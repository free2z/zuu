"""
Turn a bag of per-source ZEC/USD quotes into one trustworthy number.

Algorithm:
  1. Compute the median of all quotes (robust to outliers).
  2. Drop any quote that deviates from the median by more than
     ``OUTLIER_THRESHOLD`` (default 10%) — this rules out a single glitched or
     stale exchange book.
  3. Average what's left. That mean is the ZEC/USD we price against.

If the outlier filter would leave nothing (e.g. two sources 50% apart, no
majority), we fall back to the median so we still return a sane value.
"""
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Dict, List

from .constants import OUTLIER_THRESHOLD


def _median(values: List[Decimal]) -> Decimal:
    ordered = sorted(values)
    n = len(ordered)
    mid = n // 2
    if n % 2 == 1:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / Decimal(2)


@dataclass
class AggregateResult:
    zec_usd: Decimal
    median: Decimal
    used: Dict[str, Decimal] = field(default_factory=dict)
    rejected: Dict[str, Decimal] = field(default_factory=dict)

    @property
    def num_sources(self) -> int:
        return len(self.used)


def aggregate(prices: Dict[str, Decimal],
              outlier_threshold: Decimal = OUTLIER_THRESHOLD) -> AggregateResult:
    """Aggregate ``{source: price}`` into a single spread-free ZEC/USD value."""
    if not prices:
        raise ValueError("cannot aggregate an empty set of prices")

    values = list(prices.values())
    median = _median(values)

    used: Dict[str, Decimal] = {}
    rejected: Dict[str, Decimal] = {}
    for name, price in prices.items():
        deviation = abs(price - median) / median if median else Decimal(0)
        if deviation <= outlier_threshold:
            used[name] = price
        else:
            rejected[name] = price

    if used:
        zec_usd = sum(used.values()) / Decimal(len(used))
    else:
        # No source agreed with the median (e.g. two quotes far apart, no
        # majority). Report the robust median as the value but leave `used`
        # empty so callers can enforce a source floor and refuse to price off
        # it — do NOT re-average the outliers we just rejected.
        zec_usd = median

    return AggregateResult(
        zec_usd=zec_usd,
        median=median,
        used=used,
        rejected=rejected,
    )
