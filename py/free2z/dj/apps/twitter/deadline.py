"""A TOTAL wall-clock bound for one provider call (codex review).

``requests``/``httpx`` timeouts bound connection setup and the gap between
bytes, not the whole response: a provider that keeps dribbling bytes can hold
a call open indefinitely. The announcement job shares the catch-all worker's
single slot with scheduled publishing and the recovery sweeps, so every
provider call it makes goes through:func:`call`.

The call runs in a daemon thread and the job stops WAITING when the deadline
passes. The thread is abandoned, not killed (Python cannot kill a thread): it
finishes or dies on its own socket timeout, and holds no job slot and no
database connection meanwhile -- provider calls here never touch the ORM.
For a non-idempotent call (the X create) the caller must treat
:class:`DeadlineExceeded` as AMBIGUOUS: the abandoned request may still land.
:class:`ProviderBusy` is raised BEFORE anything starts, so it is always safe
to retry.
"""
from __future__ import annotations

import threading

#At most this many abandoned calls PER PROVIDER LANE may still be running
#in one process. Past it,:func:`call` refuses to START another call on
#that lane (codex review): an endpoint that dribbles bytes forever would
#otherwise pile up sockets and buffers inside the catch-all worker. Lanes
#are separate so a stuck image model cannot block X, and vice versa; a
#lane stays blocked until its stuck calls end or the worker restarts
#(every release restarts it).
MAX_ABANDONED = 2
#announcements._record_late_create keys connection cleanup on this name.
THREAD_NAME = "f2zp2p-provider-call"

_abandoned: dict[threading.Thread, str] = {}
_lock = threading.Lock()


class DeadlineExceeded(TimeoutError):
    pass


class ProviderBusy(RuntimeError):
    """Too many earlier calls are still running; nothing was started."""


def abandoned_count(lane: str | None = None) -> int:
    with _lock:
        for thread in [t for t in _abandoned if not t.is_alive()]:
            _abandoned.pop(thread, None)
        return sum(1 for name in _abandoned.values()
                   if lane is None or name == lane)


def call(fn, seconds: float, *args, on_late=None, lane: str = "default",
         **kwargs):
    """Run ``fn`` for at most ``seconds``.

    ``on_late(outcome)`` -- ``{"value":...}`` or ``{"error":...}`` -- is
    called from the abandoned thread if ``fn`` finishes AFTER the caller gave
    up, so a late result of a public write is recorded, not lost.
    """
    if abandoned_count(lane) >= MAX_ABANDONED:
        raise ProviderBusy(
            f"{MAX_ABANDONED} abandoned {lane} calls still running"
        )
    outcome = {}
    done = threading.Event()
    state = {"abandoned": False}

    def target():
        try:
            outcome["value"] = fn(*args, **kwargs)
        except BaseException as exc:  # re-raised in the caller's thread
            outcome["error"] = exc
        finally:
            with _lock:
                done.set()
                late = state["abandoned"]
        if late and on_late is not None:
            try:
                on_late(dict(outcome))
            except Exception:  # noqa: BLE001 -- nobody is left to raise to
                import logging

                logging.getLogger(__name__).exception(
                    "late provider result could not be recorded",
                )

    worker = threading.Thread(
        target=target, name=THREAD_NAME, daemon=True,
    )
    worker.start()
    if not done.wait(seconds):
        with _lock:
            abandoned = not done.is_set()
            if abandoned:
                state["abandoned"] = True
                _abandoned[worker] = lane
        if abandoned:
            raise DeadlineExceeded(
                f"{getattr(fn, '__name__', fn)!s} exceeded {seconds}s"
            )
    if "error" in outcome:
        raise outcome["error"]
    return outcome["value"]
