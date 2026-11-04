"""Regression tests for the PPV admission reserve from issue."""
from decimal import Decimal

import pytest

from dj.apps.dyte.views import ppv_join_threshold


@pytest.mark.parametrize(
    "price, expected",
    [
        (Decimal("100"), 3015),
        (Decimal("0.29"), 24),
        (Decimal("0.01"), 16),
        ("1.20", 51),
        (0.29, 24),
        ("9999.99", 300015),
    ],
)
def test_ppv_join_threshold_matches_the_admission_gate(price, expected):
    assert ppv_join_threshold(price) == expected


@pytest.mark.parametrize(
    "price",
    [
        None,
        "",
        "0",
        Decimal("-1"),
        Decimal("NaN"),
        Decimal("Infinity"),
        "1.234",
        "10000",
    ],
)
def test_ppv_join_threshold_rejects_invalid_or_overprecise_prices(price):
    assert ppv_join_threshold(price) is None
