"""A second zPage below 1 2Z is refused in the ordinary 402 shape.

Alert  (2026-10-07): a creator who had published their first page that
morning tried to start a second one and was refused six times in two minutes,
then left. The refusal was a bare-string 400 telling them to get "a tuzi" --
a word no screen uses any more -- so no client could tell it apart from a
validation error, and the editor could offer nothing but the sentence.

Every other "not enough 2Z" answer on the platform is a 402 with the
``insufficient_funds`` body, which the composers and ZUULI's wallet
already turn into "you need N more" plus a way to get it. This one is now the
same, and these tests pin that, plus the one-free-page rule it implements.
"""
from decimal import Decimal

import pytest
from rest_framework.test import APIClient

from dj.apps.g12f.models import zPage


def _client(user):
    client = APIClient()
    client.force_authenticate(user)
    return client


def _create(client, **overrides):
    body = {
        "title": "A page",
        "content": "Some words.",
        "description": "",
        "tags": [],
    }
    body.update(overrides)
    return client.post("/api/zpage/", body, format="json")


@pytest.mark.django_db
def test_the_first_page_is_free(creator_factory):
    creator = creator_factory(tuzis=Decimal("0"))

    response = _create(_client(creator))

    assert response.status_code == 201
    assert zPage.objects.filter(creator=creator).count() == 1


@pytest.mark.django_db
def test_a_second_page_below_1_2z_is_an_insufficient_funds_402(
    creator_factory,
):
    creator = creator_factory(tuzis=Decimal("0.5"))
    client = _client(creator)
    assert _create(client, title="First").status_code == 201

    refused = _create(client, title="Second")

    assert refused.status_code == 402
    # The exact wire contract of every other refused 2Z action
    # (`ledger.insufficient_funds_payload`): strings, three decimals.
    assert {k: refused.data[k] for k in (
        "code", "cost", "balance", "shortfall", "action",
    )} == {
        "code": "insufficient_funds",
        "cost": "1.000",
        "balance": "0.500",
        "shortfall": "0.500",
        "action": "page_create",
    }
    # A sentence for a client that does not read `code`, in the words the
    # product uses: 2Z, never the retired "tuzi".
    assert "2Z" in refused.data["detail"]
    assert "tuzi" not in refused.data["detail"].lower()
    assert zPage.objects.filter(creator=creator).count() == 1
    # Refused, not charged.
    creator.refresh_from_db()
    assert creator.tuzis == Decimal("0.5")


@pytest.mark.django_db
def test_a_second_page_with_1_2z_is_created_and_not_charged(creator_factory):
    creator = creator_factory(tuzis=Decimal("1"))
    client = _client(creator)
    assert _create(client, title="First").status_code == 201

    second = _create(client, title="Second")

    assert second.status_code == 201
    assert zPage.objects.filter(creator=creator).count() == 2
    creator.refresh_from_db()
    assert creator.tuzis == Decimal("1")
