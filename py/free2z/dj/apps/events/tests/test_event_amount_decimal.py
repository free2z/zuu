"""``Event.amount`` keeps the fraction the ledger moved.

Until migration 0014 the column was an IntegerField and Django prepared
``Decimal("1.5")`` for it as ``1`` -- so a 1.5 2Z donation moved 1.5 2Z of
balance and wrote an audit row saying 1. Negative control for this file:
``git checkout origin/main -- py/dj/apps/events/models.py`` and every test
below but the serializer-shape one fails.
"""
import json
from decimal import Decimal

import pytest

from dj.apps.events.models import Event
from dj.apps.g12f.models import Creator

# AMOUNT_MAX, format_amount and tuzis.zec (which imports AMOUNT_MAX) are
# imported inside the tests that need them, so that the negative control --
# this file against origin/main's IntegerField model -- fails on the
# behaviour under test rather than on an ImportError at collection.


@pytest.mark.django_db
def test_a_fractional_amount_round_trips_exactly(creator_factory):
    user = creator_factory()
    event = Event.objects.create(
        type="DONATION_RECEIVED", amount=Decimal("1.5"), receiving_user=user,
    )
    assert Event.objects.get(pk=event.pk).amount == Decimal("1.500")


@pytest.mark.django_db
def test_the_ledgers_own_precision_round_trips(creator_factory):
    """0.001 is the ledger's quantum (``ledger.TUZI_EXPONENT``)."""
    user = creator_factory()
    event = Event.objects.create(
        type="PLATFORM_FEE", amount=Decimal("0.001"), receiving_user=user,
    )
    assert Event.objects.get(pk=event.pk).amount == Decimal("0.001")


def test_amount_precision_is_the_ledgers():
    """Same digits and places as ``Creator.tuzis``: whatever the balance can
    hold, the audit row can record. If one changes, both must."""
    amount = Event._meta.get_field("amount")
    tuzis = Creator._meta.get_field("tuzis")
    assert (amount.max_digits, amount.decimal_places) == (
        tuzis.max_digits, tuzis.decimal_places)
    assert amount.max_digits == 17 and amount.decimal_places == 3


def test_the_zec_clamp_is_the_column_ceiling():
    from dj.apps.events.models import AMOUNT_MAX
    from dj.apps.tuzis import zec

    assert zec.EVENT_AMOUNT_MAX == AMOUNT_MAX == Decimal("99999999999999.999")


@pytest.mark.parametrize("value, rendered", [
    (Decimal("5.000"), "5"),
    (Decimal("1.500"), "1.5"),
    (Decimal("0.001"), "0.001"),
    (Decimal("-3.000"), "-3"),
    (Decimal("0.000"), "0"),
    (Decimal("2700000000.000"), "2700000000"),
    (None, "None"),
    (7, "7"),
])
def test_format_amount_drops_only_trailing_zeros(value, rendered):
    from dj.apps.events.models import format_amount

    assert format_amount(value) == rendered


@pytest.mark.django_db
def test_notification_copy_does_not_grow_trailing_zeros(creator_factory):
    """Every template interpolates the display form: a whole-number
    donation still reads "5 tuzi", a fractional one reads "1.5 tuzi"."""
    star = creator_factory()
    fan = creator_factory()
    whole = Event.objects.create(
        type="DONATION_RECEIVED", amount=5,
        receiving_user=star, contributor=fan, payee=star,
    )
    fraction = Event.objects.create(
        type="DONATION_SENT", amount=Decimal("1.5"),
        receiving_user=fan, contributor=fan, payee=star,
    )
    assert Event.objects.get(pk=whole.pk).message() == (
        f"You received 5 tuzi from {fan.username}")
    assert Event.objects.get(pk=fraction.pk).message() == (
        f"You sent 1.5 tuzi to {star.username}")


def test_every_template_needs_only_amount_and_renders_the_fraction():
    """The templates are handed duck-typed objects, not only ``Event``
    instances (``comments/test_comment_headline_optional.py`` pins that with
    an object carrying nothing but ``amount``). So the display form must be
    computed from ``amount`` in the template, never read off an
    ``Event``-only property -- and it must still drop the trailing zeros.
    """
    from types import SimpleNamespace

    from dj.apps.events.models import EVENT_TEMPLATES

    person = SimpleNamespace(username="someone")
    ev = SimpleNamespace(
        amount=Decimal("1.500"), contributor=person, payee=person,
        content_object=SimpleNamespace(title="a page"),
    )
    non_monetary = {"NEW_REPLY", "PAGE_UPDATE", "PAGE_MENTION", "ZEC_PENDING"}
    for event_type, template in EVENT_TEMPLATES.items():
        message = template["get_message"](ev)
        assert "1.500" not in message, (event_type, message)
        if event_type not in non_monetary:
            assert "1.5" in message, (event_type, message)
        if event_type == "ZEC_PENDING":
            # Detection copy carries no projected credit, including for the
            # current policy whose notification amount is null.
            assert "1.5" not in message
            assert template["get_message"](SimpleNamespace(amount=None)) == message


@pytest.mark.django_db
def test_the_api_and_the_pubsub_payload_carry_amount_as_a_json_number(
        api_client, creator_factory):
    """The wire type stays a JSON number, now possibly fractional.

    The notifications page renders the amount only inside
    ``typeof event.amount === "number"``, and the post_save signal hands
    ``to_dict()`` to a bare ``json.dumps`` -- DRF's default decimal *string*
    would blank the UI, and a raw Decimal would make the publish raise inside
    on_commit and never send.
    """
    user = creator_factory()
    event = Event.objects.create(
        type="BOUGHT_TUZI", amount=Decimal("36.900"), receiving_user=user,
    )
    payload = Event.objects.get(pk=event.pk).to_dict()
    assert payload["amount"] == 36.9
    assert json.loads(json.dumps(payload))["amount"] == 36.9

    api_client.force_authenticate(user=user)
    response = api_client.get("/api/events/")
    assert response.status_code == 200
    data = response.json()
    items = data["results"] if isinstance(data, dict) else data
    assert [item["amount"] for item in items] == [36.9]
