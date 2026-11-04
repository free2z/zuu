"""Issue  — the broadcast participant fee floor is gone.

``calculate_platform_fee`` used to be ``max(duration_minutes // 2, 1)``. On a
broadcast the fee is paid by the *creator* for every non-creator participant
session, and a single participant token can be reused to join the same meeting
repeatedly — so the floor let one API call plus a connect/disconnect loop bill
a creator 1 2Z per cycle for sessions costing us a fraction of a
participant-minute of provider time, draining the balance below the 150 2Z
go-live threshold. Without the floor a joiner has to hold a real session past
the one-minute mark before the creator is charged anything.

These are real-Postgres tests against the signature-verified webhook, because
the webhook is the ONLY place a broadcast creator is ever debited.
"""
import base64
import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from dj.apps.dyte.models import BROADCAST, PAY_PER_VIEW, CreatorMeeting
from dj.apps.dyte.views import (
    PPV_JOIN_PLATFORM_RESERVE,
    PPV_JOIN_RESERVE_MINUTES,
    calculate_platform_fee,
)
from dj.apps.events.models import Event

WEBHOOK_URL = '/api/dyte/webhook'

# The formula the fee floor used to have. Every assertion that the change can
# only ever LOWER a bill is made against this, not against a remembered number.
def _legacy_platform_fee(duration_minutes: int) -> int:
    return max(duration_minutes // 2, 1)


@pytest.fixture(scope='module')
def keypair():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private_key, private_key.public_key()


@pytest.fixture(autouse=True)
def webhook_boundaries(mocker, keypair):
    _, public_key = keypair
    mocker.patch(
        'dj.apps.dyte.views.get_or_load_dyte_public_key',
        return_value=public_key,
    )
    mocker.patch(
        'dj.apps.dyte.views._DYTE_PUBLIC_KEY_LOADED_AT', time.monotonic())
    # No Pub/Sub patch here any more: the producers write an outbox row
    #  and the root conftest already stubs the relay's client.


def _sign(private_key, body):
    return base64.b64encode(private_key.sign(
        body, padding.PKCS1v15(), hashes.SHA256(),
    )).decode()


def _meeting(meeting_id):
    return {
        'id': meeting_id,
        'sessionId': str(uuid.uuid4()),
        'title': 'Open broadcast',
        'status': 'LIVE',
        'createdAt': '2026-08-07T00:00:00Z',
        'startedAt': '2026-08-07T00:00:00Z',
        'organizedBy': {'id': str(uuid.uuid4()), 'name': 'free2z'},
    }


JOINED_AT = datetime(2026, 8, 7, 0, 0, 0, tzinfo=timezone.utc)


def _left_after(cm, participant_id, seconds):
    """A signed-shape participantLeft payload for a session of ``seconds``."""
    left_at = JOINED_AT + timedelta(seconds=seconds)
    return json.dumps({
        'event': 'meeting.participantLeft',
        'meeting': _meeting(cm.meeting_id),
        'participant': {
            'peerId': str(uuid.uuid4()),
            'userDisplayName': participant_id,
            'customParticipantId': participant_id,
            'joinedAt': JOINED_AT.isoformat().replace('+00:00', 'Z'),
            'leftAt': left_at.isoformat().replace('+00:00', 'Z'),
        },
    }).encode()


def _post(client, private_key, body):
    return client.post(
        WEBHOOK_URL,
        data=body,
        content_type='application/json',
        HTTP_DYTE_SIGNATURE=_sign(private_key, body),
        HTTP_DYTE_UUID=str(uuid.uuid4()),
    )


def _broadcast(creator_factory, tuzis='1000'):
    creator = creator_factory(tuzis=Decimal(tuzis))
    cm = CreatorMeeting.objects.create(
        creator=creator,
        meeting_id=str(uuid.uuid4()),
        meeting_type=BROADCAST,
    )
    return cm, creator


# ---------------------------------------------------------------------------
# The formula itself
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('duration_minutes, expected', [
    # `duration_minutes` is already ceil()'d from seconds by the caller, so 0
    # only arises from a zero-length session; it must not cost anything.
    (0, 0),
    # THE BOUNDARY. 1 was the whole vulnerability: it used to bill 1 2Z.
    (1, 0),
    (2, 1),
    (3, 1),
    (4, 2),
    (5, 2),
    (30, 15),
    (60, 30),
])
def test_platform_fee_at_and_around_the_two_minute_boundary(
    duration_minutes, expected,
):
    assert calculate_platform_fee(duration_minutes) == expected


def test_the_only_change_is_below_two_minutes():
    """A pricing change that could ever bill MORE would be a blocking bug."""
    changed = []
    for duration_minutes in range(0, 601):
        new = calculate_platform_fee(duration_minutes)
        old = _legacy_platform_fee(duration_minutes)
        assert new <= old, (
            f'{duration_minutes} min now costs {new} 2Z, was {old} — a fee '
            'floor removal must never raise a bill'
        )
        if new != old:
            changed.append(duration_minutes)
    # Exactly the sub-two-minute sessions moved, and each moved 1 2Z -> 0.
    assert changed == [0, 1]


def test_fee_never_decreases_as_a_session_gets_longer():
    previous = 0
    for duration_minutes in range(0, 601):
        fee = calculate_platform_fee(duration_minutes)
        assert fee >= previous
        previous = fee


def test_ppv_admission_reserve_still_matches_the_charged_fee():
    """The quoted PPV entry reserve must not drift from what is billed.

    ``ppv_join_threshold`` adds a flat PPV_JOIN_PLATFORM_RESERVE on top of the
    per-minute price; it is only honest if it equals the platform fee actually
    charged for a full PPV_JOIN_RESERVE_MINUTES session.
    """
    assert PPV_JOIN_PLATFORM_RESERVE == calculate_platform_fee(
        PPV_JOIN_RESERVE_MINUTES)


# ---------------------------------------------------------------------------
# End to end, through the signed webhook, against real Postgres
# ---------------------------------------------------------------------------

@pytest.mark.django_db
@pytest.mark.parametrize('seconds', [1, 5, 30, 59, 60])
def test_broadcast_session_of_a_minute_or_less_bills_the_creator_nothing(
    api_client, creator_factory, keypair, seconds,
):
    """`duration_minutes` <= 1 (wall clock <= 60s) is free. This is.

    Note the wall-clock boundary is ONE minute, not two: ceil() rounds 0:61 up
    to 2 minutes, which bills 1 2Z. The creator-facing copy has to say "a
    minute or less"; see test_broadcast_billing_at_the_boundary_and_above.
    """
    private_key, _ = keypair
    cm, creator = _broadcast(creator_factory, tuzis='150')

    body = _left_after(cm, 'Guest 8b1f', seconds)
    assert _post(api_client, private_key, body).status_code == 200

    creator.refresh_from_db()
    assert creator.tuzis == Decimal('150')
    #...and the creator is still above the go-live threshold.
    assert creator.can_stream is True


@pytest.mark.django_db
def test_zero_cost_session_is_still_recorded(
    api_client, creator_factory, keypair,
):
    """Billing nothing must not mean observing nothing.

    The abuse fingerprint is thousands of sessions against a handful of
    concurrent participants; that ratio is only visible if free sessions are
    still written down.
    """
    private_key, _ = keypair
    cm, creator = _broadcast(creator_factory)

    assert _post(
        api_client, private_key, _left_after(cm, 'Guest 8b1f', 3),
    ).status_code == 200

    fee_events = Event.objects.filter(
        type='PLATFORM_FEE', receiving_user=creator)
    assert fee_events.count() == 1
    assert fee_events.get().amount == Decimal('0')


@pytest.mark.django_db
@pytest.mark.parametrize('seconds, expected_fee', [
    # ceil(seconds / 60) crosses into 2 minutes one second past the minute, so
    # 60s is the last free session and 61s is the first that costs anything.
    (60, 0),
    (61, 1),
    (120, 1),
    (121, 1),
    (180, 1),
    (181, 2),
    (3600, 30),
])
def test_broadcast_billing_at_the_boundary_and_above(
    api_client, creator_factory, keypair, seconds, expected_fee,
):
    private_key, _ = keypair
    cm, creator = _broadcast(creator_factory)

    body = _left_after(cm, 'Guest 8b1f', seconds)
    assert _post(api_client, private_key, body).status_code == 200

    creator.refresh_from_db()
    assert creator.tuzis == Decimal('1000') - Decimal(expected_fee)
    assert Event.objects.get(
        type='PLATFORM_FEE', receiving_user=creator,
    ).amount == Decimal(expected_fee)


@pytest.mark.django_db
@pytest.mark.parametrize('seconds', [61, 121, 600, 3600])
def test_long_broadcast_sessions_bill_exactly_what_they_did_before(
    api_client, creator_factory, keypair, seconds,
):
    """Anything at or past the boundary is byte-for-byte the old behaviour."""
    private_key, _ = keypair
    cm, creator = _broadcast(creator_factory)
    duration_minutes = -(-seconds // 60)  # ceil, mirroring the handler

    assert _post(
        api_client, private_key, _left_after(cm, 'Guest 8b1f', seconds),
    ).status_code == 200

    creator.refresh_from_db()
    expected = _legacy_platform_fee(duration_minutes)
    assert creator.tuzis == Decimal('1000') - Decimal(expected)


@pytest.mark.django_db
def test_repeated_sub_minute_joins_cost_the_creator_nothing(
    api_client, creator_factory, keypair,
):
    """The  attack, replayed at its old speed.

    One participant token, reused for a connect/disconnect loop. Each cycle is
    a distinct billable event by design (fresh peerId/joinedAt/leftAt), so the
    idempotency claim does not stop it — only the missing floor does. Before
    this change these 40 cycles cost the creator 40 2Z and knocked a creator
    sitting on the 150 2Z go-live threshold off the air.
    """
    private_key, _ = keypair
    cm, creator = _broadcast(creator_factory, tuzis='150')

    for _cycle in range(40):
        assert _post(
            api_client, private_key, _left_after(cm, 'Guest 8b1f', 2),
        ).status_code == 200

    creator.refresh_from_db()
    assert creator.tuzis == Decimal('150')
    assert creator.can_stream is True
    # Every cycle is still on the record even though none of them billed.
    assert Event.objects.filter(
        type='PLATFORM_FEE', receiving_user=creator).count() == 40


@pytest.mark.django_db
def test_a_session_past_the_boundary_still_bills_and_still_can_unseat_a_creator(
    api_client, creator_factory, keypair,
):
    """The residual exposure, asserted rather than hand-waved.

    This change makes the drain ~60x more expensive; it does not make it
    impossible. A joiner who holds a session past 60 seconds still bills the
    creator 1 2Z, and a creator sitting exactly on the 150 2Z go-live
    threshold is still knocked below it by one such session.

    That is the accepted trade in: closing it needs an admission gate, and
    the owner's constraint is that nothing may limit how many people watch a
    stream. What the change buys is that extracting a 2Z now costs the attacker
    a held, concurrent session — visible in ``live_participants`` and
    indistinguishable from watching — instead of a one-second drive-by. If this
    test's premise ever needs revisiting, it is the concurrency-ratio signal
    (billable sessions per concurrent participant) that should catch it, not a
    join-rate throttle: the attacker issues exactly one POST.
    """
    private_key, _ = keypair
    cm, creator = _broadcast(creator_factory, tuzis='150')

    assert _post(
        api_client, private_key, _left_after(cm, 'Guest 8b1f', 61),
    ).status_code == 200

    creator.refresh_from_db()
    assert creator.tuzis == Decimal('149')
    assert creator.can_stream is False


@pytest.mark.django_db
def test_creator_own_session_is_still_never_billed(
    api_client, creator_factory, keypair,
):
    private_key, _ = keypair
    cm, creator = _broadcast(creator_factory)

    assert _post(
        api_client, private_key, _left_after(cm, creator.username, 3600),
    ).status_code == 200

    creator.refresh_from_db()
    assert creator.tuzis == Decimal('1000')
    assert Event.objects.filter(type='PLATFORM_FEE').count() == 0


@pytest.mark.django_db
def test_short_ppv_session_drops_the_platform_fee_but_still_pays_the_creator(
    api_client, creator_factory, keypair,
):
    """PPV shares the formula, so it gets the same price cut — never a rise.

    The PPV platform fee is paid by the viewer for their own session, so it was
    never the  lever; it moves only because the formula is shared. The
    creator's per-minute cut is a separate calculation and is untouched.
    """
    private_key, _ = keypair
    creator = creator_factory(tuzis=Decimal('100'))
    viewer = creator_factory(tuzis=Decimal('100'))
    cm = CreatorMeeting.objects.create(
        creator=creator,
        meeting_id=str(uuid.uuid4()),
        meeting_type=PAY_PER_VIEW,
        price_per_minute=Decimal('3'),
    )

    # 30s -> duration_minutes 1 -> platform fee 0 (was 1), creator fee 3.
    assert _post(
        api_client, private_key, _left_after(cm, viewer.username, 30),
    ).status_code == 200

    creator.refresh_from_db()
    viewer.refresh_from_db()
    assert creator.tuzis == Decimal('103')
    assert viewer.tuzis == Decimal('97')
    assert Event.objects.get(
        type='PLATFORM_FEE', receiving_user=viewer).amount == Decimal('0')
