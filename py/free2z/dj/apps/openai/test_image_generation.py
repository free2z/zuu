"""
Image generation tests (`/api/openai/image`), against real Postgres.

These tests drive the endpoint the way a browser does: a **session-authenticated**
request, so `request.user` is the `SimpleLazyObject` that
`AuthenticationMiddleware` installs and `SessionAuthentication` passes through
untouched. That detail is the whole point of this module.

`SimpleLazyObject` proxies `__class__` (so `isinstance` and FK assignment work)
but `type()` deliberately bypasses the proxy. An earlier revision of this PR
hand-rolled its own `reserve_image_cost` using `type(user).objects`, which is
`SimpleLazyObject.objects` for every cookie-authenticated request -- an
`AttributeError` and a 500 for 100% of real browser traffic, while Knox-token
clients (which authenticate to a concrete model instance) worked fine. The
money handling now goes through `dj.apps.tuzis.ledger`  instead,
which is immune by construction: it only ever reads `creator.pk`.

The tests that caught it stay, because the class of bug is not specific to that
helper: anything reached from `request.user` can meet the proxy.

An earlier version of this file used a hand-rolled `FakeUser` with
`objects = MagicMock()` under `SimpleTestCase`, so it never touched Postgres,
never touched the real user model, and green-lit code that could not run in
prod. Do not reintroduce a fake user here.

The only boundaries stubbed are the OpenAI client (an external network service)
and file storage, redirected from GCS to a tmp dir. The database is real.

Note on transactions: the view opts out of `AtomicMiddleware` and wraps the
debit, provider call and both file rows in one explicit `transaction.atomic()`
block. A failure rolls that block back before cleanup writes recovery outside
it; there is no manual refund to get wrong. "The user was not charged" is
therefore asserted end-to-end against the database.
"""
import base64
from datetime import timedelta
import json
import logging
import uuid
from decimal import Decimal
from io import BytesIO
from types import SimpleNamespace

import httpx2
import pytest
from openai import APIStatusError, BadRequestError, OpenAI, RateLimitError
from PIL import Image

from django.conf import settings as django_settings
from django.core.files.base import ContentFile
from django.db import transaction
from django.utils import timezone
from django.utils.functional import SimpleLazyObject

from procrastinate.contrib.django.models import ProcrastinateJob

from dj.apps.openai.views import (
    IMAGE_COST, IMAGE_QUALITY, PROMPT_REJECTION_CODES,
    _provider_error_payload, delete_generated_files,
)
from dj.apps.tuzis import ledger
from dj.apps.tuzis.models import IdempotencyKey, STALE_CLAIM, fingerprint
from dj.apps.uploads import tasks as upload_tasks
from dj.apps.uploads.models import (
    GenericFile, PendingUploadBlobDeletion, Webp,
)
from dj.apps.uploads.tasks import delete_pending_blob

IMAGE_URL = "/api/openai/image"


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    """Swap GCS for a tmp dir -- the external storage boundary only."""
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
        },
    }
    settings.MEDIA_ROOT = str(tmp_path)
    return tmp_path


@pytest.fixture
def creator(creator_factory):
    """A creator with exactly one image's worth of 2Zs, plus change."""
    return creator_factory(tuzis=Decimal(IMAGE_COST + 5))


@pytest.fixture
def session_client(api_client, creator):
    """A cookie/session-authenticated client -- what both UIs actually use.

    `force_login` goes through the session backend, so the view sees the
    `SimpleLazyObject` that broke `type(user).objects`.
    """
    api_client.force_login(creator)
    api_client.idempotency_key = str(uuid.uuid4())
    api_client.credentials(HTTP_IDEMPOTENCY_KEY=api_client.idempotency_key)
    return api_client


def _png_bytes(size=(4, 4), color="red"):
    out = BytesIO()
    Image.new("RGB", size, color=color).save(out, format="PNG")
    return out.getvalue()


def _provider_response(png=None):
    return SimpleNamespace(
        data=[SimpleNamespace(
            b64_json=base64.b64encode(png or _png_bytes()).decode("ascii"),
        )],
    )


def _stub_provider(mocker, **kwargs):
    """Stub the OpenAI network boundary. Nothing else is faked."""
    client = mocker.patch("dj.apps.openai.views.oai_client")
    client.images.generate.return_value = _provider_response()
    for key, value in kwargs.items():
        setattr(client.images.generate, key, value)
    return client


def _enable_fal(settings, client=None):
    from dj.apps.openai import hosted_image

    settings.FAL_API_KEY = "server-side-test-token"
    settings.FAL_IMAGE_ENABLED = True
    settings.FAL_IMAGE_MODEL_VERSION = hosted_image.MODEL_VERSION
    settings.FAL_IMAGE_APPROVED_PRICE_USD = "0.006"
    settings.FAL_IMAGE_DAILY_BUDGET_USD = "1.00"
    if client is not None:
        # Act as a browser which accepted the advertised choice before posting.
        # Keep that signed snapshot stable through configuration changes/replays.
        from dj.apps.openai.views import _cover_choice_snapshot, _cover_choice_snapshot_token
        snapshot = _cover_choice_snapshot_token(_cover_choice_snapshot("fal-flux-schnell"))
        original_post = client.post
        def post_with_choice(path, data=None, **kwargs):
            if path == IMAGE_URL:
                data = {"choice": "fal-flux-schnell", "choice_snapshot": snapshot, **(data or {})}
            return original_post(path, data, **kwargs)
        client.post = post_with_choice


def _cover_choice(client, choice_id):
    response = client.get("/api/ai/creator-options/")
    assert response.status_code == 200
    return next(choice for choice in response.data["cover"] if choice["id"] == choice_id)


def _cover_server_snapshot(choice):
    return {
        key: value for key, value in choice.items()
        if key not in {"snapshot_token", "availability", "queue"}
    }


def _stale_choice_receipt(creator, key, choice, prompt, *, phase="started", operation=None):
    from django.utils import timezone

    server_snapshot = _cover_server_snapshot(choice)
    body = {
        "operation": "ai_image",
        "state": "provider_pending",
        "_provider_intent_snapshot": {
            "choice_snapshot": choice["snapshot_token"],
            "server_snapshot": server_snapshot,
            "legacy_request": False,
        },
        "_image_operation": {
            "provider": choice["provider"],
            "model": choice["model"],
            "provider_request_state": phase,
        },
    }
    if operation:
        body["_image_operation"].update(operation)
    receipt = IdempotencyKey.objects.create(
        scope="ai_image", user=creator, key=key,
        request_hash=fingerprint({
            "action": "ai_image", "intent": "creator_cover",
            "choice": choice["id"], "prompt": prompt, "size": "1024x1024",
        }),
        response_body=body,
    )
    IdempotencyKey.objects.filter(pk=receipt.pk).update(
        created_at=timezone.now() - STALE_CLAIM - timedelta(seconds=1),
    )
    return receipt


class _HostedImageStream:
    def __init__(self, content, *, status_code=200, headers=None):
        self.content = content
        self.status_code = status_code
        self.headers = headers or {"content-type": "image/png"}

    def iter_raw(self):
        yield self.content

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None


def _stub_fal_http(mocker, *, image=None, post_side_effect=None, verdict=False):
    client = mocker.MagicMock()
    client.__enter__.return_value = client
    request_url = "https://queue.fal.run/fal-ai/flux/schnell/requests/fal-request-123"
    client.post.return_value = SimpleNamespace(
        status_code=200,
        json=lambda: {
            "request_id": "fal-request-123",
            "response_url": request_url,
            "status_url": f"{request_url}/status",
        },
    )
    if post_side_effect is not None:
        client.post.side_effect = post_side_effect
    client.get.side_effect = [
        SimpleNamespace(status_code=200, json=lambda: {"status": "COMPLETED"}),
        SimpleNamespace(status_code=200, json=lambda: {
            "has_nsfw_concepts": [verdict], "images": [{"url": "https://v3b.fal.media/files/test.png"}],
        }),
    ]
    client.stream.return_value = _HostedImageStream(image or _png_bytes())

    def as_json_stream(response):
        if 200 <= response.status_code < 300:
            payload = response.json()
            content = json.dumps(payload, allow_nan=True).encode("utf-8")
        else:
            content = b""
        return _HostedImageStream(
            content,
            status_code=response.status_code,
            headers={"content-type": "application/json"},
        )

    def stream(method, url, **kwargs):
        if method == "POST":
            return as_json_stream(client.post(url, **kwargs))
        if url.startswith("https://queue.fal.run/"):
            return as_json_stream(client.get(url, **kwargs))
        return _HostedImageStream(image or _png_bytes())

    client.stream.side_effect = stream
    mocker.patch("dj.apps.openai.hosted_image.httpx2.Client", return_value=client)
    return client


def _media_files(root):
    return sorted(p.name for p in root.rglob("*") if p.is_file())


@pytest.mark.django_db
def test_expected_actor_mismatch_refuses_cover_before_claim_or_provider(
        session_client, creator, mocker):
    provider = _stub_provider(mocker)
    key = session_client.idempotency_key

    response = session_client.post(
        IMAGE_URL,
        {"prompt": "A quiet forest"},
        format="json",
        HTTP_X_EXPECTED_ACTOR=str(creator.pk + 1),
    )

    assert response.status_code == 409
    assert response.data["code"] == "account_changed"
    assert not IdempotencyKey.objects.filter(
        scope="ai_image", user=creator, key=key,
    ).exists()
    provider.images.generate.assert_not_called()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


def _http_400(payload):
    """An httpx2 400 carrying `payload` as the JSON body, as the wire would.

    `httpx2`, not `httpx`: `openai>=3` moved to HTTPX2 and dropped `httpx<1`
    entirely, and `APIStatusError.response` is annotated `httpx2.Response`.
    Building the response from a *different* HTTP library than the SDK uses
    would still pass -- `_make_status_error_from_response` duck-types on
    `is_closed`/`is_stream_consumed`/`text`/`status_code`/`headers` with no
    `isinstance` -- while testing strictly less, and it would drag a legacy
    `httpx` back into the test image for no reason.
    """
    request = httpx2.Request(
        "POST", "https://api.openai.com/v1/images/generations")
    content = b"" if payload is None else json.dumps(payload).encode()
    return httpx2.Response(
        400,
        request=request,
        content=content,
        headers={"content-type": "application/json"},
    )


def _http_429():
    request = httpx2.Request(
        "POST", "https://api.openai.com/v1/images/generations")
    return httpx2.Response(429, request=request, headers={"retry-after": "1"})


def _bad_request_error(code, message):
    """A `BadRequestError` built by the SDK itself from a real wire payload.

    NOT hand-rolled. The wire carries `{"error": {...}}`, but
    `OpenAI._make_status_error` does `body.get("error", body)` before
    constructing the exception, so `exc.body` is the *inner* mapping. A test
    that assembled the exception by hand would happily encode the envelope
    shape the view never sees, and green-light a parser that returns nothing
    for every real refusal. Let the SDK do it.
    """
    client = OpenAI(api_key="sk-not-used-the-response-is-supplied")
    error = client._make_status_error_from_response(_http_400({
        "error": {
            "code": code,
            "message": message,
            "param": None,
            "type": "invalid_request_error",
        },
    }))
    assert isinstance(error, BadRequestError)
    return error


@pytest.mark.parametrize("code", sorted(PROMPT_REJECTION_CODES))
def test_sdk_error_body_is_the_inner_mapping(code):
    """Pin the SDK contract that `_provider_error_payload` depends on.

    `openai` is a pinned dependency that gets bumped. If a future version stops
    unwrapping `body["error"]`, every refusal would silently degrade to the
    generic message with `code=None` in the logs -- a failure with no symptom
    at the boundary. Fail here instead.
    """
    error = _bad_request_error(code, "why it was refused")

    assert error.body == {
        "code": code,
        "message": "why it was refused",
        "param": None,
        "type": "invalid_request_error",
    }
    assert _provider_error_payload(error) == error.body


# --------------------------------------------------------------------------
# The regression that a mocked-user test could never see.
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_session_authenticated_request_succeeds_and_debits_the_balance(
    session_client, creator, mocker, _local_media,
):
    """The bug this file exists for: a real browser-shaped request.

    Against `type(user).objects` this raises
    `AttributeError: type object 'SimpleLazyObject' has no attribute 'objects'`
    before anything else happens.
    """
    provider = _stub_provider(mocker)

    response = session_client.post(
        IMAGE_URL,
        {"prompt": "A wide mountain cover", "size": "1536x1024"},
        format="json",
    )

    assert response.status_code == 200

    # The balance moved in Postgres, by exactly the price, once.
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(5)

    # A real row, owned by the real creator, with a real WebP beside it.
    file_obj = GenericFile.objects.get(owner=creator)
    assert file_obj.mime_type == "image/png"
    webp = Webp.objects.get(parent=file_obj)
    # Legacy callers omit `choice` and retain the original URL response.
    assert response.data == webp.get_url()

    # Both blobs are real, decodable images of the right format.
    with Image.open(file_obj.file) as img:
        assert img.format == "PNG"
    with Image.open(webp.file) as img:
        assert img.format == "WEBP"

    provider.images.generate.assert_called_once_with(
        prompt="A wide mountain cover",
        n=1,
        size="1536x1024",
        quality=IMAGE_QUALITY,
        output_format="png",
        model=django_settings.OPENAI_IMAGE_MODEL,
        extra_headers={"Idempotency-Key": session_client.idempotency_key},
    )


@pytest.mark.django_db
def test_paid_image_receipt_replays_after_configured_model_changes(
        session_client, creator, mocker, _local_media, settings):
    provider = _stub_provider(mocker)
    options = session_client.get("/api/ai/creator-options/")
    assert options.status_code == 200
    choice = options.data["cover"][0]
    body = {
        "prompt": "A quiet forest", "size": "1024x1024",
        "choice": choice["id"], "choice_snapshot": choice["snapshot_token"],
    }
    first = session_client.post(
        IMAGE_URL, body, format="json",
    )
    assert first.status_code == 200
    assert first.data["provider"] == "openai"
    assert first.data["model"] == settings.OPENAI_IMAGE_MODEL

    settings.OPENAI_IMAGE_MODEL = "different-configured-image-model"
    retry = session_client.post(
        IMAGE_URL, body, format="json",
    )

    assert retry.status_code == 200
    assert retry.data == first.data
    provider.images.generate.assert_called_once()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(5)


@pytest.mark.django_db
def test_legacy_image_receipt_keeps_its_original_fingerprint_after_setting_change(
        session_client, creator, mocker, settings):
    provider = _stub_provider(mocker)
    key = session_client.idempotency_key
    prompt = "Legacy image request"
    old_payload = {
        "action": "ai_image", "intent": "openai_image",
        "prompt": prompt, "size": "1024x1024",
    }
    old_url = "/uploads/paid-before-deploy.webp"
    IdempotencyKey.objects.create(
        scope="ai_image", user=creator, key=key,
        request_hash=fingerprint(old_payload), response_status=200,
        response_body={"value": old_url},
    )
    settings.OPENAI_IMAGE_MODEL = "changed-after-payment"

    replay = session_client.post(
        IMAGE_URL,
        {"prompt": prompt, "size": "1024x1024"},
        format="json",
        HTTP_X_REQUIRE_EXISTING_RECEIPT="true",
    )

    assert replay.status_code == 200
    assert replay.data == old_url
    provider.images.generate.assert_not_called()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


@pytest.mark.django_db
def test_adopted_legacy_key_without_receipt_is_refused_before_generation(
        session_client, creator, mocker):
    provider = _stub_provider(mocker)
    key = session_client.idempotency_key

    response = session_client.post(
        IMAGE_URL,
        {"prompt": "A garden without an adopted choice", "size": "1024x1024"},
        format="json",
        HTTP_X_REQUIRE_EXISTING_RECEIPT="true",
    )

    assert response.status_code == 409
    assert response.data["code"] == "legacy_replay_unavailable"
    assert not IdempotencyKey.objects.filter(
        scope="ai_image", user=creator, key=key,
    ).exists()
    provider.images.generate.assert_not_called()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


@pytest.mark.django_db
def test_pre_disclosure_stale_image_claim_becomes_a_terminal_unknown_outcome(
        session_client, creator, mocker):
    provider = _stub_provider(mocker)
    key = session_client.idempotency_key
    prompt = "Legacy ambiguous image request"
    body = {"prompt": prompt, "size": "1024x1024"}
    payload = {
        "action": "ai_image", "intent": "openai_image",
        "prompt": prompt, "size": "1024x1024",
    }
    record = IdempotencyKey.objects.create(
        scope="ai_image", user=creator, key=key,
        request_hash=fingerprint(payload),
        response_body={"operation": "ai_image", "state": "provider_pending"},
    )
    IdempotencyKey.objects.filter(pk=record.pk).update(
        created_at=timezone.now() - STALE_CLAIM - timedelta(seconds=1),
    )

    first = session_client.post(IMAGE_URL, body, format="json")
    replay = session_client.post(IMAGE_URL, body, format="json")

    assert first.status_code == replay.status_code == 503
    assert first.data == replay.data
    assert first.data["code"] == "image_generation_outcome_uncertain"
    assert first.data["key_resolved"] is True
    assert first.data["credit_reservation_state"] == "unknown"
    provider.images.generate.assert_not_called()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


@pytest.mark.django_db
def test_cover_snapshot_change_is_refused_before_provider_or_charge(
        session_client, creator, mocker, settings):
    provider = _stub_provider(mocker)
    options = session_client.get("/api/ai/creator-options/")
    choice = options.data["cover"][0]
    settings.OPENAI_IMAGE_MODEL = "new-image-model"

    response = session_client.post(
        IMAGE_URL,
        {
            "prompt": "A quiet forest", "size": "1024x1024",
            "choice": choice["id"], "choice_snapshot": choice["snapshot_token"],
        },
        format="json",
    )

    assert response.status_code == 409
    provider.images.generate.assert_not_called()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


@pytest.mark.django_db
def test_stale_cover_claim_cannot_take_over_under_a_changed_model(
        session_client, creator, mocker, settings):
    provider = _stub_provider(mocker)
    options = session_client.get("/api/ai/creator-options/")
    choice = options.data["cover"][0]
    prompt = "An ambiguous cover request"
    body = {
        "prompt": prompt, "size": "1024x1024", "choice": choice["id"],
        "choice_snapshot": choice["snapshot_token"],
    }
    old_snapshot = {
        key: value for key, value in choice.items()
        if key not in {"snapshot_token", "availability", "queue"}
    }
    IdempotencyKey.objects.create(
        scope="ai_image", user=creator, key=session_client.idempotency_key,
        request_hash=fingerprint({
            "action": "ai_image", "intent": "creator_cover",
            "choice": choice["id"], "prompt": prompt, "size": "1024x1024",
        }),
        response_body={
            "operation": "ai_image", "state": "provider_pending",
            "_provider_intent_snapshot": {
                "choice_snapshot": choice["snapshot_token"],
                "server_snapshot": old_snapshot,
                "legacy_request": False,
            },
        },
    )
    IdempotencyKey.objects.filter(
        scope="ai_image", user=creator,
        key=session_client.idempotency_key,
    ).update(created_at=timezone.now() - STALE_CLAIM - timedelta(seconds=1))
    settings.OPENAI_IMAGE_MODEL = "changed-after-the-ambiguous-call"

    response = session_client.post(IMAGE_URL, body, format="json")

    assert response.status_code == 503
    assert response.data["code"] == "image_generation_outcome_uncertain"
    assert response.data["key_resolved"] is True
    provider.images.generate.assert_not_called()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


@pytest.mark.django_db
def test_unadvertised_image_choice_is_rejected_before_provider_or_charge(
        session_client, creator, mocker):
    provider = _stub_provider(mocker)

    response = session_client.post(
        IMAGE_URL,
        {"prompt": "A quiet forest", "choice": "made-up-provider/model"},
        format="json",
    )

    assert response.status_code == 409
    provider.images.generate.assert_not_called()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


@pytest.mark.django_db
def test_openai_finished_image_key_replay_does_not_regenerate_or_charge_again(
    session_client, creator, mocker, _local_media,
):
    provider = _stub_provider(mocker)
    payload = {"prompt": "A replay-safe mountain cover", "size": "1024x1024"}

    first = session_client.post(IMAGE_URL, payload, format="json")
    replay = session_client.post(IMAGE_URL, payload, format="json")

    assert first.status_code == replay.status_code == 200
    assert replay.data == first.data
    provider.images.generate.assert_called_once()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(5)
    assert GenericFile.objects.filter(owner=creator).count() == 1
    assert Webp.objects.filter(parent__owner=creator).count() == 1


@pytest.mark.django_db
def test_fal_success_is_stored_and_idempotent_without_prompt_logs(
    session_client, creator, mocker, _local_media, settings, caplog,
):
    _enable_fal(settings, session_client)
    provider = _stub_fal_http(mocker)
    prompt = "private prompt that must not appear in logs"

    response = session_client.post(
        IMAGE_URL, {"prompt": prompt, "size": "1536x1024"}, format="json",
    )
    replay = session_client.post(
        IMAGE_URL, {"prompt": prompt, "size": "1536x1024"}, format="json",
    )

    assert response.status_code == replay.status_code == 200
    assert response.data == replay.data
    provider.post.assert_called_once()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(5)
    assert GenericFile.objects.filter(owner=creator).count() == 1
    file_obj = GenericFile.objects.get(owner=creator)
    webp = Webp.objects.get(parent=file_obj)
    assert file_obj.mime_type == "image/png"
    with Image.open(file_obj.file) as stored:
        assert stored.format == "PNG"
    with Image.open(webp.file) as stored:
        assert stored.format == "WEBP"
    assert response.data["url"] == webp.get_url()

    receipt = IdempotencyKey.objects.get(
        scope="ai_image", user=creator, key=session_client.idempotency_key,
    )
    operation = receipt.response_body["_image_operation"]
    assert operation["provider"] == "fal"
    assert operation["model_version"]
    assert operation["billed_usd"] is None
    assert operation["estimated_usd"] == "0.006"
    assert operation["billing_source"] == "fal_public_per_megapixel_tariff_estimate"
    assert operation["latency_seconds"] >= 0
    assert operation["budget_day"]
    assert operation["result_state"] == "stored"
    assert operation["result"]["generic_file_id"] == file_obj.pk
    assert operation["result"]["webp_id"] == webp.pk
    assert prompt not in caplog.text
    assert prompt not in str(receipt.request_hash)


@pytest.mark.django_db
@pytest.mark.parametrize(
    "key",
    [None, "not-a-uuid", "00000000-0000-1000-8000-000000000001"],
    ids=["missing", "malformed", "non-v4-uuid"],
)
def test_fal_rejects_missing_or_invalid_uuid4_key_before_admission(
    api_client, creator, mocker, settings, key,
):
    _enable_fal(settings, api_client)
    api_client.force_login(creator)
    if key is not None:
        api_client.credentials(HTTP_IDEMPOTENCY_KEY=key)
    provider = _stub_fal_http(mocker)
    import dj.apps.openai.views as image_views

    reserve_budget = mocker.spy(image_views, "_reserve_hosted_image_budget")

    response = api_client.post(
        IMAGE_URL, {"prompt": "must not be admitted"}, format="json",
    )

    assert response.status_code == 400
    assert response.data["code"] == "idempotency_key_required"
    provider.post.assert_not_called()
    reserve_budget.assert_not_called()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)
    assert not IdempotencyKey.objects.filter(scope="ai_image", user=creator).exists()


@pytest.mark.django_db
def test_fal_pending_idempotency_claim_does_not_submit_again(
    api_client, creator, mocker, settings,
):
    from dj.apps.tuzis.models import fingerprint

    _enable_fal(settings, api_client)
    api_client.force_login(creator)
    key = str(uuid.uuid4())
    api_client.credentials(HTTP_IDEMPOTENCY_KEY=key)
    prompt = "pending operation"
    pending = IdempotencyKey.objects.create(
        scope="ai_image", user=creator, key=key,
        request_hash=fingerprint({
            "action": "ai_image", "intent": "creator_cover", "choice": "fal-flux-schnell",
            "prompt": prompt, "size": "1024x1024",
        }),
        response_body={"operation": "ai_image", "_image_operation": {"provider": "fal", "budget_state": "reserved"}},
    )
    from django.utils import timezone
    from datetime import timedelta

    IdempotencyKey.objects.filter(pk=pending.pk).update(
        created_at=timezone.now() - timedelta(hours=1),
    )
    settings.FAL_IMAGE_ENABLED = False
    provider = _stub_provider(mocker)

    response = api_client.post(
        IMAGE_URL, {"prompt": prompt}, format="json",
    )

    assert response.status_code == 503
    assert response.data["code"] == "image_generation_outcome_uncertain"
    assert response.data["key_resolved"] is True
    provider.images.generate.assert_not_called()
    pending.refresh_from_db()
    assert pending.response_status == 503
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("reserve_before_crash", [False, True])
def test_fal_claim_crash_distinguishes_unreserved_from_ambiguous_budget(
    session_client, creator, creator_factory, mocker, settings, reserve_before_crash,
):
    from dj.apps.openai import views

    _enable_fal(settings, session_client)
    provider = _stub_fal_http(mocker)
    original_reserve = views._reserve_hosted_image_budget
    prompt = "claim interrupted around durable budget admission"

    def crash(claim, amount, daily_limit):
        if reserve_before_crash:
            assert original_reserve(claim, amount, daily_limit)
        # A dead worker cannot run the ordinary exception cleanup/release.
        raise SystemExit("simulated worker termination")

    patched = mocker.patch.object(views, "_reserve_hosted_image_budget", side_effect=crash)
    with pytest.raises(SystemExit):
        session_client.post(IMAGE_URL, {"prompt": prompt}, format="json")
    mocker.stop(patched)
    receipt = IdempotencyKey.objects.get(scope="ai_image", user=creator,
        key=session_client.idempotency_key)
    assert receipt.response_status is None
    assert receipt.response_body["_image_operation"]["provider"] == "fal"
    assert receipt.response_body["_image_operation"]["provider_request_state"] == "not_started"
    assert (
        receipt.response_body["_image_operation"].get("budget_state") == "reserved"
    ) is reserve_before_crash
    # A separate connection observes the committed claim after simulated
    # termination; an outer pytest transaction must not hide this boundary.
    from concurrent.futures import ThreadPoolExecutor
    from django.db import close_old_connections, connection

    def committed_receipt():
        close_old_connections()
        try:
            return IdempotencyKey.objects.get(pk=receipt.pk).response_body
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=1) as worker:
        assert worker.submit(committed_receipt).result(timeout=5) == receipt.response_body
    IdempotencyKey.objects.filter(pk=receipt.pk).update(
        created_at=timezone.now() - STALE_CLAIM - timedelta(seconds=1))

    resolved = session_client.post(IMAGE_URL, {"prompt": prompt}, format="json")
    # Both fixtures prove the provider dispatch never began, so neither
    # consumes the cap after stale resolution.
    other = creator_factory()
    other_claim = IdempotencyKey.objects.create(scope="ai_image", user=other, key=str(uuid.uuid4()))
    admitted = original_reserve(other_claim, Decimal("0.006"), Decimal("0.006"))
    assert admitted
    assert resolved.status_code == 409
    assert resolved.data["key_resolved"] is True
    replay = session_client.post(IMAGE_URL, {"prompt": prompt}, format="json")
    assert replay.status_code == resolved.status_code
    assert replay.data["code"] == resolved.data["code"] and replay.data["key_resolved"] is True
    provider.post.assert_not_called()
    creator.refresh_from_db()
    assert creator.tuzis == IMAGE_COST + 5
    assert not GenericFile.objects.exists() and not Webp.objects.exists()
    receipt.refresh_from_db()
    operation = receipt.response_body["_image_operation"]
    assert operation["budget_state"] == "not_reserved"
    assert operation["billing_state"] == "not_billed"
    assert "prompt" not in json.dumps(receipt.response_body)



@pytest.mark.django_db
def test_stale_fal_claim_is_terminalized_without_resubmitting(
    session_client, creator, mocker, settings,
):
    from datetime import timedelta
    from django.utils import timezone
    from dj.apps.tuzis.models import fingerprint

    _enable_fal(settings, session_client)
    key = session_client.idempotency_key
    prompt = "stale accepted image must not be submitted twice"
    receipt = IdempotencyKey.objects.create(
        scope="ai_image", user=creator, key=key,
        request_hash=fingerprint({
            "action": "ai_image", "intent": "creator_cover", "choice": "fal-flux-schnell",
            "prompt": prompt, "size": "1024x1024",
        }),
        response_body={"operation": "ai_image", "_image_operation": {
            "provider": "fal",
            "model": "fal-ai/flux/schnell",
            "model_version": "FLUX.1 [schnell]",
            "request_id": "stale-fal-request",
            "budget_state": "reserved",
            "budget_reserved_usd": "0.006",
            "budget_day": timezone.localdate().isoformat(),
        }},
    )
    IdempotencyKey.objects.filter(pk=receipt.pk).update(
        created_at=timezone.now() - timedelta(hours=1),
    )
    provider = _stub_fal_http(mocker)
    from dj.apps.tuzis import ledger
    from dj.apps.ledger.models import LedgerHold
    reservation = ledger.reserve(creator, IMAGE_COST, scope="ai_image", operation_key=key)
    unrelated = ledger.reserve(creator, 1, scope="ai_image", operation_key=uuid.uuid4())

    response = session_client.post(IMAGE_URL, {"prompt": prompt}, format="json")

    assert response.status_code == 503
    assert response.data["key_resolved"] is True
    assert response.data["code"] == "image_generation_outcome_uncertain"
    provider.post.assert_not_called()
    receipt.refresh_from_db()
    assert receipt.response_status == 503
    operation = receipt.response_body["_image_operation"]
    assert operation["request_id"] == "stale-fal-request"
    assert operation["billing_state"] == "unknown"
    assert operation["budget_state"] == "uncertain"

    assert not LedgerHold.objects.filter(pk=reservation.pk).exists()
    assert LedgerHold.objects.filter(pk=unrelated.pk).exists()


@pytest.mark.django_db
def test_openai_stale_claim_with_same_request_is_not_resubmitted(
    api_client, creator, mocker, settings,
):
    from datetime import timedelta
    from django.utils import timezone
    from dj.apps.tuzis.models import fingerprint

    settings.FAL_IMAGE_ENABLED = False
    api_client.force_login(creator)
    key = str(uuid.uuid4())
    api_client.credentials(HTTP_IDEMPOTENCY_KEY=key)
    prompt = "retry an interrupted OpenAI request"
    stale = IdempotencyKey.objects.create(
        scope="ai_image", user=creator, key=key,
        request_hash=fingerprint({
            "action": "ai_image", "intent": "openai_image",
            "prompt": prompt, "size": "1024x1024",
        }),
        response_body={"operation": "ai_image", "state": "provider_pending"},
    )
    IdempotencyKey.objects.filter(pk=stale.pk).update(
        created_at=timezone.now() - timedelta(hours=1),
    )
    provider = _stub_provider(mocker)

    response = api_client.post(IMAGE_URL, {"prompt": prompt}, format="json")

    assert response.status_code == 503
    assert response.data["code"] == "image_generation_outcome_uncertain"
    assert response.data["key_resolved"] is True
    provider.images.generate.assert_not_called()
    stale.refresh_from_db()
    assert stale.response_status == 503


@pytest.mark.django_db
def test_stale_openai_pre_dispatch_receipt_retries_exact_model_and_replays_once(
    api_client, creator, mocker, settings,
):
    settings.FAL_IMAGE_ENABLED = False
    api_client.force_login(creator)
    key = str(uuid.uuid4())
    api_client.credentials(HTTP_IDEMPOTENCY_KEY=key)
    prompt = "stale OpenAI request proven not to have dispatched"
    provider = _stub_provider(mocker)
    choice = _cover_choice(api_client, "openai-image")
    receipt = _stale_choice_receipt(
        creator, key, choice, prompt, phase="not_started",
    )
    body = {
        "prompt": prompt, "choice": choice["id"],
        "choice_snapshot": choice["snapshot_token"],
    }

    first = api_client.post(IMAGE_URL, body, format="json")
    replay = api_client.post(IMAGE_URL, body, format="json")

    assert first.status_code == replay.status_code == 200, (first.data, replay.data)
    assert first.data == replay.data
    provider.images.generate.assert_called_once()
    assert provider.images.generate.call_args.kwargs["model"] == choice["model"]
    assert provider.images.generate.call_args.kwargs["extra_headers"]["Idempotency-Key"] == key
    creator.refresh_from_db()
    assert creator.tuzis == Decimal("5")
    receipt.refresh_from_db()
    assert receipt.response_status == 200
    assert receipt.response_body["_image_operation"]["provider_request_state"] == "completed"


@pytest.mark.django_db
def test_stale_pre_dispatch_receipt_resolves_if_disclosure_changed_without_dispatch(
    api_client, creator, mocker, settings,
):
    settings.FAL_IMAGE_ENABLED = False
    api_client.force_login(creator)
    key = str(uuid.uuid4())
    api_client.credentials(HTTP_IDEMPOTENCY_KEY=key)
    prompt = "do not retry under a changed disclosure"
    provider = _stub_provider(mocker)
    original_choice = _cover_choice(api_client, "openai-image")
    receipt = _stale_choice_receipt(
        creator, key, original_choice, prompt, phase="not_started",
    )
    from dj.apps.tuzis import ledger
    from dj.apps.ledger.models import LedgerHold
    hold = ledger.reserve(
        creator, IMAGE_COST, scope="ai_image", operation_key=key,
    )
    mocker.patch.dict(
        "dj.apps.openai.views.PROVIDER_PRIVACY_URLS",
        {"openai": "https://openai.com/policies/updated-image-terms"},
    )
    current_choice = _cover_choice(api_client, "openai-image")

    response = api_client.post(
        IMAGE_URL,
        {
            "prompt": prompt, "choice": current_choice["id"],
            "choice_snapshot": current_choice["snapshot_token"],
        },
        format="json",
    )

    assert response.status_code == 409
    assert response.data["code"] == "image_generation_not_started"
    assert response.data["key_resolved"] is True
    provider.images.generate.assert_not_called()
    assert not LedgerHold.objects.filter(pk=hold.pk).exists()
    receipt.refresh_from_db()
    assert receipt.response_status == 409
    assert receipt.response_body["key_resolved"] is True


@pytest.mark.django_db
def test_stale_same_model_openai_started_receipt_keeps_hold_and_never_resubmits(
    api_client, creator, mocker, settings,
):
    settings.FAL_IMAGE_ENABLED = False
    api_client.force_login(creator)
    key = str(uuid.uuid4())
    api_client.credentials(HTTP_IDEMPOTENCY_KEY=key)
    prompt = "same model OpenAI request accepted before worker died"
    provider = _stub_provider(mocker)
    choice = _cover_choice(api_client, "openai-image")
    receipt = _stale_choice_receipt(
        creator, key, choice, prompt, phase="started",
        operation={"billing_state": "unknown", "billed_usd": None},
    )
    from dj.apps.tuzis import ledger
    from dj.apps.ledger.models import LedgerHold
    hold = ledger.reserve(
        creator, IMAGE_COST, scope="ai_image", operation_key=key,
    )
    body = {
        "prompt": prompt, "choice": choice["id"],
        "choice_snapshot": choice["snapshot_token"],
    }

    first = api_client.post(IMAGE_URL, body, format="json")
    replay = api_client.post(IMAGE_URL, body, format="json")

    assert first.status_code == replay.status_code == 503
    assert first.data["code"] == "image_generation_outcome_uncertain"
    assert first.data["key_resolved"] is True
    assert first.data["credit_reservation_state"] == "held"
    assert "not retried" in first.data["detail"]
    assert "billing status" in first.data["detail"]
    assert replay.data["credit_reservation_state"] == "unknown"
    provider.images.generate.assert_not_called()
    assert LedgerHold.objects.filter(pk=hold.pk).exists()
    receipt.refresh_from_db()
    assert receipt.response_status == 503
    assert receipt.response_body["credit_reservation_state"] == "unknown"
    assert receipt.response_body["_image_operation"]["billing_state"] == "unknown"
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


@pytest.mark.django_db
def test_stale_openai_to_fal_switch_resolves_unknown_without_releasing_hold(
    api_client, creator, mocker, settings,
):
    settings.FAL_IMAGE_ENABLED = False
    api_client.force_login(creator)
    key = str(uuid.uuid4())
    api_client.credentials(HTTP_IDEMPOTENCY_KEY=key)
    prompt = "switch provider after an uncertain OpenAI dispatch"
    openai = _stub_provider(mocker)
    old_choice = _cover_choice(api_client, "openai-image")
    receipt = _stale_choice_receipt(
        creator, key, old_choice, prompt, phase="started",
    )
    from dj.apps.tuzis import ledger
    from dj.apps.ledger.models import LedgerHold
    hold = ledger.reserve(
        creator, IMAGE_COST, scope="ai_image", operation_key=key,
    )
    _enable_fal(settings, api_client)
    fal = _stub_fal_http(mocker)

    first = api_client.post(IMAGE_URL, {"prompt": prompt}, format="json")
    replay = api_client.post(IMAGE_URL, {"prompt": prompt}, format="json")

    assert first.status_code == replay.status_code == 503, (first.data, replay.data)
    assert first.data["key_resolved"] is True
    assert first.data["credit_reservation_state"] == "held"
    assert first.data["code"] == "image_generation_outcome_uncertain"
    fal.post.assert_not_called()
    openai.images.generate.assert_not_called()
    receipt.refresh_from_db()
    assert receipt.response_status == 503
    assert receipt.response_body["credit_reservation_state"] == "unknown"
    assert receipt.response_body["_image_operation"]["billing_state"] == "unknown"
    assert LedgerHold.objects.filter(pk=hold.pk).exists()


@pytest.mark.django_db
def test_stale_fal_to_openai_switch_resolves_and_preserves_fal_budget_evidence(
    api_client, creator, mocker, settings,
):
    _enable_fal(settings)
    api_client.force_login(creator)
    key = str(uuid.uuid4())
    api_client.credentials(HTTP_IDEMPOTENCY_KEY=key)
    prompt = "switch provider after an uncertain fal dispatch"
    openai = _stub_provider(mocker)
    fal_choice = _cover_choice(api_client, "fal-flux-schnell")
    from django.utils import timezone
    receipt = _stale_choice_receipt(
        creator, key, fal_choice, prompt, phase="started",
        operation={
            "budget_state": "reserved", "budget_reserved_usd": "0.006",
            "budget_day": timezone.now().date().isoformat(),
            "request_id": "accepted-fal-request",
        },
    )
    from dj.apps.tuzis import ledger
    from dj.apps.ledger.models import LedgerHold
    hold = ledger.reserve(
        creator, IMAGE_COST, scope="ai_image", operation_key=key,
    )
    settings.FAL_IMAGE_ENABLED = False
    openai_choice = _cover_choice(api_client, "openai-image")

    response = api_client.post(
        IMAGE_URL,
        {
            "prompt": prompt, "choice": openai_choice["id"],
            "choice_snapshot": openai_choice["snapshot_token"],
        },
        format="json",
    )

    assert response.status_code == 503
    assert response.data["key_resolved"] is True
    assert response.data["code"] == "image_generation_outcome_uncertain"
    openai.images.generate.assert_not_called()
    receipt.refresh_from_db()
    operation = receipt.response_body["_image_operation"]
    assert receipt.response_status == 503
    assert operation["provider"] == "fal"
    assert operation["budget_state"] == "uncertain"
    assert operation["budget_reserved_usd"] == "0.006"
    assert operation["request_id"] == "accepted-fal-request"
    assert not LedgerHold.objects.filter(pk=hold.pk).exists()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


@pytest.mark.django_db
def test_stale_image_prompt_mismatch_does_not_take_or_change_receipt(
    api_client, creator, mocker, settings,
):
    settings.FAL_IMAGE_ENABLED = False
    api_client.force_login(creator)
    key = str(uuid.uuid4())
    api_client.credentials(HTTP_IDEMPOTENCY_KEY=key)
    original_prompt = "the exact original OpenAI prompt"
    provider = _stub_provider(mocker)
    choice = _cover_choice(api_client, "openai-image")
    receipt = _stale_choice_receipt(creator, key, choice, original_prompt)
    original_owner = receipt.owner
    receipt.refresh_from_db()
    original_created_at = receipt.created_at

    response = api_client.post(
        IMAGE_URL,
        {
            "prompt": "a different prompt must not resolve this receipt",
            "choice": choice["id"], "choice_snapshot": choice["snapshot_token"],
        },
        format="json",
    )

    assert response.status_code == 409
    assert response.data["code"] == "idempotency_mismatch"
    provider.images.generate.assert_not_called()
    receipt.refresh_from_db()
    assert receipt.response_status is None
    assert receipt.owner == original_owner
    assert receipt.created_at == original_created_at


@pytest.mark.django_db
def test_stale_hashless_image_receipt_is_not_adopted_as_a_different_intent(
    api_client, creator, mocker, settings,
):
    settings.FAL_IMAGE_ENABLED = False
    api_client.force_login(creator)
    key = str(uuid.uuid4())
    api_client.credentials(HTTP_IDEMPOTENCY_KEY=key)
    provider = _stub_provider(mocker)
    choice = _cover_choice(api_client, "openai-image")
    receipt = IdempotencyKey.objects.create(
        scope="ai_image", user=creator, key=key,
        response_body={"operation": "ai_image", "state": "provider_pending"},
    )
    from django.utils import timezone
    IdempotencyKey.objects.filter(pk=receipt.pk).update(
        created_at=timezone.now() - STALE_CLAIM - timedelta(seconds=1),
    )
    receipt.refresh_from_db()
    original_owner = receipt.owner
    original_created_at = receipt.created_at

    response = api_client.post(
        IMAGE_URL,
        {
            "prompt": "cannot adopt an unknown old request as this prompt",
            "choice": choice["id"], "choice_snapshot": choice["snapshot_token"],
        },
        format="json",
    )

    assert response.status_code == 409
    assert response.data["code"] == "idempotency_mismatch"
    provider.images.generate.assert_not_called()
    receipt.refresh_from_db()
    assert receipt.response_status is None
    assert receipt.request_hash is None
    assert receipt.owner == original_owner
    assert receipt.created_at == original_created_at


@pytest.mark.django_db
def test_nonstale_provider_switch_stays_pending_without_mutating_receipt(
    api_client, creator, mocker, settings,
):
    settings.FAL_IMAGE_ENABLED = False
    api_client.force_login(creator)
    key = str(uuid.uuid4())
    api_client.credentials(HTTP_IDEMPOTENCY_KEY=key)
    prompt = "a recent claim cannot be recovered by provider switch"
    openai = _stub_provider(mocker)
    old_choice = _cover_choice(api_client, "openai-image")
    receipt = _stale_choice_receipt(creator, key, old_choice, prompt)
    from django.utils import timezone
    IdempotencyKey.objects.filter(pk=receipt.pk).update(created_at=timezone.now())
    receipt.refresh_from_db()
    original_owner = receipt.owner
    original_created_at = receipt.created_at
    _enable_fal(settings, api_client)
    fal = _stub_fal_http(mocker)

    response = api_client.post(IMAGE_URL, {"prompt": prompt}, format="json")

    assert response.status_code == 409
    assert response.data["code"] == "request_in_progress"
    fal.post.assert_not_called()
    openai.images.generate.assert_not_called()
    receipt.refresh_from_db()
    assert receipt.response_status is None
    assert receipt.owner == original_owner
    assert receipt.created_at == original_created_at


@pytest.mark.django_db
def test_other_actor_same_key_does_not_mutate_first_actors_stale_receipt(
    api_client, creator, creator_factory, mocker, settings,
):
    settings.FAL_IMAGE_ENABLED = False
    key = str(uuid.uuid4())
    prompt = "one actor owns this stale request"
    api_client.force_login(creator)
    api_client.credentials(HTTP_IDEMPOTENCY_KEY=key)
    provider = _stub_provider(mocker)
    choice = _cover_choice(api_client, "openai-image")
    receipt = _stale_choice_receipt(creator, key, choice, prompt)
    original_owner = receipt.owner
    other = creator_factory(tuzis=0)
    api_client.force_login(other)
    api_client.credentials(
        HTTP_IDEMPOTENCY_KEY=key,
        HTTP_X_EXPECTED_ACTOR=str(creator.pk),
    )

    response = api_client.post(
        IMAGE_URL,
        {
            "prompt": prompt, "choice": choice["id"],
            "choice_snapshot": choice["snapshot_token"],
        },
        format="json",
    )

    assert response.status_code == 409
    assert response.data["code"] == "account_changed"
    provider.images.generate.assert_not_called()
    receipt.refresh_from_db()
    assert receipt.response_status is None
    assert receipt.owner == original_owner


@pytest.mark.django_db
@pytest.mark.parametrize("status_code", [401, 403, 404, 413, 422, 429])
def test_openai_explicit_pre_admission_rejection_releases_exact_key_for_retry(
    api_client, creator, mocker, settings, status_code,
):
    settings.FAL_IMAGE_ENABLED = False
    api_client.force_login(creator)
    key = str(uuid.uuid4())
    api_client.credentials(HTTP_IDEMPOTENCY_KEY=key)
    prompt = f"retry after explicit OpenAI rejection {status_code}"
    provider = _stub_provider(mocker)
    from httpx2 import Response as HttpxResponse, Request
    rejection = APIStatusError(
        "request rejected", response=HttpxResponse(
            status_code, request=Request("POST", "https://api.openai.com/v1/images/generations"),
        ), body=None,
    )
    provider.images.generate.side_effect = [rejection, _provider_response()]

    first = api_client.post(IMAGE_URL, {"prompt": prompt}, format="json")
    second = api_client.post(IMAGE_URL, {"prompt": prompt}, format="json")

    assert first.status_code == 503
    assert second.status_code == 200
    assert provider.images.generate.call_count == 2
    creator.refresh_from_db()
    assert creator.tuzis == Decimal("5")


@pytest.mark.django_db
def test_openai_headerless_request_uses_private_receipt_key_and_cleanup_marker(
    api_client, creator, mocker, settings,
):
    settings.FAL_IMAGE_ENABLED = False
    api_client.force_login(creator)
    provider = _stub_provider(mocker)

    response = api_client.post(
        IMAGE_URL, {"prompt": "headerless OpenAI request"}, format="json",
    )

    assert response.status_code == 200
    provider.images.generate.assert_called_once()
    upstream_key = provider.images.generate.call_args.kwargs["extra_headers"]["Idempotency-Key"]
    assert uuid.UUID(upstream_key).version == 4
    receipt = IdempotencyKey.objects.get(
        scope="ai_image", user=creator,
        request_hash=fingerprint({
            "action": "ai_image", "intent": "openai_image",
            "prompt": "headerless OpenAI request", "size": "1024x1024",
        }),
    )
    operation = receipt.response_body["_image_operation"]
    assert operation["key_source"] == "server_generated"
    assert operation["provider_request_state"] == "completed"


@pytest.mark.django_db
def test_headerless_openai_safety_refusal_remains_cleanup_eligible(
    api_client, creator, mocker, settings,
):
    settings.FAL_IMAGE_ENABLED = False
    api_client.force_login(creator)
    provider = _stub_provider(mocker, side_effect=_bad_request_error(
        "content_policy_violation", "The prompt was rejected by safety policy.",
    ))

    response = api_client.post(
        IMAGE_URL, {"prompt": "headerless refused prompt"}, format="json",
    )

    assert response.status_code == 400
    assert response.data["code"] == "image_generation_safety_refused"
    assert response.data["key_resolved"] is True
    provider.images.generate.assert_called_once()
    receipt = IdempotencyKey.objects.get(
        scope="ai_image", user=creator,
        request_hash=fingerprint({
            "action": "ai_image", "intent": "openai_image",
            "prompt": "headerless refused prompt", "size": "1024x1024",
        }),
    )
    assert receipt.response_body["_image_operation"]["key_source"] == "server_generated"
    assert receipt.response_body["_image_operation"]["result_state"] == "safety_refused"

    from django.core.management import call_command
    IdempotencyKey.objects.filter(pk=receipt.pk).update(
        created_at=timezone.now() - timedelta(days=366),
    )
    call_command("cleanup_idempotency")
    assert not IdempotencyKey.objects.filter(pk=receipt.pk).exists()


@pytest.mark.django_db
def test_completed_image_receipt_replays_after_provider_switch_but_prompt_mismatch_fails(
    api_client, creator, mocker, settings,
):
    from dj.apps.tuzis.models import fingerprint

    _enable_fal(settings)
    api_client.force_login(creator)
    key = str(uuid.uuid4())
    api_client.credentials(HTTP_IDEMPOTENCY_KEY=key)
    prompt = "same cover after provider configuration changed"
    original = IdempotencyKey.objects.create(
        scope="ai_image", user=creator, key=key,
        request_hash=fingerprint({
            "action": "ai_image", "intent": "openai_image",
            "prompt": prompt, "size": "1024x1024",
        }),
        response_status=200,
        response_body={"value": "/media/previous-cover.webp"},
    )
    provider = _stub_fal_http(mocker)

    replay = api_client.post(IMAGE_URL, {"prompt": prompt}, format="json")
    mismatch = api_client.post(
        IMAGE_URL, {"prompt": "different prompt"}, format="json",
    )

    assert replay.status_code == 200, replay.data
    assert replay.data == "/media/previous-cover.webp"
    assert mismatch.status_code == 409
    assert mismatch.data["code"] == "idempotency_mismatch"
    provider.post.assert_not_called()
    original.refresh_from_db()
    assert original.response_body == {"value": "/media/previous-cover.webp"}


@pytest.mark.django_db
def test_fal_ambiguous_timeout_releases_user_hold_but_never_retries(
    session_client, creator, mocker, settings,
):
    _enable_fal(settings, session_client)
    provider = _stub_fal_http(
        mocker,
        post_side_effect=httpx2.TimeoutException("private prompt response"),
    )
    prompt = "ambiguous private prompt"

    first = session_client.post(IMAGE_URL, {"prompt": prompt}, format="json")
    second = session_client.post(IMAGE_URL, {"prompt": prompt}, format="json")

    assert first.status_code == second.status_code == 503
    assert first.data["key_resolved"] is True
    assert first.data["code"] == "image_generation_outcome_uncertain"
    assert second.data["key_resolved"] is True
    provider.post.assert_called_once()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)
    receipt = IdempotencyKey.objects.get(
        scope="ai_image", user=creator, key=session_client.idempotency_key,
    )
    operation = receipt.response_body["_image_operation"]
    assert operation["billing_state"] == "unknown"
    assert operation["budget_state"] == "uncertain"
    assert operation["billed_usd"] is None
    assert prompt not in str(receipt.response_body)


@pytest.mark.django_db
def test_fal_failed_accepted_queue_receipt_retains_provider_id(
    session_client, creator, mocker, settings,
):
    _enable_fal(settings, session_client)
    provider = _stub_fal_http(mocker)
    status_responses = iter([
        SimpleNamespace(status_code=200, json=lambda: {"status": "FAILED"}),
    ])
    def fail_after_receipt_is_persisted(*args, **kwargs):
        receipt = IdempotencyKey.objects.get(
            scope="ai_image", user=creator, key=session_client.idempotency_key,
        )
        assert receipt.response_status is None
        assert receipt.response_body["_image_operation"]["request_id"] == "fal-request-123"
        return next(status_responses)

    provider.get.side_effect = fail_after_receipt_is_persisted
    prompt = "incomplete result prompt"

    first = session_client.post(IMAGE_URL, {"prompt": prompt}, format="json")
    replay = session_client.post(IMAGE_URL, {"prompt": prompt}, format="json")

    assert first.status_code == replay.status_code == 503
    assert first.data["key_resolved"] is True
    assert replay.data["key_resolved"] is True
    provider.post.assert_called_once()
    receipt = IdempotencyKey.objects.get(
        scope="ai_image", user=creator, key=session_client.idempotency_key,
    )
    operation = receipt.response_body["_image_operation"]
    assert operation["request_id"] == "fal-request-123"
    assert operation["provider_status"] == "FAILED"
    assert operation["billing_state"] == "unknown"
    assert operation["budget_state"] == "uncertain"
    assert prompt not in str(receipt.response_body)


@pytest.mark.django_db
def test_fal_invalid_image_is_not_stored_and_remains_unreconciled(
    session_client, creator, mocker, settings, _local_media,
):
    _enable_fal(settings, session_client)
    provider = _stub_fal_http(mocker, image=b"not an image")

    response = session_client.post(
        IMAGE_URL, {"prompt": "image bytes must be decoded"}, format="json",
    )

    assert response.status_code == 503
    assert response.data["key_resolved"] is True
    provider.post.assert_called_once()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)
    assert GenericFile.objects.filter(owner=creator).count() == 0
    assert _media_files(_local_media) == []
    receipt = IdempotencyKey.objects.get(
        scope="ai_image", user=creator, key=session_client.idempotency_key,
    )
    operation = receipt.response_body["_image_operation"]
    assert operation["billing_state"] == "unknown"
    assert operation["billed_usd"] is None
    assert operation["estimated_usd"] == "0.006"
    assert operation["budget_state"] == "uncertain"
    assert operation["result_state"] == "download_failed"
    assert operation["request_id"] == "fal-request-123"


@pytest.mark.django_db
def test_unexpected_error_after_acceptance_keeps_persisted_request_id(
    session_client, creator, mocker, settings,
):
    _enable_fal(settings, session_client)
    provider = _stub_fal_http(mocker)
    provider.get.side_effect = RuntimeError("unexpected local adapter error")

    response = session_client.post(
        IMAGE_URL, {"prompt": "persist accepted request identity"}, format="json",
    )

    assert response.status_code == 503
    assert response.data["key_resolved"] is True
    receipt = IdempotencyKey.objects.get(
        scope="ai_image", user=creator, key=session_client.idempotency_key,
    )
    operation = receipt.response_body["_image_operation"]
    assert operation["request_id"] == "fal-request-123"
    assert operation["billing_state"] == "unknown"
    assert operation["budget_state"] == "uncertain"


@pytest.mark.django_db
@pytest.mark.parametrize("failure", ["storage", "settlement"])
def test_fal_successful_generation_storage_failure_keeps_reconciliation_receipt(
    session_client, creator, mocker, settings, caplog, failure,
):
    _enable_fal(settings, session_client)
    provider = _stub_fal_http(mocker)
    prompt = "storage failure prompt must stay out of logs"
    if failure == "storage":
        mocker.patch("dj.apps.openai.views.GenericFile.objects.create",
            side_effect=OSError("storage backend unavailable"))
    else:
        mocker.patch("dj.apps.openai.views.ledger.settle_reservation",
            side_effect=ledger.InsufficientFunds(creator, IMAGE_COST, balance=Decimal("0")))

    response = session_client.post(IMAGE_URL, {"prompt": prompt}, format="json")

    assert response.status_code == 503
    provider.post.assert_called_once()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)
    receipt = IdempotencyKey.objects.get(
        scope="ai_image", user=creator, key=session_client.idempotency_key,
    )
    operation = receipt.response_body["_image_operation"]
    assert operation["request_id"] == "fal-request-123"
    assert operation["provider_status"] == "COMPLETED"
    assert operation["billing_state"] == "unreconciled"
    assert operation["billed_usd"] is None
    assert operation["estimated_usd"] == "0.006"
    assert operation["result_state"] == "storage_failed"
    assert operation["result"] is None
    assert operation["budget_day"]
    assert prompt not in caplog.text
    assert receipt.response_status == 503
    replay = session_client.post(IMAGE_URL, {"prompt": prompt}, format="json")
    assert replay.status_code == 503 and replay.data["key_resolved"] is True
    provider.post.assert_called_once()
    assert not GenericFile.objects.filter(owner=creator).exists()
    assert not Webp.objects.filter(parent__owner=creator).exists()


@pytest.mark.django_db
@pytest.mark.parametrize("rejection_status", [422, 429])
def test_fal_definite_rejection_releases_claim_and_reservation(
    session_client, creator, mocker, settings, rejection_status,
):
    _enable_fal(settings, session_client)
    provider = _stub_fal_http(
        mocker,
        post_side_effect=[
                SimpleNamespace(status_code=rejection_status),
                SimpleNamespace(
                    status_code=200,
                    json=lambda: {
                        "request_id": "retry-safe-request",
                        "response_url": (
                            "https://queue.fal.run/fal-ai/flux/schnell/requests/"
                            "retry-safe-request"
                        ),
                        "status_url": (
                            "https://queue.fal.run/fal-ai/flux/schnell/requests/"
                            "retry-safe-request/status"
                        ),
                    },
                ),
        ],
    )

    first = session_client.post(IMAGE_URL, {"prompt": "retry after rejection"}, format="json")
    creator.refresh_from_db()
    assert first.status_code == 503
    assert creator.tuzis == Decimal(IMAGE_COST + 5)
    second = session_client.post(IMAGE_URL, {"prompt": "retry after rejection"}, format="json")

    assert second.status_code == 200
    assert provider.post.call_count == 2
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(5)


@pytest.mark.django_db
@pytest.mark.parametrize(
    "setting,value",
    [
        ("FAL_IMAGE_ENABLED", False),
        ("FAL_IMAGE_DAILY_BUDGET_USD", "0.002"),
    ],
)
def test_fal_unavailable_policy_or_budget_fails_before_provider(
    session_client, creator, mocker, settings, setting, value,
):
    _enable_fal(settings, session_client)
    setattr(settings, setting, value)
    provider = _stub_fal_http(mocker)

    response = session_client.post(
        IMAGE_URL, {"prompt": "not admitted"}, format="json",
    )

    assert response.status_code == 409
    assert response.data["detail"] == "This image model is no longer available."
    provider.post.assert_not_called()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)
    assert not IdempotencyKey.objects.filter(
        scope="ai_image", user=creator, key=session_client.idempotency_key,
    ).exists()


@pytest.mark.django_db
def test_fal_daily_usd_budget_counts_prior_success(
    session_client, creator, mocker, settings,
):
    _enable_fal(settings, session_client)
    settings.FAL_IMAGE_DAILY_BUDGET_USD = "0.006"
    provider = _stub_fal_http(mocker)
    first = session_client.post(IMAGE_URL, {"prompt": "first"}, format="json")
    assert first.status_code == 200

    second_key = str(uuid.uuid4())
    session_client.credentials(HTTP_IDEMPOTENCY_KEY=second_key)
    second = session_client.post(IMAGE_URL, {"prompt": "second"}, format="json")

    assert second.status_code == 503
    assert provider.post.call_count == 1
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(5)


@pytest.mark.django_db
def test_request_user_reaching_the_view_is_a_lazy_object(
    session_client, creator, mocker,
):
    """Pin the precondition, so this can't silently stop being tested.

    If DRF/Django ever start handing the view a concrete instance, the test
    above stops covering the bug -- this assertion fails loudly instead.
    """
    seen = {}
    real_reserve = ledger.reserve

    def _spy(user, amount, **kwargs):
        seen["type"] = type(user)
        seen["class"] = user.__class__
        return real_reserve(user, amount, **kwargs)

    mocker.patch.object(ledger, "reserve", _spy)
    _stub_provider(mocker)

    session_client.post(IMAGE_URL, {"prompt": "lazy"}, format="json")

    assert seen["type"] is SimpleLazyObject, (
        "request.user is no longer lazy; the type()-vs-__class__ regression "
        "test above is no longer meaningful"
    )
    assert seen["class"] is type(creator)


@pytest.mark.django_db
def test_ledger_moves_money_for_a_lazy_user(creator):
    """The money primitives must work on the proxy, not just on an instance."""
    lazy = SimpleLazyObject(lambda: creator)

    ledger.debit(lazy, IMAGE_COST)
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(5)

    ledger.credit(
        lazy, IMAGE_COST, source="sys:promo", ref_kind="tuzi_grant",
        ref_id="lazy", idem=f"test-lazy:{uuid.uuid4()}",
    )
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


# --------------------------------------------------------------------------
# The atomicity claim -- the actual behaviour change -- against Postgres.
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_charging_is_atomic_against_a_stale_in_memory_balance(
    creator_factory,
):
    """Two request-scoped copies of the same user cannot both be charged.

    This is what the conditional `UPDATE... SET tuzis = tuzis - 6
    WHERE tuzis >= 6` buys over `user.tuzis -= 6; user.save()`: the second
    holder has a stale in-memory balance, and the database -- not Python --
    is the arbiter. A read-modify-write would let both through and overdraw
    the account.
    """
    creator = creator_factory(tuzis=Decimal(IMAGE_COST))
    model = type(creator)
    first = model.objects.get(pk=creator.pk)
    second = model.objects.get(pk=creator.pk)
    assert first.tuzis == second.tuzis == Decimal(IMAGE_COST)

    ledger.debit(first, IMAGE_COST)

    with pytest.raises(ledger.InsufficientFunds):
        ledger.debit(second, IMAGE_COST)

    creator.refresh_from_db()
    assert creator.tuzis == Decimal(0)


@pytest.mark.django_db
def test_insufficient_balance_is_rejected_without_calling_the_provider(
    api_client, creator_factory, mocker,
):
    broke = creator_factory(tuzis=Decimal(IMAGE_COST - 1))
    api_client.force_login(broke)
    provider = _stub_provider(mocker)

    response = api_client.post(
        IMAGE_URL, {"prompt": "A mountain cover"}, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))

    assert response.status_code == 402
    assert response.data["code"] == "insufficient_funds"
    assert Decimal(response.data["cost"]) == Decimal(IMAGE_COST)
    assert Decimal(response.data["balance"]) == Decimal(IMAGE_COST - 1)
    assert Decimal(response.data["shortfall"]) == Decimal("1")
    assert response.data["action"] == "ai_image"
    provider.images.generate.assert_not_called()
    broke.refresh_from_db()
    assert broke.tuzis == Decimal(IMAGE_COST - 1)


@pytest.mark.django_db
def test_anonymous_requests_are_rejected(api_client, mocker):
    provider = _stub_provider(mocker)

    response = api_client.post(
        IMAGE_URL, {"prompt": "A mountain cover"}, format="json")

    assert response.status_code in (401, 403)
    provider.images.generate.assert_not_called()


# --------------------------------------------------------------------------
# Request contract.
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_dalle3_size_is_rejected_before_charging(
    session_client, creator, mocker,
):
    """`1792x1024` is a DALL-E 3 size; gpt-image cannot produce it.

    PR 's cover panel used to post exactly this.
    """
    provider = _stub_provider(mocker)

    response = session_client.post(
        IMAGE_URL,
        {"prompt": "An oversized cover", "size": "1792x1024"},
        format="json",
    )

    assert response.status_code == 400
    provider.images.generate.assert_not_called()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


@pytest.mark.django_db
def test_omitted_size_falls_back_to_the_square_default(
    session_client, mocker,
):
    """The classic React UI posts `prompt` only."""
    provider = _stub_provider(mocker)

    response = session_client.post(
        IMAGE_URL, {"prompt": "A square cover"}, format="json")

    assert response.status_code == 200
    assert provider.images.generate.call_args.kwargs["size"] == "1024x1024"


@pytest.mark.django_db
def test_overlong_prompt_is_rejected_before_charging(
    session_client, creator, mocker,
):
    provider = _stub_provider(mocker)

    response = session_client.post(
        IMAGE_URL, {"prompt": "x" * 4001}, format="json")

    assert response.status_code == 400
    provider.images.generate.assert_not_called()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


# --------------------------------------------------------------------------
# Failure paths: unresolved provider billing keeps its hold and key terminal,
# and no half-written blob may survive.
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_provider_failure_keeps_unknown_outcome_held_and_never_replays(
    session_client, creator, mocker, _local_media,
):
    provider = _stub_provider(mocker, side_effect=RuntimeError("provider unavailable"))

    first = session_client.post(
        IMAGE_URL, {"prompt": "A mountain cover"}, format="json")
    replay = session_client.post(
        IMAGE_URL, {"prompt": "A mountain cover"}, format="json")

    assert first.status_code == replay.status_code == 503
    assert first.data["code"] == "image_generation_outcome_uncertain"
    assert first.data["key_resolved"] is True
    provider.images.generate.assert_called_once()
    from dj.apps.ledger.models import LedgerHold
    assert LedgerHold.objects.filter(logical_key=f"ai_image:{session_client.idempotency_key}").exists()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)
    assert GenericFile.objects.count() == 0
    assert _media_files(_local_media) == []


@pytest.mark.django_db
def test_malformed_provider_payload_keeps_unknown_outcome_held(
    session_client, creator, mocker, _local_media,
):
    client = mocker.patch("dj.apps.openai.views.oai_client")
    client.images.generate.return_value = SimpleNamespace(
        data=[SimpleNamespace(b64_json="not valid base64")],
    )

    response = session_client.post(
        IMAGE_URL, {"prompt": "A mountain cover"}, format="json")

    assert response.status_code == 503
    assert response.data["code"] == "image_generation_outcome_uncertain"
    assert response.data["key_resolved"] is True
    from dj.apps.ledger.models import LedgerHold
    assert LedgerHold.objects.filter(logical_key=f"ai_image:{session_client.idempotency_key}").exists()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)
    assert GenericFile.objects.count() == 0
    assert _media_files(_local_media) == []


@pytest.mark.django_db
def test_empty_provider_payload_keeps_unknown_outcome_held(
    session_client, creator, mocker, _local_media,
):
    client = mocker.patch("dj.apps.openai.views.oai_client")
    client.images.generate.return_value = SimpleNamespace(
        data=[SimpleNamespace(b64_json=None)],
    )

    response = session_client.post(
        IMAGE_URL, {"prompt": "A mountain cover"}, format="json")

    assert response.status_code == 503
    assert response.data["code"] == "image_generation_outcome_uncertain"
    assert response.data["key_resolved"] is True
    from dj.apps.ledger.models import LedgerHold
    assert LedgerHold.objects.filter(logical_key=f"ai_image:{session_client.idempotency_key}").exists()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)
    assert _media_files(_local_media) == []


# --------------------------------------------------------------------------
#  a prompt the provider refuses is the caller's problem, not a 500.
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_content_policy_violation_is_400_not_500(
    session_client, creator, mocker, _local_media,
):
    """The exact prod traceback in: an unhandled `BadRequestError`.

    `openai.BadRequestError` propagated out of the view, so every disallowed
    prompt was a 500 and a page. It must be a 400 the UI can show.
    """
    provider = _stub_provider(mocker, side_effect=_bad_request_error(
        "content_policy_violation",
        "Your request was rejected as a result of our safety system. Your "
        "prompt may contain text that is not allowed by our safety system.",
    ))

    body = {"prompt": "something disallowed"}
    response = session_client.post(IMAGE_URL, body, format="json")
    replay = session_client.post(IMAGE_URL, body, format="json")

    assert response.status_code == 400, response.content
    assert response.data["code"] == "image_generation_safety_refused"
    assert response.data["key_resolved"] is True
    assert "safety system" in response.data["detail"]
    assert replay.data == response.data
    provider.images.generate.assert_called_once()

    # Refused prompts are free: the debit rolled back with the transaction.
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)
    assert GenericFile.objects.count() == 0
    assert Webp.objects.count() == 0
    assert _media_files(_local_media) == []


@pytest.mark.django_db
def test_other_prompt_rejections_surface_their_message_as_400(
    session_client, creator, mocker,
):
    """Not only content policy — any prompt-attributable refusal is a 400."""
    provider = _stub_provider(mocker, side_effect=_bad_request_error(
        "invalid_prompt", "Your prompt could not be processed.",
    ))

    body = {"prompt": "A mountain cover"}
    response = session_client.post(IMAGE_URL, body, format="json")
    replay = session_client.post(IMAGE_URL, body, format="json")

    assert response.status_code == 400, response.content
    assert response.data["code"] == "image_generation_safety_refused"
    assert response.data["key_resolved"] is True
    assert response.data["detail"] == "Your prompt could not be processed."
    assert replay.data == response.data
    provider.images.generate.assert_called_once()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


@pytest.mark.django_db
def test_configuration_bad_request_is_503_and_logged_as_an_error(
    session_client, creator, mocker, caplog,
):
    """A 400 that is OUR fault must not be dressed up as the user's.

    If `OPENAI_IMAGE_MODEL` is retired or a parameter stops being accepted,
    EVERY request 400s. Answering `400 "try a different prompt"` and logging a
    warning would leave image generation dead with nobody paged — trading
    's noisy 500 for a silent outage. This is the guard against that.
    """
    _stub_provider(mocker, side_effect=_bad_request_error(
        "unsupported_parameter", "Unknown parameter: 'output_format'.",
    ))

    with caplog.at_level(logging.ERROR, logger="dj.apps.openai.views"):
        response = session_client.post(
            IMAGE_URL, {"prompt": "A mountain cover"}, format="json")

    assert response.status_code == 503, response.content
    assert "prompt" not in response.data["detail"].lower()
    # ERROR, not WARNING: the error reporter has to see a total outage.
    assert [r for r in caplog.records if r.levelno >= logging.ERROR]
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


@pytest.mark.django_db
def test_bad_request_without_a_parsable_body_is_503(
    session_client, creator, mocker,
):
    """`exc.body` is None when the 400 wasn't JSON (a proxy/CDN 400).

    No code means we cannot attribute it to the prompt, so it takes the loud
    path rather than being silently blamed on the user.
    """
    _stub_provider(mocker, side_effect=BadRequestError(
        "Bad Request", response=_http_400(None), body=None,
    ))

    response = session_client.post(
        IMAGE_URL, {"prompt": "A mountain cover"}, format="json")

    assert response.status_code == 503, response.content
    assert response.data["detail"]
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


@pytest.mark.django_db
def test_unexpected_provider_errors_are_terminal_uncertain_not_retried(
    session_client, creator, mocker,
):
    provider = _stub_provider(mocker, side_effect=RuntimeError("connection reset"))

    first = session_client.post(
        IMAGE_URL, {"prompt": "A mountain cover"}, format="json")
    replay = session_client.post(
        IMAGE_URL, {"prompt": "A mountain cover"}, format="json")

    assert first.status_code == replay.status_code == 503
    assert first.data["code"] == "image_generation_outcome_uncertain"
    assert first.data["key_resolved"] is True
    provider.images.generate.assert_called_once()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


@pytest.mark.django_db
def test_rate_limit_releases_the_claim_for_same_key_retry(
    session_client, creator, mocker,
):
    provider = _stub_provider(
        mocker,
        side_effect=[
            RateLimitError(
                "rate limited", response=_http_429(), body={"error": "rate_limit"}
            ),
            _provider_response(),
        ],
    )
    key = session_client.idempotency_key
    body = {"prompt": "A mountain cover"}

    refused = session_client.post(IMAGE_URL, body, format="json")
    replay = session_client.post(IMAGE_URL, body, format="json")

    assert refused.status_code == 503, refused.content
    assert replay.status_code == 200, replay.content
    assert provider.images.generate.call_count == 2
    assert not IdempotencyKey.objects.filter(
        user=creator, scope="ai_image", key=key,
    ).filter(response_status__isnull=True).exists()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal("5")


@pytest.mark.django_db
def test_failure_after_persistence_cleans_up_both_blobs(
    session_client, creator, mocker, _local_media,
):
    """Both files are written before this raises; neither may survive.

    Storage is not transactional, so the view's database rollback removes the
    rows but cannot remove the blobs -- only `delete_generated_files` can. That
    makes the on-disk assertion the real subject here.
    """
    _stub_provider(mocker)
    mocker.patch.object(
        Webp, "get_url", side_effect=RuntimeError("url unavailable"))

    response = session_client.post(
        IMAGE_URL, {"prompt": "A mountain cover"}, format="json")

    assert response.status_code == 503
    assert response.data["code"] == "image_generation_outcome_uncertain"
    assert response.data["key_resolved"] is True

    assert _media_files(_local_media) == []
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)
    assert GenericFile.objects.count() == 0
    assert Webp.objects.count() == 0


@pytest.mark.django_db(transaction=True)
def test_storage_failure_leaves_durable_cleanup_after_view_rollback(
    session_client, creator, mocker, _local_media,
):
    """A doomed image transaction cannot erase the cleanup recovery row."""
    _stub_provider(mocker)
    mocker.patch.object(
        Webp, "get_url", side_effect=RuntimeError("url unavailable"))
    from django.core.files.storage import default_storage
    storage = default_storage
    storage._setup()
    storage_backend = storage._wrapped
    storage_delete = mocker.patch.object(
        storage_backend,
        "delete",
        side_effect=RuntimeError("storage unavailable"),
    )
    before_job_ids = set(
        ProcrastinateJob.objects.filter(
            task_name="uploads.delete_pending_blob",
        ).values_list("pk", flat=True)
    )

    response = session_client.post(
        IMAGE_URL, {"prompt": "A mountain cover"}, format="json")

    assert response.status_code == 503
    assert response.data["code"] == "image_generation_outcome_uncertain"
    assert response.data["key_resolved"] is True

    pending = list(PendingUploadBlobDeletion.objects.order_by("name"))
    assert {row.name for row in pending}
    assert len(pending) == 2
    assert all(row.last_enqueued_at is not None for row in pending)
    assert all(storage.exists(row.name) for row in pending)

    mocker.stop(storage_delete)
    for row in pending:
        delete_pending_blob(pending_blob_id=row.pk)

    assert not PendingUploadBlobDeletion.objects.exists()
    assert _media_files(_local_media) == []
    ProcrastinateJob.objects.filter(
        task_name="uploads.delete_pending_blob",
    ).exclude(pk__in=before_job_ids).delete()


@pytest.mark.django_db(transaction=True)
def test_generation_metadata_failure_enqueues_existing_rollback_cleanup(
    creator, settings, mocker,
):
    """Metadata failure cannot lose the row created after the rollback."""
    class FakeGoogleCloudStorage:
        pass

    storage = FakeGoogleCloudStorage()
    storage.bucket = mocker.Mock()
    settings.NAMESPACE = "prod"
    mocker.patch(
        "storages.backends.gcloud.GoogleCloudStorage",
        FakeGoogleCloudStorage,
    )
    mocker.patch.object(upload_tasks, "storages", {"default": storage})

    with pytest.raises(RuntimeError, match="roll back image rows"):
        with transaction.atomic():
            doomed = GenericFile.objects.create(
                owner=creator,
                file=ContentFile(b"doomed", name="metadata-failure.png"),
                mime_type="image/png",
            )
            name = doomed.file.name
            raise RuntimeError("roll back image rows")

    def fail_metadata(*args, **kwargs):
        assert PendingUploadBlobDeletion.objects.filter(name=name).exists()
        raise RuntimeError("metadata unavailable")

    storage.bucket.get_blob.side_effect = fail_metadata

    delete_generated_files(None, doomed)

    pending = PendingUploadBlobDeletion.objects.get(name=name)
    assert pending.generation is None
    assert pending.last_enqueued_at is not None
    assert ProcrastinateJob.objects.filter(
        task_name="uploads.delete_pending_blob",
        args__pending_blob_id=pending.pk,
    ).exists()


@pytest.mark.django_db(transaction=True)
def test_cleanup_preserves_a_png_key_referenced_by_another_live_file(
    creator,
):
    """Rollback cleanup must not erase a legacy/manual duplicate key."""
    keeper = GenericFile.objects.create(
        owner=creator,
        file=ContentFile(b"keeper", name="keeper.png"),
        mime_type="image/png",
    )
    shared_name = keeper.file.name
    doomed = GenericFile.objects.create(
        owner=creator,
        file=ContentFile(b"doomed", name="doomed.png"),
        mime_type="image/png",
    )
    unused_name = doomed.file.name
    # Only a legacy row flagged by uploads migration 0014 can share a key.
    GenericFile.objects.filter(pk=doomed.pk).update(
        file=shared_name, legacy_shared_file=True)
    doomed.refresh_from_db()
    doomed.file.storage.delete(unused_name)

    delete_generated_files(None, doomed)

    assert not GenericFile.objects.filter(pk=doomed.pk).exists()
    assert GenericFile.objects.filter(pk=keeper.pk).exists()
    assert keeper.file.storage.exists(shared_name)


@pytest.mark.django_db(transaction=True)
def test_cleanup_deletes_own_png_inside_a_doomed_transaction(creator):
    with pytest.raises(RuntimeError, match="doom this transaction"):
        with transaction.atomic():
            doomed = GenericFile.objects.create(
                owner=creator,
                file=ContentFile(b"doomed", name="doomed.png"),
                mime_type="image/png",
            )
            name = doomed.file.name

            delete_generated_files(None, doomed)

            assert not doomed.file.storage.exists(name)
            raise RuntimeError("doom this transaction")

    assert not GenericFile.objects.filter(file=name).exists()
    assert not doomed.file.storage.exists(name)


@pytest.mark.django_db
def test_disclosed_stale_openai_claim_keeps_uncertain_hold_and_never_dispatches(
    session_client, creator, mocker,
):
    from .views import _cover_choice_snapshot
    provider = _stub_provider(mocker)
    choice = session_client.get("/api/ai/creator-options/").data["cover"][0]
    body = {"prompt": "Ambiguous disclosed cover", "size": "1024x1024",
            "choice": choice["id"], "choice_snapshot": choice["snapshot_token"]}
    payload = {"action": "ai_image", "intent": "creator_cover",
               "choice": choice["id"], "prompt": body["prompt"], "size": body["size"]}
    from dj.apps.ledger.models import LedgerHold
    reservation = ledger.reserve(creator, IMAGE_COST, scope="ai_image", operation_key=session_client.idempotency_key)
    record = IdempotencyKey.objects.create(
        scope="ai_image", user=creator, key=session_client.idempotency_key,
        request_hash=fingerprint(payload),
        response_body={"operation": "ai_image", "state": "provider_pending",
                       "_provider_intent_snapshot": {
                           "choice_snapshot": choice["snapshot_token"],
                           "server_snapshot": _cover_choice_snapshot(), "legacy_request": False}},
    )
    IdempotencyKey.objects.filter(pk=record.pk).update(
        created_at=timezone.now() - STALE_CLAIM - timedelta(seconds=1),
    )
    first = session_client.post(IMAGE_URL, body, format="json")
    assert LedgerHold.objects.filter(pk=reservation.pk).exists()
    record.refresh_from_db()
    assert record.response_body["credit_reservation_state"] == "unknown"
    assert record.response_body["_image_operation"]["provider"] == "openai"
    replay = session_client.post(IMAGE_URL, body, format="json")
    assert first.status_code == replay.status_code == 503
    assert first.data["code"] == "image_generation_outcome_uncertain"
    assert replay.data["credit_reservation_state"] == "unknown"
    provider.images.generate.assert_not_called()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


@pytest.mark.django_db
@pytest.mark.parametrize("verdict,expected_status", [(True, 400), (None, 503), ("false", 503), (0, 503)])
def test_fal_moderation_fails_closed_without_charge_or_duplicate_submission(
    session_client, creator, mocker, settings, _local_media, verdict, expected_status,
):
    _enable_fal(settings, session_client)
    provider = _stub_fal_http(mocker, verdict=verdict)
    payload = {"prompt": "moderation verdict"}
    first = session_client.post(IMAGE_URL, payload, format="json")
    replay = session_client.post(IMAGE_URL, payload, format="json")
    assert first.status_code == replay.status_code == expected_status
    assert first.data == replay.data
    assert first.data["key_resolved"] is True
    if verdict is True:
        assert first.data["code"] == "moderation_blocked"
        assert "safety system" in first.data["detail"]
    provider.post.assert_called_once()
    assert provider.stream.call_count == 3  # submission/status/result, no image download
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)
    assert not GenericFile.objects.filter(owner=creator).exists()
    assert _media_files(_local_media) == []
    receipt = IdempotencyKey.objects.get(scope="ai_image", user=creator, key=session_client.idempotency_key)
    operation = receipt.response_body["_image_operation"]
    assert operation["budget_state"] == "uncertain"
    assert operation["billed_usd"] is None
    assert operation["request_id"] == "fal-request-123"


@pytest.mark.django_db
def test_enabling_fal_does_not_switch_legacy_openai_requests(session_client, mocker, settings):
    _enable_fal(settings)
    provider = _stub_provider(mocker)
    fal = _stub_fal_http(mocker)
    response = session_client.post(IMAGE_URL, {"prompt": "legacy OpenAI request"}, format="json")
    assert response.status_code == 200
    provider.images.generate.assert_called_once()
    fal.post.assert_not_called()


@pytest.mark.django_db
def test_fal_account_budget_refuses_new_key_but_replays_owned_receipt(session_client, creator, mocker, settings):
    _enable_fal(settings, session_client)
    settings.FAL_IMAGE_ACCOUNT_DAILY_BUDGET_USD = "0.006"
    provider = _stub_fal_http(mocker, verdict=True)
    first = session_client.post(IMAGE_URL, {"prompt": "refused generation"}, format="json")
    assert first.status_code == 400
    first_key = session_client.idempotency_key
    session_client.credentials(HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
    exhausted = session_client.post(IMAGE_URL, {"prompt": "a new prompt"}, format="json")
    assert exhausted.status_code == 429
    assert exhausted.data["code"] == "image_daily_budget_exceeded"
    assert exhausted.data["key_resolved"] is True
    session_client.credentials(HTTP_IDEMPOTENCY_KEY=first_key)
    replay = session_client.post(IMAGE_URL, {"prompt": "refused generation"}, format="json")
    assert replay.status_code == first.status_code
    assert replay.data == first.data
    provider.post.assert_called_once()
    assert IdempotencyKey.objects.filter(scope="ai_image", user=creator).count() == 1
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


@pytest.mark.django_db
@pytest.mark.parametrize("delete_during_provider", [False, True])
def test_image_provider_completion_cannot_restore_deleted_account_uploads(
    session_client, creator, mocker, settings, _local_media, delete_during_provider,
):
    from dj.apps.g12f.account_deletion import delete_account
    from dj.apps.g12f.models import Creator
    from dj.apps.ledger.models import LedgerHold
    from dj.apps.openai import hosted_image

    _enable_fal(settings, session_client)
    _stub_fal_http(mocker)
    create_file = mocker.spy(GenericFile.objects, "create")
    generate = hosted_image.generate

    def delete():
        current = Creator.objects.get(pk=creator.pk)
        delete_account(current, confirm_username=current.username, auth_epoch=current.kt_account_epoch)

    def generate_then_delete(*args, **kwargs):
        result = generate(*args, **kwargs)
        # Provider accepted/completed, while the HTTP image request is paused
        # before its local persistence transaction. Deletion commits first.
        delete()
        return result

    if delete_during_provider:
        mocker.patch.object(hosted_image, "generate", side_effect=generate_then_delete)
    response = session_client.post(IMAGE_URL, {"prompt": "private deleted cover"}, format="json")
    assert response.status_code == (503 if delete_during_provider else 200)
    if delete_during_provider:
        create_file.assert_not_called()
    if not delete_during_provider:
        assert GenericFile.objects.filter(owner_id=creator.pk).exists()
        delete()
    assert not GenericFile.objects.filter(owner_id=creator.pk).exists()
    assert not Webp.objects.filter(parent__owner_id=creator.pk).exists()
    assert not LedgerHold.objects.filter(account__owner_id=creator.pk).exists()
    receipt = IdempotencyKey.objects.get(scope="ai_image", user_id=creator.pk)
    assert receipt.response_body["_account_deletion_scrubbed"] is True
    assert "private deleted cover" not in str(receipt.response_body)
    assert "http" not in str(receipt.response_body)
    assert "result" not in receipt.response_body["_image_operation"]
    assert receipt.response_body["_image_operation"]["request_id"] == "fal-request-123"
    assert receipt.response_body["_image_operation"]["budget_reserved_usd"] == "0.006"


@pytest.mark.django_db
def test_stale_cover_with_changed_fingerprint_conflicts_without_provider_call(
        session_client, creator, mocker):
    provider = _stub_provider(mocker)
    choice, = session_client.get("/api/ai/creator-options/").data["cover"]
    server_snapshot = {
        key: value for key, value in choice.items()
        if key not in {"snapshot_token", "availability", "queue"}
    }
    old_prompt = "Original ambiguous cover request"
    request_hash = fingerprint({
        "action": "ai_image", "intent": "creator_cover",
        "choice": choice["id"], "prompt": old_prompt,
        "size": "1024x1024",
    })
    record = IdempotencyKey.objects.create(
        scope="ai_image", user=creator, key=session_client.idempotency_key,
        request_hash=request_hash,
        response_body={
            "operation": "ai_image", "state": "provider_pending",
            "_provider_intent_snapshot": {
                "choice_snapshot": choice["snapshot_token"],
                "server_snapshot": server_snapshot,
                "legacy_request": False,
            },
        },
    )
    IdempotencyKey.objects.filter(pk=record.pk).update(
        created_at=timezone.now() - STALE_CLAIM - timedelta(seconds=1),
    )

    response = session_client.post(
        IMAGE_URL,
        {
            "prompt": "Different request under the same key",
            "size": "1024x1024",
            "choice": choice["id"],
            "choice_snapshot": choice["snapshot_token"],
        },
        format="json",
    )

    assert response.status_code == 409
    assert response.data["code"] == "idempotency_mismatch"
    provider.images.generate.assert_not_called()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


@pytest.mark.django_db(transaction=True)
def test_stale_cover_takeover_fences_late_worker_settlement(
        session_client, creator, mocker):
    """The real receipt fence rolls back a late image settlement and files."""
    from dj.apps.ledger.models import LedgerHold
    provider = _stub_provider(mocker)
    choice, = session_client.get("/api/ai/creator-options/").data["cover"]
    key = session_client.idempotency_key
    body = {
        "prompt": "An ambiguous cover request", "size": "1024x1024",
        "choice": choice["id"], "choice_snapshot": choice["snapshot_token"],
    }
    takeover = {}

    def provider_paused_after_acceptance(**kwargs):
        record = IdempotencyKey.objects.get(
            scope="ai_image", user=creator, key=key,
        )
        IdempotencyKey.objects.filter(pk=record.pk).update(
            created_at=timezone.now() - STALE_CLAIM - timedelta(seconds=1),
        )
        takeover["response"] = session_client.post(
            IMAGE_URL, body, format="json",
        )
        takeover["hold_exists"] = LedgerHold.objects.filter(
            logical_key=f"ai_image:{key}",
        ).exists()
        takeover["receipt"] = IdempotencyKey.objects.get(pk=record.pk)
        return _provider_response()

    provider.images.generate.side_effect = provider_paused_after_acceptance
    session_client.raise_request_exception = False

    late_worker = session_client.post(IMAGE_URL, body, format="json")

    assert takeover["response"].status_code == 503
    assert takeover["response"].data["code"] == "image_generation_outcome_uncertain"
    assert takeover["response"].data["key_resolved"] is True
    assert takeover["hold_exists"] is True
    provider.images.generate.assert_called_once()
    # The stale owner can no longer settle or publish a result, while the
    # unproven upstream hold remains retained for reconciliation.
    assert late_worker.status_code == 503
    assert "url" not in late_worker.data
    assert not GenericFile.objects.filter(owner=creator).exists()
    assert not Webp.objects.filter(parent__owner=creator).exists()

    receipt = takeover["receipt"]
    operation = receipt.response_body["_image_operation"]
    assert operation["provider"] == "openai"
    assert operation["model"] == choice["model"]
    assert operation["billing_state"] == "unknown"
    assert operation["provider_request_state"] == "started"
    assert receipt.response_status == 503
    assert LedgerHold.objects.filter(logical_key=f"ai_image:{key}").exists()
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)


@pytest.mark.django_db
def test_fal_safety_refusal_key_is_scoped_to_its_actor(
    api_client, creator, creator_factory, mocker, settings,
):
    other = creator_factory(tuzis=Decimal(IMAGE_COST + 5))
    key = str(uuid.uuid4())
    provider = _stub_fal_http(mocker, verdict=True)
    clients = [api_client, type(api_client)()]
    responses = []
    for client, actor in zip(clients, [creator, other]):
        client.force_login(actor)
        client.credentials(HTTP_IDEMPOTENCY_KEY=key)
        _enable_fal(settings, client)
        provider.get.side_effect = [
            SimpleNamespace(status_code=200, json=lambda: {"status": "COMPLETED"}),
            SimpleNamespace(status_code=200, json=lambda: {
                "images": [{"url": "https://v3b.fal.media/files/test.png"}],
                "has_nsfw_concepts": [True],
            }),
        ]
        response = client.post(IMAGE_URL, {"prompt": "same private prompt"}, format="json")
        responses.append(response)
        assert response.status_code == 400
        assert response.data["code"] == "moderation_blocked"
        assert response.data["key_resolved"] is True
        assert IdempotencyKey.objects.filter(scope="ai_image", user=actor, key=key).count() == 1
        actor.refresh_from_db()
        assert actor.tuzis == Decimal(IMAGE_COST + 5)
    assert provider.post.call_count == 2
    for client, response in zip(clients, responses):
        replay = client.post(IMAGE_URL, {"prompt": "same private prompt"}, format="json")
        assert replay.status_code == response.status_code
        assert replay.data == response.data
    assert provider.post.call_count == 2


@pytest.mark.django_db
@pytest.mark.parametrize("kind", ["field", "parser", "idempotency", "openai_safety", "fal_safety"])
def test_actual_image_bad_requests_match_published_error_schema(
    session_client, creator, mocker, settings, kind,
):
    from drf_spectacular.generators import SchemaGenerator
    from jsonschema import Draft4Validator

    payload = {"prompt": "image schema fixture"}
    if kind in {"idempotency", "fal_safety"}:
        _enable_fal(settings, session_client)
        _stub_fal_http(mocker, verdict=True)
    else:
        _stub_provider(mocker, side_effect=_bad_request_error(
            "content_policy_violation", "Blocked by safety policy",
        ))
    if kind == "field":
        payload["size"] = "1792x1024"
    if kind == "idempotency":
        session_client.credentials(HTTP_IDEMPOTENCY_KEY="invalid-key")
    if kind == "parser":
        response = session_client.post(IMAGE_URL, "{", content_type="application/json")
    else:
        response = session_client.post(IMAGE_URL, payload, format="json")
    assert response.status_code == 400, response.content
    schema = SchemaGenerator().get_schema(request=None, public=True)
    contract = schema["paths"][IMAGE_URL]["post"]["responses"]["400"]["content"]["application/json"]["schema"]
    Draft4Validator({**contract, "components": schema["components"]}).validate(response.json())
    creator.refresh_from_db()
    assert creator.tuzis == Decimal(IMAGE_COST + 5)
