"""Publish rate card v3: every model repriced from the providers' official pages.

The 2026-10-04 audit on #2224 found card v2 stale in both directions:
gpt-5.6-luna sold at 5x cost, gpt-5.6-terra and claude-sonnet-5 at 1.5x, and
grok-4.5 BELOW cost (input 1.6x, output 2.4x under). Card v3 carries the list
price of every model, verified 2026-10-05 against (all fetched that day):

  OpenAI    https://developers.openai.com/api/docs/pricing.md and
            https://developers.openai.com/api/docs/models/<id>.md per model
  Anthropic https://platform.claude.com/docs/en/docs/about-claude/pricing
  xAI       https://docs.x.ai/docs/models
  Moonshot  https://platform.moonshot.ai/docs/pricing/chat (2026-10-04)

and adds the 24 OpenAI chat models the pricing page lists with a standard
price (everything but the pro/Responses-only tier). Per model the rows hold
(USD per 1M tokens, nano-USD here): input / cached read / 5m cache write /
1h cache write / output. OpenAI bills cache writes at 1.25x input on GPT-5.6
and later (free before); it has no 1h cache, so that column mirrors the 5m
one. gpt-5.6-sol is on a promo ($4 / $20 through at least 2026-11-21) and is
priced at its pre-promo $5 / $30 because a card cannot expire a price (owner
decision item on #2224). Long-context tiers (>272K input on OpenAI's tiered
models, >=200K on xAI) are NOT priced: ``openai.0026_seed_lineup_v3`` caps
those models' context windows below the threshold instead.

``ROWS`` is ``seed_ai_models.rate_card_rows()`` at this commit, frozen;
``test_rate_card.py`` pins this file's digest and compares LINEUP against the
NEWEST seed, so a future reprice is a v4 file, never an edit here. Published
v1 and v2 stay immutable and active for the holds admitted on them; the
catalogue serves the newest published active card. Reverse is a no-op:
published pricing history must never be deleted.
"""
from django.db import migrations
from django.db.models.functions import Now


VERSION = 3
PLATFORM_MARGIN_BPS = 2000
MIN_MARGIN_BPS = 0

# (model_id, input, cached_input, cache_write_5m, cache_write_1h, output,
#  image_nusd, tool_call_nusd, min_charge_2z) -- token prices in nano-USD
# per MILLION tokens.
ROWS = (
    ('gpt-4o', 2_500_000_000, 1_250_000_000, 2_500_000_000, 2_500_000_000, 10_000_000_000, 0, 0, 1),
    ('gpt-6.1-sol', 2_000_000_000, 100_000_000, 2_500_000_000, 2_500_000_000, 10_000_000_000, 0, 0, 1),
    ('gpt-6-astra', 10_000_000_000, 1_000_000_000, 12_500_000_000, 12_500_000_000, 50_000_000_000, 0, 0, 1),
    ('gpt-6-sol', 2_000_000_000, 200_000_000, 2_500_000_000, 2_500_000_000, 10_000_000_000, 0, 0, 1),
    ('gpt-6-luna', 100_000_000, 10_000_000, 125_000_000, 125_000_000, 500_000_000, 0, 0, 1),
    ('gpt-5.5', 5_000_000_000, 500_000_000, 5_000_000_000, 5_000_000_000, 30_000_000_000, 0, 0, 1),
    ('gpt-5.4', 2_500_000_000, 250_000_000, 2_500_000_000, 2_500_000_000, 15_000_000_000, 0, 0, 1),
    ('gpt-5.6-sol', 5_000_000_000, 500_000_000, 6_250_000_000, 6_250_000_000, 30_000_000_000, 0, 0, 1),
    ('gpt-5.6-terra', 2_000_000_000, 200_000_000, 2_500_000_000, 2_500_000_000, 12_000_000_000, 0, 0, 1),
    ('gpt-5.6-luna', 200_000_000, 20_000_000, 250_000_000, 250_000_000, 1_200_000_000, 0, 0, 1),
    ('gpt-5.4-mini', 750_000_000, 75_000_000, 750_000_000, 750_000_000, 4_500_000_000, 0, 0, 1),
    ('gpt-5.4-nano', 200_000_000, 20_000_000, 200_000_000, 200_000_000, 1_250_000_000, 0, 0, 1),
    ('gpt-5.2', 1_750_000_000, 175_000_000, 1_750_000_000, 1_750_000_000, 14_000_000_000, 0, 0, 1),
    ('gpt-5.1', 1_250_000_000, 125_000_000, 1_250_000_000, 1_250_000_000, 10_000_000_000, 0, 0, 1),
    ('gpt-5', 1_250_000_000, 125_000_000, 1_250_000_000, 1_250_000_000, 10_000_000_000, 0, 0, 1),
    ('gpt-5-mini', 250_000_000, 25_000_000, 250_000_000, 250_000_000, 2_000_000_000, 0, 0, 1),
    ('gpt-5-nano', 50_000_000, 5_000_000, 50_000_000, 50_000_000, 400_000_000, 0, 0, 1),
    ('gpt-4.1', 2_000_000_000, 500_000_000, 2_000_000_000, 2_000_000_000, 8_000_000_000, 0, 0, 1),
    ('gpt-4.1-mini', 400_000_000, 100_000_000, 400_000_000, 400_000_000, 1_600_000_000, 0, 0, 1),
    ('gpt-4.1-nano', 100_000_000, 25_000_000, 100_000_000, 100_000_000, 400_000_000, 0, 0, 1),
    ('gpt-4o-mini', 150_000_000, 75_000_000, 150_000_000, 150_000_000, 600_000_000, 0, 0, 1),
    ('o3', 2_000_000_000, 500_000_000, 2_000_000_000, 2_000_000_000, 8_000_000_000, 0, 0, 1),
    ('o4-mini', 1_100_000_000, 275_000_000, 1_100_000_000, 1_100_000_000, 4_400_000_000, 0, 0, 1),
    ('o3-mini', 1_100_000_000, 550_000_000, 1_100_000_000, 1_100_000_000, 4_400_000_000, 0, 0, 1),
    ('o1', 15_000_000_000, 7_500_000_000, 15_000_000_000, 15_000_000_000, 60_000_000_000, 0, 0, 1),
    ('claude-opus-4-8', 5_000_000_000, 500_000_000, 6_250_000_000, 10_000_000_000, 25_000_000_000, 0, 0, 1),
    ('claude-sonnet-5', 2_000_000_000, 200_000_000, 2_500_000_000, 4_000_000_000, 10_000_000_000, 0, 0, 1),
    ('claude-haiku-4-5', 1_000_000_000, 100_000_000, 1_250_000_000, 2_000_000_000, 5_000_000_000, 0, 0, 1),
    ('grok-4.5', 2_000_000_000, 300_000_000, 2_000_000_000, 2_000_000_000, 6_000_000_000, 0, 0, 1),
    ('grok-4.3', 1_250_000_000, 200_000_000, 1_250_000_000, 1_250_000_000, 2_500_000_000, 0, 0, 1),
    ('kimi-k3', 3_000_000_000, 300_000_000, 3_000_000_000, 6_000_000_000, 15_000_000_000, 0, 0, 1),
    ('kimi-k2.6', 950_000_000, 160_000_000, 950_000_000, 950_000_000, 4_000_000_000, 0, 0, 1),
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
            raise RuntimeError("rate card v3 conflicts with the 2026-10-05 audited pricing seed")
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
        ('pricing', '0005_reject_token_billed_image_prices'),
        # The AIModel rows the card prices (and the 0005 trigger joins) land
        # first, so a fresh database and prod seed in the same order.
        ('openai', '0026_seed_lineup_v3'),
    ]

    operations = [
        migrations.RunPython(seed, migrations.RunPython.noop),
    ]
