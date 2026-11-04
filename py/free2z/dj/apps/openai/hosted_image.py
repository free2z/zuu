"""One-shot fal queue adapter for the hosted FLUX.1 [schnell] endpoint.

fal does not expose a request-level idempotency key or actual USD charge in
the documented REST result. A queue submit is therefore made at most once for
an idempotency key; after acceptance, all failures retain its request ID and
are terminal/ambiguous until reconciled. The moving public endpoint does not
publish an immutable serving-build revision. The adapter pins the documented
FLUX.1 [schnell] release name to fal's fixed public endpoint and records that
serving-build limitation in operation metadata and provider documentation.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_CEILING
from io import BytesIO
import math
import time
from urllib.parse import quote, urlparse
import warnings

import httpx2
from django.conf import settings
from PIL import Image


PROVIDER = "fal"
MODEL = "fal-ai/flux/schnell"
MODEL_VERSION = "FLUX.1 [schnell]"
MODEL_REVISION_STATUS = "provider_serving_build_revision_not_published"
PRICE_USD_PER_MEGAPIXEL = Decimal("0.003")
QUEUE_URL = f"https://queue.fal.run/{MODEL}"
QUEUE_HOST = "queue.fal.run"
BUDGET_ADVISORY_LOCK = 245220261005
OUTPUT_HOST = "fal.media"
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_IMAGE_PIXELS = 4_000_000
MAX_IMAGE_SIDE = 4096
MAX_PROVIDER_JSON_BYTES = 64 * 1024
MAX_OPERATION_SECONDS = 150
SUPPORTED_SIZES = {
    "1024x1024": (1024, 1024),
    "1536x1024": (1536, 1024),
    "1024x1536": (1024, 1536),
}


class ImageProviderUnavailable(Exception):
    """The hosted provider has not passed server-side policy/config checks."""


class ImageProviderAccountBudgetExceeded(Exception):
    """This authenticated account exhausted its daily provider allowance."""


class ImageProviderDefiniteFailure(Exception):
    """The provider definitively rejected the queue submission."""


class ImageProviderAmbiguousFailure(Exception):
    """The provider may have accepted the request; do not submit it again."""

    def __init__(self, message: str, metadata: dict | None = None):
        self.metadata = metadata or {}
        super().__init__(message)


class ImageProviderModerated(ImageProviderAmbiguousFailure):
    """A completed output was refused; upstream billing remains unresolved."""


class InvalidProviderImage(ValueError):
    """The provider output exceeded transfer or decoded-image limits."""


@dataclass(frozen=True)
class HostedImageResult:
    image: bytes
    metadata: dict


def _decimal_setting(value: str) -> Decimal | None:
    try:
        parsed = Decimal(value)
    except (InvalidOperation, TypeError, ValueError):
        return None
    if not parsed.is_finite() or parsed < 0:
        return None
    return parsed


def estimate_price(size: str) -> Decimal:
    """Estimate fal's per-megapixel tariff, rounded up as its page specifies."""
    dimensions = SUPPORTED_SIZES.get(size)
    if dimensions is None:
        raise ImageProviderDefiniteFailure("unsupported image size")
    width, height = dimensions
    megapixels = Decimal(width * height) / Decimal(1_000_000)
    billed_megapixels = megapixels.to_integral_value(rounding=ROUND_CEILING)
    return billed_megapixels * PRICE_USD_PER_MEGAPIXEL


def configuration() -> tuple[Decimal, Decimal]:
    """Return the approved tariff estimate and daily cap, or fail closed."""
    approved = _decimal_setting(settings.FAL_IMAGE_APPROVED_PRICE_USD)
    budget = _decimal_setting(settings.FAL_IMAGE_DAILY_BUDGET_USD)
    # Existing cover dimensions all round to one or two megapixels. The
    # maximum estimate is the admission unit for every request.
    maximum_estimate = estimate_price("1536x1024")
    if (
        not settings.FAL_IMAGE_ENABLED
        or not settings.FAL_API_KEY
        or settings.FAL_IMAGE_MODEL_VERSION != MODEL_VERSION
        or approved != maximum_estimate
        or budget is None
        or budget < maximum_estimate
    ):
        raise ImageProviderUnavailable
    return approved, budget


def _image_url(payload: dict) -> str:
    if not isinstance(payload, dict):
        raise ImageProviderAmbiguousFailure("invalid result shape")
    verdict = payload.get("has_nsfw_concepts")
    if not isinstance(verdict, list) or len(verdict) != 1 or type(verdict[0]) is not bool:
        raise ImageProviderAmbiguousFailure("invalid moderation verdict")
    if verdict[0]:
        raise ImageProviderModerated("provider safety system refused the image")
    images = payload.get("images")
    if not isinstance(images, list) or len(images) != 1 or not isinstance(images[0], dict):
        raise ImageProviderAmbiguousFailure("invalid result shape")
    url = images[0].get("url")
    try:
        parsed = urlparse(url) if isinstance(url, str) else None
        hostname = parsed.hostname if parsed is not None else None
        port = parsed.port if parsed is not None else None
    except ValueError as exc:
        raise ImageProviderAmbiguousFailure("invalid result URL") from exc
    if (
        parsed is None
        or parsed.scheme != "https"
        or hostname is None
        or not (hostname == OUTPUT_HOST or hostname.endswith(f".{OUTPUT_HOST}"))
        or parsed.username
        or parsed.password
        or port not in (None, 443)
        or parsed.fragment
    ):
        raise ImageProviderAmbiguousFailure("invalid result URL")
    return url


def validate_image(image: bytes) -> tuple[int, int, str]:
    """Validate bounded PNG/JPEG bytes and dimensions before full decoding."""
    if not isinstance(image, bytes) or not image or len(image) > MAX_IMAGE_BYTES:
        raise InvalidProviderImage("provider image exceeds byte limit")
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        try:
            with Image.open(BytesIO(image)) as decoded:
                width, height = decoded.size
                if (
                    decoded.format not in {"PNG", "JPEG"}
                    or width < 1
                    or height < 1
                    or width > MAX_IMAGE_SIDE
                    or height > MAX_IMAGE_SIDE
                    or width * height > MAX_IMAGE_PIXELS
                ):
                    raise InvalidProviderImage("provider image dimensions or format are unsupported")
                decoded.verify()
        except InvalidProviderImage:
            raise
        except Exception as exc:
            raise InvalidProviderImage("provider image could not be decoded") from exc
    with Image.open(BytesIO(image)) as decoded:
        return width, height, decoded.format


def _bounded_download(client, image_url: str, deadline: float) -> bytes:
    """Stream an allowlisted HTTPS result without redirects or unbounded reads."""
    chunks = []
    total = 0
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise httpx2.TimeoutException("provider image download deadline expired")
    with client.stream(
        "GET", image_url, follow_redirects=False,
        headers={"Accept-Encoding": "identity"},
        timeout=min(15.0, remaining),
    ) as response:
        if response.status_code != 200:
            raise OSError("provider image download failed")
        content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
        if content_type not in {"image/png", "image/jpeg"}:
            raise InvalidProviderImage("provider image content type is unsupported")
        content_encoding = response.headers.get("content-encoding", "identity").lower()
        if content_encoding not in {"", "identity"}:
            raise InvalidProviderImage("provider image content encoding is unsupported")
        content_length = response.headers.get("content-length")
        if content_length:
            try:
                parsed_length = int(content_length)
                if parsed_length < 0 or parsed_length > MAX_IMAGE_BYTES:
                    raise InvalidProviderImage("provider image exceeds byte limit")
            except ValueError as exc:
                raise InvalidProviderImage("provider image length is invalid") from exc
        # iter_bytes(chunk_size) coalesces raw network chunks until it has a
        # full chunk. That prevents the absolute deadline from being checked
        # during a slow drip. Request identity encoding and inspect each raw
        # transport chunk so the deadline and byte cap apply as bytes arrive.
        for chunk in response.iter_raw():
            if time.monotonic() >= deadline:
                raise httpx2.TimeoutException("provider image download deadline expired")
            total += len(chunk)
            if total > MAX_IMAGE_BYTES:
                raise InvalidProviderImage("provider image exceeds byte limit")
            chunks.append(chunk)
    image = b"".join(chunks)
    if time.monotonic() >= deadline:
        raise httpx2.TimeoutException("provider image download deadline expired")
    _, _, decoded_format = validate_image(image)
    expected_type = "image/png" if decoded_format == "PNG" else "image/jpeg"
    if content_type != expected_type:
        raise InvalidProviderImage("provider image content type does not match bytes")
    return image


def _bounded_json_request(
    client, method: str, url: str, deadline: float, *, headers=None,
    json_body=None, metadata=None,
):
    """Read a small queue JSON response with an absolute deadline and cap."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise httpx2.TimeoutException("provider response deadline expired")
    request_headers = {**(headers or {}), "Accept-Encoding": "identity"}
    with client.stream(
        method, url, headers=request_headers, json=json_body,
        follow_redirects=False, timeout=min(15.0, remaining),
    ) as response:
        status_code = response.status_code
        if not 200 <= status_code < 300:
            return status_code, None
        encoding = response.headers.get("content-encoding", "identity").lower()
        if encoding not in {"", "identity"}:
            raise ImageProviderAmbiguousFailure(
                "provider response encoding is unsupported", metadata,
            )
        content_length = response.headers.get("content-length")
        if content_length:
            try:
                parsed_length = int(content_length)
            except ValueError as exc:
                raise ImageProviderAmbiguousFailure(
                    "provider response length is invalid", metadata,
                ) from exc
            if parsed_length < 0 or parsed_length > MAX_PROVIDER_JSON_BYTES:
                raise ImageProviderAmbiguousFailure(
                    "provider response exceeds byte limit", metadata,
                )
        chunks = []
        total = 0
        for chunk in response.iter_raw():
            if time.monotonic() >= deadline:
                raise httpx2.TimeoutException("provider response deadline expired")
            total += len(chunk)
            if total > MAX_PROVIDER_JSON_BYTES:
                raise ImageProviderAmbiguousFailure(
                    "provider response exceeds byte limit", metadata,
                )
            chunks.append(chunk)
    if time.monotonic() >= deadline:
        raise httpx2.TimeoutException("provider response deadline expired")
    try:
        payload = json.loads(b"".join(chunks).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ImageProviderAmbiguousFailure(
            "provider response JSON is invalid", metadata,
        ) from exc
    return status_code, payload


def _request_id(payload: dict) -> str | None:
    request_id = payload.get("request_id")
    if isinstance(request_id, str) and 1 <= len(request_id) <= 200:
        return request_id
    return None


def _queue_url(payload: dict, key: str, request_id: str) -> str:
    """Use the provider's returned queue URL after checking its authority/path."""
    value = payload.get(key)
    try:
        parsed = urlparse(value) if isinstance(value, str) else None
        hostname = parsed.hostname if parsed is not None else None
        port = parsed.port if parsed is not None else None
    except ValueError as exc:
        raise ImageProviderAmbiguousFailure("invalid queue URL") from exc

    encoded_id = quote(request_id, safe="")
    endpoint_path = f"/{MODEL}/requests/{encoded_id}"
    # fal's public client has also emitted the owner/model alias route, which
    # omits the endpoint's final path segment. Both are provider-owned forms.
    alias_path = f"/fal-ai/flux/requests/{encoded_id}"
    suffix = "/status" if key == "status_url" else ""
    expected_paths = (
        (endpoint_path + suffix, alias_path + suffix)
        if key == "status_url"
        else (endpoint_path, endpoint_path + "/response", alias_path, alias_path + "/response")
    )
    if (
        parsed is None
        or parsed.scheme != "https"
        or hostname != QUEUE_HOST
        or parsed.username
        or parsed.password
        or port not in (None, 443)
        or parsed.query
        or parsed.fragment
        or parsed.path not in expected_paths
    ):
        raise ImageProviderAmbiguousFailure("invalid queue URL")
    return value


def generate(prompt: str, size: str, *, on_accepted=None) -> HostedImageResult:
    """Submit once, poll the accepted queue request, then fetch its result."""
    dimensions = SUPPORTED_SIZES.get(size)
    if dimensions is None:
        raise ImageProviderDefiniteFailure("unsupported image size")
    estimate = estimate_price(size)
    started = time.monotonic()
    operation_deadline = started + MAX_OPERATION_SECONDS
    base_metadata = {
        "provider": PROVIDER,
        "model": MODEL,
        "model_version": MODEL_VERSION,
        "model_revision_status": MODEL_REVISION_STATUS,
        "billed_usd": None,
        "estimated_usd": str(estimate),
        "billing_source": "fal_public_per_megapixel_tariff_estimate",
    }
    headers = {
        "Authorization": f"Key {settings.FAL_API_KEY}",
        "Content-Type": "application/json",
    }
    body = {
        "prompt": prompt,
        "image_size": {"width": dimensions[0], "height": dimensions[1]},
        "num_images": 1,
        "output_format": "png",
        "enable_safety_checker": True,
    }
    try:
        with httpx2.Client(timeout=httpx2.Timeout(15.0, connect=5.0)) as client:
            try:
                submit_status, submission = _bounded_json_request(
                    client, "POST", QUEUE_URL, operation_deadline,
                    headers=headers, json_body=body, metadata=base_metadata,
                )
            except (httpx2.TimeoutException, httpx2.NetworkError) as exc:
                raise ImageProviderAmbiguousFailure(
                    "queue submission outcome is unknown", base_metadata,
                ) from exc
            if 400 <= submit_status < 500 and submit_status not in (408, 409):
                raise ImageProviderDefiniteFailure(
                    f"provider rejected request ({submit_status})"
                )
            if not 200 <= submit_status < 300:
                raise ImageProviderAmbiguousFailure(
                    "queue submission outcome is unknown", base_metadata,
                )
            request_id = _request_id(submission) if isinstance(submission, dict) else None
            if request_id is None:
                raise ImageProviderAmbiguousFailure(
                    "accepted queue request omitted its identifier", base_metadata,
                )
            try:
                status_url = _queue_url(submission, "status_url", request_id)
                result_url = _queue_url(submission, "response_url", request_id)
            except ImageProviderAmbiguousFailure as exc:
                raise ImageProviderAmbiguousFailure(
                    "accepted queue request omitted valid status/result URLs",
                    {**base_metadata, "request_id": request_id,
                     "provider_status": "IN_QUEUE"},
                ) from exc
            operation_metadata = {
                **base_metadata,
                "request_id": request_id,
                "provider_status": "IN_QUEUE",
            }
            if on_accepted is not None:
                try:
                    on_accepted(dict(operation_metadata))
                except Exception as exc:
                    raise ImageProviderAmbiguousFailure(
                        "accepted request could not be persisted", operation_metadata,
                    ) from exc
            deadline = min(time.monotonic() + 75, operation_deadline)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ImageProviderAmbiguousFailure(
                        "provider request remains pending", operation_metadata,
                    )
                response_status, status_payload = _bounded_json_request(
                    client, "GET", status_url, deadline,
                    headers=headers, metadata=operation_metadata,
                )
                if response_status != 200:
                    raise ImageProviderAmbiguousFailure(
                        "queue status could not be resolved", operation_metadata,
                    )
                state = status_payload.get("status") if isinstance(status_payload, dict) else None
                if not isinstance(state, str) or state not in {
                    "IN_QUEUE", "IN_PROGRESS", "COMPLETED", "FAILED", "CANCELLED",
                }:
                    operation_metadata["provider_status"] = "UNKNOWN"
                    raise ImageProviderAmbiguousFailure(
                        "provider returned an invalid queue status", operation_metadata,
                    )
                operation_metadata["provider_status"] = state
                if state == "COMPLETED":
                    break
                if state in {"FAILED", "CANCELLED"}:
                    raise ImageProviderAmbiguousFailure(
                        "accepted provider request failed", operation_metadata,
                    )
                if time.monotonic() >= deadline:
                    raise ImageProviderAmbiguousFailure(
                        "provider request remains pending", operation_metadata,
                    )
                time.sleep(0.25)
            remaining = operation_deadline - time.monotonic()
            if remaining <= 0:
                raise ImageProviderAmbiguousFailure(
                    "provider result deadline expired", operation_metadata,
                )
            result_status, result_payload = _bounded_json_request(
                client, "GET", result_url, operation_deadline,
                headers=headers, metadata=operation_metadata,
            )
            if result_status != 200:
                raise ImageProviderAmbiguousFailure(
                    "provider result could not be retrieved", operation_metadata,
                )
            try:
                image_url = _image_url(result_payload)
            except ImageProviderModerated as exc:
                raise ImageProviderModerated(
                    str(exc), {**operation_metadata, "result_state": "safety_refused"},
                ) from exc
            except (ValueError, ImageProviderAmbiguousFailure) as exc:
                raise ImageProviderAmbiguousFailure(
                    "invalid provider result", {**operation_metadata, "result_state": "invalid"},
                ) from exc
            operation_metadata["provider_status"] = "COMPLETED"
            latency = time.monotonic() - started
            if (
                isinstance(latency, bool)
                or not isinstance(latency, (int, float))
                or not math.isfinite(latency)
                or latency < 0
            ):
                raise ImageProviderAmbiguousFailure(
                    "provider operation latency could not be validated", operation_metadata,
                )
            operation_metadata["latency_seconds"] = round(latency, 3)
            # Preserve accepted-request and tariff evidence if download fails.
            try:
                image = _bounded_download(client, image_url, operation_deadline)
            except Exception as exc:
                operation_metadata["result_state"] = "download_failed"
                raise ImageProviderAmbiguousFailure(
                    "successful provider result download failed", operation_metadata,
                ) from exc
    except (ImageProviderDefiniteFailure, ImageProviderAmbiguousFailure):
        raise
    except (httpx2.TimeoutException, httpx2.NetworkError, OSError) as exc:
        raise ImageProviderAmbiguousFailure(
            "provider request outcome is unknown",
            locals().get("operation_metadata", base_metadata),
        ) from exc

    return HostedImageResult(
        image=image,
        metadata={
            **operation_metadata,
            "result_count": 1,
        },
    )
