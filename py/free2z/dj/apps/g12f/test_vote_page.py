"""Regression test: vote_page must 400 on a missing/invalid vote, not 500.

``vote_page`` read ``request.data['vote']`` directly, so a POST without a
``vote`` key raised KeyError -> 500. It must be a 400.
"""
import uuid
from decimal import Decimal

import pytest

from dj.apps.g12f.models import zPage


def _page(creator):
    return zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=f"vote-{uuid.uuid4().hex[:8]}",
        title="A page",
        content="Some content.",
        is_published=True,
    )


def _headers():
    return {"HTTP_IDEMPOTENCY_KEY": str(uuid.uuid4())}


@pytest.mark.django_db
def test_missing_vote_value_is_400(api_client, creator_factory):
    voter = creator_factory()  # tuzis=1000
    page = _page(creator_factory())
    api_client.force_authenticate(user=voter)

    response = api_client.post(f"/api/zpage/{page.free2zaddr}/vote/", {}, format="json")

    assert response.status_code == 400, response.content


@pytest.mark.django_db
def test_invalid_vote_value_is_400(api_client, creator_factory):
    voter = creator_factory()
    page = _page(creator_factory())
    api_client.force_authenticate(user=voter)

    response = api_client.post(
        f"/api/zpage/{page.free2zaddr}/vote/", {"vote": "sideways"}, format="json"
    )

    assert response.status_code == 400, response.content


@pytest.mark.django_db
def test_optional_and_malformed_idempotency_key_are_controlled(
    api_client, creator_factory,
):
    voter = creator_factory()
    page = _page(creator_factory())
    api_client.force_authenticate(user=voter)

    missing = api_client.post(
        f"/api/zpage/{page.free2zaddr}/vote/", {"vote": "up"}, format="json"
    )
    malformed = api_client.post(
        f"/api/zpage/{page.free2zaddr}/vote/", {"vote": "up"},
        format="json", HTTP_IDEMPOTENCY_KEY="not-a-uuid",
    )

    assert missing.status_code == 200, missing.content
    assert malformed.status_code == 400
    assert malformed.data["code"] == "idempotency_key_required"


@pytest.mark.django_db(transaction=True)
def test_valid_upvote_succeeds(api_client, creator_factory):
    voter = creator_factory()
    owner = creator_factory()
    page = _page(owner)
    api_client.force_authenticate(user=voter)

    response = api_client.post(
        f"/api/zpage/{page.free2zaddr}/vote/", {"vote": "up"}, format="json",
        **_headers(),
    )

    assert response.status_code == 200, response.content
    owner.refresh_from_db()
    assert owner.total == Decimal("0.001")
    page.refresh_from_db()
    assert response.data["f2z_score"] == str(page.f2z_score)
    assert page.f2z_score > 0


@pytest.mark.django_db(transaction=True)
def test_vote_cache_refresh_is_best_effort_and_nonblocking(
    api_client, creator_factory, monkeypatch
):
    voter = creator_factory()
    owner = creator_factory()
    page = _page(owner)
    callback_options = []

    def busy_cache(_creator, **options):
        callback_options.append(options)
        raise RuntimeError("simulated busy derived cache")

    monkeypatch.setattr(type(owner), "cache_total", busy_cache)
    api_client.force_authenticate(user=voter)

    response = api_client.post(
        f"/api/zpage/{page.free2zaddr}/vote/", {"vote": "up"}, format="json",
        **_headers(),
    )

    assert response.status_code == 200, response.content
    page.refresh_from_db()
    assert page.tuzi_total == 1
    assert callback_options == [{"nowait": True}]


@pytest.mark.django_db(transaction=True)
def test_vote_retry_replays_after_page_deactivation(api_client, creator_factory):
    voter = creator_factory(tuzis=Decimal("10"))
    owner = creator_factory()
    page = _page(owner)
    api_client.force_authenticate(user=voter)
    key = str(uuid.uuid4())

    first = api_client.post(
        f"/api/zpage/{page.free2zaddr}/vote/", {"vote": "up"},
        format="json", HTTP_IDEMPOTENCY_KEY=key,
    )
    owner.is_active = False
    owner.save(update_fields=["is_active"])
    replay = api_client.post(
        f"/api/zpage/{page.free2zaddr}/vote/", {"vote": "up"},
        format="json", HTTP_IDEMPOTENCY_KEY=key,
    )
    fresh = api_client.post(
        f"/api/zpage/{page.free2zaddr}/vote/", {"vote": "up"},
        format="json", **_headers(),
    )

    assert first.status_code == replay.status_code == 200
    assert replay.data["replayed"] is True
    assert fresh.status_code == 404
    voter.refresh_from_db()
    page.refresh_from_db()
    assert voter.tuzis == Decimal("9")
    assert page.tuzi_total == 1
