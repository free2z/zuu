from dj.apps.economy.services import EconomicRefusal
from datetime import timedelta
from decimal import Decimal
import uuid

from django.db import IntegrityError, OperationalError, connection, transaction
from django.utils import timezone
from django.shortcuts import get_object_or_404, render
from django.db.models import F, Max, Min, Sum
from rest_framework import generics
from rest_framework.permissions import IsAuthenticated
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
)
from drf_spectacular.types import OpenApiTypes
# from rest_framework.pagination import PageNumberPagination
from dj.apps.g12f.models import Subscription, Creator
from dj.apps.g12f.models.creator import SUBSCRIPTION_PERIOD
# The renewal worker's lead time, imported rather than restated: the horizon
# below is derived from it, and a silent drift would make this page overstate
# affordability by a whole extra charge.
from dj.apps.g12f.tasks import RENEWAL_LEAD
from dj.apps.events.models import Event
from . import ledger
from . import models as idempotency
from .serializers import (
    ConfirmedSubscriptionRequestSerializer,
    ConfirmedSubscriptionResultSerializer,
    IdempotentDonationRequestSerializer,
    IdempotentDonationResultSerializer,
    CreditErrorSerializer,
    InsufficientFundsErrorSerializer,
    SubscriptionMaxPriceSerializer,
    SubscriptionRenewalSummarySerializer,
    SubscriptionSerializer,
    SubscriptionStatusSerializer,
    SubscriptionIntentRecoveryRequestSerializer,
    SubscriptionIntentRecoveryResultSerializer,
)


_UUID4_IDEMPOTENCY_KEY_SCHEMA = {
    "type": "string",
    "format": "uuid",
    "minLength": 36,
    "maxLength": 36,
}

#True of every UUIDv4 route, and of nothing else. Kept separate from the
#subscribe text below on purpose: the cross-route bridge is a property of
#the two SUBSCRIBE routes, and publishing it on the donation operation --
#which claims under its own `donate-idempotent` scope and reads neither
#subscribe receipt -- would tell a third-party client that a key spent on a
#donation is spent on a subscribe. It is not, and acting on that is a second
#debit. A guarantee is only worth what the narrowest operation it is
#published on actually honours.
_CANONICAL_UUID_KEY_RULE = (
    "UUIDv4 retry key. Reuse it only for the exact "
    "same confirmed 2Z request. "
    "The value is parsed as a UUID and stored in its canonical lowercase "
    "hyphenated form, so the braced, `urn:uuid:` and unhyphenated "
    "32-character spellings of one UUID are the SAME key, not three. "
)

CONFIRMED_IDEMPOTENCY_KEY_PARAMETER = OpenApiParameter(
    name="Idempotency-Key",
    type=_UUID4_IDEMPOTENCY_KEY_SCHEMA,
    location=OpenApiParameter.HEADER,
    required=True,
    description=(
        _CANONICAL_UUID_KEY_RULE
        + "The key is scoped to this operation: a key spent here is spent "
        "here, and no other endpoint replays it."
    ),
)

SUBSCRIBE_CONFIRMED_IDEMPOTENCY_KEY_PARAMETER = OpenApiParameter(
    name="Idempotency-Key",
    type=_UUID4_IDEMPOTENCY_KEY_SCHEMA,
    location=OpenApiParameter.HEADER,
    required=True,
    description=(
        _CANONICAL_UUID_KEY_RULE
        + "A key spent here is also spent on the legacy POST "
        "/api/tuzis/subscribe/{username}/ and vice versa: each route reads "
        "the other's COMMITTED receipts, so a purchase intent that moves "
        "between the two after an ambiguous answer replays instead of "
        "charging a second month. Three bounds on that, stated because a "
        "guarantee a client cannot see the edge of is worse than a narrower "
        "one: it covers committed receipts, not two genuinely CONCURRENT "
        "requests under one key; it identifies the creator by id, so a "
        "retry sent after the path username changed hands is a different "
        "recipient and is charged as one; and it covers a membership that "
        "is still running. Receipts are kept far longer than a membership "
        "lasts, so a key whose month has already ENDED is neither replayed "
        "(you are not subscribed) nor charged again under that same key -- "
        "it is 409 `idempotency_mismatch` with `key_resolved: true`, which "
        "means retire the key and buy the new month under a fresh one."
    ),
)


# Request metadata that changes what happens to a 2Z endpoint has to be in
# the contract, or a generated client (hey-api, the MCP server, ZUULI) has no
# way to know the endpoint even has replay semantics (issue, finding F8).
#
# The header NAME is shared; the published PARAMETER is not, and deliberately
# so. IDEMPOTENCY_KEY_PARAMETER below documents the loose-key legacy subscribe
# route and is attached to that operation only; CONFIRMED_IDEMPOTENCY_KEY_
# PARAMETER above documents the routes that require a canonical UUIDv4. One
# shared parameter would have to publish the laxer of the two rules on both,
# which is the drift  exists to close.
IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key'
# Claim scope of the legacy POST /subscribe/ route (suffixed with the target
# creator's pk). Named here because ConfirmedSubscribeView has to look under it
# too -- see _legacy_subscribe_receipt.
LEGACY_SUBSCRIBE_SCOPE = 'subscribe'
# Claim scope of POST /subscribe-confirmed/ (NOT suffixed with the creator:
# the creator rides in the request fingerprint instead, so for a given fan one
# key is one confirmed purchase). CreatorSubscribeView has to look under it --
# see _confirmed_subscribe_receipt.
CONFIRMED_SUBSCRIBE_SCOPE = 'subscribe-confirmed'
# New claims for both subscribe POST routes. The historical route-specific
# rows remain as compatibility receipts; this row is the single gate that is
# inserted and committed before either route starts moving 2Z.
SUBSCRIBE_SHARED_SCOPE = 'subscribe-intent'
# `IdempotentDonate2Z`'s retired PPV "unlock" intent. It stays a valid
# request value so receipts recorded before the retirement still replay; a
# NEW request with it is refused before any money moves.
PPV_UNLOCK_INTENT = 'ppv'

SUBSCRIPTION_INTENT_ABANDONED = "subscription_intent_abandoned"


def _subscribe_scope(star):
    """The route-independent claim namespace for one creator."""
    return f"{SUBSCRIBE_SHARED_SCOPE}:{star.pk}"

# The one-way bridge for a key a client can no longer SEND.
#
#  tightened Idempotency-Key to a UUIDv4. The client shipped by
# minted `f2z-<base36 time>-<random>` in any browser without
# `crypto.randomUUID` (Chrome <92, Firefox <95, Safari <15.4, or any
# non-secure context), and `IdempotencyKey.key` is a CharField, so receipts
# recorded under those keys really are in the table -- for the published
# 365-day COMPLETED_CLAIM_RETENTION horizon.
#
# A browser still holding such a key cannot resolve it: sending it is 400
# `invalid_idempotency_key`, and the client's only other move was to throw it
# away and mint a fresh UUID -- which is a SECOND month charged for a purchase
# the first key may already have committed. That is the money bug
# names, and neither half can fix it alone: the server cannot invent the old
# key and the client cannot send it.
#
# So the client hands the retired key over for a LOOKUP it can no longer do
# itself. The retired VALUE is read-only by construction: it can replay a
# committed receipt, and it is never claimed, never charged, never bound to a
# price. An unrecognised or absent value changes nothing at all -- the request
# proceeds to a normal claim under Idempotency-Key.
#
# What a successful lookup does write is a receipt under the REPLACEMENT key
# the client sent anyway (`_bind_replacement_key`), because leaving that key
# unclaimed leaves it chargeable from an older tab. That is the same purchase
# intent ending under both keys, not a second debit -- see that function.
SUPERSEDED_IDEMPOTENCY_KEY_HEADER = 'X-Superseded-Idempotency-Key'
SUPERSEDED_IDEMPOTENCY_KEY_PARAMETER = OpenApiParameter(
    name=SUPERSEDED_IDEMPOTENCY_KEY_HEADER,
    type={'type': 'string', 'minLength': 1, 'maxLength': 200},
    location=OpenApiParameter.HEADER,
    required=False,
    description=(
        "A retry key this client is RETIRING because it can no longer be "
        "sent: a value that predates the UUIDv4 rule now enforced on "
        "Idempotency-Key. Send it alongside the fresh Idempotency-Key that "
        "replaces it and this route looks for a committed receipt under it "
        "first, replaying that purchase (`replayed: true`, nothing charged) "
        "instead of buying a second month for an intent the retired key "
        "already paid for. "
        "The RETIRED value is only ever looked up: it is never claimed, never "
        "binds a price, and never charges. A value that is unknown, blank, "
        "longer than 200 characters, or absent is ignored and the request "
        "proceeds as a normal purchase under Idempotency-Key -- an unusable "
        "hint never fails a write. "
        "A lookup that DOES find a receipt ends the purchase intent under "
        "both keys: the fresh Idempotency-Key you sent with it is recorded "
        "as a receipt for that same replayed purchase, so a later retry of "
        "it -- from an older tab, or on the legacy route -- replays instead "
        "of buying a second month. No 2Z moves, but that key is then spent "
        "and bound to this request's expected_price, exactly as if the "
        "purchase had happened here. "
        "A value that IS a canonical UUIDv4 is ignored too, deliberately: "
        "such a key can be sent as Idempotency-Key itself, where it replays "
        "AND claims, so honouring it here would be a second, weaker way to "
        "spend a key. "
        "Retire the header once the purchase resolves, exactly like the key "
        "it replaces."
    ),
)
IDEMPOTENCY_KEY_PARAMETER = OpenApiParameter(
    name=IDEMPOTENCY_KEY_HEADER,
    # This schema IS the enforcement rule, not a hint. `_idempotency_key`
    # (idempotency.uuid4_key) requires a version-4 UUID and
    # CreatorSubscribeView answers 400 `invalid_idempotency_key` for anything
    # else that arrives in the header, a blank value included. Until
    # this decorator still advertised the pre- rule (any 1..200
    # character string, truncated, blank tolerated) while the view enforced
    # this one; regenerating the spec cannot catch that, because the stale
    # decorator is the source of the stale contract. Keep the two in step --
    # INCLUDING the leniency: uuid4_key normalizes rather than rejecting the
    # braced / urn / unhyphenated spellings, so a description promising that
    # every non-36-character value is refused would be a NEW drift in the
    # other direction. The schema still
    # declares the canonical form, which is what clients should send.
    type={
        'type': 'string',
        'format': 'uuid',
        'minLength': 36,
        'maxLength': 36,
    },
    location=OpenApiParameter.HEADER,
    required=False,
    description=(
        "Optional client-generated UUIDv4 that makes this charge safe to "
        "retry. When the header is present it MUST parse as a version-4 "
        "UUID: anything else, a blank or whitespace-only value included, is "
        "answered 400 with code `invalid_idempotency_key` and nothing is "
        "charged. There is no truncation and no silent fallback -- the only "
        "way to opt out of the protection is to omit the header entirely. "
        "Send the canonical 36-character 8-4-4-4-12 form, which is what this "
        "schema declares. The server is deliberately no stricter than "
        "Python's UUID parser, so surrounding whitespace is stripped and the "
        "braced (`{...}`), `urn:uuid:` and unhyphenated 32-character "
        "spellings of one UUID all normalize to that same canonical key -- "
        "they are ONE key and replay each other, not three independent "
        "charges. Case is not significant either. "
        "The key is scoped to the authenticated fan AND the creator in the "
        "path, so the same key sent for a different creator is a different "
        "request -- unless it was already spent on POST "
        "/api/tuzis/subscribe-confirmed/{username}/, which scopes a key to "
        "the fan alone. This route reads that route's receipts: a key that "
        "completed there for THIS creator replays here (nothing charged). One "
        "that completed there for a DIFFERENT creator is not this request at "
        "all, so it is claimed and charged normally under this route's own "
        "per-creator scope. Only a receipt that cannot be attributed to a "
        "creator -- still running, or recorded without a "
        "recipient id -- is answered 409 `idempotency_mismatch`, because it "
        "might be this creator's committed purchase; mint a new key. "
        "That is the price of the two routes being one retry namespace, and "
        "it is what stops a route switch charging a second month. It is a "
        "guarantee about COMMITTED receipts: two genuinely concurrent "
        "requests under one key are not covered, and neither is a retry sent "
        "after the path username changed owners, because the recipient is "
        "identified by id and that is then a different creator. "
        "Reuse the SAME key for every retry of one purchase and a NEW key for "
        "a genuinely new purchase: once a request under a key has completed, "
        "retrying that key replays the recorded status and body verbatim and "
        f"does NOT charge again for {idempotency.COMPLETED_CLAIM_RETENTION.days} "
        "days afterwards -- for as long as the membership it bought is still "
        "running. The receipt outlives the membership by up to eleven "
        "months, and once the month has ENDED that retry is neither replayed "
        "(you are not subscribed) nor charged again under the same key: it "
        "is 409 `idempotency_mismatch` with `key_resolved: true`, meaning "
        "retire this key and buy the new month under a fresh one. Because "
        "the replay is verbatim it is a record of THAT request, not a live "
        "read: `charged` describes the original call and `expires` is the "
        "membership end date as of the original call, which a later renewal "
        "may since have pushed out. Re-read GET /api/tuzis/my-subscriptions "
        "for current state rather than writing a replayed body over it. "
        "A retry sent while the original is still running either blocks until "
        "the original commits and then replays it, or is answered 409 "
        "Conflict meaning 'undecided, ask again shortly' -- never a second "
        "charge. "
        "A request that moved no 2Z (for example 402 insufficient funds) "
        "does not burn the key. For an existing target, a completed key is "
        "looked up before mutable price, balance, or active-state checks, so "
        "a retry after a timeout still replays a committed charge even if the "
        "creator was later deactivated. A genuinely new key must still pass "
        "those eligibility checks; a failed check releases the key. If the "
        "target username no longer resolves, the stored request fingerprint "
        "is used for the same replay-or-conflict decision. "
        "Omit the header entirely and every POST is an independent request, "
        "protected only by a coarse 60-second server-side debounce -- a retry "
        "after that window charges another month. "
        "This endpoint also binds no price: it charges the creator's price "
        "as of the request. Interactive clients that showed the fan a price "
        "should use POST /api/tuzis/subscribe-confirmed/{username}/ with "
        "expected_price instead, which refuses (409 `price_changed`) rather "
        "than charge an amount the fan never saw."
    ),
)


def _credit_error(code, message, http_status, **fields):
    return Response(
        {"code": code, "error": message, **fields},
        status=http_status,
    )


def _abandoned_response():
    """Return the public result for a definitive abandoned intent."""
    return _credit_error(
        SUBSCRIPTION_INTENT_ABANDONED,
        "This subscription attempt was abandoned. Start a new attempt.",
        status.HTTP_409_CONFLICT,
        key_resolved=True,
    )


def _subscription_intent_is_abandoned(star, key):
    return idempotency.SubscriptionIntentAbandonment.objects.filter(
        creator_id=star.pk,
        key=key,
    ).exists()


class _SubscriptionIntentAbandoned(Exception):
    """A terminal creator/key fence won before this charge could settle."""


def _is_subscription_lock_timeout(exc):
    """Recognize PostgreSQL ``lock_timeout`` without masking other outages."""
    pending = [exc]
    seen = set()
    while pending:
        current = pending.pop()
        if current is None or id(current) in seen:
            continue
        seen.add(id(current))
        sqlstate = getattr(current, "sqlstate", None) or getattr(
            current, "pgcode", None,
        )
        if sqlstate == "55P03":  # lock_not_available / lock_timeout
            return True
        pending.extend((getattr(current, "__cause__", None),
                        getattr(current, "__context__", None)))
    return False


def _subscription_lock_retryable_response():
    return _credit_error(
        "subscription_retryable",
        "A subscription request is still settling. Retry with the same key.",
        status.HTTP_409_CONFLICT,
    )


def _lock_subscription_intent(star, key, *, reject_abandoned=True):
    """Serialize settlement and recovery for one creator/key across payers.

    The lock is transaction-scoped and acquired before ``Subscription.extend``
    takes its subscription/balance locks. Recovery uses the same first lock, so
    a fence cannot commit between a charge's preflight and its debit. The
    advisory key is deterministic, contains no payer data, and is only used on
    PostgreSQL, the production money-path database.
    """
    if not key or connection.vendor != "postgresql":
        return
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL lock_timeout = %s", ["5s"])
        cursor.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            [f"subscription-intent:{star.pk}:{key}"],
        )
    if reject_abandoned and _subscription_intent_is_abandoned(star, key):
        raise _SubscriptionIntentAbandoned


def _subscription_pending_body(star):
    """Metadata for an unfinished receipt; never returned to the browser."""
    return {
        "_creator_pk": star.pk,
        "_subscription_intent": "pending",
    }


def _record_targets_creator(record, creator_pk, *, username=None,
                            expected_price=None):
    """Prove a receipt belongs to ``creator_pk`` without trusting a username."""
    if record.scope in {
        f"{LEGACY_SUBSCRIBE_SCOPE}:{creator_pk}",
        f"{SUBSCRIBE_SHARED_SCOPE}:{creator_pk}",
    }:
        return True
    body = record.response_body
    if (
        isinstance(body, dict)
        and body.get("_creator_pk") is not None
        and str(body.get("_creator_pk")) == str(creator_pk)
    ):
        return True
    if (
        record.scope == CONFIRMED_SUBSCRIBE_SCOPE
        and record.request_hash
        and username
        and expected_price is not None
    ):
        return record.request_hash == idempotency.fingerprint({
            "creator": creator_pk,
            "creator_username": username,
            "expected_price": str(expected_price),
        })
    return False


def _idempotency_key(request):
    return idempotency.request_key(request)


def _superseded_idempotency_key(request):
    """Read a retired key offered for RECEIPT LOOKUP ONLY.

    See SUPERSEDED_IDEMPOTENCY_KEY_PARAMETER. Returns None for anything this
    route will not look up, which is every case where ignoring the header is
    the safe answer: absent, blank, over the column width, or a canonical
    UUIDv4 (which belongs in Idempotency-Key, where it can claim as well as
    replay -- honouring it here would be a second way to spend a key).
    """
    raw = request.headers.get(SUPERSEDED_IDEMPOTENCY_KEY_HEADER)
    if raw is None:
        return None
    candidate = str(raw).strip()
    if not candidate or len(candidate) > 200:
        return None
    if idempotency.uuid4_key(candidate) is not None:
        return None
    return candidate


def _claim(scope, user, key, request_hash, on_conflict=None, initial_body=None):
    """Return (claim, response), where response handles duplicate outcomes.

    `on_conflict` is an optional `record -> Response | None` an endpoint can
    pass when the default mismatch answer is not safe for it. Returning None
    keeps the default. Only the subscribe route uses it; see
    `_completed_purchase_this_key_already_made`.
    """
    try:
        return idempotency.claim(
            scope,
            user,
            key,
            request_hash=request_hash,
            initial_body=initial_body,
        ), None
    except idempotency.IdempotencyConflict as conflict:
        if conflict.record.abandoned_at is not None:
            return None, _abandoned_response()
        if on_conflict is not None:
            handled = on_conflict(conflict.record)
            if handled is not None:
                return None, handled
        return None, _credit_error(
            "idempotency_mismatch",
            "This idempotency key was already used for a different request.",
            status.HTTP_409_CONFLICT,
            # Whether that other request has FINISHED, which is the one thing
            # the client cannot work out and cannot live without. A client
            # keeps one key per purchase intent, so a key bound to a
            # completed, differently-fingerprinted request (a subscribe at
            # last month's price, say) answers 409 to every attempt it ever
            # makes -- for the whole 365-day receipt horizon, with no reload
            # able to clear it (codex adversarial review, round 3). It is
            # safe to mint a new key when this is true and ONLY when it is
            # true: the receipt describes a different request, so it holds no
            # evidence about this one, whereas an unfinished claim may be a
            # charge that is still committing. "A different request" is not
            # the same as "a different INTENT", which is why the subscribe
            # route passes `on_conflict` -- see
            # `_completed_purchase_this_key_already_made`.
            key_resolved=conflict.record.response_status is not None,
        )
    except idempotency.DuplicateRequest as duplicate:
        if duplicate.record.abandoned_at is not None:
            return None, _abandoned_response()
        if duplicate.in_flight:
            return None, _credit_error(
                "request_in_progress",
                "The original request is still in progress.",
                status.HTTP_409_CONFLICT,
            )
        body = duplicate.record.response_body
        if not isinstance(body, dict):
            return None, _credit_error(
                "invalid_idempotency_record",
                "The original response could not be replayed safely.",
                status.HTTP_409_CONFLICT,
            )
        replay = {
            key: value
            for key, value in body.items()
            if key not in SERVER_ONLY_RECEIPT_FIELDS
        }
        replay["replayed"] = True
        return None, Response(
            replay,
            status=duplicate.record.response_status,
        )


#Keys a stored receipt carries for the SERVER's benefit only. They are
#request identity, not API surface, so every replay path strips them --
#adding one here without adding it to the strippers widens the published
#response by accident.
SERVER_ONLY_RECEIPT_FIELDS = frozenset({
    "_unresolved_fingerprint",
    "_creator_pk",
    "_subscribe_route",
    "_subscription_intent",
})


def _stored_response(body, unresolved_fingerprint, creator_pk=None):
    """Attach server-only request identity without widening the API response."""
    stored = {
        **body,
        "_unresolved_fingerprint": unresolved_fingerprint,
    }
    if creator_pk is not None:
        # The IMMUTABLE recipient id. A receipt is otherwise identifiable
        # only by the username it serialized, and usernames are mutable and
        # reusable: creator A can be paid as `alice`, rename, and creator B
        # can then take `alice`, at which point a username comparison would
        # hand A's receipt back for a request aimed at B (codex adversarial
        # review of ). Never leaves the server.
        stored["_creator_pk"] = creator_pk
    return stored


def _stored_subscribe_response(
    body, unresolved_fingerprint, creator_pk, route,
):
    """Store one subscribe receipt usable by either route."""
    stored = _stored_response(
        body, unresolved_fingerprint, creator_pk=creator_pk,
    )
    stored["_subscribe_route"] = route
    return stored


def _finish_subscribe_claim(
    claim, body, unresolved_fingerprint, fan, star, request_hash, route,
    compatibility_request_hash=None, compatibility_claim=None,
):
    """Finish the shared gate and retain a route-shaped legacy receipt."""
    stored = _stored_subscribe_response(
        body,
        unresolved_fingerprint,
        creator_pk=star.pk,
        route=route,
    )
    claim.finish(status.HTTP_200_OK, stored)
    idempotency.mark_subscription_intent_resolved(fan, star.pk, claim.key)
    if compatibility_claim is not None:
        # Confirmed requests claim the fan-wide scope before this creator's
        # shared scope. Both receipts commit atomically with the debit.
        compatibility_claim.finish(status.HTTP_200_OK, stored)
        return

    # Deploys cannot invalidate an old tab. Keep the receipt in the scope its
    # old route used so pre-shared-namespace rows and already-loaded bundles
    # remain replayable. These aliases are written in the charge transaction;
    # the shared claim, not either alias, is the concurrency gate.
    compatibility_scope = (
        f"{LEGACY_SUBSCRIBE_SCOPE}:{star.pk}"
        if route == "legacy" else CONFIRMED_SUBSCRIBE_SCOPE
    )
    IdempotencyKey = idempotency.IdempotencyKey
    IdempotencyKey.objects.get_or_create(
        scope=compatibility_scope,
        user=fan,
        key=claim.key,
        defaults={
            # The shared claim deliberately has a route-independent
            # fingerprint. The historical alias must retain the fingerprint
            # its route published, though: old clients use it to distinguish
            # a changed price from the receipt they are retrying.
            "request_hash": (
                compatibility_request_hash
                if compatibility_request_hash is not None
                else request_hash
            ),
            "response_status": status.HTTP_200_OK,
            "response_body": stored,
        },
    )


def _bind_replacement_key(response, fan, star, key, request_hash,
                          unresolved_fingerprint):
    """Record the REPLACEMENT key as a receipt for the purchase it replayed.

    Replaying a superseded key's receipt and returning without claiming the
    replacement leaves that replacement chargeable, and the fan's browser is
    exactly where the next request comes from. Concretely: the new bundle
    stores replacement K, sends both headers, and is answered with the old
    purchase; that response is lost; the fan retries from a tab still running
    the pre- bundle, which reads K out of the SAME localStorage and sends
    no superseded header at all. K is unclaimed, the 60-second debounce has
    long since passed, and a second month is charged. (Codex adversarial
    review, round 2 -- RISKIEST LINE.)

    So the replay ends the intent under BOTH keys. The alias is written in the
    confirmed scope, which the legacy route also reads, so it covers a retry
    of K on either route.

    Claim and finish are one transaction because there is no money movement to
    bracket here and a crash between them would otherwise leave an unfinished
    row under K -- takeable over after STALE_CLAIM, i.e. chargeable again,
    which is the failure this function exists to remove. A key already spent
    is left alone: it has its own answer, and this one is not better.
    """
    data = getattr(response, "data", None)
    if (
        response.status_code != status.HTTP_200_OK
        or not isinstance(data, dict)
    ):
        # In flight, or a receipt this route could not read. Nothing committed
        # is being reported, so there is nothing to bind.
        return response
    try:
        with transaction.atomic():
            claim = idempotency.claim(
                CONFIRMED_SUBSCRIBE_SCOPE,
                fan,
                key,
                request_hash=request_hash,
                initial_body=_subscription_pending_body(star),
            )
            claim.finish(
                status.HTTP_200_OK,
                _stored_response(
                    dict(data), unresolved_fingerprint, creator_pk=star.pk,
                ),
            )
    except (idempotency.IdempotencyConflict, idempotency.DuplicateRequest):
        pass
    return response


def _with_live_balance(response, fan):
    """Give `balance` ONE meaning across every 200 this route can return.

    The confirmed route has three ways to answer 200 with `replayed: true`:
    `_claim` replaying its own stored receipt, `_replay_when_target_moved`
    replaying it after the username moved, and `_legacy_subscribe_receipt`
    translating a receipt from the legacy route. The first two returned the
    balance FROZEN at the moment the original response was recorded; the
    third has no stored balance to return (the legacy route never recorded
    one) and read the fan's current balance instead. Same route, same
    `replayed: true`, two different meanings for one field -- and a client
    cannot tell which it got. (Codex adversarial review of /.)

    Live wins, for both of the reasons that matter: it is the only meaning
    ALL three paths can produce, and it is the one a client can act on -- a
    frozen balance from a replay is a number that was true once and may be
    several charges out of date. `charged` and `expires` still describe the
    original request, and the schema says so.
    """
    data = getattr(response, "data", None)
    if (
        response is not None
        and response.status_code == status.HTTP_200_OK
        and isinstance(data, dict)
        and "balance" in data
    ):
        fan.refresh_from_db(fields=["tuzis"])
        data["balance"] = str(fan.tuzis)
    return response


def _completed_purchase_this_key_already_made(
    record, fan, star, scope_is_creator_bound=False,
):
    """The mismatch answer for a key that DID buy the membership in hand.

    `key_resolved: true` tells a client the receipt under its key describes a
    different request, so it may mint a fresh one. A completed claim proves
    the other request FINISHED; it does not prove it was a different INTENT.
    The gap is a double charge (codex adversarial review, round 3):

        the fan buys at 10 2Z under key K, the charge commits, the response
        is lost; the creator moves to 12; the fan's tab retries K with the
        price it now renders. The fingerprint differs, so the claim conflicts
        -- and `key_resolved: true` invites the client to drop K and buy
        again. Both bundles do exactly that. Past the 60-second debounce,
        that is a second month for a fan trying to recover one purchase.

    So when the conflicting receipt is a COMPLETED purchase of a membership
    this fan is STILL holding from THIS creator, the honest answer is the
    receipt itself: 200, `replayed: true`, nothing charged. The clients then
    run their success path -- which retires the key -- so a fan who really
    does want another month gets it on the next click, at the new price and
    under a fresh key. One extra click; never a second debit.

    Returns None (keep the 409) whenever the receipt is provably NOT this
    purchase, which is the case the signal was built for: a different
    creator's receipt, or one whose membership has since lapsed so the month
    it bought is over. A receipt this route cannot attribute at all -- no
    `_creator_pk`, predating  -- while a live membership exists is the
    one case with no good answer: it MIGHT be this membership, so it refuses
    without blessing a new key, exactly as `_confirmed_subscribe_receipt`
    does in the same situation.

    `scope_is_creator_bound` says the receipt was read from a scope that
    already names this creator -- `subscribe:<star.pk>`, the legacy route's.
    There the stored `_creator_pk` is not identity, it is redundancy: NO
    other creator's receipt can be in that scope, and the legacy route has
    never written `_creator_pk` at all, so demanding one would refuse every
    legacy receipt there is. The immutable-id check exists for the CROSS-route
    lookup, where one scope holds every creator's receipts.
    """
    if record.response_status != status.HTTP_200_OK:
        # Unfinished: it may still be committing. The default answer says so
        # (`key_resolved: false`), which is the one thing it must not get
        # wrong.
        return None
    body = record.response_body
    if not isinstance(body, dict) or "charged" not in body:
        return None
    sub = Subscription.objects.filter(star=star, fan=fan).first()
    if sub is None or _replay_would_report_a_lapsed_membership(sub):
        return None
    stored_pk = body.get("_creator_pk")
    if scope_is_creator_bound or stored_pk == star.pk:
        replay = {
            field: value
            for field, value in body.items()
            if field not in SERVER_ONLY_RECEIPT_FIELDS
        }
        replay["replayed"] = True
        return Response(replay, status=status.HTTP_200_OK)
    if stored_pk is None:
        return _credit_error(
            "idempotency_mismatch",
            "This idempotency key was already used for a different request.",
            status.HTTP_409_CONFLICT,
        )
    return None


def _replay_would_report_a_lapsed_membership(sub, now=None):
    """True when a receipt describes a month that has already run out.

    Receipts live for COMPLETED_CLAIM_RETENTION (365 days); a membership
    lasts SUBSCRIPTION_PERIOD (30). So a receipt can outlive by eleven months
    the thing it certifies, and replaying it then answers "already recorded,
    nothing charged" to a fan who is not subscribed and has bought nothing.
    Both clients run their success path on that 200 -- they mark the fan
    subscribed and show "this subscription was already recorded". (Adversarial
    review of /, round 2.)
    """
    return sub is None or sub.expires <= (now or timezone.now())


def _spent_on_a_membership_that_ended():
    """The answer for a key whose purchase is real, finished, and OVER.

    There are three tempting answers and only one is safe.

    REPLAY IT is a lie: the fan is not subscribed and bought nothing, and
    both bundles believe the 200 (round 2 of the adversarial review).

    CHARGE IT -- fall through to a normal claim, which an earlier revision of
    this branch did -- is a debit under a key the CLIENT still considers
    unresolved. Expiry proves the entitlement ended; it does not prove the
    fan asked for another month under that same key, and on the legacy route
    the debit is not even price-bound (codex adversarial review, round 4:
    "`return None` converts a known completed purchase into permission for
    another debit on the price-unbound legacy route").

    So: 409 `idempotency_mismatch` with `key_resolved: true`, which both
    bundles already act on -- retire the key, tell the fan the attempt was
    settled, and let the next click buy the month under a key minted after
    they were told. That is explicit new intent under a fresh key, one click,
    no false success, and no 2Z moved on this request.
    """
    return _credit_error(
        "idempotency_mismatch",
        "This idempotency key is spent on a membership that has ended.",
        status.HTTP_409_CONFLICT,
        key_resolved=True,
    )


def _never_report_a_membership_that_ended(response, fan, star):
    """Guard every REPLAY on the subscribe routes with the rule above.

    The cross-route lookups can check before they answer; this covers the
    replays built somewhere else -- `_claim`'s own completed receipt, and the
    legacy route's `DuplicateRequest` branch. Both hand back a stored body
    verbatim, and a stored body has no idea whether the month it describes is
    still running.

    The gap this closes is not hypothetical (codex adversarial review, round
    4): a bridged replay records the replacement key K with the SAME
    fingerprint the retry sends, so a retry of K after expiry matches, never
    reaches the mismatch path, and replays a receipt from a membership that
    ended. Only a 200 carrying a purchase body is inspected, so a 4xx and a
    fresh purchase (whose membership was just extended) pass through
    untouched.
    """
    data = getattr(response, "data", None)
    if (
        response is None
        or response.status_code != status.HTTP_200_OK
        or not isinstance(data, dict)
        or "charged" not in data
    ):
        return response
    sub = Subscription.objects.filter(star=star, fan=fan).first()
    if _replay_would_report_a_lapsed_membership(sub):
        return _spent_on_a_membership_that_ended()
    return response


def _replay_shared_subscribe_claim(response, fan, star, route):
    """Translate a shared claim's stored body into this route's contract."""
    data = getattr(response, "data", None)
    if (
        response is None
        or response.status_code != status.HTTP_200_OK
        or not isinstance(data, dict)
        or "charged" not in data
    ):
        return response

    response = _never_report_a_membership_that_ended(response, fan, star)
    if response.status_code != status.HTTP_200_OK:
        return response
    sub = Subscription.objects.filter(star=star, fan=fan).first()
    if sub is None:
        return _credit_error(
            "invalid_idempotency_record",
            "The original response could not be replayed safely.",
            status.HTTP_409_CONFLICT,
        )

    if route == "legacy":
        return Response({
            "charged": bool(data["charged"]),
            "expires": data.get("expires") or sub.expires.isoformat(),
            "replayed": True,
        }, status=status.HTTP_200_OK)

    # A legacy receipt has no balance or serialized subscription. Rebuild those
    # fields in the confirmed route's response shape, while keeping charged
    # and expires tied to the original request.
    fan.refresh_from_db(fields=["tuzis"])
    subscription = data.get("subscription")
    if subscription is None:
        subscription = SubscriptionSerializer(sub).data
    return Response({
        "balance": str(fan.tuzis),
        "charged": bool(data["charged"]),
        "replayed": True,
        "expires": data.get("expires") or sub.expires.isoformat(),
        "subscription": subscription,
    }, status=status.HTTP_200_OK)


def _legacy_subscribe_receipt(
    fan, star, key, route="confirmed", *, check_abandoned=True,
):
    """Replay a receipt the legacy POST /subscribe/ recorded under this key.

    The client keeps ONE Idempotency-Key per purchase intent and reuses it
    on the retry the abort copy asks for. When the new-ui moved from the
    legacy route to subscribe-confirmed  a key left outstanding by an
    ambiguous legacy response -- the request committed, the response was
    lost -- would reach this route, where `_claim` looks under a different
    scope, claim afresh, and pay a second month for a membership the legacy
    request already bought. (codex adversarial review of.)

    Returns None only when the legacy route never saw this key, so the caller
    proceeds to claim normally. A completed legacy receipt for a membership
    still running is replayed in this route's response shape with
    `replayed: true`; an unfinished one is "still in progress" (409), exactly
    as `_claim` answers for its own scope; and one whose month has already
    ended is neither replayed nor charged under this key -- see
    `_spent_on_a_membership_that_ended`, which explains why falling through to
    a normal claim there is the wrong answer.
    """
    record = idempotency.replay_record_or_release_abandoned(
        f"{LEGACY_SUBSCRIBE_SCOPE}:{star.pk}", fan, key,
    )
    if record is None:
        if check_abandoned and _subscription_intent_is_abandoned(star, key):
            return _abandoned_response()
        return None
    if record.abandoned_at is not None:
        return _abandoned_response()
    if record.response_status is None:
        if route == "legacy":
            return Response(
                data={'error': 'Request already in progress'},
                status=status.HTTP_409_CONFLICT,
            )
        return _credit_error(
            "request_in_progress",
            "The original request is still in progress.",
            status.HTTP_409_CONFLICT,
        )
    body = record.response_body
    sub = Subscription.objects.filter(star=star, fan=fan).first()
    if (
        record.response_status != status.HTTP_200_OK
        or not isinstance(body, dict)
        or "charged" not in body
    ):
        return _credit_error(
            "invalid_idempotency_record",
            "The original response could not be replayed safely.",
            status.HTTP_409_CONFLICT,
        )
    if sub is None:
        # This is a valid completed legacy receipt, but there is no current
        # membership to which it can be replayed. Preserve the legacy wire
        # contract: the key is resolved and the caller may safely mint a new
        # one. The confirmed route deliberately keeps its stricter invalid-
        # record response for this historical shape.
        if route == "legacy":
            return _credit_error(
                "idempotency_mismatch",
                "This idempotency key was already used for a different request.",
                status.HTTP_409_CONFLICT,
                key_resolved=True,
            )
        return _credit_error(
            "invalid_idempotency_record",
            "The original response could not be replayed safely.",
            status.HTTP_409_CONFLICT,
        )
    if _replay_would_report_a_lapsed_membership(sub):
        return _spent_on_a_membership_that_ended()
    return _replay_shared_subscribe_claim(Response({
        "charged": bool(body["charged"]),
        "expires": body.get("expires") or sub.expires.isoformat(),
        "replayed": True,
    }, status=status.HTTP_200_OK), fan, star, route)


def _confirmed_subscribe_receipt(
    fan, star, key, request_hash=None, cross_creator_is_conflict=True,
    *, check_abandoned=True,
):
    """Refuse (or replay) a key POST /subscribe-confirmed/ already spent.

    The mirror of `_legacy_subscribe_receipt`, and it is needed for the same
    reason in the opposite direction: the new-ui now buys on the confirmed
    route, but an older bundle in a tab that has been open across the deploy
    -- or a rollback -- still posts here, and it reads the SAME persisted key
    out of localStorage. Without this lookup the legacy route finds nothing
    under `subscribe:<pk>`, claims afresh and charges a second month for the
    intent the confirmed route already committed. Bridging only one direction
    is not a bridge (codex adversarial review of /).

    Returns None when the confirmed route never saw this key, and (for the
    legacy route's documented per-creator behavior) when it saw it for a
    POSITIVELY IDENTIFIED different creator. The confirmed route itself keeps
    its historical fan-wide mismatch contract for that case. A completed
    receipt for THIS creator, for a membership still running, replays in this
    route's response shape. A
    receipt this route cannot identify -- still running, or no `_creator_pk`
    because it predates  -- is a 409: it may be this creator's, so mint
    a new key. So is one whose month has already ended, and that one is NOT a
    fall-through to a chargeable claim (`_spent_on_a_membership_that_ended`
    has the reasoning). Nothing is charged in the 409 cases, which is the
    whole point.
    """
    record = idempotency.replay_record_or_release_abandoned(
        CONFIRMED_SUBSCRIBE_SCOPE, fan, key,
    )
    if record is None:
        if check_abandoned and _subscription_intent_is_abandoned(star, key):
            return _abandoned_response()
        return None
    if record.abandoned_at is not None:
        if _record_targets_creator(record, star.pk):
            return _abandoned_response()
        # The confirmed scope is fan-wide for historical compatibility.  A
        # tombstone for another immutable creator must not be presented as B's
        # abandonment after A's username is reused; it is only a resolved-key
        # conflict for this request.
        return _credit_error(
            "idempotency_mismatch",
            "This idempotency key was already used for a different request.",
            status.HTTP_409_CONFLICT,
            key_resolved=True,
        )
    if record.response_status is None:
        # Still in flight on the other route. Undecided, not failed.
        if request_hash is not None and record.request_hash != request_hash:
            return _credit_error(
                "idempotency_mismatch",
                "This idempotency key was already used for a different request.",
                status.HTTP_409_CONFLICT,
                key_resolved=False,
            )
        if request_hash is not None:
            return _credit_error(
                "request_in_progress",
                "The original request is still in progress.",
                status.HTTP_409_CONFLICT,
            )
        return Response(
            data={'error': 'Request already in progress'},
            status=status.HTTP_409_CONFLICT,
        )
    body = record.response_body
    # Compare the IMMUTABLE creator id, never the username the receipt
    # serialized: a creator can rename and free their old username for
    # someone else, and a username comparison would then replay the first
    # creator's receipt for a request aimed at the second -- reporting a
    # purchase that the second creator's subscription never received (codex
    # adversarial review of ). A receipt with no `_creator_pk` predates
    #  and cannot be identified at all, so it is refused rather than
    # replayed against a guess; that costs a replay and charges nothing.
    stored_pk = body.get('_creator_pk') if isinstance(body, dict) else None
    if (
        stored_pk is None
        and request_hash is not None
        and record.request_hash == request_hash
    ):
        # Historical confirmed receipts predate _creator_pk. An exact match
        # of this route's fingerprint already binds the immutable creator id,
        # username and price, so preserve its original replay/expiry path.
        # Cross-route callers supply no such proof and remain conservative.
        stored_pk = star.pk
    if stored_pk is not None and stored_pk != star.pk:
        if cross_creator_is_conflict:
            # An already-running old legacy POST can hold the historical
            # receipt lock while its target-specific receipt is uncommitted.
            # Our earlier target lookup then misses it, and the historical
            # lookup waits. Re-read after that wait before saying the key is
            # resolved: the other target's purchase may just have committed.
            legacy_replay = _legacy_subscribe_receipt(fan, star, key)
            if legacy_replay is not None:
                return legacy_replay
            return _credit_error(
                "idempotency_mismatch",
                "This idempotency key was already used for a different request.",
                status.HTTP_409_CONFLICT,
                key_resolved=True,
            )
        # A receipt we can positively identify as ANOTHER creator's is not
        # this legacy request. Fall through to a normal claim: this route's own
        # scope is `subscribe:<star.pk>`, so the key is unspent HERE and
        # claiming it cannot replay or double-charge the other creator's
        # purchase. Answering 409 instead (as an earlier revision did) turned
        # a legitimate second purchase into an unrecoverable refusal and
        # silently narrowed the per-creator key scoping this route has always
        # published for third-party clients. (Codex adversarial review.)
        return None
    if (
        record.response_status != status.HTTP_200_OK
        or not isinstance(body, dict)
        or 'charged' not in body
        or stored_pk is None
    ):
        # Left: a receipt this route cannot identify at all -- no
        # `_creator_pk` (it predates ), a non-200, or a body without
        # `charged`. It may well be THIS creator's committed purchase, and
        # claiming it here would then be the second month this function
        # exists to stop. 409 says "spent, mint a new one" and moves no 2Z.
        return _credit_error(
            "idempotency_mismatch",
            "This idempotency key was already used for a different request.",
            status.HTTP_409_CONFLICT,
        )
    sub = Subscription.objects.filter(star=star, fan=fan).first()
    if sub is None:
        return _credit_error(
            "invalid_idempotency_record",
            "The original response could not be replayed safely.",
            status.HTTP_409_CONFLICT,
        )
    if _replay_would_report_a_lapsed_membership(sub):
        # Same rule as the other direction, and note it is NOT "fall through
        # and charge": this route binds no price at all, so a debit here on
        # the strength of an expired receipt is a charge at whatever the
        # creator's price happens to be, under a key the client still
        # considers unresolved.
        return _spent_on_a_membership_that_ended()
    fan.refresh_from_db(fields=["tuzis"])
    subscription = body.get("subscription")
    if subscription is None:
        subscription = SubscriptionSerializer(sub).data
    return Response({
        "balance": str(fan.tuzis),
        'charged': bool(body['charged']),
        'expires': body.get('expires') or sub.expires.isoformat(),
        'replayed': True,
        "subscription": subscription,
    })


def _replay_when_target_moved(
    scope, user, key, unresolved_fingerprint, receipt_guard=None,
):
    """Replay a prior result when its username no longer resolves.

    The key is user- and operation-scoped, so this lookup cannot expose another
    payer's result. Valid current targets still flow through the fingerprint
    check in `_claim`, preserving changed-recipient rejection.

    `receipt_guard(response, stored_body)` is the caller's last say over the
    replay it is about to send. The subscribe route passes one because this is
    the only replay path where `star` is None -- the username has moved -- so
    it cannot apply the lapsed-month rule from the outside, and the stored
    body is the only thing that still names the creator. A donation has no
    entitlement to outlive and passes nothing.
    """
    record = idempotency.replay_record_or_release_abandoned(
        scope, user, key,
    )
    if record is None:
        return None
    if record.abandoned_at is not None:
        return _abandoned_response()
    if record.response_status is None:
        return _credit_error(
            "request_in_progress",
            "The original request is still in progress.",
            status.HTTP_409_CONFLICT,
        )
    if not isinstance(record.response_body, dict):
        return _credit_error(
            "invalid_idempotency_record",
            "The original response could not be replayed safely.",
            status.HTTP_409_CONFLICT,
        )
    if (
        record.response_body.get("_unresolved_fingerprint")
        != unresolved_fingerprint
    ):
        return _credit_error(
            "idempotency_mismatch",
            "This idempotency key was already used for a different request.",
            status.HTTP_409_CONFLICT,
        )
    replay = {
        key: value
        for key, value in record.response_body.items()
        if key not in SERVER_ONLY_RECEIPT_FIELDS
    }
    replay["replayed"] = True
    response = Response(
        replay,
        status=record.response_status,
    )
    if receipt_guard is not None:
        return receipt_guard(response, record.response_body)
    return response


def _never_report_a_membership_that_ended_by_id(response, fan, creator_pk):
    """`_never_report_a_membership_that_ended` for a moved username.

    After a rename the requested username resolves to nobody, so the route
    has no `star` to ask about the membership -- but the receipt names the
    creator by immutable id, which is the whole reason  started storing
    it. Without this the rename is the ONE replay path that skips the
    lapsed-month rule, and the rule is published as covering every replay
    both subscribe routes can emit. (Codex adversarial review, round 5.)

    A receipt with no `_creator_pk` (it predates ) or naming a row that
    has since been deleted cannot be attributed, so the rule cannot be
    applied and the replay is returned unchanged -- the behaviour before this
    guard existed. Nothing is charged on this path either way.
    """
    if creator_pk is None:
        return response
    star = Creator.objects.filter(pk=creator_pk).first()
    if star is None:
        return response
    return _never_report_a_membership_that_ended(response, fan, star)


# One billing cycle: `Subscription.extend()` sets
# `expires = max(old_expires, now) + SUBSCRIPTION_PERIOD`. Imported, not
# restated — if the product ever shortens the period, a 30-day literal here
# would keep advertising a window in which a subscription can be charged twice.
RENEWAL_CYCLE = SUBSCRIPTION_PERIOD

# The window this endpoint can speak for, and why it is 29 days rather than 30.
#
# A renewal is not charged AT expiry — `renew_subscription` fires at
# `expires - RENEWAL_LEAD` (24h early) and then retries hourly. So a 30-day
# window measured in CHARGES is not a 30-day window measured in EXPIRIES. A sub
# expiring in 12 hours charges now, moves to day 30.5, and its next charge is
# attempted on day 29.5 — a SECOND debit inside a 30-day claim, which is
# exactly the overstatement this endpoint exists to prevent.
#
# Charging at most once therefore requires `HORIZON <= RENEWAL_CYCLE -
# RENEWAL_LEAD`: after a charge at `T - LEAD`, the next one comes no earlier
# than `T + CYCLE - LEAD`, which is past the far edge for every active
# subscription (`T > now`).
RENEWAL_HORIZON = RENEWAL_CYCLE - RENEWAL_LEAD

# A charge lands inside that window iff the attempt time `expires - LEAD` does,
# i.e. iff `expires <= now + HORIZON + LEAD` (== now + one cycle).
RENEWAL_EXPIRY_CUTOFF = RENEWAL_HORIZON + RENEWAL_LEAD


def _subscription_renewal_summary(fan: Creator, now=None):
    """What the fan will be charged for renewals over one billing cycle.

    Renewal jobs charge each subscription independently, but every charge draws
    from this one balance.  The dashboard therefore sums the charges that fall
    due in the next ``RENEWAL_HORIZON`` for every subscription that passes the
    worker's static eligibility checks: it must be active, have a positive
    creator price, and have a ceiling at least as high as that price.  The
    worker's per-charge ``fan.tuzis >= price`` guard is intentionally not
    applied to each row; comparing the aggregate to the shared balance is the
    problem this endpoint is diagnosing.

    An over-ceiling subscription (``member_price > max_price``) is the case
    that matters most: the worker refuses it at ANY balance, so counting it
    would tell the fan to buy 2Z that cannot make the renewal happen.  An
    unpriced subscription is not chargeable either and contributes zero rather
    than blanking the whole indicator.  A creator price of exactly 0 is the one
    deliberate divergence — the worker would "charge" it, this skips it — and
    it moves the total by 0 2Z either way.

    THE HORIZON IS THE POINT.  An unbounded "one next renewal each" sum is not
    an affordability statement: with a 10-2Z subscription expiring tomorrow and
    a prepaid 10-2Z subscription expiring in 61 days, a 20-2Z balance sums to
    "ok" while the first subscription actually renews twice inside those 61
    days and drains the balance before the second is ever charged.  Counting
    only the charges that fall inside ``RENEWAL_HORIZON`` makes "your balance
    covers these" true as stated, and the response carries ``horizon_days`` so
    the copy names the same window the query measured.

    It is still a SNAPSHOT at current prices.  A creator raising their price
    after this response can defeat a balance that covered the old one, which is
    why the copy says "at today's prices" rather than making a promise about
    the future.
    """
    now = now or timezone.now()
    cutoff = now + RENEWAL_EXPIRY_CUTOFF
    chargeable = Subscription.objects.filter(
        fan=fan,
        star__is_active=True,
        expires__gt=now,
        expires__lte=cutoff,
        max_price__gt=0,
        star__member_price__gt=0,
        star__member_price__lte=F('max_price'),
    )

    aggregate = chargeable.aggregate(
        total_upcoming=Sum('star__member_price'),
        next_renewal=Min('expires'),
        # The balance is read HERE, in the same statement as the sum it will be
        # compared against, and not taken from `request.user` — that row was
        # loaded during authentication, and a renewal committing in between
        # would have this page compare a pre-charge balance against a
        # post-charge set of subscriptions and call it "covered". Every row is
        # the same fan, so Max is just "the value". (codex review.)
        balance=Max('fan__tuzis'),
    )
    if aggregate['next_renewal'] is None:
        return {
            'status': 'none',
            # No rows, so no balance came back with them. Nothing is compared
            # against it on this branch; it is reported for display only.
            'balance': fan.tuzis,
            'total_upcoming': Decimal('0'),
            'shortfall': Decimal('0'),
            'next_renewal': None,
            'horizon_days': RENEWAL_HORIZON.days,
        }

    total_upcoming = aggregate['total_upcoming'] or Decimal('0')
    balance = aggregate['balance']
    shortfall = max(Decimal('0'), total_upcoming - balance)

    return {
        'status': 'shortfall' if shortfall > 0 else 'ok',
        'balance': balance,
        'total_upcoming': total_upcoming,
        'shortfall': shortfall,
        'next_renewal': aggregate['next_renewal'],
        'horizon_days': RENEWAL_HORIZON.days,
    }


class Donate2Z(APIView):
    """
    Donate 2Z to the creator in the url
    """

    permission_classes = [
        IsAuthenticated,
    ]
    @extend_schema(
        responses={
            200: OpenApiResponse(
                response={"type": "string", "format": "decimal"},
                description="The donor's remaining 2Z balance.",
            ),
            400: CreditErrorSerializer,
            402: InsufficientFundsErrorSerializer,
            404: CreditErrorSerializer,
        }
    )
    def post(self, request, *args, **kwargs):
        # Preserve the original scalar success response and optional-header
        # behavior on this URL. New clients that need exactly-once replay use
        # /donate-idempotent/ instead; the legacy endpoint still shares the
        # machine-readable insufficient-funds contract.
        star: Creator = get_object_or_404(
            Creator, username=kwargs.get('username'), is_active=True
        )
        fan: Creator = request.user
        try:
            amount = ledger.to_tuzis(request.data.get('amount'))
        except (ValueError, TypeError):
            return Response(
                {'error': 'Request must contain amount > 1 and < balance'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if star.username == fan.username:
            return Response(
                {'error': "Don't donate to yourself, lol"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if amount < 1:
            return Response(
                {'error': 'Request must contain amount > 1 and < balance'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        anonymous = request.data.get('anon', False)
        try:
            with transaction.atomic():
                ledger.transfer(fan, star, amount, action="donation")
                Event.objects.create(
                    type="DONATION_SENT",
                    receiving_user=fan,
                    contributor=fan if not anonymous else None,
                    payee=star,
                    amount=amount,
                    content_object=star,
                    read=True,
                )
                Event.objects.create(
                    type="DONATION_RECEIVED",
                    receiving_user=star,
                    contributor=fan if not anonymous else None,
                    payee=star,
                    amount=amount,
                    content_object=star if anonymous else fan,
                )
        except ledger.InsufficientFunds as exc:
            return Response(
                ledger.insufficient_funds_payload(exc, action="donation"),
                status=status.HTTP_402_PAYMENT_REQUIRED,
            )
        except ledger.InactiveCreator:
            return Response(
                {'error': 'Creator not found'},
                status=status.HTTP_404_NOT_FOUND,
            )
        return Response(str(fan.tuzis))


class IdempotentDonate2Z(APIView):
    """Explicit retry-safe donation contract; legacy Donate2Z stays intact."""

    # The claim must commit before the money transaction begins so a duplicate
    # sees `request_in_progress` instead of blocking on an uncommitted unique
    # index entry for the lifetime of the original request.
    atomic_request = False
    permission_classes = [IsAuthenticated]

    @extend_schema(
        parameters=[CONFIRMED_IDEMPOTENCY_KEY_PARAMETER],
        request=IdempotentDonationRequestSerializer,
        responses={
            200: IdempotentDonationResultSerializer,
            400: CreditErrorSerializer,
            402: InsufficientFundsErrorSerializer,
            404: CreditErrorSerializer,
            409: CreditErrorSerializer,
        },
        description=(
            "Atomically transfer 2Z and record a replayable response. The "
            "idempotency key is bound to recipient, amount, and anonymity. "
            "This explicit route supports backend-first rollout: clients "
            "must not fall back to the legacy donation POST after an "
            "ambiguous response. "
            "`intent: ppv` (the former pay-per-view unlock) is retired: a "
            "new request is refused with 400 `ppv_unlock_retired` and moves "
            "nothing, because PPV admission is a balance reserve and PPV is "
            "billed per minute watched; a key that completed a `ppv` unlock "
            "before the retirement still replays its receipt. "
            f"Completed results replay for "
            f"{idempotency.COMPLETED_CLAIM_RETENTION.days} days."
        ),
    )
    def post(self, request, *args, **kwargs):
        fan: Creator = request.user
        key = _idempotency_key(request)
        if key is None:
            return _credit_error(
                "idempotency_key_required",
                "A valid UUIDv4 Idempotency-Key header is required.",
                status.HTTP_400_BAD_REQUEST,
            )
        serializer = IdempotentDonationRequestSerializer(data=request.data)
        if not serializer.is_valid():
            return _credit_error(
                "invalid_request",
                "Enter a whole donation of at least 1 2Z.",
                status.HTTP_400_BAD_REQUEST,
            )
        # Preserve the 2Z field's canonical three-decimal response and
        # idempotency fingerprint while the request itself is constrained to
        # whole 2Z amounts (parity with 's call-site ceil; the audit
        # column itself is Decimal and no longer the reason).
        amount = serializer.validated_data["amount"].quantize(
            ledger.TUZI_EXPONENT)
        anonymous = serializer.validated_data["anon"]
        intent = serializer.validated_data["intent"]
        target_username = kwargs.get("username")
        unresolved_fingerprint = idempotency.fingerprint({
            "recipient_username": target_username,
            "amount": str(amount),
            "anonymous": anonymous,
            "action": intent,
        })
        star = Creator.objects.filter(username=target_username).first()
        if star is None:
            if Creator.objects.filter(username=target_username).exists():
                return _credit_error(
                    "recipient_not_found",
                    "Recipient not found.",
                    status.HTTP_404_NOT_FOUND,
                )
            replay = _replay_when_target_moved(
                "donate-idempotent", fan, key, unresolved_fingerprint)
            if replay is not None:
                return replay
            return _credit_error(
                "recipient_not_found",
                "Recipient not found.",
                status.HTTP_404_NOT_FOUND,
            )
        if fan.pk == star.pk:
            return _credit_error(
                "self_send",
                "You cannot donate to yourself.",
                status.HTTP_400_BAD_REQUEST,
            )

        request_hash = idempotency.fingerprint({
            "recipient": str(star.pk),
            "recipient_username": target_username,
            "amount": str(amount),
            "anonymous": anonymous,
            "action": intent,
        })
        claim, duplicate_response = _claim(
            "donate-idempotent",
            fan,
            key,
            request_hash,
        )
        if duplicate_response is not None:
            # Including a `ppv` receipt from before: that unlock DID
            # move 2Z, so a retry of it must hear "already recorded", never
            # the refusal below.
            return duplicate_response
        if intent == PPV_UNLOCK_INTENT:
            # The PPV "unlock" bought nothing. Admission is a reserve
            # check on the balance, and PPV is billed per minute when the
            # viewer leaves; no entitlement was ever recorded, so the unlock
            # only lowered the balance the gate tests. It was offered after a
            # join had been refused for being under that reserve -- so paying
            # it made admission LESS likely, and a viewer could pay, be
            # refused, and pay again until the account was empty. Refuse a
            # new one here, server side, so an old bundle or a direct API
            # caller cannot buy it either. Nothing has moved yet; drop the
            # claim so no receipt implies otherwise.
            idempotency.release(claim)
            return _credit_error(
                "ppv_unlock_retired",
                "Pay-per-view streams are not unlocked with an up-front "
                "payment. Join the stream: you need the stream's entry "
                "reserve in your balance, and you are charged per minute "
                "watched.",
                status.HTTP_400_BAD_REQUEST,
            )
        if not star.is_active:
            idempotency.release(claim)
            return _credit_error(
                "recipient_not_found",
                "Recipient not found.",
                status.HTTP_404_NOT_FOUND,
            )

        try:
            with transaction.atomic():
                ledger.transfer(fan, star, amount, action=intent)
                Event.objects.create(
                    type="DONATION_SENT",
                    receiving_user=fan,
                    contributor=fan if not anonymous else None,
                    payee=star,
                    amount=amount,
                    content_object=star,
                    read=True,
                )
                Event.objects.create(
                    type="DONATION_RECEIVED",
                    receiving_user=star,
                    contributor=fan if not anonymous else None,
                    payee=star,
                    amount=amount,
                    content_object=star if anonymous else fan,
                )
                body = {
                    "balance": str(fan.tuzis),
                    "charged": str(amount),
                    "replayed": False,
                }
                claim.finish(
                    status.HTTP_200_OK,
                    _stored_response(body, unresolved_fingerprint),
                )
        except ledger.InsufficientFunds as exc:
            idempotency.release(claim)
            payload = ledger.insufficient_funds_payload(
                exc, action=intent
            )
            return Response(payload, status=status.HTTP_402_PAYMENT_REQUIRED)
        except ledger.InactiveCreator:
            idempotency.release(claim)
            return _credit_error(
                "recipient_not_found",
                "Recipient not found.",
                status.HTTP_404_NOT_FOUND,
            )
        except Exception:
            idempotency.release(claim)
            raise

        return Response(body)


class ConfirmedSubscribeView(APIView):
    """Price-bound, retry-safe membership purchase for interactive clients."""

    # This route owns its explicit transaction boundaries and must not be
    # wrapped by AtomicMiddleware. The shared claim is committed before the
    # money transaction, so a cross-route duplicate sees the claim while the
    # original request is still charging instead of racing past an
    # uncommitted row.
    atomic_request = False
    permission_classes = [IsAuthenticated]

    @extend_schema(
        parameters=[
            SUBSCRIBE_CONFIRMED_IDEMPOTENCY_KEY_PARAMETER,
            SUPERSEDED_IDEMPOTENCY_KEY_PARAMETER,
        ],
        request=ConfirmedSubscriptionRequestSerializer,
        responses={
            200: ConfirmedSubscriptionResultSerializer,
            400: CreditErrorSerializer,
            402: InsufficientFundsErrorSerializer,
            404: CreditErrorSerializer,
            409: OpenApiResponse(
                response=CreditErrorSerializer,
                description=(
                    "`subscription_retryable` means a lock timeout left the "
                    "request undecided; retry with the SAME "
                    "Idempotency-Key. `subscription_intent_abandoned` means "
                    "authenticated recovery fenced this key; retire it and "
                    "use a fresh key for a deliberate new purchase."
                ),
            ),
        },
        description=(
            "Purchase 30 days only when the creator's transaction-locked "
            "price equals expected_price. A new subscription renews at that "
            "ceiling; an existing subscription retains its current renewal "
            "ceiling, including zero after cancellation. This explicit route "
            "supports backend-first rollout; clients must "
            "not fall back to the legacy subscription POST after an "
            "ambiguous response. Completed results "
            "replay for "
            f"{idempotency.COMPLETED_CLAIM_RETENTION.days} days. "
            "A key that already completed a legacy POST "
            "/api/tuzis/subscribe/{username}/ for the same creator is "
            "replayed here too (replayed: true, nothing charged) rather than "
            "claimed anew, so a client may move an outstanding purchase "
            "intent from that route to this one without paying twice. "
            "That replay is the ONE 200 on this route that expected_price "
            "does not constrain, and it cannot be: the legacy route binds no "
            "price and records none, so the amount it debited is not "
            "recoverable from its receipt. Read it as 'this key already "
            "bought this membership, on a route that charged whatever the "
            "price was then' -- nothing is charged now, and `balance` is the "
            "fan's real balance either way. The same applies to a receipt "
            "reached through X-Superseded-Idempotency-Key. That carry-over "
            "replay only happens while the membership it bought is still "
            "running: receipts are kept far longer than 30 days, so a "
            "receipt whose month has already ENDED is not replayed -- you "
            "are not subscribed and it would be false -- and is not charged "
            "under that key either. It is 409 `idempotency_mismatch` with "
            "`key_resolved: true`, and the month is bought by the next "
            "request, under the fresh key that answer tells you to mint. "
            "Every replay on this route is guarded that way, including the "
            "replay of a receipt recorded under this very key. "
            "One other 200 is unbound for the same kind of reason: if your "
            "key already completed a purchase HERE, of a membership you are "
            "STILL holding from this creator, a retry of it at a different "
            "expected_price replays that purchase (replayed: true, nothing "
            "charged) rather than refusing. That key bought the month you "
            "are holding, so reporting it is the honest answer, and telling "
            "you to mint a fresh one would buy a second month for a fan "
            "trying to recover one purchase. Retire the key on that 200 like "
            "any other, and a deliberate extra month is then a normal "
            "purchase at the current price. Once the membership has lapsed "
            "the same retry is a 409 `idempotency_mismatch` with "
            "`key_resolved: true`, because then the receipt really does "
            "describe a request that is over. "
            "A NEW debit is always bound to expected_price. "
            "expected_price 0 confirms a FREE membership (a free follow): "
            "it grants the same 30 days and moves no 2Z, so `charged: true` "
            "there means the membership was extended, not that 2Z moved. "
            "On every 200, `balance` is the fan's balance as of this reply, "
            "including a replay; `charged` and `expires` describe the "
            "original request."
        ),
    )
    def post(self, request, *args, **kwargs):
        fan: Creator = request.user
        key = _idempotency_key(request)
        if key is None:
            return _credit_error(
                "idempotency_key_required",
                "A valid UUIDv4 Idempotency-Key header is required.",
                status.HTTP_400_BAD_REQUEST,
            )
        serializer = ConfirmedSubscriptionRequestSerializer(data=request.data)
        if not serializer.is_valid():
            return _credit_error(
                "invalid_request",
                "expected_price must be a non-negative whole 2Z amount.",
                status.HTTP_400_BAD_REQUEST,
            )
        expected_price = serializer.validated_data["expected_price"]
        requested_creator_id = serializer.validated_data.get("creator_id")
        target_username = kwargs.get("username")
        unresolved_fingerprint = idempotency.fingerprint({
            "creator_username": target_username,
            "expected_price": str(expected_price),
        })
        star = Creator.objects.filter(username=target_username).first()
        if star is None and requested_creator_id is not None:
            # The URL is a mutable display locator. On a retry after this
            # creator renamed, resolve by the immutable id carried by the
            # dialog so the original intent can still replay. If the stale
            # URL now resolves to another creator, the check below rejects it
            # before any historical lookup or claim.
            star = Creator.objects.filter(pk=requested_creator_id).first()
        if star is None:
            if Creator.objects.filter(username=target_username).exists():
                return _credit_error(
                    "creator_not_found",
                    "Creator not found.",
                    status.HTTP_404_NOT_FOUND,
                )
            replay = _replay_when_target_moved(
                CONFIRMED_SUBSCRIBE_SCOPE, fan, key,
                unresolved_fingerprint,
                # The lapsed-month rule, applied to the one replay that has
                # no `star` to apply it from. See
                # `_never_report_a_membership_that_ended_by_id`.
                receipt_guard=lambda response, body: (
                    _never_report_a_membership_that_ended_by_id(
                        response, fan, body.get("_creator_pk"),
                    )
                ),
            )
            if replay is not None:
                return _with_live_balance(replay, fan)
            return _credit_error(
                "creator_not_found",
                "Creator not found.",
                status.HTTP_404_NOT_FOUND,
            )
        if fan.pk == star.pk:
            return _credit_error(
                "self_subscription",
                "You cannot subscribe to yourself.",
                status.HTTP_400_BAD_REQUEST,
            )
        if (
            requested_creator_id is not None
            and requested_creator_id != star.pk
        ):
            return _credit_error(
                "creator_changed",
                "The creator changed before this purchase completed.",
                status.HTTP_409_CONFLICT,
            )

        compatibility_request_hash = idempotency.fingerprint({
            "creator": star.pk,
            "creator_username": star.username,
            "expected_price": str(expected_price),
        })
        request_hash = idempotency.fingerprint({
            "creator": str(star.pk),
            "intent": "subscribe",
        })

        # Deliberately BEFORE the `is_active` gate below, and the same
        # ordering `_claim`'s own replay has always had (pinned by
        # test_confirmed_subscription_replays_after_creator_deactivation).
        # A receipt reports money that already moved, and what the creator
        # changed afterwards cannot alter that; answering 404/400 to the
        # retry of a COMMITTED purchase is a false failure the client cannot
        # recover from, because neither answer carries `key_resolved`, so the
        # key is kept and re-sent forever. (Adversarial review of.)
        legacy_replay = _legacy_subscribe_receipt(
            fan, star, key, check_abandoned=False,
        )
        if legacy_replay is not None:
            return legacy_replay
        # Receipts written by the pre-shared-namespace confirmed route remain
        # valid. New requests below claim the route-independent per-creator
        # scope, but this old fan-wide scope must still be consulted first.
        confirmed_replay = _confirmed_subscribe_receipt(
            fan,
            star,
            key,
            request_hash=compatibility_request_hash,
            check_abandoned=False,
        )
        if confirmed_replay is not None:
            return confirmed_replay
        if _subscription_intent_is_abandoned(star, key):
            return _abandoned_response()
        # The same lookup for a key this client has RETIRED because it can no
        # longer be sent as Idempotency-Key. Read-only: see
        # SUPERSEDED_IDEMPOTENCY_KEY_PARAMETER. Only the legacy scope is
        # consulted, because a retired key is by definition not a UUIDv4 and
        # this route has never accepted one.
        superseded = _superseded_idempotency_key(request)
        if superseded is not None:
            replay = _legacy_subscribe_receipt(fan, star, superseded)
            if replay is not None:
                return _bind_replacement_key(
                    replay, fan, star, key,
                    request_hash, unresolved_fingerprint,
                )
        # Preserve the confirmed route's fan-wide key contract as well as
        # the per-creator gate shared with legacy POST. Always claim fan-wide
        # first; neither claim holds a lock across the subsequent claim call.
        compatibility_claim, compatibility_duplicate = _claim(
            CONFIRMED_SUBSCRIBE_SCOPE, fan, key, compatibility_request_hash,
            on_conflict=lambda record: (
                _completed_purchase_this_key_already_made(record, fan, star)
            ),
            initial_body=_subscription_pending_body(star),
        )
        if compatibility_duplicate is not None:
            return _with_live_balance(
                _replay_shared_subscribe_claim(
                    compatibility_duplicate, fan, star, "confirmed",
                ), fan,
            )

        compatibility_committed = False
        try:
            claim, duplicate_response = _claim(
                _subscribe_scope(star),
                fan,
                key,
                request_hash,
                # A finished claim under a DIFFERENT fingerprint is not proof the
                # fan has not already bought this membership with this key.
                on_conflict=lambda record: (
                    _completed_purchase_this_key_already_made(record, fan, star)
                ),
                initial_body=_subscription_pending_body(star),
            )
            if duplicate_response is not None:
                # `_claim`'s own replay hands back the stored body verbatim, and a
                # stored body cannot know whether the month it describes is still
                # running -- including the bridged alias, whose fingerprint MATCHES
                # a later retry and so never reaches the mismatch path at all.
                return _with_live_balance(
                    _replay_shared_subscribe_claim(
                        duplicate_response, fan, star, "confirmed",
                    ),
                    fan,
                )
            if not star.is_active:
                idempotency.release(claim)
                return _credit_error(
                    "creator_not_found",
                    "Creator not found.",
                    status.HTTP_404_NOT_FOUND,
                )

            try:
                with transaction.atomic():
                    _lock_subscription_intent(star, key)
                    sub, _ = Subscription.objects.get_or_create(
                        star=star,
                        fan=fan,
                        defaults={"max_price": expected_price},
                    )
                    charged = sub.extend(expected_price=expected_price)
                    fan.refresh_from_db(fields=["tuzis"])
                    body = {
                        "balance": str(fan.tuzis),
                        "charged": charged,
                        "replayed": False,
                        "expires": sub.expires.isoformat(),
                        "subscription": SubscriptionSerializer(sub).data,
                    }
                    _finish_subscribe_claim(
                        claim,
                        body,
                        unresolved_fingerprint,
                        fan,
                        star,
                        request_hash,
                        "confirmed",
                        compatibility_request_hash=compatibility_request_hash,
                        compatibility_claim=compatibility_claim,
                    )
                compatibility_committed = True
            except _SubscriptionIntentAbandoned:
                idempotency.release(claim)
                return _abandoned_response()
            except EconomicRefusal as exc:
                idempotency.release(claim)
                return _credit_error(str(exc), "This utility sharing transfer is temporarily unavailable.", status.HTTP_409_CONFLICT)
            except ledger.ExpectedPriceMismatch as mismatch:
                idempotency.release(claim)
                return _credit_error(
                    "price_changed",
                    "The creator's current membership price differs from the confirmed price.",
                    status.HTTP_409_CONFLICT,
                    current_price=(
                        str(mismatch.current)
                        if mismatch.current is not None
                        else None
                    ),
                )
            except ledger.InactiveCreator:
                idempotency.release(claim)
                return _credit_error(
                    "creator_not_found",
                    "Creator not found.",
                    status.HTTP_404_NOT_FOUND,
                )
            except OperationalError as exc:
                idempotency.release(claim)
                if _is_subscription_lock_timeout(exc):
                    return _subscription_lock_retryable_response()
                raise
            except ledger.InsufficientFunds as exc:
                idempotency.record_subscription_intent_release(claim, star.pk)
                payload = ledger.insufficient_funds_payload(
                    exc, action="subscription"
                )
                return Response(payload, status=status.HTTP_402_PAYMENT_REQUIRED)
            except Exception:
                idempotency.release(claim)
                raise

            return Response(body)
        finally:
            # Also covers shared-claim replay/refusal and exceptions before
            # entering the money transaction. A rolled-back finish must not
            # strand the fan-wide claim, so use transaction completion, not
            # the in-memory receipt's response_status, as the success flag.
            if not compatibility_committed:
                idempotency.release(compatibility_claim)



class SubscriptionStatusView(APIView):
    """Target-specific entitlement fact, independent of mutable pagination."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        responses={
            200: SubscriptionStatusSerializer,
            404: CreditErrorSerializer,
        },
        description=(
            "Return this fan's authoritative membership state for one creator."
        ),
    )
    def get(self, request, *args, **kwargs):
        star = Creator.objects.filter(
            username=kwargs.get("username"), is_active=True
        ).first()
        if star is None:
            return _credit_error(
                "creator_not_found",
                "Creator not found.",
                status.HTTP_404_NOT_FOUND,
            )
        sub = Subscription.objects.filter(
            star=star,
            fan=request.user,
        ).first()
        return Response({
            "username": star.username,
            "active": bool(sub and sub.expires > timezone.now()),
            "expires": sub.expires.isoformat() if sub else None,
            "max_price": str(sub.max_price) if sub else None,
            "current_price": (
                str(star.member_price)
                if star.member_price is not None
                else None
            ),
        })


class CreatorSubscribeView(APIView):
    """
    Subscribe the request.user as a fan to the star in the urls.

    Add another 30 days if repeated... hrm...
    """

    permission_classes = [IsAuthenticated]

    # POST owns an explicit claim-before-charge transaction. Keep PATCH in the
    # request-wide transaction (and DELETE's existing explicit transaction)
    # because `atomic_request = False` is a class-wide switch.
    non_atomic_methods = frozenset({"POST"})

    # Optional client-supplied header. When present it must be a UUIDv4
    # (anything else is 400 `invalid_idempotency_key`, ), and the same
    # key can be retried for the published 365-day horizon and will replay
    # the first response instead of charging again. Absent, the
    # last_charged_at debounce in Subscription.extend() still applies.
    # The header name and its published description live at module level
    # (IDEMPOTENCY_KEY_PARAMETER) so the code and the contract cannot drift
    # -- and test_legacy_subscribe_idempotency_key_contract_is_the_enforced_rule
    # pins the generated schema to what _idempotency_key actually accepts,
    # because the new-ui no longer calls this route  and nothing else
    # would notice the two diverging again.
    IDEMPOTENCY_HEADER = IDEMPOTENCY_KEY_HEADER
    IDEMPOTENCY_SCOPE = LEGACY_SUBSCRIBE_SCOPE

    @extend_schema(
        parameters=[IDEMPOTENCY_KEY_PARAMETER],
        # A retry protocol a client cannot type against is a retry protocol it
        # will not follow. The spec previously said "No response body" for the
        # 200 and did not mention 409 at all, so a generated client saw `void`
        # and an undifferentiated exception — it could not tell "still running,
        # ask again with the same key" from "failed, start over", which is
        # exactly the confusion that produces a second charge.
        responses={
            200: OpenApiResponse(
                response={
                    'type': 'object',
                    'required': ['charged', 'expires', 'replayed'],
                    'properties': {
                        'charged': {
                            'type': 'boolean',
                            'description': (
                                'True if 2Z moved for the request this body '
                                'describes. False means it was absorbed as a '
                                'duplicate of a very recent one; the fan is '
                                'subscribed either way. On an Idempotency-Key '
                                'replay this still describes the ORIGINAL '
                                'call, so do not decrement cached 2Z '
                                'again on seeing it.'
                            ),
                        },
                        'expires': {
                            'type': 'string',
                            'format': 'date-time',
                            'description': (
                                'Membership end date as of this request. Use '
                                'it rather than assuming the previous value '
                                'plus 30 days. On an Idempotency-Key replay '
                                'it is the value recorded then and a later '
                                'renewal may have pushed it out since, so '
                                'refresh from my-subscriptions instead of '
                                'writing a replayed value over current state.'
                            ),
                        },
                        'replayed': {
                            'type': 'boolean',
                            'description': (
                                'True when this is the replay of a completed '
                                'Idempotency-Key request rather than a new '
                                'subscription attempt.'
                            ),
                        },
                    },
                },
                description=(
                    'Subscribed. A replay of a previously completed '
                    'Idempotency-Key returns the original body here verbatim, '
                    'so treat it as a record of that request rather than as a '
                    'live read of the membership.'
                ),
            ),
            400: OpenApiResponse(
                response={
                    'type': 'object',
                    'required': ['error'],
                    'properties': {
                        'error': {'type': 'string'},
                        'code': {
                            'type': 'string',
                            'description': (
                                'Present as `invalid_idempotency_key` when '
                                'an Idempotency-Key header was sent but is '
                                'not a canonical UUIDv4. Nothing was '
                                'charged; do NOT discard the key and mint '
                                'another on a retry -- check '
                                'my-subscriptions first, because the original '
                                'request under that key may have completed.'
                            ),
                        },
                    },
                },
                description=(
                    'Not chargeable: subscribing to yourself, the creator '
                    'set no member price, or the Idempotency-Key header is '
                    'present but is not a UUIDv4 (`code` says which).'
                ),
            ),
            402: InsufficientFundsErrorSerializer,
            409: OpenApiResponse(
                response={
                    'type': 'object',
                    'required': ['error'],
                    'properties': {
                        'error': {'type': 'string'},
                        'code': {
                            'type': 'string',
                            'description': (
                                '`idempotency_mismatch` when this key is '
                                'already spent on a different request for '
                                'THIS creator -- including one made on POST '
                                '/api/tuzis/subscribe-confirmed/{username}/, '
                                'whose keys share this namespace, or one '
                                'recorded there without a '
                                'recipient id and so no longer attributable '
                                'to a creator at all. A confirmed receipt '
                                'that is positively another creator\'s is '
                                'not this request and is charged normally '
                                'under this route\'s per-creator scope. It '
                                'also covers a key spent on a membership '
                                'that has since ENDED, on either route: that '
                                'receipt is real, but the month it bought is '
                                'over, so it is neither replayed (you are '
                                'not subscribed) nor charged again under the '
                                'same key -- `key_resolved: true` says to '
                                'retire it and buy under a fresh one. '
                                '`invalid_idempotency_record` when a receipt '
                                'exists but cannot be replayed safely -- a '
                                'stored body this route cannot read, or one '
                                'with no membership recorded at all. '
                                'Absent on the in-flight answer. '
                                '`subscription_retryable` means a lock timeout '
                                'left the request undecided; reuse the SAME '
                                'Idempotency-Key. '
                                '`subscription_intent_abandoned` means '
                                'authenticated recovery fenced this key; retire '
                                'it and use a fresh key for a deliberate new '
                                'purchase.'
                            ),
                        },
                        # Published because it is the ONLY escape from a
                        # permanent 409, and a client generated from this
                        # spec cannot read a field the spec does not declare
                        # ( is exactly that drift, in the other
                        # direction). The confirmed route publishes it via
                        # CreditErrorSerializer; keep the two wordings in
                        # step.
                        'key_resolved': {
                            'type': 'boolean',
                            'description': (
                                'Only on `idempotency_mismatch`, and only '
                                'when this endpoint can prove it: true means '
                                'the request recorded under your '
                                'Idempotency-Key has FINISHED and cannot be '
                                'the one you are making now -- another '
                                'creator\'s, or a membership that has since '
                                'ended -- so retire that key and mint a new '
                                'one. It is NOT merely "a different request '
                                'finished": a finished receipt for a '
                                'membership you are still holding is your '
                                'own purchase and replays as a 200 instead, '
                                'because retiring the key there would buy a '
                                'second month. False means it may still be '
                                'committing -- reuse the SAME key. Absent '
                                'means the endpoint could not tell (a '
                                'receipt it cannot attribute), which is also '
                                'a reason to reuse the same key. Without '
                                'this a client that keeps one key per '
                                'purchase intent can be answered 409 for the '
                                'receipt\'s whole retention horizon with no '
                                'way to recover.'
                            ),
                        },
                    },
                },
                description=(
                    'Either a request with this Idempotency-Key is still in '
                    'flight — undecided, not failed, so retry the SAME key '
                    'rather than issuing a new one — or the key is already '
                    'spent on a different request (`code` says which). '
                    'Nothing was charged in either case. On '
                    '`idempotency_mismatch`, `key_resolved` says whether '
                    'that other request has finished, which is what makes '
                    'minting a fresh key safe rather than a second charge. '
                    '`subscription_retryable` means a lock timeout left the '
                    'request undecided; retry with the same key. '
                    '`subscription_intent_abandoned` means authenticated '
                    'recovery fenced this key; retire it before a deliberate '
                    'new purchase.'
                ),
            ),
        },
    )
    def post(self, request, *args, **kwargs):
        # this buys 30 more days of a creator
        star: Creator = get_object_or_404(
            Creator, username=kwargs.get('username'))
        fan: Creator = request.user

        if star.username == fan.username:
            return Response(
                data={'error': "Don't subscribe to yourself, lol"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        raw_idem_key = request.headers.get(self.IDEMPOTENCY_HEADER)
        idem_key = _idempotency_key(request)
        if raw_idem_key is not None and idem_key is None:
            return _credit_error(
                "invalid_idempotency_key",
                "Idempotency-Key must be a UUIDv4.",
                status.HTTP_400_BAD_REQUEST,
            )
        compatibility_claim = None
        compatibility_committed = False
        try:
            claim = None
            if idem_key:
                # Old confirmed receipts remain in their historical fan-wide
                # scope. New requests use the route-independent per-creator scope
                # below, so both routes contend on one committed claim before any
                # money transaction starts.
                # Also before the `is_active` / `member_price` gates below, for
                # the reason given on the mirror lookup in ConfirmedSubscribeView:
                # a committed purchase must not be reported as a 404/400 the
                # client can never recover from.
                confirmed_replay = _confirmed_subscribe_receipt(
                    fan,
                    star,
                    idem_key,
                    cross_creator_is_conflict=False,
                    check_abandoned=False,
                )
                if confirmed_replay is not None:
                    return _replay_shared_subscribe_claim(
                        confirmed_replay, fan, star, "legacy",
                    )
                legacy_replay = _legacy_subscribe_receipt(
                    fan, star, idem_key, route="legacy",
                    check_abandoned=False,
                )
                if legacy_replay is not None:
                    return legacy_replay
                if _subscription_intent_is_abandoned(star, idem_key):
                    return _abandoned_response()
                # Old pods claim this historical scope inside their request-wide
                # transaction BEFORE locking the subscription. Reserve it first,
                # committed, so no old-pod insert can invert our money-lock order.
                compatibility_request_hash = idempotency.fingerprint({
                    "creator": str(star.pk),
                    "creator_username": star.username,
                    "intent": "subscribe",
                })
                compatibility_claim, compatibility_duplicate = _claim(
                    f"{LEGACY_SUBSCRIBE_SCOPE}:{star.pk}", fan, idem_key,
                    compatibility_request_hash,
                    on_conflict=lambda record: (
                        _completed_purchase_this_key_already_made(
                            record, fan, star, scope_is_creator_bound=True,
                        )
                    ),
                    initial_body=_subscription_pending_body(star),
                )
                if compatibility_duplicate is not None:
                    return _replay_shared_subscribe_claim(
                        compatibility_duplicate, fan, star, "legacy",
                    )
                request_hash = idempotency.fingerprint({
                    "creator": str(star.pk),
                    "intent": "subscribe",
                })
                try:
                    # Scope the key to the TARGET and share this scope with the
                    # confirmed route. A key reused across two creators remains
                    # two independent legacy requests, as before.
                    claim = idempotency.claim(
                        _subscribe_scope(star),
                        fan,
                        idem_key,
                        request_hash=request_hash,
                        initial_body=_subscription_pending_body(star),
                    )
                except idempotency.IdempotencyConflict as conflict:
                    # A completed membership receipt is evidence of this
                    # purchase even if its historical fingerprint differs.
                    # Both this shared scope and the legacy scope name star.pk.
                    settled = _completed_purchase_this_key_already_made(
                        conflict.record, fan, star, scope_is_creator_bound=True,
                    )
                    if settled is not None:
                        return settled
                    return _credit_error(
                        "idempotency_mismatch",
                        "This idempotency key was already used for a different request.",
                        status.HTTP_409_CONFLICT,
                        # See `_claim`: true means the other request COMPLETED, so
                        # this key holds no evidence about the current intent and
                        # a new one may safely be minted. The guard above has
                        # already ruled out the one case where "completed" WOULD
                        # be evidence -- the membership this fan is still holding.
                        # Deliberately absent from the cross-route refusals below,
                        # where the receipt might be this very purchase.
                        key_resolved=(
                            conflict.record.response_status is not None
                        ),
                    )
                except idempotency.DuplicateRequest as dup:
                    if dup.in_flight:
                        # The original is still running. Reporting success would be
                        # a lie and reporting failure would invite another click,
                        # so say "ask again".
                        return Response(
                            data={'error': 'Request already in progress'},
                            status=status.HTTP_409_CONFLICT,
                        )
                    return _replay_shared_subscribe_claim(
                        Response(
                            {
                                **dup.record.response_body,
                                "replayed": True,
                            },
                            status=dup.record.response_status,
                        ),
                        fan,
                        star,
                        "legacy",
                    )

            if not star.is_active:
                if claim is not None:
                    idempotency.release(claim)
                return Response(
                    data={'error': 'Creator not found'},
                    status=status.HTTP_404_NOT_FOUND,
                )

            # member_price is NOT NULL and 0 is a FREE membership
            # (extend() grants the 30 days without touching the ledger). Only
            # a negative price -- unreachable through the validators, but the
            # column itself has no CHECK -- is refused before any lock.
            if star.member_price is None or star.member_price < 0:
                if claim is not None:
                    idempotency.release(claim)
                return Response(
                    data={'error': 'Creator did not set member price'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            try:
                # ONE transaction covering the charge AND the recording of the
                # idempotency result. This is what makes an unfinished claim mean
                # exactly one thing: "the charge did not commit". If the pod dies
                # mid-request, the money transaction and claim.finish() roll back
                # together, so the later stale-claim takeover in idempotency.claim
                # cannot re-run a charge that already happened.
                with transaction.atomic():
                    _lock_subscription_intent(star, idem_key)
                    sub, _ = Subscription.objects.get_or_create(
                        star=star,
                        fan=fan,
                        defaults={
                            'max_price': star.member_price,
                        },
                    )
                    # extend() is idempotent within SUBSCRIBE_DEBOUNCE and returns
                    # False when it swallowed a duplicate.
                    #
                    # Either way this is a 200: the caller ends up subscribed, and
                    # a retry that looks like a failure is exactly what makes
                    # people click a third time. But it says WHICH it was.
                    # Returning an identical "OK" for a charge and for a swallowed
                    # duplicate leaves the client — and anyone reading logs during
                    # an incident — unable to tell whether 2Z moved on a 2Z
                    # endpoint. `expires` rides along so the client can show the
                    # real membership end date instead of assuming +30 days.
                    charged = sub.extend()
                    body = {
                        'charged': charged,
                        'expires': sub.expires.isoformat(),
                        'replayed': False,
                    }
                    if claim is not None:
                        _finish_subscribe_claim(
                            claim,
                            body,
                            request_hash,
                            fan,
                            star,
                            request_hash,
                            "legacy",
                            compatibility_claim=compatibility_claim,
                        )
                compatibility_committed = True
            except _SubscriptionIntentAbandoned:
                if claim is not None:
                    idempotency.release(claim)
                return _abandoned_response()
            except OperationalError as exc:
                if claim is not None:
                    idempotency.release(claim)
                if _is_subscription_lock_timeout(exc):
                    return _subscription_lock_retryable_response()
                raise
            except ledger.InsufficientFunds as exc:
                if claim is not None:
                    # No 2Z moved, so don't burn the key.
                    idempotency.record_subscription_intent_release(
                        claim, star.pk,
                    )
                return Response(
                    data=ledger.insufficient_funds_payload(
                        exc, action="subscription"
                    ),
                    status=status.HTTP_402_PAYMENT_REQUIRED,
                )
            except EconomicRefusal as exc:
                if claim is not None:
                    idempotency.release(claim)
                return Response(data={'code': str(exc), 'error': 'This utility sharing transfer is temporarily unavailable.'}, status=status.HTTP_409_CONFLICT)
            except ledger.InactiveCreator:
                if claim is not None:
                    idempotency.release(claim)
                return Response(
                    data={'error': 'Creator not found'},
                    status=status.HTTP_404_NOT_FOUND,
                )
            except Exception:
                if claim is not None:
                    idempotency.release(claim)
                raise

            return Response(body)
        finally:
            # A finish rolled back with the money transaction is not durable.
            # Also release on shared-claim replay/refusal before charging.
            if compatibility_claim is not None and not compatibility_committed:
                idempotency.release(compatibility_claim)

    def get(self, request, *args, **kwargs):
        star: Creator = get_object_or_404(
            Creator, username=kwargs.get('username'))
        fan: Creator = request.user

        sub: Subscription = get_object_or_404(
            Subscription, star=star, fan=fan)

        return Response({
            "max_price": sub.max_price,
        })

    def delete(self, request, *args, **kwargs):
        """
        Set max_price to 0 so it won't renew.

        Cancellation is deliberately available after the creator is
        deactivated. New charges and renewals are blocked by the active-owner
        checks, but an existing recurring authorization must remain revocable
        while the creator is unavailable.
        """
        star: Creator = get_object_or_404(
            Creator, username=kwargs.get('username'))
        fan: Creator = request.user
        # Cancellation participates in the same Subscription-first lock
        # protocol as purchase/renewal. Updating only max_price prevents an
        # unlocked stale instance from erasing a just-paid expiry or debounce
        # timestamp after the charge commits.
        with transaction.atomic():
            sub: Subscription = get_object_or_404(
                Subscription.objects.select_for_update(),
                star=star,
                fan=fan,
            )
            sub.max_price = 0
            sub.save(update_fields=['max_price'])
        return Response("OK")

    @extend_schema(
        # drf-spectacular marks every field on a PATCH serializer optional.
        # This endpoint requires max_price, so describe that request invariant
        # explicitly instead of publishing the misleading auto-"Patched"
        # component that previously let generated callers send {}.
        request={
            'application/json': {
                'type': 'object',
                'required': ['max_price'],
                'properties': {
                    'max_price': {
                        'type': 'string',
                        'pattern': r'^(?:[1-9]\d{0,5}|1000000)$',
                        'description': (
                            'Maximum 2Z the authenticated fan permits per '
                            'renewal.'
                        ),
                        'example': '100',
                    },
                },
            },
        },
        responses={200: SubscriptionSerializer},
        description=(
            "Change the authenticated fan's maximum 2Z per renewal and "
            "return the authoritative subscription representation."
        ),
    )
    def patch(self, request, *args, **kwargs):
        star: Creator = get_object_or_404(
            Creator, username=kwargs.get('username'), is_active=True)
        fan: Creator = request.user

        sub: Subscription = get_object_or_404(
            Subscription, star=star, fan=fan)

        request_serializer = SubscriptionMaxPriceSerializer(data=request.data)
        request_serializer.is_valid(raise_exception=True)
        max_price = request_serializer.validated_data['max_price']
        # A free membership (price 0, ) accepts a cap too: it is the
        # fan's consent for the free follow to renew itself, and the most it
        # may ever be charged if the creator later raises the price.
        if star.member_price is None or star.member_price < 0:
            return Response(
                data={'error': 'Creator does not have a chargeable price'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not (max_price >= star.member_price and max_price <= fan.tuzis):
            return Response(
                data={
                    'error': 'max price should be between the price and what you have'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        sub.max_price = max_price
        sub.save(update_fields=['max_price'])
        return Response(SubscriptionSerializer(sub).data)


class _RecoveryResolved(Exception):
    """A concurrent or historical receipt proves that money settled."""


class _SubscriptionRecoveryRetryable(Exception):
    """A raced claim disappeared before recovery could classify it."""


def _recovery_tombstone(star, fan, scope, key, now):
    return idempotency.IdempotencyKey(
        scope=scope,
        user=fan,
        key=key,
        owner=uuid.uuid4(),
        response_status=status.HTTP_409_CONFLICT,
        response_body={
            "code": SUBSCRIPTION_INTENT_ABANDONED,
            "error": "This subscription attempt was abandoned. Start a new attempt.",
            "key_resolved": True,
            "_creator_pk": star.pk,
            "_subscription_intent": "abandoned",
        },
        abandoned_at=now,
        created_at=now,
    )


def _abandon_subscription_intent(
    fan, star, key, *, username=None, expected_price=None,
):
    """Atomically abandon an authenticated payer's unresolved purchase."""
    scopes = [
        _subscribe_scope(star),
        f"{LEGACY_SUBSCRIBE_SCOPE}:{star.pk}",
        CONFIRMED_SUBSCRIBE_SCOPE,
    ]
    with transaction.atomic():
        _lock_subscription_intent(star, key, reject_abandoned=False)
        rows = {}
        for scope in scopes:
            row = (
                idempotency.IdempotencyKey.objects.select_for_update()
                .filter(scope=scope, user=fan, key=key)
                .first()
            )
            if row is not None:
                rows[scope] = row

        matched = {
            scope: row for scope, row in rows.items()
            if _record_targets_creator(
                row,
                star.pk,
                username=username,
                expected_price=expected_price,
            )
        }
        evidence = (
            idempotency.SubscriptionIntentEvidence.objects
            .select_for_update()
            .filter(
                creator_id=star.pk,
                user=fan,
                key=key,
            )
            .first()
        )
        if evidence is not None and evidence.resolved_at is not None:
            return "resolved"
        if not matched and evidence is None:
            # A missing claim and missing release evidence is not silently
            # converted into abandonment from a browser-only observation.
            return "unchanged"
        if any(row.response_status == status.HTTP_200_OK for row in matched.values()):
            return "resolved"

        fence = (
            idempotency.SubscriptionIntentAbandonment.objects
            .select_for_update()
            .filter(creator_id=star.pk, key=key)
            .first()
        )
        if fence is not None:
            return "abandoned"

        for row in matched.values():
            if row.response_status is None:
                idempotency.mark_abandoned(row, star.pk)

        now = timezone.now()
        for scope in scopes:
            existing = matched.get(scope)
            if existing is not None:
                if existing.response_status == status.HTTP_200_OK:
                    raise _RecoveryResolved
                continue
            tombstone = _recovery_tombstone(star, fan, scope, key, now)
            try:
                # Keep a unique-race failure inside a savepoint.  Catching an
                # IntegrityError directly in this outer atomic block leaves
                # PostgreSQL's transaction aborted, so the verification query
                # below would itself fail and could not distinguish a raced
                # completed receipt from an unfinished claim.
                with transaction.atomic():
                    tombstone.save(force_insert=True)
            except IntegrityError:
                try:
                    current = (
                        idempotency.IdempotencyKey.objects.select_for_update()
                        .get(scope=scope, user=fan, key=key)
                    )
                except idempotency.IdempotencyKey.DoesNotExist as exc:
                    # A release can win this race between the tombstone
                    # INSERT and the verification query. The enclosing
                    # transaction is rolled back; make the browser retry the
                    # exact evidence instead of returning a 500 or rotating
                    # to a chargeable key.
                    raise _SubscriptionRecoveryRetryable from exc
                if (
                    current.response_status == status.HTTP_200_OK
                    and _record_targets_creator(
                        current,
                        star.pk,
                        username=username,
                        expected_price=expected_price,
                    )
                ):
                    raise _RecoveryResolved
                if (
                    current.response_status is None
                    and _record_targets_creator(
                        current,
                        star.pk,
                        username=username,
                        expected_price=expected_price,
                    )
                ):
                    idempotency.mark_abandoned(current, star.pk)

        try:
            with transaction.atomic():
                idempotency.SubscriptionIntentAbandonment.objects.get_or_create(
                    creator_id=star.pk,
                    key=key,
                    defaults={"user": fan},
                )
        except (IntegrityError, _SubscriptionRecoveryRetryable):
            # A concurrent recovery may have inserted the same immutable
            # fence. The outer transaction remains usable because this is a
            # nested savepoint; the durable fence is verified after it exits.
            if not idempotency.SubscriptionIntentAbandonment.objects.filter(
                creator_id=star.pk, key=key,
            ).exists():
                raise
        if evidence is not None:
            evidence.abandoned_at = now
            evidence.save(update_fields=["abandoned_at"])
        return "abandoned"


class SubscriptionIntentRecoveryView(APIView):
    """Let the authenticated original payer close an unresolved intent."""

    atomic_request = False
    permission_classes = [IsAuthenticated]

    @extend_schema(
        request=SubscriptionIntentRecoveryRequestSerializer,
        responses={
            200: SubscriptionIntentRecoveryResultSerializer,
            400: CreditErrorSerializer,
            404: CreditErrorSerializer,
            409: CreditErrorSerializer,
        },
        description=(
            "Reconcile one subscription retry handle for the authenticated "
            "payer and immutable creator. A committed purchase is reported "
            "as resolved. An unresolved recorded claim is retained as a "
            "terminal abandonment fence, including its legacy route aliases; "
            "the old key cannot charge again. A missing or unrelated handle "
            "is answered unchanged and reveals no other payer's receipt."
        ),
    )
    def post(self, request, *args, **kwargs):
        star = Creator.objects.filter(pk=kwargs.get("creator_id")).first()
        if star is None:
            return _credit_error(
                "creator_not_found", "Creator not found.",
                status.HTTP_404_NOT_FOUND,
            )
        serializer = SubscriptionIntentRecoveryRequestSerializer(data=request.data)
        if not serializer.is_valid():
            return _credit_error(
                "invalid_request", "A subscription retry key is required.",
                status.HTTP_400_BAD_REQUEST,
            )
        values = serializer.validated_data
        try:
            try:
                outcome = _abandon_subscription_intent(
                    request.user,
                    star,
                    values["key"],
                    username=values.get("username"),
                    expected_price=values.get("expected_price"),
                )
            except _RecoveryResolved:
                outcome = "resolved"
        except (IntegrityError, _SubscriptionRecoveryRetryable):
            # Do not convert a rolled-back recovery into a browser permission
            # to rotate keys. The caller must retain its exact evidence and
            # retry; only the committed helper result is authoritative.
            return _credit_error(
                "subscription_recovery_retryable",
                "The subscription attempt could not be reconciled. Please try again.",
                status.HTTP_409_CONFLICT,
            )
        except OperationalError as exc:
            if not _is_subscription_lock_timeout(exc):
                raise
            return _credit_error(
                "subscription_recovery_retryable",
                "The subscription attempt could not be reconciled. Please try again.",
                status.HTTP_409_CONFLICT,
            )
        return Response({"status": outcome})


# Deliberately a comment, not a docstring: drf-spectacular publishes a view's
# docstring as the endpoint description in f2z.yaml, and internal reasoning
# with issue numbers does not belong in the public contract.
#
# A deactivated counterparty is REDACTED by
# SubscriptionCounterpartySerializer, not filtered out here .
# Filtering was the obvious fix and it is wrong: this list carries the only
# ordinary unsubscribe control, so dropping the row tells a fan they have no
# subscription while a live recurring authorization sits behind it, and
# reactivating the creator before expiry then charges them --
# `test_deactivated_creator_subscription_remains_cancellable` pins exactly
# that. The Subscription row is untouched throughout: the fan keeps what they
# paid for and the renewal worker keeps its own `star__is_active` gate.
class MySubscribersListView(generics.ListAPIView):
    permission_classes = [IsAuthenticated]
    serializer_class = SubscriptionSerializer
    ordering_fields = ['expires', '-max_price']
    ordering = ['-max_price']

    def get_queryset(self):
        queryset = Subscription.objects.filter(
            star=self.request.user,
            expires__gt=timezone.now(),
        ).select_related('fan', 'star')

        ordering = self.request.query_params.get('ordering', '-max_price')

        if ordering == 'expires':
            queryset = queryset.order_by('expires')
        elif ordering == '-max_price':
            queryset = queryset.order_by('-max_price')

        return queryset


# See the comment on MySubscribersListView for why a deactivated counterparty
# is redacted rather than filtered out, and why this is a comment rather than
# a docstring.
class MySubscriptionsListView(generics.ListAPIView):
    permission_classes = [IsAuthenticated]
    serializer_class = SubscriptionSerializer
    ordering_fields = ['expires', '-max_price']
    ordering = ['expires']

    def get_queryset(self):
        queryset = Subscription.objects.filter(
            fan=self.request.user,
            expires__gt=timezone.now(),
        ).select_related('fan', 'star')

        ordering = self.request.query_params.get('ordering', 'expires')

        if ordering == 'expires':
            queryset = queryset.order_by('expires')
        elif ordering == '-max_price':
            queryset = queryset.order_by('-max_price')

        return queryset


class MySubscriptionRenewalSummaryView(APIView):
    """Show whether the current balance covers the next renewals."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses=SubscriptionRenewalSummarySerializer)
    def get(self, request, *args, **kwargs):
        serializer = SubscriptionRenewalSummarySerializer(
            _subscription_renewal_summary(request.user),
        )
        return Response(serializer.data)
