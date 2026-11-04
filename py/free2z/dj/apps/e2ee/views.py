"""Contract A (free2z/zuu#1022): the paid chat-request API.

The money path is deliberately NOT new. The charge is
``dj.apps.tuzis.ledger.transfer`` -- the same atomic sender-debit /
recipient-credit ``donate-idempotent`` uses -- and retry safety is the same
``IdempotencyKey`` claim, replay and release helpers, imported from
``dj.apps.tuzis.views`` rather than copied, so the two paid routes cannot
drift apart on what a replay, an in-flight duplicate or a reused key means.
"""
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from dj.apps.events.models import Event
from dj.apps.g12f.blocks import has_blocked
from dj.apps.g12f.models import Creator
from dj.apps.tuzis import ledger
from dj.apps.tuzis import models as idempotency
from dj.apps.tuzis.serializers import (
    CreditErrorSerializer,
    InsufficientFundsErrorSerializer,
)
from dj.apps.tuzis.views import (
    CONFIRMED_IDEMPOTENCY_KEY_PARAMETER,
    SERVER_ONLY_RECEIPT_FIELDS,
    _claim,
    _credit_error,
    _idempotency_key,
    _replay_when_target_moved,
    _stored_response,
)

from .handles import resolve_messaging_handle
from .models import ChatRequest
from .serializers import (
    ChatRequestBodySerializer,
    ChatRequestPriceSerializer,
    ChatRequestRateLimitedSerializer,
    ChatRequestResultSerializer,
)
from .tasks import enqueue_chat_request_email

#IdempotencyKey scope. A key spent here is spent here only; it is listed in
#tuzis' cleanup_idempotency EXPIRING_SCOPES so receipts expire on the same
#published horizon as donate-idempotent.
CHAT_REQUEST_SCOPE = "e2ee-chat-request"
#The `action` in a 402 body, and the ledger's action label.
CHAT_REQUEST_ACTION = "encrypted_chat_request"
EVENT_TYPE = "ENCRYPTED_CHAT_REQUEST"


class SenderHandleUnavailable(Exception):
    pass


class PriceChanged(Exception):
    def __init__(self, current):
        super().__init__(f"price is now {current}")
        self.current = current


class RateLimited(Exception):
    def __init__(self, retry_after: int):
        super().__init__(f"rate limited for {retry_after}s")
        self.retry_after = retry_after


def chat_request_cost():
    """The server-set price, as the ledger's Decimal."""
    return ledger.to_tuzis(settings.E2EE_CHAT_REQUEST_COST)


def _window_retry_after(queryset, window: timedelta, limit: int, now):
    """Seconds until ``queryset`` holds fewer than ``limit`` rows in ``window``.

    Returns 0 when there is room now.
    """
    since = now - window
    recent = list(
        queryset.filter(created_at__gt=since)
        .order_by("-created_at")
        .values_list("created_at", flat=True)[:limit]
    )
    if len(recent) < limit:
        return 0
    # The `limit`-th newest row is the one that has to age out.
    frees_at = recent[-1] + window
    return max(1, int((frees_at - now).total_seconds()) + 1)


def check_rate_limit(sender, recipient, now=None) -> None:
    """Raise ``RateLimited`` if one more request would exceed a window.

    Counted from ``ChatRequest`` rows, not a cache, and called with the
    sender's Creator row locked (``ledger.lock_in_order``): two concurrent
    requests from one sender are serialized on that lock, so the second one
    counts the first and the limit is exact rather than approximately
    enforced. A refused request moves no 2Z.
    """
    now = now or timezone.now()
    by_sender = ChatRequest.objects.filter(sender_id=sender.pk)
    by_pair = by_sender.filter(recipient_id=recipient.pk)
    windows = (
        (by_sender, timedelta(hours=1),
         settings.E2EE_CHAT_REQUEST_SENDER_HOURLY_LIMIT),
        (by_sender, timedelta(days=1),
         settings.E2EE_CHAT_REQUEST_SENDER_DAILY_LIMIT),
        (by_pair, timedelta(days=1),
         settings.E2EE_CHAT_REQUEST_PAIR_DAILY_LIMIT),
    )
    retry_after = max(
        _window_retry_after(queryset, window, limit, now)
        for queryset, window, limit in windows
    )
    if retry_after:
        raise RateLimited(retry_after)


def chat_requests_enabled() -> bool:
    return bool(settings.E2EE_CHAT_REQUESTS_ENABLED)


def _disabled():
    # Deliberately NOT "nothing was charged": during a rollout that flips the
    # switch, an enabled pod may still be about to commit a request sent
    # earlier under this same key, and its claim may not be visible yet. What
    # is true is that THIS attempt charged nothing -- so keep the key.
    return _credit_error(
        "chat_requests_disabled",
        "Encrypted chat requests are switched off right now. This attempt "
        "charged nothing; keep the same Idempotency-Key and try again later.",
        status.HTTP_503_SERVICE_UNAVAILABLE,
    )


def _switched_off_answer(sender, key, request_hash):
    """What a switched-off route answers for this key. Reads only.

    "Disabled, nothing charged" is only true when this key has no request
    that may still commit. So, before saying it:

    * a COMPLETED request for this key replays (200), because it charged;
    * an UNFINISHED claim that is not provably abandoned answers
      `request_in_progress` (409): during a rollout an enabled pod may be
      committing it right now, and a client told "nothing charged" could
      retire the key and pay again under a new one;
    * only then is it 503 `chat_requests_disabled`.

    Nothing is claimed, released or taken over here.
    """
    record = (
        idempotency.IdempotencyKey.objects.filter(
            scope=CHAT_REQUEST_SCOPE, user=sender, key=key,
        )
        .first()
    )
    if record is not None and record.response_status is None:
        abandoned = (
            timezone.now() - record.created_at > idempotency.STALE_CLAIM
        )
        if not abandoned:
            return _credit_error(
                "request_in_progress",
                "The original request is still in progress.",
                status.HTTP_409_CONFLICT,
            )
    elif (
        record is not None
        and record.request_hash == request_hash
        and isinstance(record.response_body, dict)
    ):
        replay = {
            name: value
            for name, value in record.response_body.items()
            if name not in SERVER_ONLY_RECEIPT_FIELDS
        }
        replay["replayed"] = True
        return Response(replay, status=record.response_status)
    return _disabled()


def _recipient_not_found():
    return _credit_error(
        "recipient_not_found",
        "Recipient not found.",
        status.HTTP_404_NOT_FOUND,
    )


class ChatRequestPriceView(APIView):
    """The server-set price of one encrypted chat request."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        responses={200: ChatRequestPriceSerializer},
        description=(
            "Whole 2Z charged by POST /api/e2ee/chat-requests/{username}/. "
            "Set by the server; the client never supplies an amount. "
            "`enabled: false` means new requests are switched off and the "
            "POST will answer 503 `chat_requests_disabled`."
        ),
    )
    def get(self, request, *args, **kwargs):
        return Response({
            "cost": int(chat_request_cost()),
            "enabled": chat_requests_enabled(),
        })


class ChatRequestView(APIView):
    """Pay to ask another account to start an encrypted chat in e2e2z."""

    # The claim must commit before the money transaction begins (same reason
    # as IdempotentDonate2Z): a duplicate then sees `request_in_progress`
    # instead of blocking on the original's uncommitted unique-index entry.
    atomic_request = False
    permission_classes = [IsAuthenticated]

    @extend_schema(
        parameters=[CONFIRMED_IDEMPOTENCY_KEY_PARAMETER],
        request=ChatRequestBodySerializer,
        responses={
            200: ChatRequestResultSerializer,
            400: CreditErrorSerializer,
            402: InsufficientFundsErrorSerializer,
            404: CreditErrorSerializer,
            409: OpenApiResponse(
                CreditErrorSerializer,
                description=(
                    "`self_request`: you cannot send a chat request to "
                    "yourself. `price_changed`: `expected_cost` was sent and "
                    "differs from the current price (in `current_price`); "
                    "nothing was charged. Also the shared idempotency answers "
                    "`request_in_progress`, `idempotency_mismatch` and "
                    "`invalid_idempotency_record`."
                ),
            ),
            422: OpenApiResponse(
                CreditErrorSerializer,
                description=(
                    "`sender_handle_unavailable`: your account has no "
                    "messaging handle yet, so there is no one for the "
                    "recipient to reply to. Nothing was charged."
                ),
            ),
            429: ChatRequestRateLimitedSerializer,
            503: OpenApiResponse(
                CreditErrorSerializer,
                description=(
                    "`chat_requests_disabled`: new chat requests are "
                    "switched off. THIS attempt charged nothing and took no "
                    "key. It is not proof that an earlier attempt under the "
                    "same key did not charge (one may still be committing on "
                    "another server), so keep the key and retry it later. A "
                    "key whose request already COMPLETED replays with 200, "
                    "and one with a visible unfinished request answers 409 "
                    "`request_in_progress`."
                ),
            ),
        },
        description=(
            "Charge the server-set price (GET "
            "/api/e2ee/chat-requests/price/) from the caller and credit it "
            "to the recipient, atomically, and notify the recipient with an "
            "ENCRYPTED_CHAT_REQUEST event whose content_url opens e2e2z's "
            "first-contact screen for the caller's handle (the caller gets a "
            "read ENCRYPTED_CHAT_REQUEST row of their own, with no link, as "
            "the record of the spend). No message is "
            "sent. The Idempotency-Key is bound to the recipient; a replay "
            "returns the original result with `replayed: true` and never "
            "charges twice. Completed results replay for "
            f"{idempotency.COMPLETED_CLAIM_RETENTION.days} days. Refusals "
            "(402, 404, 409 price_changed, 422, 429, 503) charge nothing and "
            "release (or never take) the key. Rate "
            "limits, per sender: "
            f"{settings.E2EE_CHAT_REQUEST_SENDER_HOURLY_LIMIT} per hour, "
            f"{settings.E2EE_CHAT_REQUEST_SENDER_DAILY_LIMIT} per 24 hours, "
            f"and {settings.E2EE_CHAT_REQUEST_PAIR_DAILY_LIMIT} per 24 hours "
            "to the same recipient."
        ),
    )
    def post(self, request, *args, **kwargs):
        sender: Creator = request.user
        key = _idempotency_key(request)
        if key is None:
            return _credit_error(
                "idempotency_key_required",
                "A valid UUIDv4 Idempotency-Key header is required.",
                status.HTTP_400_BAD_REQUEST,
            )

        body_serializer = ChatRequestBodySerializer(data=request.data)
        if not body_serializer.is_valid():
            return _credit_error(
                "invalid_request",
                "expected_cost must be a whole number of 2Z.",
                status.HTTP_400_BAD_REQUEST,
            )
        expected_cost = body_serializer.validated_data.get("expected_cost")

        target_username = kwargs.get("username")
        unresolved_fingerprint = idempotency.fingerprint({
            "recipient_username": target_username,
            "action": CHAT_REQUEST_ACTION,
        })
        recipient = Creator.objects.filter(username=target_username).first()
        if recipient is None:
            # The recipient may have renamed since a request this key already
            # completed; replay that instead of answering 404 to a retry.
            replay = _replay_when_target_moved(
                CHAT_REQUEST_SCOPE, sender, key, unresolved_fingerprint)
            if replay is not None:
                return replay
            if not chat_requests_enabled():
                return _disabled()
            return _recipient_not_found()
        if recipient.pk == sender.pk:
            if not chat_requests_enabled():
                return _disabled()
            return _credit_error(
                "self_request",
                "You cannot send a chat request to yourself.",
                status.HTTP_409_CONFLICT,
            )

        # The price is deliberately NOT part of the fingerprint: the client
        # never sends one, so a retry after a price change is still the same
        # request, and replaying what it originally charged is the truth.
        request_hash = idempotency.fingerprint({
            "recipient": str(recipient.pk),
            "recipient_username": target_username,
            "action": CHAT_REQUEST_ACTION,
        })
        if not chat_requests_enabled():
            # Checked BEFORE the claim: a switched-off request consumes no key.
            return _switched_off_answer(sender, key, request_hash)
        claim, duplicate_response = _claim(
            CHAT_REQUEST_SCOPE, sender, key, request_hash,
        )
        if duplicate_response is not None:
            return duplicate_response

        # Everything below either finishes the claim inside the money
        # transaction or releases it. Checked after the claim so a replay of
        # a completed request is never refused by a later state change.
        if not recipient.is_active:
            idempotency.release(claim)
            return _recipient_not_found()
        try:
            # A recipient who blocked the sender is answered exactly like one
            # who does not exist: nothing is charged, no event is
            # created, and the blocked account cannot use this endpoint to
            # learn of the block. Inside the release boundary, like every
            # other read after the claim.
            if has_blocked(recipient.pk, sender.pk):
                idempotency.release(claim)
                return _recipient_not_found()
            # Inside the release boundary: a database error here must not
            # strand the committed claim as `request_in_progress`.
            sender_handle, _ = resolve_messaging_handle(sender)
            if sender_handle is None:
                raise SenderHandleUnavailable()
            recipient_handle, recipient_handle_status = (
                resolve_messaging_handle(recipient)
            )
            cost = chat_request_cost()
            # Checked AFTER the claim, so a replay of a completed request is
            # still a replay whatever the price is now.
            if expected_cost is not None and cost != expected_cost:
                raise PriceChanged(cost)
            with transaction.atomic():
                ledger.lock_in_order(sender, recipient)
                check_rate_limit(sender, recipient)
                ledger.transfer(
                    sender, recipient, cost, action=CHAT_REQUEST_ACTION,
                )
                chat_request = ChatRequest.objects.create(
                    sender=sender,
                    recipient=recipient,
                    sender_handle=sender_handle,
                    charged=cost,
                )
                Event.objects.create(
                    type=EVENT_TYPE,
                    receiving_user=recipient,
                    contributor=sender,
                    payee=recipient,
                    amount=cost,
                    content_object=chat_request,
                )
                # The payer's own record of the spend, like DONATION_SENT:
                # already read (no badge), and no content object, so it links
                # nowhere -- the chat link names the SENDER's handle and is
                # only meaningful to the recipient.
                Event.objects.create(
                    type=EVENT_TYPE,
                    receiving_user=sender,
                    contributor=sender,
                    payee=recipient,
                    amount=cost,
                    read=True,
                )
                enqueue_chat_request_email(chat_request.pk)
                body = {
                    "balance": str(sender.tuzis),
                    "charged": str(cost),
                    "replayed": False,
                    "request_id": str(chat_request.pk),
                    "recipient": {
                        "username": recipient.username,
                        "handle": recipient_handle,
                        "handle_status": recipient_handle_status,
                    },
                }
                claim.finish(
                    status.HTTP_200_OK,
                    _stored_response(body, unresolved_fingerprint),
                )
        except PriceChanged as changed:
            idempotency.release(claim)
            return _credit_error(
                "price_changed",
                "The price of a chat request has changed.",
                status.HTTP_409_CONFLICT,
                current_price=str(int(changed.current)),
            )
        except SenderHandleUnavailable:
            idempotency.release(claim)
            return _credit_error(
                "sender_handle_unavailable",
                "Your account needs a messaging handle before you can "
                "start an encrypted chat.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        except RateLimited as limited:
            idempotency.release(claim)
            response = Response(
                {
                    "code": "rate_limited",
                    "error": "Too many chat requests. Try again later.",
                    "retry_after": limited.retry_after,
                },
                status=status.HTTP_429_TOO_MANY_REQUESTS,
            )
            response["Retry-After"] = str(limited.retry_after)
            return response
        except ledger.InsufficientFunds as exc:
            idempotency.release(claim)
            return Response(
                ledger.insufficient_funds_payload(
                    exc, action=CHAT_REQUEST_ACTION),
                status=status.HTTP_402_PAYMENT_REQUIRED,
            )
        except ledger.InactiveCreator:
            idempotency.release(claim)
            return _recipient_not_found()
        except Exception:
            idempotency.release(claim)
            raise

        return Response(body)
