"""
Real "Login with Zcash" endpoints ("ZUULI Zcash Login v2").

Flow:
  1. POST /api/auth/zcash/challenge/  {address}          -> {challenge}
  2. wallet signs the exact challenge string with the Zcash Signed
     Message convention (same as zcashd ``signmessage``)
  3. POST /api/auth/zcash/login/
     {address, challenge, signature, pubkey?, otp_token?}
     -> verifies the message signature and issues a knox token.

Verification is done **in-process** (see ``verify.verify_message``) -- the
same cryptographic check ``zcashd verifymessage`` performed, but with no node
dependency. It previously called ``client.rpc.verifymessage`` on the zcashrpc
client; that attribute only exists on the retired **zcashd** proxy, so once
prod moved to the **Zallet** backend (which has no ``.rpc``/``verifymessage``)
every login failed with a 401 regardless of signature validity.
"""
import hashlib
import logging

from django.db import DatabaseError, IntegrityError, connection, transaction
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import AllowAny
from rest_framework import status
from drf_spectacular.utils import extend_schema


from dj.apps.g12f.models import Creator
from dj.apps.g12f.account_deletion import (
    DeletionPending,
    InactiveAccount,
    deletion_pending_response,
    ensure_account_can_sign_in,
)
from dj.apps.identity.auth_context import (
    require_recent_auth, RecentAuthenticationRequired, record_existing_session_reauth,
)
from dj.apps.identity.auth_context import AMR_ZCASH, INHERIT, record_login
from dj.apps.ktauth.credentials import (
    STALE_IDENTITY_DETAIL,
    identity_can_authenticate,
    issue_bearer_token,
)
from dj.apps.otp.utils import (
    INVALID_OTP_TOKEN_MESSAGE,
    TOTP_ATTEMPT_LIMIT,
    TOTP_ATTEMPT_TTL_SECONDS,
    claim_totp_attempt,
    check_user_totp,
    clear_totp_attempt,
    has_active_totp,
)
from dj.free2z.throttling import (
    ZCASH_CHALLENGE_THROTTLES,
    ZCASH_LOGIN_THROTTLES,
)

from .models import ZcashIdentity
from .challenges import (
    ChallengeClaimUnavailable,
    ChallengeCompatibilityUnavailable,
    claim_challenge,
    cleanup_expired_challenge_claims,
    consume_legacy_challenge,
    consume_v2_legacy_mirror,
    issue_challenge,
    is_legacy_challenge,
    legacy_mirror_policy,
    legacy_challenge_claim_identifier,
    store_legacy_compatible_challenge,
    validate_challenge,
)
from .parsers import ZcashAuthJSONParser
from .serializers import (
    ZcashAuthErrorSerializer,
    ZcashChallengeRequestSerializer,
    ZcashChallengeResponseSerializer,
    ZcashLoginRequestSerializer,
    ZcashLoginResponseSerializer,
)
from .verify import verify_message

logger = logging.getLogger(__name__)
INVALID_REQUEST_DETAIL = "Invalid request."


class ZcashIdentityConflict(RuntimeError):
    """A verified association conflicts with an existing identity."""


class ZcashIdentityRevoked(RuntimeError):
    """The linked identity was planted before an ownership event.

    Distinct from ``ZcashIdentityConflict`` because it is not a conflict with
    another account: this address IS this account's, and the account has evicted whoever was holding it. A 403 rather than the 409 a conflict gets,
    and a message that tells the owner how to get their login back rather than
    inviting a retry of the signature.
    """


class ZcashIdentityProvisioningUnavailable(RuntimeError):
    """Identity/token provisioning could not complete transactionally."""


class ZcashTotpRequired(RuntimeError):
    """The existing Creator's active TOTP factor was not satisfied."""


class ZcashTotpRateLimited(RuntimeError):
    """The existing Creator exhausted the bounded TOTP attempt window."""


class ZcashTotpUnavailable(RuntimeError):
    """The shared TOTP attempt counter could not be reached."""


class ZcashAdmissionBeforeAuthenticationAPIView(APIView):
    """Charge endpoint admission before inherited authentication work."""

    # AtomicMiddleware runs before DRF admission and would otherwise acquire a
    # database connection/transaction for every public request, including an
    # immediate Redis 429/503 or parser rejection. Both live routes stay
    # outside that blanket transaction. Login owns its explicit durable
    # claim/provision/token boundary below; challenge issuance does no DB work.
    atomic_request = False

    def perform_authentication(self, request):
        """Leave ``request.user`` lazy until the authenticated-user throttle."""

    def check_throttles(self, request):
        """Stop at client denial instead of evaluating later auth throttles.

        DRF normally evaluates every throttle after a denial to aggregate wait
        times.  Here that would invoke lazy authentication after the fixed-size
        client bucket was already exhausted, so the endpoint admission result
        must short-circuit the ordered chain.
        """
        for throttle in self.get_throttles():
            if not throttle.allow_request(request, self):
                self.throttled(request, throttle.wait())

    def get_authenticate_header(self, request):
        """Keep invalid inherited credentials as 401 responses.

        Session authentication is globally first but has no challenge header.
        DRF otherwise rewrites a later Knox AuthenticationFailed to 403. Use
        the first configured authenticator that can advertise a challenge
        without changing the authentication order itself. (Basic used to be the
        one supplying that header; it was removed from the global defaults in
         because it authenticated on a password alone, skipping TOTP.
        Knox still advertises ``Token``, so the 401 behaviour is unchanged.)
        """
        for authenticator in self.get_authenticators():
            header = authenticator.authenticate_header(request)
            if header:
                return header
        return None


def username_for_address(address: str) -> str:
    """
    Deterministic, unique, username-validator-safe handle for a brand
    new Zcash-only account: "z" + first 16 hex chars of sha256(address),
    with a numeric suffix on the (astronomically unlikely) collision.

    Deliberately outside 's refuse-not-link rule: this username
    derives from a signature-proven address, not from a user-chosen
    handle, so there is no human claim to collide with and nothing to
    hijack by registering a name somewhere else.
    """
    base = "z" + hashlib.sha256(address.encode()).hexdigest()[:16]
    username = base
    suffix = 0
    while Creator.objects.filter(username__iexact=username).exists():
        suffix += 1
        username = f"{base}{suffix}"
    return username


def _identity_lock_id(address: str) -> int:
    """Stable signed int64 used by PostgreSQL's transaction advisory lock."""
    digest = hashlib.sha256(address.encode("ascii")).digest()
    return int.from_bytes(digest[:8], byteorder="big", signed=True)


def _lock_identity_address(address: str) -> None:
    """Serialize provisioning for one address before testing row existence."""
    if connection.vendor == "postgresql":
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT pg_advisory_xact_lock(%s)", [_identity_lock_id(address)]
            )


def _provision_identity_and_token(acting_user, address: str, otp_token=None, *, request=None):
    """Create/reuse one identity and mint its token in one transaction.

    The address advisory lock closes the absent-row race: two distinct valid
    challenges for a brand-new address serialize before either creates its
    Creator.  A bounded uniqueness retry preserves the same no-orphan outcome
    on non-PostgreSQL development databases and covers the vanishingly rare
    deterministic-username collision with another address.  The login view
    wraps this savepoint-based retry in the same outer transaction as the
    durable challenge claim.
    """
    deferred_pending = None
    for retry_index in range(3):
        try:
            with transaction.atomic():
                _lock_identity_address(address)

                if acting_user is not None:
                    # Also serialize the one-identity-per-Creator invariant
                    # when two different address links arrive concurrently.
                    creator = Creator.objects.select_for_update().get(
                        pk=acting_user.pk
                    )
                else:
                    creator = None

                existing = (
                    ZcashIdentity.objects.select_related("creator")
                    .filter(zcash_address=address)
                    .first()
                )

                proved_existing_identity = (
                    creator is not None and existing is not None
                    and existing.creator_id == creator.pk
                    and identity_can_authenticate(existing, creator)
                )
                if creator is not None:
                    # The epoch to stamp anything this request issues with,
                    # from the snapshot that validated the caller's own
                    # credential.
                    issuing_epoch = acting_user.kt_account_epoch
                    if existing is not None and existing.creator_id != creator.id:
                        raise ZcashIdentityConflict(
                            "This Zcash address is linked to another account."
                        )
                    creator_identity = (
                        ZcashIdentity.objects.filter(creator=creator).first()
                    )
                    if (
                        creator_identity is not None
                        and creator_identity.zcash_address != address
                    ):
                        raise ZcashIdentityConflict(
                            "This account already has a Zcash identity."
                        )
                    if existing is None or not identity_can_authenticate(existing, creator):
                        require_recent_auth(request)
                    if existing is None:
                        # Deliberately NOT a `kt_account_epoch` event:
                        # linking ADDS a principal and invalidates nothing.
                        # There is no self-service unlink route for a Zcash
                        # identity; removing one goes through `ZcashIdentityAdmin`,
                        # which does count. See `dj.apps.ktauth.epoch`.
                        ZcashIdentity.objects.create(
                            creator=creator,
                            zcash_address=address,
                            linked_at_epoch=issuing_epoch,
                        )
                    else:
                        # RE-LINKING refreshes the stamp: it is how an owner
                        # recovers an identity their own ownership event made
                        # stale, and it needs an authenticated session,
                        # which after a password change means the new password.
                        ZcashIdentity.objects.filter(pk=existing.pk).update(
                            linked_at_epoch=issuing_epoch,
                            fallback_rejected_at_epoch=None,
                        )
                    created = False
                elif existing is not None:
                    creator = existing.creator
                    if not identity_can_authenticate(existing, creator):
                        raise ZcashIdentityRevoked(STALE_IDENTITY_DETAIL)
                    else:
                        issuing_epoch = creator.kt_account_epoch
                        created = False
                else:
                    creator = Creator(
                        username=username_for_address(address),
                        p2paddr=address,
                    )
                    creator.set_unusable_password()
                    creator.save()
                    issuing_epoch = creator.kt_account_epoch
                    ZcashIdentity.objects.create(
                        creator=creator,
                        zcash_address=address,
                        linked_at_epoch=issuing_epoch,
                    )
                    #NO welcome 2Z here, deliberately. This path has
                    # no CAPTCHA and a fresh keypair costs nothing, so a grant
                    # would be a faucet: see
                    # EXEMPT_SITES in dj/apps/tuzis/test_welcome_grant.py.
                    created = True

                # This endpoint always mints a fresh Knox credential, even
                # after an authenticated association. Require the active
                # Creator TOTP factor in both modes before issuing it, and
                # bind a shared bounded counter to that Creator so a caller
                # cannot bypass the limit by requesting fresh challenges.
                second_factor = None
                if acting_user is None:
                    # Reject banned/deactivated accounts before session,
                    # token or AuthContext creation. Deletion grace remains
                    # eligible here so its keep token can follow TOTP.
                    ensure_account_can_sign_in(creator)
                if has_active_totp(creator):
                    totp_attempt = claim_totp_attempt(
                        "zcash",
                        creator.pk,
                        TOTP_ATTEMPT_TTL_SECONDS,
                    )
                    if totp_attempt is None:
                        raise ZcashTotpUnavailable
                    if totp_attempt > TOTP_ATTEMPT_LIMIT:
                        raise ZcashTotpRateLimited
                    gate = check_user_totp(creator, otp_token)
                    if not gate.passed:
                        if totp_attempt == TOTP_ATTEMPT_LIMIT:
                            raise ZcashTotpRateLimited
                        raise ZcashTotpRequired
                    second_factor = gate.second_factor

                if acting_user is None:
                    # A sign-in to an account in its deletion grace period gets
                    # a keep token, never a credential. The refusal is NOT
                    # raised in here: this savepoint must commit so the TOTP
                    # code verified above stays burned (a keep token records
                    # "otp" as its second factor; a rolled-back burn would
                    # leave that code replayable elsewhere). It is raised
                    # just after, and caught inside the outer block like a
                    # TOTP refusal, so the challenge claim commits too.
                    from dj.apps.g12f.account_deletion import login_gate

                    try:
                        login_gate(
                            creator, methods=[AMR_ZCASH],
                            second_factor=second_factor, credential="knox",
                        )
                    except DeletionPending as exc:
                        deferred_pending = exc
                if deferred_pending is not None:
                    clear_totp_attempt("zcash", creator.pk)
                    break
                instance, token = issue_bearer_token(creator, issuing_epoch)
                # The token's AuthContext, in the same transaction as
                # the token: the wallet signature, plus the TOTP when one was
                # verified above. A sign-in only: an ASSOCIATION proves an
                # address the caller may have just linked themselves, not the
                # account, so ZcashLoginView gives that token the caller's
                # own context instead.
                if acting_user is None or proved_existing_identity:
                    record_login(
                        None, creator,
                        methods=[AMR_ZCASH],
                        second_factor=second_factor,
                        token=instance,
                        account_epoch=issuing_epoch,
                    )
                if proved_existing_identity:
                    record_existing_session_reauth(
                        request, creator, methods=[AMR_ZCASH],
                        second_factor=second_factor, account_epoch=issuing_epoch,
                    )
                clear_totp_attempt("zcash", creator.pk)
                return creator, created, instance, token, proved_existing_identity
        except (ZcashIdentityConflict, ZcashIdentityRevoked):
            raise
        except IntegrityError as exc:
            if retry_index == 2:
                logger.exception(
                    "zauth: identity provisioning exhausted conflict retries"
                )
                raise ZcashIdentityProvisioningUnavailable from exc

    if deferred_pending is not None:
        raise deferred_pending
    raise AssertionError("unreachable identity provisioning retry state")


def verify_zcash_signature(address: str, signature: str, challenge: str) -> bool:
    """
    Verify a Zcash Signed Message against a transparent (P2PKH) address.

    This is the exact check ``zcashd verifymessage`` performed -- recover the
    signing pubkey from the recoverable signature over the challenge and
    confirm it hashes to ``address`` -- but done in-process with no node (see
    ``verify.verify_message``). Message signing is stateless cryptography, so
    it needs neither wallet nor chain state and behaves identically in local
    dev and in prod. Any malformed input returns False rather than raising.
    """
    try:
        return verify_message(address, signature, challenge)
    except Exception:  # noqa: BLE001 - defensive: never 500 on bad input
        logger.exception("zauth: signature verification errored for %s", address)
        return False


class ZcashChallengeView(ZcashAdmissionBeforeAuthenticationAPIView):
    """POST {address} -> {challenge}. Public.

    During rollout phase A, the v1 Redis mirror is authoritative and a newer
    issuance invalidates an older proof. Phase B keeps writing mirrors while
    consumers transition to PostgreSQL-only claims. Phase C stops mirror
    writes after every consumer has transitioned.
    """
    permission_classes = [AllowAny]
    parser_classes = [ZcashAuthJSONParser]
    throttle_classes = ZCASH_CHALLENGE_THROTTLES

    @extend_schema(
        request=ZcashChallengeRequestSerializer,
        responses={
            200: ZcashChallengeResponseSerializer,
            400: ZcashAuthErrorSerializer,
            413: ZcashAuthErrorSerializer,
            415: ZcashAuthErrorSerializer,
            429: ZcashAuthErrorSerializer,
            503: ZcashAuthErrorSerializer,
        },
    )
    def post(self, request):
        serializer = ZcashChallengeRequestSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(
                {"detail": INVALID_REQUEST_DETAIL},
                status=status.HTTP_400_BAD_REQUEST,
            )
        address = serializer.validated_data["address"]
        challenge = issue_challenge(address)
        try:
            # The helper owns the centrally validated write half of the staged
            # rollout policy. Phase A/B mirror into the exact v1 address slot;
            # Phase C is a deliberate no-op.
            store_legacy_compatible_challenge(address, challenge)
        except ChallengeCompatibilityUnavailable:
            return Response(
                {"detail": "Challenge service is temporarily unavailable."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return Response({"challenge": challenge})


class ZcashLoginView(ZcashAdmissionBeforeAuthenticationAPIView):
    """
    POST {address, challenge, signature, pubkey?, otp_token?} -> knox token.

    If the request carries a valid knox token (authenticated Creator),
    the verified address is linked to THAT account (associate flow)
    instead of creating a new one. An existing Creator's active TOTP is
    required for both login and association before a token is minted.
    """
    permission_classes = [AllowAny]
    parser_classes = [ZcashAuthJSONParser]
    throttle_classes = ZCASH_LOGIN_THROTTLES

    @extend_schema(
        request=ZcashLoginRequestSerializer,
        responses={
            200: ZcashLoginResponseSerializer,
            400: ZcashAuthErrorSerializer,
            401: ZcashAuthErrorSerializer,
            #the signature verified but the linked identity is stale.
            403: ZcashAuthErrorSerializer,
            409: ZcashAuthErrorSerializer,
            413: ZcashAuthErrorSerializer,
            415: ZcashAuthErrorSerializer,
            429: ZcashAuthErrorSerializer,
            503: ZcashAuthErrorSerializer,
        },
    )
    def post(self, request):
        serializer = ZcashLoginRequestSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(
                {"detail": INVALID_REQUEST_DETAIL},
                status=status.HTTP_400_BAD_REQUEST,
            )
        address = serializer.validated_data["address"]
        challenge = serializer.validated_data["challenge"]
        signature = serializer.validated_data["signature"]
        otp_token = serializer.validated_data.get("otp_token")

        # (a) Authenticate canonical v2 without cache state. Only strict v1
        # syntax can enter the transitional compare/delete fallback; a malformed,
        # expired, or bad-HMAC v2 token can never be reinterpreted as legacy.
        is_v2 = validate_challenge(address, challenge)
        legacy_challenge = False
        if is_v2:
            claim_identifier = challenge
        elif is_legacy_challenge(challenge):
            claim_identifier = legacy_challenge_claim_identifier(address, challenge)
            legacy_challenge = True
        else:
            return Response(
                {"detail": "Challenge is missing, expired or does not match."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            v2_legacy_mirror_required = (
                is_v2 and legacy_mirror_policy().required
            )
        except ChallengeCompatibilityUnavailable:
            return Response(
                {"detail": "Challenge service is temporarily unavailable."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        # Opportunistically remove one bounded expired batch before opening
        # the claim/provision transaction. PostgreSQL's try-lock makes
        # concurrent cleaners skip rather than serialize; cleanup failures are
        # non-fatal and never hold the provisioning transaction.
        cleanup_expired_challenge_claims()

        # (b) Claim the server-valid token before expensive secp256k1 recovery.
        # Independent client login admission bounds proof bursts, while the
        # uniqueness claim ensures one issued challenge buys at most one
        # signature-verification attempt. A bad signature deliberately burns
        # the challenge. Valid provisioning joins this same transaction so a
        # retryable 503 rolls the claim back with any identity/token writes.
        # Mirror-not-required canonical v2 can then retry. Any compatibility
        # proof already deleted from Redis stays burned because restoring it
        # after an ambiguous commit is replay-unsafe.
        acting_user = request.user if request.user.is_authenticated else None
        try:
            with transaction.atomic():
                if not claim_challenge(claim_identifier):
                    return Response(
                        {
                            "detail": (
                                "Challenge is missing, expired or does not match."
                            )
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                if legacy_challenge or v2_legacy_mirror_required:
                    # The durable claim comes first so an ordinary PostgreSQL
                    # failure cannot delete an otherwise-unused rollout proof.
                    # A Redis miss rolls this uncommitted claim back. Once the
                    # atomic compare/delete wins, however, no failure path ever
                    # restores Redis: a process crash or ambiguous database
                    # commit may sacrifice availability, but can never reopen
                    # an assertion after a token might have committed.
                    if legacy_challenge:
                        consumed = consume_legacy_challenge(address, challenge)
                    else:
                        consumed = consume_v2_legacy_mirror(address, challenge)
                    if not consumed:
                        transaction.set_rollback(True)
                        return Response(
                            {
                                "detail": (
                                    "Challenge is missing, expired or does not "
                                    "match."
                                )
                            },
                            status=status.HTTP_400_BAD_REQUEST,
                        )

                if not verify_zcash_signature(address, signature, challenge):
                    # Returning normally commits the claim: an invalid wallet
                    # signature consumes this server-issued proof.
                    return Response(
                        {"detail": "Signature verification failed."},
                        status=status.HTTP_401_UNAUTHORIZED,
                    )

                try:
                    creator, created, instance, token, proved_existing_identity = (
                        _provision_identity_and_token(
                            acting_user, address, otp_token, request=request
                        )
                    )
                except RecentAuthenticationRequired as exc:
                    return exc.response()
                except DeletionPending as exc:
                    return deletion_pending_response(exc)
                except InactiveAccount as exc:
                    return Response(
                        {"detail": exc.detail},
                        status=status.HTTP_403_FORBIDDEN,
                    )
                except ZcashTotpRequired:
                    # Catch inside the outer atomic block so the durable
                    # challenge claim commits and cannot be replayed while
                    # guessing TOTP values. The identity/token savepoint has
                    # already rolled back, so no credential was issued.
                    return Response(
                        {"detail": INVALID_OTP_TOKEN_MESSAGE},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                except ZcashTotpRateLimited:
                    return Response(
                        {"detail": "Too many Zcash login attempts. Start again."},
                        status=status.HTTP_429_TOO_MANY_REQUESTS,
                    )
                except ZcashTotpUnavailable:
                    return Response(
                        {"detail": "Zcash login is temporarily unavailable."},
                        status=status.HTTP_503_SERVICE_UNAVAILABLE,
                    )
                except ZcashIdentityConflict as exc:
                    # A logical 409 is not retryable with the same association.
                    # Commit the claim so replay cannot buy another recovery.
                    return Response(
                        {"detail": str(exc)}, status=status.HTTP_409_CONFLICT
                    )
                except ZcashIdentityRevoked as exc:
                    #. Same reasoning as the 409 above -- commit the
                    # challenge claim rather than handing the proof back for a
                    # retry that must fail the same way. 403, not 401: the
                    # signature WAS valid, the identity is what is refused, and
                    # a 401 would send a wallet round the challenge loop again.
                    return Response(
                        {"detail": str(exc)}, status=status.HTTP_403_FORBIDDEN
                    )
                else:
                    if acting_user is not None and not proved_existing_identity:
                        # An association's token inherits the context of the
                        # credential that asked for it: linking a
                        # wallet is not a fresh authentication of the account.
                        record_login(
                            request, creator,
                            methods=INHERIT,
                            token=instance,
                            account_epoch=acting_user.kt_account_epoch,
                        )
        except ChallengeClaimUnavailable:
            return Response(
                {"detail": "Challenge service is temporarily unavailable."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        except ChallengeCompatibilityUnavailable:
            # The transaction rolls its pending claim back. The Redis script
            # may have completed before a connection error became observable,
            # so restoring the proof here would be replay-unsafe.
            return Response(
                {"detail": "Challenge service is temporarily unavailable."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        except ZcashIdentityProvisioningUnavailable:
            return Response(
                {"detail": "Zcash identity service is temporarily unavailable."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        except DatabaseError:
            # Includes failures while creating a token or committing the outer
            # transaction. A failed transaction rolls back as a unit; if the
            # commit outcome is ambiguous, PostgreSQL uniqueness remains the
            # authority and no external legacy proof is ever restored.
            logger.exception("zauth: transactional login provisioning failed")
            return Response(
                {"detail": "Zcash identity service is temporarily unavailable."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        # (c) The response is constructed only after claim, identity, and token
        # have committed as one database outcome.
        return Response({
            "token": token,
            "expiry": instance.expiry.isoformat() if instance.expiry else None,
            "username": creator.username,
            "did": f"did:zcash:{address}",
            "created": created,
        })
