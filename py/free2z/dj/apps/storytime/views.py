import logging
import os
import urllib.request

from django.conf import settings
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
from .serializers import PageSerializer, StoryFullSerializer

from f2z.ai.providers import (
    EmptyCompletion, complete_prompt, flat_price_prompt_error,
    prompt_completion_model,
)
from f2z.openai.util import get_web_request_openai_client

logger = logging.getLogger(__name__)

# Web-request budget, no SDK retry: see get_web_request_openai_client.
oai_client = get_web_request_openai_client()

#Reply budget of a storytime page (flat 1 2Z). With
#f2z.ai.providers.FLAT_PRICE_CONTEXT_TOKENS (4,096) it leaves 1,024 prompt
#tokens, the old gpt-3.5-turbo-instruct bound.
STORYTIME_MAX_TOKENS = 3072

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
        prompt = request.data.get("prompt")
        if not prompt:
            raise ParseError("Missing prompt.")
        if not isinstance(prompt, str):
            raise ParseError("Prompt must be a string.")
        # Flat 1 2Z: bound the input before any provider spend.
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

        if request.user.tuzis < 1:
            idempotency.release(claim)
            return Response(
                ledger.insufficient_funds_payload(
                    request.user, 1, action="storytime_page"
                ),
                status=402,
            )

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
            # Nothing to sell: no page, no debit, and the claim is released
            # so the same key can try again. Logged the way
            # /api/openai/prompt logs it (_ai_error_response), or a model
            # that answers every storytime prompt with nothing is a stream of
            # silent 503s.
            logger.exception(
                "AI generation failed for %s", prompt_completion_model())
            idempotency.release(claim)
            return Response(
                {"detail": "Storytime returned no text. Try again."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        except Exception:
            # No page or debit exists yet, so this claim can be retried. A
            # killed request still uses the stale-takeover path above.
            idempotency.release(claim)
            raise

        # The page and the charge are ONE transaction: the
        # balance check above is stale by the time we get here, so a
        # concurrent spend can make the debit fail — and the page must then
        # not exist, or the user keeps generated content they never paid for.
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
                ledger.debit(request.user, 1, action="storytime_page")
                body = PageSerializer(page).data
                if claim is not None:
                    claim.finish(status.HTTP_200_OK, {"page": body})
        except ledger.InsufficientFunds as exc:
            idempotency.release(claim)
            return Response(
                ledger.insufficient_funds_payload(exc, action="storytime_page"),
                status=402,
            )
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
        prompt = request.data.get("prompt")
        if not prompt:
            raise ParseError("Missing prompt.")

        size = request.data.get("size", "512x512")
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

        if request.user.tuzis < 1:
            idempotency.release(claim)
            return Response(
                ledger.insufficient_funds_payload(
                    request.user, 1, action="storytime_image"
                ),
                status=402,
            )

        try:
            response = oai_client.images.generate(
                prompt=prompt,
                n=1,
                size=size,
                response_format="url",
            )

            # download the image from the url
            image_url = response.data[0].url
            # TODO: should probably save for posterity or sth
            # print(image_url)
            # Bounded: urlopen's default is the global socket
            # timeout, which is None -- block forever.
            with urllib.request.urlopen(
                image_url,
                timeout=settings.OPENAI_IMAGE_DOWNLOAD_TIMEOUT_SECONDS,
            ) as response:
                image_data = response.read()
        except Exception:
            # The external phase did not produce a paid Storytime page.
            # Release the claim so a normal retry can proceed; stale takeover
            # remains the crash-only fallback when this handler disappears.
            idempotency.release(claim)
            raise

        # The image records and the charge are ONE transaction,
        # so a debit that loses a race leaves no GenericFile or Page for the
        # user to keep. (The bytes themselves stay in the bucket, orphaned —
        # object storage has no transaction to join. Nothing references them.)
        try:
            with transaction.atomic():
                # create a ContentFile object
                file_name = f"{slugify(prompt)[:64]}.png"
                file_data = ContentFile(image_data, name=file_name)
                file_obj = GenericFile.objects.create(
                    owner=request.user,
                    file=file_data,
                    title=prompt[:64],
                    mime_type='image/png'
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
                ledger.debit(request.user, 1, action="storytime_image")
                body = PageSerializer(page).data
                if claim is not None:
                    claim.finish(status.HTTP_200_OK, {"page": body})
        except ledger.InsufficientFunds as exc:
            idempotency.release(claim)
            return Response(
                ledger.insufficient_funds_payload(exc, action="storytime_image"),
                status=402,
            )
        return Response(
            body,
            content_type="application/json",
        )
