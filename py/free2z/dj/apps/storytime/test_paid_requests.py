"""Storytime's paid endpoints: input is bounded, and 2Z is held, before any
provider call.

Each test asserts three things together: the HTTP status, how many times the
provider was called, and where the user's 2Z ended up. A provider call that
produces no page and no charge is the outcome these invariants exist to rule
out, so "the status was 400" alone is not enough -- the fake must also show it
was never reached.

No test here calls a real provider.
"""
import base64
from decimal import Decimal
from io import BytesIO
import uuid

import pytest
from django.db import connection
from PIL import Image
from rest_framework.test import APIClient

from dj.apps.g12f.models import Creator
from dj.apps.storytime.models import Page, Story
from dj.apps.uploads.models import GenericFile

PROMPT_COLUMN = Page._meta.get_field("prompt").max_length


def _png_b64(side=8):
    out = BytesIO()
    Image.new("RGB", (side, side), (200, 30, 30)).save(out, format="PNG")
    return base64.b64encode(out.getvalue()).decode()


class _Reply:
    def __init__(self, content):
        message = type("Message", (), {"content": content})()
        self.choices = [type("Choice", (), {"message": message})()]


class FakeProvider:
    """Chat completions + image generation, recording every call.

    ``during_call`` runs inside the provider call, i.e. while the first
    request is between admission and settlement -- the window concurrent
    requests used to share.
    """

    def __init__(self, *, text="Once upon a time.", image_b64=None,
                 raises=None, during_call=None):
        self.calls = []
        outer = self

        def record(kind, kwargs):
            outer.calls.append((kind, kwargs))
            if during_call is not None and len(outer.calls) == 1:
                during_call()
            if raises is not None:
                raise raises

        class Completions:
            def create(self, **kwargs):
                record("text", kwargs)
                return _Reply(text)

        class Images:
            def generate(self, **kwargs):
                record("image", kwargs)
                item = type("Item", (), {
                    "b64_json": image_b64 if image_b64 is not None else _png_b64(),
                    "url": None,
                })()
                return type("ImagesResponse", (), {"data": [item]})()

        self.chat = type("Chat", (), {"completions": Completions()})()
        self.images = Images()


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
        },
    }
    settings.MEDIA_ROOT = str(tmp_path)


@pytest.fixture
def fake(monkeypatch):
    def install(**kwargs):
        provider = FakeProvider(**kwargs)
        monkeypatch.setattr("dj.apps.storytime.views.oai_client", provider)
        return provider
    return install


@pytest.fixture
def author(creator_factory):
    def make(tuzis):
        user = creator_factory(tuzis=Decimal(tuzis))
        story = Story.objects.create(creator=user, title="A tale")
        client = APIClient()
        client.force_authenticate(user=Creator.objects.get(pk=user.pk))
        return user, story, client
    return make


def _post(client, story, kind, body, key=None):
    return client.post(
        f"/api/storytime/{story.slug}/{kind}", body, format="json",
        HTTP_IDEMPOTENCY_KEY=key or str(uuid.uuid4()),
    )


def _balance(user):
    return Creator.objects.get(pk=user.pk).tuzis


def _held_milli(user):
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT held FROM ledger_account WHERE key = %s", [f"user:{user.pk}"])
        row = cursor.fetchone()
    return 0 if row is None else row[0]


# --------------------------------------------------------------------------- #
# Input is validated before the provider is called
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("kind", ["text", "image"])
@pytest.mark.parametrize("prompt", [
    "a" * (PROMPT_COLUMN + 1),
    "word " * 200,
    "contains a \x00 byte",
    "",
    123,
    ["list"],
    None,
])
@pytest.mark.django_db
def test_invalid_prompt_is_refused_before_the_provider(author, fake, kind, prompt):
    provider = fake()
    user, story, client = author("5")

    response = _post(client, story, kind, {"prompt": prompt})

    assert response.status_code == 400, response.content
    assert provider.calls == []
    assert _balance(user) == Decimal("5")
    assert _held_milli(user) == 0
    assert not story.pages.exists()


@pytest.mark.parametrize("size", ["4096x4096", "1x1", "", 512, None, "512x512 "])
@pytest.mark.django_db
def test_image_size_outside_the_allow_list_is_refused_before_the_provider(
        author, fake, size):
    provider = fake()
    user, story, client = author("5")

    response = _post(client, story, "image", {"prompt": "A castle", "size": size})

    assert response.status_code == 400, response.content
    assert provider.calls == []
    assert _balance(user) == Decimal("5")
    assert not story.pages.exists()


@pytest.mark.parametrize("kind", ["text", "image"])
@pytest.mark.django_db
def test_prompt_at_the_column_limit_is_accepted_and_charged_once(author, fake, kind):
    provider = fake()
    user, story, client = author("5")
    prompt = "a" * PROMPT_COLUMN

    response = _post(client, story, kind, {"prompt": prompt})

    assert response.status_code == 200, response.content
    assert len(provider.calls) == 1
    assert story.pages.get().prompt == prompt
    assert _balance(user) == Decimal("4")
    assert _held_milli(user) == 0


@pytest.mark.django_db
def test_image_request_uses_inline_image_data_and_an_allowed_size(author, fake):
    provider = fake()
    user, story, client = author("5")

    response = _post(client, story, "image", {"prompt": "A castle", "size": "256x256"})

    assert response.status_code == 200, response.content
    [(kind, kwargs)] = provider.calls
    assert kind == "image"
    assert kwargs["size"] == "256x256"
    assert kwargs["response_format"] == "b64_json"
    page = story.pages.get()
    assert page.image is not None
    assert page.image.mime_type == "image/png"
    assert _balance(user) == Decimal("4")


@pytest.mark.django_db
def test_image_size_defaults_when_omitted(author, fake):
    provider = fake()
    _, story, client = author("5")

    response = _post(client, story, "image", {"prompt": "A castle"})

    assert response.status_code == 200, response.content
    assert provider.calls[0][1]["size"] == "512x512"


@pytest.mark.parametrize("image_b64", [
    base64.b64encode(b"not an image").decode(),
    "%%% not base64 %%%",
    "",
])
@pytest.mark.django_db
def test_unusable_provider_image_stores_nothing_and_charges_nothing(
        author, fake, image_b64):
    fake(image_b64=image_b64)
    user, story, client = author("5")
    client.raise_request_exception = False
    files_before = GenericFile.objects.count()

    response = _post(client, story, "image", {"prompt": "A castle"})

    assert response.status_code >= 500, response.content
    assert not story.pages.exists()
    assert GenericFile.objects.count() == files_before
    assert _balance(user) == Decimal("5")
    assert _held_milli(user) == 0


# --------------------------------------------------------------------------- #
# 2Z is held before the provider call, and settled or released after
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("kind", ["text", "image"])
@pytest.mark.django_db
def test_price_is_held_while_the_provider_runs(author, fake, kind):
    user, story, client = author("5")
    observed = {}

    def during_call():
        observed["held"] = _held_milli(user)

    fake(during_call=during_call)

    response = _post(client, story, kind, {"prompt": "Begin."})

    assert response.status_code == 200, response.content
    assert observed["held"] == 1000
    assert _held_milli(user) == 0
    assert _balance(user) == Decimal("4")


@pytest.mark.parametrize("kind", ["text", "image"])
@pytest.mark.django_db
def test_a_balance_covers_only_as_many_provider_calls_as_it_can_pay_for(
        author, fake, kind):
    """A second request that arrives while the first is at the provider sees
    the first one's 2Z as already spoken for."""
    user, story, client = author("1")
    second = {}

    def during_call():
        second["response"] = _post(client, story, kind, {"prompt": "Again."})

    provider = fake(during_call=during_call)

    first = _post(client, story, kind, {"prompt": "Begin."})

    assert first.status_code == 200, first.content
    assert second["response"].status_code == 402, second["response"].content
    assert second["response"].data["code"] == "insufficient_funds"
    assert len(provider.calls) == 1
    assert story.pages.count() == 1
    assert _balance(user) == Decimal("0")
    assert _held_milli(user) == 0


@pytest.mark.parametrize("kind", ["text", "image"])
@pytest.mark.django_db
def test_insufficient_balance_is_refused_before_the_provider(author, fake, kind):
    provider = fake()
    user, story, client = author("0.5")

    response = _post(client, story, kind, {"prompt": "Begin."})

    assert response.status_code == 402, response.content
    assert response.data["code"] == "insufficient_funds"
    assert provider.calls == []
    assert _balance(user) == Decimal("0.5")
    assert _held_milli(user) == 0


@pytest.mark.parametrize("kind", ["text", "image"])
@pytest.mark.django_db
def test_provider_failure_releases_the_hold_and_the_key(author, fake, kind):
    fake(raises=RuntimeError("provider down"))
    user, story, client = author("5")
    client.raise_request_exception = False
    key = str(uuid.uuid4())

    failed = _post(client, story, kind, {"prompt": "Begin."}, key=key)

    assert failed.status_code >= 500
    assert _balance(user) == Decimal("5")
    assert _held_milli(user) == 0
    assert not story.pages.exists()

    # The same key may be retried, and is then charged exactly once.
    provider = fake()
    retried = _post(client, story, kind, {"prompt": "Begin."}, key=key)
    assert retried.status_code == 200, retried.content
    assert len(provider.calls) == 1
    assert _balance(user) == Decimal("4")
    assert _held_milli(user) == 0

    replayed = _post(client, story, kind, {"prompt": "Begin."}, key=key)
    assert replayed.status_code == 200, replayed.content
    assert len(provider.calls) == 1
    assert _balance(user) == Decimal("4")


@pytest.mark.parametrize("kind", ["text", "image"])
@pytest.mark.django_db
def test_requests_without_a_key_are_each_held_and_settled(author, fake, kind):
    provider = fake()
    user, story, client = author("5")

    for _ in range(2):
        response = client.post(
            f"/api/storytime/{story.slug}/{kind}", {"prompt": "Begin."},
            format="json",
        )
        assert response.status_code == 200, response.content

    assert len(provider.calls) == 2
    assert story.pages.count() == 2
    assert _balance(user) == Decimal("3")
    assert _held_milli(user) == 0
