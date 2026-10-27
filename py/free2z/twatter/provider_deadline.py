"""Wall-clock bounds for synchronous provider calls.

Requests' timeout values bound connection establishment and inactivity between
bytes, not a response that keeps dribbling data.  Gunicorn's sync workers run
request handlers in their process main thread, where an interval timer can
enforce the total provider-call budget as well.
"""
from contextlib import contextmanager
import signal
import threading


TWITTER_PROVIDER_DEADLINE_SECONDS = 12


class TwitterProviderDeadlineExceeded(TimeoutError):
    pass


@contextmanager
def twitter_provider_deadline(seconds=TWITTER_PROVIDER_DEADLINE_SECONDS):
    """Bound provider wall time without replacing a process-owned alarm."""
    supports_process_timer = (
        threading.current_thread() is threading.main_thread()
        and hasattr(signal, "SIGALRM")
        and hasattr(signal, "ITIMER_REAL")
        and hasattr(signal, "setitimer")
        and hasattr(signal, "getitimer")
    )
    if not supports_process_timer:
        yield
        return

    previous_handler = signal.getsignal(signal.SIGALRM)
    previous_timer = signal.getitimer(signal.ITIMER_REAL)
    if previous_handler != signal.SIG_DFL or previous_timer[0] > 0:
        yield
        return

    def deadline_exceeded(_signum, _frame):
        raise TwitterProviderDeadlineExceeded(
            "Twitter provider deadline exceeded",
        )

    signal.signal(signal.SIGALRM, deadline_exceeded)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
