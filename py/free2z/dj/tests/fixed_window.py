"""Scheduling helpers for tests that assert on a fixed wall-clock window.

Zcash admission (``dj.apps.zauth.admission``) counts requests in a **fixed**
window, not a sliding one::

    local now = tonumber(redis.call('TIME')[1])
    local window_end = now - (now % window) + window

Every client on the planet therefore shares the same boundaries — for a 60s
window they are the wall-clock minute marks — and the counter drops back to
zero the instant one is crossed. That is the intended production behaviour,
but it makes any test that issues *a sequence* of requests and then asserts on
the resulting counter non-deterministic: if a boundary lands mid-sequence the
counter goes 1, 2, 1 instead of 1, 2, 3, and a request the test expects to be
rejected is admitted instead. See, where a ~1-2% flake cost a wrong
diagnosis on an unrelated PR.

The fix is scheduling, not a weaker assertion: before starting the sequence,
require that enough of the current window remains to finish it, and otherwise
wait out the boundary and start clean in the next window. The assertions keep
proving exactly what they proved before.

The clock that matters is the one the *counter* uses. The Lua script above
reads Redis's ``TIME``, so:func:`redis_server_time` is the ``now_fn`` for the
shared-Redis path; the LocMemCache path in ``_admit_single_bucket`` uses the
process's own ``time.time()``, which is the default.
"""

import time


# Enough to be sure the sleep lands past the boundary rather than exactly on
# it, and small enough to be invisible in a test run.
BOUNDARY_MARGIN_SECONDS = 0.05

# The window every Zcash-admission test configures. Kept here rather than in
# each test module so the guard and the setting it protects cannot drift apart.
ADMISSION_WINDOW_SECONDS = 60

# Headroom demanded before a request sequence starts. The slowest guarded
# sequence (`existing-real-hash`: two production-cost PBKDF2 verifications, the
# parametrisation  caught) measured 1.3-1.6s wall clock, so this is ~7x
# the observed worst case: the residual failure needs the sequence itself to
# stall past ten seconds, which is no longer a one-in-fifty coin flip. It costs
# an average of ~0.8s per run -- 10/60 of runs wait, for a mean of 5s -- and
# the wait can never exceed ten seconds, because the guard sleeps only as far
# as the next boundary and never longer.
ADMISSION_SEQUENCE_HEADROOM_SECONDS = 10.0

# One sleep is arithmetically sufficient; the retries only cover a clock that
# jumped (NTP step, suspended laptop) between measuring and sleeping.
_MAX_ATTEMPTS = 3


def redis_server_time(redis_client) -> float:
    """Return Redis's own clock in float seconds.

    ``TIME`` is what ``_SINGLE_BUCKET_ADMISSION_SCRIPT`` computes its window
    from, so the guard must not substitute the client's clock: the two can be
    seconds apart and the guard would then protect the wrong boundary.
    """
    seconds, microseconds = redis_client.time()
    return seconds + microseconds / 1_000_000


def fixed_window_headroom(now: float, window_seconds: int) -> float:
    """Return seconds remaining before ``now`` crosses into the next window.

    Mirrors the script exactly: windows start at multiples of
    ``window_seconds`` since the epoch, so the next boundary is the next such
    multiple. Sitting precisely on a boundary reports a full window, which is
    the truth — the window that just began has all of its budget left.
    """
    return window_seconds - (now % window_seconds)


def wait_for_fixed_window_headroom(
    window_seconds: int,
    required_seconds: float,
    *,
    now_fn=time.time,
    margin_seconds: float = BOUNDARY_MARGIN_SECONDS,
) -> float:
    """Block until ``required_seconds`` of the current fixed window remain.

    Returns the headroom actually available at the moment it returns. The wait
    is bounded by ``required_seconds + margin_seconds`` and only happens for
    the ``required_seconds / window_seconds`` fraction of runs that start too
    close to a boundary — it is not a blanket sleep, and it never retries an
    assertion.
    """
    if required_seconds <= 0:
        raise ValueError("required_seconds must be positive")
    if required_seconds + margin_seconds >= window_seconds:
        raise ValueError(
            "required_seconds must fit inside the window with room to spare; "
            f"got {required_seconds} for a {window_seconds}s window"
        )

    for _ in range(_MAX_ATTEMPTS):
        headroom = fixed_window_headroom(now_fn(), window_seconds)
        if headroom >= required_seconds:
            return headroom
        # Sleep out the remainder of this window (plus a hair) so the sequence
        # begins at the top of a fresh one with the whole budget ahead of it.
        time.sleep(headroom + margin_seconds)

    raise RuntimeError(
        f"could not obtain {required_seconds}s of headroom in a "
        f"{window_seconds}s window after {_MAX_ATTEMPTS} attempts; "
        "the clock is not advancing monotonically"
    )


def await_admission_window_headroom(redis_client=None) -> float:
    """Guard a Zcash-admission request sequence against a window boundary.

    Call this immediately before the sequence, never earlier: work done in
    between (a ``creator_factory`` password hash costs 1-3s) spends the
    headroom that was just measured.

    ``redis_client`` selects the clock. Pass the raw client for tests pinned
    to real Redis via ``_real_redis``; leave it ``None`` for the LocMemCache
    path, whose window comes from ``_fixed_window_retry`` and therefore from
    this process's own clock.
    """
    if redis_client is None:
        now_fn = time.time
    else:

        def now_fn():
            return redis_server_time(redis_client)

    return wait_for_fixed_window_headroom(
        ADMISSION_WINDOW_SECONDS,
        ADMISSION_SEQUENCE_HEADROOM_SECONDS,
        now_fn=now_fn,
    )
