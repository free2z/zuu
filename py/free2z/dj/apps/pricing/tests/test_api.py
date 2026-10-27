"""Public pricing API against real Postgres."""
from decimal import Decimal

import pytest

from dj.apps.pricing import service
from dj.apps.pricing.models import ZecPriceSnapshot

pytestmark = pytest.mark.django_db


def _snapshot(zec_usd="1000", spread="0.10"):
    from dj.apps.pricing import constants
    return ZecPriceSnapshot.objects.create(
        zec_usd=Decimal(zec_usd),
        median_usd=Decimal(zec_usd),
        spread=Decimal(spread),
        tuzis_per_zec=constants.tuzis_per_zec(Decimal(zec_usd), Decimal(spread)),
        num_sources=3,
        sources={"kraken": zec_usd, "coinbase": zec_usd, "gemini": zec_usd},
    )


def test_pricing_is_public_and_returns_current(api_client):
    _snapshot()
    resp = api_client.get("/api/pricing/")
    assert resp.status_code == 200
    data = resp.json()
    assert data["tuzis_per_zec"] == "100000.0000"
    assert data["estimated_tuzis_per_zec"] == "90000.0000"
    assert data["spread"] == "0" and data["estimate_buffer"] == "0.10"
    assert data["zec_usd"] == "1000.000000"
    assert data["tuzi_per_usd"] == 100
    assert data["num_sources"] == 3
    assert data["card"]["percent_fee"] == "0.10"
    assert data["card"]["min_fee_cents"] == 50
    assert data["stale"] is False


def test_pricing_serves_bootstrap_estimate_when_no_data(api_client, mocker):
    # No snapshot in the DB and no sources responding: display falls back to a
    # best-guess estimate instead of hard-failing, flagged bootstrap+stale.
    mocker.patch("dj.apps.pricing.service.fetch_all_prices", return_value={})
    resp = api_client.get("/api/pricing/")
    assert resp.status_code == 200
    data = resp.json()
    assert data["bootstrap"] is True
    assert data["stale"] is True
    assert data["num_sources"] == 0
    # Bootstrap ZEC guess is a sane number, not the old $25-implied 2500.
    assert data["zec_usd"] == "500.000000"
    assert data["tuzis_per_zec"] == "50000.0000"
    assert data["estimated_tuzis_per_zec"] == "45000.0000"


def test_quote_returns_amounts(api_client):
    _snapshot(zec_usd="1000")
    resp = api_client.get("/api/pricing/quote/?tuzis=90000")
    assert resp.status_code == 200
    data = resp.json()
    assert data["tuzis"] == 90000
    # 90000 2Z at $1000 ZEC (10% spread) == 1 ZEC.
    assert data["zec_amount"] == "1.00000000"
    # Card: $900.00 base + max(50c, 10%) = 9000c fee -> $990.00.
    assert data["card_cents"] == 99000
    assert data["card_currency"] == "usd"
    assert data["card_pricing_version"] == "card-v3"
    assert data["bootstrap"] is False
    assert data["stale"] is False


def test_quote_bootstrap_is_flagged_not_fresh(api_client, mocker):
    # Cold start: quote must flag the estimate and not present it as fresh, so a
    # buyer can't act on a bootstrap-priced ZEC amount thinking it's live.
    mocker.patch("dj.apps.pricing.service.fetch_all_prices", return_value={})
    resp = api_client.get("/api/pricing/quote/?tuzis=45000")
    assert resp.status_code == 200
    data = resp.json()
    assert data["bootstrap"] is True
    assert data["stale"] is True


def test_quote_requires_valid_tuzis(api_client):
    _snapshot()
    assert api_client.get("/api/pricing/quote/").status_code == 400
    assert api_client.get("/api/pricing/quote/?tuzis=0").status_code == 400
    assert api_client.get("/api/pricing/quote/?tuzis=abc").status_code == 400
    assert api_client.get("/api/pricing/quote/?tuzis=1.0").status_code == 400
    assert api_client.get("/api/pricing/quote/?tuzis=01").status_code == 400
    assert (
        api_client.get("/api/pricing/quote/?tuzis=1000001").status_code
        == 400
    )


def test_promotion_preview_shares_rates_and_never_reserves(api_client):
    from datetime import timedelta
    from django.utils import timezone
    from dj.apps.economy.models import ZecPromotion,FundingReservation
    from dj.apps.purchases.models import PurchaseIntent
    from dj.apps.economy.tests.test_foundation import activate_for_test
    from django.db import transaction
    with transaction.atomic():activate_for_test()
    _snapshot()
    now=timezone.now()
    ZecPromotion.objects.update_or_create(code='',defaults={'title':'Launch','enabled':True,'multiplier':Decimal(2),'ends_at':now+timedelta(hours=1)})
    ZecPromotion.objects.update_or_create(code='ZODL',defaults={'title':'Wallet','enabled':True,'multiplier':Decimal(3),'ends_at':now+timedelta(hours=1)})
    for code,multiplier,title,status in [('',2,'Launch','none'),(' zodl ',3,'Wallet','active'),('unknown',2,'Launch','unavailable'),('ſ',2,'Launch','unavailable')]:
        data=api_client.get('/api/pricing/',{'promo':code}).json()
        assert Decimal(data['tuzis_per_zec'])==100000*multiplier
        assert Decimal(data['estimated_tuzis_per_zec'])==90000*multiplier
        assert data['zec_promotion']['title']==title and data['zec_promotion']['code_status']==status
    assert not PurchaseIntent.objects.exists() and not FundingReservation.objects.exists()


def test_future_snapshot_is_not_fresh(api_client):
    from datetime import timedelta
    from django.utils import timezone
    snapshot=_snapshot();ZecPriceSnapshot.objects.filter(pk=snapshot.pk).update(created_at=timezone.now()+timedelta(seconds=30))
    assert api_client.get('/api/pricing/').json()['stale'] is True


def test_policy_zero_previews_no_promotions_until_supported_writer(api_client):
    from datetime import timedelta
    from django.utils import timezone
    from dj.apps.economy.models import ZecPromotion
    _snapshot()
    for code in ['', 'ZODL']:
        ZecPromotion.objects.update_or_create(code=code,defaults={'title':'Unsupported','enabled':True,'multiplier':Decimal(2),'ends_at':timezone.now()+timedelta(hours=1)})
    for code in ['', 'ZODL']:
        payload=api_client.get('/api/pricing/',{'promo':code}).json()
        assert payload['zec_promotion']['multiplier']=='1' and Decimal(payload['tuzis_per_zec'])==100000
        quote=api_client.get('/api/pricing/quote/',{'tuzis':'90000','promo':code}).json()
        assert quote['zec_amount']=='1.00000000'
