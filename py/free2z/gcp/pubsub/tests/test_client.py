"""Regression tests for the Pub/Sub subscribe loop.

Every prod subscriber Deployment exited 0 -- and was restarted by kubelet --
every ~83 minutes, which is exactly the `timeout=5000` the loop passed to
`StreamingPullFuture.result()`. `StreamingPullFuture` inherits
`concurrent.futures.Future.result()`, which raises
`concurrent.futures.TimeoutError`; that only became an alias of the builtin
`TimeoutError` in Python 3.11, and the deployed image was `python:3.10`. So the
`except TimeoutError: continue` branch never matched, the timeout fell through
to a generic `except Exception` that `break`s, and the process exited cleanly.

Only the external Google Pub/Sub boundary is faked here. No database is
involved, and none is mocked.
"""
import logging
import threading
from concurrent.futures import TimeoutError as FuturesTimeoutError

import pytest

from gcp.pubsub import client as client_module
from gcp.pubsub.client import PubSubClient


class _StopLoop(BaseException):
    """Escape hatch to end the otherwise-infinite subscribe loop.

    Deliberately a BaseException so the production code's `except Exception`
    recovery path cannot swallow it.
    """


class FakeFuture:
    """Stands in for google.cloud.pubsub_v1.subscriber.futures.StreamingPullFuture."""

    def __init__(self, outcomes, done_on_timeout=False):
        # `outcomes` is a list of exception instances to raise (or the
        # sentinel `RETURN` to return normally), consumed one per result().
        self.outcomes = list(outcomes)
        self.done_on_timeout = done_on_timeout
        self.result_calls = []
        self.cancelled = False

    RETURN = object()

    def result(self, timeout=None):
        self.result_calls.append(timeout)
        if not self.outcomes:
            raise AssertionError("result() called more times than expected")
        outcome = self.outcomes.pop(0)
        if outcome is self.RETURN:
            return None
        raise outcome

    def done(self):
        return self.done_on_timeout

    def cancel(self):
        self.cancelled = True


class FakeSubscriberClient:
    def __init__(self, futures):
        self.futures = list(futures)
        self.subscribe_calls = []
        self.closed = False

    def get_subscription(self, subscription=None):
        return object()

    def create_subscription(self, name=None, topic=None):  # pragma: no cover
        raise AssertionError("subscription already exists in these tests")

    def subscribe(self, subscription_path, callback, **kwargs):
        self.subscribe_calls.append((subscription_path, callback, kwargs))
        if not self.futures:
            raise AssertionError("subscribe() called more times than expected")
        return self.futures.pop(0)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.closed = True
        return False


class FakePublisherClient:
    def get_topic(self, topic=None):
        return object()

    def create_topic(self, name=None):  # pragma: no cover
        raise AssertionError("topic already exists in these tests")


@pytest.fixture
def sleeps(mocker):
    """Record backoff sleeps instead of actually sleeping."""
    recorded = []
    mocker.patch.object(
        client_module.time, "sleep", side_effect=recorded.append)
    # jitter factor 0.5 + random() -> exactly 1.0, so sleeps are deterministic
    mocker.patch.object(client_module.random, "random", return_value=0.5)
    return recorded


def make_client(futures):
    client = PubSubClient.__new__(PubSubClient)
    client.publisher = FakePublisherClient()
    client.subscriber = FakeSubscriberClient(futures)
    return client


def run_subscribe(client, callback=None, **kwargs):
    """Run the loop until the test's _StopLoop sentinel escapes."""
    with pytest.raises(_StopLoop):
        client.subscribe(
            "projects/p/topics/t",
            "projects/p/subscriptions/s",
            callback or (lambda message: None),
            **kwargs,
        )


def test_futures_timeout_is_matched_on_every_interpreter():
    """The exact mechanism of, asserted directly.

    On Python < 3.11 the builtin TimeoutError does NOT catch
    concurrent.futures.TimeoutError, so `except TimeoutError` silently missed
    every heartbeat in the then-deployed 3.10 image (3.12 since; the
    assertion is interpreter-independent on purpose).
    """
    assert issubclass(FuturesTimeoutError, client_module.TIMEOUT_ERRORS)
    assert issubclass(TimeoutError, client_module.TIMEOUT_ERRORS)


def test_timeout_keeps_listening_without_resubscribing(sleeps):
    """A result() timeout is normal: keep waiting on the same future."""
    future = FakeFuture([FuturesTimeoutError()] * 5 + [_StopLoop()])
    client = make_client([future])

    run_subscribe(client, heartbeat_seconds=300)

    # The loop waited through every timeout on the SAME streaming pull.
    assert len(client.subscriber.subscribe_calls) == 1
    assert future.result_calls == [300] * 6
    assert sleeps == []


def test_callback_scheduler_has_two_bounded_workers(sleeps):
    """The SQL budget counts two thread-local connections per process."""
    future = FakeFuture([_StopLoop()])
    client = make_client([future])

    run_subscribe(client, heartbeat_seconds=300)

    _, wrapped_callback, kwargs = client.subscriber.subscribe_calls[0]
    scheduler = kwargs['scheduler']
    assert scheduler._executor._max_workers == client_module.CALLBACK_WORKERS == 2
    assert wrapped_callback is not None
    assert 'await_callbacks_on_shutdown' not in kwargs


def test_callback_slots_are_shared_across_reconnects(sleeps):
    """Old and replacement streams cannot multiply executing callbacks."""
    future = FakeFuture([_StopLoop()])
    client = make_client([future])
    entered = []
    release = threading.Event()
    two_entered = threading.Event()

    def callback(message):
        entered.append(message)
        if len(entered) == client_module.CALLBACK_WORKERS:
            two_entered.set()
        release.wait(timeout=1)

    run_subscribe(client, callback=callback, heartbeat_seconds=300)
    wrapped = client.subscriber.subscribe_calls[0][1]
    threads = [
        threading.Thread(target=wrapped, args=(message,))
        for message in ("first", "second", "third")
    ]
    threads[0].start()
    threads[1].start()
    assert two_entered.wait(timeout=1)
    threads[2].start()
    assert len(entered) == 2
    assert set(entered) == {"first", "second"}
    release.set()
    for thread in threads:
        thread.join(timeout=1)
        assert not thread.is_alive()
    assert sorted(entered) == ["first", "second", "third"]


def test_does_not_exit_after_the_5000_second_timeout(sleeps):
    """The  reproduction: timeout=5000 must not end the subscriber."""
    future = FakeFuture([FuturesTimeoutError(), _StopLoop()])
    client = make_client([future])

    run_subscribe(client, heartbeat_seconds=5000)

    # It waited again on the same future after the 5000s timeout. Before the
    # fix, the timeout escaped to `except Exception` -> `break`, the `with
    # self.subscriber:` block closed, handle() returned, and the container
    # exited 0 -- "Reason: Completed, Exit Code: 0" every ~83 minutes.
    assert future.result_calls == [5000, 5000]
    assert len(client.subscriber.subscribe_calls) == 1


def test_builtin_timeout_error_also_keeps_listening(sleeps):
    """On Python 3.11+ result() raises the builtin TimeoutError instead."""
    future = FakeFuture([TimeoutError(), _StopLoop()])
    client = make_client([future])

    run_subscribe(client, heartbeat_seconds=60)

    assert len(client.subscriber.subscribe_calls) == 1
    assert sleeps == []


def test_transient_error_resubscribes_with_backoff(sleeps, caplog):
    """A genuine error reconnects in-process instead of giving up."""
    failing = FakeFuture([RuntimeError("stream broke"), FakeFuture.RETURN])
    recovered = FakeFuture([_StopLoop()])
    client = make_client([failing, recovered])

    with caplog.at_level(logging.ERROR, logger=client_module.__name__):
        run_subscribe(client, heartbeat_seconds=60)

    assert len(client.subscriber.subscribe_calls) == 2
    assert (
        client.subscriber.subscribe_calls[0][1]
        is client.subscriber.subscribe_calls[1][1]
    )
    assert failing.cancelled is True
    assert sleeps == [client_module.INITIAL_BACKOFF_SECONDS]
    # Logged as ERROR, not print() -- print is why this never surfaced in
    # Cloud Logging.
    assert any(r.levelno == logging.ERROR for r in caplog.records)


def test_backoff_grows_exponentially_and_is_capped(sleeps):
    futures = [
        FakeFuture([RuntimeError("boom"), FakeFuture.RETURN])
        for _ in range(4)
    ]
    futures.append(FakeFuture([_StopLoop()]))
    client = make_client(futures)

    run_subscribe(client, heartbeat_seconds=60, max_consecutive_failures=99)

    assert sleeps == [1.0, 2.0, 4.0, 8.0]
    assert len(client.subscriber.subscribe_calls) == 5


def test_clean_stream_end_resubscribes_rather_than_returning(sleeps):
    """result() returning is still 'nothing is consuming the subscription'."""
    ended = FakeFuture([FakeFuture.RETURN, FakeFuture.RETURN])
    replacement = FakeFuture([_StopLoop()])
    client = make_client([ended, replacement])

    run_subscribe(client, heartbeat_seconds=60)

    assert len(client.subscriber.subscribe_calls) == 2


def test_gives_up_loudly_and_non_zero_after_repeated_failures(sleeps, caplog):
    """If reconnecting is hopeless, raise -- never a clean exit(0)."""
    futures = [
        FakeFuture([RuntimeError("boom"), FakeFuture.RETURN])
        for _ in range(3)
    ]
    client = make_client(futures)

    with caplog.at_level(logging.CRITICAL, logger=client_module.__name__):
        with pytest.raises(RuntimeError, match="boom"):
            client.subscribe(
                "projects/p/topics/t",
                "projects/p/subscriptions/s",
                lambda message: None,
                heartbeat_seconds=60,
                max_consecutive_failures=3,
            )

    assert len(client.subscriber.subscribe_calls) == 3
    assert any(r.levelno == logging.CRITICAL for r in caplog.records)


def test_timeout_stored_on_a_finished_future_is_a_real_error(sleeps):
    """A TimeoutError raised because the future FAILED must not be swallowed."""
    failing = FakeFuture(
        [TimeoutError("deadline exceeded"), FakeFuture.RETURN],
        done_on_timeout=True,
    )
    replacement = FakeFuture([_StopLoop()])
    client = make_client([failing, replacement])

    run_subscribe(client, heartbeat_seconds=60)

    assert len(client.subscriber.subscribe_calls) == 2
    assert failing.cancelled is True


def test_shutdown_signal_cancels_and_propagates(sleeps):
    future = FakeFuture([KeyboardInterrupt()])
    client = make_client([future])

    with pytest.raises(KeyboardInterrupt):
        client.subscribe(
            "projects/p/topics/t",
            "projects/p/subscriptions/s",
            lambda message: None,
            heartbeat_seconds=60,
        )

    assert future.cancelled is True
    assert len(client.subscriber.subscribe_calls) == 1
