"""The zPage meta-description listener runs on ``PROMPT_COMPLETION_MODEL``.

``describe_zpage_listener`` hard-coded ``gpt-3.5-turbo``. It also called the
search-summary path first, and when that model (``gpt-3.5-turbo-instruct``)
was retired on 2026-09-28 every callback raised there, was acked, and never
reached the description. These pin both: the model and message shape, and that
a search-index failure no longer takes the description down with it.

Real Postgres; only the OpenAI client is faked, and it exposes ONLY
``client.chat.completions`` so a regression to the legacy API fails.
"""
import json
import uuid

import pytest
from rest_framework.test import APIClient

from dj.apps.g12f.models import zPage
from dj.apps.openai.management.commands import describe_zpage_listener
from f2z.ai import providers

LONG = "Zebras have stripes, and nobody fully agrees on why. " * 5


class _Reply:
    def __init__(self, content):
        message = type("Message", (), {"content": content})()
        self.choices = [type("Choice", (), {"message": message})()]


class _ChatOnly:
    def __init__(self, content="  A short page about zebra stripes.  "):
        self.calls = []
        outer = self

        class Completions:
            def create(self, **kwargs):
                outer.calls.append(kwargs)
                return _Reply(content)

        self.chat = type("Chat", (), {"completions": Completions()})()


class _Message:
    def __init__(self, page):
        self.data = json.dumps({"free2zaddr": page.free2zaddr}).encode()
        self.acked = 0

    def ack(self):
        self.acked += 1


@pytest.fixture
def fake_client(monkeypatch):
    client = _ChatOnly()
    monkeypatch.setattr(describe_zpage_listener, "oai_client", client)
    return client


def _page(creator, **kwargs):
    defaults = dict(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        title="Stripes",
        content=LONG,
        is_published=True,
    )
    defaults.update(kwargs)
    return zPage.objects.create(**defaults)


@pytest.mark.django_db
def test_description_uses_the_prompt_model_with_the_same_messages(
        creator_factory, fake_client, settings):
    settings.PROMPT_COMPLETION_MODEL = "gpt-4o-mini"
    page = _page(creator_factory())

    assert describe_zpage_listener.describe_zpage(page) is True

    page.refresh_from_db()
    assert page.description == "A short page about zebra stripes."
    [call] = fake_client.calls
    assert call["model"] == "gpt-4o-mini"
    assert call["max_completion_tokens"] == (
        describe_zpage_listener.DESCRIPTION_MAX_TOKENS)
    assert [m["role"] for m in call["messages"]] == ["system", "user"]
    assert call["messages"][0]["content"] == describe_zpage_listener.SYSTEM
    assert call["messages"][1]["content"] == describe_zpage_listener.PROMPT(page)
    assert LONG in call["messages"][1]["content"]


@pytest.mark.django_db
def test_description_is_cut_to_250_characters(creator_factory, monkeypatch):
    monkeypatch.setattr(
        describe_zpage_listener, "oai_client", _ChatOnly("x" * 400))
    page = _page(creator_factory())
    describe_zpage_listener.describe_zpage(page)
    page.refresh_from_db()
    assert page.description == "x" * 250


@pytest.mark.django_db
def test_generated_description_is_mirrored_to_public_source_variant(
        creator_factory, fake_client, settings):
    settings.ZPAGE_VARIANT_READS = True
    page = _page(creator_factory(), source_language="en")

    assert describe_zpage_listener.describe_zpage(page) is True

    page.refresh_from_db()
    source = page.variants.get(origin="source")
    assert source.description == page.description
    response = APIClient().get(f"/api/zpage/{page.free2zaddr}/")
    assert response.status_code == 200
    assert response.data["description"] == page.description


@pytest.mark.django_db
def test_duplicate_callbacks_only_allow_the_first_description_write(
        creator_factory, monkeypatch):
    """Two callbacks can qualify from stale instances and both call the model.

    The conditional UPDATE makes the later completion lose without replacing
    the description written by the earlier callback.
    """
    page = _page(creator_factory())
    first = zPage.objects.get(pk=page.pk)
    second = zPage.objects.get(pk=page.pk)
    replies = iter(["First generated description.",
                    "Second generated description."])
    calls = []

    def complete_prompt(*args, **kwargs):
        calls.append((args, kwargs))
        return next(replies)

    monkeypatch.setattr(
        describe_zpage_listener, "complete_prompt", complete_prompt)

    assert describe_zpage_listener.describe_zpage(first) is True
    assert describe_zpage_listener.describe_zpage(second) is False

    page.refresh_from_db()
    assert page.description == "First generated description."
    assert page.variants.get(origin="source").description == page.description
    assert len(calls) == 2


@pytest.mark.django_db
def test_human_edit_during_generation_wins_over_generated_description(
        creator_factory, monkeypatch):
    page = _page(creator_factory())

    def complete_prompt(*args, **kwargs):
        # Simulate the author saving while the provider request is in flight.
        author_edit = zPage.objects.get(pk=page.pk)
        author_edit.description = "Written by the author."
        author_edit.save(update_fields=["description"])
        return "Generated description."

    monkeypatch.setattr(
        describe_zpage_listener, "complete_prompt", complete_prompt)

    assert describe_zpage_listener.describe_zpage(page) is False

    page.refresh_from_db()
    assert page.description == "Written by the author."
    assert page.variants.get(origin="source").description == page.description


@pytest.mark.django_db
@pytest.mark.parametrize("kwargs", [
    {"description": "Already written by the author."},
    {"is_published": False, "publish_at": None},
    {"content": "Too short to describe."},
])
def test_pages_that_do_not_qualify_are_left_alone_without_a_call(
        creator_factory, fake_client, kwargs):
    """Idempotent: the backfill re-runs this over pages that may have been
    described since, and must neither overwrite nor pay for them."""
    page = _page(creator_factory(), **kwargs)
    before = page.description

    assert describe_zpage_listener.describe_zpage(page) is False

    page.refresh_from_db()
    assert page.description == before
    assert fake_client.calls == []


@pytest.mark.django_db
def test_an_empty_reply_saves_nothing(creator_factory, monkeypatch):
    monkeypatch.setattr(describe_zpage_listener, "oai_client", _ChatOnly(None))
    page = _page(creator_factory())
    with pytest.raises(providers.EmptyCompletion):
        describe_zpage_listener.describe_zpage(page)
    page.refresh_from_db()
    assert page.description == ""


@pytest.mark.django_db
def test_long_content_is_truncated_before_it_is_sent(
        creator_factory, fake_client, monkeypatch):
    monkeypatch.setattr(
        describe_zpage_listener, "DESCRIPTION_CONTENT_TOKENS", 10)
    page = _page(creator_factory())
    describe_zpage_listener.describe_zpage(page)
    sent = fake_client.calls[0]["messages"][1]["content"]
    assert LONG not in sent
    assert "Zebras have stripes" in sent


@pytest.mark.django_db
def test_a_search_index_failure_does_not_block_the_description(
        creator_factory, fake_client, monkeypatch):
    """The 2026-09-28 failure mode: the search summary raised first, the
    message was acked, and the page never got a description."""
    def retired(_instance):
        raise RuntimeError("404 model_not_found")

    monkeypatch.setattr(
        describe_zpage_listener, "create_search_index_if_not_exists", retired)
    # catch_errors closes "old" connections first; under CONN_MAX_AGE=0 that
    # is the test's own transaction.
    monkeypatch.setattr(
        describe_zpage_listener, "close_old_connections", lambda: None)
    page = _page(creator_factory())
    message = _Message(page)

    describe_zpage_listener.callback(message)

    page.refresh_from_db()
    assert page.description == "A short page about zebra stripes."
    assert message.acked == 1


def test_complete_prompt_sends_a_system_message_only_when_given():
    client = _ChatOnly("ok")
    providers.complete_prompt(client, "p", max_tokens=5, model="m")
    providers.complete_prompt(client, "p", max_tokens=5, model="m",
                              system="be brief")
    assert client.calls[0]["messages"] == [{"role": "user", "content": "p"}]
    assert client.calls[1]["messages"] == [
        {"role": "system", "content": "be brief"},
        {"role": "user", "content": "p"},
    ]
