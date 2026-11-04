"""The membership price the Settings page sends is one the server takes.

The page told creators "Set to 0 for free access." and sent ``"0"``;
``Creator.member_price`` has carried ``MinValueValidator(1)`` since 2023, so
every such save was a 400 -- and the page threw the body away. 32 failed saves
by 6 creators in 30 days.

The client now validates the price itself (``src/lib/utils/member-price.ts``).
"Client validation matches the server" is only a claim until both sides are
run against the same cases, so the table lives in ONE file,
``ts/svelte/free2z/tests/fixtures/member-price-contract.json``:

* ``tests/member-price.test.mjs`` asserts the client accepts/refuses each case;
* this file PATCHes the same cases through the real serializer.

For an accepted case, what the client ``sends`` must be answered 200 and
stored. For a refused case, what would have been sent WITHOUT the client check
must be answered 400 naming ``member_price`` -- so the client never refuses a
value the server would have taken. Change the server rule and this fails;
change the client rule and the node test fails.

 (owner decision 2026-10-06): ``0`` is a FREE membership and is accepted;
the column is NOT NULL with default 10, so an empty price (``null``) is now
refused rather than meaning "no membership offered".
"""

import json
from decimal import Decimal
from pathlib import Path

import pytest
from rest_framework.test import APIClient


URL = "/api/auth/user/"
CONTRACT = (
    Path(__file__).resolve().parents[5]
    / "ts" / "svelte" / "free2z" / "tests" / "fixtures"
    / "member-price-contract.json"
)


def _cases(kind):
    table = json.loads(CONTRACT.read_text(encoding="utf-8"))
    return [
        pytest.param(case, id=repr(case["typed"]))
        for case in table[kind]
    ]


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def test_the_contract_table_is_not_empty():
    """A table that fails to load would make both halves vacuously green."""
    table = json.loads(CONTRACT.read_text(encoding="utf-8"))
    assert len(table["accepted"]) >= 5
    assert len(table["refused"]) >= 5
    #0 is a FREE membership, and the price can no longer be cleared.
    assert any(case["sends"] == "0" for case in table["accepted"])
    assert any(case["sends"] is None for case in table["refused"])
    assert any(case["sends"] == "-1" for case in table["refused"])


@pytest.mark.django_db
@pytest.mark.parametrize("case", _cases("accepted"))
def test_every_price_the_client_sends_is_saved(case, creator_factory):
    creator = creator_factory(username="price-ok-2044")
    creator.member_price = 42
    creator.save(update_fields=["member_price"])

    response = _client(creator).patch(
        URL, {"member_price": case["sends"]}, format="json")

    assert response.status_code == 200, response.content
    creator.refresh_from_db()
    assert creator.member_price == Decimal(case["sends"])
    assert response.json()["member_price"] == case["sends"]


@pytest.mark.django_db
@pytest.mark.parametrize("case", _cases("refused"))
def test_every_price_the_client_refuses_the_server_refuses(
        case, creator_factory):
    creator = creator_factory(username="price-bad-2044")
    creator.member_price = 42
    creator.save(update_fields=["member_price"])

    response = _client(creator).patch(
        URL, {"member_price": case["sends"]}, format="json")

    assert response.status_code == 400, response.content
    body = response.json()
    # A field error, keyed by the field -- the shape the page now reads and
    # renders next to the input.
    assert list(body) == ["member_price"], body
    assert body["member_price"] and isinstance(body["member_price"][0], str)
    creator.refresh_from_db()
    assert creator.member_price == 42


@pytest.mark.django_db
def test_a_new_creator_defaults_to_ten_2z(creator_factory):
    """: new creators offer a 10 2Z / 30 days membership by default.

    Built through the model, not the factory (whose own default is also 10),
    so this pins ``Creator.member_price``'s default and not the fixture's.
    """
    from dj.apps.g12f.models import Creator

    creator = Creator.objects.create(username="default-price-2510")
    creator.refresh_from_db()
    assert creator.member_price == Decimal("10")


@pytest.mark.django_db
def test_the_model_refuses_a_negative_price_and_accepts_zero(creator_factory):
    from django.core.exceptions import ValidationError

    creator = creator_factory(username="neg-price-2510")
    creator.member_price = Decimal("-1")
    with pytest.raises(ValidationError) as excinfo:
        creator.full_clean(validate_unique=False)
    assert "member_price" in excinfo.value.message_dict
    creator.member_price = Decimal("0")
    creator.full_clean(validate_unique=False)
