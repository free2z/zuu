"""A recording inherits the audience its room has WHEN THE RECORDING LANDS.

Not "the audience it had when it was recorded" -- that shorter sentence is
what this file used to say and it is false in one direction. The consumer
reads `meeting_type` at ingest, so restricting a room mid-flight is honoured
(pinned below, twice), and so is WIDENING one: flipping a subscribers-only
room to broadcast while its recording is queued or downloading publishes that
older recording. That is a real property of the merged design, it is not
pinned here in either direction as required behaviour, and changing it needs
the audience to be captured at record time -- an owner-scoped decision this
PR does not take (codex adversarial review, MEDIUM).

 made `dyte_download_upload` derive `GenericFile.access` from the
recording's `CreatorMeeting` instead of letting it fall through to the model
default (`public`). Before that, a `subscribers-only` room -- which is the
DEFAULT `meeting_type` -- had its recording republished at
`/uploadz/public/recordings/<uuid>` for anyone to fetch; for `ppv` that was
also a revenue leak. This file is the  audit's behavioural half of that
guarantee.

's own tests pin the resolver as a unit -- `resolve_recording_access()`
called directly with a hand-written dict -- plus two source-scraping checks
that the call is `select_for_update` and sits inside the atomic block. That
proves the function, not the pipeline. Nothing anywhere drives the chain:

  producer  (`dyte.views._process_webhook_event` /
             `_process_legacy_recording_event` -> `publish_recording_ready`)
      --meeting_pk-->
  consumer  (`dyte_download_upload.callback` -> `resolve_recording_access`)
      --> `GenericFile.access` --> the URL a viewer actually hits

and neither producer call site is covered at all: `grep -rn
publish_recording_ready py/dj/apps/dyte/` matched only `views.py` before this
file existed. A rename or a dropped keyword on either side of that one dict
key leaves every  test green and every recording `private`.

So the tests below never hand-write the payload. They drive the REAL producer,
take what it actually put on the topic, and feed that to the real consumer.
The seam is the thing under test.

Two invariants ride along:

* the message carries the meeting's IDENTIFIER and never a level -- the same
  rule  applies to URLs and request metadata. Stated precisely, because
  the loose version ("a message cannot choose the level") is false: a
  `meeting_pk` DOES select, within the sending creator's own public rooms.
  `test_a_message_selects_a_level_from_within_the_senders_own_rooms`
  characterises that residual exposure instead of asserting it away;
* every path that cannot positively identify a public audience fails closed to
  `private`. `private` costs the creator one click in the media dashboard; a
  blob that reached the open internet and Cloud CDN cannot be recalled
  ( hazard 2 -- and per  the purge has never actually run).
"""
import uuid
from datetime import datetime, timezone as dt_timezone
from unittest import mock

import pytest
from django.core.files.storage import FileSystemStorage

from dj.apps.dyte import models as dyte_models
from dj.apps.dyte import views as dyte_views
from dj.apps.jobs import outbox
from dj.apps.dyte.management.commands import dyte_download_upload as dlu
from dj.apps.dyte.models import (
    BROADCAST,
    MEETING_TYPES,
    PAY_PER_VIEW,
    PRIVATE,
    SUBSCRIBERS_ONLY,
    CreatorMeeting,
    RecordingDelivery,
)
from dj.apps.dyte.types import LegacyRecordingWebhookEvent, WebhookEvent
from dj.apps.uploads.models import ACCESS_CHOICES, GenericFile


RECORDING_URL = "https://bucket.s3.us-east-1.amazonaws.com/rec.mp4"

#The fail-closed level, named once so a rename of
#`dlu.DEFAULT_RECORDING_ACCESS` cannot quietly turn these assertions into
#assertions about something else.
RESTRICTED = "private"

#meeting_type -> the level a recording of it must land at, spelled out
#literally rather than read back out of the mapping under test. Derived from
#how the LIVE room is gated (`dyte.views`), which is the whole argument:
#
#broadcast         anonymous POST is permitted for this type and only this
#type, so the live audience is everyone -> public
#subscribers-only  authenticated + an unexpired `Subscription` of this
#creator, which is exactly `_members_access_ok` -> members
#ppv               any logged-in viewer holding `ceil(price*30)+15` 2Z. No
#upload level expresses a per-item purchase: `members`
#would be wrong in both directions and `public` gives
#away what was sold -> private, the safe tier
#private           a rotating secret URL, not a re-checkable identity, and
#nothing on an upload means "whoever held the link"
#-> private
EXPECTED_LEVEL = {
    BROADCAST: "public",
    SUBSCRIBERS_ONLY: "members",
    PAY_PER_VIEW: RESTRICTED,
    PRIVATE: RESTRICTED,
}


# --------------------------------------------------------------------------
# the mapping itself -- pure, no database
# --------------------------------------------------------------------------

def test_every_meeting_type_has_a_deliberate_recording_level():
    """A new meeting type must not silently inherit anything.

    `recording_access_for_meeting_type` falls back to the restricted level, so
    an unmapped type fails closed rather than publishing -- but "fails closed"
    is not the same as "was decided", and a fifth type quietly landing every
    one of its recordings owner-only is a regression a creator would feel.
    This asserts the mapping is TOTAL over `MEETING_TYPES`, so adding a type
    is a decision someone has to make here.
    """
    assert set(dlu._GENERIC_FILE_ACCESS_BY_MEETING_TYPE) == set(MEETING_TYPES)
    assert {
        meeting_type: dlu.recording_access_for_meeting_type(meeting_type)
        for meeting_type in MEETING_TYPES
    } == EXPECTED_LEVEL

    # Every level it can produce is one `GenericFile.access` actually accepts.
    levels = {level for level, _label in ACCESS_CHOICES}
    assert set(EXPECTED_LEVEL.values()) <= levels
    assert dlu.DEFAULT_RECORDING_ACCESS == RESTRICTED
    assert dlu.recording_access_for_meeting_type("watch-party") == RESTRICTED


def test_the_meeting_type_default_is_a_gated_one():
    """Why this bug was as bad as it was: the DEFAULT room is gated.

    A creator who never picks a type gets `subscribers-only`, so the broken
    path published the recordings of the most ordinary room there is. The
    model default on `GenericFile.access` is still `public` and is left alone
    deliberately -- which is why the recording row has to be born restricted
    rather than relying on it.
    """
    assert dyte_models.CreatorMeeting._meta.get_field(
        "meeting_type").default == SUBSCRIBERS_ONLY
    assert EXPECTED_LEVEL[SUBSCRIBERS_ONLY] == "members"
    assert GenericFile._meta.get_field("access").default == "public"


# --------------------------------------------------------------------------
# harness
# --------------------------------------------------------------------------

class _Message:
    def __init__(self, payload):
        import json
        self.data = json.dumps(payload).encode("utf-8")
        self.acked = False
        self.nacked = False

    def ack(self):
        self.acked = True

    def nack(self):
        self.nacked = True


class _Resp:
    is_redirect = False
    is_permanent_redirect = False
    status_code = 200
    headers = {}

    def raise_for_status(self):
        pass

    def iter_content(self, chunk_size=8192):
        yield b"video-bytes"

    def close(self):
        pass


@pytest.fixture(autouse=True)
def _no_close_connections(mocker):
    # The subscriber's catch_errors wrapper calls close_old_connections() on
    # every message; under a test transaction that would drop the connection.
    mocker.patch.object(dlu, "close_old_connections")
    mocker.patch.object(dlu.connection, "close")


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    }
    settings.MEDIA_ROOT = str(tmp_path)


@pytest.fixture
def download(mocker):
    """Stub the provider fetch; every test here is about the level, not I/O."""
    return mocker.patch.object(dlu.requests, "get", return_value=_Resp())


@pytest.fixture
def queued(mocker):
    """Return what the REAL producer actually puts on the topic.

    Driving the consumer with the producer's own payload is the point: the two
    halves meet at one dict key, and a test that hand-writes
    `{"meeting_pk":...}` on both sides -- which is what  shipped -- would
    keep passing after a rename or a dropped keyword on one side only.

    `_process_legacy_recording_event` is the smaller of the two production
    call sites; `test_the_primary_webhook_path_also_names_the_room` drives the
    other one.
    """
    #the producer writes an outbox row; `jobs.outbox` is the only
    # thing that talks to Pub/Sub, so that is the boundary to mock and
    # `outbox.drain()` is what actually puts the payload on the topic.
    publisher = mocker.patch.object(outbox, "PubSubClient")

    def _queue(meeting):
        event = LegacyRecordingWebhookEvent(
            # The row's OWN provider id, so the event is one the real legacy
            # endpoint would resolve to this `cm` via
            # `get_object_or_404(CreatorMeeting, meeting_id=...)`. That
            # endpoint-level binding is still not asserted here -- see the
            # PR body -- but the fixture is no longer a shape the endpoint
            # would have rejected.
            meeting={"id": str(meeting.meeting_id)},
            recording={
                "id": str(uuid.uuid4()),
                "status": "UPLOADED",
                "downloadUrl": RECORDING_URL,
            },
        )
        dyte_views._process_legacy_recording_event(
            event_data=event,
            cm=meeting,
            provider_event_id=uuid.uuid4(),
            payload=b"{}",
        )
        outbox.drain()
        assert publisher.return_value.publish.called, (
            "the producer did not publish at all; the rest of this test would "
            "be asserting against a stale or empty payload"
        )
        return dict(publisher.return_value.publish.call_args.args[1])

    return _queue


def _meeting(creator, meeting_type, *, is_public=True):
    # A real provider-shaped UUID, so `queued()` can build an event whose
    # `meeting.id` genuinely NAMES this row rather than being unrelated to it
    # (codex adversarial review, MEDIUM).
    return CreatorMeeting.objects.create(
        creator=creator,
        meeting_id=str(uuid.uuid4()),
        meeting_type=meeting_type,
        is_public=is_public,
    )


# --------------------------------------------------------------------------
# the pipeline, driven end to end across the producer/consumer seam
# --------------------------------------------------------------------------

@pytest.mark.django_db
@pytest.mark.parametrize("meeting_type", sorted(EXPECTED_LEVEL))
def test_a_recording_lands_at_its_meetings_own_level(
    creator_factory, download, queued, meeting_type,
):
    """The headline. Recording of a gated room -> a gated upload.

    The published payload goes in unmodified, so this covers the producer
    naming the field, the consumer reading it, the lookup resolving, and the
    level reaching the row. Only the `broadcast` half of this is covered
    anywhere else, and only incidentally.
    """
    creator = creator_factory(username=f"rec-{meeting_type}")
    _meeting(creator, meeting_type, is_public=meeting_type != PRIVATE)
    message = _Message(queued(CreatorMeeting.objects.get(creator=creator)))

    dlu.callback(message)

    assert message.acked is True
    stored = GenericFile.objects.get(owner=creator)
    assert stored.access == EXPECTED_LEVEL[meeting_type]
    # The URL the row hands out follows, which is what a viewer actually hits.
    # `_get_prefix()` returns `/uploadz/public/` for `public` only, and that
    # prefix is the one nginx serves without an auth subrequest.
    if EXPECTED_LEVEL[meeting_type] == "public":
        assert stored.get_url().startswith("/uploadz/public/")
    else:
        assert not stored.get_url().startswith("/uploadz/public/")


@pytest.mark.django_db
def test_the_producer_sends_the_rooms_identifier_and_not_its_level(
    creator_factory, queued,
):
    """A queue message may name a resource; it may never carry the level.

    If the level travelled on the message, anything that could publish to the
    topic could set it directly. The consumer re-reads our own row instead, so
    a message can only NAME a meeting.

    Read that narrowly. `meeting_pk` is still a selector, and
    `test_a_message_selects_a_level_from_within_the_senders_own_rooms` is the
    honest bound on it: a message cannot invent a level and cannot reach
    another creator's rooms, but WITHIN one creator's rooms it does choose,
    so pairing the right recording with the right pk is the producer's job and
    is pinned separately (codex adversarial review, HIGH). The absence of an
    `access` key below is not on its own a security property.
    """
    creator = creator_factory(username="producer-payload")
    meeting = _meeting(creator, SUBSCRIBERS_ONLY)

    payload = queued(meeting)

    assert payload["meeting_pk"] == meeting.pk
    assert payload["username"] == creator.username
    assert payload["creator_id"] == creator.pk
    assert "access" not in payload
    assert not any(
        value in {"public", "members", "private"}
        for value in payload.values()
    )


@pytest.mark.django_db
def test_a_message_selects_a_level_from_within_the_senders_own_rooms(
    creator_factory, download, queued,
):
    """The honest bound on `meeting_pk`, characterised rather than claimed away.

    Codex adversarial review, HIGH: "a message cannot choose the level" is
    FALSE as stated. A creator routinely has both a `broadcast` room and a
    gated one. `resolve_recording_access` scopes the lookup to the creator and
    to `is_public=True` and nothing further, so a message that pairs a
    SUBSCRIBERS-ONLY recording with that same creator's BROADCAST pk resolves
    `public` and nginx then serves it anonymously. Both guards match; nothing
    in the payload distinguishes which room the bytes came from.

    `test_a_meeting_belonging_to_someone_else_is_not_borrowed` does not cover
    this -- it is a cross-CREATOR mismatch, which the scoping does catch.
    Every other fixture here gives a creator exactly one relevant room, so
    this class of regression would have stayed invisible.

    Two things are therefore true and both are pinned:

    * the blast radius is bounded by the sender's own rooms -- a message can
      never reach another creator's, so this is a producer-correctness bug and
      not a cross-tenant one;
    * inside that radius the pairing IS the decision, which is why
      `test_the_primary_webhook_path_also_names_the_room` and the legacy-path
      equivalent exist: both producers derive `cm` from the recording's own
      meeting, and that is the only thing making the pairing right.

    What this asserts is ONLY the bound. An earlier revision asserted the
    `public` that today's code actually produces for the same-owner swap;
    codex was right that that is worse than saying nothing (HIGH): it turns a
    known access-control weakness into CI-ENFORCED required behaviour, so the
    obvious hardening -- fail closed on a pairing the consumer cannot
    corroborate -- would arrive to a red suite and look like the regression.
    A characterisation test may describe a gap; it must never make the gap
    load-bearing.

    So the exposure is written down here and NOT asserted, and closing it
    needs the recording's own room identity to be verifiable at ingest --
    an owner-scoped design decision that this PR does not take.
    """
    creator = creator_factory(username="same-owner-decoy")
    gated = _meeting(creator, SUBSCRIBERS_ONLY)
    decoy = _meeting(creator, BROADCAST)

    payload = queued(gated)
    assert payload["meeting_pk"] == gated.pk

    # Correctly paired: the gated room's own pk. This is the producer's
    # contract, and it is the half that is a guarantee.
    dlu.callback(_Message(payload))
    assert GenericFile.objects.get(owner=creator).access == "members"

    # The bound that DOES hold, stated exactly: a pk is resolved only against
    # the rooms of the creator NAMED ON THE SAME MESSAGE, so a swap of one
    # field alone resolves to nothing.
    #
    # That is weaker than "cross-tenant is impossible", and deliberately not
    # written that way (codex adversarial review, MEDIUM): `username` and
    # `meeting_pk` ride the same unauthenticated payload, so a producer
    # regression that swaps BOTH consistently would store creator A's
    # restricted recording publicly under creator B. Nothing ties the
    # provider's recording to the meeting it came from once the message is
    # built. Closing that needs an immutable recording-to-room association
    # persisted at webhook time -- production surgery on merged code, not a
    # test-file change, and so out of scope here and named in the PR body.
    #
    # Whether the same-owner swap to `decoy` resolves `public` (today) or
    # fails closed (after hardening) is deliberately left unpinned.
    stranger = creator_factory(username="same-owner-decoy-stranger")
    strangers_broadcast = _meeting(stranger, BROADCAST)
    assert dlu.resolve_recording_access(
        {"meeting_pk": strangers_broadcast.pk}, creator) == RESTRICTED
    assert dlu.resolve_recording_access(
        {"meeting_pk": decoy.pk}, stranger) == RESTRICTED


@pytest.mark.django_db
@pytest.mark.parametrize("meeting_type", sorted(EXPECTED_LEVEL))
@pytest.mark.parametrize("sessionless", [False, True])
def test_the_primary_webhook_path_also_names_the_room(
    creator_factory, mocker, download, meeting_type, sessionless,
):
    """The other producer call site, which nothing else touches.

    `_process_webhook_event` is the path RealtimeKit actually uses;
    `_process_legacy_recording_event` is the retained one. Both must pass
    `meeting_pk`, and neither had a test. A dropped keyword here is invisible:
    `publish_recording_ready` would raise `TypeError` inside a webhook handler
    -- returning a 500 to the provider on every finished recording -- and no
    test in the tree would notice.
    """
    creator = creator_factory(username="primary-webhook")
    provider_meeting_id = uuid.uuid4()
    meeting = CreatorMeeting.objects.create(
        creator=creator,
        meeting_id=str(provider_meeting_id),
        meeting_type=meeting_type,
        is_public=meeting_type != PRIVATE,
    )
    publisher = mocker.patch.object(outbox, "PubSubClient")
    now = datetime.now(dt_timezone.utc)
    event = WebhookEvent(
        event="recording.statusUpdate",
        meeting={
            "id": str(provider_meeting_id),
            **({} if sessionless else {"sessionId": str(uuid.uuid4())}),
            "title": "a stream",
            "status": "ENDED",
            "createdAt": now,
            **({} if sessionless else {"startedAt": now}),
            "organizedBy": {"id": str(uuid.uuid4()), "name": "free2z"},
        },
        recording={
            "id": str(uuid.uuid4()),
            "status": "UPLOADED",
            "downloadUrl": RECORDING_URL,
        },
    )

    dyte_views._process_webhook_event(
        event_data=event,
        cm=meeting,
        provider_event_id=uuid.uuid4(),
        payload=b"{}",
    )
    outbox.drain()

    payload = publisher.return_value.publish.call_args.args[1]
    assert payload["meeting_pk"] == meeting.pk
    assert payload["username"] == creator.username
    assert payload["creator_id"] == creator.pk

    message = _Message(payload)
    dlu.callback(message)
    assert message.acked is True
    stored = GenericFile.objects.get(owner=creator)
    assert stored.access == EXPECTED_LEVEL[meeting_type]
    if EXPECTED_LEVEL[meeting_type] != "public":
        assert not stored.get_url().startswith("/uploadz/public/")


@pytest.mark.django_db
@pytest.mark.parametrize("mutate,why", [
    (lambda p: p.pop("meeting_pk"),
     "a message published before the field existed (rollout backlog)"),
    (lambda p: p.update(meeting_pk=None),
     "a null identifier"),
    (lambda p: p.update(meeting_pk="not-a-number"),
     "a non-numeric identifier"),
    (lambda p: p.update(meeting_pk={"nested": "object"}),
     "an identifier that is not a scalar at all"),
    (lambda p: p.update(meeting_pk=0),
     "a zero pk, which no row has"),
    (lambda p: p.update(meeting_pk=2 ** 40),
     "a pk past int4 (an empty result, not a driver error -- measured)"),
    (lambda p: p.update(meeting_pk=2 ** 63),
     "one above the PostgreSQL bigint upper bound"),
    (lambda p: p.update(meeting_pk=-1),
     "a negative pk"),
    (lambda p: p.update(meeting_pk=p["meeting_pk"] + 10_000),
     "a room deleted between the stream and the ingest"),
])
def test_a_recording_it_cannot_attribute_to_a_room_is_private(
    creator_factory, download, queued, mutate, why,
):
    """Fail closed, every time -- and ACK, never NACK.

    Two claims, and the ack half is the one that bites at 3am. The resolution
    runs AFTER the (up to 15 minute) provider download and AFTER the
    object-storage upload of up to `DYTE_RECORDING_MAX_BYTES`. An identifier
    that raises there rather than resolving would reach `catch_errors`, NACK,
    and -- with `max_messages=1` -- redo the whole multi-gigabyte transfer
    forever while holding this subscriber's only flow-control slot. So each
    case asserts the message was acked, not merely that the level was safe.

    The `broadcast` room here is the adversarial choice: it is the ONE type
    that maps to `public`, so a fallback of "whatever we last saw" or "the
    model default" comes back public and turns this red.
    """
    creator = creator_factory(username="unattributable")
    meeting = _meeting(creator, BROADCAST)

    payload = queued(meeting)
    mutate(payload)

    message = _Message(payload)
    dlu.callback(message)

    assert message.acked is True, why
    assert message.nacked is False, why
    assert GenericFile.objects.get(owner=creator).access == RESTRICTED, why
    assert RecordingDelivery.objects.get().meeting_pk is None, why


@pytest.mark.django_db
def test_a_meeting_belonging_to_someone_else_is_not_borrowed(
    creator_factory, download, queued,
):
    """The lookup is scoped to the creator named on the message.

    Without that scope, a message pairing one creator's username with another
    creator's `broadcast` room would publish a private recording -- an id
    proves nothing about whose room it names. Driven through the consumer, not
    the resolver, because the scoping only helps if the consumer is what
    passes the creator in.
    """
    victim = creator_factory(username="scoped-victim")
    stranger = creator_factory(username="scoped-stranger")
    _meeting(victim, PRIVATE, is_public=False)
    strangers_broadcast = _meeting(stranger, BROADCAST)

    payload = queued(strangers_broadcast)
    # The message names the victim: by account id now (the owner key), and
    # by username for consumers that predate it.
    payload["creator_id"] = victim.pk
    payload["username"] = victim.username

    dlu.callback(_Message(payload))

    assert not GenericFile.objects.filter(owner=stranger).exists()
    assert GenericFile.objects.get(owner=victim).access == RESTRICTED


@pytest.mark.django_db
def test_a_non_public_room_never_resolves_above_private(
    creator_factory, download, queued,
):
    """`unique_together` permits a `(creator, broadcast, is_public=False)` row.

    No route creates one, and if one ever appears it is not a room the public
    could join -- so its recording is not one we may publish, whatever its
    `meeting_type` says. The positive control on the line above is the point:
    the same room at `is_public=True` DOES come back public, so this is not
    passing because the lookup is broken.
    """
    creator = creator_factory(username="not-public")
    meeting = _meeting(creator, BROADCAST, is_public=True)
    payload = queued(meeting)

    dlu.callback(_Message(payload))
    assert GenericFile.objects.get(owner=creator).access == "public"

    GenericFile.objects.all().delete()
    RecordingDelivery.objects.all().delete()
    CreatorMeeting.objects.filter(pk=meeting.pk).update(is_public=False)

    dlu.callback(_Message(queued(meeting)))
    assert GenericFile.objects.get(owner=creator).access == RESTRICTED


@pytest.mark.django_db
def test_an_off_enum_meeting_type_resolves_to_private(
    creator_factory, download, queued,
):
    """`choices` is only enforced by `full_clean()`, which the API never calls.

    Rows predating  really do hold values outside the enum. An audience we
    do not recognise is not one we publish to.
    """
    creator = creator_factory(username="off-enum")
    meeting = _meeting(creator, BROADCAST)
    payload = queued(meeting)
    # `meeting_type` is varchar(20), so an off-enum value has to fit in it --
    # a longer one raises DataError from the fixture instead of exercising the
    # resolver, which would look like a pass for the wrong reason.
    assert "watch-party" not in MEETING_TYPES
    CreatorMeeting.objects.filter(pk=meeting.pk).update(
        meeting_type="watch-party")

    dlu.callback(_Message(payload))

    assert GenericFile.objects.get(owner=creator).access == RESTRICTED


@pytest.mark.django_db
def test_a_boolean_meeting_pk_does_not_read_as_row_one(creator_factory):
    """`isinstance(True, int)` is True, and `pk=True` queries as `pk=1`.

    A JSON `true` in the identifier slot would otherwise silently resolve to
    whichever room happens to be row one -- someone else's, at whatever level
    it has. Pinned with pk=1 ACTUALLY POPULATED, and with its own positive
    control on the line above, because the obvious version of this assertion
    passes for the boring reason that no room has pk 1.
    """
    creator = creator_factory(username="bool-pk")
    CreatorMeeting.objects.create(
        pk=1, creator=creator, meeting_id="mtg-row-one",
        meeting_type=BROADCAST, is_public=True,
    )

    assert dlu.resolve_recording_access({"meeting_pk": 1}, creator) == "public"
    assert dlu.resolve_recording_access(
        {"meeting_pk": True}, creator) == RESTRICTED


# --------------------------------------------------------------------------
# redelivery, lease takeover
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_a_redelivery_never_relevels_a_recording_the_owner_changed(
    creator_factory, download, queued,
):
    """One canonical asset, one level, owned by the OWNER.

    This command runs under a lease with redelivery, so the same message can
    arrive again long after it succeeded -- by which time the creator may have
    changed the level deliberately. A completed `RecordingDelivery` is
    terminal: the redelivery is acked and nothing is written, so the ingest
    level is a starting point and never an override.

    TWO independent guards enforce that -- the `claim_result == 'completed'`
    early return, and the `delivery.completed_at is not None` re-check inside
    the commit transaction -- and a negative control that removes only the
    first one still passes, because the second catches it. That is a fine
    property for production and a trap for a test: an assertion satisfied by
    either guard cannot tell you when one of them is gone. So the download
    count is asserted too. It pins the early return specifically: a redelivery
    must not re-fetch the recording at all, let alone re-level it.
    """
    creator = creator_factory(username="redelivered")
    meeting = _meeting(creator, SUBSCRIBERS_ONLY)
    payload = queued(meeting)

    dlu.callback(_Message(payload))
    stored = GenericFile.objects.get(owner=creator)
    assert stored.access == "members"

    # The creator publishes it on purpose.
    stored.access = "public"
    stored.save(update_fields=["access"])

    again = _Message(payload)
    dlu.callback(again)

    assert again.acked is True
    # Guard one: the completed claim short-circuits before any outbound
    # request. Without this the assertions below pass on the second guard.
    assert download.call_count == 1
    # Guard two: one row, still at the level its owner chose.
    assert GenericFile.objects.filter(owner=creator).count() == 1
    stored.refresh_from_db()
    assert stored.access == "public"
    assert RecordingDelivery.objects.count() == 1


@pytest.mark.django_db
def test_a_lease_taken_over_leaves_no_row_at_any_level(
    creator_factory, download, queued,
):
    """A losing attempt must not leave a differently-levelled row behind.

    Two attempts at the same recording each build their own `GenericFile` and
    their own storage object; only the lease holder commits. Pin that the
    loser commits NOTHING -- the hazard being a half-finished attempt that
    lands a row the winner then duplicates, which is exactly the "second row
    at a different level"  forbids.

    The retry that follows is the same message resolving the same meeting, so
    it cannot produce a different level than the attempt it replaced. The only
    way two attempts at one recording ever disagree is when one of them could
    not identify the meeting at all -- and that one is `private`, so a retry
    can never come out LOOSER than the meeting's real audience.
    """
    creator = creator_factory(username="lease-takeover")
    meeting = _meeting(creator, SUBSCRIBERS_ONLY)
    payload = queued(meeting)

    with mock.patch.object(
        dlu, "renew_recording_claim", return_value=False,
    ) as stolen:
        lost = _Message(payload)
        dlu.callback(lost)

    stolen.assert_called_once()
    assert lost.acked is True
    assert not GenericFile.objects.filter(owner=creator).exists()

    # The recording is still ingestable, at the meeting's level, once a lease
    # is held again.
    RecordingDelivery.objects.update(lease_token=None, lease_expires_at=None)
    dlu.callback(_Message(payload))
    assert GenericFile.objects.get(owner=creator).access == "members"


# --------------------------------------------------------------------------
# the identifier has to survive what actually happens to a room
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_the_provider_meeting_id_rotating_does_not_orphan_the_recording(
    creator_factory, download, queued,
):
    """The identifier on the wire is OUR pk, not the provider's `meeting_id`.

    `_create_meeting()` overwrites `CreatorMeeting.meeting_id` on the EXISTING
    row -- every go-live in a room whose row is over a day old, and again on a
    provider error retry. So the provider's id is not a durable handle on the
    room: a recording queued behind a long download while its creator starts
    the next session would resolve to nothing and land `private`.

    That fails closed, which is why it would not be a leak -- and it would
    still be a regression a creator feels, because a BROADCAST recording would
    silently go owner-only. Nothing rotates the row's primary key.
    """
    creator = creator_factory(username="rotating-room")
    meeting = _meeting(creator, BROADCAST)
    payload = queued(meeting)

    # The creator goes live again; the provider issues a new meeting id.
    CreatorMeeting.objects.filter(pk=meeting.pk).update(
        meeting_id="mtg-rotated-by-the-provider")

    dlu.callback(_Message(payload))

    assert GenericFile.objects.get(owner=creator).access == "public"


@pytest.mark.django_db
def test_a_room_restricted_during_the_download_is_honoured(
    creator_factory, queued, mocker,
):
    """`meeting_type` is admin-editable and a recording downloads for minutes.

    A level resolved BEFORE the download would publish a room an operator
    restricted during it -- the exact window in which someone is most likely
    to be restricting it. So the level is read immediately before the row is
    committed. The stub below flips the room while the response body is being
    consumed, which is the real ordering: bytes first, level second.
    """
    creator = creator_factory(username="restricted-mid-download")
    meeting = _meeting(creator, BROADCAST)
    payload = queued(meeting)

    class _RestrictingResp(_Resp):
        def iter_content(self, chunk_size=8192):
            yield b"video-"
            CreatorMeeting.objects.filter(pk=meeting.pk).update(
                meeting_type=SUBSCRIBERS_ONLY)
            yield b"bytes"

    mocker.patch.object(dlu.requests, "get", return_value=_RestrictingResp())

    dlu.callback(_Message(payload))

    assert GenericFile.objects.get(owner=creator).access == "members"


@pytest.mark.django_db
def test_a_room_restricted_during_the_object_storage_upload_is_honoured(
    creator_factory, download, queued, mocker,
):
    """The window after the download is unbounded, and this pins it shut.

    Resolving after the provider download closes the long (15 minute,
    `DYTE_RECORDING_TOTAL_TIMEOUT_SECONDS`) window but not the next one:
    pushing up to `DYTE_RECORDING_MAX_BYTES` (2 GiB) into object storage is
    bounded by no timeout at all, and a level read before it commits minutes
    stale -- stale in the PUBLISHING direction.

    `test_a_room_restricted_during_the_download_is_honoured` does not cover
    this: it mutates during `iter_content`, which is before the row object
    exists either way, so it stays green with the resolution moved back into
    the `GenericFile(...)` constructor.

    The seam is `storage.save()` ITSELF -- the call that does the upload --
    not `limit_filename_length` immediately before it (codex adversarial
    review, MEDIUM). Hooking the filename helper would pin only
    "resolved after the name was computed", leaving a refactor that resolves
    between the name and the minutes-long GCS upload green while production
    commits a stale `public`. The mutation has to happen INSIDE the window
    being claimed, so it is raised from the storage backend's own `save`.
    """
    creator = creator_factory(username="restricted-mid-upload")
    meeting = _meeting(creator, BROADCAST)
    payload = queued(meeting)

    real_save = FileSystemStorage._save
    fired = []

    def _restrict_mid_upload(self, name, content):
        # We are now inside the upload itself -- this call is what writes the
        # bytes -- so a level resolved at any point before this line is
        # already stale.
        fired.append(name)
        CreatorMeeting.objects.filter(pk=meeting.pk).update(
            meeting_type=SUBSCRIBERS_ONLY)
        return real_save(self, name, content)

    mocker.patch.object(FileSystemStorage, "_save", _restrict_mid_upload)

    dlu.callback(_Message(payload))

    # A hook that never ran would make this test pass by doing nothing.
    assert fired, "the storage upload seam was never reached"
    assert GenericFile.objects.get(owner=creator).access == "members"


@pytest.mark.django_db
@pytest.mark.parametrize("raw,why", [
    ("²", "a superscript two: `isdigit()` says yes, `int()` raises"),
    ("༢", "a Tibetan digit: same trap, different script"),
    ("1" * 5000, "past CPython's int-conversion length limit"),
    ("12.0", "a float-looking identifier"),
    ("  ", "whitespace"),
])
def test_a_parseable_looking_meeting_pk_still_fails_closed(
    creator_factory, download, queued, raw, why,
):
    """"A malformed identifier fails closed" has to hold for EVERY malformed one.

    `str.isdigit()` is not `int()`. `"²".isdigit()` is True and
    `int("²")` raises `ValueError`, and so does a long-enough digit
    string. A guard written as `isdigit()` then `int()` would raise from the
    resolution -- which runs after the download AND the object-storage
    upload -- so `catch_errors` would NACK, and with `max_messages=1` that one
    message would redo a multi-gigabyte transfer forever while holding this
    subscriber's only slot.

    Today's resolver rejects every string outright, which is why these are
    safe; this pins that the tempting "accept numeric-looking strings too"
    relaxation cannot be added without handling these. A `broadcast` room
    again, so a fallback that is anything but the safe level shows up as
    `public`.
    """
    creator = creator_factory(username=f"unparseable-{abs(hash(raw)) % 10000}")
    meeting = _meeting(creator, BROADCAST)
    payload = queued(meeting)
    payload["meeting_pk"] = raw

    message = _Message(payload)
    dlu.callback(message)

    assert message.acked is True, why
    assert message.nacked is False, why
    assert GenericFile.objects.get(owner=creator).access == RESTRICTED, why


# --------------------------------------------------------------------------
# mixed versions -- the window the owner named when closing
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_a_mixed_version_message_is_terminal_at_the_level_it_landed(
    creator_factory, download, queued,
):
    """The ingest level is ONE-SHOT. Nothing self-heals it, in either direction.

     was closed as a release blocker over the new-producer ->
    old-consumer window: an old subscriber ignores `meeting_pk`, stores a
    gated recording `public`, and **completes the idempotency receipt
    permanently** -- so no redelivery ever revisits it and the leak is
    unrecoverable.  made that window unreachable in the deploy path
    (`bin/bazel-apply.sh` applies the subscriber and gates the rest of the
    deploy on its rollout, with `bin/test-bazel-apply.sh` covering the abort),
    and that ordering is on `main`; nothing here re-litigates it.

    What no test anywhere pins is the PROPERTY that made the window fatal
    rather than merely wrong: receipt terminality. It is still live, and it
    still cuts in the direction mixed versions can actually produce today --
    an OLD producer reaching a NEW consumer, which is what a rollback or a
    Pub/Sub backlog drained after the deploy looks like. That message carries
    no `meeting_pk`, so it lands `private` (safe) and completes the receipt
    (permanent). A later, perfectly-formed redelivery of the same recording
    does NOT correct it.

    Asserted in the SAFE direction because that is the direction the current
    code can produce; the mechanism is identical either way, which is exactly
    why the level has to be right the first time. `private` is one click for
    the owner to undo, which is the whole reason `private` is the fallback.
    """
    creator = creator_factory(username="mixed-version")
    meeting = _meeting(creator, BROADCAST)

    # Phase one: the old producer's payload shape -- no meeting_pk at all.
    old_payload = queued(meeting)
    del old_payload["meeting_pk"]
    dlu.callback(_Message(old_payload))

    stored = GenericFile.objects.get(owner=creator)
    assert stored.access == RESTRICTED
    receipt = RecordingDelivery.objects.get()
    assert receipt.completed_at is not None, (
        "the receipt must be complete; if it were not, redelivery would "
        "self-heal and this whole hazard would not exist"
    )

    # Phase two: the same recording redelivered by a converged producer,
    # naming a room that maps to `public`.
    fixed_payload = dict(old_payload, meeting_pk=meeting.pk)
    redelivered = _Message(fixed_payload)
    dlu.callback(redelivered)

    assert redelivered.acked is True
    assert download.call_count == 1, (
        "the completed receipt must short-circuit before any outbound request"
    )
    assert GenericFile.objects.filter(owner=creator).count() == 1
    stored.refresh_from_db()
    assert stored.access == RESTRICTED, (
        "the receipt is terminal: a redelivery cannot re-level the row. The "
        "same terminality is what made the #1491 leak unrecoverable."
    )
