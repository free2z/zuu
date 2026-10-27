import requests
import base64
import binascii
import hashlib
import json
import math
import time
import uuid
from decimal import Decimal, InvalidOperation
from urllib.parse import urlsplit, urlunsplit

from django.conf import settings
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.http import HttpResponse, HttpRequest
from django.db import IntegrityError, connection, transaction
from django.db.models import Exists, F, Max, Prefetch, Subquery

from rest_framework.decorators import (
    action, api_view, permission_classes, throttle_classes
)
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from rest_framework import viewsets
from rest_framework.permissions import (
    AllowAny, IsAuthenticated, IsAuthenticatedOrReadOnly
)
from drf_spectacular.openapi import AutoSchema
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    PolymorphicProxySerializer,
    extend_schema,
    extend_schema_view,
)

from dj.free2z.throttling import DYTE_MEETING_THROTTLES, POLLING_THROTTLES

from dj.apps.jobs import outbox
from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.backends import default_backend

from dj.apps.g12f.models.creator import Creator, Subscription
from dj.apps.events.models import Event
from dj.apps.tuzis import ledger
from dj.apps.economy.epoch import pin_supported_policy
from dj.apps.economy.services import EconomicRefusal
from dj.apps.uploads.models import ImageVariant

from .models import (
    BROADCAST,
    PAY_PER_VIEW,
    PRIVATE,
    PUBLIC_MEETING_TYPES,
    SUBSCRIBERS_ONLY,
    CreatorMeeting,
    RecordingDeliveryTarget,
    WebhookDelivery,
)
from .recording import redact_recording_url
from .serializers import (
    HOST_ROLE,
    VIEWER_ROLE,
    CreatorMeetingSerializer,
    HostSeatConflictSerializer,
    HostSessionActionSerializer,
    HostSessionStatusSerializer,
    MeetingJoinRequestSchemaSerializer,
    MeetingJoinRequestSerializer,
    MeetingJoinResponseSerializer,
    PublicMeetingDiscoverySerializer,
    PublicMeetingListSerializer,
)
from dj.apps.tuzis.serializers import (
    InsufficientFundsErrorSerializer,
    StreamEntitlementErrorSerializer,
)
from .client import DyteClient

import logging

logger = logging.getLogger(__name__)

PUBLIC_DISCOVERY_LIMIT = 12

STREAM_PAYMENT_REQUIRED_RESPONSE = OpenApiResponse(
    response=PolymorphicProxySerializer(
        component_name="StreamPaymentRequiredError",
        serializers={
            "insufficient_funds": InsufficientFundsErrorSerializer,
            "subscription_required": StreamEntitlementErrorSerializer,
        },
        resource_type_field_name="code",
    ),
    description=(
        "The viewer lacks either the 2Z reserve or the subscription "
        "entitlement. Inspect `code` to choose the recovery action."
    ),
)

# Cached provider signing key + the monotonic timestamps that bound it. See
# the caching notes in get_or_load_dyte_public_key.
DYTE_PUBLIC_KEY = None
# Last SUCCESSFUL load (the TTL is measured from this).
_DYTE_PUBLIC_KEY_LOADED_AT = None
# Last fetch ATTEMPT, successful or not. Every outbound fetch is rate-limited
# on this one timestamp, which is what caps the amplification lever.
_DYTE_PUBLIC_KEY_ATTEMPTED_AT = None


def reset_dyte_public_key_cache():
    """Clear the key cache and its rate-limit state (used by tests)."""
    global DYTE_PUBLIC_KEY
    global _DYTE_PUBLIC_KEY_LOADED_AT, _DYTE_PUBLIC_KEY_ATTEMPTED_AT
    DYTE_PUBLIC_KEY = None
    _DYTE_PUBLIC_KEY_LOADED_AT = None
    _DYTE_PUBLIC_KEY_ATTEMPTED_AT = None


def get_or_load_dyte_public_key(force_refresh: bool = False):
    """Return the provider's webhook-signing public key, or None.

    NEVER RAISES. The only caller is the unauthenticated `webhook` view, and
    this runs *before* the signature check (it is what makes the signature
    check possible), so every failure mode here is reachable by an anonymous
    caller. Hence:

    * an explicit timeout -- `requests` has none by default, so a hung
      provider would pin a sync gunicorn worker indefinitely;
    * ONE rate limit covering every outbound fetch, successful or not
      (`_DYTE_PUBLIC_KEY_ATTEMPTED_AT`), so no request pattern -- unsigned,
      badly signed, or `force_refresh` -- can drive more than one outbound
      request per DYTE_KEY_FETCH_RETRY_SECONDS from inside the cluster;
    * returning None instead of raising, so the caller can FAIL CLOSED with a
      "retry later" response rather than a 500.

    The positive cache has a TTL. It used to be unbounded, so a worker that
    loaded the key once held it for its entire lifetime: if the provider
    rotated its signing key, that worker would reject every genuine delivery
    -- stalling live status, billing and recordings -- until it happened to
    restart.

    `force_refresh=True` additionally lets the caller re-check the key the
    moment a signature fails to verify, instead of waiting out the TTL. That
    matters because the provider does NOT retry 4xx: without it, a rotation
    would permanently drop up to a full TTL of real events. The shared rate
    limit is what makes exposing this to unauthenticated callers safe -- and it
    also bounds the damage, to one DYTE_KEY_FETCH_RETRY_SECONDS window (30s by
    default) rather than one DYTE_KEY_CACHE_SECONDS window (an hour).

    A refresh that FAILS keeps serving the stale key rather than failing
    closed: an old key is far more likely to still be valid than not, and a
    provider outage must not take the webhook down with it.
    """
    global DYTE_PUBLIC_KEY
    global _DYTE_PUBLIC_KEY_LOADED_AT, _DYTE_PUBLIC_KEY_ATTEMPTED_AT

    now = time.monotonic()

    if (
        not force_refresh
        and DYTE_PUBLIC_KEY is not None
        and _DYTE_PUBLIC_KEY_LOADED_AT is not None
        and now - _DYTE_PUBLIC_KEY_LOADED_AT < settings.DYTE_KEY_CACHE_SECONDS
    ):
        return DYTE_PUBLIC_KEY

    if (
        _DYTE_PUBLIC_KEY_ATTEMPTED_AT is not None
        and now - _DYTE_PUBLIC_KEY_ATTEMPTED_AT
        < settings.DYTE_KEY_FETCH_RETRY_SECONDS
    ):
        # Inside the back-off window. Serve the cached key if we have one
        # (possibly stale); otherwise None and the caller fails closed.
        return DYTE_PUBLIC_KEY

    _DYTE_PUBLIC_KEY_ATTEMPTED_AT = now

    try:
        response = requests.get(
            f"{settings.RTK_API_BASE_URL}/.well-known/webhooks.json",
            timeout=settings.DYTE_KEY_FETCH_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        public_key_pem = response.json().get("data", {}).get("publicKey")
        if not public_key_pem:
            raise ValueError("Public key not found in the provider's response")
        key = serialization.load_pem_public_key(
            public_key_pem.encode('utf-8')
        )
    except Exception:
        # Deliberately broad: requests raises a wide family (Timeout,
        # ConnectionError, HTTPError, JSONDecodeError) and PEM parsing raises
        # ValueError/UnsupportedAlgorithm. None of them may escape.
        logger.exception(
            "Could not load the webhook signing key from %s; %s for the next "
            "%ss",
            settings.RTK_API_BASE_URL,
            "continuing with the cached key" if DYTE_PUBLIC_KEY is not None
            else "rejecting webhook deliveries",
            settings.DYTE_KEY_FETCH_RETRY_SECONDS,
        )
        return DYTE_PUBLIC_KEY

    DYTE_PUBLIC_KEY = key
    _DYTE_PUBLIC_KEY_LOADED_AT = now
    return DYTE_PUBLIC_KEY


def verify_dyte_signature(public_key: rsa.RSAPublicKey, signature: str, payload: bytes) -> bool:
    """
    Verifies the signature for a given Dyte webhook event using the provided public key.

    :param public_key: RSAPublicKey used for verification.
    :param signature: Base64 encoded signature from Dyte.
    :param payload: Original payload as received from Dyte in bytes.
    :return: True if signature is valid, False otherwise.
    """
    try:
        decoded = base64.b64decode(signature, validate=True)
    except (binascii.Error, ValueError, TypeError) as e:
        # A hostile caller controls this header; malformed base64 must be a
        # clean rejection, not an uncaught exception → 500.
        logger.error("Malformed signature header for webhook event: %s", e)
        return False

    try:
        public_key.verify(
            decoded,
            payload,  # Ensure payload is in bytes
            padding.PKCS1v15(),
            hashes.SHA256()
        )
        return True
    except InvalidSignature as e:
        logger.error("Invalid signature for webhook event: %s", e)
        return False
    except (TypeError, UnsupportedAlgorithm) as e:
        # The key comes from the provider, not from us: if they ever publish a
        # non-RSA key, `verify` raises TypeError (wrong padding/algorithm for
        # the key type) rather than InvalidSignature. Fail closed, not 500.
        logger.error("Unusable webhook signing key: %s", e)
        return False


def calculate_platform_fee(duration_minutes: int) -> int:
    """Platform fee in 2Z for one participant session of ``duration_minutes``.

    1 2Z per whole two minutes of participation, and **nothing below that**.

    Mind the boundary, in both directions. ``duration_minutes`` is already
    rounded UP from seconds by the caller, so the free window in wall-clock
    terms is a session of **a minute or less**, not "under two minutes": a
    0:60 session rounds to 1 minute and is free, while a 1:01 session rounds
    to 2 and costs 1 2Z. The creator-facing cost copy in
    ``dashboard.stream.types.*.cost`` states it that way for the same reason.

    Issue  — why the ``max(..., 1)`` floor was removed. The floor made a
    one-second session cost the same 1 2Z as a two-minute one, while the
    provider bills us per participant-minute of an active session, so a
    drive-by connect recovered a multiple of ~300x its own provider cost.
    On a broadcast that fee is paid by the *creator*, not the joiner, and a
    single participant token can be reused to join the same meeting over and
    over — so one API call plus a connect/disconnect loop drained a creator's
    balance below the go-live threshold at 1 2Z per cycle, with the creator's
    2Z funding an attack on the creator. Without the floor a joiner has to hold
    a real session for over a minute before the creator is charged anything,
    which costs the attacker sustained concurrency (visible in
    ``live_participants``) and is indistinguishable from simply watching.

    The change can only ever lower a session's fee, never raise it:
    ``d // 2 <= max(d // 2, 1)`` for every ``d``, and the two differ only at
    ``d < 2``. Above 2 minutes billing is byte-for-byte what it was.

    :param duration_minutes: Duration of the participant's session in minutes.
    :return: Platform fee for the session, in whole 2Z. May be 0.
    """
    return duration_minutes // 2


PPV_JOIN_RESERVE_MINUTES = 30
PPV_JOIN_PLATFORM_RESERVE = 15
PPV_PRICE_MAX = Decimal("9999.99")


def ppv_join_threshold(price_per_minute):
    """Return the PPV admission reserve, or ``None`` for an invalid rate.

    CreatorMeeting.price_per_minute is a two-decimal DecimalField. Normalize
    through ``str`` so a float supplied by a request cannot introduce binary
    rounding before the exact ``ceil(price_per_minute * 30) + 15`` formula is
    applied. The ``None`` result lets callers return a clean validation error
    instead of a 500 for empty, zero, non-finite, over-precise, or
    out-of-range input.
    """
    try:
        price = Decimal(str(price_per_minute))
        if not price.is_finite() or price <= 0:
            return None
        normalized = price.quantize(Decimal("0.01"))
    except (InvalidOperation, TypeError, ValueError):
        return None

    if normalized != price or normalized > PPV_PRICE_MAX:
        return None

    return math.ceil(
        price * PPV_JOIN_RESERVE_MINUTES
    ) + PPV_JOIN_PLATFORM_RESERVE


def authenticate_dyte_webhook(request: HttpRequest):
    """Verify the RSA signature on an inbound provider webhook.

    Returns ``None`` when the request is authentic (the caller proceeds), or a
    ``Response`` to short-circuit with when it is not. This is the SINGLE
    authentication path shared by every provider-facing endpoint (`webhook`
    and `webhook_recording_status_update`); neither is behind the DRF
    permission layer, so the signature IS the authentication.

    Status codes are chosen around the provider's retry policy: it retries on
    5xx and does NOT retry 4xx. So a forgery is 400 (never retried), while a
    fault on OUR side — key unavailable, or a possible key rotation we could
    not confirm — is 503, so a genuine delivery is redelivered rather than
    lost forever.
    """
    # Cloudflare RealtimeKit still signs with the legacy dyte-signature header
    # (and the same key pair) as of the 2026 migration, but accept the
    # rtk-signature name too in case they rename it after the cutover.
    #
    # Try EVERY candidate header rather than picking the first present one:
    # mid-migration a proxy may attach both names, and if the legacy one is
    # stale, `first-present-wins` would 400 a delivery whose other header is
    # perfectly valid — silently stalling live_now, billing and recordings.
    # Accepting "any header verifies" is no weaker: each candidate must still
    # be a valid RSA signature by Dyte's key over this exact request body.
    signatures = [
        s for s in (
            request.headers.get('dyte-signature'),
            request.headers.get('rtk-signature'),
        ) if s
    ]
    # Checked BEFORE the key fetch on purpose: this path is unauthenticated, so
    # an unsigned flood must cost us no outbound request to the provider.
    if not signatures:
        return _auth_refusal(status.HTTP_400_BAD_REQUEST, 'missing_signature')

    dyte_pk = get_or_load_dyte_public_key()
    if dyte_pk is None:
        # FAIL CLOSED. We cannot authenticate this delivery, so we must not act
        # on it — but this is our fault, not the caller's, so answer 503 rather
        # than 400: the provider retries on 5xx, and a transient key-fetch
        # outage should not silently drop real events.
        return _auth_refusal(
            status.HTTP_503_SERVICE_UNAVAILABLE, 'public_key_unavailable')

    if any(
        verify_dyte_signature(dyte_pk, s, request.body) for s in signatures
    ):
        return None

    # Could be a key rotation rather than a forgery. The provider does not
    # retry 4xx, so waiting out the cache TTL would permanently drop every
    # real event in the meantime. Re-check the key and try once more; the
    # shared fetch rate limit means a flood of bad signatures still costs
    # at most one outbound request per DYTE_KEY_FETCH_RETRY_SECONDS.
    refreshed = get_or_load_dyte_public_key(force_refresh=True)

    # Note the short-circuit: when the back-off suppressed the refetch,
    # `refreshed is dyte_pk` and we do NOT run a second verification. A
    # flood of bad signatures therefore costs one RSA verify each, not two.
    verified = (
        refreshed is not None
        and refreshed is not dyte_pk
        and any(
            verify_dyte_signature(refreshed, s, request.body)
            for s in signatures
        )
    )
    if verified:
        logger.info("Webhook signature verified after a key refresh")
        return None

    # Is the key we judged against recent enough that we can call this a
    # forgery? If it was loaded within the last back-off window we effectively
    # just asked the provider, so yes -> 400.
    key_is_fresh = (
        _DYTE_PUBLIC_KEY_LOADED_AT is not None
        and time.monotonic() - _DYTE_PUBLIC_KEY_LOADED_AT
        < settings.DYTE_KEY_FETCH_RETRY_SECONDS
    )
    if not key_is_fresh:
        # We could not re-check the key (rate-limited, or the provider is
        # down), so we cannot tell a forgery from a rotation. Answer 503,
        # which the provider RETRIES, rather than 400, which it does not: a
        # genuine post-rotation delivery is then redelivered once the back-off
        # expires instead of being lost forever.
        return _auth_refusal(
            status.HTTP_503_SERVICE_UNAVAILABLE, 'signature_unverifiable')
    return _auth_refusal(status.HTTP_400_BAD_REQUEST, 'bad_signature')


def _auth_refusal(status_code: int, reason: str) -> Response:
    """A bodiless refusal that carries its reason for the caller's log line."""
    response = Response(status=status_code)
    response.dyte_refusal_reason = reason
    return response


# Structured outcomes of a provider delivery we did NOT apply.
#
# Before this, a correctly signed delivery for a meeting we could not resolve
# was a bare `get_object_or_404`, and the only trace was Django's
# `Not Found: /api/dyte/webhook` -- no event type, no meeting id, no delivery
# id. 7 of 54 prod deliveries in 30 days went that way and nobody could say
# what they were. Each line below is one JSON object, so Cloud Logging turns
# it into `jsonPayload` and a log-based metric can count it by `event`.
#
# * DROPPED -- signed, and an effect was lost: a non-2xx after the signature
#   verified, or a billing/recording event for a room we cannot resolve. This
#   is what `monitoring/alert-policies/dyte-webhook-signed-delivery-dropped`
#   counts. Zero is the healthy floor.
# * IGNORED -- signed, 2xx, and nothing was lost: a lifecycle event
#   (started/ended/joined, the host's own leave, a non-UPLOADED recording
#   status) for a room that is no longer any CreatorMeeting's current room.
# * REJECTED -- not authenticated. The fields come from an UNSIGNED body, so
#   they are bounded and marked `signed: false`; nobody should act on them.
DYTE_WEBHOOK_DROPPED_EVENT = 'dyte_webhook_signed_delivery_dropped'
DYTE_WEBHOOK_IGNORED_EVENT = 'dyte_webhook_ignored'
DYTE_WEBHOOK_REJECTED_EVENT = 'dyte_webhook_rejected'

_WEBHOOK_LOG_FIELD_MAX = 80


def _bounded_field(value):
    """A short, single-line string (or None) that is safe to put in a log."""
    if value is None:
        return None
    text = str(value)
    if len(text) > _WEBHOOK_LOG_FIELD_MAX:
        text = text[:_WEBHOOK_LOG_FIELD_MAX] + '...'
    return text


def _webhook_identity(request: HttpRequest) -> dict:
    """The identifying fields of a delivery, read without trusting the body.

    Deliberately NOT ``request.data``: this also runs for bodies that failed
    authentication or schema validation. Only identifiers are copied -- never
    ``recording.downloadUrl``/``audioDownloadUrl``, whose query string is a
    live presigned credential. The recording's own UUID is kept: it is what
    an operator needs to ask the provider for a fresh download URL when a
    recording event could not be applied.
    """
    try:
        body = json.loads(request.body)
    except Exception:  # noqa: BLE001 - any unreadable body is just "unknown"
        body = None
    if not isinstance(body, dict):
        body = {}
    meeting = body.get('meeting')
    meeting = meeting if isinstance(meeting, dict) else {}
    participant = body.get('participant')
    participant = participant if isinstance(participant, dict) else {}
    recording = body.get('recording')
    recording = recording if isinstance(recording, dict) else {}
    return {
        'event_type': _bounded_field(body.get('event')),
        'meeting_id': _bounded_field(meeting.get('id')),
        'session_id': _bounded_field(meeting.get('sessionId')),
        'delivery_id': _bounded_field(
            request.headers.get('rtk-uuid') or request.headers.get('dyte-uuid')),
        'participant_id': _bounded_field(
            participant.get('customParticipantId')
            or participant.get('clientSpecificId')),
        'recording_id': _bounded_field(recording.get('id')),
        'recording_status': _bounded_field(recording.get('status')),
    }


_WEBHOOK_OUTCOME_LEVELS = {
    DYTE_WEBHOOK_DROPPED_EVENT: logging.ERROR,
    DYTE_WEBHOOK_IGNORED_EVENT: logging.INFO,
    DYTE_WEBHOOK_REJECTED_EVENT: logging.WARNING,
}


def _webhook_outcome_payload(
    event: str, *, request: HttpRequest, endpoint: str, status_code: int,
    reason: str, signed: bool,
) -> dict:
    """The outcome line's fields. Separate so the monitoring contract test
    (``gcp/tests/test_alert_policy_contract.py``) can call the real builder
    and check a metric only extracts keys this line actually carries."""
    identity = _webhook_identity(request)
    return {
        'severity': logging.getLevelName(_WEBHOOK_OUTCOME_LEVELS[event]),
        'message': (
            f"Dyte webhook {event}: status={status_code} reason={reason} "
            f"event_type={identity['event_type']} "
            f"meeting_id={identity['meeting_id']}"
        ),
        'event': event,
        'endpoint': endpoint,
        'status': status_code,
        'reason': reason,
        'signed': signed,
        **identity,
    }


def _log_webhook_outcome(
    event: str, *, request: HttpRequest, endpoint: str, status_code: int,
    reason: str, signed: bool,
) -> None:
    """Emit one JSON line naming what a delivery was and why it was not applied.

    One line, always: ``json.dumps`` escapes everything, so a body value with
    a newline cannot forge a second record.
    """
    logger.log(_WEBHOOK_OUTCOME_LEVELS[event], json.dumps(
        _webhook_outcome_payload(
            event, request=request, endpoint=endpoint,
            status_code=status_code, reason=reason, signed=signed,
        ),
        separators=(',', ':'),
    ))


def get_provider_event_id(request: HttpRequest) -> uuid.UUID:
    """Return the stable provider retry UUID from the request headers.

    RealtimeKit renamed most ``dyte-*`` headers to ``rtk-*``.  Prefer the new
    name when both are present, while retaining the documented legacy retry
    key for callbacks that have not migrated yet.  A signed delivery without
    a usable UUID is rejected: processing it would reintroduce the replay bug
    this endpoint's money and recording paths must prevent.
    """
    raw_event_id = (
        request.headers.get('rtk-uuid')
        or request.headers.get('dyte-uuid')
    )
    if not raw_event_id:
        raise ValueError('missing rtk-uuid/dyte-uuid webhook header')
    try:
        return uuid.UUID(raw_event_id)
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError('invalid rtk-uuid/dyte-uuid webhook header') from exc


def claim_webhook_delivery(
    *, provider_event_id: uuid.UUID, event_type: str, endpoint: str,
    payload: bytes, business_event_key: str,
) -> bool:
    """Claim a delivery without breaking the request's outer transaction.

    ``AtomicMiddleware`` wraps POST requests in a transaction.  The nested
    ``atomic`` is an intentional savepoint: a concurrent insert can violate
    the primary key, and catching that error outside the savepoint leaves the
    outer transaction usable.  A new row remains part of the outer request
    transaction, alongside all billing effects.
    """
    payload_sha256 = hashlib.sha256(payload).hexdigest()
    try:
        with transaction.atomic():
            WebhookDelivery.objects.create(
                provider_event_id=provider_event_id,
                event_type=event_type,
                endpoint=endpoint,
                payload_sha256=payload_sha256,
                business_event_key=business_event_key,
            )
    except IntegrityError:
        existing = WebhookDelivery.objects.filter(
            provider_event_id=provider_event_id,
        ).only('payload_sha256', 'event_type', 'endpoint').first()
        same_delivery_uuid = existing is not None
        if existing is None:
            existing = WebhookDelivery.objects.filter(
                business_event_key=business_event_key,
            ).only('payload_sha256', 'event_type', 'endpoint').first()
        if (
            same_delivery_uuid
            and existing
            and existing.payload_sha256 != payload_sha256
        ):
            logger.error(
                "Provider webhook UUID %s was reused for a different payload "
                "(%s/%s then %s/%s)",
                provider_event_id,
                existing.endpoint,
                existing.event_type,
                endpoint,
                event_type,
            )
        else:
            logger.info("Ignoring duplicate provider webhook %s", provider_event_id)
        return False
    return True


def normalized_event_key(*parts) -> str:
    """Hash stable semantic fields, independent of JSON order/legacy aliases."""
    material = '\x1f'.join(str(part) for part in parts)
    return hashlib.sha256(material.encode('utf-8')).hexdigest()


def recording_business_identity(recording) -> str:
    """Identify a recording without treating refreshed credentials as new.

    RealtimeKit's recording UUID is the authoritative identity and is present
    in the general webhook schema.  The retained legacy endpoint historically
    accepted payloads without it, so only those old shapes fall back to the
    credential-free URL.  Including the discriminator prevents the fallback
    string from ever colliding with a UUID.
    """
    if recording.id is not None:
        return f'id:{recording.id}'
    url = str(recording.downloadUrl)
    parsed = urlsplit(url)
    return f'url:{urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))}'


def recording_idempotency_key(meeting_id, recording) -> uuid.UUID:
    """Return the semantic key the asynchronous consumer must claim.

    Current payloads carry the provider's stable recording UUID.  Historical
    legacy payloads may omit it, so retain a deterministic URL-path fallback
    for those messages without confusing a webhook delivery UUID with the
    recording being delivered.
    """
    if recording.id is not None:
        return uuid.UUID(str(recording.id))
    identity = normalized_event_key(
        'recording', meeting_id, recording_business_identity(recording))
    return uuid.uuid5(uuid.NAMESPACE_URL, f'free2z:dyte-recording:{identity}')


def _historical_private_recording_meeting(meeting_id, session_id=None):
    """Resolve only recordings from a retained private room, never live events."""
    targets = RecordingDeliveryTarget.objects.select_related('creator_meeting').filter(
        provider_meeting_id=str(meeting_id),
    )
    target = targets.filter(
        provider_session_id=session_id, meeting_type=PRIVATE, is_public=False,
    ).first()
    if target is None and session_id is not None and not targets.filter(
        provider_session_id__isnull=False,
    ).exists():
        # A private room's immutable owner is safe across its sessions: this
        # routes an owner-only upload, not participant state or a public tier.
        # A known contradictory session is never guessed onto another target.
        target = targets.filter(
            provider_session_id__isnull=True, meeting_type=PRIVATE, is_public=False,
        ).first()
    cm = target.creator_meeting if target else None
    if (
        cm is not None and cm.meeting_type == PRIVATE and not cm.is_public
        and target.creator_id == cm.creator_id
        and target.creator_id_snapshot == cm.creator_id
    ):
        return cm
    return None


def recording_delivery_business_key(meeting_id, recording) -> str:
    """Deduplicate one usable URL delivery without suppressing a refresh.

    A presigned URL can expire or transiently return 403. RealtimeKit may then
    send the same recording UUID with fresh credentials. The webhook receipt
    must allow that new URL through, while the consumer's stable recording key
    prevents another file after a prior successful ingestion.
    """
    return normalized_event_key(
        'recording-delivery',
        meeting_id,
        recording_business_identity(recording),
        str(recording.downloadUrl),
    )


def publish_recording_ready(
    url, creator, provider_event_id: uuid.UUID,
    recording_key: uuid.UUID, meeting_pk: int,
) -> None:
    """Promise a recording-ready message in the delivery claim's transaction.

    This used to call Pub/Sub here and block on
    ``future.result(timeout=DYTE_PUBSUB_PUBLISH_TIMEOUT_SECONDS)`` while the
    caller's ``@transaction.atomic`` was still open. Two things were wrong
    with that, and  fixes both by writing an outbox row instead:

    * a Pub/Sub slowdown held a **web worker's** database connection for the
      whole timeout, and a webhook burst could hold several at once;
    * waiting only narrowed the crash window, it never closed it. A process
      killed after COMMIT and before (or during) the publish left a committed
      claim with no message and nothing to retry it -- the claim is what makes
      the provider's retry a no-op, so the recording was simply lost.

    Now the promise commits with the claim, and the relay
    (``jobs.publish_outbox`` / the periodic ``jobs.sweep_outbox``) is what
    talks to Pub/Sub. Delivery becomes at-least-once instead of
    at-most-once-if-nothing-crashes; the consumer already deduplicates on
    ``recording_idempotency_key``, which is exactly what makes that
    trade legal.

    ``meeting_pk`` is the stable database primary key of the ``CreatorMeeting``
    that produced the recording. It travels with the payload so the consuming
    subscriber can resolve the meeting's access tier and never store a
    restricted recording as public.
    """
    topic = settings.PUBSUB["DYTE_VIDEO_READY"]["topic"]
    outbox.enqueue(
        topic,
        {
            'url': str(url),
            # The account id is the owner key; the username only names it for
            # older consumers (a deleted account's name can be re-registered).
            'creator_id': int(creator.pk),
            'username': creator.username,
            'provider_event_id': str(provider_event_id),
            'recording_idempotency_key': str(recording_key),
            'meeting_pk': int(meeting_pk),
        },
        # Ordered per recording, so a refreshed-credential redelivery for the
        # same recording can never overtake the original message and hand the
        # subscriber the older, expiring URL last.
        ordering_key=f'dyte-recording:{recording_key}',
        # Unchanged from the synchronous path: deployment provisions the
        # topic, and a missing one must fail the publish (and be retried by
        # the relay) rather than trigger synchronous get/create admin RPCs.
        ensure_topic=False,
    )


# Called by Cloudflare RealtimeKit (Dyte), not by a logged-in user.
# Its authentication is the RSA signature verified below, so it must
# stay open to the DRF permission layer.
#
# DELIBERATELY NOT anon-throttled ( review). Every delivery arrives from a
# handful of provider IPs, so one shared bucket would be hit by legitimate
# bursts — and DRF answers 429, a 4xx the provider does not retry, so throttling
# here would silently drop real billing and live-status events. The
# amplification this would otherwise mitigate is handled at its source instead:
# get_or_load_dyte_public_key caps outbound fetches at one per
# DYTE_KEY_FETCH_RETRY_SECONDS no matter how many requests arrive.
@api_view(['POST'])
@permission_classes([AllowAny])
def webhook(request: HttpRequest):
    from pydantic import ValidationError
    from .types import WebhookEvent

    auth_error = authenticate_dyte_webhook(request)
    if auth_error is not None:
        _log_webhook_outcome(
            DYTE_WEBHOOK_REJECTED_EVENT, request=request, endpoint='general',
            status_code=auth_error.status_code,
            reason=getattr(auth_error, 'dyte_refusal_reason', 'unauthenticated'),
            signed=False,
        )
        return auth_error

    try:
        event_data = WebhookEvent(**request.data)
    except ValidationError as exc:
        # Never log Pydantic's default exception text or request.data here:
        # both include rejected input values, which can contain a live
        # presigned recording credential.  Locations, types and messages are
        # enough to diagnose schema drift without copying the payload.
        logger.error(
            "Invalid webhook data: %s",
            exc.errors(include_url=False, include_input=False),
        )
        # Retry only effect-bearing shapes this endpoint knows how to process.
        # Other valid provider event families use different schemas and are
        # intentionally acknowledged as unsupported instead of retry-storming.
        if request.data.get('event') in {
            'meeting.participantLeft', 'recording.statusUpdate',
        }:
            # The provider will retry 5xx responses. This payload has already
            # passed signature verification but can never pass our schema, so
            # retrying the identical bytes would only create a poison loop.
            _log_webhook_outcome(
                DYTE_WEBHOOK_DROPPED_EVENT, request=request,
                endpoint='general', status_code=status.HTTP_400_BAD_REQUEST,
                reason='invalid_schema', signed=True,
            )
            return Response(status=status.HTTP_400_BAD_REQUEST)
        _log_webhook_outcome(
            DYTE_WEBHOOK_IGNORED_EVENT, request=request, endpoint='general',
            status_code=status.HTTP_200_OK, reason='unsupported_schema',
            signed=True,
        )
        return HttpResponse("OK")

    try:
        provider_event_id = get_provider_event_id(request)
    except ValueError as exc:
        logger.error("Rejecting non-idempotent provider webhook: %s", exc)
        _log_webhook_outcome(
            DYTE_WEBHOOK_DROPPED_EVENT, request=request, endpoint='general',
            status_code=status.HTTP_400_BAD_REQUEST,
            reason='missing_or_invalid_delivery_id', signed=True,
        )
        return Response(status=status.HTTP_400_BAD_REQUEST)

    cm = CreatorMeeting.objects.filter(
        meeting_id=str(event_data.meeting.id)).first()
    if cm is None and event_data.event == 'recording.statusUpdate':
        cm = _historical_private_recording_meeting(
            event_data.meeting.id, getattr(event_data.meeting, 'sessionId', None),
        )
    admission_token = None
    if event_data.event=='meeting.participantLeft':
        token=event_data.participant.customParticipantId
        if isinstance(token,str) and token.startswith('ea_'):
            try:
                candidate=uuid.UUID(hex=token[3:])
            except ValueError:
                candidate=None
            if candidate is not None:
                from dj.apps.economy.models import ServiceAdmission
                if ServiceAdmission.objects.filter(pk=candidate,service='livestream_ppv',policy_version=1,
                        source__meeting_id=str(event_data.meeting.id),
                        source__provider_session_id=str(event_data.meeting.sessionId)).exists():
                    admission_token=candidate
    if admission_token is not None:
        # The room is reusable current state. A delayed callback follows its
        # immutable original admission even after room/host/profile changes.
        _process_compensated_ppv_event(event_data=event_data,
            provider_event_id=provider_event_id,payload=request.body)
        return HttpResponse('OK')
    if cm is None:
        return _acknowledge_unresolved_meeting(
            request, endpoint='general',
            effect_lost=_general_event_has_effect(event_data),
            provider_event_id=provider_event_id,
        )

    _process_webhook_event(
        event_data=event_data,
        cm=cm,
        provider_event_id=provider_event_id,
        payload=request.body,
    )
    return HttpResponse("OK")


@transaction.atomic
def _process_compensated_ppv_event(*, event_data, provider_event_id, payload):
    from dj.apps.economy.products import settle_livestream_delivery
    token=event_data.participant.customParticipantId
    try:
        admission_id=uuid.UUID(hex=token[3:])
    except (ValueError,TypeError) as exc:
        raise EconomicRefusal('original_livestream_admission_unproven') from exc
    key=normalized_event_key('participant-left',event_data.meeting.id,event_data.meeting.sessionId,
        event_data.participant.peerId,token,event_data.participant.joinedAt.isoformat(),
        event_data.participant.leftAt.isoformat())
    pin_supported_policy()
    if not claim_webhook_delivery(provider_event_id=provider_event_id,event_type=event_data.event,
            endpoint='general',payload=payload,business_event_key=key):
        return
    settle_livestream_delivery(admission_id=admission_id,event_key=key,evidence={
        'provider_event_id':str(provider_event_id),'payload_sha256':hashlib.sha256(payload).hexdigest(),
        'meeting_id':str(event_data.meeting.id),'provider_session_id':str(event_data.meeting.sessionId),
        'participant_id':token,'joined_at':event_data.participant.joinedAt.isoformat(),
        'left_at':event_data.participant.leftAt.isoformat()})


def _general_event_has_effect(event_data) -> bool:
    """Would this delivery have changed money or ingested a recording?

    Only two events carry an effect that lives nowhere but the delivery:

    * ``meeting.participantLeft`` settles the platform fee / PPV charge. The
      one leave that is never billed in any meeting type is the creator's own,
      and the provider room's ``title`` is the creator's username
      (``_create_meeting`` -> ``DyteClient.create_meeting(username)``), so a
      leave whose participant id equals the title is the host leaving -- which
      is exactly what a host restart that rotated the room produces.
      Anything else counts as lost, deliberately erring toward the alert.
    * ``recording.statusUpdate`` with ``UPLOADED`` and a download URL. The URL
      expires, so this is the one event that cannot be reconstructed later
      from our side (the logged recording id lets an operator ask the
      provider for a fresh URL).

    ``meeting.started`` / ``meeting.ended`` / ``participantJoined`` for a room
    that is no longer any row's current room must NOT be applied to that row:
    the row now points at a newer room, and an old room's ``meeting.ended``
    would take a live stream off the public list.
    """
    if event_data.event == 'meeting.participantLeft':
        participant = event_data.participant
        participant_id = participant.customParticipantId if participant else None
        return participant_id != event_data.meeting.title
    if event_data.event == 'recording.statusUpdate':
        recording = event_data.recording
        return bool(
            recording
            and recording.status == 'UPLOADED'
            and recording.downloadUrl is not None
        )
    return False


def _acknowledge_unresolved_meeting(
    request, *, endpoint, effect_lost, provider_event_id,
):
    """Answer 200 for a signed delivery whose meeting we cannot resolve.

    Measured in prod: every such 404 in 30 days was an event for a
    provider room that ``_create_meeting`` had already replaced on the same
    ``CreatorMeeting`` row -- a host restarting a broadcast minted a new room
    each time, and the old room's leaves and ``meeting.ended`` arrived
    seconds later. None was "early": the row is written before the host is
    handed a join token, so no event can precede it.

    So the id is not going to start resolving, and a non-2xx buys nothing: a
    4xx is not retried, and a 5xx is retried against a lookup that will fail
    identically every time. Acknowledge it, and say exactly what it was. The
    delivery is deliberately NOT claimed in ``WebhookDelivery``: a claim
    would make a later replay (once the old room can be resolved -- 's
    room-cleanup records) a silent duplicate.

    A provider RETRY of a delivery we already applied (the first response was
    lost, then the room rotated) is not a loss: its claim is already in
    ``WebhookDelivery`` under the same stable delivery UUID, so it is logged
    as ignored with ``reason=already_processed`` rather than counted.
    """
    reason = 'unknown_meeting'
    if effect_lost and WebhookDelivery.objects.filter(
        provider_event_id=provider_event_id,
    ).exists():
        effect_lost = False
        reason = 'already_processed'
    _log_webhook_outcome(
        DYTE_WEBHOOK_DROPPED_EVENT if effect_lost else DYTE_WEBHOOK_IGNORED_EVENT,
        request=request, endpoint=endpoint, status_code=status.HTTP_200_OK,
        reason=reason, signed=True,
    )
    return HttpResponse("OK")


@transaction.atomic
def _process_webhook_event(*, event_data, cm, provider_event_id, payload):
    """Apply one validated delivery atomically with its unique claim."""
    if event_data.event == 'meeting.participantLeft' and cm.meeting_type in (BROADCAST, PAY_PER_VIEW):
        version=pin_supported_policy()
        if version==1 and cm.meeting_type==PAY_PER_VIEW and event_data.participant.customParticipantId==f'ph_{cm.creator.public_id.hex}':
            return
    is_uploaded_recording = (
        event_data.event == 'recording.statusUpdate'
        and event_data.recording
        and event_data.recording.status == 'UPLOADED'
        and event_data.recording.downloadUrl is not None
    )
    needs_claim = (
        event_data.event == 'meeting.participantLeft'
        or is_uploaded_recording
    )
    if needs_claim and not claim_webhook_delivery(
        provider_event_id=provider_event_id,
        event_type=event_data.event,
        endpoint='general',
        payload=payload,
        business_event_key=(
            normalized_event_key(
                'participant-left',
                event_data.meeting.id,
                event_data.meeting.sessionId,
                event_data.participant.peerId,
                event_data.participant.customParticipantId,
                event_data.participant.joinedAt.isoformat(),
                event_data.participant.leftAt.isoformat(),
            )
            if event_data.event == 'meeting.participantLeft'
            else recording_delivery_business_key(
                event_data.meeting.id, event_data.recording)
        ),
    ):
        return

    # You now have a validated 'event_data' object of type 'WebhookEvent'
    # Perform actions based on 'event' type
    if event_data.event == "meeting.started":
        logger.info(
            "meeting started event=%s meeting_id=%s",
            event_data.event,
            event_data.meeting.id,
        )
        cm.live_now = True
        # Stamp presence so the just-went-live room is inside the public
        # list's last_seen_at window and safe from the sweep's grace before
        # the first dyte.sweep_live_meetings probe runs.
        cm.last_seen_at = timezone.now()
        # update_fields: a full save() from this instance, loaded before the
        # event was processed, would write back a stale broadcaster seat
        # (host_session_id) over a start or take-over that committed in
        # between.
        cm.save(update_fields=['live_now', 'last_seen_at'])

    elif event_data.event == "meeting.ended":
        logger.info(
            "meeting ended event=%s meeting_id=%s",
            event_data.event,
            event_data.meeting.id,
        )
        cm.live_now = False
        cm.save(update_fields=['live_now'])

    elif event_data.event == "meeting.participantJoined":
        logger.info(
            "participant joined event=%s meeting_id=%s",
            event_data.event,
            event_data.meeting.id,
        )
        # we get started/ended when the user leaves so
        # we don't need to record anything here?

    elif event_data.event == "meeting.participantLeft":
        logger.info(
            "participant left event=%s meeting_id=%s",
            event_data.event,
            event_data.meeting.id,
        )
        joined_at = event_data.participant.joinedAt
        left_at = event_data.participant.leftAt
        duration_minutes = math.ceil((left_at - joined_at).total_seconds() / 60)

        # Apply billing logic based on meeting type
        meeting_type = cm.meeting_type
        if meeting_type == SUBSCRIBERS_ONLY:
            logger.info("subscribers-only")
            # Billing logic for subscribers-only meetings
            pass
        elif meeting_type == BROADCAST:
            logger.info("broadcast")
            # Only charge the creator if the participant is not the creator
            # so people can play around a bit for free
            if (not cm.creator.username == event_data.participant.customParticipantId):
                # Calculate the platform fee and update the creator's tuzis
                platform_fee = calculate_platform_fee(duration_minutes)
                logger.info(f"broadcast {platform_fee} from {cm.creator.username}")
                # Atomic, clamped debit: the stream already
                # happened, so collect what is there; never drive the balance
                # negative, and record what was actually collected.
                #
                # Deliberately UNCONDITIONAL, including when platform_fee is 0
                # (issue: a session of a minute or less is free). The row is
                # the only per-session record we keep, and the abuse signature
                # is thousands of sessions against a handful of concurrent
                # participants — a ratio you can only see if the free sessions
                # are still written down. Do not skip the Event to save a row.
                with transaction.atomic():
                    charged = ledger.debit_up_to(
                        cm.creator, platform_fee, action="platform_fee")
                    Event.objects.create(
                        type="PLATFORM_FEE",
                        receiving_user=cm.creator,
                        amount=charged,
                    )
        elif meeting_type == PAY_PER_VIEW:
            if pin_supported_policy() == 1:
                # Old active sessions must drain or have an exact reviewed
                # legacy receipt disposition before activation. The exclusive
                # delivery adapter will consume captured ea_<admission> IDs.
                raise EconomicRefusal('livestream_delivery_integration_unavailable')
            # Only charge if it's not the creator
            participant_id = event_data.participant.customParticipantId
            if participant_id != cm.creator.username:
                logger.info("ppv")
                participant = Creator.objects.get(username=event_data.participant.customParticipantId)
                price_per_minute = cm.price_per_minute
                platform_fee = calculate_platform_fee(duration_minutes)
                creator_fee = math.ceil(price_per_minute * duration_minutes)

                # One transaction for the whole PPV settlement:
                # platform fee, then the creator's cut. Previously these were
                # four independent read-modify-write saves, so a failure
                # part-way through left the participant charged and the
                # creator unpaid.
                #
                # Also fixed here: the participant used to be debited the FULL
                # `creator_fee` while the creator was only credited
                # `min(creator_fee, balance)`. When the participant couldn't
                # afford it, the difference was destroyed and the balance went
                # negative. Now exactly what the creator receives is what the
                # participant pays.
                with transaction.atomic():
                    # Acquire BOTH balance rows in primary-key order before
                    # touching either. This block debits the participant, then
                    # credits the creator — participant first regardless of
                    # their ids — while ledger.transfer() (donations,
                    # subscriptions) acquires in pk order. When
                    # participant.pk > creator.pk those are opposite orders, so
                    # a fan leaving a PPV stream while donating to that same
                    # creator could deadlock and one of the two would die.
                    ledger.lock_in_order(participant, cm.creator)
                    charged_fee = ledger.debit_up_to(
                        participant, platform_fee, action="platform_fee")
                    Event.objects.create(
                        type="PLATFORM_FEE",
                        receiving_user=participant,
                        amount=charged_fee,
                    )
                    logger.info(f"Platform fee of {charged_fee} tuzis deducted from {participant_id}")
                    # Give whatever is available to the creator, up to the
                    # total price.
                    total_creator_fee = ledger.debit_up_to(
                        participant, creator_fee, action="ppv")
                    # The creator's cut: `sys:platform_revenue -> user`,
                    # named and keyed by this delivery's provider event id
                    # (claim_webhook_delivery already refuses a redelivery
                    # before any money moves, so the key is a second wall,
                    # not the first).
                    ledger.credit(
                        cm.creator, total_creator_fee,
                        source="sys:platform_revenue",
                        ref_kind="ppv",
                        ref_id=str(provider_event_id),
                        idem=f"ppv:{provider_event_id}",
                    )
                    Event.objects.create(
                        type="PAY_PER_VIEW_REVENUE",
                        receiving_user=cm.creator,
                        contributor=participant,
                        amount=total_creator_fee,
                        payee=cm.creator,
                    )
                    Event.objects.create(
                        type="PAY_PER_VIEW_SPEND",
                        receiving_user=participant,
                        contributor=participant,
                        amount=total_creator_fee,
                        payee=cm.creator,
                    )
                logger.info(f"{total_creator_fee} tuzis transferred to {cm.creator.username} from {participant_id}")

    elif event_data.event == "recording.statusUpdate":
        recording = event_data.recording
        redacted_url = redact_recording_url(
            recording.downloadUrl if recording else None,
            settings.DYTE_RECORDING_ALLOWED_HOSTS,
        )
        recording_status = recording.status if recording else None
        logger.info(
            "recording status update event=%s meeting_id=%s status=%s "
            "download_url=%s",
            event_data.event,
            event_data.meeting.id,
            recording_status,
            redacted_url,
        )
        # Specific handling for recording status updates
        if recording and recording.status == "UPLOADED":
            logger.info(
                "recording uploaded event=%s meeting_id=%s status=%s "
                "download_url=%s",
                event_data.event,
                event_data.meeting.id,
                recording_status,
                redacted_url,
            )
            # Process the recording. `cm` was resolved by the caller from this
            # same meeting id (an unresolvable one is acknowledged and logged
            # there, ); a second lookup here could only 404 a delivery
            # whose claim is already in this transaction.
            url = recording.downloadUrl
            if url:
                publish_recording_ready(
                    url,
                    cm.creator,
                    provider_event_id,
                    recording_idempotency_key(
                        event_data.meeting.id, event_data.recording),
                    meeting_pk=cm.pk,
                )
        else:
            logger.debug(
                "recording not uploaded event=%s meeting_id=%s status=%s "
                "download_url=%s",
                event_data.event,
                event_data.meeting.id,
                recording_status,
                redacted_url,
            )

    else:
        # Log and/or handle unknown event types
        logger.warning(f"Received unknown event type: {event_data.event}")

# Legacy recording-only webhook.
#
# Kept ALIVE on purpose: nothing in this repo registers the provider-side
# webhook URL, so we cannot prove from code whether the dashboard still points
# recording callbacks here or at the general `webhook` above. Deleting it would
# risk recordings silently ceasing to ingest — the download URL expires
# (`downloadUrlExpiry` in types.py), so a missed callback is unrecoverable.
#
# What  was actually about: this endpoint had NO signature verification and
# published an attacker-supplied `recording.downloadUrl` to the DYTE_VIDEO_READY
# topic tagged with a creator's username. The deployed consumer of that topic
# (`dyte_download_upload`) then did an UNALLOWLISTED `requests.get(url)` and
# saved the result as a GenericFile owned by that creator — an unauthenticated,
# in-cluster SSRF + file-injection-as-any-creator primitive.
#
# The fix is two independent layers, both required:
#   1. this endpoint now runs the SAME signature check as `webhook` (below),
#      so an unsigned or forged request is rejected before any work happens;
#   2. the sink (`dyte_download_upload`) allowlists the download host/scheme,
#      so even an authentic message cannot make it fetch an arbitrary URL.
# A valid signature proves the message came from the provider; it does not make
# a provider-relayed URL safe to fetch. Hence both.
#
# AllowAny + unthrottled for the same reason as `webhook`: its auth is the
# signature, and a 429 is a 4xx the provider will not retry. Detection of a
# silent ingestion stop is tracked in.
@api_view(['POST'])
@permission_classes([AllowAny])
def webhook_recording_status_update(request: HttpRequest):
    """
    DEPRECATED (superseded by the recording.statusUpdate branch of `webhook`),
    but retained and now signature-verified — see the note above.
    """
    auth_error = authenticate_dyte_webhook(request)
    if auth_error is not None:
        _log_webhook_outcome(
            DYTE_WEBHOOK_REJECTED_EVENT, request=request,
            endpoint='recording-legacy', status_code=auth_error.status_code,
            reason=getattr(auth_error, 'dyte_refusal_reason', 'unauthenticated'),
            signed=False,
        )
        return auth_error

    from pydantic import ValidationError
    from .types import LegacyRecordingWebhookEvent

    try:
        event_data = LegacyRecordingWebhookEvent(**request.data)
    except ValidationError as exc:
        logger.error(
            "Invalid legacy recording webhook data: %s",
            exc.errors(include_url=False, include_input=False),
        )
        _log_webhook_outcome(
            DYTE_WEBHOOK_DROPPED_EVENT, request=request,
            endpoint='recording-legacy',
            status_code=status.HTTP_400_BAD_REQUEST,
            reason='invalid_schema', signed=True,
        )
        return Response(status=status.HTTP_400_BAD_REQUEST)

    try:
        provider_event_id = get_provider_event_id(request)
    except ValueError as exc:
        logger.error("Rejecting non-idempotent provider webhook: %s", exc)
        _log_webhook_outcome(
            DYTE_WEBHOOK_DROPPED_EVENT, request=request,
            endpoint='recording-legacy',
            status_code=status.HTTP_400_BAD_REQUEST,
            reason='missing_or_invalid_delivery_id', signed=True,
        )
        return Response(status=status.HTTP_400_BAD_REQUEST)

    cm = CreatorMeeting.objects.filter(
        meeting_id=str(event_data.meeting.id)).first()
    if cm is None:
        cm = _historical_private_recording_meeting(
            event_data.meeting.id, getattr(event_data.meeting, 'sessionId', None),
        )
    if cm is None:
        recording = event_data.recording
        return _acknowledge_unresolved_meeting(
            request, endpoint='recording-legacy',
            effect_lost=(
                recording.status == 'UPLOADED'
                and bool(recording.downloadUrl)
            ),
            provider_event_id=provider_event_id,
        )
    _process_legacy_recording_event(
        event_data=event_data,
        cm=cm,
        provider_event_id=provider_event_id,
        payload=request.body,
    )
    return HttpResponse("OK")


@transaction.atomic
def _process_legacy_recording_event(
    *, event_data, cm, provider_event_id, payload,
):
    recording = event_data.recording
    if recording.status != 'UPLOADED' or not recording.downloadUrl:
        return

    recording_key = recording_idempotency_key(
        event_data.meeting.id, recording)

    if not claim_webhook_delivery(
        provider_event_id=provider_event_id,
        event_type='recording.statusUpdate',
        endpoint='recording-legacy',
        payload=payload,
        business_event_key=recording_delivery_business_key(
            event_data.meeting.id, recording),
    ):
        return

    publish_recording_ready(
        recording.downloadUrl, cm.creator, provider_event_id, recording_key,
        meeting_pk=cm.pk)


@extend_schema_view(
    retrieve=extend_schema(responses=CreatorMeetingSerializer),
)
class PublicMeetingViewSet(viewsets.ReadOnlyModelViewSet):
    # Public: the live-now list renders on anonymous creator pages.
    # Browser-polled, so 'anon-poll' — kept out of the auth bucket.
    permission_classes = [AllowAny]
    throttle_classes = POLLING_THROTTLES
    # live_now is kept truthful in the DB by the dyte.sweep_live_meetings
    # periodic worker, so the public read stays a single indexed query and
    # never probes the provider. Declared as a class attr for the router
    # basename; the effective, time-bounded query is built in get_queryset.
    queryset = CreatorMeeting.objects.filter(
        creator__is_active=True, is_public=True, live_now=True,
    )
    serializer_class = CreatorMeetingSerializer
    lookup_field = 'meeting_id'

    def _live_queryset(self):
        # Single, indexed query (see CreatorMeeting.Meta.indexes). The
        # last_seen_at bound is a belt-and-suspenders guard: if the sweep
        # worker stalls, rooms drop off once their confirmed presence goes
        # stale instead of sticking forever. It never hides a just-went-live
        # room — go-live and the meeting.started webhook stamp
        # last_seen_at=now, and a healthy sweep refreshes it well within the
        # TTL window.
        cutoff = timezone.now() - timezone.timedelta(
            seconds=settings.DYTE_LIVE_LAST_SEEN_TTL_SECONDS)
        return CreatorMeeting.objects.filter(
            creator__is_active=True,
            is_public=True,
            live_now=True,
            last_seen_at__gte=cutoff,
            # Rows written before the route was constrained can
            # hold a meeting_type outside the enum. The serializer advertises
            # a closed enum, so serving one breaks a strict client on a value
            # it was never told about. This fix stops NEW junk; the filter
            # stops the OLD junk leaking out, without a data migration.
            meeting_type__in=PUBLIC_MEETING_TYPES,
        )

    def get_queryset(self):
        return self._live_queryset().order_by('-created_at')

    @extend_schema(
        operation_id='dyte_public_discovery_list',
        description=(
            f"Return the current public live modes for at most "
            f"{PUBLIC_DISCOVERY_LIMIT} creators, "
            "ordered by presence freshness. The selected_creators list is "
            "complete for each selected creator. If complete is false, "
            "creators not selected are unknown rather than offline. Private "
            "rooms are never included."
        ),
        responses=PublicMeetingDiscoverySerializer,
    )
    @action(
        detail=False,
        methods=['get'],
        url_path='discovery',
        pagination_class=None,
    )
    def discovery(self, request):
        # Pick creators by the freshest live mode, then return every current
        # public mode for those creators. Limiting meeting rows directly can
        # split a creator's modes at the cutoff and tell the browser that a
        # live mode is absent when it was merely truncated. The grouped
        # subquery keeps the response bounded at 12 creators * the finite
        # public meeting enum, without adding a query for the cap metadata.
        creator_groups = (
            self._live_queryset()
            .values('creator_id')
            .annotate(
                _latest_seen=Max('last_seen_at'),
                _latest_created=Max('created_at'),
            )
            .order_by('-_latest_seen', '-_latest_created', '-creator_id')
        )
        selected_creator_ids = creator_groups.values(
            'creator_id'
        )[:PUBLIC_DISCOVERY_LIMIT]
        has_more_creators = creator_groups.values('creator_id')[
            PUBLIC_DISCOVERY_LIMIT:PUBLIC_DISCOVERY_LIMIT + 1
        ]
        queryset = self._live_queryset().select_related(
            'creator', 'creator__avatar_image', 'creator__avatar_image__webp',
        ).prefetch_related(
            Prefetch(
                'creator__avatar_image__variants',
                queryset=ImageVariant.objects.filter(format='webp'),
            ),
        ).order_by(
            '-last_seen_at', '-created_at', '-pk',
        ).annotate(
            _discovery_has_more=Exists(has_more_creators),
        ).filter(creator_id__in=Subquery(selected_creator_ids))
        rows = list(queryset)
        selected_creators = list(dict.fromkeys(
            row.creator.username for row in rows
        ))
        payload = {
            'results': rows,
            'selected_creators': selected_creators,
            'complete': not any(
                getattr(row, '_discovery_has_more', False) for row in rows
            ),
        }
        response = Response(PublicMeetingDiscoverySerializer(payload).data)
        # This is a changing live snapshot. Do not let a browser, CDN, or
        # intermediary replay a dead rail after the DB state has changed.
        response['Cache-Control'] = 'no-store'
        return response

    def get_object(self):
        queryset = self.filter_queryset(self.get_queryset())

        obj = get_object_or_404(
            queryset,
            meeting_id=self.kwargs.get('meeting_id'),
        )
        self.check_object_permissions(self.request, obj)
        return obj


# Public read on creator pages. Anon-throttled because each call fans
# out to the paid Dyte participants API — unauthenticated amplification.
# This is the endpoint that motivated the scope split: LiveIndicator polls it
# every 15-60s per card, so it gets its own 'anon-poll' budget.
@api_view(['GET'])
@permission_classes([AllowAny])
@throttle_classes(POLLING_THROTTLES)
def live_meeting_status(request, username):
    dc = DyteClient(settings.DYTE_ORG)
    live_meetings = CreatorMeeting.objects.filter(
        creator__username=username,
        creator__is_active=True,
        is_public=True,
        live_now=True,
        # Same reason as PublicMeetingViewSet._live_queryset: this response is
        # keyed BY meeting_type, and the client parses it against a closed
        # enum, so one legacy off-enum row would invalidate the
        # whole payload and hide that creator's real streams.
        meeting_type__in=PUBLIC_MEETING_TYPES,
    ).values('meeting_type', 'meeting_id', 'price_per_minute')
    # this fundamentally ties the whole experience to polling dyte for
    # the participant count. I guess it could be fine though.
    resp = {}
    for meeting in live_meetings:
        try:
            count = dc.get_participants_count(meeting['meeting_id'])
        except Exception as exc:
            # A provider hiccup must never 500 a public, bot-crawled page.
            # Unknown presence reads as "not live" for this response only;
            # dyte.sweep_live_meetings owns reconciling live_now.
            logger.warning(
                "live_meeting_status: probe failed for %s (%s): %s",
                meeting['meeting_id'], username, exc,
            )
            continue
        meeting['participants'] = count
        # bring back count when dyte fixes regression
        # https://discord.com/channels/872824138048352277/1253228307227349004
        if count:
            resp[meeting['meeting_type']] = meeting
    return Response(resp)


def _create_meeting(cm: CreatorMeeting, dc: DyteClient = None) -> CreatorMeeting:
    if not dc:
        dc = DyteClient(settings.DYTE_ORG)
    resp = dc.create_meeting(cm.creator.username)
    d = resp.json()
    if d.get('error'):
        logger.error(d)
        raise Exception("Dyte Error")
    cm.meeting_id = d['data']['id']
    # NOTE: `created_at` is deliberately NOT moved here, although the
    # host path's "rotate a room over a day old" rule reads it and so, from a
    # row's second day, every host start mints a new room and orphans the old
    # room's in-flight events (all 7 prod webhook 404s in 30 days). Reusing the
    # room is not safe until lifecycle and billing are scoped to the provider
    # SESSION: a restart re-prices `price_per_minute`, which a delayed leave
    # from the previous session would then settle at, and the previous
    # session's late `meeting.ended` would take the new session offline (the
    # sweep only re-checks live rooms).  adds that session state; until
    # then an orphaned event is acknowledged and counted at the webhook.
    cm.save(update_fields=['meeting_id'])
    return cm


# ---------------------------------------------------------------------------
# The broadcaster seat: one publishing tab per creator.
#
# Before this, every host POST to /api/dyte/<me>/<type> added another host
# participant, and -- because `created_at` never moves  -- from a row's
# second day every one of them also minted a NEW provider room. So a second
# dashboard tab, a refresh, a double click, or the creator merely opening
# their own public stream page (which POSTed as the owner and got the host
# preset) either published a shadow host into the live room or moved the
# row to a fresh room and stranded every viewer in the old one.
#
# The seat is a lease on CreatorMeeting (host_session_id/host_session_seen_at)
# with a partial unique constraint: at most one row per creator holds it. The
# tab that holds it renews it every HOST_SESSION_HEARTBEAT_SECONDS; after
# HOST_SESSION_TTL without a renewal it is free again (a closed laptop must
# not lock the creator out forever). Taking a held seat requires an explicit
# `takeover`, and the tab that lost it learns so from its next heartbeat.
# ---------------------------------------------------------------------------

HOST_SESSION_HEARTBEAT_SECONDS = 15
# Four missed heartbeats. A broadcasting tab holds a live WebRTC connection,
# which exempts it from Chrome's intensive background-timer throttling, but a
# network blip or a slow mobile radio should not hand the seat to nobody.
HOST_SESSION_TTL = timezone.timedelta(seconds=60)


def _lock_host_seat(creator):
    """Serialize every seat decision for one creator until the transaction ends.

    A transaction-scoped advisory lock rather than SELECT... FOR UPDATE on the
    Creator row: a host start spends seconds in provider calls, and holding
    the account row that long would stall that creator's 2Z debits and
    credits (webhook billing, donations). This lock contends only with other
    seat decisions for the same creator -- which is exactly the race being
    closed: two tabs (or a double click) deciding at the same moment that the
    seat is free.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_advisory_xact_lock(hashtext(%s)::bigint)",
            [f"dyte-host-seat:{creator.pk}"],
        )


# A previous host is retried on every heartbeat (15s) of the new holder; 40
# attempts is ten minutes of a provider that will not confirm, after which the
# entry is dropped LOUDLY -- an operator can still end the room by hand.
HOST_EVICTION_MAX_ATTEMPTS = 40


def _retire_hosts(dc, entries, creator):
    """Retire each previous host; return the entries still unconfirmed."""
    remaining = []
    for entry in entries or []:
        meeting_id = entry.get('meeting_id')
        participant_id = entry.get('participant_id')
        if not meeting_id or not participant_id:
            continue
        if dc.retire_participant(meeting_id, participant_id):
            logger.info(
                "host seat handoff: previous host retired creator=%s",
                creator.pk)
            continue
        attempts = int(entry.get('attempts') or 0) + 1
        if attempts >= HOST_EVICTION_MAX_ATTEMPTS:
            logger.error(
                "host seat handoff: previous host NOT retired after %s "
                "attempts creator=%s meeting=%s participant=%s",
                attempts, creator.pk, meeting_id, participant_id,
            )
            continue
        remaining.append({
            'meeting_id': meeting_id,
            'participant_id': participant_id,
            'attempts': attempts,
        })
    return remaining


def _held_host_seat(creator):
    """The creator's seat-holding row, or None. The constraint allows one."""
    return (
        CreatorMeeting.objects
        .filter(creator=creator, host_session_id__isnull=False)
        .first()
    )


def _seat_is_fresh(cm, now) -> bool:
    return bool(
        cm is not None
        and cm.host_session_id is not None
        and cm.host_session_seen_at is not None
        and now - cm.host_session_seen_at < HOST_SESSION_TTL
    )


def _seat_conflict_response(cm, *, code, status_code=status.HTTP_409_CONFLICT):
    messages = {
        'already_live_elsewhere': (
            "You are already live in another tab or on another device."
        ),
        'host_session_superseded': (
            "This broadcast was taken over from another tab or device."
        ),
    }
    return Response(
        status=status_code,
        data={
            'code': code,
            'error': messages[code],
            'meeting_type': (
                cm.meeting_type
                if cm is not None and cm.meeting_type in PUBLIC_MEETING_TYPES
                else None
            ),
            'last_seen_at': cm.host_session_seen_at if cm is not None else None,
        },
    )


def _host_seat_status(creator, now):
    cm = _held_host_seat(creator)
    fresh = _seat_is_fresh(cm, now)
    return {
        'active': fresh,
        'host_session': cm.host_session_id if fresh else None,
        'meeting_type': (
            cm.meeting_type
            if fresh and cm.meeting_type in PUBLIC_MEETING_TYPES
            else None
        ),
        'last_seen_at': cm.host_session_seen_at if fresh else None,
        'ttl_seconds': int(HOST_SESSION_TTL.total_seconds()),
    }


def is_path_owner(request, kwargs) -> bool:
    """True when the authenticated caller owns the `username` in the path.

    Compared case-insensitively, which is how a username identifies a creator
    everywhere else in this codebase: signup rejects case-variant duplicates
    with `username__iexact`, and the public reads resolve creators the same
    way. A case-sensitive `==` therefore does not mean "not the owner", it
    means "the owner spelled their own name differently" — and every guard
    written that way silently opens for `/api/dyte/Alice/...`.

    `lower()`, deliberately, and NOT `casefold()`. The equivalence this has to
    agree with is Postgres' `username__iexact`, which is simple case mapping.
    Full Unicode case folding is strictly wider — it maps `ß` to `ss`, `ﬁ` to
    `fi` — so `casefold()` would treat two accounts the database considers
    distinct as one, and let a guard keyed on "is this me" answer yes for
    somebody else's name. A gate must never be wider than the identity model
    underneath it.
    """
    path_username = (kwargs.get('username') or '').lower()
    if not path_username:
        return False
    return (request.user.username or '').lower() == path_username


class PrivateMeetingManage(APIView):
    """
    Manage the authenticated creator's own private meeting.

    GET returns the secret UUID of the caller's private meeting.
    POST creates the caller's private meeting if it does not exist yet, and
    otherwise recycles the secret UUID and returns a new one.

    Only for the creator to manage their own private meeting: the `username`
    in the path must be the caller's own, and any other username is a 403.
    """
    permission_classes = [IsAuthenticated]

    def get(self, request, *args, **kwargs):
        if not is_path_owner(request, kwargs):
            return Response(
                status=status.HTTP_403_FORBIDDEN,
                data="You can only manage your own private meeting",
            )
        cm = get_object_or_404(
            CreatorMeeting,
            creator=request.user,
            meeting_type=PRIVATE,
        )
        return Response(data={
            'secret': cm.secret,
            'e2ee': cm.e2ee,
        })

    def post(self, request, *args, **kwargs):
        # This route only ever acts on `creator=request.user`, so the username
        # in the path was decoration — except that the can_stream gate below
        # was conditioned on it matching. Posting to somebody else's path
        # (or to a case-variant of one's own) therefore skipped the 150 2Z
        # requirement AND minted a fresh paid provider meeting per request,
        # while `/live/{username}?type=private` made that URL reachable from
        # the UI. Establish ownership first, before any gate, any write and
        # any provider call.
        if not is_path_owner(request, kwargs):
            return Response(
                status=status.HTTP_403_FORBIDDEN,
                data="You can only manage your own private meeting",
            )
        if not request.user.can_stream:
            return Response(
                status=status.HTTP_400_BAD_REQUEST,
                data="You need at least 150 to go live!"
            )
        # Serialize invitation/room rotation with private recording mutations.
        with transaction.atomic():
            cm, _ = CreatorMeeting.objects.select_for_update().get_or_create(
                creator=request.user,
                meeting_type=PRIVATE,
                is_public=False,
            )
            if cm.meeting_id and not cm.e2ee:
                from .recording_control import ACTIVE, ProviderUnavailable, recording_status
                from .models import RecordingDelivery

                try:
                    current = recording_status(cm)
                except (ProviderUnavailable, requests.RequestException, ValueError, TypeError, KeyError):
                    return Response(
                        {"code": "recording_status_unknown", "error": "Recording status could not be confirmed. Retry before creating another private link."},
                        status=503,
                    )
                # Keep the old invitation usable for stopping capture and keep
                # its provider room attributable until the upload is ingested.
                if current and (
                    current["status"] in ACTIVE | {"STOPPING", "UPLOADING"}
                    or (
                        current["status"] == "UPLOADED"
                        and not RecordingDelivery.objects.filter(
                            idempotency_key=current["id"], completed_at__isnull=False,
                        ).exists()
                    )
                ):
                    delivery_failed = current["status"] == "UPLOADED" and RecordingDelivery.objects.filter(
                        idempotency_key=current["id"], retry_exhausted_at__isnull=False,
                    ).exists()
                    return Response(
                        {
                            "code": (
                                "recording_active" if current["status"] in ACTIVE else
                                "recording_delivery_failed" if delivery_failed else "recording_delivery_pending"
                            ),
                            "error": (
                                "Stop recording before creating another private link."
                                if current["status"] in ACTIVE else
                                "The recording could not be saved. Return to the current call or contact support before replacing its private link."
                                if delivery_failed else
                                "The recording is processing. Wait for it to appear in your uploads, then retry creating the private link."
                            ),
                        },
                        status=409,
                    )
            if cm.meeting_id:
                # A delayed callback can outlive the recording-status cache or
                # a later recording. Preserve owner routing before replacing
                # the provider room; no public audience is inferred from this.
                target, _ = RecordingDeliveryTarget.objects.get_or_create(
                    provider_meeting_id=cm.meeting_id, provider_session_id=cm.provider_session_id,
                    defaults={
                        'creator': cm.creator, 'creator_id_snapshot': cm.creator_id,
                        'creator_meeting': cm, 'meeting_type': PRIVATE, 'is_public': False,
                    },
                )
                if (
                    target.creator_id != cm.creator_id
                    or target.creator_id_snapshot != cm.creator_id
                    or target.creator_meeting_id != cm.pk
                    or target.meeting_type != PRIVATE or target.is_public
                ):
                    return Response({'error': 'Private room ownership could not be confirmed.'}, status=503)
            cm = _create_meeting(cm)
            cm.e2ee = request.data.get('e2ee', False)
            cm.recycle_secret()
        return Response(data={
            'secret': cm.secret,
            'e2ee': cm.e2ee,
        })


class PrivateMeeting(APIView):
    """
    Post will join the private meeting:

    For the creator, it will join the meeting as the host
    For the participant, it will join the meeting as a participant
    """

    # post() reads request.user.can_stream and adds request.user as a
    # participant; anonymous callers used to 500 here.
    permission_classes = [IsAuthenticated]

    def post(self, request, *args, **kwargs):
        dc = DyteClient(settings.DYTE_ORG)
        stream_owner = kwargs.get('username')
        secret = kwargs.get('secret')

        # `creator__is_active` is the deactivation gate: a deactivated
        # room owner must not have their private room joinable — not even by a
        # genuine secret holder — and the refusal must happen BEFORE any paid
        # provider call. It is part of the lookup (not a later branch) so an
        # inactive owner's room resolves to a 404, the same answer every other
        # deactivated-creator surface gives (: 404, never 403/410 — no
        # existence oracle).
        cm = get_object_or_404(
            CreatorMeeting,
            creator__username__iexact=stream_owner,
            creator__is_active=True,
            meeting_type=PRIVATE,
            secret=secret,
        )

        # Only the room's own creator is gated on can_stream; an invitee joins
        # on the strength of the secret alone, so this must NOT become an
        # ownership check on the route.
        #
        # Decided from the row's creator id rather than by comparing the path
        # string to `request.user.username`: once the room is in hand, identity
        # is a fact, not a string-equality convention. Comparing spellings here
        # could only ever be wrong in one of two directions — miss the real
        # owner (they skip the balance requirement) or match somebody who is
        # not (a legitimate invitee is refused with "You need at least 150 to
        # go live!" for a room that is not theirs).
        if cm.creator_id == request.user.pk and not request.user.can_stream:
            return Response(
                status=status.HTTP_400_BAD_REQUEST,
                data="You need at least 150 to go live!"
            )
        # if not cm.meeting_id:
        #     cm = _create_meeting(cm, dc)

        resp = dc.add_participant(request.user, cm.meeting_id)
        auth_token = resp.json()['data']['token']
        return Response({
            # "meeting_id": cm.meeting_id,
            "e2ee": cm.e2ee,
            "auth_token": auth_token,
        })


class IsAuthenticatedOrPublicBroadcast(IsAuthenticatedOrReadOnly):
    """Allow guests to join only the public broadcast meeting type.

    Read-only status probes remain public. Every write by an authenticated
    creator/viewer remains allowed, while anonymous POSTs are restricted to
    the one meeting type whose product contract explicitly permits guests.
    Entitlement-bearing stream types therefore never reach token issuance.
    """

    def has_permission(self, request, view):
        if super().has_permission(request, view):
            return True
        return (
            request.method == "POST"
            and view.kwargs.get("type", "").lower() == "broadcast"
        )


class PublicBroadcastAutoSchema(AutoSchema):
    """Describe the type-dependent endpoint as accepting optional auth.

    The shared POST is anonymous for ``broadcast`` and authenticated for the
    entitlement-bearing types. OpenAPI cannot express security conditional on
    a path-parameter value, so optional authentication is the truthful
    operation-level representation. GET is public for every type.
    """

    def get_auth(self):
        auth = super().get_auth()
        if {} not in auth:
            auth.append({})
        return auth


MEETING_TYPE_PATH_PARAMETER = OpenApiParameter(
    name='type',
    location=OpenApiParameter.PATH,
    type=str,
    enum=list(PUBLIC_MEETING_TYPES),
    required=True,
    description=(
        "Public meeting type. This is a closed enum, not free text: the URL "
        "pattern only matches these values (case-insensitively), so anything "
        "else does not resolve and returns 404 without touching the database "
        "or the meeting provider. Anonymous POST access is permitted only "
        "for broadcast; ppv and subscribers-only require authentication."
    ),
)


def resolve_public_meeting_type(kwargs):
    """Normalize the `type` path segment, or return None if it isn't one.

    The path converter registered in urls.py already rejects anything outside
    the enum, so in production this never returns None. It is kept as a second
    gate because the value is persisted (`CreatorMeeting.meeting_type`) and
    triggers paid provider calls: `choices` is only enforced by
    `full_clean()`, which nothing on this path calls, so a future URL edit
    must not be able to reopen issue  silently.
    """
    raw = kwargs.get('type') or ''
    meeting_type = raw.lower()
    if meeting_type not in PUBLIC_MEETING_TYPES:
        return None
    return meeting_type


class DyteMeeting(APIView):
    """
    Create/join _public_ meetings
    """

    # GET is the public "is this creator live / how many watching" read used
    # on anonymous creator pages. POST starts a meeting for authenticated
    # creators or joins it as a viewer; only broadcasts permit guest viewers.
    # GET is browser-polled, so it uses the generous 'anon-poll' scope. An
    # anonymous broadcast POST creates a paid-provider participant and uses a
    # separate, tighter scope. Authenticated calls keep the global user cap.
    permission_classes = [IsAuthenticatedOrPublicBroadcast]
    throttle_classes = DYTE_MEETING_THROTTLES
    schema = PublicBroadcastAutoSchema()

    @extend_schema(parameters=[MEETING_TYPE_PATH_PARAMETER])
    def get(self, request, *args, **kwargs):
        """
        Returns number of participants in a meeting or 4XX if not live
        """
        username = kwargs.get('username')
        # Validate before anything else: an unknown type is not a resource.
        meeting_type = resolve_public_meeting_type(kwargs)
        if meeting_type is None:
            return Response(
                status=status.HTTP_404_NOT_FOUND,
                data="Unknown meeting type",
            )
        dc: DyteClient = DyteClient(settings.DYTE_ORG)

        star: Creator = get_object_or_404(
            Creator, username=username, is_active=True
        )

        if not star.can_stream:
            return Response(
                status=status.HTTP_404_NOT_FOUND,
                data="Not Live",
            )

        # get the meeting for the creator by type and is_public and live_now
        cm: CreatorMeeting = get_object_or_404(
            CreatorMeeting,
            creator=star,
            meeting_type=meeting_type,
            is_public=True,
            # 404 if not live
            live_now=True,
        )
        try:
            participants = dc.get_participants_count(cm.meeting_id)
        except Exception as exc:
            # Don't 500 on a provider error — report "Not Live" instead.
            logger.warning(
                "stream status: probe failed for %s (%s): %s",
                cm.meeting_id, username, exc,
            )
            participants = 0

        if not participants:
            return Response(
                status=status.HTTP_404_NOT_FOUND,
                data="Not Live",
            )
        return Response(
            data=participants
        )

    @extend_schema(
        parameters=[MEETING_TYPE_PATH_PARAMETER],
        description=(
            "Start or join a public meeting. Anonymous callers may join only "
            "broadcast meetings; ppv and subscribers-only require "
            "authentication and their corresponding entitlement checks."
        ),
        request=MeetingJoinRequestSchemaSerializer,
        responses={
            status.HTTP_200_OK: MeetingJoinResponseSerializer,
            status.HTTP_402_PAYMENT_REQUIRED: STREAM_PAYMENT_REQUIRED_RESPONSE,
            status.HTTP_409_CONFLICT: OpenApiResponse(
                response=HostSeatConflictSerializer,
                description=(
                    "Host start only: another tab or device holds the "
                    "broadcaster seat (`already_live_elsewhere`). Nothing "
                    "was created, joined or rotated. Retry with "
                    "`takeover: true` to move the broadcast here."
                ),
            ),
        },
    )
    def post(self, request, *args, **kwargs):
        stream_owner = kwargs.get('username')
        # First thing, before any query, any get_or_create and any (paid)
        # provider call: the URL segment must name a real meeting type.
        # Otherwise a request could mint an off-enum CreatorMeeting row plus a
        # provider meeting per novel string, and >20 chars 500'd on the raw
        # Postgres varchar bound.
        meeting_type = resolve_public_meeting_type(kwargs)
        if meeting_type is None:
            return Response(
                status=status.HTTP_404_NOT_FOUND,
                data="Unknown meeting type",
            )
        # The path is a public stream surface. Resolve the owner while they
        # are still active, before constructing a provider client or touching
        # a meeting row; an in-flight request must not start/join a room after
        # the creator has been deactivated.
        get_object_or_404(
            Creator, username=stream_owner, is_active=True
        )
        dc: DyteClient = DyteClient(settings.DYTE_ORG)

        body = MeetingJoinRequestSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        role = body.validated_data.get('role')
        supplied_actor = body.validated_data.get('expected_actor_id')
        if meeting_type == PAY_PER_VIEW and supplied_actor is not None and supplied_actor != request.user.pk:
            # Check the original instruction before inferring a host role:
            # switched cookies must not turn A's viewer join into B's broadcast.
            return Response({'code': 'actor_changed', 'error': 'The signed-in viewer changed. Review the original paid join.'}, status=409)

        # Host intent is explicit now. The creator's own public stream
        # page sends `role: viewer` and is handled below exactly like any
        # other viewer: it can never publish, claim the broadcaster seat,
        # create a room, or rotate the live one. A client that does not say
        # (an old bundle) keeps the legacy inference, but even then a host
        # start cannot take a seat another tab holds.
        is_host_start = (
            request.user.username == stream_owner and role != VIEWER_ROLE
        )

        if is_host_start and not request.user.can_stream:
            return Response(
                status=status.HTTP_400_BAD_REQUEST,
                data="You need at least 150 to go live!"
            )

        logger.info(f"POST to start/join: {request.data}")

        if is_host_start:
            return self._start_or_resume_host(
                request, meeting_type, dc,
                host_session=body.validated_data.get('host_session'),
                takeover=body.validated_data.get('takeover', False),
            )

        # Viewer -- including the creator on their own public stream page.
        # Meeting must exist and be live
        cm = get_object_or_404(
            CreatorMeeting,
            creator__username=stream_owner,
            creator__is_active=True,
            meeting_type=meeting_type,
            is_public=True,
            live_now=True,
        )

        # User must be logged in for these types.
        #
        # The custom permission rejects anonymous POSTs for these paid or
        # entitlement-bearing types before dispatch. Keep this check as
        # defence in depth so a future permission edit cannot silently
        # make either type anonymously joinable.
        if (
            meeting_type in (SUBSCRIBERS_ONLY, PAY_PER_VIEW)
        ) and not request.user.is_authenticated:
            return Response(
                status=status.HTTP_401_UNAUTHORIZED,
                data="You must be logged in to join this meeting",
            )

        # The creator watching their own stream is not buying anything from
        # themselves: the entitlement gates below are for the audience. (The
        # leave webhook never bills the creator's own participant either.)
        is_own_stream = (
            request.user.is_authenticated and cm.creator_id == request.user.pk
        )

        if meeting_type == PAY_PER_VIEW and not is_own_stream:
            from dj.apps.economy.models import EconomicPolicy
            expected_actor = body.validated_data.get('expected_actor_id')
            if (expected_actor is not None and expected_actor != request.user.pk) or (
                    EconomicPolicy.objects.get(pk=True).version == 1 and expected_actor != request.user.pk):
                return Response({'code': 'actor_changed', 'error': 'The signed-in viewer changed. Review the original paid join.'}, status=409)

        # User must be subscribed for subscribers-only
        if meeting_type == SUBSCRIBERS_ONLY and not is_own_stream:
            subs = Subscription.objects.filter(
                star__username=stream_owner,
                fan=request.user,
                expires__gt=timezone.now(),
            )
            if not subs.exists():
                return Response(
                    status=status.HTTP_402_PAYMENT_REQUIRED,
                    data={
                        "code": "subscription_required",
                        "error": "You must be subscribed to join this meeting",
                        "action": "stream_join",
                    },
                )

        compensation_admission = None
        if meeting_type == PAY_PER_VIEW and not is_own_stream:
            # User must have enough tuzis
            price_per_minute = cm.price_per_minute
            # A viewer must reserve 30 minutes of creator fees plus the
            # 15 2Z platform reserve before they are admitted.
            total_price = ppv_join_threshold(price_per_minute)
            if total_price is None:
                return Response(
                    status=status.HTTP_400_BAD_REQUEST,
                    data="This PPV stream has an invalid price",
                )
            if request.user.tuzis < total_price:
                return Response(
                    status=status.HTTP_402_PAYMENT_REQUIRED,
                    data=ledger.insufficient_funds_payload(
                        request.user,
                        total_price,
                        action="stream_join",
                    ),
                )

        if meeting_type == PAY_PER_VIEW and not is_own_stream:
            with transaction.atomic():
                version = pin_supported_policy()
                expected_actor = body.validated_data.get('expected_actor_id')
                if (expected_actor is not None and expected_actor != request.user.pk) or (version == 1 and expected_actor != request.user.pk):
                    return Response({'code': 'actor_changed', 'error': 'The signed-in viewer changed. Review the original paid join.'}, status=409)
                if version == 1:
                    actors = {actor.pk: actor for actor in Creator.objects.select_for_update().filter(
                        pk__in=sorted({cm.creator_id, request.user.pk})).order_by('pk')}
                    viewer = actors.get(request.user.pk)
                    if viewer is None or not viewer.is_active or viewer.kt_account_epoch != request.user.kt_account_epoch:
                        return Response({'code': 'actor_authentication_changed', 'error': 'Viewer authorization changed. Authenticate again.'}, status=409)
                    from dj.apps.economy.products import prepare_livestream_admission
                    try:
                        compensation_admission = prepare_livestream_admission(host_id=cm.creator_id,
                            viewer_id=request.user.pk, meeting_id=cm.meeting_id,
                            price_per_minute=cm.price_per_minute, viewer_account_epoch=request.user.kt_account_epoch)
                    except EconomicRefusal as exc:
                        return Response({'code': str(exc), 'error': 'Paid livestream compensation is unavailable.'}, status=409)
        logger.info(f"Adding Participant! {request.user.username}")
        # role=viewer, always: this branch must never hand out the host
        # preset, whoever the caller is.
        if compensation_admission is not None:
            resp = dc.add_participant(request.user, cm.meeting_id, role=VIEWER_ROLE,
                custom_participant_id=f'ea_{compensation_admission.pk.hex}')
        else:
            resp = dc.add_participant(request.user, cm.meeting_id, role=VIEWER_ROLE)
        # Neither resp.text nor resp.json() may be logged: the success
        # body carries data.token, a bearer credential for joining this
        # meeting, and root logging is INFO in prod. DyteClient.
        # add_participant already logs the outcome without the token.
        #
        # `logger.info("PARTICIPANT ADDED", resp.json())` was also a
        # broken call in its own right -- a positional arg with no %s in
        # the message makes logging raise "not all arguments converted"
        # internally, so it emitted a formatting error, not a log line.
        auth_token = resp.json()['data']['token']

        return Response({
            "meeting_id": cm.meeting_id,
            "auth_token": auth_token,
        })

    def _start_or_resume_host(
        self, request, meeting_type, dc, *, host_session, takeover,
    ):
        """Start the creator's broadcast, or resume the one this tab owns.

        One broadcaster seat per creator:

        * seat free (never taken, released, or its holder stopped
          heartbeating)                 -> this tab takes it and goes live;
        * seat held by THIS host_session -> resume: same room, fresh token, no
          rotation, no price change (a retry or a double click);
        * seat held by another session  -> 409 already_live_elsewhere, and
          nothing is created, joined or rotated -- unless `takeover`, which
          moves the seat here. The previous tab finds out on its next
          heartbeat and leaves the room.

        While the room is live it is never rotated, whichever of these it is:
        a new provider room strands every viewer in the old one.
        """
        creator = request.user
        legacy_client = host_session is None
        if legacy_client:
            # An old bundle that predates the seat. It cannot heartbeat, so
            # its seat simply lapses after HOST_SESSION_TTL -- but while it is
            # fresh it still protects the broadcast from a second tab.
            host_session = uuid.uuid4()

        with transaction.atomic():
            policy_version = pin_supported_policy()
            if meeting_type == PAY_PER_VIEW and policy_version == 1:
                # A host cannot open a paid room before durable per-delivery
                # compensation/reconnect settlement is installed.
                with connection.cursor() as cursor:
                    cursor.execute("SELECT to_regprocedure('economy.settle_service_delivery(uuid,text,bigint,jsonb)')")
                    if cursor.fetchone()[0] is None:
                        return Response({'code': 'livestream_compensation_integration_unavailable',
                            'error': 'Paid livestream compensation is unavailable.'}, status=409)
            _lock_host_seat(creator)
            now = timezone.now()
            held = _held_host_seat(creator)
            held_fresh = _seat_is_fresh(held, now)

            if (
                held_fresh
                and held.host_session_id != host_session
                and not takeover
            ):
                logger.info(
                    "host start refused: seat held creator=%s type=%s",
                    creator.pk, held.meeting_type,
                )
                return _seat_conflict_response(
                    held, code='already_live_elsewhere')

            cm, created = CreatorMeeting.objects.get_or_create(
                creator=creator,
                meeting_type=meeting_type,
                is_public=True,
            )
            # Resuming this tab's own seat, or taking over the live one of the
            # same type: the broadcast continues, so the room and the price
            # its viewers were admitted at stay exactly as they are.
            resumed = held_fresh and held.pk == cm.pk

            # A room with viewers in it keeps the price they were admitted
            # at, whoever is starting it: the leave webhook bills the WHOLE
            # attendance at the row's current price, so a new price on a live
            # room would reprice minutes already watched (a reload, or a
            # lapsed seat, reaches here with `resumed` False).
            if not resumed and (created or not cm.live_now):
                cm.price_per_minute = request.data.get(
                    'price_per_minute', cm.price_per_minute)

            if (
                meeting_type == PAY_PER_VIEW
                and ppv_join_threshold(cm.price_per_minute) is None
            ):
                return Response(
                    status=status.HTTP_400_BAD_REQUEST,
                    data="PPV price must be a positive amount with at most two decimals",
                )

            # Rotate a room over a day old (see _create_meeting and ) --
            # but never one that is live: viewers are in it.
            if created or not cm.meeting_id or (
                not resumed
                and not cm.live_now
                and timezone.now() - cm.created_at > timezone.timedelta(days=1)
            ):
                cm = _create_meeting(cm, dc)

            logger.info(f"Adding Host! {creator.username}")
            resp = dc.add_participant(creator, cm.meeting_id, role=HOST_ROLE)
            d = resp.json()

            # This could probably be removed but we can try one more
            # time if there is a problem?
            error = d.get('error') if isinstance(d, dict) else None
            error_code = error.get('code') if isinstance(error, dict) else None
            if error_code in (404, '404') or getattr(resp, 'status_code', None) == 404:
                # {'success': False, 'error': {'code': 404, 'message': 'No..
                # The provider no longer knows this room, so there is nobody
                # in it to strand: a fresh room is the only way forward.
                # ONLY then: a 429 or a 5xx says nothing about the room, and
                # rotating on it would move the row away from a room full of
                # viewers. Those fall through to the 502 below.
                cm = _create_meeting(cm, dc)
                # try once more
                resp = dc.add_participant(creator, cm.meeting_id, role=HOST_ROLE)

            data = (resp.json() or {}).get('data') or {}
            auth_token = data.get('token')
            if not auth_token:
                # RETURN, never raise. A raise rolls the request back,
                # and with it the fresh `meeting_id` `_create_meeting` just
                # saved -- so the next go-live would retry the stale id and
                # pay for yet another provider meeting. Returning commits it:
                # "at least a new meeting was created", which is usually the
                # fix. Not logging the body: a partial success carries a token.
                #
                # The seat is deliberately NOT taken: this tab is not live.
                logger.error(
                    "Dyte add_participant returned no token for the owner of "
                    "meeting %s", cm.meeting_id,
                )
                return Response(
                    status=status.HTTP_502_BAD_GATEWAY,
                    data="The live-stream provider did not respond; try again.",
                )

            # Free every other row's seat first -- the partial unique
            # constraint allows one holder per creator, and a take-over (or a
            # lapsed seat on another meeting type) is exactly that case.
            # Every eviction still owed, wherever it was parked, travels with
            # the seat so it keeps being retried.
            pending = []
            for row in CreatorMeeting.objects.filter(creator=creator).exclude(
                host_evictions=[],
            ):
                pending.extend(row.host_evictions or [])
            CreatorMeeting.objects.filter(
                creator=creator,
            ).exclude(pk=cm.pk).exclude(
                host_session_id__isnull=True, host_evictions=[],
            ).update(
                host_session_id=None, host_session_seen_at=None,
                host_participant_id='', host_evictions=[],
            )
            # The seat is moving away from another tab (a take-over, or a
            # lapsed seat): retire that tab's host at the provider. A tab that
            # lost our API but not its WebRTC connection would otherwise keep
            # publishing forever -- it never hears the 409 -- and one that has
            # not joined yet would still hold a valid host token.
            if (
                held is not None
                and held.host_session_id != host_session
                and held.host_participant_id
                and held.meeting_id
            ):
                pending.append({
                    'meeting_id': held.meeting_id,
                    'participant_id': held.host_participant_id,
                    'attempts': 0,
                })
            # A retry from the SAME tab minted a new host participant too; the
            # one it replaces is a live credential nobody tracks any more.
            new_participant_id = str(data.get('id') or '')[:128]
            if (
                held is not None
                and held.host_session_id == host_session
                and held.host_participant_id
                and held.host_participant_id != new_participant_id
                and held.meeting_id
            ):
                pending.append({
                    'meeting_id': held.meeting_id,
                    'participant_id': held.host_participant_id,
                    'attempts': 0,
                })
            cm.host_evictions = _retire_hosts(dc, pending, creator)
            cm.host_session_id = host_session
            cm.host_session_seen_at = now
            cm.host_participant_id = new_participant_id
            cm.live_now = True
            # Stamp presence at go-live so the room shows on the public list
            # immediately and is protected by the sweep's grace window until
            # its participants register with the provider.
            cm.last_seen_at = timezone.now()
            cm.save(update_fields=[
                'price_per_minute', 'live_now', 'last_seen_at',
                'host_session_id', 'host_session_seen_at',
                'host_participant_id', 'host_evictions',
            ])

        if held_fresh and held.host_session_id != host_session:
            logger.info(
                "host seat taken over creator=%s from_type=%s to_type=%s",
                creator.pk, held.meeting_type, meeting_type,
            )

        return Response({
            "meeting_id": cm.meeting_id,
            "auth_token": auth_token,
            "host_session": str(host_session),
            "meeting_type": meeting_type,
            "resumed": resumed,
        })


@extend_schema_view(
    get=extend_schema(
        description=(
            "Who holds the caller's broadcaster seat. Owner only. A dashboard "
            "tab reads this on load so a second tab or device shows "
            "\"already live elsewhere\" before anyone presses Go live."
        ),
        responses={200: HostSessionStatusSerializer},
    ),
    post=extend_schema(
        description=(
            "Renew (`heartbeat`) or give up (`release`) the broadcaster seat "
            "this tab holds. Owner only."
        ),
        request=HostSessionActionSerializer,
        responses={
            200: HostSessionStatusSerializer,
            409: OpenApiResponse(
                response=HostSeatConflictSerializer,
                description=(
                    "`host_session_superseded`: another tab or device took "
                    "the seat over. Leave the room."
                ),
            ),
        },
    ),
)
class HostSession(APIView):
    """The caller's broadcaster seat: status, heartbeat, release."""

    permission_classes = [IsAuthenticated]

    def _forbidden(self):
        return Response(
            status=status.HTTP_403_FORBIDDEN,
            data="You can only manage your own broadcast",
        )

    def get(self, request, *args, **kwargs):
        if not is_path_owner(request, kwargs):
            return self._forbidden()
        return Response(_host_seat_status(request.user, timezone.now()))

    def post(self, request, *args, **kwargs):
        if not is_path_owner(request, kwargs):
            return self._forbidden()
        body = HostSessionActionSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        host_session = body.validated_data['host_session']
        action = body.validated_data['action']
        creator = request.user

        with transaction.atomic():
            _lock_host_seat(creator)
            now = timezone.now()
            mine = CreatorMeeting.objects.filter(
                creator=creator, host_session_id=host_session,
            )
            if action == 'release':
                # Retire the released host too before forgetting it: its
                # token outlives the page, and the page's own room cleanup
                # may not have finished (or may fail). Anything the provider
                # does not confirm stays queued on the row and travels with
                # the next seat.
                released = mine.first()
                if released is not None:
                    pending = list(released.host_evictions or [])
                    if released.host_participant_id and released.meeting_id:
                        pending.append({
                            'meeting_id': released.meeting_id,
                            'participant_id': released.host_participant_id,
                            'attempts': 0,
                        })
                    released.host_evictions = _retire_hosts(
                        DyteClient(settings.DYTE_ORG), pending, creator)
                    released.host_session_id = None
                    released.host_session_seen_at = None
                    released.host_participant_id = ''
                    released.save(update_fields=[
                        'host_evictions', 'host_session_id',
                        'host_session_seen_at', 'host_participant_id',
                    ])
                return Response(_host_seat_status(creator, now))

            # heartbeat. Renewing a seat that lapsed but that nobody else took
            # is fine -- the tab is evidently still here. Only a seat someone
            # else now holds is lost.
            if not mine.update(host_session_seen_at=now):
                return _seat_conflict_response(
                    _held_host_seat(creator), code='host_session_superseded')
            # Keep retiring any previous host the provider has not confirmed.
            held = mine.first()
            if held is not None and held.host_evictions:
                held.host_evictions = _retire_hosts(
                    DyteClient(settings.DYTE_ORG), held.host_evictions, creator)
                # Re-stamp AFTER the provider calls: slow retirements must not
                # commit a heartbeat that already looks lapsed, or another
                # device's plain Go live would take the seat from a tab that
                # is still broadcasting (PR  review).
                now = timezone.now()
                held.host_session_seen_at = now
                held.save(update_fields=[
                    'host_evictions', 'host_session_seen_at'])
            return Response(_host_seat_status(creator, now))
