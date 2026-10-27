"""Service layer against real Postgres; only the HTTP boundary is mocked."""
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from dj.apps.pricing import constants
from dj.apps.pricing import service
from dj.apps.pricing.models import ZecPriceSnapshot

pytestmark = pytest.mark.django_db


def _prices(**kw):
    return {k: Decimal(str(v)) for k, v in kw.items()}


def test_refresh_creates_snapshot(mocker, caplog):
    caplog.set_level("INFO", logger="dj.apps.pricing.service")
    mocker.patch(
        "dj.apps.pricing.service.fetch_all_prices",
        return_value=_prices(kraken=1000, coinbase=1002, gemini=998),
    )
    snap = service.refresh_snapshot()

    assert ZecPriceSnapshot.objects.count() == 1
    assert snap.zec_usd == Decimal("1000.000000")
    assert snap.num_sources == 3
    # 1000 * (1 - 0.10) * 100
    assert snap.tuzis_per_zec == Decimal("90000.0000")
    assert set(snap.sources) == {"kraken", "coinbase", "gemini"}
    assert any("pricing: ZEC=" in record.getMessage()
               for record in caplog.records)


def test_refresh_rejects_outlier(mocker):
    mocker.patch(
        "dj.apps.pricing.service.fetch_all_prices",
        return_value=_prices(a=1000, b=1000, c=1000, glitch=5000),
    )
    snap = service.refresh_snapshot()
    assert "glitch" in snap.rejected
    assert snap.zec_usd == Decimal("1000.000000")


def test_refresh_no_sources_raises(mocker):
    mocker.patch("dj.apps.pricing.service.fetch_all_prices", return_value={})
    with pytest.raises(service.PricingUnavailable):
        service.refresh_snapshot()


def test_refresh_requires_min_sources(mocker):
    # Fewer than MIN_SOURCES (3) responders -> refuse to record a price, so one
    # thin/glitched exchange can't set the credited rate. Nothing persisted.
    mocker.patch(
        "dj.apps.pricing.service.fetch_all_prices",
        return_value=_prices(only=9999),
    )
    with pytest.raises(service.PricingUnavailable):
        service.refresh_snapshot()
    mocker.patch(
        "dj.apps.pricing.service.fetch_all_prices",
        return_value=_prices(a=1000, b=1000),
    )
    with pytest.raises(service.PricingUnavailable):
        service.refresh_snapshot()
    assert ZecPriceSnapshot.objects.count() == 0


def test_refresh_requires_agreement_after_outlier_rejection(mocker):
    # Enough responders but they don't agree within the band (all far apart) ->
    # refuse rather than average disagreeing quotes.
    mocker.patch(
        "dj.apps.pricing.service.fetch_all_prices",
        return_value=_prices(a=1000, b=1500, c=2200),
    )
    with pytest.raises(service.PricingUnavailable):
        service.refresh_snapshot()
    assert ZecPriceSnapshot.objects.count() == 0


def test_current_tuzis_per_zec_uses_latest(mocker):
    mocker.patch(
        "dj.apps.pricing.service.fetch_all_prices",
        return_value=_prices(a=2000, b=2000, c=2000),
    )
    service.refresh_snapshot()
    # 2000 * 0.9 * 100
    assert service.current_tuzis_per_zec() == Decimal("200000.0000")


def test_crediting_refuses_stale_snapshot_when_refresh_fails(mocker):
    fetch = mocker.patch(
        "dj.apps.pricing.service.fetch_all_prices",
        return_value=_prices(a=2000, b=2000, c=2000),
    )
    service.refresh_snapshot()
    mocker.patch("dj.apps.pricing.constants.SNAPSHOT_MAX_AGE_SECONDS", -1)
    fetch.return_value = {}

    with pytest.raises(service.PricingUnavailable):
        service.current_tuzis_per_zec()
    assert fetch.call_count == 2


def test_crediting_refuses_a_rate_the_market_may_have_left_behind(mocker):
    """The cached-rate fallback is bounded, or it is a frozen constant.

     was a hardcoded 2,500 2Z/ZEC surviving into a $750/ZEC world. An
    unbounded stale fallback gets to the same place by a different route: once
    one snapshot exists, a prolonged exchange outage means every purchase is
    credited at whatever the market said before the outage, forever, with a
    healthy heartbeat and a zero exit.

    ZEC_SPREAD is 10% and ZEC has moved further than that inside a day, so the
    spread does not cover an unbounded age -- in one direction we are
    arbitraged, in the other the buyer is short-changed.

    Negative control: delete the age check in ``current_tuzis_per_zec`` and
    this fails -- the 25-hour-old rate is returned and nothing is deferred.
    """
    fetch = mocker.patch(
        "dj.apps.pricing.service.fetch_all_prices",
        return_value=_prices(a=2000, b=2000, c=2000),
    )
    stored = service.refresh_snapshot()
    # Age the only snapshot well past the crediting bound, and take the
    # exchanges away so no refresh can rescue it.
    stored.created_at = timezone.now() - timedelta(
        seconds=constants.CREDIT_MAX_SNAPSHOT_AGE_SECONDS + 3600)
    stored.save(update_fields=["created_at"])
    fetch.return_value = {}

    with pytest.raises(service.PricingUnavailable):
        service.current_tuzis_per_zec()


def test_crediting_still_uses_a_rate_inside_the_bound(mocker):
    """The bound must not turn every brief outage into a deferral.

    A guard that fires too eagerly stops purchases from being credited at all
    during a five-minute exchange blip, which is worse than the spread it was
    protecting. Just inside the limit, the cached rate is still used.
    """
    fetch = mocker.patch(
        "dj.apps.pricing.service.fetch_all_prices",
        return_value=_prices(a=2000, b=2000, c=2000),
    )
    stored = service.refresh_snapshot()
    stored.created_at = timezone.now() - timedelta(
        seconds=constants.SNAPSHOT_MAX_AGE_SECONDS - 60)
    stored.save(update_fields=["created_at"])
    fetch.return_value = {}

    assert service.current_tuzis_per_zec() == constants.tuzis_per_zec(stored.zec_usd, constants.ZEC_SETTLEMENT_SPREAD)


def test_the_display_path_is_not_bounded_by_the_crediting_limit(mocker):
    """Display keeps serving an old price; only CREDITING refuses it.

    A blank rate on the buy page is not safer than an old one clearly labelled
    an estimate -- and `get_pricing` already flags `stale`. The bound exists to
    stop us ISSUING 2Z at a rate nobody can vouch for, not to blank the UI.
    """
    fetch = mocker.patch(
        "dj.apps.pricing.service.fetch_all_prices",
        return_value=_prices(a=2000, b=2000, c=2000),
    )
    stored = service.refresh_snapshot()
    stored.created_at = timezone.now() - timedelta(
        seconds=constants.CREDIT_MAX_SNAPSHOT_AGE_SECONDS + 3600)
    stored.save(update_fields=["created_at"])
    fetch.return_value = {}

    payload = service.get_pricing()
    assert payload["tuzis_per_zec"] == str(constants.tuzis_per_zec(stored.zec_usd, constants.ZEC_SETTLEMENT_SPREAD))
    assert payload["estimated_tuzis_per_zec"] == str(stored.tuzis_per_zec)
    assert payload["stale"] is True
    assert payload["bootstrap"] is False


def test_refresh_lock_outlives_bounded_source_batch():
    assert service._refresh_lock_timeout() > constants.SOURCE_BATCH_TIMEOUT_SECONDS


def test_refresh_lock_timeout_reads_runtime_batch_budget(mocker):
    mocker.patch.object(constants, "SOURCE_BATCH_TIMEOUT_SECONDS", 30.5)
    assert service._refresh_lock_timeout() == 35


def test_get_current_snapshot_serves_stale_without_refresh(mocker):
    fetch = mocker.patch(
        "dj.apps.pricing.service.fetch_all_prices",
        return_value=_prices(a=1000, b=1000, c=1000),
    )
    first = service.refresh_snapshot()
    # A stale read must not make a synchronous request fan out to exchanges.
    mocker.patch("dj.apps.pricing.constants.SNAPSHOT_MAX_AGE_SECONDS", -1)
    second = service.get_current_snapshot()

    assert second.pk == first.pk
    assert ZecPriceSnapshot.objects.count() == 1
    fetch.assert_called_once()


def test_crediting_is_strict_no_bootstrap(mocker):
    # Crediting must NOT invent a rate: with no real snapshot it raises so the
    # purchase is deferred rather than credited at a guess.
    mocker.patch("dj.apps.pricing.service.fetch_all_prices", return_value={})
    with pytest.raises(service.PricingUnavailable):
        service.get_current_snapshot()  # allow_bootstrap defaults to False
    with pytest.raises(service.PricingUnavailable):
        service.current_tuzis_per_zec()


def test_display_bootstrap_when_no_history_and_no_sources(mocker):
    # Display path may fall back to a best-guess estimate (unsaved, num_sources 0).
    mocker.patch("dj.apps.pricing.service.fetch_all_prices", return_value={})
    snap = service.get_current_snapshot(allow_bootstrap=True)
    assert snap.pk is None
    assert snap.num_sources == 0
    assert snap.zec_usd == Decimal("500")
    #...and get_pricing surfaces it flagged as a bootstrap estimate.
    payload = service.get_pricing()
    assert payload["bootstrap"] is True
    assert ZecPriceSnapshot.objects.count() == 0  # nothing persisted


def test_display_prefers_cached_over_bootstrap(mocker):
    good = mocker.patch(
        "dj.apps.pricing.service.fetch_all_prices",
        return_value=_prices(a=600, b=600, c=600),
    )
    service.refresh_snapshot()
    # A stale display read serves the cached $600, NOT the $500 bootstrap, and
    # does not synchronously poll a source from the web request path.
    mocker.patch("dj.apps.pricing.constants.SNAPSHOT_MAX_AGE_SECONDS", -1)
    payload = service.get_pricing()
    assert payload["zec_usd"] == "600.000000"
    assert payload["bootstrap"] is False
    good.assert_called_once()


def test_get_pricing_payload_shape(mocker):
    mocker.patch(
        "dj.apps.pricing.service.fetch_all_prices",
        return_value=_prices(a=1000, b=1000, c=1000),
    )
    service.refresh_snapshot()
    payload = service.get_pricing()

    assert payload["tuzis_per_zec"] == "100000.0000"
    assert payload["estimated_tuzis_per_zec"] == "90000.0000"
    assert payload["zec_usd"] == "1000.000000"
    assert payload["tuzi_per_usd"] == 100
    assert payload["spread"] == "0"
    assert payload["estimate_buffer"] == "0.10"
    assert payload["stale"] is False
    assert payload["card"]["percent_fee"] == "0.10"
    assert payload["card"]["min_fee_cents"] == 50


def test_crediting_refuses_future_snapshot(mocker):
    from datetime import timedelta
    from django.utils import timezone
    snap=ZecPriceSnapshot.objects.create(zec_usd=Decimal(100),median_usd=Decimal(100),spread=Decimal('.10'),tuzis_per_zec=Decimal(9000),num_sources=2,sources={'coinbase':'100','kraken':'100'})
    ZecPriceSnapshot.objects.filter(pk=snap.pk).update(created_at=timezone.now()+timedelta(seconds=30))
    mocker.patch('dj.apps.pricing.service.fetch_all_prices',return_value={})
    with pytest.raises(service.PricingUnavailable):service.current_tuzis_per_zec()
