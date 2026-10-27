"""The PPV "unlock" payment must never take 2Z without admitting.

`PayPerViewPrompt` used to transfer the per-minute price to the creator
(`POST /api/tuzis/donate-idempotent/<creator>` with `intent: "ppv"`) and then
retry the join. But admission is, and stays, a pure reserve check --
`balance >= ceil(price * 30) + 15` -- and nothing recorded the payment. The
unlock was only ever offered AFTER a join had been refused for being under
that reserve, so the money it took pushed the viewer further under it: pay,
402, pay, 402, until the account was empty and nothing had been watched.

There is no entitlement to sell. PPV is billed per minute at settlement
(`participantLeft`), which is what the creator-facing copy has always
described; the reserve is the only admission requirement. So the server now
refuses a NEW `ppv` purchase outright (nothing moves, no receipt is kept) and
keeps replaying receipts of unlocks that already happened, so an old bundle
retrying an ambiguous response is told the truth rather than "failed".

These tests exercise the donate -> join SEQUENCE, which nothing covered: the
existing suites validate the donation and the admission gate independently.
They run against real Postgres and the real ledger functions; only the video
provider boundary is stubbed.
"""
import hashlib
import uuid
from decimal import Decimal

import pytest
from rest_framework.test import APIClient

from dj.apps.dyte.models import PAY_PER_VIEW, CreatorMeeting
from dj.apps.dyte.views import ppv_join_threshold
from dj.apps.events.models import Event
from dj.apps.g12f.models import Creator
from dj.apps.tuzis import ledger
from dj.apps.tuzis import models as idempotency
from dj.apps.tuzis.models import IdempotencyKey
from dj.apps.tuzis.views import _stored_response

pytestmark = pytest.mark.django_db

# A whole-2Z rate, so the unlock passes the donation route's whole-2Z amount
# validation and genuinely reached the ledger before this fix. (A fractional
# rate was refused with a 400 before any money moved -- a different bug that
# hid this one for those streams.)
PRICE = Decimal("2")
RESERVE = ppv_join_threshold(PRICE)  # ceil(2 * 30) + 15 = 75


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload

    @property
    def text(self):
        return str(self._payload)


@pytest.fixture
def dyte_client(mocker):
    client = mocker.MagicMock()
    client.add_participant.return_value = _FakeResponse(
        {"data": {"token": "auth-token"}})
    mocker.patch("dj.apps.dyte.views.DyteClient", return_value=client)
    return client


@pytest.fixture
def ppv_stream(creator_factory):
    star = creator_factory(tuzis=Decimal("1000"))
    CreatorMeeting.objects.create(
        creator=star,
        meeting_id="live-ppv-1601",
        meeting_type=PAY_PER_VIEW,
        is_public=True,
        live_now=True,
        price_per_minute=PRICE,
    )
    return star


def _key(label):
    return str(uuid.UUID(bytes=hashlib.md5(label.encode()).digest(), version=4))


def _client(user):
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=user.pk))
    return client


def _unlock(viewer, star, *, key):
    """Exactly what PayPerViewPrompt sent."""
    return _client(viewer).post(
        f"/api/tuzis/donate-idempotent/{star.username}",
        {"amount": str(PRICE), "anon": False, "intent": "ppv"},
        format="json",
        HTTP_IDEMPOTENCY_KEY=_key(key),
    )


def _join(viewer, star):
    """Exactly what the prompt's onSuccess -> joinStream() sent."""
    return _client(viewer).post(
        f"/api/dyte/{star.username}/{PAY_PER_VIEW}",
        {"role": "viewer"},
        format="json",
    )


def _balance(creator):
    return Creator.objects.values_list("tuzis", flat=True).get(pk=creator.pk)


def test_reserve_and_price_are_the_issue_scenario():
    # Guard the arithmetic the scenario below depends on.
    assert RESERVE == 75


def test_unlock_then_join_never_takes_2z_without_admitting(
    ppv_stream, dyte_client, creator_factory,
):
    """The issue's reproduction: one 2Z short, pay, join, repeat.

    The invariant is stated without reference to HOW it is kept: across the
    whole donate -> join loop, a viewer who is never admitted never loses a
    single 2Z, and the creator never receives one from them.
    """
    star = ppv_stream
    viewer = creator_factory(tuzis=Decimal(RESERVE - 1))
    star_before = _balance(star)

    first_join = _join(viewer, star)
    assert first_join.status_code == 402
    assert first_join.data["code"] == "insufficient_funds"
    assert first_join.data["cost"] == f"{RESERVE}.000"

    for attempt in range(3):
        _unlock(viewer, star, key=f"ppv-unlock-{attempt}")
        join = _join(viewer, star)
        # Still under the reserve, so still refused: there is no free
        # admission, with or without an unlock attempt...
        assert join.status_code == 402, attempt
        #...and the refused viewer was charged nothing for the attempt.
        assert _balance(viewer) == Decimal(RESERVE - 1), attempt
        assert _balance(star) == star_before, attempt

    dyte_client.add_participant.assert_not_called()


def test_a_new_ppv_unlock_is_refused_and_leaves_nothing_behind(
    ppv_stream, creator_factory,
):
    star = ppv_stream
    # Even a viewer who could afford the unlock AND the reserve: the unlock
    # buys nothing they do not already have, so it is not sold to anyone.
    viewer = creator_factory(tuzis=Decimal("500"))

    response = _unlock(viewer, star, key="rich-viewer-unlock")

    assert response.status_code == 400
    assert response.data["code"] == "ppv_unlock_retired"
    assert _balance(viewer) == Decimal("500")
    assert _balance(star) == Decimal("1000")
    assert not Event.objects.filter(
        type__in=("DONATION_SENT", "DONATION_RECEIVED")).exists()
    # No receipt either: a retry with the same key gets the same refusal,
    # and the key is free for nothing in particular.
    assert not IdempotencyKey.objects.filter(user=viewer).exists()
    again = _unlock(viewer, star, key="rich-viewer-unlock")
    assert again.status_code == 400
    assert again.data["code"] == "ppv_unlock_retired"
    assert _balance(viewer) == Decimal("500")


def test_a_viewer_at_the_reserve_is_admitted_without_any_unlock(
    ppv_stream, dyte_client, creator_factory,
):
    """What the prompt now does instead of paying: just join.

    Admission moves no money; the per-minute settlement on leave is the only
    PPV charge.
    """
    star = ppv_stream
    viewer = creator_factory(tuzis=Decimal(RESERVE))

    join = _join(viewer, star)

    assert join.status_code == 200
    assert join.data["auth_token"] == "auth-token"
    assert _balance(viewer) == Decimal(RESERVE)
    assert _balance(star) == Decimal("1000")
    dyte_client.add_participant.assert_called_once()


def test_a_historical_ppv_unlock_receipt_still_replays(
    ppv_stream, creator_factory,
):
    """An old bundle retrying an unlock that DID commit before this release
    must hear "already recorded", never "refused": the 2Z did move, and a
    refusal would tell the viewer otherwise. And the replay moves nothing.
    """
    star = ppv_stream
    viewer = creator_factory(tuzis=Decimal("98"))
    key = _key("pre-release-unlock")
    amount = PRICE.quantize(ledger.TUZI_EXPONENT)
    # The receipt exactly as IdempotentDonate2Z recorded it pre-.
    unresolved = idempotency.fingerprint({
        "recipient_username": star.username,
        "amount": str(amount),
        "anonymous": False,
        "action": "ppv",
    })
    request_hash = idempotency.fingerprint({
        "recipient": str(star.pk),
        "recipient_username": star.username,
        "amount": str(amount),
        "anonymous": False,
        "action": "ppv",
    })
    record = idempotency.claim(
        "donate-idempotent", viewer, key, request_hash=request_hash)
    record.finish(200, _stored_response(
        {"balance": "98.000", "charged": str(amount), "replayed": False},
        unresolved,
    ))

    response = _client(viewer).post(
        f"/api/tuzis/donate-idempotent/{star.username}",
        {"amount": str(PRICE), "anon": False, "intent": "ppv"},
        format="json",
        HTTP_IDEMPOTENCY_KEY=key,
    )

    assert response.status_code == 200, response.data
    assert response.data["replayed"] is True
    assert response.data["charged"] == str(amount)
    assert _balance(viewer) == Decimal("98")
    assert _balance(star) == Decimal("1000")


def test_an_ordinary_donation_is_untouched(ppv_stream, creator_factory):
    star = ppv_stream
    fan = creator_factory(tuzis=Decimal("100"))

    response = _client(fan).post(
        f"/api/tuzis/donate-idempotent/{star.username}",
        {"amount": "2", "anon": False, "intent": "donation"},
        format="json",
        HTTP_IDEMPOTENCY_KEY=_key("plain-donation"),
    )

    assert response.status_code == 200
    assert _balance(fan) == Decimal("98")
    assert _balance(star) == Decimal("1002")
