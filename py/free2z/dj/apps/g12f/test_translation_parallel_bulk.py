"""Parallel and bulk AI translation of one zPage (workstream A).

The single-language money path is covered by ``test_translation_purchase.py``
and ``test_translation_settlement.py``. This file covers what is NEW once a
creator can have several translations in flight on one article, and it is
written around the failures that become reachable only then:

* **A bulk purchase charges for part of a batch, or for a batch it refused.**
  It is all-or-nothing: every refusal (409 listing every failing language, 402
  for the total) moves no 2Z, writes no charge record and does not burn the
  key; a retry replays instead of charging twice, even when two arrive at once.
* **Parallel jobs are sold and then aborted for a reason we could have seen.**
  Ten new languages on an article near its draft ceiling all passed a
  purchase-time count of EXISTING drafts and then aborted one by one at
  delivery -- refunded, our provider spend gone.
* **One edit is billed N times.** A save that aborts N running jobs counted as
  N buyer-caused mutations, so jobs 3..N of a single edit were billed.
* **One account starves everybody else** -- a cap that two concurrent batches
  can both slip under, or a bulk purchase that fills the platform queue.
* **The tray cannot be rebuilt.** Another device, or a reload, sees nothing in
  flight unless the server can list it -- and listing it must not leak another
  creator's jobs.

Real Postgres throughout; no database mocking.
"""
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal

import pytest
from django.db import connections
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.g12f.models import zPage, ZPageTranslation, ZPageVariant
from dj.apps.g12f.serializers.zpage import MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE
from dj.apps.g12f.translation import charges, service, settlement
from dj.apps.g12f.translation.tasks import translate_zpage
from dj.apps.g12f.variants import content_digest
from dj.apps.openai.models import AIModel
from dj.apps.tuzis.models import IdempotencyKey


BODY = """\
# Free2Z is for creators

Creators keep what they earn, and a zPage is the unit of publishing here.

A second paragraph of ordinary prose, long enough to be worth tokenizing and
short enough to read. Nothing in it is a link, a price or a tag.
"""


def _terminal_stream(*parts, reason="stop"):
    """Text-only fake stream with an explicit provider terminal event."""
    class Stream:
        termination_reason = reason

        def __iter__(self):
            yield from parts

    return Stream()


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------
@pytest.fixture
def ai_model(db):
    """The row translation resolves to -- see ``test_translation_purchase``."""
    for entry in service.DEFAULT_MODEL_PREFERENCE:
        provider, _, model = entry.partition(":")
        row = AIModel.objects.filter(
            provider=provider, model=model, is_enabled=True
        ).first()
        if row is not None:
            return row
    raise AssertionError("No enabled model in DEFAULT_MODEL_PREFERENCE")


@pytest.fixture
def transaction_model(settings):
    """A catalogue row for ``transaction=True`` tests, which flush seed data."""
    model = AIModel.objects.create(
        provider="openai", model="bulk-transaction-test",
        display_name="Bulk transaction test", system_message="Test",
        max_tokens=16384, is_enabled=True,
    )
    settings.ZPAGE_TRANSLATION_MODELS = [f"{model.provider}:{model.model}"]
    return model


@pytest.fixture(autouse=True)
def keyed_provider(monkeypatch):
    """Pretend every provider has an API key. No network I/O either way."""
    monkeypatch.setattr(service, "get_client", lambda provider: object())


@pytest.fixture(autouse=True)
def dedicated_lane(settings):
    """Size the queue for 's 4-slot lane (Q = 20, account cap 10).

    that is also the shipped default
    (`test_the_shipped_lane_defaults_are_the_dedicated_lane` pins it); kept
    explicit so these bulk-behaviour tests do not move if the default does.
    """
    settings.ZPAGE_TRANSLATION_LANE_CONCURRENCY = 4


@pytest.fixture(autouse=True)
def roomy_failure_ceilings(settings):
    """Keep the  failure-spend ceilings out of tests not about them."""
    settings.ZPAGE_TRANSLATION_MAX_FAILED_SPEND_PER_USER = 0
    settings.ZPAGE_TRANSLATION_MAX_FAILED_SPEND_PLATFORM = 0


@pytest.fixture
def deferred(monkeypatch):
    jobs = []
    monkeypatch.setattr(
        translate_zpage, "defer", lambda **kwargs: jobs.append(kwargs)
    )
    return jobs


class Provider:
    """``stream_chat`` stand-in; ``mutate`` runs once, at the first call."""

    def __init__(self, mutate=None):
        self.mutate = mutate
        self.calls = 0

    def __call__(self, ai_model, messages, **kwargs):
        if self.mutate is not None and self.calls == 0:
            self.mutate()
        self.calls += 1
        user = messages[1]["content"]
        fragment = user.split(">\n", 1)[1].rsplit("\n</fragment", 1)[0]

        reason = "end_turn" if ai_model.provider == "anthropic" else "stop"
        return _terminal_stream(f"[tr] {fragment}", reason=reason)


def make_page(creator, **overrides):
    values = {
        "creator": creator,
        "free2zaddr": str(uuid.uuid4()),
        "title": "Free2Z is for creators",
        "description": "A short summary of the article.",
        "content": BODY,
        "source_language": "en",
        "is_published": True,
    }
    values.update(overrides)
    return zPage.objects.create(**values)


def client_for(creator):
    client = APIClient()
    client.force_authenticate(creator)
    return client


def jobs_url(page):
    return f"/api/zpage/{page.free2zaddr}/translations/"


def quote_url(page, languages):
    return f"/api/zpage/{page.free2zaddr}/translations/quote/?languages={languages}"


def flush_on_commit():
    from django.db import connection

    pending, connection.run_on_commit = connection.run_on_commit, []
    for entry in pending:
        entry[1]()


def quote(client, page, languages):
    response = client.get(quote_url(page, ",".join(languages)))
    assert response.status_code == 200, response.data
    return response.data


def prices_for(client, page, languages):
    """Each language quoted ALONE, so neither a cap nor a batch-wide ceiling
    hides a price the test wants to send anyway."""
    prices = {}
    for language in languages:
        item = quote(client, page, [language])["items"][0]
        assert item["available"], item
        prices[language] = item["price"]
    return prices


def bulk_buy(client, page, languages, *, key=None, prices=None,
             source_digest=None, policy=None, flush=True):
    """Quote the languages then buy them in one batch."""
    if prices is None or source_digest is None:
        quoted = quote(client, page, languages)
        if prices is None:
            prices = {
                item["language"]: item["price"] for item in quoted["items"]
            }
        if source_digest is None:
            source_digest = quoted["source_digest"]
    body = {
        "items": [
            {"language": language, "expected_price": prices[language]}
            for language in languages
        ],
        "source_digest": source_digest,
    }
    if policy is not None:
        body["settlement_policy"] = policy
    key = key or str(uuid.uuid4())
    response = client.post(
        jobs_url(page), body, format="json", HTTP_IDEMPOTENCY_KEY=key,
    )
    if flush:
        flush_on_commit()
    response.idempotency_key = key
    response.prices = prices
    return response


def balance(creator):
    creator.refresh_from_db(fields=["tuzis"])
    return creator.tuzis


def charge_rows(creator=None):
    rows = IdempotencyKey.objects.filter(scope=charges.SCOPE)
    if creator is not None:
        rows = rows.filter(user=creator)
    return rows


# ---------------------------------------------------------------------------
# The bulk purchase: all or nothing
# ---------------------------------------------------------------------------
@pytest.mark.django_db
def test_a_batch_debits_its_total_once_and_enqueues_one_job_per_language(
    creator_factory, ai_model, deferred
):
    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(creator)
    client = client_for(creator)
    before = balance(creator)

    response = bulk_buy(client, page, ["fr", "es", "ja"])

    assert response.status_code == 202, response.data
    total = sum(response.prices.values())
    assert response.data["total"] == total
    assert balance(creator) == before - total
    jobs = response.data["jobs"]
    assert [job["language"] for job in jobs] == ["fr", "es", "ja"]
    assert sorted(job["job_id"] for job in jobs) == sorted(
        job["job_id"] for job in deferred
    )
    # N ordinary charge records, each its own money, keyed {batch}:{lang} --
    # what the worker, the reaper and the status route already understand.
    for job in jobs:
        record = charges.record_for_job(job["job_id"])
        assert record.key == f"{response.idempotency_key}:{job['language']}"
        assert record.response_body["status"] == charges.QUEUED
        assert record.response_body["batch_id"] == response.idempotency_key
        assert record.response_body["price"] == response.prices[job["language"]]


@pytest.mark.django_db
def test_a_partly_unbuyable_batch_names_every_failure_and_charges_nothing(
    creator_factory, ai_model, deferred
):
    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(creator)
    client = client_for(creator)
    quoted = quote(client, page, ["fr", "es", "de"])
    prices = {item["language"]: item["price"] for item in quoted["items"]}
    # `de` is published after the quote; `es` is sent at a stale price.
    ZPageTranslation.objects.create(
        zpage=page, language="de", title="T", description="D",
        content="Veröffentlicht.", is_published=True,
    )
    prices["es"] += 1
    before = balance(creator)

    response = bulk_buy(
        client, page, ["fr", "es", "de"], prices=prices,
        source_digest=quoted["source_digest"],
    )

    assert response.status_code == 409
    assert response.data["code"] == "items_refused"
    by_language = {item["language"]: item for item in response.data["items"]}
    assert set(by_language) == {"es", "de"}, "only the failing items, all of them"
    assert by_language["es"]["code"] == "price_changed"
    assert by_language["es"]["price"] == prices["es"] - 1
    assert by_language["de"]["code"] == "variant_published"
    assert balance(creator) == before
    assert not charge_rows(creator).exists()
    assert deferred == []
    # The key was not burnt: the same key buys the corrected batch.
    retry = bulk_buy(client, page, ["fr"], key=response.idempotency_key)
    assert retry.status_code == 202


@pytest.mark.django_db
def test_an_unaffordable_total_is_402_even_when_each_item_is_affordable(
    creator_factory, ai_model, deferred
):
    creator = creator_factory(tuzis=Decimal("0"))
    page = make_page(creator)
    client = client_for(creator)
    quoted = quote(client, page, ["fr", "es", "ja"])
    prices = [item["price"] for item in quoted["items"]]
    assert all(price > 0 for price in prices)
    # Enough for any single language, not for all three.
    creator.tuzis = Decimal(max(prices) + 1)
    creator.save(update_fields=["tuzis"])
    before = balance(creator)

    response = bulk_buy(client, page, ["fr", "es", "ja"])

    assert response.status_code == 402
    assert response.data["code"] == "insufficient_funds"
    assert Decimal(response.data["cost"]) == sum(prices)
    assert balance(creator) == before
    assert not charge_rows(creator).exists()
    assert not IdempotencyKey.objects.filter(scope=charges.BATCH_SCOPE).exists()
    assert deferred == []


@pytest.mark.django_db
def test_a_retried_batch_replays_its_jobs_and_never_charges_twice(
    creator_factory, ai_model, deferred
):
    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(creator)
    client = client_for(creator)
    first = bulk_buy(client, page, ["fr", "es"])
    assert first.status_code == 202
    after_first = balance(creator)
    # A job finishes before the client retries: the replay reports it.
    charges.refund(
        charges.record_for_job(first.data["jobs"][0]["job_id"]).pk,
        code="provider_error",
    )

    replay = bulk_buy(
        client, page, ["es", "fr"], key=first.idempotency_key,
        prices=first.prices, source_digest=content_digest(page.content),
    )

    assert replay.status_code == 202
    assert replay.data["replayed"] is True
    assert [job["job_id"] for job in replay.data["jobs"]] == [
        job["job_id"] for job in first.data["jobs"]
    ]
    assert replay.data["jobs"][0]["status"] == charges.REFUNDED
    assert len(deferred) == 2
    assert charge_rows(creator).count() == 2
    assert balance(creator) == after_first + first.prices["fr"]

    # The same key for a DIFFERENT batch is a conflict, not a replay.
    mismatch = bulk_buy(
        client, page, ["fr", "es", "de"], key=first.idempotency_key,
        prices={**first.prices, **prices_for(client, page, ["de"])},
        source_digest=content_digest(page.content),
    )
    assert mismatch.status_code == 409
    assert mismatch.data["code"] == "idempotency_mismatch"
    assert charge_rows(creator).count() == 2


@pytest.mark.django_db
def test_another_creator_cannot_see_quote_or_buy_on_my_article(
    creator_factory, ai_model, deferred
):
    owner = creator_factory(tuzis=Decimal("1000"))
    stranger = creator_factory(tuzis=Decimal("1000"))
    page = make_page(owner)
    bulk_buy(client_for(owner), page, ["fr"])
    stranger_client = client_for(stranger)
    quoted = quote(client_for(owner), page, ["es"])

    assert stranger_client.get(jobs_url(page)).status_code == 404
    assert stranger_client.get(quote_url(page, "es")).status_code == 404
    response = bulk_buy(
        stranger_client, page, ["es"],
        prices={"es": quoted["items"][0]["price"]},
        source_digest=quoted["source_digest"],
    )
    assert response.status_code == 404
    assert balance(stranger) == Decimal("1000")
    assert not charge_rows(stranger).exists()
    # And the owner's own tray holds only the owner's job.
    jobs = client_for(owner).get(jobs_url(page)).data["jobs"]
    assert [job["language"] for job in jobs] == ["fr"]


# ---------------------------------------------------------------------------
# The quote
# ---------------------------------------------------------------------------
@pytest.mark.django_db
def test_the_bulk_quote_prices_each_language_as_the_purchase_will(
    creator_factory, ai_model, deferred
):
    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(creator)
    client = client_for(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="de", title="T", description="D",
        content="Veröffentlicht.", is_published=True,
    )
    bulk_buy(client, page, ["ja"])
    rows_before = IdempotencyKey.objects.count()

    data = quote(client, page, ["fr", "pt", "de", "en", "ja", "xx-nope"])

    items = {item["language"]: item for item in data["items"]}
    # Each available price is the single-language quote's price, exactly.
    for language in ("fr", "pt-BR"):
        single = client.get(
            f"/api/zpage/{page.free2zaddr}/variants/{language}/translate/quote/"
        ).data
        assert items[language]["available"] is True
        assert items[language]["price"] == single["price"]
    assert data["total"] == items["fr"]["price"] + items["pt-BR"]["price"]
    assert items["de"]["reason"] == "variant_published"
    assert items["en"]["reason"] == "same_language"
    assert items["ja"]["reason"] == "translation_in_progress"
    assert all(
        items[language]["price"] is None for language in ("de", "en", "ja")
    )
    assert data["in_flight"] == 1
    assert data["capacity"] == charges.account_in_flight_cap() - 1
    assert IdempotencyKey.objects.count() == rows_before, "a quote writes nothing"


# ---------------------------------------------------------------------------
# The draft ceiling counts the drafts running jobs will create
# ---------------------------------------------------------------------------
def _fill_drafts(page, *, free_slots, avoid):
    """Seed drafts until only ``free_slots`` remain, never in ``avoid``."""
    from dj.apps.g12f.test_zpage_variant_api import (
        _seed_draft_translation_mirrors,
        published_variant_cap_languages,
    )

    reserved = set(avoid) | {page.source_language}
    tags = [
        tag for tag in published_variant_cap_languages() if tag not in reserved
    ]
    count = MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE - free_slots
    assert len(tags) >= count
    _seed_draft_translation_mirrors(page, tags[:count])


@pytest.mark.django_db
def test_parallel_new_languages_cannot_be_sold_past_the_draft_ceiling(
    creator_factory, ai_model, deferred
):
    """Two free draft slots; three new languages in flight would need three.

    Before  the purchase counted only drafts that EXIST, so all three
    were sold and the third aborted at delivery with `draft_variant_limit` --
    a refund, after we had paid the provider for the whole document.
    """
    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(creator)
    client = client_for(creator)
    _fill_drafts(page, free_slots=2, avoid=["fr", "es", "ja"])
    # Quoted alone, `ja` fits: the ceiling is only full once jobs are queued.
    ja_quote = quote(client, page, ["ja"])
    assert ja_quote["items"][0]["available"] is True
    ja_price = ja_quote["items"][0]["price"]
    before = balance(creator)

    # Two separate purchases first: the reservation must see jobs that are
    # already QUEUED, not only items in the same request.
    assert bulk_buy(client, page, ["fr"]).status_code == 202
    assert bulk_buy(client, page, ["es"]).status_code == 202
    spent = before - balance(creator)
    assert quote(client, page, ["ja"])["items"][0]["reason"] == (
        "draft_variant_limit"
    )

    batch = bulk_buy(
        client, page, ["ja"], prices={"ja": ja_price},
        source_digest=content_digest(page.content),
    )
    assert batch.status_code == 409
    assert batch.data["items"] == [{
        "language": "ja",
        "code": "draft_variant_limit",
        "error": batch.data["items"][0]["error"],
    }]
    single = client.post(
        f"/api/zpage/{page.free2zaddr}/variants/ja/translate/",
        {
            "expected_price": ja_price,
            "source_digest": content_digest(page.content),
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert single.status_code == 409
    assert single.data["code"] == "draft_variant_limit"
    assert balance(creator) == before - spent
    assert len(deferred) == 2


@pytest.mark.django_db
def test_one_publish_slot_left_sells_one_new_language_not_two(
    creator_factory, ai_model, deferred
):
    """The published ceiling reserves slots across a batch and queued jobs.

    One publish slot left, a batch of two new languages: one of them could
    never be published, and it must not be sold. And once
    one job is queued into the last slot, a later purchase of another new
    language is refused too.
    """
    from dj.apps.g12f.serializers.zpage import (
        MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE,
    )
    from dj.apps.g12f.test_zpage_variant_api import (
        _seed_published_translation_mirrors,
        published_variant_cap_languages,
    )

    creator = creator_factory(tuzis=Decimal("5000"))
    page = make_page(creator)
    client = client_for(creator)
    avoid = {"fr", "es", page.source_language}
    tags = [t for t in published_variant_cap_languages() if t not in avoid]
    _seed_published_translation_mirrors(
        page, tags[: MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE - 1]
    )
    prices = prices_for(client, page, ["fr", "es"])
    before = balance(creator)

    both = bulk_buy(
        client, page, ["fr", "es"], prices=prices,
        source_digest=content_digest(page.content),
    )
    assert both.status_code == 409, both.data
    assert both.data["items"] == [{
        "language": "es",
        "code": "published_variant_limit",
        "error": both.data["items"][0]["error"],
    }]
    assert balance(creator) == before
    assert quote(client, page, ["fr", "es"])["items"][1]["reason"] == (
        "published_variant_limit"
    )

    assert bulk_buy(
        client, page, ["fr"], prices=prices,
        source_digest=content_digest(page.content),
    ).status_code == 202
    later = client.post(
        f"/api/zpage/{page.free2zaddr}/variants/es/translate/",
        {"expected_price": prices["es"],
         "source_digest": content_digest(page.content)},
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert later.status_code == 409
    assert later.data["code"] == "published_variant_limit"
    assert "95 published translations" in later.data["error"].lower()
    assert "1 queued" in later.data["error"].lower()
    assert len(deferred) == 1


@pytest.mark.django_db
def test_retranslating_existing_draft_does_not_consume_another_publish_slot(
    creator_factory, ai_model, deferred
):
    """A draft's language is cardinality-neutral when it is translated again.

    With one publish slot left, the new `fr` draft reserves it. Replacing the
    existing `es` draft adds no new language and must not be refused after `fr`
    has reserved that slot.
    """
    from dj.apps.g12f.test_zpage_variant_api import (
        _seed_draft_translation_mirrors,
        _seed_published_translation_mirrors,
        published_variant_cap_languages,
    )
    from dj.apps.g12f.serializers.zpage import (
        MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE,
    )

    creator = creator_factory(tuzis=Decimal("5000"))
    page = make_page(creator)
    client = client_for(creator)
    avoid = {"fr", "es", page.source_language}
    tags = [t for t in published_variant_cap_languages() if t not in avoid]
    _seed_published_translation_mirrors(
        page, tags[: MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE - 1]
    )
    _seed_draft_translation_mirrors(page, ["es"])
    prices = prices_for(client, page, ["fr", "es"])

    response = bulk_buy(
        client, page, ["fr", "es"], prices=prices,
        source_digest=content_digest(page.content),
    )

    assert response.status_code == 202, response.data
    assert [job["language"] for job in response.data["jobs"]] == ["fr", "es"]
    assert len(deferred) == 2


@pytest.mark.django_db
def test_queued_retranslation_of_existing_draft_does_not_reserve_publish_slot(
    creator_factory, ai_model, deferred
):
    """A queued replacement of an existing draft adds no new language."""
    from dj.apps.g12f.test_zpage_variant_api import (
        _seed_draft_translation_mirrors,
        _seed_published_translation_mirrors,
        published_variant_cap_languages,
    )
    from dj.apps.g12f.serializers.zpage import (
        MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE,
    )

    creator = creator_factory(tuzis=Decimal("5000"))
    page = make_page(creator)
    client = client_for(creator)
    avoid = {"fr", "es", "ja", page.source_language}
    tags = [t for t in published_variant_cap_languages() if t not in avoid]
    _seed_published_translation_mirrors(
        page, tags[: MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE - 2]
    )
    _seed_draft_translation_mirrors(page, ["es"])

    assert bulk_buy(client, page, ["es"]).status_code == 202
    first_new = bulk_buy(client, page, ["fr"])
    second_new = bulk_buy(client, page, ["ja"])

    assert first_new.status_code == 202, first_new.data
    assert second_new.status_code == 202, second_new.data
    assert len(deferred) == 3


@pytest.mark.django_db
def test_batch_over_language_universe_returns_too_many_languages(
    creator_factory, ai_model
):
    """The serializer's fixed input bound retains the bulk error contract."""
    from f2z import languages

    creator = creator_factory(tuzis=Decimal("5000"))
    page = make_page(creator)
    client = client_for(creator)
    tags = list(languages.TRANSLATABLE)
    assert len(tags) > charges.max_batch_items()
    items = [
        {"language": tag, "expected_price": 0}
        for tag in tags + [tags[0]]
    ]

    response = client.post(
        f"/api/zpage/{page.free2zaddr}/translations/",
        {"items": items, "source_digest": content_digest(page.content)},
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )

    assert response.status_code == 400
    assert response.data["code"] == "too_many_languages"
    assert response.data["max_items"] == charges.max_batch_items()


# ---------------------------------------------------------------------------
# One account cannot starve the rest
# ---------------------------------------------------------------------------
@pytest.mark.django_db
def test_a_full_size_batch_fits_an_idle_platform_on_the_dedicated_lane(
    creator_factory, ai_model, deferred
):
    """At 's lane the numbers allow the advertised bulk size end to end."""
    creator = creator_factory(tuzis=Decimal("100000"))
    page = make_page(creator)
    cap = charges.account_in_flight_cap()
    assert cap == charges.max_in_flight() == 10
    assert charges.max_queued() >= 2 * cap, "one account <= half the queue"
    languages = ["fr", "es", "de", "it", "ja", "ko", "pt-BR", "nl", "pl", "sv"]
    assert len(languages) == cap

    response = bulk_buy(client_for(creator), page, languages)

    assert response.status_code == 202, response.data
    assert len(deferred) == cap
    #...and the platform still has room for somebody else.
    other = creator_factory(tuzis=Decimal("1000"))
    assert bulk_buy(
        client_for(other), make_page(other), ["fr"]
    ).status_code == 202


def test_the_shipped_lane_defaults_are_the_dedicated_lane(settings):
    """ ships the four-slot `translation-worker`, and the defaults say so.

    Merge order must not matter: sizing the queue for a lane
    that is not deployed admits hours of backlog onto it. The default moved
    from 1 (the catch-all's shared slot) to 4 in the same change that created
    the lane; py/dj/apps/jobs/test_queue_isolation.py holds this default equal
    to the manifest's --concurrency.
    """
    from django.conf import settings as live
    from dj.free2z import settings as module

    assert module.ZPAGE_TRANSLATION_LANE_CONCURRENCY == 4
    assert charges.DEFAULT_LANE_CONCURRENCY == 4
    settings.ZPAGE_TRANSLATION_LANE_CONCURRENCY = (
        module.ZPAGE_TRANSLATION_LANE_CONCURRENCY
    )
    assert live.ZPAGE_TRANSLATION_LANE_CONCURRENCY == 4
    assert charges.max_queued() == 20
    assert charges.account_in_flight_cap() == 10
    assert charges.max_batch_items() == 10
    assert charges.translation_overdue_threshold_seconds() == 4500


def test_the_platform_queue_follows_the_lane_it_feeds(settings):
    """Q is sized so the last admitted job STARTS inside the reaper deadline.

    ceil(Q / C) documents of the 15-minute budget, plus one of margin, must fit
    in `abandoned_after()`. A hand-copied 20 would stay 20 when the lane is
    scaled down to one slot, and admit five hours of work against a 90-minute
    deadline.
    """
    import math

    for lane in (1, 4, 8):
        settings.ZPAGE_TRANSLATION_LANE_CONCURRENCY = lane
        queued = charges.max_queued()
        documents = math.ceil(queued / lane) + charges.ABANDONMENT_MARGIN_DOCUMENTS
        assert documents * service.DOCUMENT_TIMEOUT_SECONDS <= (
            charges.abandoned_after().total_seconds()
        ), (lane, queued)
        assert charges.account_in_flight_cap() <= queued // 2
    settings.ZPAGE_TRANSLATION_LANE_CONCURRENCY = 4
    assert charges.max_queued() == 20
    settings.ZPAGE_TRANSLATION_MAX_QUEUED = 7
    assert charges.max_queued() == 7, "an explicit ceiling still wins"


@pytest.mark.django_db
def test_no_account_may_hold_more_than_half_the_platform_queue(
    creator_factory, ai_model, deferred, settings
):
    settings.ZPAGE_TRANSLATION_MAX_IN_FLIGHT = 10
    settings.ZPAGE_TRANSLATION_MAX_QUEUED = 4
    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(creator)
    client = client_for(creator)

    prices = prices_for(client, page, ["fr", "es", "ja"])
    refused = bulk_buy(
        client, page, ["fr", "es", "ja"], prices=prices,
        source_digest=content_digest(page.content),
    )
    assert refused.status_code == 400
    assert refused.data["code"] == "too_many_languages"
    assert refused.data["max_items"] == 2

    assert bulk_buy(client, page, ["fr", "es"]).status_code == 202
    over = bulk_buy(client, page, ["ja"])
    assert over.status_code == 409
    assert over.data["code"] == "translation_in_progress"
    assert over.data["in_flight"] == 2
    assert over.data["max_in_flight"] == 2
    # Half the queue is still there for another creator.
    other = creator_factory(tuzis=Decimal("1000"))
    assert bulk_buy(
        client_for(other), make_page(other), ["fr", "es"]
    ).status_code == 202


@pytest.mark.django_db(transaction=True)
def test_two_concurrent_batches_cannot_both_slip_under_the_account_cap(
    creator_factory, transaction_model, deferred, settings
):
    """Each batch alone fits; together they exceed the cap. Exactly one wins.

    The in-flight count is only a bound if two purchases cannot both read it
    before either writes. Two DIFFERENT articles, so the article row lock does
    not serialize them by accident: what must is the buyer's balance row, which
    every purchase takes first.
    """
    settings.ZPAGE_TRANSLATION_MAX_IN_FLIGHT = 3
    creator = creator_factory(tuzis=Decimal("1000"))
    pages = [make_page(creator), make_page(creator)]
    prices = [
        prices_for(client_for(creator), page, ["fr", "es"]) for page in pages
    ]
    barrier = threading.Barrier(2)

    def buy(index):
        try:
            barrier.wait(timeout=10)
            return bulk_buy(
                client_for(creator), pages[index], ["fr", "es"],
                prices=prices[index],
                source_digest=content_digest(pages[index].content),
                flush=False,
            )
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(buy, range(2)))

    codes = sorted(response.status_code for response in results)
    assert codes == [202, 409], [r.data for r in results]
    refused = next(r for r in results if r.status_code == 409)
    assert refused.data["code"] == "translation_in_progress"
    assert charges.in_flight_count(creator) == 2
    assert charge_rows(creator).count() == 2


@pytest.mark.django_db(transaction=True)
def test_two_concurrent_retries_of_one_batch_charge_once(
    creator_factory, transaction_model, deferred
):
    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(creator)
    quoted = quote(client_for(creator), page, ["fr", "es"])
    prices = {item["language"]: item["price"] for item in quoted["items"]}
    key = str(uuid.uuid4())
    before = balance(creator)
    barrier = threading.Barrier(2)

    def buy(_):
        try:
            barrier.wait(timeout=10)
            return bulk_buy(
                client_for(creator), page, ["fr", "es"], key=key,
                prices=prices, source_digest=quoted["source_digest"],
                flush=False,
            )
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(buy, range(2)))

    assert balance(creator) == before - sum(prices.values())
    assert charge_rows(creator).count() == 2
    assert len(deferred) == 2
    winner = next(r for r in results if r.data.get("replayed") is False)
    other = next(r for r in results if r is not winner)
    # The loser either replays the same jobs or is told to ask again; it is
    # never a second charge and never a refusal of a batch that succeeded.
    if other.status_code == 202:
        assert other.data["replayed"] is True
        assert [job["job_id"] for job in other.data["jobs"]] == [
            job["job_id"] for job in winner.data["jobs"]
        ]
    else:
        assert other.status_code == 409
        assert other.data["code"] == "request_in_progress"


# ---------------------------------------------------------------------------
# One edit is one mutation, however many jobs it aborts
# ---------------------------------------------------------------------------
LANGS = ["fr", "es", "de"]


def _source_changed_outcomes(job_ids):
    outcomes = []
    for job_id in job_ids:
        body = charges.record_for_job(job_id).response_body
        assert body["error"] == "source_changed"
        assert body["provider_billed"] is True, "the meter must be full"
        assert body["requester_caused"] is True
        outcomes.append(body)
    return outcomes


@pytest.mark.django_db
@pytest.mark.parametrize("allowance", [1, 2])
def test_one_edit_that_aborts_parallel_jobs_is_forgiven_as_one_mutation(
    creator_factory, ai_model, deferred, monkeypatch, settings, allowance
):
    """Three jobs RUNNING at once, one save of the article, three aborts.

    Each job ran its provider work (so each COULD be billed under the
    terms the buyer accepted) and each was aborted by the same edit. That is
    ONE mutation: inside an allowance of one or two, every job is refunded in
    full. Counted per job, an allowance of two billed the third job, and an
    allowance of one billed the second and third.

    Real overlap, not a simulation of it: each job's first provider call starts
    the NEXT job, and the innermost one makes the single edit -- so all three
    started (and stamped `started_at`) before the save and all three finish
    after it, exactly as on a multi-slot lane.
    """
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = allowance
    creator = creator_factory(tuzis=Decimal("5000"))
    page = make_page(creator)
    before = balance(creator)
    # Latin-script targets: the fake provider answers in English, which the
    # script check would refuse for `ja` before the edit is ever observed.
    response = bulk_buy(
        client_for(creator), page, LANGS,
        policy=settlement.METERED_POLICY_VERSION,
    )
    assert response.status_code == 202
    job_ids = [job["job_id"] for job in response.data["jobs"]]
    state = {"next": 1}

    def stream_chat(ai_model, messages, **kwargs):
        position = state["next"]
        if position < len(job_ids):
            state["next"] += 1
            translate_zpage(job_id=job_ids[position])
        elif position == len(job_ids):
            state["next"] += 1
            response = client_for(creator).patch(
                f"/api/zpage/{page.free2zaddr}/",
                {"content": BODY + "\n\nOne edit while the jobs ran.\n"},
                format="json",
            )
            assert response.status_code == 200, response.data
        fragment = messages[1]["content"].split(">\n", 1)[1].rsplit(
            "\n</fragment", 1
        )[0]
        reason = "end_turn" if ai_model.provider == "anthropic" else "stop"
        return _terminal_stream(f"[tr] {fragment}", reason=reason)

    monkeypatch.setattr(service, "stream_chat", stream_chat)
    translate_zpage(job_id=job_ids[0])

    outcomes = _source_changed_outcomes(job_ids)
    assert [body["status"] for body in outcomes] == [charges.REFUNDED] * 3, (
        [(b["status"], b.get("billed")) for b in outcomes]
    )
    assert balance(creator) == before
    assert charges.requester_action_failures(creator, zpage_id=page.pk) == 1


@pytest.mark.django_db(transaction=True)
def test_an_edit_between_a_jobs_source_read_and_its_start_is_still_one_edit(
    creator_factory, transaction_model, deferred, monkeypatch, settings
):
    """The window starts when the job READ the source, not when it stamped.

    Two workers: B has read the article and passed its digest check but not
    yet started work. The creator edits ONCE. A, already generating, fails on
    that edit and settles. Only then does B start, translate its stale
    snapshot and fail on the same edit. One edit, so with an allowance of one
    both are refunded. Stamping `started_at` when B gets round to it put B's
    window after A's settlement: two mutations, and B billed (codex
    adversarial review of, round 4).
    """
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 1
    creator = creator_factory(tuzis=Decimal("5000"))
    page = make_page(creator)
    response = bulk_buy(
        client_for(creator), page, ["fr", "es"],
        prices=prices_for(client_for(creator), page, ["fr", "es"]),
        source_digest=content_digest(page.content),
        policy=settlement.METERED_POLICY_VERSION, flush=False,
    )
    assert response.status_code == 202, response.data
    job_a, job_b = (job["job_id"] for job in response.data["jobs"])
    b_has_read = threading.Event()
    a_has_settled = threading.Event()
    carried = charges.carried_fragments

    def pause_b_after_its_read(user, zpage_id, language, *args, **kwargs):
        # Runs between the worker's source check and `mark_started`. Takes
        # **kwargs because the worker passes `own_record_pk=`.
        if language == "es":
            b_has_read.set()
            assert a_has_settled.wait(timeout=30)
        return carried(user, zpage_id, language, *args, **kwargs)

    def stream_chat(ai_model, messages, **kwargs):
        fragment = messages[1]["content"].split(">\n", 1)[1].rsplit(
            "\n</fragment", 1
        )[0]
        reason = "end_turn" if ai_model.provider == "anthropic" else "stop"
        return _terminal_stream(f"[tr] {fragment}", reason=reason)

    monkeypatch.setattr(charges, "carried_fragments", pause_b_after_its_read)
    monkeypatch.setattr(service, "stream_chat", stream_chat)

    def run_b():
        try:
            translate_zpage(job_id=job_b)
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=1) as pool:
        b_done = pool.submit(run_b)
        assert b_has_read.wait(timeout=30)

        def edit_during_a(ai_model, messages, **kwargs):
            response = client_for(creator).patch(
                f"/api/zpage/{page.free2zaddr}/",
                {"content": BODY + "\n\nThe one edit.\n"},
                format="json",
            )
            assert response.status_code == 200, response.data
            monkeypatch.setattr(service, "stream_chat", stream_chat)
            return stream_chat(ai_model, messages, **kwargs)

        monkeypatch.setattr(service, "stream_chat", edit_during_a)
        translate_zpage(job_id=job_a)
        a_has_settled.set()
        b_done.result(timeout=60)

    outcomes = _source_changed_outcomes([job_a, job_b])
    assert [body["status"] for body in outcomes] == [charges.REFUNDED] * 2, (
        [(b["status"], b.get("billed")) for b in outcomes]
    )


@pytest.mark.django_db
def test_jobs_bought_together_but_each_killed_by_its_own_edit_count_separately(
    creator_factory, ai_model, deferred, monkeypatch, settings
):
    """Buying ahead must not turn N separate edits into one.

    Three jobs bought in one batch, then run one after another, each killed by
    its OWN edit after the article was reverted to the bought text. Three
    edits, so with an allowance of one the second and third are billed --
    exactly what buying the three one at a time gives. Counting from PURCHASE
    time, all three shared the purchase instant and were forgiven as one.
    """
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 1
    creator = creator_factory(tuzis=Decimal("5000"))
    page = make_page(creator)
    response = bulk_buy(
        client_for(creator), page, LANGS,
        policy=settlement.METERED_POLICY_VERSION,
    )
    assert response.status_code == 202
    job_ids = [job["job_id"] for job in response.data["jobs"]]

    for number, job_id in enumerate(job_ids):
        zPage.objects.filter(pk=page.pk).update(content=BODY)

        def edit(number=number):
            response = client_for(creator).patch(
                f"/api/zpage/{page.free2zaddr}/",
                {"content": BODY + f"\n\nSeparate edit number {number}.\n"},
                format="json",
            )
            assert response.status_code == 200, response.data

        monkeypatch.setattr(service, "stream_chat", Provider(mutate=edit))
        translate_zpage(job_id=job_id)

    outcomes = _source_changed_outcomes(job_ids)
    assert [body["status"] for body in outcomes] == [
        charges.REFUNDED, charges.SETTLED, charges.SETTLED,
    ], [(b["status"], b.get("billed")) for b in outcomes]
    assert charges.requester_action_failures(creator, zpage_id=page.pk) == 3


# ---------------------------------------------------------------------------
# The job tray
# ---------------------------------------------------------------------------
@pytest.mark.django_db
def test_the_tray_lists_the_newest_job_per_language_from_the_server(
    creator_factory, ai_model, deferred, monkeypatch
):
    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(creator)
    client = client_for(creator)
    first = bulk_buy(client, page, ["fr", "es"])
    # `es` delivers; `fr` fails, is refunded with paid-for fragments that must
    # never leave the server, and is then bought again in a later batch.
    monkeypatch.setattr(service, "stream_chat", Provider())
    es_job = first.data["jobs"][1]["job_id"]
    assert translate_zpage(job_id=es_job) is True
    fr_record = charges.record_for_job(first.data["jobs"][0]["job_id"])
    charges.refund(fr_record.pk, code="provider_error", detail="boom")
    body = charges.record_for_job(fr_record.response_body["job_id"]).response_body
    IdempotencyKey.objects.filter(pk=fr_record.pk).update(response_body={
        **body,
        "_fragments": {"secret": "paid-for text"},
        "warnings": [{"code": "glossary"}],
    })
    second = bulk_buy(client, page, ["fr"])
    assert second.status_code == 202
    # Make the source newer than the delivered `es` translation.
    zPage.objects.filter(pk=page.pk).update(content=BODY + "\n\nRevised.\n")

    data = client_for(creator).get(jobs_url(page)).data

    jobs = {job["language"]: job for job in data["jobs"]}
    assert [job["language"] for job in data["jobs"]] == ["fr", "es"]
    assert jobs["fr"]["job_id"] == second.data["jobs"][0]["job_id"]
    assert jobs["fr"]["status"] == charges.QUEUED
    assert jobs["fr"]["batch_id"] == second.idempotency_key
    assert jobs["es"]["status"] == charges.DELIVERED
    assert jobs["es"]["is_published"] is False
    assert jobs["es"]["is_stale"] is True
    assert jobs["es"]["draft"]["job_id"] == es_job
    assert jobs["es"]["draft"]["warnings"] == []
    assert jobs["es"]["draft"]["revision"].startswith('"')
    assert jobs["fr"]["is_published"] is None
    assert jobs["fr"]["draft"] is None
    assert data["source_digest"] == content_digest(BODY + "\n\nRevised.\n")
    assert data["in_flight"] == 1
    assert "paid-for text" not in str(data)
    # The superseded `fr` record's pass-through keys belong to IT, not to the
    # newest job -- and a key the record does not carry is simply absent.
    assert "warnings" not in jobs["fr"]


@pytest.mark.django_db
def test_the_tray_passes_warnings_but_not_preview_text(
    creator_factory, ai_model, deferred
):
    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(creator)
    response = bulk_buy(client_for(creator), page, ["fr", "es"])
    record = charges.record_for_job(response.data["jobs"][0]["job_id"])
    IdempotencyKey.objects.filter(pk=record.pk).update(response_body={
        **record.response_body,
        "warnings": [{"code": "amount_not_in_source", "detail": "$5"}],
        "attempted_output_preview": "Bonjour, a long preview of the output",
    })

    jobs = {
        job["language"]: job
        for job in client_for(creator).get(jobs_url(page)).data["jobs"]
    }

    assert jobs["fr"]["warnings"] == [
        {"code": "amount_not_in_source", "detail": "$5"}
    ]
    assert jobs["fr"]["has_attempted_output_preview"] is True
    assert jobs["es"]["has_attempted_output_preview"] is False
    assert "Bonjour" not in str(jobs)


@pytest.mark.django_db
def test_a_bulk_job_is_best_effort_and_the_tray_types_its_warnings(
    creator_factory, ai_model, deferred, monkeypatch
):
    """ on the bulk path: a job bought in a batch runs the same
    worker, so it is delivered with warnings or refunded exactly as a
    single-language purchase is -- and the tray serves the delivered job's
    warnings in the same typed shape as `TranslationJob.warnings`.

    One language is delivered with a ``code_identifier_not_preserved``
    warning (the model translated a backticked function name); the other's reply is cut off inside
    the echoed envelope and is refunded as ``output_truncated``.

    NEGATIVE CONTROL: make ``service._envelope_unclosed`` return ``False`` and
    the ``fr`` job is delivered and charged; remove
    ``code_identifier_not_preserved`` from
    ``settlement.DELIVER_WITH_WARNING_CODES`` and the ``es`` job is refunded.
    """
    from dj.apps.g12f.serializers.translate_batch import (
        TranslationJobListItemSerializer,
    )

    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(
        creator,
        content=(
            "Formatting basics.\n\n"
            "- Call `get_balance()` to read it.\n"
        ),
    )
    client = client_for(creator)
    before = balance(creator)
    response = bulk_buy(client, page, ["es", "fr"])
    assert response.status_code == 202, response.data
    job_ids = {job["language"]: job["job_id"] for job in response.data["jobs"]}

    def reply(cut_off):
        def stub(ai_model, messages, **kwargs):
            user = messages[1]["content"]
            nonce = user.split('<fragment id="', 1)[1].split('"', 1)[0]
            fragment = user.split(">\n", 1)[1].rsplit("\n</fragment", 1)[0]
            if cut_off and "Formatting" in fragment:
                reason = "end_turn" if ai_model.provider == "anthropic" else "stop"
                return _terminal_stream(
                    f'<fragment id="{nonce}">\nFormat', reason=reason
                )
            reason = "end_turn" if ai_model.provider == "anthropic" else "stop"
            return _terminal_stream("[tr] " + fragment.replace(
                "`get_balance()`", "`obtener_saldo()`"
            ), reason=reason)
        return stub

    monkeypatch.setattr(service, "stream_chat", reply(cut_off=False))
    translate_zpage(job_id=job_ids["es"])
    monkeypatch.setattr(service, "stream_chat", reply(cut_off=True))
    translate_zpage(job_id=job_ids["fr"])

    es = charges.record_for_job(job_ids["es"]).response_body
    fr = charges.record_for_job(job_ids["fr"]).response_body
    assert es["status"] == charges.DELIVERED
    assert [w["code"] for w in es["warnings"]] == ["code_identifier_not_preserved"]
    assert fr["error"] == "output_truncated"
    assert fr["status"] != charges.DELIVERED
    assert not ZPageTranslation.objects.filter(zpage=page, language="fr").exists()
    # Charged for the delivered draft, refunded for the truncated one.
    assert before - balance(creator) == response.prices["es"]

    # The current draft remains reviewable even when its delivered job has
    # aged out of the ordinary 30-day tray window.
    delivered_record = charges.record_for_job(job_ids["es"])
    IdempotencyKey.objects.filter(pk=delivered_record.pk).update(
        created_at=timezone.now() - charges.JOBS_LIST_WINDOW - timedelta(days=1)
    )
    retry = bulk_buy(client, page, ["es"])
    assert retry.status_code == 202, retry.data
    retry_record = charges.record_for_job(retry.data["jobs"][0]["job_id"])
    charges.refund(retry_record.pk, code="provider_error", detail="retry failed")

    jobs = {
        job["language"]: job
        for job in client.get(jobs_url(page)).data["jobs"]
    }
    assert jobs["es"]["status"] == charges.REFUNDED
    assert jobs["es"]["draft"]["job_id"] == job_ids["es"]
    assert jobs["es"]["draft"]["warnings"] == es["warnings"]
    assert jobs["es"]["draft"]["revision"]
    assert jobs["es"]["job_id"] == retry.data["jobs"][0]["job_id"]
    assert jobs["fr"]["status"] != charges.DELIVERED
    TranslationJobListItemSerializer(data=jobs["es"]).is_valid(
        raise_exception=True
    )


@pytest.mark.django_db
def test_draft_revision_rejects_a_replacement_after_manual_review(
    creator_factory, ai_model, deferred, monkeypatch
):
    """A tray approval is conditional on the exact saved draft revision.

    The old ETag must fail after a replacement lands, while a creator who
    reviewed that replacement may publish it with the revision from the same
    jobs listing. This exercises the real variant write precondition used by
    the tray's PATCH.
    """
    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(creator)
    response = bulk_buy(client_for(creator), page, ["es"])
    job_id = response.data["jobs"][0]["job_id"]
    monkeypatch.setattr(service, "stream_chat", Provider())
    assert translate_zpage(job_id=job_id) is True

    client = client_for(creator)
    path = f"/api/zpage/{page.free2zaddr}/translations/"
    first = client.get(path).data["jobs"][0]["draft"]
    assert first["job_id"] == job_id

    # Another tab saves a replacement after the jobs list returned. The exact
    # old review revision no longer authorizes publish.
    row = ZPageTranslation.objects.get(zpage=page, language="es")
    replacement_save = client.patch(
        f"/api/zpage/{page.free2zaddr}/variants/es/",
        {"content": row.content + "\n\nA replacement saved elsewhere."},
        format="json",
        HTTP_IF_MATCH=first["revision"],
    )
    assert replacement_save.status_code == 200, replacement_save.data
    stale = client.patch(
        f"/api/zpage/{page.free2zaddr}/variants/es/?mine=true",
        {"is_published": True},
        format="json",
        HTTP_IF_MATCH=first["revision"],
    )
    assert stale.status_code == 412

    replacement = client.get(path).data["jobs"][0]["draft"]
    assert replacement["job_id"] is None
    assert replacement["warnings"] == []
    assert replacement["revision"] != first["revision"]
    # The creator's explicit review of the current manual draft is publishable.
    accepted = client.patch(
        f"/api/zpage/{page.free2zaddr}/variants/es/?mine=true",
        {"is_published": True},
        format="json",
        HTTP_IF_MATCH=replacement["revision"],
    )
    assert accepted.status_code == 200, accepted.data
    assert ZPageTranslation.objects.get(zpage=page, language="es").is_published


@pytest.mark.django_db
@pytest.mark.parametrize("variant_reads", [False, True])
def test_editing_a_warned_draft_keeps_prior_delivery_warnings_visible(
    creator_factory, deferred, monkeypatch, variant_reads
):
    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(
        creator,
        content="Formatting basics.\n\n- Call `get_balance()` to read it.\n",
    )
    client = client_for(creator)
    purchase = bulk_buy(client, page, ["es"])
    job_id = purchase.data["jobs"][0]["job_id"]

    def translate_with_warning(ai_model, messages, **kwargs):
        user = messages[1]["content"]
        nonce = user.split('<fragment id="', 1)[1].split('"', 1)[0]
        fragment = user.split(">\n", 1)[1].rsplit("\n</fragment", 1)[0]
        reason = "end_turn" if ai_model.provider == "anthropic" else "stop"
        return _terminal_stream(
            f'<fragment id="{nonce}">\n'
            f'{fragment.replace("`get_balance()`", "`obtener_saldo()`")}\n'
            "</fragment>",
            reason=reason,
        )

    monkeypatch.setattr(service, "stream_chat", translate_with_warning)
    assert translate_zpage(job_id=job_id) is True

    path = jobs_url(page)
    with override_settings(ZPAGE_VARIANT_READS=variant_reads):
        first = client.get(path).data["drafts"]["es"]
        assert first["warnings"][0]["code"] == "code_identifier_not_preserved"
        current = ZPageTranslation.objects.get(zpage=page, language="es")
        saved = client.patch(
            f"/api/zpage/{page.free2zaddr}/variants/es/",
            {"content": current.content + "\nEdited by the creator."},
            format="json",
            HTTP_IF_MATCH=first["revision"],
        )
        assert saved.status_code == 200, saved.data
        edited = client.get(path).data["drafts"]["es"]
        assert edited["job_id"] is None
        assert edited["warnings"] == []
        assert edited["prior_warnings"] == first["warnings"]


@pytest.mark.django_db
def test_batched_draft_revisions_match_single_validators_at_draft_ceiling(
    creator_factory,
):
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    from dj.apps.g12f.preconditions import variant_etag, variant_etags
    from dj.apps.g12f.serializers.zpage import (
        MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE,
    )

    page = make_page(creator_factory())
    languages = [f"lang-{index:03d}" for index in range(
        MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE
    )]
    for language in languages:
        ZPageTranslation.objects.create(
            zpage=page,
            language=language,
            title=f"Title {language}",
            description=f"Description {language}",
            content=f"Content {language}",
        )

    with CaptureQueriesContext(connection) as queries:
        batched = variant_etags(
            page,
            languages,
            translation_model=ZPageTranslation,
            variant_model=ZPageVariant,
        )

    # `ZPageTranslationJobsView` holds the page row lock while constructing
    # this snapshot. The maximum legal 96-language tray costs four queries
    # (fresh page/tags, legacy drafts, mirror drafts), not four per draft.
    with CaptureQueriesContext(connection) as single_queries:
        individual = {
            language: variant_etag(
                page,
                language,
                translation_model=ZPageTranslation,
                variant_model=ZPageVariant,
            )
            for language in languages
        }

    assert len(queries) <= 4
    assert len(single_queries) >= 3 * MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE
    assert batched == individual


@pytest.mark.django_db
@pytest.mark.parametrize("variant_reads", [False, True])
@pytest.mark.parametrize("field", ["title", "description"])
def test_draft_provenance_covers_title_and_description(
    creator_factory, ai_model, deferred, monkeypatch, variant_reads, field
):
    """Every field a publish overwrites is bound to persisted check warnings."""
    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(creator)
    client = client_for(creator)
    purchase = bulk_buy(client, page, ["es"])
    job_id = purchase.data["jobs"][0]["job_id"]
    monkeypatch.setattr(service, "stream_chat", Provider())
    assert translate_zpage(job_id=job_id) is True

    path = f"/api/zpage/{page.free2zaddr}/translations/"
    with override_settings(ZPAGE_VARIANT_READS=variant_reads):
        first = client.get(path).data["drafts"]["es"]
        assert first["job_id"] == job_id
        assert first["revision"]
        current = ZPageTranslation.objects.get(zpage=page, language="es")
        replacement = client.patch(
            f"/api/zpage/{page.free2zaddr}/variants/es/",
            {field: getattr(current, field) + " edited"},
            format="json",
            HTTP_IF_MATCH=first["revision"],
        )
        assert replacement.status_code == 200, replacement.data
        changed = client.get(path).data["drafts"]["es"]
        assert changed["job_id"] is None
        assert changed["warnings"] == []
        assert changed["revision"] != first["revision"]


@pytest.mark.django_db
@pytest.mark.parametrize("variant_reads", [False, True])
def test_jobs_listing_returns_manual_drafts_without_any_job(
    creator_factory, variant_reads
):
    """A current manual draft always has a validator and unknown provenance."""
    creator = creator_factory()
    page = make_page(creator)
    with override_settings(ZPAGE_VARIANT_READS=variant_reads):
        ZPageTranslation.objects.create(
            zpage=page,
            language="es",
            title="Manual title",
            description="Manual description",
            content="Manual translation",
        )
        answer = client_for(creator).get(
            f"/api/zpage/{page.free2zaddr}/translations/"
        )
    assert answer.status_code == 200, answer.data
    assert answer.data["jobs"] == []
    draft = answer.data["drafts"]["es"]
    assert draft["job_id"] is None
    assert draft["warnings"] == []
    assert draft["revision"]


@pytest.mark.django_db
def test_aged_pre_digest_delivery_is_unknown_but_current_draft_is_listed(
    creator_factory, ai_model, deferred, monkeypatch
):
    """Legacy AI text keeps a revision, but cannot claim old warning provenance."""
    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(creator)
    purchase = bulk_buy(client_for(creator), page, ["es"])
    job_id = purchase.data["jobs"][0]["job_id"]
    monkeypatch.setattr(service, "stream_chat", Provider())
    assert translate_zpage(job_id=job_id) is True

    record = charges.record_for_job(job_id)
    body = dict(record.response_body)
    body.pop("draft_digest")
    IdempotencyKey.objects.filter(pk=record.pk).update(
        response_body=body,
        created_at=timezone.now() - charges.JOBS_LIST_WINDOW - timedelta(days=1),
    )
    answer = client_for(creator).get(
        f"/api/zpage/{page.free2zaddr}/translations/"
    )
    assert answer.status_code == 200, answer.data
    assert answer.data["jobs"] == []
    assert answer.data["drafts"]["es"]["job_id"] is None
    assert answer.data["drafts"]["es"]["warnings"] == []
    assert answer.data["drafts"]["es"]["revision"]


@pytest.mark.django_db
@pytest.mark.parametrize("lane", [1, 4])
def test_a_healthy_full_queue_does_not_page_as_backlogged(settings, lane):
    """The `translation` backlog threshold follows the queue model.

    A full platform queue on a lane of C slots holds its oldest runnable job
    for up to ceil(Q / C) - 1 documents; that must not page, and one document
    more must. The metric policy is held to the same number by
    `test_queue_backlog_thresholds_match_the_settings_they_mirror`.
    """
    import math

    from dj.apps.jobs import health

    settings.ZPAGE_TRANSLATION_LANE_CONCURRENCY = lane
    translation = health.QueueHealth(queue="translation")
    assert translation.is_billing is True, "failures still page at one"
    healthy_wait = (
        math.ceil(charges.max_queued() / lane) - 1
    ) * service.DOCUMENT_TIMEOUT_SECONDS
    threshold = translation.overdue_threshold_seconds
    assert healthy_wait < threshold
    assert threshold == healthy_wait + service.DOCUMENT_TIMEOUT_SECONDS
    assert threshold == 4500
    assert health.QueueHealth(queue="billing").overdue_threshold_seconds == 300


@pytest.mark.django_db
def test_a_paid_batch_still_replays_after_the_cap_is_lowered(
    creator_factory, ai_model, deferred, settings
):
    """The batch-size limit follows a setting; a receipt must not.

    A client that lost its 202 retries after a deploy lowered the cap. Checking
    the size before the idempotency claim answered 400 `too_many_languages`
    about a batch that is already paid for. (codex adversarial review of
    , round 2.)
    """
    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(creator)
    client = client_for(creator)
    first = bulk_buy(client, page, ["fr", "es", "de"])
    assert first.status_code == 202
    settings.ZPAGE_TRANSLATION_MAX_IN_FLIGHT = 2

    replay = bulk_buy(
        client, page, ["fr", "es", "de"], key=first.idempotency_key,
        prices=first.prices, source_digest=content_digest(page.content),
    )

    assert replay.status_code == 202, replay.data
    assert replay.data["replayed"] is True
    assert len(replay.data["jobs"]) == 3


@pytest.mark.django_db(transaction=True)
def test_concurrent_buyers_cannot_overfill_the_platform_queue(
    creator_factory, transaction_model, deferred, settings
):
    """Three creators, three batches of two, a platform queue of four.

    Each holds its OWN balance and article row locks, so nothing in those
    serializes them; each would read an empty queue and pass. The platform
    ceiling is a bound only if admission is serialized platform-wide.
    (codex adversarial review of, finding 2.)
    """
    settings.ZPAGE_TRANSLATION_MAX_QUEUED = 4
    settings.ZPAGE_TRANSLATION_MAX_IN_FLIGHT = 2
    buyers = [creator_factory(tuzis=Decimal("1000")) for _ in range(3)]
    pages = [make_page(buyer) for buyer in buyers]
    prices = [
        prices_for(client_for(buyer), page, ["fr", "es"])
        for buyer, page in zip(buyers, pages)
    ]
    barrier = threading.Barrier(3)

    def buy(index):
        try:
            barrier.wait(timeout=10)
            return bulk_buy(
                client_for(buyers[index]), pages[index], ["fr", "es"],
                prices=prices[index],
                source_digest=content_digest(pages[index].content),
                flush=False,
            )
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(buy, range(3)))

    codes = sorted(response.status_code for response in results)
    assert codes == [202, 202, 503], [r.data for r in results]
    assert charges.queued_count() == 4
    assert charge_rows().count() == 4


@pytest.mark.django_db
def test_a_job_still_waiting_in_the_queue_is_not_reaped_as_abandoned(
    creator_factory, ai_model, monkeypatch
):
    """Ten jobs behind one serial slot can wait past 90 minutes. That job is
    not lost, and refunding it throws away the work it is about to do (codex
    adversarial review of, finding 1). A job that never reached the
    queue still is, and the outer deadline still bounds a stuck lane."""
    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(creator)
    client = client_for(creator)
    waiting = bulk_buy(client, page, ["fr"])  # a real procrastinate job
    with monkeypatch.context() as patch:
        patch.setattr(translate_zpage, "defer", lambda **kwargs: None)
        lost = bulk_buy(client, page, ["es"])  # the enqueue never happened
    waiting_job = waiting.data["jobs"][0]["job_id"]
    lost_job = lost.data["jobs"][0]["job_id"]
    assert charges.scheduled_job_ids([waiting_job, lost_job]) == {waiting_job}
    IdempotencyKey.objects.filter(scope=charges.SCOPE).update(
        created_at=timezone.now() - charges.abandoned_after() * 1.5
    )

    assert charges.reap_abandoned() == 1
    assert charges.record_for_job(lost_job).response_body["status"] == (
        charges.REFUNDED
    )
    assert charges.record_for_job(waiting_job).response_body["status"] == (
        charges.QUEUED
    )
    # Still real backlog, so it still holds its slot.
    assert charges.in_flight_count(creator) == 1

    IdempotencyKey.objects.filter(scope=charges.SCOPE).update(
        created_at=timezone.now() - charges.abandoned_hard_after() * 1.1
    )
    assert charges.reap_abandoned() == 1
    assert charges.record_for_job(waiting_job).response_body["status"] == (
        charges.REFUNDED
    )


# ---------------------------------------------------------------------------
# The wall clock  is a per-language refusal
# ---------------------------------------------------------------------------
def _too_long_for_lao(ai_model):
    """Fits the clock in Spanish, not in Lao -- asserted, not assumed."""
    from dj.apps.g12f.translation import evidence

    content = "\n\n".join([evidence.sample_for("en")] * 150) + "\n"
    for tag, expected in (("lo", service.TOO_LONG_DOCUMENT), ("es", None)):
        quoted = service.quote_document(
            title="", description="", content=content,
            source_language="en", target_language=tag, ai_model=ai_model,
            source_digest="d",
        )
        assert service.wall_clock_shortfall(quoted.wall_clock) == expected, tag
    return content


@pytest.mark.django_db
def test_the_bulk_quote_marks_only_the_language_the_clock_cannot_fit(
    creator_factory, ai_model
):
    """Lao being too long says nothing about Spanish.

    NEGATIVE CONTROL: drop ``wall_clock_error`` from the bulk quote and Lao
    comes back available with a price that the purchase would then refuse.
    """
    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(
        creator, title="", description="", content=_too_long_for_lao(ai_model),
    )

    quoted = quote(client_for(creator), page, ["lo", "es"])

    items = {item["language"]: item for item in quoted["items"]}
    assert items["lo"]["available"] is False
    assert items["lo"]["reason"] == "translation_too_long"
    assert items["lo"]["price"] is None
    assert items["es"]["available"] is True
    assert quoted["total"] == items["es"]["price"]


@pytest.mark.django_db
def test_a_bulk_purchase_with_a_language_the_clock_cannot_fit_charges_nothing(
    creator_factory, ai_model, deferred
):
    """All or nothing: the Lao item is named and nothing at all is bought.

    NEGATIVE CONTROL: drop ``wall_clock_error`` from the bulk purchase and the
    batch is bought, Lao included.
    """
    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(
        creator, title="", description="", content=_too_long_for_lao(ai_model),
    )
    client = client_for(creator)
    es_price = quote(client, page, ["es"])["items"][0]["price"]
    lo_price = service.quote_document(
        title="", description="", content=page.content,
        source_language="en", target_language="lo", ai_model=ai_model,
        source_digest="d",
    ).price
    before = balance(creator)

    response = bulk_buy(
        client, page, ["lo", "es"], prices={"lo": lo_price, "es": es_price},
        source_digest=content_digest(page.content),
    )

    assert response.status_code == 409, response.data
    assert response.data["code"] == "items_refused"
    by_language = {item["language"]: item for item in response.data["items"]}
    assert set(by_language) == {"lo"}
    assert by_language["lo"]["code"] == "translation_too_long"
    assert balance(creator) == before
    assert not charge_rows(creator).exists()
    assert deferred == []
