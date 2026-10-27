"""
Live ZEC/USD price sources.

Each source is a small adapter that hits a public, no-auth REST endpoint of an
exchange or aggregator and returns a positive ``Decimal`` USD price, or ``None``
if it can't (network error, unexpected shape, non-positive value). Sources that
quote against USDT are treated as ~USD; the outlier filter in
``aggregation.py`` discards any that drift too far from the pack.

Add or remove a source by editing ``SOURCES`` — the rest of the pipeline is
source-agnostic.
"""
import logging
import time
from concurrent.futures import Future, wait
from decimal import Decimal, InvalidOperation
from threading import Thread
from typing import Callable, Dict, Optional

import requests

from . import constants

logger = logging.getLogger(__name__)

# A source: name -> function(session) -> Decimal price in USD (or None).
Source = Callable[[requests.Session], Optional[Decimal]]


def _to_decimal(value) -> Optional[Decimal]:
    try:
        d = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    if d <= 0:
        return None
    return d


def _get_json(session: requests.Session, url: str):
    resp = session.get(url, timeout=constants.SOURCE_TIMEOUT_SECONDS)
    resp.raise_for_status()
    return resp.json()


# --- Adapters ---------------------------------------------------------------

def coinbase(session: requests.Session) -> Optional[Decimal]:
    data = _get_json(session, "https://api.coinbase.com/v2/prices/ZEC-USD/spot")
    return _to_decimal(data["data"]["amount"])


def kraken(session: requests.Session) -> Optional[Decimal]:
    data = _get_json(
        session, "https://api.kraken.com/0/public/Ticker?pair=ZECUSD")
    result = data["result"]
    # Kraken keys the pair oddly (e.g. "ZECUSD"); take the first entry.
    pair = next(iter(result.values()))
    return _to_decimal(pair["c"][0])  # c = last trade closed [price, lot]


def gemini(session: requests.Session) -> Optional[Decimal]:
    data = _get_json(session, "https://api.gemini.com/v1/pubticker/zecusd")
    return _to_decimal(data["last"])


def coingecko(session: requests.Session) -> Optional[Decimal]:
    data = _get_json(
        session,
        "https://api.coingecko.com/api/v3/simple/price"
        "?ids=zcash&vs_currencies=usd",
    )
    return _to_decimal(data["zcash"]["usd"])


def bitfinex(session: requests.Session) -> Optional[Decimal]:
    data = _get_json(
        session, "https://api-pub.bitfinex.com/v2/ticker/tZECUSD")
    # [BID, BID_SIZE, ASK, ASK_SIZE, DAILY_CHANGE, DAILY_CHANGE_REL,
    #  LAST_PRICE, VOLUME, HIGH, LOW]
    return _to_decimal(data[6])


def coinpaprika(session: requests.Session) -> Optional[Decimal]:
    data = _get_json(
        session, "https://api.coinpaprika.com/v1/tickers/zec-zcash")
    return _to_decimal(data["quotes"]["USD"]["price"])


def kucoin(session: requests.Session) -> Optional[Decimal]:
    data = _get_json(
        session,
        "https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=ZEC-USDT",
    )
    return _to_decimal((data.get("data") or {}).get("price"))


# Registry. Order is irrelevant — fetching is concurrent.
SOURCES: Dict[str, Source] = {
    "coinbase": coinbase,
    "kraken": kraken,
    "gemini": gemini,
    "coingecko": coingecko,
    "bitfinex": bitfinex,
    "coinpaprika": coinpaprika,
    "kucoin": kucoin,
}


def fetch_one(name: str, source: Source) -> Optional[Decimal]:
    """Run a single source, swallowing any error into ``None``.

    Uses its own short-lived ``requests.Session`` so nothing is shared across
    threads (``Session`` state is not guaranteed thread-safe).
    """
    try:
        with requests.Session() as session:
            session.headers.update({"User-Agent": "free2z-pricing/1.0"})
            price = source(session)
    except Exception as exc:  # network, JSON shape, key errors — all non-fatal
        logger.warning("pricing source %s failed: %s", name, exc)
        return None
    if price is None:
        logger.warning("pricing source %s returned no usable price", name)
    return price


def _run_source(future: Future, name: str, source: Source) -> None:
    """Resolve one source future without leaving it pending on worker errors."""
    try:
        future.set_result(fetch_one(name, source))
    except BaseException as exc:
        # ``fetch_one`` turns ordinary source failures into ``None``. Keep the
        # Future complete even if a custom source escapes with a BaseException,
        # so the batch can still collect the other sources at its deadline.
        future.set_exception(exc)


def fetch_all_prices(sources: Dict[str, Source] = None) -> Dict[str, Decimal]:
    """Poll every source concurrently within one wall-clock batch budget.

    A worker that ignores its request timeout can continue in the background,
    but it must not hold up this caller. Workers are daemon threads rather than
    ``ThreadPoolExecutor`` workers: the latter are joined by Python during
    interpreter shutdown even after ``shutdown(wait=False)``.
    """
    sources = SOURCES if sources is None else sources
    prices: Dict[str, Decimal] = {}
    deadline = time.monotonic() + constants.SOURCE_BATCH_TIMEOUT_SECONDS
    futures: Dict[Future, str] = {}
    for name, fn in sources.items():
        future = Future()
        futures[future] = name
        Thread(
            target=_run_source,
            args=(future, name, fn),
            name=f"pricing-source-{name}",
            daemon=True,
        ).start()
    completed, pending = wait(
        futures, timeout=max(0, deadline - time.monotonic()))
    for future in completed:
        name = futures[future]
        try:
            price = future.result()
        except BaseException as exc:
            # fetch_one normally turns source failures into None, but keep
            # the aggregation batch non-fatal if a worker itself escapes.
            logger.warning("pricing source %s failed: %s", name, exc)
            continue
        if price is not None:
            prices[name] = price
    if pending:
        logger.warning(
            "pricing source batch timed out after %.1fs; %d source(s) "
            "still running",
            constants.SOURCE_BATCH_TIMEOUT_SECONDS,
            len(pending),
        )
    return prices
