import base64
import binascii
from decimal import Decimal
import logging
import uuid

from django.db import transaction
from django.shortcuts import get_object_or_404
from django.core.files.base import ContentFile
from django.utils.text import slugify

from rest_framework.response import Response
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework import views, status
from rest_framework.exceptions import ParseError
from rest_framework import viewsets
from rest_framework import pagination
from drf_spectacular.utils import OpenApiParameter, extend_schema

from dj.free2z.pagination import Free2zPagination
from dj.apps.uploads.models import GenericFile
from dj.apps.tuzis import ledger
from dj.apps.tuzis import models as idempotency
from dj.apps.tuzis.serializers import InsufficientFundsErrorSerializer

from .models import Story, Page
from .serializers import (
    PageSerializer, StorytimeImageRequestSerializer,
    StorytimePromptRequestSerializer, StoryFullSerializer,
)

from f2z.ai.providers import (
    EmptyCompletion, complete_prompt, flat_price_prompt_error,
    prompt_completion_model,
)
from f2z.openai.util import get_web_request_openai_client
from dj.apps.openai.hosted_image import validate_image

logger = logging.getLogger(__name__)

# Web-request budget, no SDK retry: see get_web_request_openai_client.
oai_client = get_web_request_openai_client()

#Reply budget of a storytime page (flat 1 2Z). With
#f2z.ai.providers.FLAT_PRICE_CONTEXT_TOKENS (4,096) it leaves 1,024 prompt
#tokens, the old gpt-3.5-turbo-instruct bound.
STORYTIME_MAX_TOKENS = 3072

#Flat price of one Storytime page, text or image, in 2Z.
STORYTIME_PRICE = Decimal("1")

PROVIDER_IDEMPOTENCY_PARAMETER = OpenApiParameter(
    name="Idempotency-Key",
    type={"type": "string", "format": "uuid", "minLength": 36, "maxLength": 36},
    location=OpenApiParameter.HEADER,
    required=False,
    description="Optional UUIDv4 operation key. Reuse it only to retry the exact same provider request.",
)


def _provider_claim(request, scope, payload):
    key = idempotency.request_key(request)
    if request.headers.get("Idempotency-Key") is None:
        return None, None
    if key is None:
        return None, Response(
            {"code": "idempotency_key_required", "error": "A valid UUIDv4 Idempotency-Key header is required."},
            status=status.HTTP_400_BAD_REQUEST,
        )
    try:
        return idempotency.claim(
            scope, request.user, key,
            request_hash=idempotency.fingerprint(payload),
            initial_body={"operation": scope, "state": "provider_pending"},
            # A worker can die after claiming and before the provider/page
            # transaction. The existing stale-claim bound is the recovery path.
            allow_stale_takeover=True,
        ), None
    except idempotency.IdempotencyConflict:
        return None, Response(
            {"code": "idempotency_mismatch", "error": "This idempotency key was already used for a different request."},
            status=status.HTTP_409_CONFLICT,
        )
    except idempotency.DuplicateRequest as duplicate:
        if duplicate.in_flight:
            return None, Response(
                {"code": "request_in_progress", "error": "The original provider operation is still being resolved."},
                status=status.HTTP_409_CONFLICT,
            )
        body = duplicate.record.response_body
        if not isinstance(body, dict) or "page" not in body:
            return None, Response(
                {"code": "invalid_idempotency_record", "error": "The original response could not be replayed safely."},
                status=status.HTTP_409_CONFLICT,
            )
        return None, Response(body["page"], status=duplicate.record.response_status)


class MyStories(viewsets.ModelViewSet):
    """
    Use this for own stories
    """
    lookup_field = 'slug'
    lookup_url_kwarg = 'slug'
    serializer_class = StoryFullSerializer
    pagination_class = Free2zPagination
    permission_classes = (IsAuthenticated,)

    def get_queryset(self):
        user = self.request.user
        return Story.objects.filter(creator=user)


class StoryDetail(views.APIView):
    # Public read of a published story by creator + slug.
    permission_classes = [AllowAny]

    def get(self, request, **kwargs):
        story = get_object_or_404(
            Story,
            slug=kwargs['slug'],
            creator__username=kwargs['creator'],
            creator__is_active=True,
            is_published=True,
        )
        serializer = StoryFullSerializer(story)
        return Response(serializer.data, content_type="application/json")


class StartStory(views.APIView):
    # Was `@permission_classes(...)` on the class, which DRF only
    # honours on @api_view functions.
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = StoryFullSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(creator=request.user)
        return Response(serializer.data, content_type="application/json")


def _reserve_price(request, claim, scope):
    """Hold the page's price before the provider is called.

    Returns ``(reservation, None)`` or ``(None, 402 response)``. The hold is
    taken under the creator row lock, so two requests can never both be
    admitted against the same 2Z: the second one sees the first one's price
    as already held. A retry under the same Idempotency-Key reuses the
    original hold instead of taking a second one.
    """
    operation_key = claim.key if claim is not None else uuid.uuid4()
    try:
        return ledger.reserve(
            request.user, STORYTIME_PRICE,
            scope=scope, operation_key=operation_key,
        ), None
    except ledger.InsufficientFunds as exc:
        idempotency.release(claim)
        return None, Response(
            ledger.insufficient_funds_payload(exc, action=scope),
            status=status.HTTP_402_PAYMENT_REQUIRED,
        )


def _abandon(reservation, claim):
    """Nothing was sold: return the held 2Z and free the key for a retry."""
    try:
        ledger.release_reservation(reservation)
    finally:
        idempotency.release(claim)


def _decode_provider_image(response):
    """The provider's inline image as bytes, validated before it is stored.

    Inline data (``b64_json``) means there is no second fetch to a URL taken
    from the provider's response; ``validate_image`` bounds the byte size,
    format and dimensions before anything is written to storage.
    """
    image_b64 = response.data[0].b64_json
    if not image_b64:
        raise ValueError("Image provider returned no image data")
    try:
        image_data = base64.b64decode(image_b64, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("Image provider returned invalid image data") from error
    _, _, image_format = validate_image(image_data)
    return image_data, image_format


class PromptView(views.APIView):
    permission_classes = [IsAuthenticated]
    atomic_request = False

    @extend_schema(
        parameters=[PROVIDER_IDEMPOTENCY_PARAMETER],
        responses={
            200: PageSerializer,
            402: InsufficientFundsErrorSerializer,
        }
    )
    def post(self, request, **kwargs):
        # Every input is validated before anything is claimed, held, or sent
        # to the provider: a request that cannot be stored must not be paid
        # for upstream.
        params = StorytimePromptRequestSerializer(data=request.data)
        params.is_valid(raise_exception=True)
        prompt = params.validated_data["prompt"]
        # Flat 1 2Z: bound the input's token count too.
        too_long = flat_price_prompt_error(
            prompt, max_tokens=STORYTIME_MAX_TOKENS)
        if too_long:
            raise ParseError(too_long)

        claim, duplicate_response = _provider_claim(
            request, "storytime_page",
            {"action": "storytime_page", "intent": "text", "story": kwargs["slug"], "prompt": prompt},
        )
        if duplicate_response is not None:
            return duplicate_response
        try:
            story = get_object_or_404(Story, slug=kwargs['slug'], creator=request.user)
        except Exception:
            idempotency.release(claim)
            raise
        if oai_client is None:
            idempotency.release(claim)
            return Response({"detail": "Storytime is unavailable right now."}, status=status.HTTP_503_SERVICE_UNAVAILABLE)

        reservation, refused = _reserve_price(request, claim, "storytime_page")
        if refused is not None:
            return refused

        try:
            # Chat Completions on PROMPT_COMPLETION_MODEL: the legacy
            # completions model (gpt-3.5-turbo-instruct) was retired.
            content = complete_prompt(
                oai_client,
                prompt,
                # TODO: temperature as argument
                temperature=0.5,
                max_tokens=STORYTIME_MAX_TOKENS,
            )
        except EmptyCompletion:
            # Nothing to sell: no page, the hold is released, and the claim
            # is released so the same key can try again. Logged the way
            # /api/openai/prompt logs it (_ai_error_response), or a model
            # that answers every storytime prompt with nothing is a stream of
            # silent 503s.
            logger.exception(
                "AI generation failed for %s", prompt_completion_model())
            _abandon(reservation, claim)
            return Response(
                {"detail": "Storytime returned no text. Try again."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        except Exception:
            # No page exists yet, so the hold is returned and this claim can
            # be retried. A killed request still uses the stale-takeover path
            # above, and its hold expires on the same bound.
            _abandon(reservation, claim)
            raise

        # The page and the settlement of the hold are ONE transaction, so a
        # page never exists without its charge and a charge never exists
        # without its page.
        try:
            with transaction.atomic():
                # TODO: insert pages anywhere
                num_pages = story.pages.count()
                page = Page.objects.create(
                    story=story,
                    prompt=prompt,
                    content=content,
                    order=num_pages + 1,
                )
                ledger.settle_reservation(reservation)
                body = PageSerializer(page).data
                if claim is not None:
                    claim.finish(status.HTTP_200_OK, {"page": body})
        except ledger.InsufficientFunds as exc:
            _abandon(reservation, claim)
            return Response(
                ledger.insufficient_funds_payload(exc, action="storytime_page"),
                status=status.HTTP_402_PAYMENT_REQUIRED,
            )
        except Exception:
            _abandon(reservation, claim)
            raise
        return Response(body, content_type="application/json")


class ImageView(views.APIView):
    permission_classes = [IsAuthenticated]
    atomic_request = False

    @extend_schema(
        parameters=[PROVIDER_IDEMPOTENCY_PARAMETER],
        responses={
            200: PageSerializer,
            402: InsufficientFundsErrorSerializer,
        }
    )
    def post(self, request, **kwargs):
        # Validate every input (prompt and size) before anything is claimed,
        # held, or sent to the provider.
        params = StorytimeImageRequestSerializer(data=request.data)
        params.is_valid(raise_exception=True)
        prompt = params.validated_data["prompt"]
        size = params.validated_data["size"]

        claim, duplicate_response = _provider_claim(
            request, "storytime_image",
            {"action": "storytime_image", "intent": "image", "story": kwargs["slug"], "prompt": prompt, "size": size},
        )
        if duplicate_response is not None:
            return duplicate_response
        try:
            story = get_object_or_404(Story, slug=kwargs['slug'], creator=request.user)
        except Exception:
            idempotency.release(claim)
            raise
        if oai_client is None:
            idempotency.release(claim)
            return Response({"detail": "Storytime is unavailable right now."}, status=status.HTTP_503_SERVICE_UNAVAILABLE)

        reservation, refused = _reserve_price(request, claim, "storytime_image")
        if refused is not None:
            return refused

        try:
            response = oai_client.images.generate(
                prompt=prompt,
                n=1,
                size=size,
                response_format="b64_json",
            )
            image_data, image_format = _decode_provider_image(response)
        except Exception:
            # The external phase did not produce a paid Storytime page.
            # Return the hold and release the claim so a normal retry can
            # proceed; stale takeover remains the crash-only fallback when
            # this handler disappears.
            _abandon(reservation, claim)
            raise

        # The image records and the settlement are ONE transaction, so no
        # GenericFile or Page survives without its charge. (Bytes written to
        # the bucket before a rollback stay there, orphaned -- object storage
        # has no transaction to join. Nothing references them.)
        extension, mime_type = (
            ("png", "image/png") if image_format == "PNG"
            else ("jpg", "image/jpeg")
        )
        try:
            with transaction.atomic():
                # create a ContentFile object
                file_name = f"{slugify(prompt)[:64]}.{extension}"
                file_data = ContentFile(image_data, name=file_name)
                file_obj = GenericFile.objects.create(
                    owner=request.user,
                    file=file_data,
                    title=prompt[:64],
                    mime_type=mime_type,
                )
                file_obj.save()

                # TODO: insert pages anywhere
                num_pages = story.pages.count()
                page = Page.objects.create(
                    story=story,
                    prompt=prompt,
                    image=file_obj,
                    order=num_pages + 1,
                )
                ledger.settle_reservation(reservation)
                body = PageSerializer(page).data
                if claim is not None:
                    claim.finish(status.HTTP_200_OK, {"page": body})
        except ledger.InsufficientFunds as exc:
            _abandon(reservation, claim)
            return Response(
                ledger.insufficient_funds_payload(exc, action="storytime_image"),
                status=status.HTTP_402_PAYMENT_REQUIRED,
            )
        except Exception:
            _abandon(reservation, claim)
            raise
        return Response(
            body,
            content_type="application/json",
        )
