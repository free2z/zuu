import base64
import hashlib
from decimal import Decimal, InvalidOperation
import binascii
from io import BytesIO
import json
import logging
import os
import time
import uuid
from datetime import datetime, time as datetime_time, timedelta, timezone as datetime_timezone

from PIL import Image

from django.conf import settings
from django.core.exceptions import PermissionDenied
from django.core.files.base import ContentFile
from django.core.signing import Signer
from django.utils.text import slugify
from django.utils import timezone
from django.contrib.contenttypes.models import ContentType
from django.db import transaction
from django.db.models import Q, Prefetch
from django.shortcuts import get_object_or_404

from dj.free2z.pagination import Free2zPagination
from rest_framework.response import Response
from rest_framework import serializers
from rest_framework.permissions import (
    AllowAny, IsAuthenticated, IsAuthenticatedOrReadOnly
)
from rest_framework import views, status
from rest_framework.exceptions import ParseError
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.renderers import JSONRenderer
from django_filters.rest_framework import DjangoFilterBackend
from drf_spectacular.extensions import OpenApiSerializerExtension
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    PolymorphicProxySerializer,
    extend_schema,
)

# The top-level `openai` SDK, not this app (`dj.apps.openai`): absolute imports
# resolve against sys.path, where only `py/` lives -- same as f2z/openai/util.py.
from openai import BadRequestError as OpenAIBadRequestError
from openai import APIStatusError as OpenAIAPIStatusError

from f2z.ai.providers import (
    EmptyCompletion, complete_prompt, flat_price_prompt_error,
    prompt_completion_model,
)
from f2z.openai.util import get_web_request_openai_client

from dj.apps.uploads.models import GenericFile, UPLOAD_STORAGE_ALIAS, Webp
from dj.apps.events.models import Event
from dj.apps.tuzis import ledger
from dj.apps.tuzis import models as idempotency

from .models import (
    MIN_REQUEST_OUTPUT_TOKENS, AIModel, Conversation, GenerationInterrupted,
    PromptResponse,
    Personality, count_prompt_tokens, generate_reply, num_tokens_from_messages,
)
from .permissions import IsConversationOwner, valid_uuid
from .visibility import (
    public_conversation_q as _public_conversation_q,
    public_personality_q as _public_personality_q,
)
from .serializers import (
    AIModelSerializer, ConversationDetailSerializer, ConversationSerializer, PromptResponseSerializer,
    AIPersonalitySerializer
)
from dj.apps.tuzis.serializers import InsufficientFundsErrorSerializer

# Web-request budget, no SDK retry: see get_web_request_openai_client.
oai_client = get_web_request_openai_client()

logger = logging.getLogger(__name__)

# Product minimum to start a chat. NOT the admission test -- that is derived
# per model from the assembled prompt plus the reply length this request asked
# for, see PromptResponseViewSet.create STEP 0. This constant only keeps the
# historical entry bar in place.
MIN_CHAT_TUZIS = 100

# Upper bound on the `max_output_tokens` a request body may name. It is a
# sanity bound on the JSON, not the policy: the real ceiling is per model
# (`AIModel.get_request_output_cap`), which clamps anything larger down to what
# that model and the remaining context window can actually deliver. This only
# stops a 10**50 landing in an int32 column's arithmetic, and gives the OpenAPI
# schema an honest `maximum`.
MAX_REQUESTABLE_OUTPUT_TOKENS = 1000000


def _creator_prompt_quote_token(
        ai_model, prompt, system_message, requested_output, input_tokens,
        window_tokens, output_cap, max_price):
    """Bind a displayed maximum hold to the exact live model and prompt."""
    payload = {
        "id": str(ai_model.pk),
        "provider": ai_model.provider,
        "model": ai_model.model,
        "display_name": ai_model.display_name,
        "destination": PROVIDER_DISPLAY_NAMES.get(
            ai_model.provider, "the selected AI provider",
        ),
        "privacy_policy_url": PROVIDER_PRIVACY_URLS.get(
            ai_model.provider, "/docs/legal/privacy-policy/",
        ),
        "retention_disclosure": "provider-policy-v1",
        "input_price": str(ai_model.input_price),
        "output_price": str(ai_model.output_price),
        "markup": str(ai_model.markup),
        "prompt": prompt,
        "system_message": system_message,
        "requested_output": requested_output,
        "input_tokens": input_tokens,
        "window_tokens": window_tokens,
        "output_cap": output_cap,
        "max_price": max_price,
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _creator_model_intent_snapshot(ai_model):
    """Fields that must stay fixed while one provider request is unresolved."""
    if ai_model is None:
        return None
    return {
        "choice": str(ai_model.pk),
        "provider": ai_model.provider,
        "model": ai_model.model,
        "display_name": ai_model.display_name,
        "destination": PROVIDER_DISPLAY_NAMES.get(
            ai_model.provider, "the selected AI provider",
        ),
        "privacy_policy_url": PROVIDER_PRIVACY_URLS.get(
            ai_model.provider, "/docs/legal/privacy-policy/",
        ),
        "retention_disclosure": "provider-policy-v1",
        "system_message": ai_model.system_message,
        "input_price": str(ai_model.input_price),
        "output_price": str(ai_model.output_price),
        "markup": str(ai_model.markup),
    }


def _cover_choice_snapshot(choice_id="openai-image"):
    """Return the current server-owned cover disclosure, or no option."""
    if choice_id == "fal-flux-schnell":
        from . import hosted_image
        try:
            hosted_image.configuration()
        except hosted_image.ImageProviderUnavailable:
            return None
        return {
            "id": choice_id, "provider": hosted_image.PROVIDER,
            "model": hosted_image.MODEL, "display_name": hosted_image.MODEL_VERSION,
            "destination": "fal", "privacy_policy_url": "https://fal.ai/legal/privacy-policy",
            "price_basis": "fixed", "price_2z": IMAGE_COST,
            "retention_disclosure": "provider-policy-v1",
        }
    if choice_id != "openai-image":
        return None
    model = settings.OPENAI_IMAGE_MODEL
    if oai_client is None or not isinstance(model, str) or not model.strip():
        return None
    return {
        "id": "openai-image",
        "provider": "openai",
        "model": model,
        "display_name": model,
        "destination": PROVIDER_DISPLAY_NAMES["openai"],
        "privacy_policy_url": PROVIDER_PRIVACY_URLS["openai"],
        "price_basis": "fixed",
        "price_2z": IMAGE_COST,
        "retention_disclosure": "provider-policy-v1",
    }


def _cover_choice_snapshot_token(snapshot):
    return Signer(salt="free2z.creator-ai-cover-disclosure.v1").sign_object(
        snapshot, compress=True,
    )

IMAGE_COST = 6
IMAGE_QUALITY = "medium"
IMAGE_SIZES = ("1024x1024", "1536x1024", "1024x1536")

# Creator-facing disclosures. These describe the first-party route and link to
# each provider's public privacy terms; they are not claims about provider
# retention settings that Free2z cannot independently enforce.
PROVIDER_PRIVACY_URLS = {
    "anthropic": "https://www.anthropic.com/legal/privacy",
    "openai": "https://openai.com/policies/privacy-policy/",
    "xai": "https://x.ai/legal/privacy-policy/",
    "kimi": "https://www.moonshot.ai/privacy-policy",
}
PROVIDER_DISPLAY_NAMES = {
    "anthropic": "Anthropic",
    "openai": "OpenAI",
    "xai": "xAI",
    "kimi": "Kimi (Moonshot)",
}


class CreatorPromptQuoteSerializer(serializers.Serializer):
    model = serializers.UUIDField()
    prompt = serializers.CharField(trim_whitespace=False)
    system_message = serializers.CharField(
        required=False, allow_null=True, allow_blank=True, trim_whitespace=False,
    )
    max_output_tokens = serializers.IntegerField(
        required=False, min_value=1, max_value=MAX_REQUESTABLE_OUTPUT_TOKENS,
        default=256,
    )


class CreatorAIChoiceSerializer(serializers.Serializer):
    id = serializers.CharField()
    provider = serializers.CharField()
    model = serializers.CharField()
    display_name = serializers.CharField()
    destination = serializers.CharField()
    privacy_policy_url = serializers.CharField()
    price_basis = serializers.ChoiceField(choices=("fixed", "metered"))
    price_2z = serializers.IntegerField(required=False)
    snapshot_token = serializers.CharField(required=False)
    availability = serializers.CharField()
    queue = serializers.CharField()


class CreatorAIOptionsResponseSerializer(serializers.Serializer):
    cover = CreatorAIChoiceSerializer(many=True)
    completion = CreatorAIChoiceSerializer(many=True)


class CreatorPromptQuoteResponseSerializer(serializers.Serializer):
    choice = CreatorAIChoiceSerializer()
    model = serializers.UUIDField()
    max_output_tokens = serializers.IntegerField()
    requested_output_tokens = serializers.IntegerField()
    max_charge_2z = serializers.IntegerField()
    quote_token = serializers.CharField()
    availability = serializers.CharField()
    queue = serializers.CharField()


def _creator_text_choice(model):
    """The exact provider disclosure accompanying a catalogue row or quote."""
    return {
        "id": str(model.pk),
        "provider": model.provider,
        "model": model.model,
        "display_name": model.display_name,
        "destination": PROVIDER_DISPLAY_NAMES.get(
            model.provider, "the selected AI provider",
        ),
        "privacy_policy_url": PROVIDER_PRIVACY_URLS.get(
            model.provider, "/docs/legal/privacy-policy/",
        ),
        "price_basis": "metered",
        "availability": "Configured; checked again at submission.",
        "queue": "Processed synchronously; no queue position or SLA.",
    }


class CreatorAIOptionsView(views.APIView):
    """Server-authoritative choices and a quote for creator AI operations."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses=CreatorAIOptionsResponseSerializer)
    def get(self, request):
        completion = []
        for model in AIModel.objects.selectable().filter(
            input_price__gt=0, output_price__gt=0,
        ).order_by("-order", "display_name"):
            completion.append(_creator_text_choice(model))

        cover = []
        for choice_id in ("openai-image", "fal-flux-schnell"):
            cover_snapshot = _cover_choice_snapshot(choice_id)
            if cover_snapshot is not None:
                cover.append({
                    **cover_snapshot,
                    "snapshot_token": _cover_choice_snapshot_token(cover_snapshot),
                    "availability": "Configured; checked again at submission.",
                    "queue": ("Processed via the provider queue; no queue position or SLA."
                              if choice_id == "fal-flux-schnell" else
                              "Processed synchronously; no queue position or SLA."),
                })
        return Response({"cover": cover, "completion": completion})

    @extend_schema(
        request=CreatorPromptQuoteSerializer,
        responses={
            200: CreatorPromptQuoteResponseSerializer,
            400: OpenApiResponse(description="Prompt is invalid or too long."),
            409: OpenApiResponse(description="Selected model is no longer available."),
        },
    )
    def post(self, request):
        """Quote the maximum hold for the exact text prompt and selected model."""
        body = CreatorPromptQuoteSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        model_id = body.validated_data["model"]
        prompt = body.validated_data["prompt"]
        requested_output = body.validated_data["max_output_tokens"]
        system_message = body.validated_data.get("system_message")
        model = AIModel.objects.selectable().filter(
            pk=model_id, input_price__gt=0, output_price__gt=0,
        ).first()
        if model is None:
            return Response(
                {"detail": "This text model is no longer available."},
                status=status.HTTP_409_CONFLICT,
            )
        if system_message is None:
            system_message = model.system_message
        messages = []
        if system_message:
            messages.append({"role": "system", "content": system_message})
        messages.append({"role": "user", "content": prompt})
        try:
            # Match MeteredPromptView's model-specific billing tokenizer.
            input_tokens = num_tokens_from_messages(messages, model.model)
            window_tokens = count_prompt_tokens(messages, model.model)
        except Exception as exc:
            return _ai_error_response(exc, model_label=str(model))
        if window_tokens > model.get_input_token_budget():
            return Response(
                {"detail": "This prompt is too long for the selected model."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        output_cap = model.get_request_output_cap(window_tokens, requested_output)
        max_price = model.get_admission_price(input_tokens, output_cap)
        return Response({
            "model": str(model.pk),
            "max_output_tokens": output_cap,
            "requested_output_tokens": requested_output,
            "max_charge_2z": max_price,
            "choice": _creator_text_choice(model),
            "quote_token": _creator_prompt_quote_token(
                model, prompt, system_message, requested_output, input_tokens,
                window_tokens, output_cap, max_price,
            ),
            "availability": "Configured; checked again during generation.",
            "queue": "Processed synchronously; no queue position or SLA.",
        })


PROVIDER_IDEMPOTENCY_PARAMETER = OpenApiParameter(
    name="Idempotency-Key",
    type={"type": "string", "format": "uuid", "minLength": 36, "maxLength": 36},
    location=OpenApiParameter.HEADER,
    required=False,
    description="Optional UUIDv4 operation key. Reuse it only to retry the exact same provider request.",
)

IMAGE_IDEMPOTENCY_PARAMETER = OpenApiParameter(
    name="Idempotency-Key",
    type={"type": "string", "format": "uuid", "minLength": 36, "maxLength": 36},
    location=OpenApiParameter.HEADER,
    required=False,
    description=(
        "Optional UUIDv4 operation key for OpenAI image generation; required "
        "when hosted fal is selected. It is scoped to the authenticated actor "
        "and exact image intent (provider, model, prompt, size, and choice "
        "disclosure). A present non-UUIDv4 value is refused with 400 "
        "idempotency_key_required before a receipt, charge, or provider call. "
        "A different intent under a used key is refused with 409 "
        "idempotency_mismatch; an unresolved live claim returns 409 "
        "request_in_progress. Reuse the key only for an identical request. "
        "An OpenAI request is retried only when its durable receipt proves "
        "dispatch never started. If OpenAI acceptance is uncertain, its "
        "authorization hold is retained and it is not automatically "
        "resubmitted; start a new intent only after an explicit user action."
    ),
)

PROVIDER_GENERATION_MODEL_PARAMETER = OpenApiParameter(
    name="X-AI-Generation-Model",
    type={"type": "string", "format": "uuid", "minLength": 36, "maxLength": 36},
    location=OpenApiParameter.HEADER,
    required=False,
    description=(
        "Optional legacy receipt discriminator. On retries of a chat whose "
        "stored receipt includes a model id, provide that original id so the "
        "server can replay the response after the conversation model changes. "
        "This header never selects the model for a new generation."
    ),
)


def _provider_claim(
        request, scope, payload, *, replay_field=None, intent_snapshot=None,
        allow_stale_takeover=True, stale_takeover_requires_matching_hash=False,
        legacy_payloads=(), initial_body=None, key_override=None,
        resolve_stale_unfinished=None):
    """Claim a provider operation before making an externally billed call.

    Fixed-cost provider operations add their own short authorization hold
    around this claim. The hold is settled with the local result or released
    on failure; provider I/O never runs while a database lock is held.
    """
    key = key_override if key_override is not None else idempotency.request_key(request)
    if request.headers.get("Idempotency-Key") is None and key_override is None:
        return None, None
    if key is None:
        return None, Response(
            {
                "code": "idempotency_key_required",
                "error": "A valid UUIDv4 Idempotency-Key header is required.",
            },
            status=status.HTTP_400_BAD_REQUEST,
        )
    request_hash = idempotency.fingerprint(payload)
    legacy_hashes = {
        idempotency.fingerprint(legacy_payload)
        for legacy_payload in legacy_payloads
    }
    claim_body = initial_body or {"operation": scope, "state": "provider_pending"}
    if intent_snapshot is not None:
        claim_body = {**claim_body, "_provider_intent_snapshot": intent_snapshot}
    prior_record = None
    if resolve_stale_unfinished is not None:
        prior_record = idempotency.IdempotencyKey.objects.filter(
            scope=scope, user=request.user, key=key,
        ).first()

    def mismatch_response():
        return None, Response(
            {"code": "idempotency_mismatch", "error": "This idempotency key was already used for a different request."},
            status=status.HTTP_409_CONFLICT,
        )

    if (
        resolve_stale_unfinished is not None
        and prior_record is not None
        and prior_record.response_status is None
        and prior_record.request_hash is None
    ):
        if timezone.now() - prior_record.created_at > idempotency.STALE_CLAIM:
            return mismatch_response()
        return None, Response(
            {"code": "request_in_progress", "error": "The original provider operation is still being resolved."},
            status=status.HTTP_409_CONFLICT,
        )

    def duplicate_response(duplicate):
        if duplicate.in_flight:
            return None, Response(
                {"code": "request_in_progress", "error": "The original provider operation is still being resolved."},
                status=status.HTTP_409_CONFLICT,
            )
        body = duplicate.record.response_body
        if not isinstance(body, dict):
            return None, Response(
                {"code": "invalid_idempotency_record", "error": "The original response could not be replayed safely."},
                status=status.HTTP_409_CONFLICT,
            )
        if (
            scope == "ai_image"
            and body.get("key_resolved") is True
            and body.get("credit_reservation_state") != "unknown"
            and key is not None
        ):
            # A terminalized stale image claim can still own an authorization
            # hold if its worker died after reservation. Release that exact
            # hold once the stale claim has been resolved.
            reservation = _image_reservation(request.user, key)
            if reservation is not None:
                ledger.release_reservation(reservation)
        replay = {k: v for k, v in body.items() if not k.startswith("_")}
        if replay_field is not None and replay_field in replay:
            replay = replay[replay_field]
        return None, Response(replay, status=duplicate.record.response_status)

    def finish_or_return(claim, *, previous_record=None):
        if resolve_stale_unfinished is None or not getattr(
            claim, "stale_takeover", False,
        ):
            return claim, None
        previous_record = previous_record or prior_record
        resolved = resolve_stale_unfinished(
            claim, previous_record=previous_record,
        )
        if resolved is False:
            # The generic claim API has already fenced the old owner. Restore
            # the exact old token and timestamp when image provenance proves
            # this is not one of our compatible provider intents.
            if previous_record is not None:
                idempotency.IdempotencyKey.objects.filter(
                    pk=claim.pk, owner=claim.owner,
                    response_status__isnull=True,
                ).update(
                    owner=previous_record.owner,
                    created_at=previous_record.created_at,
                    request_hash=previous_record.request_hash,
                )
            return mismatch_response()
        if resolved is not None:
            return None, resolved
        return claim, None

    try:
        claim = idempotency.claim(
            scope,
            request.user,
            key,
            request_hash=request_hash,
            initial_body=claim_body,
            allow_stale_takeover=allow_stale_takeover,
            stale_takeover_requires_matching_hash=(
                stale_takeover_requires_matching_hash
            ),
        )
        return finish_or_return(claim)
    except idempotency.IdempotencyConflict as conflict:
        record = conflict.record
        if record.response_status is not None and record.request_hash in legacy_hashes:
            body = record.response_body
            if isinstance(body, dict):
                replay = {k: v for k, v in body.items() if not k.startswith("_")}
                if replay_field is not None and replay_field in replay:
                    replay = replay[replay_field]
                return None, Response(replay, status=record.response_status)
        if (
            scope != "ai_image"
            or resolve_stale_unfinished is None
            or record.response_status is not None
            or record.request_hash not in legacy_hashes
        ):
            return mismatch_response()
        # Re-enter the unchanged shared claim API with the stored, explicitly
        # compatible image hash. The API's own row lock, stale-age check,
        # owner rotation, and matching-hash fence decide whether this is still
        # the same stale row. No provider call happens in this branch.
        try:
            claim = idempotency.claim(
                scope,
                request.user,
                key,
                request_hash=record.request_hash,
                initial_body=claim_body,
                allow_stale_takeover=True,
                stale_takeover_requires_matching_hash=True,
            )
        except idempotency.IdempotencyConflict:
            return mismatch_response()
        except idempotency.DuplicateRequest as duplicate:
            return duplicate_response(duplicate)
        return finish_or_return(claim, previous_record=record)
    except idempotency.DuplicateRequest as duplicate:
        return duplicate_response(duplicate)


def _provider_reservation(user, key, scope):
    """Locate only this provider operation's legacy reservation or L2 hold."""
    from dj.apps.ledger import holds
    from dj.apps.ledger.models import Account, LedgerHold
    operation_key = uuid.UUID(str(key))
    reservation = idempotency.ProviderReservation.objects.filter(
        scope=scope, user=user, operation_key=operation_key,
        status=idempotency.ProviderReservation.ACTIVE,
    ).first()
    if reservation is not None:
        return reservation
    account = Account.objects.filter(owner_id=user.pk, kind="user").first()
    if account is None:
        return None
    hold = LedgerHold.objects.filter(
        account_id=account.pk, app_id=holds.FIRST_PARTY_APP_ID,
        logical_key=f"{scope}:{operation_key}",
    ).first()
    if hold is None:
        return None
    return holds.HoldReservation(
        pk=hold.pk, user_id=user.pk, amount=Decimal(hold.amount) / Decimal(1000),
        scope=scope,
    )



def _image_reservation(user, key):
    return _provider_reservation(user, key, "ai_image")

class ImageGenerationRequestSerializer(serializers.Serializer):
    # Keep prompt input costs bounded so the fixed 2Z price remains valid.
    prompt = serializers.CharField(max_length=4000)
    # Clients may choose only an opaque option advertised by creator-options.
    # Omission preserves older clients; the server resolves it to the same
    # configured default before claiming idempotency or calling the provider.
    choice = serializers.CharField(max_length=64, required=False)
    choice_snapshot = serializers.CharField(required=False, allow_blank=False)
    size = serializers.ChoiceField(
        choices=IMAGE_SIZES, required=False, default="1024x1024"
    )


def _reserve_hosted_image_budget(claim, amount: Decimal, daily_limit: Decimal) -> bool:
    """Reserve one output's USD budget atomically across API workers.

    Operation records live in the existing idempotency table; the advisory
    transaction lock serializes inspection and admission without a migration.
    Uncertain operations keep their budget reservation until reconciled.
    """
    from django.db import connection
    from . import hosted_image

    account_limit = hosted_image._decimal_setting(settings.FAL_IMAGE_ACCOUNT_DAILY_BUDGET_USD)
    if account_limit is None or account_limit < amount:
        return False
    local_day = timezone.now().astimezone(datetime_timezone.utc).date()
    budget_day = local_day.isoformat()
    day_start = timezone.make_aware(
        datetime.combine(local_day, datetime_time.min),
        datetime_timezone.utc,
    )
    day_end = day_start + timedelta(days=1)
    # A request can create its idempotency claim just before local midnight
    # and reach budget admission just after it. Keep that short claim-to-
    # admission window in the indexed scan; budget_day remains authoritative.
    scan_start = day_start - idempotency.STALE_CLAIM
    reservation_state = (
        Q(response_body__contains={
            "_image_operation": {"budget_state": "reserved"},
        })
        | Q(response_body__contains={
            "_image_operation": {"budget_state": "uncertain"},
        })
        | Q(response_body__contains={
            "_image_operation": {"budget_state": "billed"},
        })
    )
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT pg_try_advisory_xact_lock(%s)",
                [hosted_image.BUDGET_ADVISORY_LOCK],
            )
            if not cursor.fetchone()[0]:
                return False
        bodies = idempotency.IdempotencyKey.objects.filter(
            scope="ai_image",
            created_at__gte=scan_start,
            created_at__lt=day_end,
        ).filter(reservation_state).exclude(
            response_body__contains={"_image_operation": {"provider": "openai"}},
        ).values_list("user_id", "response_body")
        used = Decimal("0")
        account_used = Decimal("0")
        for user_id, body in bodies:
            operation = body.get("_image_operation") if isinstance(body, dict) else None
            if not isinstance(operation, dict):
                continue
            if operation.get("budget_state") not in ("reserved", "uncertain", "billed"):
                continue
            # A live/terminal reservation without its immutable day cannot be
            # safely excluded from this day's cap.
            if not operation.get("budget_day"):
                return False
            if operation["budget_day"] != budget_day:
                continue
            reserved = operation.get("budget_reserved_usd")
            try:
                parsed_reserved = Decimal(str(reserved))
            except (InvalidOperation, TypeError, ValueError):
                # Corrupt accounting metadata is a closed budget, not zero spend.
                return False
            if not parsed_reserved.is_finite() or parsed_reserved < 0:
                return False
            used += parsed_reserved
            if user_id == claim.user_id:
                account_used += parsed_reserved
        if account_used + amount > account_limit:
            raise hosted_image.ImageProviderAccountBudgetExceeded
        if used + amount > daily_limit:
            return False
        body = dict(claim.response_body or {})
        prior_operation = body.get("_image_operation")
        prior_operation = prior_operation if isinstance(prior_operation, dict) else {}
        body["_image_operation"] = {
            **prior_operation,
            "provider": hosted_image.PROVIDER,
            "model": hosted_image.MODEL,
            "model_version": hosted_image.MODEL_VERSION,
            "budget_state": "reserved",
            "budget_reserved_usd": str(amount),
            "budget_day": budget_day,
        }
        from .image_receipts import update_image_receipt
        updated, body = update_image_receipt(
            idempotency.IdempotencyKey.objects.filter(
                pk=claim.pk, owner=claim.owner, response_status__isnull=True,
            ), body,
        )
        if not updated:
            return False
    claim.response_body = body
    return True


def _write_image_operation(claim, operation: dict, *, merge=True) -> bool:
    """Persist provider phase metadata without crossing an ownership/deletion fence."""
    queryset = idempotency.IdempotencyKey.objects.filter(
        pk=claim.pk, owner=claim.owner, response_status__isnull=True,
    )
    with transaction.atomic():
        record = queryset.select_for_update().first()
        if record is None:
            return False
        body = dict(record.response_body) if isinstance(record.response_body, dict) else {}
        previous = body.get("_image_operation")
        current = dict(previous) if merge and isinstance(previous, dict) else {}
        current.update(operation)
        body["_image_operation"] = current
        from .image_receipts import update_image_receipt
        updated, body = update_image_receipt(queryset, body)
    if updated:
        claim.response_body = body
    return bool(updated)


def _mark_image_provider_request_started(claim) -> bool:
    """Durably fence provider dispatch before sending the request."""
    return _write_image_operation(
        claim, {"provider_request_state": "started"}, merge=True,
    )


def _record_hosted_image_request(claim, metadata):
    """Persist fal's accepted request ID before polling or downloading."""
    body = dict(claim.response_body or {})
    operation = body.get("_image_operation")
    operation = dict(operation) if isinstance(operation, dict) else {}
    operation.update(metadata)
    body["_image_operation"] = operation
    from .image_receipts import update_image_receipt
    updated, body = update_image_receipt(
        idempotency.IdempotencyKey.objects.filter(
            pk=claim.pk, owner=claim.owner, response_status__isnull=True,
        ), body,
    )
    if not updated:
        raise RuntimeError("accepted image request receipt no longer belongs to this request")
    claim.response_body = body


def _retain_hosted_budget_day(claim, operation):
    """Carry the admission day into every terminal hosted receipt."""
    if not claim:
        return operation
    prior = claim.response_body if isinstance(claim.response_body, dict) else {}
    prior_operation = prior.get("_image_operation", {})
    if isinstance(prior_operation, dict) and prior_operation.get("budget_day"):
        operation.setdefault("budget_day", prior_operation["budget_day"])
    return operation


def _delete_generated_file(obj, label):
    """Delete one generated row with durable, generation-safe recovery."""
    if obj is None:
        return
    pending = None
    try:
        from dj.apps.uploads.models import PendingUploadBlobDeletion
        from dj.apps.uploads.tasks import (
            _BLOB_MISSING,
            _PENDING_GONE,
            _delete_from_storage,
            _ensure_pending_blob_generation,
            _has_live_file_reference,
            _record_generated_blob_for_cleanup,
            enqueue_blob_cleanup,
        )

        name = getattr(obj.file, "name", "")
        # Create the recovery row first. The ImageView opts out of
        # AtomicMiddleware and has already rolled back its own atomic block, so
        # this row is committed even when provider/storage cleanup fails.
        pending = _record_generated_blob_for_cleanup(name, enqueue=False)
        storage_deleted = pending is None
        if pending is not None:
            # Generation capture is a separate, committed phase. In
            # production GCS this metadata request can fail; the outbox row
            # already exists, so the exception path below can enqueue durable
            # recovery without losing the target name.
            generation = _ensure_pending_blob_generation(pending)
            if generation is _BLOB_MISSING:
                storage_deleted = True
            elif generation is _PENDING_GONE:
                storage_deleted = True
            else:
                has_other_reference = _has_live_file_reference(
                    name,
                    UPLOAD_STORAGE_ALIAS,
                    exclude_instance=obj,
                )
                if not has_other_reference:
                    storage_deleted = _delete_from_storage(
                        obj.file.storage,
                        name,
                        generation=generation,
                    )
                if not storage_deleted:
                    # Shared references and generation-unknown production rows
                    # are safe to retain; the worker/sweep can revisit them.
                    enqueue_blob_cleanup(pending.pk)

        # The row may have rolled back already. Avoid a no-op delete that would
        # fire upload signals for a row which never committed, but still remove
        # a partially persisted object when this helper is used directly.
        if obj.pk is not None and obj.__class__.objects.filter(
            pk=obj.pk,
        ).exists():
            obj.delete()

        if pending is not None and storage_deleted:
            PendingUploadBlobDeletion.objects.filter(pk=pending.pk).delete()
    except Exception:
        if pending is not None:
            try:
                from dj.apps.uploads.tasks import enqueue_blob_cleanup
                enqueue_blob_cleanup(pending.pk)
            except Exception:
                logger.exception(
                    "Failed to enqueue cleanup for generated %s", label)
        logger.exception("Failed to clean up generated %s", label)


def delete_generated_files(webp_obj, file_obj):
    """Best-effort cleanup for partially persisted image generations."""
    _delete_generated_file(webp_obj, "WebP")
    _delete_generated_file(file_obj, "PNG")


def _ai_error_response(exc, *, model_label=""):
    """Translate a provider failure into a clean DRF error Response.

    Any exception raised while generating a response (missing API key, retired /
    invalid model, provider API error, timeout,...) is logged in full and
    surfaced to the client as a friendly message instead of an opaque 500.
    Callers release the hold for failures before an accepted provider stream;
    interrupted accepted streams attach settlement details separately.
    """
    logger.exception("AI generation failed%s", f" for {model_label}" if model_label else "")

    # provider.get_client() raises RuntimeError("No API key configured...")
    # when the operator hasn't enabled that provider yet.
    if isinstance(exc, RuntimeError) and "No API key configured" in str(exc):
        detail = "This model isn't enabled yet. Try another model."
    else:
        # Keep the reason short and non-leaky (no stack / secrets).
        reason = type(exc).__name__
        detail = (
            f"This model isn't available right now ({reason}). Try another model."
        )

    return Response(
        {"detail": detail, "charge_status": "not_charged", "tuzis_charged": 0},
        status=status.HTTP_503_SERVICE_UNAVAILABLE,
    )


def _ai_not_charged_payload(payload):
    """Mark an application refusal whose charge outcome is known to be free.

    Clients retain idempotency keys for unstructured transport errors. They may
    release one only when this API explicitly reports that no charge occurred.
    """
    return {
        **payload,
        "charge_status": "not_charged",
        "tuzis_charged": 0,
    }


class AINotChargedErrorSerializer(serializers.Serializer):
    """A refusal that explicitly confirms the request incurred no debit."""

    detail = serializers.CharField(required=False)
    charge_status = serializers.ChoiceField(choices=["not_charged"])
    tuzis_charged = serializers.IntegerField(min_value=0)


class AISettledInterruptionErrorSerializer(serializers.Serializer):
    """A provider interruption whose observed usage was charged."""

    detail = serializers.CharField()
    charge_status = serializers.ChoiceField(choices=["settled"])
    tuzis_charged = serializers.IntegerField(min_value=0)
    response_saved = serializers.BooleanField()


class AIIdempotencyErrorSerializer(serializers.Serializer):
    """A malformed or conflicting idempotency request."""

    code = serializers.CharField()
    error = serializers.CharField()


class AIParserErrorSerializer(serializers.Serializer):
    """A malformed JSON body rejected by DRF before endpoint validation."""

    detail = serializers.CharField()


class ExpectedActorErrorSerializer(serializers.Serializer):
    """A stale authenticated-account precondition refused before paid work."""

    code = serializers.ChoiceField(choices=("account_changed",))
    detail = serializers.CharField()



class AIRequestErrorProxySerializer(PolymorphicProxySerializer):
    """OpenAPI union whose overlapping error variants remain valid."""


class AIRequestErrorProxyExtension(OpenApiSerializerExtension):
    target_class = AIRequestErrorProxySerializer

    def get_name(self, auto_schema, direction):
        return self.target.component_name

    def map_serializer(self, auto_schema, direction):
        variants = []
        for serializer in self.target.serializers:
            component = auto_schema.resolve_serializer(serializer, direction)
            if component:
                variants.append(component.ref)
        return {"anyOf": variants}


AI_REQUEST_ERROR_RESPONSE = OpenApiResponse(
    response=AIRequestErrorProxySerializer(
        component_name="AIRequestError",
        serializers=[
            AINotChargedErrorSerializer,
            AIIdempotencyErrorSerializer,
            AIParserErrorSerializer,
            ExpectedActorErrorSerializer,
        ],
        resource_type_field_name=None,
        many=False,
    ),
    description=(
        "Application validation refusals include an explicit no-charge outcome; "
        "malformed or conflicting idempotency requests use code/error. Invalid "
        "JSON rejected by the request parser returns detail only."
    ),
)

AI_SERVICE_ERROR_RESPONSE = OpenApiResponse(
    response=PolymorphicProxySerializer(
        component_name="AIServiceError",
        serializers={
            "not_charged": AINotChargedErrorSerializer,
            "settled": AISettledInterruptionErrorSerializer,
        },
        resource_type_field_name="charge_status",
    ),
    description=(
        "A pre-provider failure is not charged; an accepted interrupted provider "
        "stream reports its settled amount and that no response was saved."
    ),
)


def _ai_settled_interruption_response(error, amount):
    """Explain that an accepted but interrupted call was settled."""
    amount = int(amount)
    if amount:
        error.data["detail"] = (
            f"Generation was interrupted. {amount} 2Z was charged for "
            "observable usage; no response was saved. You can retry or "
            "choose another model."
        )
    else:
        error.data["detail"] = (
            "Generation was interrupted before any billable output was "
            "observed. No 2Z was charged and no response was saved. "
            "You can retry or choose another model."
        )
    error.data["charge_status"] = "settled"
    error.data["tuzis_charged"] = amount
    error.data["response_saved"] = False
    return error


def _provider_rejected_before_generation(exc):
    """Whether an explicit provider 4xx proves no generation was accepted."""
    code = getattr(exc, "status_code", None)
    # A 408 may occur after request processing began, and a 409 can report a
    # provider-side operation conflict. Neither proves a retry is free. Other
    # explicit 4xx responses, especially 429, are definite request refusals.
    return isinstance(code, int) and 400 <= code < 500 and code not in {408, 409}


def model_unavailable_detail(ai_model):
    """The message a user sees when their model has been flagged off.

    Deliberately says the model is unavailable and not why: the reason is a
    vendor-terms judgement that belongs in the published per-provider
    disclosure, not in an error body. It also must not read as an
    outage -- ``_ai_error_response``'s "right now" invites a retry, and a
    retry will never succeed. Nothing is lost: the conversation is still there
    to read, and a new one on another model is one click away.
    """
    return (
        f"{ai_model.display_name} is no longer available on Free2Z. Your "
        "existing conversations with it are unchanged and still readable — "
        "pick another model to keep chatting."
    )


def model_unavailable_response(ai_model):
    """409 for "the model exists, is named correctly, and is switched off".

    Not 503 (that is `_ai_error_response`, i.e. "try again") and not 404 (the
    conversation and the model both exist and the requester may read them).
    409 says the request is well-formed but conflicts with the current state
    of the resource, which is exactly this. Crucially it is a *clean* answer:
    a disabled model must never reach the provider layer and become a 500.
    """
    return Response(
        {
            "detail": model_unavailable_detail(ai_model),
            "charge_status": "not_charged",
            "tuzis_charged": 0,
        },
        status=status.HTTP_409_CONFLICT,
    )


# Bound what we echo back from the provider so a pathological error body can't
# become the response payload.
PROVIDER_DETAIL_MAX_LEN = 500

# Provider 400 codes that are genuinely about what the *user* typed. Everything
# else with a 400 -- a retired model, an unsupported parameter, a bad size for
# the configured model -- is OUR configuration being wrong, which means image
# generation is broken for everyone and must stay loud. See ImageView.post.
PROMPT_REJECTION_CODES = frozenset({
    "content_policy_violation",
    "moderation_blocked",
    "invalid_prompt",
})

CONTENT_POLICY_DETAIL = (
    "That prompt was rejected by the image provider's safety system. "
    "Please try a different prompt."
)
GENERIC_PROMPT_REJECTION_DETAIL = (
    "The image provider rejected this prompt. Please try a different one."
)
IMAGE_UNAVAILABLE_DETAIL = (
    "Image generation isn't available right now. Please try again later."
)
IMAGE_OUTCOME_UNCERTAIN_DETAIL = (
    "The provider may have accepted this image request. It was not retried; "
    "confirm its billing status before starting another request."
)


def _provider_error_payload(exc):
    """The `{"code":..., "message":...}` mapping from an OpenAI error.

    The SDK has ALREADY unwrapped the envelope: `OpenAI._make_status_error`
    does ``data = body.get("error", body)``, so `exc.body` is the *inner*
    error mapping, not the ``{"error": {...}}`` the wire carries. Unwrap once
    more anyway -- it is exactly what the SDK does, it costs nothing, and an
    SDK that stops unwrapping would otherwise silently degrade every message
    here to the generic fallback. `body` is `None` (or a bare string) when the
    response was not JSON, so assume no shape at all.

    `test_sdk_error_body_is_the_inner_mapping` pins the SDK half of this.
    """
    body = getattr(exc, "body", None)
    if not isinstance(body, dict):
        return {}
    error = body.get("error", body)
    return error if isinstance(error, dict) else {}


def _prompt_rejection_detail(error):
    """User-facing reason for a provider 400 that blames the prompt."""
    if error.get("code") == "content_policy_violation":
        return CONTENT_POLICY_DETAIL

    message = error.get("message")
    if isinstance(message, str) and message.strip():
        return message.strip()[:PROVIDER_DETAIL_MAX_LEN]

    return GENERIC_PROMPT_REJECTION_DETAIL


class AIModelPagination(Free2zPagination):
    """The whole shelf on page one.

    Rate card v3  put 25 OpenAI models in the lineup; at the default
    page size of 12 a picker that reads only the first page -- ZUULI's does --
    would show the top twelve by ``order`` and silently lose the rest. The
    envelope is unchanged (still ``count`` / ``next`` / ``results``), only
    the default and the ceiling move; ``?page_size=`` still works.
    """
    page_size = 100
    max_page_size = 100


class AIModelViewSet(viewsets.ReadOnlyModelViewSet):
    # Public catalogue of GA models, shown before login.
    permission_classes = [AllowAny]
    # queryset = AIModel.objects.filter(is_ga=True)
    serializer_class = AIModelSerializer
    pagination_class = AIModelPagination

    def get_queryset(self):
        # `selectable()` == is_ga AND is_enabled AND the provider has an API
        # key in this deployment (: prod listed five Claude/Grok models
        # it had no key for, each a 503 on every prompt). Both UIs build their model
        # picker from exactly this list (React `AIModelSelect` and the Svelte
        # provider grouping both GET /api/ai/models/ -- neither hardcodes a
        # model array), so a flagged-off row leaves every picker at once. This
        # is also `retrieve`'s queryset, so a direct GET of a disabled model's
        # id answers 404 rather than publishing its price card.
        return AIModel.objects.selectable()


class AIPersonalityViewSet(viewsets.ModelViewSet):
    serializer_class = AIPersonalitySerializer
    permission_classes = [IsAuthenticatedOrReadOnly]

    def get_queryset(self):
        if self.request.user.is_authenticated:
            # here, if it is update or delete method,
            # we don't want to show the public personalities
            if self.request.method in ['PUT', 'PATCH', 'DELETE']:
                return Personality.objects.filter(creator=self.request.user)

            return Personality.objects.filter(
                (Q(is_public=True) & _public_personality_q())
                | Q(creator=self.request.user)
            )
        else:
            return Personality.objects.filter(
                Q(is_public=True) & _public_personality_q()
            )

    def perform_create(self, serializer):
        serializer.save(creator=self.request.user)


class PublicConversationViewSet(viewsets.ReadOnlyModelViewSet):
    """
    This viewset provides read-only access to public conversations.
    The ConversationDetailSerializer returns all of the promptresponses
    """
    # Public: queryset is hard-filtered to a public conversation whose owner
    # and attached personality (when any) are still active.
    permission_classes = [AllowAny]
    serializer_class = ConversationSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ['user__username', 'ai_model__model']

    def get_serializer_class(self):
        if self.action == 'retrieve':
            return ConversationDetailSerializer
        return ConversationSerializer

    def get_queryset(self):
        # if self.request.user.is_authenticated:
        #     qs = Conversation.objects.filter(
        #         Q(is_public=True) | Q(user=self.request.user)
        #     )
        # else:
        # We actually don't need to use this one and scare people
        # that their convos are public haha
        #
        # Security: `is_public` alone is NOT the read boundary. A
        # conversation flagged `is_subscriber_only=True` (the UI offers the
        # toggle) must be visible only to its owner and to active subscribers
        # of its creator -- otherwise the paywalled transcript was served in
        # full to anyone, including anonymous users. This gate covers both
        # `list` and `retrieve`, since `retrieve` resolves its object through
        # this queryset.
        qs = Conversation.objects.filter(
            _public_conversation_q(self.request.user)
            & _public_personality_q(prefix="personality__")
        )
        public_prompt_responses = PromptResponse.objects.filter(
            _public_personality_q(prefix="personality__")
        )
        return qs.prefetch_related(
            'tags',
            Prefetch(
                'prompt_response_set',
                queryset=public_prompt_responses,
            ),
        ).select_related('user', 'ai_model')


class PublicPromptResponseViewSet(viewsets.ReadOnlyModelViewSet):
    """
    This viewset provides read-only access to prompt responses for public conversations
    """
    # Public: queryset is hard-filtered to one active, public conversation.
    permission_classes = [AllowAny]
    serializer_class = PromptResponseSerializer

    def get_queryset(self):
        # Only return prompt responses that belong to THE public conversation
        # named in the URL. This previously filtered on `conversation` (the
        # deprecated FK, NULL on every modern row) and ignored the URL kwarg
        # entirely, so it both returned nothing useful and was not scoped to the
        # requested conversation. `conversations` is the live M2M; both
        # predicates share one filter() so a single conversation must satisfy
        # them together.
        cid = valid_uuid(self.kwargs.get('conversation_id'))
        if cid is None:
            return PromptResponse.objects.none()
        # Security: the same subscriber-only gate that protects
        # PublicConversationViewSet must protect the transcript rows too, or a
        # non-subscriber just reads the paywalled content one endpoint over.
        # All predicates live in ONE filter() so, across the `conversations`
        # M2M, they bind to a SINGLE conversation that is both the requested
        # one, public, AND visible to this viewer -- not "some public
        # conversation with this id" plus "some conversation the viewer may
        # see".
        return PromptResponse.objects.filter(
            Q(conversations__id=cid)
            & _public_conversation_q(
                self.request.user, prefix="conversations__"
            )
            & _public_personality_q(prefix="personality__")
        )


class ConversationViewSet(viewsets.ModelViewSet):
    """
    This is to get your own conversations and fork others.
    """
    serializer_class = ConversationSerializer
    filter_backends = [DjangoFilterBackend]
    # Adjust the search fields as needed
    filterset_fields = ['user__username', 'ai_model__model']
    permission_classes = [IsAuthenticated]
    # TODO: should not be able to update ai_model
    # http_method_names = ['get', 'post', 'head', 'options']

    def get_serializer_class(self):
        if self.action == 'retrieve':
            return ConversationDetailSerializer
        return ConversationSerializer

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context.update({
            'action': self.action
        })
        return context

    def get_queryset(self):
        user = self.request.user
        if user.is_authenticated:
            return Conversation.objects.filter(user=user)
        return Conversation.objects.none()

    @action(detail=False, url_path='public')
    def public(self, request):
        # Security: same subscriber-only gate as the public viewset --
        # this action is another path that serves public conversations, so a
        # subscriber-only one must not leak here to a non-subscriber.
        public_conversations = Conversation.objects.filter(
            _public_conversation_q(request.user)
            & _public_personality_q(prefix="personality__")
        )
        serializer = self.get_serializer(public_conversations, many=True)
        return Response(serializer.data)

    def create(self, request, *args, **kwargs):
        ai_model_id = request.data.get('ai_model')
        personality_id = request.data.get('personality')

        # `ai_model` comes straight from the request body and this method
        # bypasses the serializer entirely, so the field-level queryset scoping
        # in ConversationSerializer never runs here -- the check has to be
        # explicit. Scoped to `enabled()`: naming a flagged-off model is
        # rejected server-side, which is the half a client-side filter can
        # never cover.
        #
        # `valid_uuid` first because `id` is a UUIDField: handing the ORM a
        # non-UUID string raises django.core.exceptions.ValidationError, and
        # `.get()` on a missing id raised DoesNotExist -- both 500s today, on
        # a request that is simply malformed.
        if valid_uuid(ai_model_id) is None:
            raise ParseError("A valid ai_model id is required.")
        ai_model = AIModel.objects.enabled().discovered(upstream=False).filter(id=ai_model_id).first()
        if ai_model is None:
            # Don't distinguish "no such model" from "disabled" by status
            # code, but do give the disabled case its real message when the row
            # exists -- "not found" for a model the user can see in an old
            # conversation is the confusing answer.
            disabled = AIModel.objects.filter(id=ai_model_id).first()
            if disabled is not None:
                return model_unavailable_response(disabled)
            raise ParseError("No such ai_model.")

        personality = None

        if personality_id:
            personality = Personality.objects.get(id=personality_id)
            # Don't allow creating a converation with some elses personality
            if personality.creator and personality.creator != request.user:
                raise PermissionDenied("You do not have permission to use this personality.")

        conversation = Conversation.objects.create(
            display_name=request.data.get('display_name'),
            ai_model=ai_model,
            personality=personality,
            user=request.user
        )
        serializer = self.get_serializer(conversation)
        return Response(serializer.data)

    def update(self, request, *args, **kwargs):
        partial = kwargs.pop('partial', False)
        instance = self.get_object()
        if instance.personality and instance.personality.creator and instance.personality.creator != request.user:
            raise PermissionDenied("You do not have permission to update this conversation.")
        serializer = self.get_serializer(instance, data=request.data, partial=partial)
        serializer.is_valid(raise_exception=True)
        self.perform_update(serializer)
        return Response(serializer.data)

    @action(detail=False, methods=['post'], url_path='fork')
    def fork(self, request):
        prompt_response_id = request.data.get('prompt_response')
        conversation_id = request.data.get('conversation')

        if request.user.is_anonymous:
            raise PermissionDenied("You must be logged in to fork a conversation.")

        # Security: both ids arrive straight from the request body and
        # neither used to be scoped, so `fork` was a working exfiltration
        # primitive -- POST any conversation UUID and the victim's private
        # transcript was copied into a conversation the attacker owns and can
        # read at leisure. A conversation is forkable only if the requester owns
        # it or its author published it (`is_public`); forking others' public
        # conversations is the intended product feature and is preserved.
        #
        # Security: `fork` was deliberately kept matching the public
        # READ path so it grants nothing the read path doesn't. Now that the
        # read path enforces `is_subscriber_only`, so must fork -- otherwise a
        # non-subscriber copies the paywalled transcript into a conversation
        # they own and read it at leisure. The owner may always fork their own
        # conversation (even a private one), hence the explicit `user=` arm.
        if not conversation_id or valid_uuid(conversation_id) is None:
            raise ParseError("A valid conversation id is required.")

        conversation = get_object_or_404(
            Conversation.objects.filter(
                Q(user=request.user)
                | (
                    _public_conversation_q(request.user)
                    & _public_personality_q(prefix="personality__")
                )
            ),
            id=conversation_id,
        )
        # The fork point must belong to THIS conversation. Previously an
        # unrelated (or non-member) prompt_response never matched the loop
        # below, so the break never fired and the ENTIRE conversation was
        # copied rather than the requested prefix.
        # PromptResponse.id is a sequential AutoField (int4), so a non-integer
        # body value would raise ValueError out of the ORM as a 500 rather than
        # a 400 -- get_object_or_404 only swallows DoesNotExist.
        try:
            prompt_response_id = int(prompt_response_id)
        except (TypeError, ValueError):
            raise ParseError("A valid prompt_response id is required.")

        prompt_response = get_object_or_404(
            conversation.prompt_response_set, id=prompt_response_id
        )

        # don't let someone fork with a personality that is owned by someone else
        #... alternatively we could let them use it.. or set a default personality
        if conversation.personality and conversation.personality.creator and conversation.personality.creator != request.user:
            raise PermissionDenied("You do not have permission to fork this conversation.")

        # A fork copies `conversation.ai_model` verbatim, so forking a
        # conversation on a flagged-off model would mint a brand new
        # conversation that can never generate a reply -- an empty shell whose
        # first prompt 409s. Refuse here instead, while the original is still
        # readable and forkable-once-re-enabled. Reading the source
        # conversation is deliberately NOT gated: only creating new work on a
        # disabled model is.
        # `enabled().discovered()`, not the row's own flag: a model its
        # provider stopped listing is as unavailable as a flagged-off one
        # ( follow-up; codex review of ).
        if not AIModel.objects.enabled().discovered(upstream=False).filter(
                pk=conversation.ai_model_id).exists():
            return model_unavailable_response(conversation.ai_model)

        new_conversation = Conversation.objects.create(
            # Copy the necessary attributes from the original conversation.
            ai_model=conversation.ai_model,
            personality=conversation.personality,
            user=request.user,
            display_name=f"(Forked) {conversation.display_name}"[:200],
            # is_public=conversation.is_public,
            # is_subscriber_only=conversation.is_subscriber_only,
        )
        # Add all of the promptresponses from the original conversation
        # UP TO the prompt response that was forked from.

        # Collect all the prompt responses to be added
        prompt_responses_to_add = []
        for pr in conversation.prompt_response_set.all():
            prompt_responses_to_add.append(pr)
            if pr.id == prompt_response.id:
                break

        logger.info(f"Adding {len(prompt_responses_to_add)} prompt responses to new conversation {new_conversation.id}")
        new_conversation.prompt_response_set.add(*prompt_responses_to_add)

        return Response({
            "id": new_conversation.id
        }, status=status.HTTP_201_CREATED)


class PromptRequestSerializer(serializers.Serializer):
    """Send a prompt to the conversation's model and get the reply."""

    # Deliberately a comment, not more docstring: drf-spectacular publishes a
    # serializer's docstring as the schema description in the PUBLIC f2z.yaml.
    #
    # The view read `request.data` by hand before, so `user_input` was
    # undeclared: no generated client could see it, and a request without it
    # died inside the tokenizer and surfaced as a 503. Declaring the body is
    # what lets `max_output_tokens` be declared too -- a field that changes
    # what we ask the provider for, and therefore how many 2Z the requester
    # has to hold, has to be visible in the spec or no generated client can
    # ever send it (see AGENTS.md).

    user_input = serializers.CharField(
        allow_blank=True,
        # The prompt is content, not a form field: stripping it would change
        # the tokens we price and the tokens we send.
        trim_whitespace=False,
        help_text="The prompt to send to the model.",
    )
    max_output_tokens = serializers.IntegerField(
        required=False,
        allow_null=True,
        min_value=1,
        max_value=MAX_REQUESTABLE_OUTPUT_TOKENS,
        help_text=(
            "How long a reply to ask for, in tokens. Omit it to get the "
            "longest reply the model can give for this prompt that your 2Z "
            "already cover. Naming a number larger than the model can produce "
            "-- or than the context window has left after the prompt -- is "
            "clamped down to that, never rejected; naming one your 2Z do not "
            "cover answers 402 with the number of 2Z it would take."
        ),
    )


class PromptResponseViewSet(viewsets.ModelViewSet):
    # Prompt/response rows of ONE conversation the requester owns.
    #
    # Security: this used to filter on `conversation_id` alone, so any
    # authenticated user holding a conversation UUID could read, rewrite or
    # DELETE another user's private transcript. Two independent guards now have
    # to fail together for that to happen: the queryset is scoped to the
    # requester, AND `IsConversationOwner` enforces ownership at the request
    # *and* object level. A scoped queryset alone is not a boundary -- a future
    # `get_object` override or a custom `@action` sails straight past it.
    #
    # Deliberately a comment, not a docstring: drf-spectacular publishes view
    # docstrings as operation descriptions in the public f2z.yaml.
    serializer_class = PromptResponseSerializer
    permission_classes = [IsAuthenticated, IsConversationOwner]

    # Issue: opt OUT of `AtomicMiddleware`'s request-wide transaction.
    # `create` spends 10-90s streaming from a third-party provider; wrapping
    # that in a transaction leaves a Cloud SQL connection `idle in
    # transaction` for the whole generation. This view takes responsibility
    # for its own atomicity instead -- see the explicit `transaction.atomic()`
    # around the persist + debit in `create`. The other methods here are
    # single-row writes, each already atomic on its own.
    atomic_request = False

    # JSON only, and that is load-bearing rather than tidiness. DRF renders the
    # Response AFTER the view returns -- i.e. after the money transaction above
    # has committed. Encoding a dict of primitives to JSON cannot fail
    # transiently, so that window is safe. `BrowsableAPIRenderer` (half of
    # DRF's default `DEFAULT_RENDERER_CLASSES`, and this project does not
    # override it) is a different animal entirely: an `Accept: text/html` POST
    # would render templates and run its own queries post-commit, which is
    # exactly the transient-failure class that turns a 500 into a retry into a
    # double charge. Pinning the renderer keeps the post-commit window
    # I/O-free. Found by the review of.
    renderer_classes = [JSONRenderer]

    def get_queryset(self):
        cid = valid_uuid(self.kwargs.get('conversation_id'))
        if cid is None:
            return PromptResponse.objects.none()
        user = self.request.user
        if not user.is_authenticated:
            return PromptResponse.objects.none()
        # NB: `conversation` (singular) is the DEPRECATED FK and is NULL on
        # every modern row -- the commented-out `conversation__user=` "fix" that
        # shipped here would have scoped on that dead column and silently
        # returned nothing. The live relation is the `conversations` M2M
        # (`Conversation.prompt_response_set`). Both predicates sit in ONE
        # filter() call on purpose: for a multi-valued relation Django requires a
        # SINGLE related row to satisfy them together, i.e. "a conversation with
        # this id that belongs to me" -- not "some conversation with this id"
        # AND "some conversation of mine".
        return PromptResponse.objects.filter(
            conversations__id=cid,
            conversations__user=user,
        )

    @extend_schema(
        parameters=[
            PROVIDER_IDEMPOTENCY_PARAMETER,
            PROVIDER_GENERATION_MODEL_PARAMETER,
        ],
        request=PromptRequestSerializer,
        responses={
            200: PromptResponseSerializer,
            400: AI_REQUEST_ERROR_RESPONSE,
            409: AI_REQUEST_ERROR_RESPONSE,
            402: InsufficientFundsErrorSerializer,
            503: AI_SERVICE_ERROR_RESPONSE,
        },
    )
    def create(self, request, *args, **kwargs):
        body = PromptRequestSerializer(data=request.data)
        if not body.is_valid():
            return Response(
                _ai_not_charged_payload(body.errors),
                status=status.HTTP_400_BAD_REQUEST,
            )
        user_input = body.validated_data['user_input']
        requested_output = body.validated_data.get('max_output_tokens')


        conversation = Conversation.objects.get(
            id=kwargs.get('conversation_id'),
            user=request.user,
        )

        # AVAILABILITY GATE, before anything else costs anything.
        # `ai_model` is a FK on the conversation, so a model flagged off after
        # the conversation was started is still the one this endpoint would
        # call. Refuse cleanly and early: no tokenizing, no admission pricing,
        # no provider request, no 2Z moved, and above all no exception -- the
        # conversation itself is untouched and its transcript still reads back
        # in full through `list`/`retrieve`, which are deliberately not gated.
        #
        # Ahead of the 2Z minimum below on purpose: "get more 2Zs" is the wrong
        # thing to tell someone whose model is gone, because buying them would
        # not make this request work.
        # `enabled().discovered()`, not the row's own flag: a model its
        # provider stopped listing is as unavailable as a flagged-off one
        # ( follow-up; codex review of ).
        claim, duplicate_response = _provider_claim(
            request,
            "ai_chat",
            {
                "action": "ai_chat",
                "intent": "openai_chat",
                "conversation": str(conversation.pk),
                "user_input": user_input,
                "max_output_tokens": requested_output,
                # The model is mutable conversation state. A retry with the
                # same operation key must replay a completed answer even if
                # the user changed the conversation's model after losing the
                # HTTP response. If the prior operation did not commit, its
                # released key can safely start against the new model.
            },
            legacy_payloads=(
                ([{
                    "action": "ai_chat",
                    "intent": "openai_chat",
                    "conversation": str(conversation.pk),
                    "user_input": user_input,
                    "max_output_tokens": requested_output,
                    "model": model_id,
                } for model_id in {
                    str(conversation.ai_model.pk),
                    request.headers.get("X-AI-Generation-Model"),
                } if model_id]
                )
            ),
        )
        if duplicate_response is not None:
            return duplicate_response

        # Resolve a durable retry before the current availability gate. A
        # receipt already committed under this operation remains replayable
        # after its model is disabled; a fresh key is released below.
        if not AIModel.objects.enabled().discovered(upstream=False).filter(
                pk=conversation.ai_model_id).exists():
            idempotency.release(claim)
            return model_unavailable_response(conversation.ai_model)

        if request.user.tuzis < MIN_CHAT_TUZIS:
            idempotency.release(claim)
            return Response(
                _ai_not_charged_payload(
                    ledger.insufficient_funds_payload(
                        request.user, MIN_CHAT_TUZIS, action="ai_chat"
                    )
                ),
                status=status.HTTP_402_PAYMENT_REQUIRED,
            )

        content_type = ContentType.objects.get_for_model(conversation)
        ai_model = conversation.ai_model

        # STEP 0 — ADMISSION. Price the CEILING of this request and refuse it
        # here if the requester's 2Z do not cover it, BEFORE the provider is
        # called ( §3.1).
        #
        # The flat 100-2Z floor above is not an admission test, it is a
        # product minimum: it is a constant, and the charge is a function of
        # the model, the prompt length and the reply length. When the real
        # price exceeded the floor, the sequence was: admit -> call the
        # provider (we are billed) -> `ledger.debit` raises InsufficientFunds
        # -> the whole atomic block rolls back -> the user is charged NOTHING
        # and we keep the provider bill. Repeatable, and repeatable at the
        # global 1200/min throttle, because failing costs the attacker nothing
        # and gets cheaper the more history the conversation carries.
        #
        # `build_messages` is a pure read that returns the token count of the
        # prompt we are about to send, and `output_cap` below is the very
        # number `generate` hands the provider as a HARD cap, so
        # `get_max_tuzi_price` is an upper bound on what STEP 2 can charge
        # rather than an estimate. Both halves are load-bearing: drop the
        # output cap and this number stops bounding anything.
        #
        # Except where the cap does not bound reasoning: xAI's covers visible
        # output only. `get_admission_price` adds the model's
        # reasoning allowance on top, so the ceiling admitted (and clamped
        # to) covers typical reasoning instead of handing it to us.
        #
        # (The count itself is tiktoken's, not each provider's own tokenizer,
        # so it carries the estimation error  §3.4 is about. The honest
        # claim is "bounded", not "exact to the provider's own count".)
        #
        # This is admission control only. It does NOT reserve the 2Z, so a
        # concurrent spend can still leave the user unable to pay by STEP 2 --
        # `ledger.debit` remains the authoritative answer and still refuses.
        # Closing that window needs authorize-then-capture, which is 's
        # structural work and deliberately not built here.
        #
        # Wrapped in the same try/_ai_error_response the build used to sit
        # inside (it ran within `generate`), so a prompt that cannot be
        # tokenized keeps answering 503 instead of becoming a new 500.
        try:
            messages, input_tokens = conversation.build_messages(user_input)
        except Exception as exc:
            idempotency.release(claim)
            return _ai_error_response(exc, model_label=str(ai_model))

        # A turn build_messages could not trim under the budget (nothing left
        # to drop but the system message and the turn itself) used to be sent
        # anyway with a squeezed output cap. Refuse it instead, as the
        # conversation-less prompt endpoint already does. Two reasons, both
        # money: the provider would answer a 400 that reaches the user as
        # "this model isn't available", and on a long-context-tiered model
        # (OpenAI >272K, xAI >=200K) the whole request is billed at the
        # higher tier while the row's short-context price is what we charge
        # -- the window cap in the lineup only holds if nothing above it is
        # ever sent.
        # Two counts, on purpose. `window_tokens` is
        # the CONSERVATIVE count (max over the shipped tokenizers): it decides
        # the budget refusal below and the output cap, so prompt + cap can
        # never exceed the model's window on the tokenizer the provider
        # actually uses. `input_tokens` is the legacy count the charge and
        # admission price use (tuzi#2494 moves billing to provider usage).
        window_tokens = count_prompt_tokens(messages, ai_model.model)
        if window_tokens > ai_model.get_input_token_budget():
            idempotency.release(claim)
            return Response(
                {
                    "detail": (
                        f"That message is {window_tokens} tokens; "
                        f"{ai_model.display_name} accepts at most "
                        f"{ai_model.get_input_token_budget()} for one turn."
                    ),
                    "charge_status": "not_charged",
                    "tuzis_charged": 0,
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # How long a reply this request gets.  handed every request the
        # same fixed per-model cap, which meant a user holding plenty of 2Z was
        # given no more than one scraping the minimum. The length is now the
        # requester's to choose and to cover:
        #
        # * named a number -> that number, clamped to what the model can
        #   produce and to the room left in the context window (clamping, not
        #   rejecting, because a 400 from the provider reaches the user as
        #   "this model isn't available right now", which is a lie);
        # * named nothing -> the longest reply the model can give for this
        #   prompt that their 2Z already cover. Never less than  gave
        #   them:  refused anyone who could not cover the fixed cap, so
        #   for every request it admitted, the affordable length is at least
        #   that cap.
        #
        # The floor keeps the "named nothing" branch from silently asking for
        # a two-word answer when the prompt has eaten nearly everything the
        # requester holds. It does not admit anything: the single check below
        # prices whatever comes out of here and is the only gate.
        if requested_output is None:
            output_cap = min(
                ai_model.get_request_output_cap(window_tokens),
                max(MIN_REQUEST_OUTPUT_TOKENS,
                    ai_model.get_affordable_output_tokens(
                        input_tokens, request.user.tuzis)),
            )
        else:
            output_cap = ai_model.get_request_output_cap(
                window_tokens, requested_output)

        # ONE admission check, for whichever length we landed on, so the two
        # branches above cannot drift into two different guarantees.
        max_price = ai_model.get_admission_price(input_tokens, output_cap)
        if request.user.tuzis < max_price:
            idempotency.release(claim)
            return Response(
                _ai_not_charged_payload(
                    ledger.insufficient_funds_payload(
                        request.user, max_price, action="ai_chat"
                    )
                ),
                status=status.HTTP_402_PAYMENT_REQUIRED,
            )

        # Hold the admitted ceiling through provider I/O. Besides preventing
        # concurrent spends from making a started call uncollectable, this
        # gives interrupted calls the same bounded settlement path as the
        # metered prompt endpoint.
        reservation = None
        if max_price > 0:
            operation_key = idempotency.request_key(request) or uuid.uuid4()
            try:
                reservation = ledger.reserve(
                    request.user, max_price,
                    scope="ai_chat", operation_key=operation_key,
                )
            except ledger.InsufficientFunds as exc:
                idempotency.release(claim)
                return Response(
                    _ai_not_charged_payload(
                        ledger.insufficient_funds_payload(exc, action="ai_chat")
                    ),
                    status=status.HTTP_402_PAYMENT_REQUIRED,
                )

        # STEP 1 — generate, OUTSIDE any transaction.
        #
        # `generate` opens the provider stream and iterates it token by token:
        # 10-90s of third-party network I/O, bounded only by gunicorn's
        # --timeout 600.  ran this inside the money transaction, which left
        # a Cloud SQL connection `idle in transaction` for the whole
        # generation — pinning an xmin, holding back vacuum, and burning a
        # connection slot that looks idle to every monitoring tool. It writes
        # nothing, so there is nothing to keep atomic here.
        #
        # Provider failures become a clean 503 — never a 500. Failures before
        # the provider returns a stream release the hold; once it has started,
        # an interrupted stream settles reported usage or the visible estimate,
        # still clamped to this ceiling.
        #
        # `output_cap` is passed explicitly rather than recomputed inside
        # `generate`, so the length admitted above and the length asked of the
        # provider are the same number by construction. A longer reply than we
        # priced is a charge nobody agreed to; a shorter one is an answer cut
        # off for no reason.
        #
        # AVAILABILITY, not 2Z: this blocks one of the fleet's single sync
        # gunicorn workers  for the whole generation, and a longer reply
        # blocks it for longer. `AI_CHAT_DEADLINE_SECONDS` bounds that at 540s,
        # under gunicorn's `--timeout 600`, so the worst case is unchanged from
        # before this branch. The real fix is the SSE transport in  §3.2,
        # which stops a long generation holding a sync worker at all.
        try:
            generation = conversation.generate(
                user_input, messages=messages, input_tokens=input_tokens,
                max_output_tokens=output_cap,
                # Use the validated claim as the correlation source. It is
                # present only for a valid idempotent operation and avoids a
                # second, unrelated header read in the write path.
                stream_id=str(claim.key) if claim is not None else None,
            )
        except GenerationInterrupted as exc:
            try:
                error = _ai_error_response(exc, model_label=str(ai_model))
                price = _clamp_to_ceiling(
                    ai_model, exc.input_tokens, exc.settlement_output_tokens,
                    max_price, endpoint="ai_chat", user_id=request.user.pk, usage=exc.usage)
                error = _ai_settled_interruption_response(error, price)
                with transaction.atomic():
                    ledger.settle_reservation(reservation, amount=price)
                    Event.objects.create(
                        read=False,
                        type="CHAT2Z",
                        receiving_user=request.user,
                        contributor=request.user,
                        amount=price,
                        content_type=content_type,
                        object_id=conversation.id,
                    )
                    if claim is not None:
                        claim.finish(error.status_code, error.data)
            except ledger.InsufficientFunds as settle_exc:
                ledger.release_reservation(reservation)
                idempotency.release(claim)
                return Response(
                    _ai_not_charged_payload(
                        ledger.insufficient_funds_payload(
                            settle_exc, action="ai_chat"
                        )
                    ),
                    status=status.HTTP_402_PAYMENT_REQUIRED,
                )
            except Exception:
                ledger.release_reservation(reservation)
                idempotency.release(claim)
                raise
            return error
        except Exception as exc:
            ledger.release_reservation(reservation)
            idempotency.release(claim)
            return _ai_error_response(exc, model_label=str(ai_model))

        # STEP 2 — persist AND charge in ONE transaction, now
        # orders of magnitude shorter: local writes only, no network I/O.
        #
        # The Event `post_save` signal used to make a blocking Pub/Sub
        # `get_topic` RPC right here (found by the codex adversarial
        # review).  fixed that app-wide: `dj/apps/events/signals.py` now
        # defers the publish to `transaction.on_commit(..., robust=True)` with
        # `ensure_topic=False`, so creating the Event below only queues a
        # callback. Note the interaction with the opt-out above — because this
        # request is NOT wrapped by `AtomicMiddleware`, the block below is the
        # OUTERMOST atomic block, so that callback fires the instant the debit
        # commits rather than at the end of the request. `robust=True` means a
        # Pub/Sub failure is logged, not raised, and cannot unwind money that
        # is already durable.
        #
        # MONEY PATH: hold the admitted ceiling, then settle with actual usage
        # (or the observable estimate when an interruption has no final usage).
        # The debit and answer share one atomic block, so they commit together
        # or not at all. STEP 0 refuses every request whose ceiling the user
        # cannot cover, and the reservation prevents concurrent spending from
        # making the call uncollectable.
        #
        # The failure we accept: if the process dies between the last token and
        # this commit, the user got a generation for free. The failure we
        # refuse: charging for output the user never received. Free output
        # costs us one provider call; a phantom charge costs us trust, and it
        # is unfixable without a manual refund. (The live-token WebSocket push
        # already leaks the same way and always has — the tokens are on the
        # wire before any of this runs.)
        #
        # CLAMPED to the ceiling admitted above, as the metered prompt path
        # already is. `output_tokens` is the provider's own count,
        # hidden reasoning included, and a provider whose output cap does not
        # bound its reasoning (xAI reports reasoning beside
        # `completion_tokens`) could otherwise price a delivered reply above
        # what the requester was shown and admitted for -- a charge nobody
        # agreed to, or a 402 after the provider has already billed us.
        try:
            response_text, input_tokens, output_tokens, usage = generation
            price = _clamp_to_ceiling(
                conversation.ai_model, input_tokens,
                generation.settlement_output_tokens, max_price,
                endpoint="ai_chat", user_id=request.user.pk, usage=usage)
            with transaction.atomic():
                prompt_response = conversation.persist_response(
                    user_input, response_text
                )
                ledger.settle_reservation(reservation, amount=price)
                Event.objects.create(
                    read=False,
                    type="CHAT2Z",
                    receiving_user=request.user,
                    # payee=request.user,
                    contributor=request.user,
                    amount=price,
                    content_type=content_type,
                    object_id=conversation.id,
                )
                # Serialize INSIDE the block. `.data` is evaluated eagerly and
                # runs its own queries (the nested creator serializer counts
                # zpages, resolves images); if it blows up after the commit the
                # user has been charged and the request 500s, so they retry and
                # pay twice. Losing the outer AtomicMiddleware transaction is
                # what exposed this boundary -- it used to stay open through
                # rendering. These are cheap reads, so the money transaction is
                # still milliseconds, not a provider round trip. Found by the
                # codex adversarial review.
                data = self.get_serializer(prompt_response).data
                if claim is not None:
                    claim.finish(status.HTTP_200_OK, data)
        except ledger.InsufficientFunds as exc:
            ledger.release_reservation(reservation)
            idempotency.release(claim)
            return Response(
                _ai_not_charged_payload(
                    ledger.insufficient_funds_payload(exc, action="ai_chat")
                ),
                status=status.HTTP_402_PAYMENT_REQUIRED,
            )
        except Exception:
            ledger.release_reservation(reservation)
            idempotency.release(claim)
            raise
        # NB: no blanket `except Exception` here. It used to wrap the provider
        # call too, so it had to exist; now the only things left in this block
        # are our own writes, and answering a database failure with "this model
        # isn't available right now" would send everyone chasing the wrong
        # provider while the real error never surfaces.
        return Response(data)


# OG views.py


#Reply budget of the flat-priced legacy prompt. With
#f2z.ai.providers.FLAT_PRICE_CONTEXT_TOKENS (4,096) it leaves 200 prompt
#tokens -- exactly what gpt-3.5-turbo-instruct's context allowed.
LEGACY_MAX_TOKENS = 2048 * 2 - 200


class PromptView(views.APIView):
    # Was `@permission_classes(...)` on the class, which DRF only
    # honours on @api_view functions.
    permission_classes = [IsAuthenticated]
    atomic_request = False

    @extend_schema(
        parameters=[PROVIDER_IDEMPOTENCY_PARAMETER],
        responses={
            200: OpenApiResponse(description="No response body"),
            402: InsufficientFundsErrorSerializer,
        }
    )
    def post(self, request):
        prompt = request.data.get("prompt")
        if not prompt:
            raise ParseError("Missing prompt.")
        if not isinstance(prompt, str):
            raise ParseError("Prompt must be a string.")
        # Flat 1 2Z: bound the input before any provider spend.
        too_long = flat_price_prompt_error(prompt, max_tokens=LEGACY_MAX_TOKENS)
        if too_long:
            raise ParseError(too_long)

        claim, duplicate_response = _provider_claim(
            request,
            "ai_completion",
            {"action": "ai_completion", "intent": "openai_completion", "prompt": prompt},
            replay_field="value",
        )
        if duplicate_response is not None:
            return duplicate_response
        # Resolved once per request so the error label names the model that
        # was actually asked (: it used to be a hard-coded literal).
        model = prompt_completion_model()
        if oai_client is None:
            idempotency.release(claim)
            return _ai_error_response(
                RuntimeError("No API key configured for OpenAI"),
                model_label=model,
            )

        if request.user.tuzis < 1:
            idempotency.release(claim)
            return Response(
                ledger.insufficient_funds_payload(
                    request.user, 1, action="ai_completion"
                ),
                status=status.HTTP_402_PAYMENT_REQUIRED,
            )

        # Legacy completions endpoint. Wrap the provider call so an OpenAI
        # outage / retired model returns a clean 503 instead of a 500, and the
        # user is not charged (the deduction happens only on success below).
        #
        # Chat Completions on PROMPT_COMPLETION_MODEL: the legacy
        # Completions model this used, gpt-3.5-turbo-instruct, was retired on
        # 2026-09-28. The PRICE is unchanged -- a flat 1 2Z per call, not
        # metered per token -- and the provider cost per call went DOWN
        # (gpt-4o-mini lists at 1/10 the input and under 1/3 the output price
        # of gpt-3.5-turbo-instruct), so the flat price still covers the
        # worst case (3,896 output tokens) with margin.
        try:
            value = complete_prompt(
                oai_client,
                prompt,
                model=model,
                temperature=0.5,
                max_tokens=LEGACY_MAX_TOKENS,
            )
        except EmptyCompletion as exc:
            # The provider answered with no text. Nothing is delivered, so
            # nothing is charged, and the key is released for a real retry.
            idempotency.release(claim)
            return _ai_error_response(exc, model_label=model)
        except Exception as exc:
            # The provider may have accepted the request before the transport
            # failed. Keep the claim so a retry cannot issue another completion.
            return _ai_error_response(exc, model_label=model)
        # Collect the 2Z atomically. Strict, not clamped: a
        # concurrent spend that emptied the account since the check above must
        # not buy a free completion.
        try:
            with transaction.atomic():
                ledger.debit(request.user, 1, action="ai_completion")
                if claim is not None:
                    claim.finish(status.HTTP_200_OK, {"value": value})
        except ledger.InsufficientFunds as exc:
            idempotency.release(claim)
            return Response(
                ledger.insufficient_funds_payload(exc, action="ai_completion"),
                status=status.HTTP_402_PAYMENT_REQUIRED,
            )
        return Response(value)


class MeteredPromptRequestSerializer(serializers.Serializer):
    """Send one prompt to a catalogue model and get the reply, metered."""

    # Deliberately a comment, not more docstring: drf-spectacular publishes a
    # serializer's docstring as the schema description in the PUBLIC f2z.yaml.
    #
    # Every field here changes what we ask the provider for and therefore how
    # many 2Z the requester has to hold, so every one of them is declared
    # (AGENTS.md: a value that reaches the database or the charge must be
    # visible to a generated client).

    model = serializers.UUIDField(
        help_text=(
            "The id of the model to prompt, as listed by GET /api/ai/models/."
        ),
    )
    prompt = serializers.CharField(
        # The prompt is content, not a form field: stripping it would change
        # the tokens we price and the tokens we send.
        trim_whitespace=False,
        help_text="The prompt to send to the model.",
    )
    system_message = serializers.CharField(
        required=False,
        allow_null=True,
        allow_blank=True,
        trim_whitespace=False,
        help_text=(
            "System message for this request. Omit it to use the model's "
            "default system message; send an empty string for none."
        ),
    )
    quote_token = serializers.CharField(required=False, allow_blank=False)
    max_output_tokens = serializers.IntegerField(
        required=False,
        allow_null=True,
        min_value=1,
        max_value=MAX_REQUESTABLE_OUTPUT_TOKENS,
        help_text=(
            "How long a reply to ask for, in tokens. Omit it to get the "
            "longest reply the model can give for this prompt that your 2Z "
            "already cover. Naming a number larger than the model can produce "
            "-- or than the context window has left after the prompt -- is "
            "clamped down to that, never rejected; naming one your 2Z do not "
            "cover answers 402 with the number of 2Z it would take."
        ),
    )


#``jsonPayload.event`` of the line:func:`_clamp_to_ceiling` writes when the
#clamp binds. Contract with ``monitoring/log-metrics/ai-charge-clamped.json``
#and the ``prod | AI charge clamped`` policy; renaming it blinds both.
AI_CHARGE_CLAMPED_EVENT = "ai_charge_clamped"


def charge_clamped_payload(ai_model, input_tokens, output_tokens, metered,
                           charged, *, endpoint, user_id, usage=None):
    """The ``ai_charge_clamped`` line, as a dict.

    A builder of its own so ``py/gcp/tests/test_alert_policy_contract.py`` can
    call it and check every field the log metric extracts is really here.

    Three amounts, because they answer different questions:

    * ``uncharged_2z`` -- ``metered_2z - charged_2z``: the retail price we
      did not collect. Includes the markup and the whole-2Z rounding.
    * ``provider_cost_2z`` -- what the provider billed us for the reply, at
      the model's cost columns before markup, in 2Z (100 2Z = $1).
    * ``absorbed_2z`` -- ``provider_cost_2z - charged_2z``, floored at 0: what
      the platform actually paid out of pocket. A clamp that bound only the
      markup reports 0 here. This is the number to sum.
    """
    provider_cost = (
        ai_model.get_provider_input_cost(
            int(input_tokens),
            cached_input_tokens=getattr(usage, "cached_input_tokens", 0),
            cache_write_tokens=getattr(usage, "cache_write_tokens", 0),
            cache_write_1h_tokens=getattr(usage, "cache_write_1h_tokens", 0),
        )
        + Decimal(int(output_tokens)) * Decimal(str(ai_model.output_price))
    ) * 100
    absorbed = max(Decimal(0), provider_cost - Decimal(int(charged)))
    return {
        "severity": "WARNING",
        "message": (
            f"AI charge clamped to the admitted ceiling on "
            f"{ai_model.provider}/{ai_model.model}: metered {metered} 2Z "
            f"for in={input_tokens} out={output_tokens} tokens, charged "
            f"{charged} 2Z"
        ),
        "event": AI_CHARGE_CLAMPED_EVENT,
        "endpoint": endpoint,
        "user_id": user_id,
        "provider": ai_model.provider,
        "model": ai_model.model,
        "input_tokens": int(input_tokens),
        "output_tokens": int(output_tokens),
        "reasoning_allowance_tokens": ai_model.get_reasoning_allowance(),
        "metered_2z": int(metered),
        "charged_2z": int(charged),
        "uncharged_2z": int(metered) - int(charged),
        "provider_cost_2z": float(round(provider_cost, 3)),
        "absorbed_2z": float(round(absorbed, 3)),
    }


def _clamp_to_ceiling(ai_model, input_tokens, output_tokens, max_price, *,
                      endpoint, user_id, usage=None):
    """The metered price, never above the ceiling the request was admitted at.

    When the clamp BINDS, the platform absorbs the difference. The likeliest
    cause is reasoning that a provider does not count against the
    output cap it was sent. xAI reports reasoning beside
    ``completion_tokens``. the ceiling includes a reasoning
    allowance for those models, so a clamp means the reasoning outran the
    allowance. That is a pricing gap someone has to see, and how much of it
    we paid has to be measurable.

    So the line is ONE JSON object (Cloud Logging promotes it to
    ``jsonPayload``); see:func:`charge_clamped_payload` for its fields. A
    plain ``%s`` WARNING on this logger reaches the root handler as
    unstructured text, which a metric can only match by wording.
    """
    metered = ai_model.get_tuzi_price(
        input_tokens, output_tokens,
        cached_input_tokens=getattr(usage, "cached_input_tokens", 0),
        cache_write_tokens=getattr(usage, "cache_write_tokens", 0),
        cache_write_1h_tokens=getattr(usage, "cache_write_1h_tokens", 0),
    )
    if metered > max_price:
        logger.warning(json.dumps(charge_clamped_payload(
            ai_model, input_tokens, output_tokens, metered, max_price,
            endpoint=endpoint, user_id=user_id, usage=usage,
        ), separators=(",", ":")))
    return min(metered, max_price)


EXPECTED_ACTOR_PARAMETER = OpenApiParameter(
    name="X-Expected-Actor",
    type=str,
    location=OpenApiParameter.HEADER,
    required=False,
    description=(
        "Optional authenticated user ID observed when this paid request was "
        "prepared. If it differs from the current authenticated user, the "
        "request is refused with 409 account_changed before a receipt claim, "
        "provider call, or debit. It never chooses the actor or supplies "
        "persisted data."
    ),
)


LEGACY_REPLAY_ONLY_PARAMETER = OpenApiParameter(
    name="X-Require-Existing-Receipt",
    type=bool,
    location=OpenApiParameter.HEADER,
    required=False,
    description=(
        "For an adopted pre-choice retry key, only replay an existing image "
        "receipt. If no receipt exists, refuse before provider I/O or debit."
    ),
)


class ImageFieldValidationErrorSerializer(serializers.Serializer):
    """DRF maps invalid image request fields to lists of validation messages."""


class ImageFieldValidationErrorExtension(OpenApiSerializerExtension):
    target_class = ImageFieldValidationErrorSerializer

    def map_serializer(self, auto_schema, direction):
        return {"type": "object", "minProperties": 1,
            "additionalProperties": {"type": "array", "items": {"type": "string"}}}


class ImageSafetyRefusalSerializer(serializers.Serializer):
    """A terminal provider safety refusal, with no customer charge."""

    code = serializers.ChoiceField(choices=["moderation_blocked"])
    key_resolved = serializers.BooleanField()
    detail = serializers.CharField()


class ImageRequestPreconditionErrorSerializer(serializers.Serializer):
    """An actor or replay precondition refused before paid image work."""

    code = serializers.ChoiceField(
        choices=("account_changed", "legacy_replay_unavailable")
    )
    detail = serializers.CharField()


class MeteredPromptResponseSerializer(serializers.Serializer):
    """The reply and exactly what it cost."""

    response = serializers.CharField(help_text="The model's reply.")
    provider = serializers.CharField(help_text="The provider that received the prompt.")
    model = serializers.CharField(help_text="The provider's model identifier.")
    display_name = serializers.CharField(help_text="The catalog name shown to the user.")
    tuzis_charged = serializers.IntegerField(
        help_text="The 2Z debited for this request.",
    )
    input_tokens = serializers.IntegerField(
        help_text=(
            "Total prompt tokens reported by the provider, including cached "
            "and cache-write input; falls back to the model tokenizer when "
            "usage is unavailable."
        ),
    )
    output_tokens = serializers.IntegerField(
        help_text=(
            "Output tokens billed for the reply, including any hidden "
            "reasoning tokens the provider bills as output."
        ),
    )


class MeteredPromptView(views.APIView):
    # Synchronous, model-aware, metered prompt. One prompt in, one
    # reply out, priced by the same `AIModel` metering as the conversation
    # path. Provider input usage is split into disjoint ordinary, cached and
    # cache-write classes; provider output usage is billed at the output rate.
    # Nothing is persisted except the 2Z movement and its receipt, so a
    # client (ZUULI) can honour the user's model choice and show the real
    # per-message cost without holding a WebSocket or a Conversation row.
    #
    # The legacy `/api/openai/prompt` (a flat 1 2Z for a hardcoded
    # completions model) is untouched; this is the metered replacement.
    #
    # Deliberately a comment, not a docstring: drf-spectacular publishes view
    # docstrings as operation descriptions in the public f2z.yaml.
    permission_classes = [IsAuthenticated]

    # Issue: opt OUT of `AtomicMiddleware`'s request-wide transaction.
    # The provider call below is 10-90s of third-party I/O and must not hold
    # a Cloud SQL connection `idle in transaction`. The view owns its own
    # atomicity: the explicit `transaction.atomic()` around the debit below,
    # exactly as `PromptResponseViewSet.create` does.
    atomic_request = False

    # JSON only: the Response is rendered AFTER the money transaction has
    # committed, and encoding a dict of primitives cannot fail transiently.
    # `BrowsableAPIRenderer` would run templates and queries in that
    # post-commit window, which is the transient-failure class that turns a
    # 500 into a retry into a double charge. See PromptResponseViewSet.
    renderer_classes = [JSONRenderer]

    @extend_schema(
        parameters=[PROVIDER_IDEMPOTENCY_PARAMETER, EXPECTED_ACTOR_PARAMETER],
        request=MeteredPromptRequestSerializer,
        responses={
            200: MeteredPromptResponseSerializer,
            400: AI_REQUEST_ERROR_RESPONSE,
            409: AI_REQUEST_ERROR_RESPONSE,
            402: InsufficientFundsErrorSerializer,
            503: AI_SERVICE_ERROR_RESPONSE,
        },
        description=(
            "Send one prompt to a catalogue model and get the reply back "
            "synchronously. The charge is metered on the prompt and reply "
            "token counts at the model's published prices and debited from "
            "your 2Z balance; the response says exactly what was charged. "
            "The most this request can be charged (the prompt plus the "
            "longest reply asked for, plus a reasoning allowance on models "
            "whose output limit does not cover their reasoning) is held from "
            "your balance before the model is called -- refused with 402 if "
            "you do not hold it -- and the difference is returned when the "
            "reply is priced. No transcript "
            "is kept: use the conversation endpoints for one. Send an "
            "Idempotency-Key to be able to retry a dropped connection and "
            "get the same reply back without paying twice; the reply is "
            "kept with that key for replay."
        ),
    )
    def post(self, request):
        body = MeteredPromptRequestSerializer(data=request.data)
        if not body.is_valid():
            return Response(
                _ai_not_charged_payload(body.errors),
                status=status.HTTP_400_BAD_REQUEST,
            )
        expected_actor = request.headers.get("X-Expected-Actor")
        if expected_actor and expected_actor != str(request.user.pk):
            return Response(
                {
                    "code": "account_changed",
                    "detail": (
                        "The signed-in account changed. Return to the original "
                        "account before retrying this paid request."
                    ),
                },
                status=status.HTTP_409_CONFLICT,
            )
        prompt = body.validated_data["prompt"]
        requested_output = body.validated_data.get("max_output_tokens")
        system_message = body.validated_data.get("system_message")
        quote_token = body.validated_data.get("quote_token")

        # Keep the historical fingerprint shape byte-for-byte compatible.
        # The catalogue UUID is the submitted model choice; mutable provider
        # metadata belongs in the claim snapshot below, never the hash.
        # Completed claims are checked before current policy or quote data.
        requested_model = AIModel.objects.filter(
            pk=body.validated_data["model"],
        ).first()
        stable_intent = {
            "action": "ai_prompt",
            "intent": "ai_prompt",
            "model": str(body.validated_data["model"]),
            "prompt": prompt,
            "system_message": system_message,
            "max_output_tokens": requested_output,
        }
        claim, duplicate_response = _provider_claim(
            request,
            "ai_prompt",
            stable_intent,
            intent_snapshot=_creator_model_intent_snapshot(requested_model),
            # The stream endpoint has no upstream idempotency contract. Once
            # a call may have reached the provider, a stale claim must never
            # make an automatic second paid call.
            allow_stale_takeover=True,
            stale_takeover_requires_matching_hash=True,
        )
        if duplicate_response is not None:
            return duplicate_response

        # A brand-new claim for a model that no longer exists cannot have
        # reached a provider. Release it and return the ordinary 404 before
        # classifying missing historical snapshots as uncertain outcomes.
        # Existing stale claims still take the conservative unknown-outcome
        # path below because their original provider call may have escaped.
        if (
            requested_model is None
            and claim is not None
            and not getattr(claim, "stale_takeover", False)
        ):
            idempotency.release(claim)
            return Response(
                {"detail": "No such model."}, status=status.HTTP_404_NOT_FOUND
            )

        if claim is not None and getattr(claim, "stale_takeover", False):
            result = {
                "code": "provider_outcome_unknown",
                "detail": (
                    "The original text request may have reached its provider, "
                    "so it was not sent again. Review your balance before "
                    "starting a new request."
                ),
            }
            from dj.apps.ledger import api as ledger_api
            with transaction.atomic():
                ledger_api.lock_creator(request.user.pk)
                reservation = _provider_reservation(request.user, claim.key, "ai_prompt")
                snapshot = (claim.response_body or {}).get("_provider_intent_snapshot")
                operation = {
                    "provider": snapshot.get("provider") if isinstance(snapshot, dict) else None,
                    "model": snapshot.get("model") if isinstance(snapshot, dict) else None,
                    "billing_state": "unknown", "billed_usd": None,
                    "budget_state": "uncertain",
                    "reserved_2z": str(reservation.amount) if reservation is not None else "0",
                    "reservation_released": reservation is None,
                }
                if reservation is not None:
                    ledger.release_reservation(reservation)
                    operation["reservation_released"] = True
                claim.finish(status.HTTP_409_CONFLICT, {
                    **result, "_provider_intent_snapshot": snapshot,
                    "_prompt_operation": operation,
                })
            return Response(result, status=status.HTTP_409_CONFLICT)

        if claim is not None:
            original_snapshot = (claim.response_body or {}).get(
                "_provider_intent_snapshot",
            )
            if not isinstance(original_snapshot, dict):
                result = {
                    "code": "provider_outcome_unknown",
                    "detail": (
                        "This request began before provider terms were recorded. "
                        "Its outcome cannot be safely replayed; review your balance "
                        "before starting a new request."
                    ),
                }
                claim.finish(status.HTTP_409_CONFLICT, result)
                return Response(result, status=status.HTTP_409_CONFLICT)
            if original_snapshot != _creator_model_intent_snapshot(requested_model):
                return Response(
                    {"detail": "The original text request is unresolved under a different model or disclosure. Review it before starting another request."},
                    status=status.HTTP_409_CONFLICT,
                )

        # The model is looked up in the same catalogue GET /api/ai/models/
        # publishes, so a client can only name what it can see. `is_ga=False`
        # rows are not in that catalogue and answer 404 like the catalogue's
        # own `retrieve` does; a row that IS in the lineup but flagged off
        # (`is_enabled=False`, or a policy-disabled provider) answers the
        # same clean 409 the conversation path gives, before anything costs
        # anything.
        if requested_model is None or not requested_model.is_ga:
            idempotency.release(claim)
            return Response(
                {"detail": "No such model."}, status=status.HTTP_404_NOT_FOUND)
        ai_model = requested_model
        if not AIModel.objects.selectable().filter(
            pk=ai_model.pk, input_price__gt=0, output_price__gt=0,
        ).exists():
            idempotency.release(claim)
            return model_unavailable_response(ai_model)

        # STEP 0 -- ADMISSION. Price the CEILING of this request and refuse
        # it here if the requester's 2Z do not cover it, BEFORE the provider
        # is called ( §3.1). Same shape as PromptResponseViewSet.create,
        # minus the transcript: the payload is the system message and the
        # prompt, and `input_tokens` is exact for it.
        if system_message is None:
            system_message = ai_model.system_message
        messages = []
        if system_message:
            messages.append({"role": "system", "content": system_message})
        messages.append({"role": "user", "content": prompt})
        try:
            input_tokens = num_tokens_from_messages(messages, ai_model.model)
        except Exception as exc:
            idempotency.release(claim)
            return _ai_error_response(exc, model_label=str(ai_model))

        # A single turn has nothing to trim. A prompt that does not leave the
        # model's context window room for a reply would reach the provider as
        # a 400 and come back as "this model isn't available right now",
        # which is a lie: it is the prompt, and the client can fix it.
        # Conservative count for the window (refusal + output cap), legacy
        # count for the charge -- see the conversation endpoint.
        window_tokens = count_prompt_tokens(messages, ai_model.model)
        if window_tokens > ai_model.get_input_token_budget():
            idempotency.release(claim)
            return Response(
                {
                    "detail": (
                        f"That prompt is {window_tokens} tokens; "
                        f"{ai_model.display_name} accepts at most "
                        f"{ai_model.get_input_token_budget()} for one request."
                    ),
                    "charge_status": "not_charged",
                    "tuzis_charged": 0,
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # The reply length is the requester's to choose and to cover: a named
        # number is clamped to what the model and the remaining window can
        # deliver; nothing named means the longest reply their 2Z already
        # cover, never shorter than MIN_REQUEST_OUTPUT_TOKENS. The single
        # check below prices whichever one it is and is the only gate.
        if requested_output is None:
            output_cap = min(
                ai_model.get_request_output_cap(window_tokens),
                max(MIN_REQUEST_OUTPUT_TOKENS,
                    ai_model.get_affordable_output_tokens(
                        input_tokens, request.user.tuzis)),
            )
        else:
            output_cap = ai_model.get_request_output_cap(
                window_tokens, requested_output)

        # The ceiling is HELD, not merely checked (unlike the conversation
        # path, which checks and then debits after generating -- the
        # authorize-then-capture gap  leaves open). Without the hold, N
        # concurrent requests with different idempotency keys all pass a
        # balance-only read, all reach the provider (we are billed N times),
        # and only one debit succeeds -- withholding the other N-1 replies
        # does not recover their provider cost. Found by the codex
        # adversarial review. `ledger.reserve` moves `max_price` out of the
        # spendable balance under the Creator row lock and commits before
        # the provider is called, so a concurrent request sees the reduced
        # balance and is refused here. The hold is never held across provider
        # I/O: it is settled or released below, and a hold orphaned by a
        # killed worker is swept by the periodic L2 expiry worker (or lazily
        # by the next reservation for that account after 15 min, past the 170s generation
        # deadline). Same mechanism as ImageView.
        max_price = ai_model.get_admission_price(input_tokens, output_cap)
        if quote_token is not None and quote_token != _creator_prompt_quote_token(
            ai_model, prompt, system_message, requested_output, input_tokens,
            window_tokens, output_cap, max_price,
        ):
            idempotency.release(claim)
            return Response(
                {"detail": "The model price or settings changed. Review the updated quote before submitting."},
                status=status.HTTP_409_CONFLICT,
            )
        reservation = None
        if max_price > 0:
            operation_key = idempotency.request_key(request) or uuid.uuid4()
            try:
                reservation = ledger.reserve(
                    request.user, max_price,
                    scope="ai_prompt", operation_key=operation_key,
                )
            except ledger.InsufficientFunds as exc:
                idempotency.release(claim)
                return Response(
                    _ai_not_charged_payload(
                        ledger.insufficient_funds_payload(exc, action="ai_prompt")
                    ),
                    status=status.HTTP_402_PAYMENT_REQUIRED,
                )

        # STEP 1 -- generate, OUTSIDE any transaction. Failures
        # before the provider returns a stream release the hold. An accepted
        # stream that is interrupted settles reported usage or the visible
        # estimate before the clean 503 is returned. `output_cap` is handed
        # through so the length
        # admitted above and the length asked of the provider are identical.
        try:
            generation = generate_reply(
                ai_model, messages, input_tokens, output_cap,
                label=f"metered prompt on {ai_model.model}",
            )
        except GenerationInterrupted as exc:
            try:
                error = _ai_error_response(
                    exc, model_label=f"metered prompt on {ai_model.model}")
                price = _clamp_to_ceiling(
                    ai_model, exc.input_tokens, exc.settlement_output_tokens,
                    max_price, endpoint="ai_prompt", user_id=request.user.pk, usage=exc.usage)
                error = _ai_settled_interruption_response(error, price)
                with transaction.atomic():
                    ledger.settle_reservation(reservation, amount=price)
                    Event.objects.create(
                        read=False,
                        type="CHAT2Z",
                        receiving_user=request.user,
                        contributor=request.user,
                        amount=price,
                        content_type=ContentType.objects.get_for_model(ai_model),
                        object_id=ai_model.id,
                    )
                    if claim is not None:
                        claim.finish(error.status_code, error.data)
            except ledger.InsufficientFunds as settle_exc:
                ledger.release_reservation(reservation)
                idempotency.release(claim)
                return Response(
                    _ai_not_charged_payload(
                        ledger.insufficient_funds_payload(
                            settle_exc, action="ai_prompt"
                        )
                    ),
                    status=status.HTTP_402_PAYMENT_REQUIRED,
                )
            except Exception:
                ledger.release_reservation(reservation)
                idempotency.release(claim)
                raise
            return error
        except Exception as exc:
            ledger.release_reservation(reservation)
            if claim is not None and _provider_rejected_before_generation(exc):
                idempotency.release(claim)
            return _ai_error_response(exc, model_label=str(ai_model))

        # STEP 2 -- settle the L2 reservation at the actual fixed price.
        # Settlement, the receipt and idempotency response commit together.
        # A swept hold or a rollout-era balance shortfall refuses the reply;
        # the wrapper raises inside this transaction, rolling back any partial
        # collection. Existing pre-L2 reservations keep their legacy recovery
        # path and are never converted into a second economic hold.
        #
        # The charge is CLAMPED to the ceiling the requester was admitted
        # against. The provider enforces `output_cap` in ITS tokens; the reply
        # is priced in tiktoken's, and the two are not the same unit, so a
        # capped reply can retokenize locally to more than the cap. Without
        # the clamp that is either a debit above the authorized hold or a 402
        # after the provider bill for a reply that was delivered as asked.
        # Found by the codex adversarial review. `output_tokens` is still
        # reported as counted; only the money is bounded. it is
        # the provider's own count (hidden reasoning included) whenever the
        # provider reported usage, and the tiktoken estimate only when it did
        # not; the clamp covers both, including reasoning a provider does not
        # count against `output_cap`.
        try:
            response_text, input_tokens, output_tokens, usage = generation
            price = _clamp_to_ceiling(
                ai_model, input_tokens, generation.settlement_output_tokens,
                max_price,
                endpoint="ai_prompt", user_id=request.user.pk, usage=usage)
            data = {
                "response": response_text,
                "provider": ai_model.provider,
                "model": ai_model.model,
                "display_name": ai_model.display_name,
                "tuzis_charged": price,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            }
            with transaction.atomic():
                ledger.settle_reservation(reservation, amount=price)
                Event.objects.create(
                    read=False,
                    type="CHAT2Z",
                    receiving_user=request.user,
                    contributor=request.user,
                    amount=price,
                    content_type=ContentType.objects.get_for_model(ai_model),
                    object_id=ai_model.id,
                )
                if claim is not None:
                    claim.finish(status.HTTP_200_OK, data)
        except ledger.InsufficientFunds as exc:
            # The rollback above undid the release too. Return the hold from
            # OUTSIDE the failed transaction so the user is not left with
            # their balance depleted until the stale sweep 15 minutes later.
            # Idempotent: a hold the sweep already returned is a no-op. Found
            # by the codex adversarial review.
            ledger.release_reservation(reservation)
            idempotency.release(claim)
            return Response(
                _ai_not_charged_payload(
                    ledger.insufficient_funds_payload(exc, action="ai_prompt")
                ),
                status=status.HTTP_402_PAYMENT_REQUIRED,
            )
        except Exception:
            # Same for a settlement that dies for any other reason (a database
            # failure writing the receipt): nothing was charged, so nothing
            # may stay held. The error itself still surfaces as a 500 -- see
            # the note at the end of PromptResponseViewSet.create.
            ledger.release_reservation(reservation)
            idempotency.release(claim)
            raise
        return Response(data)


class ImageView(views.APIView):
    # Was `@permission_classes(...)` on the class, which DRF only
    # honours on @api_view functions. (Kept from  -- fail-closed.)
    permission_classes = [IsAuthenticated]

    # The view owns the short charge + persistence transaction below. It must
    # not inherit AtomicMiddleware's outer transaction: rollback cleanup runs
    # after that block exits and needs to commit a storage-recovery outbox row
    # even when image persistence failed.
    atomic_request = False
    # Rendering a browsable HTML response after the transaction commits would
    # reopen a post-commit failure/double-charge window. The API returns a URL
    # string, so JSON is the complete response contract here.
    renderer_classes = [JSONRenderer]

    @extend_schema(
        parameters=[
            IMAGE_IDEMPOTENCY_PARAMETER,
            EXPECTED_ACTOR_PARAMETER,
            LEGACY_REPLAY_ONLY_PARAMETER,
        ],
        request=ImageGenerationRequestSerializer,
        responses={
            200: OpenApiResponse(
                response={
                    "oneOf": [
                        {"type": "string"},
                        {
                            "type": "object",
                            "properties": {
                                "url": {"type": "string"},
                                "provider": {"type": "string"},
                                "model": {"type": "string"},
                            },
                            "required": ["url", "provider", "model"],
                        },
                    ],
                },
                description="Legacy callers receive a URL; choice-aware callers also receive model attribution.",
            ),
            400: OpenApiResponse(
                response=AIRequestErrorProxySerializer(
                    component_name="ImageRequestError",
                    serializers=[ImageSafetyRefusalSerializer, AIParserErrorSerializer,
                                 AIIdempotencyErrorSerializer, ImageFieldValidationErrorSerializer],
                    resource_type_field_name=None, many=False,
                ),
                description=(
                    "A present non-UUIDv4 Idempotency-Key is refused with "
                    "idempotency_key_required before receipt creation, charge, "
                    "or provider dispatch. Also includes provider safety "
                    "refusals, malformed JSON, and request field errors."
                ),
            ),
            402: InsufficientFundsErrorSerializer,
            429: OpenApiResponse(
                response={
                    "type": "object",
                    "properties": {
                        "code": {"type": "string", "enum": ["image_daily_budget_exceeded"]},
                        "key_resolved": {"type": "boolean"},
                        "detail": {"type": "string"},
                    },
                    "required": ["code", "key_resolved", "detail"],
                },
                description="The authenticated account's daily fal allowance is exhausted; no hold or provider call was started. Existing receipts can still be replayed.",
            ),
            409: OpenApiResponse(
                response=ImageRequestPreconditionErrorSerializer,
                description=(
                    "The authenticated account differs from X-Expected-Actor; "
                    "no receipt, provider call, or debit was started."
                ),
            ),
        },
        description=(
            "Generate an image, save it to the authenticated user's uploads, "
            f"and return the stored WebP URL. Costs {IMAGE_COST} 2Zs."
        ),
    )
    def post(self, request):
        serializer = ImageGenerationRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        expected_actor = request.headers.get("X-Expected-Actor")
        if expected_actor and expected_actor != str(request.user.pk):
            return Response(
                {
                    "code": "account_changed",
                    "detail": (
                        "The signed-in account changed. Return to the original "
                        "account before retrying this paid request."
                    ),
                },
                status=status.HTTP_409_CONFLICT,
            )
        prompt = serializer.validated_data["prompt"]
        submitted_choice = serializer.validated_data.get("choice")
        submitted_snapshot = serializer.validated_data.get("choice_snapshot")
        size = serializer.validated_data["size"]
        hosted_image = submitted_choice == "fal-flux-schnell"
        if hosted_image and idempotency.request_key(request) is None:
            return Response({"code": "idempotency_key_required",
                             "error": "A valid UUIDv4 Idempotency-Key header is required."},
                            status=status.HTTP_400_BAD_REQUEST)
        current_cover_snapshot = _cover_choice_snapshot(submitted_choice or "openai-image")
        intent = (
            {"action": "ai_image", "intent": "openai_image", "prompt": prompt, "size": size}
            if submitted_choice is None
            else {
                "action": "ai_image", "intent": "creator_cover",
                "choice": submitted_choice, "prompt": prompt, "size": size,
            }
        )
        claim_snapshot = {
            "choice_snapshot": submitted_snapshot,
            "server_snapshot": current_cover_snapshot,
            "legacy_request": submitted_choice is None,
        }
        current_provider = (
            current_cover_snapshot.get("provider")
            if isinstance(current_cover_snapshot, dict)
            else ("fal" if hosted_image else "openai")
        )
        current_model = (
            current_cover_snapshot.get("model")
            if isinstance(current_cover_snapshot, dict)
            else None
        )
        operation_key = idempotency.request_key(request)
        if (
            operation_key is None
            and not hosted_image
            and request.headers.get("Idempotency-Key") is None
        ):
            # Keep the historical headerless OpenAI API, but give its hold and
            # provider phase a private durable receipt key.
            operation_key = str(uuid.uuid4())

        legacy_openai_payload = {
            "action": "ai_image", "intent": "openai_image",
            "prompt": prompt, "size": size,
        }
        legacy_fal_payload = {
            "action": "ai_image", "intent": "fal_flux_schnell_image",
            "prompt": prompt, "size": size,
        }
        compatible_payloads = [legacy_openai_payload, legacy_fal_payload]
        compatible_intents = {
            idempotency.fingerprint(intent): current_provider,
            idempotency.fingerprint(legacy_openai_payload): "openai",
            idempotency.fingerprint(legacy_fal_payload): "fal",
        }
        for choice_id, choice_provider in (
            ("openai-image", "openai"),
            ("fal-flux-schnell", "fal"),
        ):
            choice_intent = {
                "action": "ai_image", "intent": "creator_cover",
                "choice": choice_id, "prompt": prompt, "size": size,
            }
            if choice_intent != intent:
                compatible_payloads.append(choice_intent)
            compatible_intents[
                idempotency.fingerprint(choice_intent)
            ] = choice_provider

        def resolve_stale_image_intent(stale_claim, *, previous_record=None):
            """Resolve only this actor's exact provider/prompt/options receipt."""
            body = stale_claim.response_body
            body = body if isinstance(body, dict) else {}
            source_hash = (
                previous_record.request_hash
                if previous_record is not None else stale_claim.request_hash
            )
            source_provider = compatible_intents.get(source_hash)
            if source_provider not in {"openai", "fal"}:
                return False
            operation = body.get("_image_operation")
            operation = dict(operation) if isinstance(operation, dict) else {}
            snapshot = body.get("_provider_intent_snapshot")
            snapshot = snapshot if isinstance(snapshot, dict) else {}
            original_server_snapshot = snapshot.get("server_snapshot")
            if isinstance(original_server_snapshot, dict):
                original_provider = original_server_snapshot.get("provider")
                original_choice = original_server_snapshot.get("id")
                provider_for_choice = {
                    "openai-image": "openai",
                    "fal-flux-schnell": "fal",
                }.get(original_choice)
                if (
                    provider_for_choice is None
                    or provider_for_choice != original_provider
                    or original_provider != source_provider
                ):
                    return False
                if snapshot.get("legacy_request") is True and source_provider != "openai":
                    return False

            recorded_provider = operation.get("provider")
            if recorded_provider is not None and recorded_provider != source_provider:
                return False
            recorded_model = operation.get("model")
            snapshot_model = (
                original_server_snapshot.get("model")
                if isinstance(original_server_snapshot, dict) else None
            )
            if (
                recorded_model is not None
                and snapshot_model is not None
                and recorded_model != snapshot_model
            ):
                return False
            source_model = recorded_model or snapshot_model

            original_intent_matches_current = (
                isinstance(original_server_snapshot, dict)
                and original_server_snapshot == current_cover_snapshot
                and snapshot.get("choice_snapshot") == submitted_snapshot
                and snapshot.get("legacy_request") is (submitted_choice is None)
            )

            unreserved_fal_claim = (
                "_image_operation" not in body
                and body.get("operation") == "ai_image"
                and body.get("state") == "provider_pending"
                and source_provider == "fal"
                and isinstance(original_server_snapshot, dict)
                and original_server_snapshot.get("provider") == "fal"
            )

            current_choice_is_valid = (
                submitted_choice is None
                or (
                    current_cover_snapshot is not None
                    and submitted_choice in ("openai-image", "fal-flux-schnell")
                    and submitted_snapshot == _cover_choice_snapshot_token(
                        current_cover_snapshot,
                    )
                )
            )
            if (
                source_provider == "openai"
                and current_provider == "openai"
                and source_model == current_model
                and operation.get("provider_request_state") == "not_started"
                and current_choice_is_valid
                and original_intent_matches_current
            ):
                # The durable marker precedes the SDK call. Since OpenAI does
                # not document idempotency-key retention, only this proven
                # pre-call case can repeat the same model/key.
                return None

            if source_provider != current_provider and not current_choice_is_valid:
                return False

            terminal_body = dict(body)
            terminal_body.pop("operation", None)
            terminal_body.pop("state", None)
            operation.setdefault("provider", source_provider)
            if source_model is not None:
                operation.setdefault("model", source_model)
            phase = operation.get("provider_request_state")
            definitely_not_started = (
                phase == "not_started" or unreserved_fal_claim
            )
            operation.setdefault("billing_state", "not_billed" if definitely_not_started else "unknown")
            operation.setdefault("billed_usd", "0" if definitely_not_started else None)
            if source_provider == "fal":
                if definitely_not_started:
                    operation.update({
                        "budget_state": "not_reserved",
                        "budget_reserved_usd": "0",
                        "billing_state": "not_billed",
                        "billed_usd": "0",
                    })
                elif operation.get("budget_state") == "reserved":
                    operation["budget_state"] = "uncertain"
            terminal_body["_image_operation"] = operation
            reservation_state = "unknown" if source_provider == "openai" and not definitely_not_started else "released"
            if definitely_not_started:
                result = {
                    "code": "image_generation_not_started",
                    "key_resolved": True,
                    "credit_reservation_state": "released",
                    "detail": "The original image request stopped before provider dispatch. Start a new request to try again.",
                }
                response_status = status.HTTP_409_CONFLICT
            else:
                result = {
                    "code": "image_generation_outcome_uncertain",
                    "key_resolved": True,
                    "credit_reservation_state": reservation_state,
                    "detail": IMAGE_OUTCOME_UNCERTAIN_DETAIL,
                }
                response_status = status.HTTP_503_SERVICE_UNAVAILABLE
            terminal_body.update(result)

            with transaction.atomic():
                from dj.apps.ledger import api as ledger_api
                ledger_api.lock_creator(request.user.pk)
                reservation = _image_reservation(request.user, stale_claim.key)
                if reservation_state == "released" and reservation is not None:
                    ledger.release_reservation(reservation)
                # Persist unknown on the receipt: OpenAI's 15-minute local
                # hold is temporary and must not appear active on later replay.
                if source_provider == "openai" and not definitely_not_started:
                    terminal_body["credit_reservation_state"] = "unknown"
                stale_claim.finish(response_status, terminal_body)

            public_result = dict(result)
            if source_provider == "openai" and not definitely_not_started:
                public_result["credit_reservation_state"] = (
                    "held" if reservation is not None else "unknown"
                )
            return Response(public_result, status=response_status)

        claim, duplicate_response = _provider_claim(
            request,
            "ai_image",
            intent,
            replay_field="value",
            intent_snapshot=claim_snapshot,
            stale_takeover_requires_matching_hash=True,
            legacy_payloads=compatible_payloads,
            key_override=operation_key,
            initial_body={
                "operation": "ai_image",
                "state": "provider_pending",
                "_image_operation": {
                    "provider": current_provider,
                    "model": current_model,
                    "provider_request_state": "not_started",
                    "key_source": (
                        "server_generated"
                        if request.headers.get("Idempotency-Key") is None
                        else "client"
                    ),
                },
            },
            resolve_stale_unfinished=resolve_stale_image_intent,
        )
        if duplicate_response is not None:
            return duplicate_response

        if request.headers.get("X-Require-Existing-Receipt", "").lower() in {"1", "true", "yes"}:
            if claim is None or not getattr(claim, "stale_takeover", False):
                if claim is not None:
                    idempotency.release(claim)
                return Response(
                    {
                        "code": "legacy_replay_unavailable",
                        "detail": (
                            "This saved legacy request has no server receipt to "
                            "replay. Review the current provider choice and "
                            "price, then start a new request."
                        ),
                    },
                    status=status.HTTP_409_CONFLICT,
                )

        current_snapshot_token = (
            _cover_choice_snapshot_token(current_cover_snapshot)
            if current_cover_snapshot is not None else None
        )
        if submitted_choice not in (None, "openai-image", "fal-flux-schnell"):
            idempotency.release(claim)
            return Response(
                {"detail": "This image model is no longer available."},
                status=status.HTTP_409_CONFLICT,
            )
        if claim is not None:
            original_snapshot = (claim.response_body or {}).get(
                "_provider_intent_snapshot",
            )
            if not isinstance(original_snapshot, dict):
                result = {
                    "code": "provider_outcome_unknown",
                    "detail": (
                        "This cover request began before provider terms were "
                        "recorded. Its outcome cannot be safely replayed; review "
                        "your balance before starting a new request."
                    ),
                }
                claim.finish(status.HTTP_409_CONFLICT, result)
                return Response(result, status=status.HTTP_409_CONFLICT)
            if (
                original_snapshot.get("server_snapshot") != current_cover_snapshot
                or original_snapshot.get("choice_snapshot") != submitted_snapshot
            ):
                return Response(
                    {"detail": "The original cover request has different provider or disclosure terms. Review them before starting another request."},
                    status=status.HTTP_409_CONFLICT,
                )
        if (
            current_cover_snapshot is None
            or (submitted_choice is not None
                and submitted_snapshot != current_snapshot_token)
        ):
            idempotency.release(claim)
            return Response(
                {"detail": "This image model is no longer available."},
                status=status.HTTP_409_CONFLICT,
            )
        selected_provider = current_cover_snapshot["provider"]
        selected_model = current_cover_snapshot["model"]
        if hosted_image:
            from . import hosted_image as hosted_image_provider
            try:
                _, provider_budget = hosted_image_provider.configuration()
                provider_price = hosted_image_provider.estimate_price(size)
            except hosted_image_provider.ImageProviderUnavailable:
                idempotency.release(claim)
                return Response({"detail": IMAGE_UNAVAILABLE_DETAIL}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
            try:
                budget_reserved = _reserve_hosted_image_budget(claim, provider_price, provider_budget)
            except hosted_image_provider.ImageProviderAccountBudgetExceeded:
                idempotency.release(claim)
                return Response({
                    "code": "image_daily_budget_exceeded", "key_resolved": True,
                    "detail": "Your daily fal image allowance has been reached. Try after midnight UTC or select another provider. No 2Z was charged for this request.",
                }, status=status.HTTP_429_TOO_MANY_REQUESTS)
            except Exception:
                idempotency.release(claim)
                raise
            if not budget_reserved:
                idempotency.release(claim)
                return Response({"detail": IMAGE_UNAVAILABLE_DETAIL}, status=status.HTTP_503_SERVICE_UNAVAILABLE)

        # Reserve the fixed provider cost under a short Creator-row lock.
        # The reservation commits before OpenAI is called, so concurrent image
        # requests cannot all pass a balance-only admission read. The lock is
        # not held across provider I/O; the hold is settled or released below.
        try:
            reservation = ledger.reserve(
                request.user,
                IMAGE_COST,
                scope="ai_image",
                operation_key=operation_key,
            )
        except ledger.InsufficientFunds as exc:
            idempotency.release(claim)
            return Response(
                ledger.insufficient_funds_payload(exc, action="ai_image"),
                status=status.HTTP_402_PAYMENT_REQUIRED,
            )
        file_obj = None
        webp_obj = None
        # The provider call and image conversion stay outside the money
        # transaction. This avoids holding a Cloud SQL connection and the
        # user's balance row lock across third-party I/O. OpenAI keeps its
        # existing request key; the fal adapter makes an ambiguous queued
        # request terminal rather than risking a duplicate generation.
        hosted_metadata = None
        call_started = time.monotonic()
        provider_request_started = False
        try:
            if hosted_image:
                if not _mark_image_provider_request_started(claim):
                    return Response(
                        {"code": "request_in_progress", "detail": "The original provider operation is still being resolved."},
                        status=status.HTTP_409_CONFLICT,
                    )
                provider_request_started = True
                hosted_result = hosted_image_provider.generate(
                    prompt, size,
                    on_accepted=lambda metadata: _record_hosted_image_request(
                        claim, metadata,
                    ),
                )
                image_data = hosted_result.image
                hosted_metadata = hosted_result.metadata
                # The existing upload contract stores PNG as the source file.
                with Image.open(BytesIO(image_data)) as img:
                    img.load()
                    png_output = BytesIO()
                    img.save(png_output, format="PNG")
                    image_data = png_output.getvalue()
                    webp_output = BytesIO()
                    img.save(webp_output, format="WEBP", quality=50)
                    webp_image_data = webp_output.getvalue()
            else:
                provider_kwargs = {
                    "prompt": prompt,
                    "n": 1,
                    "size": size,
                    "quality": IMAGE_QUALITY,
                    "output_format": "png",
                    "model": selected_model,
                }
                provider_kwargs["extra_headers"] = {
                    "Idempotency-Key": str(operation_key),
                }
                if not _mark_image_provider_request_started(claim):
                    return Response(
                        {"code": "request_in_progress", "detail": "The original provider operation is still being resolved."},
                        status=status.HTTP_409_CONFLICT,
                    )
                provider_request_started = True
                response = oai_client.images.generate(**provider_kwargs)
                image_base64 = response.data[0].b64_json
                if not image_base64:
                    raise ValueError("Image provider returned no image data")
                try:
                    image_data = base64.b64decode(image_base64, validate=True)
                except (binascii.Error, ValueError) as error:
                    raise ValueError(
                        "Image provider returned invalid image data"
                    ) from error

                # Validate and convert before writing either file to storage.
                with Image.open(BytesIO(image_data)) as img:
                    img.load()
                    output = BytesIO()
                    img.save(output, format="WEBP", quality=50)
                    webp_image_data = output.getvalue()
        except OpenAIBadRequestError as exc:
            # OpenAI's documented refusal response is definitively unbilled.
            ledger.release_reservation(reservation)
            error = _provider_error_payload(exc)
            code = error.get("code")
            if code not in PROMPT_REJECTION_CODES:
                idempotency.release(claim)
                logger.exception(
                    "Image generation rejected by provider (model=%s, code=%s)",
                    selected_model, code,
                )
                return Response(
                    {"detail": IMAGE_UNAVAILABLE_DETAIL},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            logger.warning(
                "Image generation refused by provider (user=%s, code=%s): %s",
                getattr(request.user, "pk", None), code, exc,
            )
            result = {
                "code": "image_generation_safety_refused",
                "key_resolved": True,
                "detail": _prompt_rejection_detail(error),
            }
            prior_body = claim.response_body
            prior_operation = (
                prior_body.get("_image_operation", {})
                if isinstance(prior_body, dict) else {}
            )
            operation = (
                dict(prior_operation) if isinstance(prior_operation, dict) else {}
            )
            operation.update({
                "provider": "openai",
                "model": selected_model,
                "provider_request_state": "rejected",
                "billing_state": "not_billed",
                "billed_usd": "0",
                "result_state": "safety_refused",
            })
            claim.finish(status.HTTP_400_BAD_REQUEST, {
                **result,
                "_image_operation": operation,
            })
            return Response(
                result,
                status=status.HTTP_400_BAD_REQUEST,
            )
        except Exception as exc:
            if not provider_request_started:
                # No provider request was dispatched. The key can be retried;
                # release is owner-fenced and the reservation belongs to this
                # exact operation key.
                ledger.release_reservation(reservation)
                idempotency.release(claim)
                raise
            if (
                isinstance(exc, OpenAIAPIStatusError)
                and exc.status_code in {401, 403, 404, 413, 422, 429}
            ):
                # Explicit rejection statuses prove this request was not
                # admitted. An exact-key retry is safe after this point.
                ledger.release_reservation(reservation)
                idempotency.release(claim)
                logger.warning(
                    "OpenAI image request was rejected before generation "
                    "(status=%s, model=%s)",
                    exc.status_code, selected_model,
                )
                return Response(
                    {"detail": IMAGE_UNAVAILABLE_DETAIL},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            if hosted_image and isinstance(
                exc,
                (hosted_image_provider.ImageProviderDefiniteFailure,
                 hosted_image_provider.ImageProviderAmbiguousFailure),
            ):
                ledger.release_reservation(reservation)
                if isinstance(exc, hosted_image_provider.ImageProviderDefiniteFailure):
                    idempotency.release(claim)
                    return Response(
                        {"detail": IMAGE_UNAVAILABLE_DETAIL},
                        status=status.HTTP_503_SERVICE_UNAVAILABLE,
                    )
                ambiguous = {
                    **getattr(exc, "metadata", {}),
                    "provider": hosted_image_provider.PROVIDER,
                    "model": hosted_image_provider.MODEL,
                    "model_version": hosted_image_provider.MODEL_VERSION,
                    "billing_state": "unknown",
                    "billed_usd": None,
                    "latency_seconds": round(time.monotonic() - call_started, 3),
                    "budget_reserved_usd": str(provider_price),
                    "budget_state": "uncertain",
                }
                _retain_hosted_budget_day(claim, ambiguous)
                moderated = isinstance(exc, hosted_image_provider.ImageProviderModerated)
                response_status = status.HTTP_400_BAD_REQUEST if moderated else status.HTTP_503_SERVICE_UNAVAILABLE
                public_result = {
                    "code": "moderation_blocked" if moderated else "image_generation_outcome_uncertain",
                    "key_resolved": True,
                    "credit_reservation_state": "released",
                    "detail": "Your prompt was rejected by the provider's safety system." if moderated else IMAGE_UNAVAILABLE_DETAIL,
                }
                claim.finish(response_status, {**public_result, "_image_operation": ambiguous})
                logger.warning(
                    "Hosted image operation ended without deliverable output "
                    "(provider=%s, model=%s, operation=%s, moderated=%s)",
                    ambiguous["provider"], ambiguous["model"], operation_key, moderated,
                )
                return Response(public_result, status=response_status)
            if hosted_image:
                # Provider output was malformed or unusable; the estimate is
                # retained while actual upstream billing stays unresolved.
                ledger.release_reservation(reservation)
                previous_body = claim.response_body if isinstance(claim.response_body, dict) else {}
                previous_operation = previous_body.get("_image_operation", {})
                previous_operation = previous_operation if isinstance(previous_operation, dict) else {}
                operation = {
                    **(previous_operation if hosted_metadata is None else {}),
                    **(hosted_metadata or {
                        "provider": hosted_image_provider.PROVIDER,
                        "model": hosted_image_provider.MODEL,
                        "model_version": hosted_image_provider.MODEL_VERSION,
                        "model_revision_status": hosted_image_provider.MODEL_REVISION_STATUS,
                        "billed_usd": None,
                        "estimated_usd": str(provider_price),
                        "billing_source": "fal_public_per_megapixel_tariff_estimate",
                    }),
                    "billing_state": "unknown",
                    "billed_usd": None,
                    "latency_seconds": round(time.monotonic() - call_started, 3),
                    "budget_reserved_usd": str(provider_price),
                    "budget_state": "uncertain",
                    "result_state": "invalid",
                }
                _retain_hosted_budget_day(claim, operation)
                claim.finish(status.HTTP_503_SERVICE_UNAVAILABLE, {
                    "code": "image_generation_outcome_uncertain",
                    "key_resolved": True,
                    "credit_reservation_state": "released",
                    "detail": IMAGE_UNAVAILABLE_DETAIL,
                    "_image_operation": operation,
                })
                logger.warning(
                    "Hosted image result was invalid "
                    "(provider=%s, model=%s, version=%s, estimated_usd=%s, operation=%s)",
                    operation.get("provider"), operation.get("model"),
                    operation.get("model_version"), operation.get("estimated_usd"),
                    operation_key,
                )
                return Response(
                    {
                        "code": "image_generation_outcome_uncertain",
                        "key_resolved": True,
                        "credit_reservation_state": "released",
                        "detail": IMAGE_UNAVAILABLE_DETAIL,
                    },
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            # Once the OpenAI request may be on the wire, neither its
            # undocumented idempotency-key behavior nor an SDK error proves
            # that a retry is bill-safe. Keep the 2Z hold and terminalize the
            # key so the browser only retries after a later explicit intent.
            operation = dict((claim.response_body or {}).get("_image_operation") or {})
            operation.update({
                "provider": "openai",
                "model": selected_model,
                "provider_request_state": "started",
                "provider_status": "UNKNOWN",
                "billing_state": "unknown",
                "billed_usd": None,
                "result_state": "provider_outcome_unknown",
            })
            public_result = {
                "code": "image_generation_outcome_uncertain",
                "key_resolved": True,
                "credit_reservation_state": "held",
                "detail": IMAGE_OUTCOME_UNCERTAIN_DETAIL,
            }
            claim.finish(status.HTTP_503_SERVICE_UNAVAILABLE, {
                **public_result,
                # Do not persist the temporary held state; a later replay may
                # arrive after the standard 15-minute hold expiry.
                "credit_reservation_state": "unknown",
                "_image_operation": operation,
            })
            logger.warning(
                "OpenAI image operation has an ambiguous outcome "
                "(model=%s, operation=%s)", selected_model, operation_key,
            )
            return Response(public_result, status=status.HTTP_503_SERVICE_UNAVAILABLE)

        # Persist the generated files and settle the authorization hold after
        # provider I/O has completed. These local writes, settlement, and the
        # receipt still commit together.
        try:
            with transaction.atomic():
                from dj.apps.g12f.models import Creator
                live_creator = Creator.objects.select_for_update().get(pk=request.user.pk)
                if (not live_creator.is_active
                        or live_creator.kt_account_epoch != request.user.kt_account_epoch):
                    raise PermissionDenied("Account authorization changed during image generation.")
                file_name_png = f"{slugify(prompt)[:64]}.png"
                file_data_png = ContentFile(image_data, name=file_name_png)
                file_obj = GenericFile.objects.create(
                    owner=request.user,
                    file=file_data_png,
                    title=prompt[:64],
                    mime_type="image/png",
                )
                base_name, _ = os.path.splitext(os.path.basename(file_obj.file.name))
                file_data_webp = ContentFile(
                    webp_image_data, name=f"{base_name}.webp"
                )
                webp_obj = Webp.objects.create(parent=file_obj, file=file_data_webp)
                webp_url = webp_obj.get_url()
                ledger.settle_reservation(reservation)
                result = {
                    "url": webp_url,
                    "provider": selected_provider,
                    "model": selected_model,
                }
                if claim is not None:
                    receipt = {"value": result if submitted_choice is not None else webp_url}
                    if hosted_metadata is not None:
                        with Image.open(BytesIO(image_data)) as stored_image:
                            result_size = stored_image.size
                        prior_body = claim.response_body
                        prior_operation = (
                            prior_body.get("_image_operation", {})
                            if isinstance(prior_body, dict) else {}
                        )
                        operation = {
                            **(prior_operation if isinstance(prior_operation, dict) else {}),
                            **hosted_metadata,
                            "billing_state": "unreconciled",
                            "budget_state": "uncertain",
                            "billed_usd": None,
                            "budget_reserved_usd": str(provider_price),
                            "request_latency_seconds": round(time.monotonic() - call_started, 3),
                            "result_state": "stored",
                            "result": {
                                "generic_file_id": file_obj.pk,
                                "webp_id": webp_obj.pk,
                                "width": result_size[0],
                                "height": result_size[1],
                            },
                        }
                        _retain_hosted_budget_day(claim, operation)
                        receipt["_image_operation"] = operation
                    else:
                        prior_body = claim.response_body
                        prior_operation = (
                            prior_body.get("_image_operation", {})
                            if isinstance(prior_body, dict) else {}
                        )
                        operation = (
                            dict(prior_operation)
                            if isinstance(prior_operation, dict) else {}
                        )
                        operation.update({
                            "provider": "openai",
                            "model": selected_model,
                            "provider_request_state": "completed",
                        })
                        receipt["_image_operation"] = operation
                    claim.finish(status.HTTP_200_OK, receipt)
        except Exception as exc:
            # Storage is outside the database transaction; queue cleanup for
            # any blobs created before a local write or receipt failed.
            delete_generated_files(webp_obj, file_obj)
            if isinstance(exc, ledger.InsufficientFunds) and hosted_metadata is None:
                # A stale takeover can release this exact hold during provider
                # I/O. Settlement rolls back generated rows; the new owner keeps
                # its terminal receipt. Fal also retains upstream spend below.
                return Response(
                    ledger.insufficient_funds_payload(exc, action="ai_image"),
                    status=status.HTTP_402_PAYMENT_REQUIRED,
                )
            if hosted_metadata is not None:
                ledger.release_reservation(reservation)
                operation = {
                    **(
                        claim.response_body.get("_image_operation", {})
                        if isinstance(claim.response_body, dict)
                        and isinstance(claim.response_body.get("_image_operation"), dict)
                        else {}
                    ),
                    **hosted_metadata,
                    "billing_state": "unreconciled",
                    "budget_state": "uncertain",
                    "billed_usd": None,
                    "budget_reserved_usd": str(provider_price),
                    "request_latency_seconds": round(time.monotonic() - call_started, 3),
                    "result_state": "storage_failed",
                    "result": None,
                }
                _retain_hosted_budget_day(claim, operation)
                claim.finish(status.HTTP_503_SERVICE_UNAVAILABLE, {
                    "code": "image_generation_outcome_uncertain",
                    "key_resolved": True,
                    "credit_reservation_state": "released",
                    "detail": IMAGE_UNAVAILABLE_DETAIL,
                    "_image_operation": operation,
                })
                logger.error(
                    "Hosted image result could not be stored "
                    "(provider=%s, model=%s, version=%s, estimated_usd=%s, request=%s, operation=%s)",
                    operation["provider"], operation["model"],
                    operation["model_version"], operation["estimated_usd"],
                    operation.get("request_id"),
                    operation_key,
                )
                return Response(
                    {
                        "code": "image_generation_outcome_uncertain",
                        "key_resolved": True,
                        "credit_reservation_state": "released",
                        "detail": IMAGE_UNAVAILABLE_DETAIL,
                    },
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            if provider_request_started:
                prior_body = claim.response_body
                prior_operation = (
                    prior_body.get("_image_operation", {})
                    if isinstance(prior_body, dict) else {}
                )
                operation = (
                    dict(prior_operation)
                    if isinstance(prior_operation, dict) else {}
                )
                operation.update({
                    "provider": "openai",
                    "model": selected_model,
                    "provider_request_state": "started",
                    "billing_state": "unknown",
                    "billed_usd": None,
                    "result_state": "storage_failed",
                })
                public_result = {
                    "code": "image_generation_outcome_uncertain",
                    "key_resolved": True,
                    "credit_reservation_state": "held",
                    "detail": IMAGE_UNAVAILABLE_DETAIL,
                }
                try:
                    claim.finish(status.HTTP_503_SERVICE_UNAVAILABLE, {
                        **public_result,
                        # This receipt can replay beyond the 15-minute local
                        # authorization hold, so do not persist ``held``.
                        "credit_reservation_state": "unknown",
                        "_image_operation": operation,
                    })
                except idempotency.DuplicateRequest:
                    return Response(
                        {**public_result, "credit_reservation_state": "unknown"},
                        status=status.HTTP_503_SERVICE_UNAVAILABLE,
                    )
                return Response(public_result, status=status.HTTP_503_SERVICE_UNAVAILABLE)
            ledger.release_reservation(reservation)
            idempotency.release(claim)
            raise

        if hosted_metadata is not None:
            logger.info(
                "Hosted image generated "
                "(provider=%s, model=%s, version=%s, estimated_usd=%s, "
                "latency_seconds=%.3f, request=%s, operation=%s)",
                hosted_metadata["provider"], hosted_metadata["model"],
                hosted_metadata["model_version"], hosted_metadata["estimated_usd"],
                hosted_metadata["latency_seconds"], hosted_metadata.get("request_id"),
                operation_key,
            )

        return Response(result if submitted_choice is not None else webp_url)
