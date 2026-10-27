import json
import logging
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import Future
from concurrent.futures import TimeoutError as FuturesTimeoutError
from typing import Callable, Optional

from google.api_core import exceptions as gexc
from google.api_core import retry as gretry
from google.cloud.pubsub_v1.subscriber.message import Message
from google.cloud.pubsub_v1.subscriber.scheduler import ThreadScheduler
from google.cloud import pubsub_v1

logger = logging.getLogger(__name__)


# `StreamingPullFuture` does not override `result()`, so it inherits
# `concurrent.futures.Future.result()` and raises
# `concurrent.futures.TimeoutError` when the timeout elapses.
#
# `concurrent.futures.TimeoutError` only became an alias of the builtin
# `TimeoutError` in Python 3.11. The deployed image was `python:3.10-bullseye`
# (docker/py3base/Dockerfile) when  hit, where the two are unrelated
# classes -- which is exactly why the old `except TimeoutError:` branch never
# matched in prod and every subscriber exited 0 every ~83 minutes. The image
# is 3.12 now, where the tuple is redundant; keep matching on both so
# the fix does not depend on which interpreter happens to be pinned.
TIMEOUT_ERRORS = (FuturesTimeoutError, TimeoutError)

# How long to block in a single `result()` call. Purely a liveness heartbeat:
# a timeout means "healthy, still streaming", and we go straight back to
# waiting on the SAME future. It never re-subscribes and never exits.
HEARTBEAT_SECONDS = 300.0

# Reconnect backoff after a genuine stream failure.
INITIAL_BACKOFF_SECONDS = 1.0
MAX_BACKOFF_SECONDS = 60.0

# A stream that stayed up at least this long counts as a successful
# connection, and resets the backoff / failure budget.
HEALTHY_STREAM_SECONDS = 60.0

# If the stream fails this many times in a row without ever staying up for
# HEALTHY_STREAM_SECONDS, the problem is not transient. Log CRITICAL and let
# the exception propagate so the process dies NON-zero and kubelet's restart
# count means something.
MAX_CONSECUTIVE_FAILURES = 10

# How long to wait for a cancelled streaming pull to wind down.
CANCEL_TIMEOUT_SECONDS = 30.0

# Django ORM connections are thread-local. google-cloud-pubsub otherwise uses
# a ten-thread callback pool, so one subscriber process can retain ten
# CONN_MAX_AGE connections after a burst even though the deployment budget
# counts one connection per process. Subscriber Deployments already scale by
# queue and namespace; keep each process serial so that accounting is true.
CALLBACK_WORKERS = 2

# SECONDS. Bound on each SYNCHRONOUS admin RPC on the publish path
# (`get_topic`, `create_topic`).
#
# These run BEFORE the future exists, so `future.result(timeout=...)` does
# not bound them -- and the SDK's own default is a 600s retry deadline per
# operation (google/pubsub_v1/services/publisher/transports/base.py). During
# a Pub/Sub outage one `ensure_topic=True` publish could therefore block for
# ~20 minutes on a caller that believed it had a 30s cap: the outbox relay
# runs on `image-variant-worker`, concurrency 1, shared with images, search,
# translation, the health sweep and the stalled-job reclaimer.
#
# 10s because this is a metadata lookup against a topic that, in every
# deployed namespace, already exists -- the call is a formality that only
# the first publish into a fresh namespace ever needs.
ADMIN_TIMEOUT_SECONDS = 10.0

# What one bounded call can ACTUALLY take, which is not ADMIN_TIMEOUT_SECONDS.
#
# api-core checks the retry deadline BEFORE starting an attempt, not during
# one, and `TimeToDeadlineTimeout` resets the per-attempt timeout to the full
# value once the remaining budget drops below a second
# (`google/api_core/timeout.py`). So an attempt begun a hair inside the
# deadline gets a fresh full timeout: the honest ceiling is 2x, not 1x.
#
# Anything computing a lease or a budget from these calls must use THIS
# number. Understating it is how a lease expires while its own pass is still
# running, which is the one duplicate the outbox is supposed to prevent
# rather than absorb.
ADMIN_CALL_WORST_CASE_SECONDS = 2 * ADMIN_TIMEOUT_SECONDS

# The status codes Pub/Sub's own GAPIC config declares retryable. Named here
# because `bounded_retry` below replaces the SDK's default retry object, and
# a replacement that silently narrowed the predicate would turn ordinary
# transient errors into hard failures.
TRANSIENT_ERRORS = (
    gexc.ServiceUnavailable,     # UNAVAILABLE
    gexc.DeadlineExceeded,       # DEADLINE_EXCEEDED
    gexc.InternalServerError,    # INTERNAL
    gexc.Aborted,                # ABORTED
    gexc.Cancelled,              # CANCELLED
    gexc.Unknown,                # UNKNOWN
    gexc.ResourceExhausted,      # RESOURCE_EXHAUSTED
)


def bounded_retry(total_seconds: float) -> gretry.Retry:
    """A retry policy whose TOTAL duration is `total_seconds`.

    `timeout=` on a GAPIC method is NOT this. api-core turns a float
    `timeout` into a `TimeToDeadlineTimeout` applied to each ATTEMPT -- and
    it deliberately resets to the full value when the remaining budget drops
    below a second (`google/api_core/timeout.py`) -- while the *retry loop*
    keeps its own deadline, which the Pub/Sub publisher transport sets to
    **600 seconds**. So `get_topic(timeout=10)` alone bounds one attempt and
    lets the call run for ten minutes.

    That matters because these calls sit on the outbox relay's path, on a
    worker running concurrency 1 across seven queues, and the relay's drain
    budget and claim lease are both computed from a per-row worst case. A
    bound that is not really a bound makes both of those arithmetic
    statements false rather than merely optimistic.
    """
    return gretry.Retry(
        predicate=gretry.if_exception_type(*TRANSIENT_ERRORS),
        initial=0.25,
        maximum=2.0,
        multiplier=2.0,
        timeout=total_seconds,
    )


class PubSubClient:
    def __init__(self):
        self.publisher = pubsub_v1.PublisherClient()
        self.subscriber = pubsub_v1.SubscriberClient()

    def publish_string(self, topic_path: str, payload: str) -> Future:
        payload_bytes = payload.encode('utf-8')
        #was a bare get_topic()/create_topic() pair, i.e. the SDK's
        # 600s retry deadline per admin RPC. Same bounded path as publish().
        self._ensure_topic(topic_path, ADMIN_TIMEOUT_SECONDS)
        return self.publisher.publish(topic_path, payload_bytes)

    def _ensure_topic(self, topic_path: str, timeout: float) -> None:
        """Create `topic_path` if, and only if, it is genuinely missing.

        This used to be `except Exception: create_topic(...)`, which turned
        every failure into an attempted create: a permission error, a
        deadline, a transient UNAVAILABLE. The create then failed too, with
        a second error that named the wrong problem, after a second full
        retry deadline. Only NotFound means "missing".

        AlreadyExists is success: two producers racing into a fresh
        namespace both see NotFound and both create.

        `retry` is passed as well as `timeout`, and it is the half that
        actually bounds the call -- see `bounded_retry`.
        """
        retry = bounded_retry(timeout)
        try:
            self.publisher.get_topic(
                topic=topic_path, timeout=timeout, retry=retry)
            return
        except gexc.NotFound:
            pass
        try:
            self.publisher.create_topic(
                name=topic_path, timeout=timeout, retry=bounded_retry(timeout))
        except gexc.AlreadyExists:
            pass

    def publish(
        self, topic_path: str, payload: dict, *, ensure_topic: bool = True,
        attributes: Optional[dict] = None,
        timeout: Optional[float] = None,
        admin_timeout: float = ADMIN_TIMEOUT_SECONDS,
    ) -> Future:
        """Publish one JSON message.

        `attributes` become Pub/Sub message attributes. They are keyword
        arguments to the underlying `publish()`, so every key must be a
        `str` and every value a `str`; the caller owns that conversion
        because it owns the meaning. `ordering_key`, `retry` and `timeout`
        are named parameters of that call, so they cannot be used as
        attribute names.

        `timeout` bounds the publish RPC ITSELF (attempt timeout AND retry
        deadline, via `bounded_retry`), and is not the same thing as
        `future.result(timeout=...)`. A `result()` timeout only stops the
        CALLER waiting; the SDK keeps retrying underneath, and a publisher
        future cannot be cancelled -- so without this the message could
        still be accepted minutes after its caller gave up and recorded a
        failure. It narrows that window to roughly the caller's own wait
        rather than closing it; the residual is why delivery is documented
        as at-least-once (see ).

        `admin_timeout` bounds the synchronous `ensure_topic` RPCs, which
        happen BEFORE the future exists and are therefore bounded by
        nothing else.

        NOTE for anyone tempted to add `ordering_key=` here: it raises
        unless this PublisherClient was built with
        `PublisherOptions(enable_message_ordering=True)`, and ordered
        DELIVERY additionally requires the subscription to have been created
        with ordering enabled -- `subscribe()` below creates them with
        defaults. See `dj/apps/jobs/models.py`.
        """
        payload_bytes = json.dumps(payload).encode('utf-8')

        if ensure_topic:
            self._ensure_topic(topic_path, admin_timeout)

        kwargs = dict(attributes or {})
        if timeout is not None:
            kwargs['timeout'] = timeout
            # `timeout` alone bounds one ATTEMPT; the retry loop keeps the
            # transport's own 600s deadline. Both, or neither is a bound.
            kwargs['retry'] = bounded_retry(timeout)
        return self.publisher.publish(topic_path, payload_bytes, **kwargs)

    def subscribe(
        self, topic_path: str, subscription_path: str,
        callback: Callable[[Message], None],
        heartbeat_seconds: Optional[float] = HEARTBEAT_SECONDS,
        max_consecutive_failures: int = MAX_CONSECUTIVE_FAILURES,
        flow_control=None,
    ) -> None:
        """Consume `subscription_path` forever.

        This call is not expected to return. A subscriber's entire job is to
        keep a streaming pull open, so there is no such thing as "done":

        * a `result()` timeout is not an error -- keep waiting on the same
          streaming pull future;
        * a genuine stream error is recovered *in process*: cancel the dead
          future, sleep with exponential backoff + jitter, re-subscribe;
        * only if reconnecting fails `max_consecutive_failures` times in a row
          do we give up -- and then we log CRITICAL and re-raise, so the
          process exits NON-zero. A clean exit(0) from here would look like
          success to kubelet and to Cloud Logging, which is precisely how
           hid for so long.
        """
        # Create the topic if it doesn't exist
        try:
            self.publisher.get_topic(topic=topic_path)
        except Exception:
            self.publisher.create_topic(name=topic_path)

        # Create the subscription if it doesn't exist
        try:
            self.subscriber.get_subscription(subscription=subscription_path)
        except Exception:
            self.subscriber.create_subscription(
                name=subscription_path, topic=topic_path)

        backoff = INITIAL_BACKOFF_SECONDS
        consecutive_failures = 0
        callback_slots = threading.BoundedSemaphore(CALLBACK_WORKERS)

        def serialized_callback(message):
            # One semaphore survives every reconnect generation. A slow
            # callback from the old stream and callbacks from its replacement
            # therefore cannot multiply thread-local database connections.
            with callback_slots:
                callback(message)

        # Subscribe to the topic and listen for messages indefinitely
        with self.subscriber:
            while True:
                subscribe_kwargs = {}
                if flow_control is not None:
                    subscribe_kwargs['flow_control'] = flow_control
                subscribe_kwargs['scheduler'] = ThreadScheduler(
                    executor=ThreadPoolExecutor(
                        max_workers=CALLBACK_WORKERS,
                        thread_name_prefix='free2z-pubsub-callback',
                    )
                )
                future = self.subscriber.subscribe(
                    subscription_path, serialized_callback, **subscribe_kwargs)
                logger.info(
                    "Listening for messages on %s", subscription_path)
                started = time.monotonic()

                try:
                    self._await_stream(
                        future, subscription_path, heartbeat_seconds)
                except (KeyboardInterrupt, SystemExit):
                    logger.info(
                        "Shutdown requested; cancelling subscription %s",
                        subscription_path)
                    self._cancel(future)
                    raise
                except Exception:
                    logger.error(
                        "Streaming pull for %s failed; will reconnect",
                        subscription_path, exc_info=True)
                    self._cancel(future)
                    uptime = time.monotonic() - started
                    if uptime >= HEALTHY_STREAM_SECONDS:
                        backoff = INITIAL_BACKOFF_SECONDS
                        consecutive_failures = 0
                    consecutive_failures += 1
                    if consecutive_failures >= max_consecutive_failures:
                        logger.critical(
                            "Streaming pull for %s failed %d times in a row; "
                            "giving up and exiting non-zero",
                            subscription_path, consecutive_failures)
                        raise
                    time.sleep(backoff * (0.5 + random.random()))
                    backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)
                    continue

                # `result()` returned instead of raising: the stream shut down
                # without an error (e.g. it was cancelled out from under us).
                # There is still nothing consuming the subscription, so treat
                # it like any other disconnect and re-subscribe.
                logger.warning(
                    "Streaming pull for %s ended without an error; "
                    "re-subscribing", subscription_path)
                self._cancel(future)
                time.sleep(backoff * (0.5 + random.random()))
                backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)

    @staticmethod
    def _await_stream(
        future, subscription_path: str, heartbeat_seconds: Optional[float],
    ):
        """Block until the streaming pull actually ends.

        A `TimeoutError` here means the stream is healthy and simply has not
        terminated, so we keep waiting on the same future. The bug in  was
        that this branch was never reached, and the timeout fell through to a
        generic handler that broke out of the loop.
        """
        while True:
            try:
                return future.result(timeout=heartbeat_seconds)
            except TIMEOUT_ERRORS:
                if future.done():
                    # The future finished, so this TimeoutError is a real
                    # error stored on it, not the wait timing out.
                    raise
                logger.debug(
                    "Still listening on %s", subscription_path)
                continue

    @staticmethod
    def _cancel(future) -> None:
        """Tear down a streaming pull future, ignoring shutdown noise."""
        try:
            future.cancel()
            future.result(timeout=CANCEL_TIMEOUT_SECONDS)
        except Exception:
            logger.debug(
                "Error while cancelling streaming pull", exc_info=True)
