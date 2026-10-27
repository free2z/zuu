"""Event payloads must stop serving deactivated counterparties --.

``EventSerializer`` embeds ``receiving_user``, ``contributor`` and ``payee``
as ``SimpleCreatorSerializer``, whose fields include ``username``,
``full_name``, ``p2paddr`` (a Zcash payment address) and ``member_price``.
The events API is scoped to the receiving user, but the OTHER side of each
event is somebody else — and after that somebody has been deactivated, their
identity block kept shipping on every old event forever. The pre-rendered
English ``message`` leaked the same names a second way: the
``EVENT_TEMPLATES`` interpolate ``contributor.username`` / ``payee.username``
into strings like "Subscription payment from bob for 10 tuzi".

Fix shape: an inactive contributor/payee serializes as ``null`` and any
message naming one is replaced with a neutral string. The receiving user's
own history is untouched — events still list, still count, still mark read;
only the counterparty identity is redacted. Active counterparties serialize
exactly as before (control assertions pin username/p2paddr/member_price).

Every redaction test FAILS against unfixed main.
"""
from decimal import Decimal

import pytest

from dj.apps.events.models import Event

# Deliberately a local literal, NOT imported from the serializer: the
# negative controls must stay collectable against unfixed main, where the
# symbol does not exist — an ImportError at collection would skip the
# behavioral assertion the whole file exists to make. If the production
# wording ever changes, this constant is the one that must follow.
REDACTED_MESSAGE = "This activity is no longer available."

pytestmark = pytest.mark.django_db


def _counterparty(creator_factory):
    """A counterparty with every SimpleCreatorSerializer field populated."""
    return creator_factory(
        full_name="Counter Party",
        p2paddr="zs1counterparty-p2paddr-value",
        member_price=Decimal("25"),
    )


def _deactivate(creator):
    creator.is_active = False
    creator.save(update_fields=["is_active"])


def _items(source):
    data = source.json() if hasattr(source, "json") else source
    return data["results"] if isinstance(data, dict) else data


# --------------------------------------------------------------------------
# Contributor redaction
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_inactive_contributor_is_nulled_and_not_leaked(
    api_client, creator_factory,
):
    receiver = creator_factory()
    fan = _counterparty(creator_factory)
    Event.objects.create(
        type="DONATION_RECEIVED", amount=5,
        receiving_user=receiver, contributor=fan,
    )

    api_client.force_authenticate(user=receiver)

    # Control: active contributor ships the full identity block.
    before = api_client.get("/api/events/")
    assert _items(before)[0]["contributor"]["username"] == fan.username

    _deactivate(fan)

    response = api_client.get("/api/events/")
    assert response.status_code == 200, response.content
    body = response.content.decode()
    item = _items(response)[0]
    assert item["contributor"] is None
    # No fragment of the counterparty identity may survive anywhere in the
    # payload — nested object OR interpolated message copy.
    assert fan.username not in body
    assert "Counter Party" not in body
    assert "zs1counterparty-p2paddr-value" not in body
    # The receiving user's own history is preserved: same events, own block.
    assert len(_items(response)) == 1
    assert item["receiving_user"]["username"] == receiver.username


@pytest.mark.django_db
def test_active_contributor_payload_is_unchanged(api_client, creator_factory):
    receiver = creator_factory()
    fan = _counterparty(creator_factory)
    Event.objects.create(
        type="DONATION_RECEIVED", amount=5,
        receiving_user=receiver, contributor=fan,
    )
    Event.objects.create(
        type="BOUGHT_TUZI", amount=9, receiving_user=receiver,
    )

    api_client.force_authenticate(user=receiver)
    response = api_client.get("/api/events/")
    assert response.status_code == 200
    by_type = {i["type"]: i for i in _items(response)}
    contributor = by_type["DONATION_RECEIVED"]["contributor"]
    assert contributor["username"] == fan.username
    assert contributor["full_name"] == "Counter Party"
    assert contributor["p2paddr"] == "zs1counterparty-p2paddr-value"
    assert Decimal(str(contributor["member_price"])) == Decimal("25")


# --------------------------------------------------------------------------
# Payee redaction (the other direction of the money)
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_inactive_payee_is_nulled_and_message_scrubbed(
    api_client, creator_factory,
):
    payer = creator_factory()
    star = _counterparty(creator_factory)
    Event.objects.create(
        type="SUBSCRIPTION_SENT", amount=10,
        receiving_user=payer, payee=star,
    )

    api_client.force_authenticate(user=payer)

    before = _items(api_client.get("/api/events/"))[0]
    assert before["payee"]["username"] == star.username
    assert star.username in before["message"]

    _deactivate(star)

    response = api_client.get("/api/events/")
    assert response.status_code == 200, response.content
    body = response.content.decode()
    item = _items(response)[0]
    assert item["payee"] is None
    assert item["message"] == REDACTED_MESSAGE
    assert star.username not in body
    assert "Counter Party" not in body


@pytest.mark.django_db
def test_active_payee_message_keeps_the_template_text(
    api_client, creator_factory,
):
    payer = creator_factory()
    star = _counterparty(creator_factory)
    Event.objects.create(
        type="SUBSCRIPTION_SENT", amount=10,
        receiving_user=payer, payee=star,
    )

    api_client.force_authenticate(user=payer)
    item = _items(api_client.get("/api/events/"))[0]
    assert item["message"] == (
        f"Subscription paid to {star.username} for 10 tuzi")
    assert item["payee"]["username"] == star.username


# --------------------------------------------------------------------------
# The message field is a second leak channel of its own
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_message_redacted_when_contributor_inactive(api_client, creator_factory):
    receiver = creator_factory()
    replier = _counterparty(creator_factory)
    Event.objects.create(
        type="NEW_REPLY", amount=None,
        receiving_user=receiver, contributor=replier,
    )
    _deactivate(replier)

    api_client.force_authenticate(user=receiver)
    item = _items(api_client.get("/api/events/"))[0]
    assert item["contributor"] is None
    assert item["message"] == REDACTED_MESSAGE


@pytest.mark.django_db
def test_message_with_no_counterparty_never_redacted(
    api_client, creator_factory,
):
    """Self-directed events (BOUGHT_TUZI etc.) have no counterparty to hide."""
    user = creator_factory()
    Event.objects.create(type="BOUGHT_TUZI", amount=7, receiving_user=user)

    api_client.force_authenticate(user=user)
    item = _items(api_client.get("/api/events/"))[0]
    assert item["payee"] is None
    assert item["contributor"] is None
    assert item["message"] == "You bought 7 tuzi"
