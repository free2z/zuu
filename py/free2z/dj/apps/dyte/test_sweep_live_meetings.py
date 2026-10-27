"""
Tests for the live-meeting self-heal (#ZUULI stale "live now" list).

Two units under test, both against real Postgres (same conventions as the
g12f task tests: tasks exercised as plain callables, the provider boundary
mocked, the DB is real):

- DyteClient.get_participants_count: a provider 404 on /active-session is
  the documented "no session running" answer and must read as a confirmed
  zero; only real failures (401/403/5xx) may raise.
- dyte.sweep_live_meetings: a confirmed zero clears live_now; a positive
  count refreshes last_seen_at and keeps live_now; a provider API error
  leaves a recently-seen room unchanged but stale-clears one nobody has
  been seen in for DYTE_LIVE_STALE_CLEAR_SECONDS; a just-went-live room
  inside the grace window is not cleared on a zero count; the sweep logs
  exactly one aggregated line per run.
- live_meeting_status: a provider error or idle-room 404 returns 200, never
  a 500.
- PublicMeetingViewSet queryset: shows only public, live_now, recently-seen
  rooms — hiding rooms cleared by the sweep and rooms whose last_seen_at has
  gone stale (stalled worker), without hiding a just-went-live room.
"""
import logging
from datetime import timedelta

import pytest
import requests
from django.conf import settings
from django.urls import reverse
from django.utils import timezone

from dj.apps.dyte.client import DyteClient
from dj.apps.dyte.models import CreatorMeeting
from dj.apps.dyte.tasks import sweep_live_meetings


def _make_meeting(creator, meeting_id, **kwargs):
    defaults = dict(
        creator=creator,
        meeting_id=meeting_id,
        meeting_type="broadcast",
        is_public=True,
        live_now=True,
        last_seen_at=timezone.now() - timedelta(hours=1),
    )
    defaults.update(kwargs)
    return CreatorMeeting.objects.create(**defaults)


def _rows(resp):
    """The public list may be paginated ({results: [...]}) or a bare list."""
    data = resp.json()
    return data["results"] if isinstance(data, dict) else data


def _patch_count(mocker, side_effect=None, return_value=None):
    """Patch the provider probe used inside the sweep."""
    m = mocker.patch(
        "dj.apps.dyte.client.DyteClient.get_participants_count",
        autospec=True,
    )
    if side_effect is not None:
        m.side_effect = side_effect
    else:
        m.return_value = return_value
    return m


@pytest.mark.django_db
def test_zero_count_clears_live_now(mocker, creator_factory):
    creator = creator_factory()
    cm = _make_meeting(creator, "zero-count-1")
    _patch_count(mocker, return_value=0)

    sweep_live_meetings(0)

    cm.refresh_from_db()
    assert cm.live_now is False


@pytest.mark.django_db
def test_positive_count_refreshes_last_seen_and_keeps_live(
    mocker, creator_factory
):
    creator = creator_factory()
    stale = timezone.now() - timedelta(hours=1)
    cm = _make_meeting(creator, "positive-count-1", last_seen_at=stale)
    _patch_count(mocker, return_value=3)

    sweep_live_meetings(0)

    cm.refresh_from_db()
    assert cm.live_now is True
    assert cm.last_seen_at > stale


@pytest.mark.django_db
def test_api_error_leaves_live_now_unchanged(mocker, creator_factory):
    creator = creator_factory()
    # Seen recently: not stale, so the safety valve must not fire.
    cm = _make_meeting(
        creator, "api-error-1", last_seen_at=timezone.now() - timedelta(seconds=5)
    )
    _patch_count(mocker, side_effect=Exception("provider 503"))

    sweep_live_meetings(0)

    cm.refresh_from_db()
    # Transient error must NOT be read as a confirmed zero.
    assert cm.live_now is True


@pytest.mark.django_db
def test_persistent_api_error_clears_stale_live_now(mocker, creator_factory):
    """Safety valve: an unreachable provider must not pin a room live forever."""
    creator = creator_factory()
    stale = timezone.now() - timedelta(
        seconds=settings.DYTE_LIVE_STALE_CLEAR_SECONDS + 60)
    cm = _make_meeting(creator, "stale-error-1", last_seen_at=stale)
    _patch_count(mocker, side_effect=Exception("provider unreachable"))

    sweep_live_meetings(0)

    cm.refresh_from_db()
    assert cm.live_now is False


@pytest.mark.django_db
def test_api_error_clears_live_now_when_never_seen(mocker, creator_factory):
    """last_seen_at=None (pre-migration row) counts as stale, not as fresh."""
    creator = creator_factory()
    cm = _make_meeting(creator, "stale-error-null", last_seen_at=None)
    _patch_count(mocker, side_effect=Exception("provider unreachable"))

    sweep_live_meetings(0)

    cm.refresh_from_db()
    assert cm.live_now is False


@pytest.mark.django_db
def test_zero_count_within_grace_is_not_cleared(mocker, creator_factory):
    creator = creator_factory()
    # Just went live: seen well within the grace window.
    fresh = timezone.now() - timedelta(
        seconds=settings.DYTE_LIVE_SWEEP_GRACE_SECONDS // 2)
    cm = _make_meeting(creator, "grace-1", last_seen_at=fresh)
    _patch_count(mocker, return_value=0)

    sweep_live_meetings(0)

    cm.refresh_from_db()
    assert cm.live_now is True


@pytest.mark.django_db
def test_error_does_not_abort_remaining_rooms(mocker, creator_factory):
    creator = creator_factory()
    # Recently seen, so the error room is left alone rather than stale-cleared.
    bad = _make_meeting(
        creator, "iso-bad", meeting_type="broadcast",
        last_seen_at=timezone.now() - timedelta(seconds=5),
    )
    good = _make_meeting(creator, "iso-good", meeting_type="ppv")

    def by_meeting(self, meeting_id):
        if meeting_id == bad.meeting_id:
            raise Exception("boom")
        return 0

    mocker.patch(
        "dj.apps.dyte.client.DyteClient.get_participants_count",
        autospec=True,
        side_effect=by_meeting,
    )

    sweep_live_meetings(0)

    bad.refresh_from_db()
    good.refresh_from_db()
    assert bad.live_now is True           # error room untouched
    assert good.live_now is False         # sweep continued past the error


class _FakeResponse:
    """Minimal stand-in for requests.Response."""

    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(
                f"{self.status_code} Client Error", response=self)


def test_client_treats_404_as_zero_participants(mocker):
    """
    Regression: Cloudflare RealtimeKit answers /active-session with 404
    ("No active session found for meeting id: ...") for every idle room.
    That is a confirmed zero, not a failure — raising here made the sweep
    treat the normal case as an error and never clear live_now.
    """
    mocker.patch(
        "dj.apps.dyte.client.requests.get",
        return_value=_FakeResponse(404, {
            "success": False,
            "error": {"code": 404, "message": "No active session found"},
        }),
    )

    assert DyteClient("org").get_participants_count("m-404") == 0


def test_client_returns_live_participants_on_200(mocker):
    mocker.patch(
        "dj.apps.dyte.client.requests.get",
        return_value=_FakeResponse(200, {
            "success": True, "data": {"live_participants": 4},
        }),
    )

    assert DyteClient("org").get_participants_count("m-200") == 4


@pytest.mark.parametrize("status_code", [401, 403, 500, 502])
def test_client_raises_on_real_failures(mocker, status_code):
    """Auth/provider failures must stay distinguishable from an empty room."""
    mocker.patch(
        "dj.apps.dyte.client.requests.get",
        return_value=_FakeResponse(status_code, {"success": False}),
    )

    with pytest.raises(requests.HTTPError):
        DyteClient("org").get_participants_count("m-boom")


@pytest.mark.django_db
def test_sweep_clears_live_now_on_provider_404(mocker, creator_factory):
    """End-to-end regression for the prod bug, through the real client."""
    creator = creator_factory()
    cm = _make_meeting(creator, "e2e-404")
    mocker.patch(
        "dj.apps.dyte.client.requests.get",
        return_value=_FakeResponse(404, {
            "success": False,
            "error": {"code": 404, "message": "No active session found"},
        }),
    )

    sweep_live_meetings(0)

    cm.refresh_from_db()
    assert cm.live_now is False


@pytest.mark.django_db
def test_sweep_logs_one_aggregated_line(mocker, creator_factory, caplog):
    """No per-room log spam: one summary line per sweep, even on failure."""
    creator = creator_factory()
    for i, mtype in enumerate(["broadcast", "ppv", "subscribers-only"]):
        _make_meeting(
            creator, f"noise-{i}", meeting_type=mtype,
            last_seen_at=timezone.now() - timedelta(seconds=5),
        )
    _patch_count(mocker, side_effect=Exception("provider 503"))

    with caplog.at_level(logging.DEBUG, logger="dj.apps.dyte.tasks"):
        sweep_live_meetings(0)

    records = [r for r in caplog.records if r.name == "dj.apps.dyte.tasks"]
    assert len(records) == 1
    assert records[0].levelno == logging.WARNING
    assert "checked=3" in records[0].getMessage()
    assert "errors=3" in records[0].getMessage()


@pytest.mark.django_db
def test_sweep_success_logs_at_info_not_warning(mocker, creator_factory, caplog):
    creator = creator_factory()
    _make_meeting(creator, "quiet-1")
    _patch_count(mocker, return_value=0)

    with caplog.at_level(logging.DEBUG, logger="dj.apps.dyte.tasks"):
        sweep_live_meetings(0)

    records = [r for r in caplog.records if r.name == "dj.apps.dyte.tasks"]
    assert [r.levelno for r in records] == [logging.INFO]


@pytest.mark.django_db
def test_live_status_does_not_500_on_provider_error(
    mocker, api_client, creator_factory
):
    """A provider hiccup must not 500 a public, bot-crawled endpoint."""
    creator = creator_factory()
    _make_meeting(creator, "live-status-boom")
    _patch_count(mocker, side_effect=Exception("provider 503"))

    resp = api_client.get(
        reverse("live_meeting_status", args=[creator.username]))

    assert resp.status_code == 200
    assert resp.json() == {}


@pytest.mark.django_db
def test_live_status_reports_idle_room_as_not_live(
    mocker, api_client, creator_factory
):
    """404 from the provider (idle room) -> empty response, not a 500."""
    creator = creator_factory()
    _make_meeting(creator, "live-status-404")
    mocker.patch(
        "dj.apps.dyte.client.requests.get",
        return_value=_FakeResponse(404, {"success": False}),
    )

    resp = api_client.get(
        reverse("live_meeting_status", args=[creator.username]))

    assert resp.status_code == 200
    assert resp.json() == {}


@pytest.mark.django_db
def test_public_list_shows_live_recent_only(api_client, creator_factory):
    creator = creator_factory()
    now = timezone.now()
    _make_meeting(
        creator, "pub-live", meeting_type="broadcast",
        live_now=True, last_seen_at=now,
    )
    _make_meeting(
        creator, "pub-offline", meeting_type="ppv",
        live_now=False, last_seen_at=now,
    )
    _make_meeting(
        creator, "pub-stale", meeting_type="subscribers-only",
        live_now=True,
        last_seen_at=now - timedelta(
            seconds=settings.DYTE_LIVE_LAST_SEEN_TTL_SECONDS + 60),
    )

    resp = api_client.get(reverse("public-meeting-discovery"))

    assert resp.status_code == 200
    usernames = {row["username"] for row in _rows(resp)}
    assert usernames == {creator.username}


@pytest.mark.django_db
def test_public_list_shows_just_went_live_room(api_client, creator_factory):
    creator = creator_factory()
    # Go-live stamps last_seen_at=now; must be visible before the first sweep.
    _make_meeting(
        creator, "pub-fresh", live_now=True, last_seen_at=timezone.now(),
    )

    resp = api_client.get(reverse("public-meeting-discovery"))

    assert resp.status_code == 200
    usernames = {row["username"] for row in _rows(resp)}
    assert creator.username in usernames


@pytest.mark.django_db
def test_deactivated_creator_is_absent_from_live_list_and_status(
    api_client, creator_factory, mocker,
):
    creator = creator_factory()
    _make_meeting(
        creator, "inactive-public-room", last_seen_at=timezone.now(),
    )
    creator.is_active = False
    creator.save(update_fields=["is_active"])
    probe = mocker.patch(
        "dj.apps.dyte.client.DyteClient.get_participants_count",
        return_value=3,
    )

    listed = api_client.get(reverse("public-meeting-discovery"))
    status_response = api_client.get(
        reverse("live_meeting_status", args=[creator.username])
    )

    assert listed.status_code == 200
    assert not any(
        row["username"] == creator.username for row in _rows(listed)
    )
    assert status_response.status_code == 200
    assert status_response.json() == {}
    probe.assert_not_called()
