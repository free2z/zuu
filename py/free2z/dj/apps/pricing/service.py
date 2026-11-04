"""
Pricing service: the one place the rest of the app asks "what does a 2Z cost?".

  * ``refresh_snapshot()`` polls the exchanges, aggregates, and stores a new
    ``ZecPriceSnapshot``. Run frequently by a k8s CronJob.
  * ``get_pricing()`` returns the current pricing payload for the UIs/API,
    using the latest stored snapshot (or a display-only bootstrap estimate on
    a cold start). It never reaches out to exchanges from a web request.
  * ``current_tuzis_per_zec()`` is the rate used when crediting an on-chain ZEC
    purchase.

The database is the durable, shared source of truth (there is no cross-pod
cache configured), so web reads always resolve against the latest snapshot row.
"""
import logging
from decimal import Decimal
from typing import Optional

from django.conf import settings
from django.core.cache import cache
from django.utils import timezone

from . import constants
from .aggregation import aggregate
from .models import ZecPriceSnapshot
from .sources import fetch_all_prices

logger = logging.getLogger(__name__)

# The crediting management command may make one bounded best-effort refresh
# when its snapshot is stale. Public GETs never call this path, so a request
# cannot fan out to exchange APIs or stampede the sources.
_REFRESH_LOCK_KEY = "pricing:refresh:lock"


def _refresh_lock_timeout() -> int:
    """Keep the single-flight lock longer than the current source budget."""
    return int(constants.SOURCE_BATCH_TIMEOUT_SECONDS) + 5


class PricingUnavailable(Exception):
    """Raised when we have no real price at all (no sources and no history)."""


def _bootstrap_zec_usd() -> Decimal:
    return Decimal(str(getattr(
        settings, "PRICING_BOOTSTRAP_ZEC_USD", constants.BOOTSTRAP_ZEC_USD)))


def _bootstrap_snapshot() -> ZecPriceSnapshot:
    """An UNSAVED best-guess snapshot for display-only cold starts.

    Marked with ``num_sources == 0`` so callers can flag it as an estimate. It
    is never persisted and never used to credit a purchase.
    """
    # Quantize to the model's stored precision so display matches saved rows.
    zec_usd = _bootstrap_zec_usd().quantize(Decimal("0.000001"))
    return ZecPriceSnapshot(
        zec_usd=zec_usd,
        median_usd=zec_usd,
        spread=constants.ZEC_ESTIMATE_BUFFER.quantize(Decimal("0.0001")),
        tuzis_per_zec=constants.tuzis_per_zec(zec_usd, constants.ZEC_ESTIMATE_BUFFER),
        num_sources=0,
        sources={},
        rejected={},
        created_at=timezone.now(),
    )


def refresh_snapshot(spread: Decimal = constants.ZEC_ESTIMATE_BUFFER) -> ZecPriceSnapshot:
    """Poll exchanges, aggregate, persist and return a fresh snapshot.

    Raises ``PricingUnavailable`` if not a single source responded.
    """
    prices = fetch_all_prices()
    if len(prices) < constants.MIN_SOURCES:
        # Not enough independent quotes to cross-check — refuse to record a new
        # rate rather than price (and credit) off a thin/unvetted set. Callers
        # keep serving the last good snapshot.
        raise PricingUnavailable(
            f"only {len(prices)} source(s) responded, need "
            f"{constants.MIN_SOURCES} ({', '.join(prices) or 'none'})")

    result = aggregate(prices)
    if result.num_sources < constants.MIN_AGREEING_SOURCES:
        # Enough responded but they don't agree within the band — untrustworthy.
        raise PricingUnavailable(
            f"only {result.num_sources} source(s) agreed within the band; "
            f"rejected {result.rejected}")

    snapshot = ZecPriceSnapshot.from_aggregate(result, spread=spread)
    snapshot.save()
    logger.info(
        "pricing: ZEC=$%s from %d sources -> %s 2Z/ZEC",
        snapshot.zec_usd, snapshot.num_sources, snapshot.tuzis_per_zec,
    )
    return snapshot


def latest_snapshot() -> Optional[ZecPriceSnapshot]:
    return ZecPriceSnapshot.objects.order_by('-created_at').first()


def _is_stale(snapshot: ZecPriceSnapshot) -> bool:
    age = (timezone.now() - snapshot.created_at).total_seconds()
    return not 0 <= age <= constants.SNAPSHOT_MAX_AGE_SECONDS


def _try_refresh_single_flight() -> Optional[ZecPriceSnapshot]:
    """Refresh once for a non-web caller; return None if it did not run."""
    if not cache.add(_REFRESH_LOCK_KEY, 1, _refresh_lock_timeout()):
        return None
    try:
        return refresh_snapshot()
    except Exception as exc:
        logger.warning("pricing: refresh failed (%s)", exc)
        return None
    finally:
        cache.delete(_REFRESH_LOCK_KEY)


def get_current_snapshot(allow_bootstrap: bool = False) -> ZecPriceSnapshot:
    """Return the latest stored snapshot without doing network I/O.

    Order of preference:
      1. Latest stored snapshot, even if stale. The refresh CronJob keeps this
         row current; web requests must not block on exchange polling.
      2. Only if ``allow_bootstrap`` (display, never crediting): an unsaved
         best-guess snapshot so the UI can still show an estimate on a cold
         start. Otherwise raise ``PricingUnavailable``.
    """
    current = latest_snapshot()
    if current is not None:
        if _is_stale(current):
            logger.warning("pricing: serving cached (stale) snapshot")
        return current
    if allow_bootstrap:
        logger.warning(
            "pricing: no snapshot available; serving bootstrap estimate")
        return _bootstrap_snapshot()
    raise PricingUnavailable("no price available")


def current_tuzis_per_zec() -> Decimal:
    """A fresh server settlement rate; stale or bootstrap data cannot credit."""
    snapshot = latest_snapshot()
    if snapshot is not None and not _is_stale(snapshot):
        return constants.tuzis_per_zec(snapshot.zec_usd, constants.ZEC_SETTLEMENT_SPREAD)
    refreshed = _try_refresh_single_flight()
    if refreshed is not None:
        return constants.tuzis_per_zec(refreshed.zec_usd, constants.ZEC_SETTLEMENT_SPREAD)
    if snapshot is not None:
        age = (timezone.now() - snapshot.created_at).total_seconds()
        if 0 <= age <= min(constants.CREDIT_MAX_SNAPSHOT_AGE_SECONDS, constants.SNAPSHOT_MAX_AGE_SECONDS):
            return constants.tuzis_per_zec(snapshot.zec_usd, constants.ZEC_SETTLEMENT_SPREAD)
        raise PricingUnavailable(
            f"the last real price is {int(age)}s old (limit "
            f"{min(constants.CREDIT_MAX_SNAPSHOT_AGE_SECONDS, constants.SNAPSHOT_MAX_AGE_SECONDS)}s); refusing to "
            f"credit at a rate the market may have left behind")
    raise PricingUnavailable("no price available")


def get_pricing(promo=None) -> dict:
    """Full pricing payload consumed by the API and both UIs.

    Reads the persisted snapshot (or falls back to a display-only bootstrap
    estimate) so a public request never waits on exchange APIs. The
    ``bootstrap`` flag tells the UI to show the number as an estimate.
    """
    snapshot = get_current_snapshot(allow_bootstrap=True)
    bootstrap = snapshot.pk is None  # unsaved == cold-start best guess
    stale = bootstrap or _is_stale(snapshot)
    from .promotions import select_promotion, rates
    _, offer, _ = select_promotion(promo)
    _, actual_rate, estimated_rate = rates(snapshot.zec_usd, Decimal(offer['multiplier']))
    return {
        "zec_promotion": offer,
        "zec_usd": str(snapshot.zec_usd),
        "spread": str(constants.ZEC_SETTLEMENT_SPREAD),
        "tuzis_per_zec": str(actual_rate),
        "estimate_buffer": str(constants.ZEC_ESTIMATE_BUFFER),
        "estimated_tuzis_per_zec": str(estimated_rate),
        "tuzi_per_usd": constants.TUZI_PER_USD,
        "usd_per_tuzi": str(constants.USD_PER_TUZI),
        "num_sources": snapshot.num_sources,
        "sources": snapshot.sources,
        "updated_at": snapshot.created_at.isoformat(),
        "stale": stale,
        "bootstrap": bootstrap,
        "card": {
            "percent_fee": str(constants.CARD_PERCENT_FEE),
            "min_fee_cents": constants.CARD_MIN_FEE_CENTS,
        },
    }
