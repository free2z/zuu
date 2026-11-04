"""Publish rate card v2 with GPT-4o's verified cached-input price.

Verified 2026-09-28 against the official model page:
https://developers.openai.com/api/docs/models/gpt-4o
Input $2.50/M, cached input $1.25/M, output $10/M. All other rows and
prices are unchanged. Published v1 remains immutable and active for existing
pricing snapshots; catalogue selection uses the newest published active card.
Reverse is a no-op: published pricing history must never be deleted.
"""
from django.db import migrations
from django.db.models.functions import Now


VERSION = 2
PLATFORM_MARGIN_BPS = 2000
MIN_MARGIN_BPS = 0

# (model_id, input, cached_input, cache_write_5m, cache_write_1h, output,
#  image_nusd, tool_call_nusd, min_charge_2z) -- token prices in nano-USD
# per MILLION tokens.
ROWS = (
    ('gpt-4o', 2_500_000_000, 1_250_000_000, 2_500_000_000, 2_500_000_000, 10_000_000_000, 0, 0, 1),
    ('claude-opus-4-8', 5_000_000_000, 500_000_000, 6_250_000_000, 10_000_000_000, 25_000_000_000, 0, 0, 1),
    ('claude-sonnet-5', 3_000_000_000, 300_000_000, 3_750_000_000, 6_000_000_000, 15_000_000_000, 0, 0, 1),
    ('claude-haiku-4-5', 1_000_000_000, 100_000_000, 1_250_000_000, 2_000_000_000, 5_000_000_000, 0, 0, 1),
    ('gpt-5.6-sol', 5_000_000_000, 5_000_000_000, 5_000_000_000, 5_000_000_000, 30_000_000_000, 0, 0, 1),
    ('gpt-5.6-terra', 2_500_000_000, 2_500_000_000, 2_500_000_000, 2_500_000_000, 15_000_000_000, 0, 0, 1),
    ('gpt-5.6-luna', 1_000_000_000, 1_000_000_000, 1_000_000_000, 1_000_000_000, 6_000_000_000, 0, 0, 1),
    ('grok-4.5', 1_250_000_000, 1_250_000_000, 1_250_000_000, 1_250_000_000, 2_500_000_000, 0, 0, 1),
    ('grok-4.3', 1_250_000_000, 1_250_000_000, 1_250_000_000, 1_250_000_000, 2_500_000_000, 0, 0, 1),
    ('kimi-k3', 600_000_000, 600_000_000, 600_000_000, 600_000_000, 2_500_000_000, 0, 0, 1),
    ('kimi-k2.6', 600_000_000, 600_000_000, 600_000_000, 600_000_000, 2_500_000_000, 0, 0, 1),
)

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
        actual = list(RateCardModel.objects.filter(rate_card=existing)
                      .order_by('model_id').values_list(*COLUMNS))
        if (existing.platform_margin_bps != PLATFORM_MARGIN_BPS
                or existing.min_margin_bps != MIN_MARGIN_BPS
                or existing.published_at is None or not existing.active
                or actual != sorted(ROWS, key=lambda row: row[0])):
            raise RuntimeError("rate card v2 conflicts with the verified GPT-4o pricing seed")
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
        ('pricing', '0003_seed_rate_card_v1'),
    ]

    operations = [
        migrations.RunPython(seed, migrations.RunPython.noop),
    ]
