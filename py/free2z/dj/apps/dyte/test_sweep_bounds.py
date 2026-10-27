"""
Bounds on the live-meeting sweep.

Two independent bounds, tested independently because they fail
independently:

1. DyteClient's outbound calls carry a (connect, read) timeout. Proven
   against a REAL socket that accepts the connection and then never says
   anything -- the exact shape that pins a thread forever, and the one
   thing a mocked `requests` can never demonstrate.
2. dyte.sweep_live_meetings has its own wall clock. The per-call timeout
   multiplies by the room count, and the task is periodic every minute on
   the catch-all `default` queue, so arithmetic over (1) is not a bound on
   the tick.
"""
import socket
import threading
import time
from datetime import timedelta

import pytest
import requests
from django.core.cache import cache
from django.test import override_settings
from django.utils import timezone

from dj.apps.dyte.client import DyteClient
from dj.apps.dyte.models import CreatorMeeting
from dj.apps.dyte.tasks import sweep_live_meetings
from dj.apps.g12f.models.creator import Creator
from dj.apps.dyte.tasks import _cursor_key


@pytest.fixture(autouse=True)
def _clean_probe_cursor():
    """The round-robin cursor lives in the cache, which LocMemCache keeps
    for the life of the pytest process. Every test here asserts on probe
    ORDER, so each must start from a known cursor."""
    cache.delete(_cursor_key())
    yield
    cache.delete(_cursor_key())


def _live_rooms(prefix, seen_at):
    """One live public broadcast room per creator.

    CreatorMeeting is unique on (creator, meeting_type, is_public), so a
    fleet of rooms needs a fleet of creators. Built with bulk_create rather
    than the factory: the factory hashes a password per creator, which is
    tens of milliseconds each and would dominate a test about wall clocks.
    """
    creators = Creator.objects.bulk_create([
        Creator(username=f"{prefix}-owner-{i:03d}")
        for i in range(len(seen_at))
    ])
    return CreatorMeeting.objects.bulk_create([
        CreatorMeeting(
            creator=creator,
            meeting_id=f"{prefix}-{i:03d}",
            meeting_type="broadcast",
            is_public=True,
            live_now=True,
            last_seen_at=seen,
        )
        for i, (creator, seen) in enumerate(zip(creators, seen_at))
    ])


@pytest.fixture
def blackhole():
    """A listener that ACCEPTS and then never responds.

    Not a closed port (that fails instantly with ECONNREFUSED and would
    make the timeout test pass for the wrong reason) and not a slow
    responder: the connection completes, so `requests` moves on to the
    READ, and without a read timeout it blocks there forever.
    """
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    server.listen(8)
    host, port = server.getsockname()
    held = []
    stop = threading.Event()

    def _accept():
        server.settimeout(0.2)
        while not stop.is_set():
            try:
                conn, _ = server.accept()
            except (socket.timeout, OSError):
                continue
            # Hold the connection open and say NOTHING.
            held.append(conn)

    thread = threading.Thread(target=_accept, daemon=True)
    thread.start()
    try:
        yield f"http://{host}:{port}"
    finally:
        stop.set()
        thread.join(timeout=5)
        for conn in held:
            try:
                conn.close()
            except OSError:
                pass
        server.close()


def _call_with_watchdog(fn, watchdog_seconds):
    """Run `fn` on a daemon thread; report whether it ever returned.

    A missing timeout does not make this test FAIL, it makes it HANG --
    and a hang in CI is a 35-minute cap failure that looks like anything
    but a missing timeout. Running the call on a daemon thread turns
    "never returned" into a clean, immediate assertion. (pytest-timeout is
    not in py/requirements/test.txt, so this is the same control without a
    new dependency.)
    """
    box = {}

    def _run():
        started = time.monotonic()
        try:
            box["value"] = fn()
        except BaseException as exc:  # noqa: BLE001 - reporting, not handling
            box["error"] = exc
        box["elapsed"] = time.monotonic() - started

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    thread.join(timeout=watchdog_seconds)
    return (not thread.is_alive()), box


@pytest.mark.django_db
@override_settings(
    DYTE_CONNECT_TIMEOUT_SECONDS=2.0,
    DYTE_READ_TIMEOUT_SECONDS=1.0,
    DYTE_ORG="test-org",
    DYTE_KEY="test-key",
)
def test_get_participants_count_gives_up_on_a_socket_that_never_answers(
    blackhole,
):
    """The probe RAISES inside the read timeout instead of hanging.

    Raising (rather than returning 0) is load-bearing: the sweep treats 0
    as a CONFIRMED empty room and clears live_now on it, so a timeout must
    never be able to masquerade as "nobody is here".
    """
    client = DyteClient("test-org")
    with override_settings(RTK_API_BASE_URL=blackhole):
        returned, box = _call_with_watchdog(
            lambda: client.get_participants_count("some-meeting-id"),
            watchdog_seconds=15,
        )

    assert returned, (
        "get_participants_count never returned: the outbound requests.get "
        "has no timeout, so this call would pin its worker forever"
    )
    assert "value" not in box, (
        f"a timed-out probe must raise, not return {box.get('value')!r} -- "
        "the sweep reads 0 as a confirmed-empty room and clears live_now"
    )
    assert isinstance(box["error"], requests.exceptions.RequestException)
    # The read timeout is 1s; anything under a few seconds proves the bound
    # fired rather than something else ending the call.
    assert box["elapsed"] < 10, box["elapsed"]


@pytest.mark.django_db
@override_settings(DYTE_LIVE_SWEEP_BUDGET_SECONDS=0.25, DYTE_ORG="test-org")
def test_the_sweep_stops_at_its_budget_and_reports_the_rooms_it_skipped(
    mocker, caplog,
):
    """50 live rooms, a slow provider, one budgeted tick.

    The tick must end near its budget -- not at 50 x per-probe-cost -- and
    must SAY how many rooms it did not reach. Unreached rooms are skipped,
    never cleared: the sweep has no evidence about them.
    """
    caplog.set_level('INFO', logger='dj.apps.dyte.tasks')
    seen = timezone.now() - timedelta(hours=1)
    _live_rooms("meeting", [seen + timedelta(seconds=i) for i in range(50)])

    def _slow_probe(self, meeting_id):
        time.sleep(0.02)
        return 1

    probe = mocker.patch(
        "dj.apps.dyte.client.DyteClient.get_participants_count",
        autospec=True, side_effect=_slow_probe,
    )

    started = time.monotonic()
    sweep_live_meetings(timestamp=0)
    elapsed = time.monotonic() - started

    # The budget bounds when the sweep stops STARTING work, so the true
    # wall clock is budget + at most one probe. 5s is enormous slack over
    # 0.25 + 0.02 and still an order of magnitude under 50 x 0.02 = 1s...
    # which is why the room count, not the clock, is the real assertion.
    assert elapsed < 5, elapsed
    assert probe.call_count < 50, (
        f"the sweep probed {probe.call_count}/50 rooms despite a "
        f"0.25s budget: it has no wall clock"
    )

    line = [r.getMessage() for r in caplog.records
            if 'sweep_live_meetings:' in r.getMessage()]
    assert len(line) == 1, line
    skipped = 50 - probe.call_count
    assert f"checked={probe.call_count}" in line[0]
    assert f"skipped={skipped}" in line[0]
    assert skipped > 0

    # Skipping is not clearing: every unreached room is still live.
    assert CreatorMeeting.objects.filter(live_now=True).count() == 50


@pytest.mark.django_db
@override_settings(DYTE_LIVE_SWEEP_BUDGET_SECONDS=45.0, DYTE_ORG="test-org")
def test_a_sweep_inside_its_budget_still_probes_every_room(
    mocker, caplog,
):
    """Negative control for the budget: it must not skip when it need not.

    A bound that always fires is not a bound, it is a bug. With the real
    45s budget and a fast provider, all 5 rooms are probed and skipped=0.
    """
    caplog.set_level('INFO', logger='dj.apps.dyte.tasks')
    _live_rooms("fast", [timezone.now()] * 5)
    probe = mocker.patch(
        "dj.apps.dyte.client.DyteClient.get_participants_count",
        autospec=True, return_value=1,
    )

    sweep_live_meetings(timestamp=0)

    assert probe.call_count == 5
    line = [r.getMessage() for r in caplog.records
            if 'sweep_live_meetings:' in r.getMessage()]
    assert len(line) == 1
    assert "skipped=0" in line[0]


def _fake_clock(mocker, cost_per_probe):
    """A monotonic clock the probe advances, so budget tests are exact.

    A real clock makes these assertions a race: the sweep's own setup
    (query, model instantiation) takes an unpredictable slice of a small
    budget, so "exactly N probes" can be wrong on a loaded runner while the
    code is perfectly correct (codex adversarial review). Driving
    tasks.time.monotonic from the probe itself removes the runner from the
    experiment entirely.
    """
    clock = {"t": 0.0}
    mocker.patch("dj.apps.dyte.tasks.time.monotonic", lambda: clock["t"])

    def _advance():
        clock["t"] += cost_per_probe

    return _advance


@pytest.mark.django_db
@override_settings(DYTE_LIVE_SWEEP_BUDGET_SECONDS=25.0, DYTE_ORG="test-org")
def test_the_priority_slot_goes_to_the_least_recently_confirmed_room(mocker):
    """One reserved slot for the room needing a verdict, then round robin.

    The stalest room goes first whatever order the rows were created in;
    the rest of the budget walks the pk cycle from the stored cursor
    (unset here, so from the lowest pk).

    Deterministic clock: each probe costs 10 fake seconds against a 25s
    budget, so exactly three probes start. (A real clock would make this a
    race -- the sweep's own setup takes an unpredictable slice of a small
    budget -- which is a test that can fail on a loaded runner while the
    code is correct.)
    """
    now = timezone.now()
    # Inserted newest-first, so pk order is the OPPOSITE of age order.
    _live_rooms("fair", [
        now,                         # fair-000  freshest
        now - timedelta(minutes=5),  # fair-001
        now - timedelta(hours=2),    # fair-002
        None,                        # fair-003  never confirmed
    ])

    advance = _fake_clock(mocker, cost_per_probe=10.0)
    probed = []

    def _record(self, meeting_id):
        probed.append(meeting_id)
        advance()
        return 1

    mocker.patch(
        "dj.apps.dyte.client.DyteClient.get_participants_count",
        autospec=True, side_effect=_record,
    )

    sweep_live_meetings(timestamp=0)

    assert probed == ["fair-003", "fair-000", "fair-001"], probed


@pytest.mark.django_db
@override_settings(
    DYTE_LIVE_SWEEP_BUDGET_SECONDS=45.0,
    DYTE_LIVE_SWEEP_GRACE_SECONDS=60,
    DYTE_ORG="test-org",
)
def test_successive_sweeps_confirm_every_room_inside_the_public_ttl(mocker):
    """The coverage property the whole ordering rests on (codex round 3).

    Ten live rooms and a provider taking 12s a call: four probes fit in the
    45s budget, so no single tick can reach everyone. Least-recently-
    confirmed-first is self-correcting round robin -- a room the budget
    missed is not refreshed, so it ages, so it rises -- and every room must
    therefore be confirmed within ceil(10 / 4) = 3 ticks. Three ticks is
    three minutes, well inside DYTE_LIVE_LAST_SEEN_TTL_SECONDS (300s), so
    an active broadcast never falls off the public list.

    This is the regression that a cursor rotated over the (mutating)
    ordering fails: refreshing a room changes the sort key underneath the
    cursor, so advancing it guarantees nothing.
    """
    now = timezone.now()
    _live_rooms("cover", [now - timedelta(seconds=10 - i) for i in range(10)])

    clock = {"t": 0.0}
    probed = []
    mocker.patch("dj.apps.dyte.tasks.time.monotonic", lambda: clock["t"])

    def _record(self, meeting_id):
        probed.append(meeting_id)
        clock["t"] += 12.0
        return 2

    mocker.patch(
        "dj.apps.dyte.client.DyteClient.get_participants_count",
        autospec=True, side_effect=_record,
    )

    covered = set()
    for tick in range(3):
        clock["t"] = 0.0
        probed.clear()
        sweep_live_meetings(timestamp=1757000000 + tick * 60)
        assert len(probed) == 4, (tick, probed)
        covered.update(probed)

    assert len(covered) == 10, sorted(covered)
    assert CreatorMeeting.objects.filter(
        live_now=True, last_seen_at__gte=now).count() == 10


@pytest.mark.django_db
@override_settings(
    DYTE_LIVE_SWEEP_BUDGET_SECONDS=45.0,
    DYTE_LIVE_SWEEP_GRACE_SECONDS=60,
    DYTE_ORG="test-org",
)
def test_permanently_failing_probes_cannot_monopolise_the_budget(mocker):
    """The regression the pk cursor exists to prevent (codex round 4).

    Three rooms whose provider endpoints now hit the read timeout, seven
    healthy broadcasts, four probes per 45s tick. A failed probe writes
    NOTHING -- so under any ordering keyed on last_seen_at those three lead
    every sweep forever, the healthy rooms are never confirmed, and they
    vanish from the public list at 300s while the stale-clear valve does
    not retire the offenders until 900s.

    Round robin over `pk` is immune: probe outcome cannot move a room's
    place in the cycle. The failing rooms cost exactly one slot per tick
    (the reserved priority slot, which the stalest room holds), so the
    other three slots keep walking the cycle.
    """
    now = timezone.now()
    # The three broken rooms are also the stalest, i.e. the worst case.
    _live_rooms("mix", (
        [now - timedelta(minutes=4 - i) for i in range(3)]     # mix-000..002
        + [now - timedelta(seconds=30 - i) for i in range(7)]  # mix-003..009
    ))
    broken = {"mix-000", "mix-001", "mix-002"}
    healthy = {f"mix-{i:03d}" for i in range(3, 10)}

    clock = {"t": 0.0}
    probed = []
    mocker.patch("dj.apps.dyte.tasks.time.monotonic", lambda: clock["t"])

    def _record(self, meeting_id):
        probed.append(meeting_id)
        clock["t"] += 12.0
        if meeting_id in broken:
            raise requests.exceptions.ReadTimeout("provider did not answer")
        return 2

    mocker.patch(
        "dj.apps.dyte.client.DyteClient.get_participants_count",
        autospec=True, side_effect=_record,
    )

    confirmed = set()
    for tick in range(4):
        clock["t"] = 0.0
        probed.clear()
        sweep_live_meetings(timestamp=1757000000 + tick * 60)
        assert len(probed) == 4, (tick, probed)
        confirmed.update(m for m in probed if m in healthy)

    assert confirmed == healthy, (
        f"healthy broadcasts never confirmed in four ticks: "
        f"{sorted(healthy - confirmed)} -- they drop off the public list at "
        f"DYTE_LIVE_LAST_SEEN_TTL_SECONDS while people are in them"
    )
    # And every healthy room's presence really was refreshed in the DB.
    assert CreatorMeeting.objects.filter(
        meeting_id__in=healthy, live_now=True, last_seen_at__gt=now,
    ).count() == len(healthy)


@pytest.mark.django_db
@override_settings(DYTE_LIVE_SWEEP_BUDGET_SECONDS=45.0, DYTE_ORG="test-org")
def test_a_cache_outage_degrades_the_cursor_but_never_the_sweep(mocker):
    """The cursor is a hint. A dead cache must not stop rooms being probed.

    It is in the cache and not a column precisely because losing it costs
    fairness and nothing else -- but only if a cache that raises is handled
    rather than propagated out of a periodic task.
    """
    _live_rooms("cacheout", [timezone.now()] * 3)
    mocker.patch("dj.apps.dyte.tasks.cache.get",
                 side_effect=RuntimeError("redis is unreachable"))
    mocker.patch("dj.apps.dyte.tasks.cache.set",
                 side_effect=RuntimeError("redis is unreachable"))
    probe = mocker.patch(
        "dj.apps.dyte.client.DyteClient.get_participants_count",
        autospec=True, return_value=1,
    )

    sweep_live_meetings(timestamp=0)

    assert probe.call_count == 3


@pytest.mark.django_db
@override_settings(
    DYTE_LIVE_SWEEP_BUDGET_SECONDS=45.0,
    DYTE_LIVE_SWEEP_GRACE_SECONDS=60,
    DYTE_ORG="test-org",
)
def test_a_dead_cache_plus_a_broken_provider_still_reaches_every_room(mocker):
    """The two failures correlate, so they must be tested together.

    With Redis down there is no cursor, and restarting at the lowest pk
    every tick reproduces the monopolisation exactly -- the three broken
    low-pk rooms eat the 45s budget every minute and nothing behind them is
    ever confirmed (codex round 6). The tick-derived fallback rotation
    works here, where it did not for the last_seen_at ordering, because the
    cycle is keyed on pk and so does not reshuffle under the offset.
    """
    now = timezone.now()
    _live_rooms("dead", (
        [now - timedelta(minutes=4 - i) for i in range(3)]     # dead-000..002
        + [now - timedelta(seconds=30 - i) for i in range(7)]  # dead-003..009
    ))
    broken = {"dead-000", "dead-001", "dead-002"}
    healthy = {f"dead-{i:03d}" for i in range(3, 10)}

    mocker.patch("dj.apps.dyte.tasks.cache.get",
                 side_effect=RuntimeError("redis is unreachable"))
    mocker.patch("dj.apps.dyte.tasks.cache.set",
                 side_effect=RuntimeError("redis is unreachable"))

    clock = {"t": 0.0}
    probed = []
    mocker.patch("dj.apps.dyte.tasks.time.monotonic", lambda: clock["t"])

    def _record(self, meeting_id):
        probed.append(meeting_id)
        clock["t"] += 12.0
        if meeting_id in broken:
            raise requests.exceptions.ReadTimeout("provider did not answer")
        return 2

    mocker.patch(
        "dj.apps.dyte.client.DyteClient.get_participants_count",
        autospec=True, side_effect=_record,
    )

    confirmed = set()
    # Degraded mode: coverage is O(N) ticks rather than ceil(N / (k-1)),
    # which is the honest cost of having no memory. Finite is the point.
    for tick in range(10):
        clock["t"] = 0.0
        probed.clear()
        sweep_live_meetings(timestamp=1757000000 + tick * 60)
        confirmed.update(m for m in probed if m in healthy)

    assert confirmed == healthy, sorted(healthy - confirmed)


def test_the_cursor_key_is_namespaced_by_database(mocker):
    """Stage, test and prod share one Redis and one logical database.

    prod_settings sets OPTIONS["PREFIX"], which reads like a namespace and
    is not one -- django_redis 5.4 has no PREFIX option, and Django's own
    KEY_PREFIX is unset. So an un-namespaced key is literally shared
    between environments, and a stage worker's cursor would reset prod to
    the lowest pk on every tick (codex round 5).

    No django_db mark and no settings.DATABASES mutation: rebinding the
    database config under a live connection is not something a test should
    do to the rest of the session.
    """
    from django.conf import settings as dj_settings

    from dj.apps.dyte.tasks import SWEEP_CURSOR_KEY, _cursor_key

    keys = []
    for name in ("free2z_stage", "free2z_prod"):
        mocker.patch.object(
            dj_settings, "DATABASES", {"default": {"NAME": name}})
        key = _cursor_key()
        assert key.endswith(SWEEP_CURSOR_KEY)
        assert name in key
        keys.append(key)

    assert keys[0] != keys[1]
