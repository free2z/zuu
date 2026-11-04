"""Bounded, failure-tolerant source fan-out tests."""
import time
from decimal import Decimal
from threading import Event, current_thread

from dj.apps.pricing import constants
from dj.apps.pricing import sources as pricing_sources


def test_fetch_all_prices_returns_completed_results_at_batch_deadline(mocker):
    """A stuck worker cannot make the caller wait past the batch deadline."""
    mocker.patch.object(
        constants, "SOURCE_BATCH_TIMEOUT_SECONDS", 0.05)
    release_slow_source = Event()
    slow_source_started = Event()
    slow_source_daemon = []

    def fast_source(_session):
        return Decimal("1000")

    def slow_source(_session):
        slow_source_started.set()
        slow_source_daemon.append(current_thread().daemon)
        release_slow_source.wait(0.3)
        return Decimal("1001")

    started = time.monotonic()
    prices = pricing_sources.fetch_all_prices({
        "fast": fast_source,
        "slow": slow_source,
    })
    elapsed = time.monotonic() - started
    release_slow_source.set()

    assert slow_source_started.is_set()
    assert slow_source_daemon == [True]
    assert prices == {"fast": Decimal("1000")}
    assert elapsed < 0.2


def test_fetch_all_prices_ignores_source_failures():
    def broken_source(_session):
        raise RuntimeError("exchange unavailable")

    def healthy_source(_session):
        return Decimal("1000")

    assert pricing_sources.fetch_all_prices({
        "broken": broken_source,
        "healthy": healthy_source,
    }) == {"healthy": Decimal("1000")}
