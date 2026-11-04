"""Outlier rejection + averaging — no DB required."""
from decimal import Decimal

import pytest

from dj.apps.pricing.aggregation import aggregate


def D(x):
    return Decimal(str(x))


def test_averages_tight_cluster():
    r = aggregate({'a': D(1000), 'b': D(1002), 'c': D(998)})
    assert r.zec_usd == D(1000)
    assert r.num_sources == 3
    assert not r.rejected


def test_rejects_high_outlier():
    r = aggregate({'a': D(1000), 'b': D(1002), 'c': D(998), 'glitch': D(1500)})
    assert 'glitch' in r.rejected
    assert set(r.used) == {'a', 'b', 'c'}
    assert r.zec_usd == D(1000)


def test_rejects_low_outlier():
    r = aggregate({'a': D(1000), 'b': D(1000), 'c': D(1000), 'stale': D(500)})
    assert 'stale' in r.rejected
    assert r.zec_usd == D(1000)


def test_within_threshold_kept():
    # 9% deviation is within the 10% default threshold.
    r = aggregate({'a': D(1000), 'b': D(1090)})
    assert not r.rejected
    assert r.zec_usd == D(1045)


def test_no_agreement_reports_median_and_empty_used():
    # Two sources 50% apart: no majority agrees with the median, so `used` is
    # empty (num_sources 0) and we report the robust median — NOT the mean of
    # the rejected outliers. Callers enforce a source floor on num_sources.
    r = aggregate({'a': D(1000), 'b': D(2000)})
    assert r.num_sources == 0
    assert set(r.rejected) == {'a', 'b'}
    assert r.zec_usd == D(1500)  # the median, not the mean-of-outliers


def test_median_even_count():
    r = aggregate({'a': D(1000), 'b': D(1010)})
    assert r.median == D(1005)


def test_empty_raises():
    with pytest.raises(ValueError):
        aggregate({})


def test_single_source():
    r = aggregate({'only': D(1234)})
    assert r.zec_usd == D(1234)
    assert r.num_sources == 1
