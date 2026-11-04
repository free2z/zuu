"""Seed rate card v1: published, active, 2000 bps (#2222, ledger-v2 §9).

HISTORY -- NEVER EDIT THIS FILE. Once applied, ``migrate`` never re-runs it
and ``seed`` below returns early when v1 exists, so an edit here would give
FRESH databases a different "v1" than prod already has. Repricing, adding or
removing a model is a NEW migration ``NNNN_seed_rate_card_v2.py`` (copy this
file, bump ``VERSION``, paste ``seed_ai_models.rate_card_rows()`` as
``ROWS``). ``dj/apps/pricing/tests/test_rate_card.py`` pins this file's rows
to a recorded digest and compares LINEUP against the NEWEST seed only; its
failure message names the file to add. See ``dj.apps.pricing.rate_card_seeds``.

The rows were, when this was written, ``seed_ai_models.rate_card_rows()``
(copied, because migrations must not import live code).

Input/output prices are LINEUP's per-token USD prices converted exactly to
nano-USD per million tokens. Cache prices follow ``CACHE_PRICE_FRACTIONS``:
Anthropic's documented 0.1x read / 1.25x 5m write / 2x 1h write, and the
uncached input price for every other provider (no verified discount -- an
overcharge relative to the discount, never an undercharge). Image and tool
prices are 0: images are billed as input tokens, and no server-side tool is
offered. ``min_charge_2z`` is 1 for every model.

Idempotent and additive: creates v1 only when no v1 exists, touches nothing
else. Nothing reads the card yet, so an old pod is unaffected. The reverse
is a no-op on purpose -- the card is published, and the trigger in 0002 is
what makes a published card undeletable.
"""
from django.db import migrations
from django.db.models.functions import Now


VERSION = 1
PLATFORM_MARGIN_BPS = 2000
MIN_MARGIN_BPS = 0

# (model_id, input, cached_input, cache_write_5m, cache_write_1h, output,
#  image_nusd, tool_call_nusd, min_charge_2z) -- token prices in nano-USD
# per MILLION tokens.
ROWS = (
    ('gpt-4o', 2_500_000_000, 2_500_000_000, 2_500_000_000, 2_500_000_000, 10_000_000_000, 0, 0, 1),
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
    if RateCard.objects.filter(version=VERSION).exists():
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
        ('pricing', '0002_ratecard'),
    ]

    operations = [
        migrations.RunPython(seed, migrations.RunPython.noop),
    ]
