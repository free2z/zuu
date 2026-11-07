"""Immutable standard-price card reviewed 2026-11-07.

See docs/free2z/ai-provider-catalog.md for sources, restrictions and expiry.
"""
from django.db import migrations
from django.db.models.functions import Now


VERSION = 4
PLATFORM_MARGIN_BPS = 2000
MIN_MARGIN_BPS = 0

# (model_id, input, cached_input, cache_write_5m, cache_write_1h, output,
#  image_nusd, tool_call_nusd, min_charge_2z) -- token prices in nano-USD
# per MILLION tokens.
ROWS = (('gpt-4o', 2500000000, 1250000000, 2500000000, 2500000000, 10000000000, 0, 0, 1),
 ('gpt-6.1-sol', 2000000000, 100000000, 2500000000, 2500000000, 10000000000, 0, 0, 1),
 ('gpt-6.1-terra', 1000000000, 50000000, 1250000000, 1250000000, 5000000000, 0, 0, 1),
 ('gpt-6-astra', 10000000000, 1000000000, 12500000000, 12500000000, 50000000000, 0, 0, 1),
 ('gpt-6-sol', 2000000000, 200000000, 2500000000, 2500000000, 10000000000, 0, 0, 1),
 ('gpt-6-luna', 100000000, 10000000, 125000000, 125000000, 500000000, 0, 0, 1),
 ('gpt-5.5', 5000000000, 500000000, 5000000000, 5000000000, 30000000000, 0, 0, 1),
 ('gpt-5.4', 2500000000, 250000000, 2500000000, 2500000000, 15000000000, 0, 0, 1),
 ('gpt-5.6-sol', 4000000000, 400000000, 5000000000, 5000000000, 20000000000, 0, 0, 1),
 ('gpt-5.6-terra', 2000000000, 200000000, 2500000000, 2500000000, 12000000000, 0, 0, 1),
 ('gpt-5.6-luna', 200000000, 20000000, 250000000, 250000000, 1200000000, 0, 0, 1),
 ('gpt-5.4-mini', 750000000, 75000000, 750000000, 750000000, 4500000000, 0, 0, 1),
 ('gpt-5.4-nano', 200000000, 20000000, 200000000, 200000000, 1250000000, 0, 0, 1),
 ('gpt-5.2', 1750000000, 175000000, 1750000000, 1750000000, 14000000000, 0, 0, 1),
 ('gpt-5.1', 1250000000, 125000000, 1250000000, 1250000000, 10000000000, 0, 0, 1),
 ('gpt-5', 1250000000, 125000000, 1250000000, 1250000000, 10000000000, 0, 0, 1),
 ('gpt-5-mini', 250000000, 25000000, 250000000, 250000000, 2000000000, 0, 0, 1),
 ('gpt-5-nano', 50000000, 5000000, 50000000, 50000000, 400000000, 0, 0, 1),
 ('gpt-4.1', 2000000000, 500000000, 2000000000, 2000000000, 8000000000, 0, 0, 1),
 ('gpt-4.1-mini', 400000000, 100000000, 400000000, 400000000, 1600000000, 0, 0, 1),
 ('gpt-4.1-nano', 100000000, 25000000, 100000000, 100000000, 400000000, 0, 0, 1),
 ('gpt-4o-mini', 150000000, 75000000, 150000000, 150000000, 600000000, 0, 0, 1),
 ('o3', 2000000000, 500000000, 2000000000, 2000000000, 8000000000, 0, 0, 1),
 ('o4-mini', 1100000000, 275000000, 1100000000, 1100000000, 4400000000, 0, 0, 1),
 ('o3-mini', 1100000000, 550000000, 1100000000, 1100000000, 4400000000, 0, 0, 1),
 ('o1', 15000000000, 7500000000, 15000000000, 15000000000, 60000000000, 0, 0, 1),
 ('claude-fable-5-1', 10000000000, 250000000, 12500000000, 20000000000, 50000000000, 0, 0, 1),
 ('claude-opus-5-5', 4000000000, 200000000, 5000000000, 8000000000, 20000000000, 0, 0, 1),
 ('claude-sonnet-5-5', 2000000000, 100000000, 2500000000, 4000000000, 10000000000, 0, 0, 1),
 ('claude-haiku-5-5', 100000000, 10000000, 125000000, 200000000, 500000000, 0, 0, 1),
 ('claude-fable-5', 10000000000, 1000000000, 12500000000, 20000000000, 50000000000, 0, 0, 1),
 ('claude-opus-5', 5000000000, 500000000, 6250000000, 10000000000, 25000000000, 0, 0, 1),
 ('claude-opus-4-8', 5000000000, 500000000, 6250000000, 10000000000, 25000000000, 0, 0, 1),
 ('claude-sonnet-5', 2000000000, 200000000, 2500000000, 4000000000, 10000000000, 0, 0, 1),
 ('claude-haiku-4-5', 1000000000, 100000000, 1250000000, 2000000000, 5000000000, 0, 0, 1),
 ('grok-4.7', 2000000000, 500000000, 2000000000, 2000000000, 6000000000, 0, 0, 1),
 ('grok-4.6', 2000000000, 500000000, 2000000000, 2000000000, 6000000000, 0, 0, 1),
 ('grok-4.5', 2000000000, 300000000, 2000000000, 2000000000, 6000000000, 0, 0, 1),
 ('grok-4.3', 1250000000, 200000000, 1250000000, 1250000000, 2500000000, 0, 0, 1),
 ('kimi-k3', 3000000000, 300000000, 3000000000, 6000000000, 15000000000, 0, 0, 1),
 ('kimi-k2.6', 950000000, 160000000, 950000000, 950000000, 4000000000, 0, 0, 1))

COLUMNS = (
    'model_id',
    'input_nusd_per_mtok',
    'cached_input_nusd_per_mtok',
    'cache_write_5m_nusd_per_mtok',
    'cache_write_1h_nusd_per_mtok',
    'output_nusd_per_mtok',
    'image_nusd',
    'tool_call_nusd',
    'min_charge_2z',
)


def seed(apps, schema_editor):
    RateCard = apps.get_model('pricing', 'RateCard')
    RateCardModel = apps.get_model('pricing', 'RateCardModel')
    existing = RateCard.objects.filter(version=VERSION).first()
    if existing is not None:
        # Sorted in Python on BOTH sides: Postgres' en_US collation orders
        # 'gpt-5.1' before 'gpt-5-mini' and Python the other way round, so an
        # ORDER BY here would read a correct card as a conflict.
        actual = sorted(
            RateCardModel.objects.filter(rate_card=existing).values_list(*COLUMNS),
            key=lambda row: row[0])
        if (existing.platform_margin_bps != PLATFORM_MARGIN_BPS
                or existing.min_margin_bps != MIN_MARGIN_BPS
                or existing.published_at is None or not existing.active
                or actual != sorted(ROWS, key=lambda row: row[0])):
            raise RuntimeError("rate card v4 conflicts with the 2026-11-07 audited pricing seed")
        return
    card = RateCard.objects.create(
        version=VERSION,
        platform_margin_bps=PLATFORM_MARGIN_BPS,
        min_margin_bps=MIN_MARGIN_BPS,
    )
    RateCardModel.objects.bulk_create(
        RateCardModel(rate_card=card, **dict(zip(COLUMNS, row))) for row in ROWS
    )
    # Publish LAST: from this UPDATE on, the rows above are frozen.
    RateCard.objects.filter(pk=card.pk).update(published_at=Now(), active=True)


class Migration(migrations.Migration):

    dependencies = [
        ('pricing', '0006_seed_rate_card_v3'),
        # The AIModel rows the card prices (and the 0005 trigger joins) land
        # first, so a fresh database and prod seed in the same order.
        ('openai', '0036_seed_lineup_v4'),
    ]

    operations = [
        migrations.RunPython(seed, migrations.RunPython.noop),
    ]
