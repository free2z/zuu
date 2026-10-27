"""``POST /api/kt/handle-assertion/`` — the whole endpoint.

Read ``dj/apps/ktauth/__init__.py`` for the trust model before this file. The
short version: Django's ordinary authentication is the only evidence that
``@alice`` is Alice, and this view turns it into bytes the key-transparency log
can check without trusting the transport it arrived over.

Four rules decide what this view will sign, and all four are here rather than
in a helper, because they are the endpoint:

1. **The handle comes from ``request.user``.** Never a body field, never a query
   parameter, never a path segment. There is no code path by which a caller
   names a handle.
2. **The handle is the stored binding, not a guess.** ``WIRE.md`` §14.3 maps a
   username to ``lowercase(username)`` in ``[a-z0-9_]{1,30}``, and its
   2026-08-23 correction records that the mapping is not injective on the live
   database (case-variant duplicate accounts exist). So the handle is whatever
   ``dj.apps.handles`` has bound to this account -- reserved oldest-account-
   first from usernames, or claimed -- and an account with no binding gets a
   409, not a signature. The database guarantees one account per handle.
3. **Nothing is invented.** ``account_epoch`` comes from the durable per-account
   counter (``dj.apps.ktauth.epoch``), read from the row at issuing time. When
   there is no usable counter this view refuses; it does not substitute a clock,
   a timestamp, or a default. That substitution was.
4. **Failure is scoped.** No issuing key, or no usable counter, means 503 with a
   bounded reason code from this endpoint and nothing else.
"""

import logging

from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from dj.apps.handles.reservation import ensure_username_handle
from dj.free2z.throttling import HANDLE_ASSERTION_THROTTLES

from . import epoch, signing
from .serializers import (
    AuthorityUnavailableSerializer,
    HandleAssertionRequestSerializer,
    HandleAssertionResponseSerializer,
    HandleIneligibleSerializer,
)

logger = logging.getLogger(__name__)

#The account owns no messaging handle: its username is ineligible
#(``WIRE.md`` §14.3, roughly one account in ten), is a reserved word, or folds
#onto a handle an earlier account holds -- and it has not claimed one.
#``GET /api/e2ee/handle/`` says which, and ``POST /api/e2ee/handle/claim/``
#fixes it.
REASON_UNCLAIMED = "handle_unclaimed"

INELIGIBLE_REASONS = (REASON_UNCLAIMED,)


class HandleIneligible(Exception):
    def __init__(self, reason: str, detail: str):
        super().__init__(reason)
        self.reason = reason
        self.detail = detail


def handle_for(user) -> bytes:
    """The messaging handle this account owns, as wire bytes.

    Raises:class:`HandleIneligible`. **Reads only**: one indexed lookup of the
    binding ``dj.apps.handles`` stores. Other code (the chat-request API)
    calls this from read paths too, so it must never write; the one write this
    endpoint may cause happens in:meth:`HandleAssertionView.post`, before it.
    """
    from dj.apps.handles.reservation import bound_handle

    handle = bound_handle(user)
    if handle is None:
        # Deliberately says nothing about any other account.
        raise HandleIneligible(
            REASON_UNCLAIMED,
            "This account has no messaging handle. Claim one at "
            "/api/e2ee/handle/claim/.",
        )

    raw = handle.encode("ascii")
    # The table's CheckConstraint already holds this. Re-checked because these
    # are the bytes about to be signed.
    if not signing.HANDLE_RE.match(raw):
        raise HandleIneligible(
            REASON_UNCLAIMED,
            "This account has no messaging handle.",
        )
    return raw


class HandleAssertionView(APIView):
    """Mint a short-lived, signed claim that the caller owns their handle.

    Authentication is the project default (session + Knox) — nothing custom, so
    the authentication and permission inventories stay green with no exemption.
    """

    permission_classes = [IsAuthenticated]

    #A dedicated, tight, per-user bucket. An assertion is minted when a device
    #enrolls, which a person does a handful of times in the life of an
    #account; the endpoint spends an Ed25519 signature and a signed claim
    #about an identity, so there is nothing here to burst.
    throttle_classes = HANDLE_ASSERTION_THROTTLES

    #A few indexed reads and, at most once per account, one savepointed
    #insert (``ensure_username_handle``); no locks. ``AtomicMiddleware`` opens a
    #transaction on every POST; there is no reason for this one to hold a
    #write transaction open across a signature, and holding ``FOR UPDATE`` on
    #the Creator row would serialise this endpoint against the ledger, the
    #admin and every password change to close a microsecond-wide window that
    #``epoch.confirm_account_epoch`` closes without a lock.
    atomic_request = False

    @extend_schema(
        operation_id="kt_handle_assertion_create",
        summary="Mint a key-transparency handle-ownership assertion",
        description=(
            "Signs a short-lived HandleAssertion (docs/free2z/messaging/KT.md in "
            "free2z/zuu) binding the authenticated account's messaging handle "
            "to an Ed25519 identity key, for submission to the key-"
            "transparency log.\n\n"
            "The handle is derived from the authenticated account and cannot "
            "be requested. The assertion is a bearer document and authorizes "
            "nothing on its own: the submission carrying it must also be "
            "signed by the identity key it names.\n\n"
            "This implements a PROPOSAL (free2z/zuu#594), not ratified spec."
        ),
        request=HandleAssertionRequestSerializer,
        responses={
            200: HandleAssertionResponseSerializer,
            409: HandleIneligibleSerializer,
            503: AuthorityUnavailableSerializer,
        },
    )
    def post(self, request):
        payload = HandleAssertionRequestSerializer(data=request.data)
        payload.is_valid(raise_exception=True)

        # Cheapest checks first, and the ordering is load-bearing rather than
        # tidy: `handle_for` reads (and may write) the handle table, and there
        # is no reason for an endpoint that cannot issue -- which is every
        # deployment today -- to touch the database once per request.
        try:
            signing.preflight()
        except signing.AuthorityUnavailable as exc:
            return self._unavailable(exc)

        # An eligible account created by a pod on the previous release, while
        # the migration that added the handle table was deploying, has no row
        # yet. Reserve its username's handle now, under the same rules as
        # everywhere else; a no-op for everyone else. Savepointed, so losing a
        # race to another writer leaves this request usable.
        ensure_username_handle(request.user)
        try:
            handle = handle_for(request.user)
        except HandleIneligible as exc:
            return Response(
                {"detail": exc.detail, "reason": exc.reason},
                status=status.HTTP_409_CONFLICT,
            )

        try:
            # Read from the row, not from `request.user`.
            # Authentication loaded that instance at the top of the request,
            # and an ownership event that commits while the request is in
            # flight would otherwise be signed away -- which reopens the exact
            # replay window the counter exists to close.
            #
            # `account_epoch_for` raises rather than substituting when there is
            # no usable counter: `KT.md` 4.5.4 requires the refusal, and
            # substituting a clock is what  was.
            account_epoch = epoch.account_epoch_for(request.user.pk)
            issued = signing.issue(
                handle=handle,
                identity_pk=payload.validated_data["identity_key"],
                intent=signing.INTENTS[payload.validated_data["intent"]],
                account_epoch=account_epoch,
            )
            #...and the read is not atomic with the signature. Re-read before
            # answering, and throw the assertion away if the counter moved
            # while it was being signed (codex adversarial review). One indexed
            # pk SELECT, no lock; `confirm_account_epoch` documents exactly
            # what this does and does not close.
            epoch.confirm_account_epoch(request.user.pk, account_epoch)
        except signing.AuthorityUnavailable as exc:
            # Also the path for a missing/unusable counter. `preflight` above
            # makes the key and log cases unreachable, but they are kept
            # because "the key was there a microsecond ago" is not an invariant
            # worth relying on.
            return self._unavailable(exc)

        return Response(
            {
                "assertion": signing.b64u_encode(issued["assertion"]),
                "handle": handle.decode("ascii"),
                "issued_ms": issued["issued_ms"],
                "expires_ms": issued["expires_ms"],
            }
        )

    @staticmethod
    def _unavailable(exc):
        """The 503 body. One bounded reason code, nothing about the deployment."""
        return Response(
            {
                "detail": (
                    "The handle authority is not available. No assertion was "
                    "issued."
                ),
                "reason": exc.reason,
            },
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )
