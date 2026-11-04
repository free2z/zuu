from decimal import Decimal, ROUND_HALF_UP

from django.db import models

from . import constants
from .aggregation import AggregateResult


class ZecPriceSnapshot(models.Model):
    """A point-in-time aggregated ZEC/USD price and the derived 2Z sell rate.

    Rows are append-only and act as the durable, shared source of truth for
    pricing (there is no shared cache across pods, so the latest row wins). The
    raw per-source quotes are kept for auditability.
    """
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    # Aggregated mid price (mean of non-outlier sources) and the median it was
    # filtered against.
    zec_usd = models.DecimalField(max_digits=16, decimal_places=6)
    median_usd = models.DecimalField(max_digits=16, decimal_places=6)

    # Spread applied and the resulting 2Z-per-ZEC sell rate.
    spread = models.DecimalField(max_digits=5, decimal_places=4)
    tuzis_per_zec = models.DecimalField(max_digits=18, decimal_places=4)

    num_sources = models.PositiveIntegerField(default=0)
    # Raw quotes used in the average, e.g. {"kraken": "1001.2",...}
    sources = models.JSONField(default=dict)
    # Quotes discarded as outliers.
    rejected = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self) -> str:
        return f"ZEC=${self.zec_usd} -> {self.tuzis_per_zec} 2Z/ZEC @ {self.created_at:%Y-%m-%d %H:%M:%S}"

    @classmethod
    def from_aggregate(cls, result: AggregateResult,
                       spread: Decimal = constants.ZEC_ESTIMATE_BUFFER) -> "ZecPriceSnapshot":
        """Build (unsaved) a snapshot from an ``AggregateResult``."""
        # Derive the sell rate from the exact price that PostgreSQL stores.
        # Otherwise an aggregate beyond six decimals can persist a rate that
        # cannot be reproduced from its own receipt price.
        stored_price = result.zec_usd.quantize(Decimal(".000001"), rounding=ROUND_HALF_UP)
        return cls(
            zec_usd=stored_price,
            median_usd=result.median,
            spread=spread,
            tuzis_per_zec=constants.tuzis_per_zec(stored_price, spread),
            num_sources=result.num_sources,
            sources={k: str(v) for k, v in result.used.items()},
            rejected={k: str(v) for k, v in result.rejected.items()},
        )


# ---------------------------------------------------------------------------
# AI rate cards. See docs/tuzis/ledger-v2.md §9 and dj.apps.pricing.ai.
#
# A rate card is the set of numbers a call is priced on: the platform margin
# and, per model, the provider prices and the minimum charge. It is VERSIONED
# and IMMUTABLE ONCE PUBLISHED, because a ledger hold snapshots the card it
# was admitted under and settle prices on that card — a card that could change
# after a hold captured it would re-price a call that already happened.
#
# Immutability is enforced by Postgres triggers (migration 0002), not by
# save(): QuerySet.update() and raw SQL skip save(), and the ledger's own SQL
# functions read these tables directly. The only column of a published card
# that may still change is ``active`` (rotation); a published card and its
# model rows can never be edited, un-published or deleted.
#
# Field names and units are the zuu f2z-ai-proto catalogue's, so the signed
# catalogue endpoint (a follow-up) serializes a row without conversion:
#   RateCard.version             -> Catalog.rate_card_version   (u64)
#   RateCard.platform_margin_bps -> Catalog.platform_margin_bps (Bps, u32)
#   RateCardModel.*_nusd*        -> CatalogModel.prices          (u64 each)
#   RateCardModel.min_charge_2z  -> CatalogModel.min_charge_2z   (Whole2z)
# with one documented exception: the 5m/1h cache-write split (zuu#1059) is two
# columns here and one member in catalogue schema 1, which carries the 5m one.
# ---------------------------------------------------------------------------

# Owner decision 2026-09-26 (ledger-v2 §9): 20 %, not the 50 % DEFAULT_MARKUP
# the seeded AIModel rows carry.
DEFAULT_PLATFORM_MARGIN_BPS = 2000
# f2z-ai-proto MAX_PLATFORM_MARGIN_BPS: a card above it is a catalogue the
# gateway refuses, so it is refused here first.
MAX_PLATFORM_MARGIN_BPS = 100_000


class RateCard(models.Model):
    """One immutable-once-published version of the AI price list."""

    version = models.PositiveBigIntegerField(
        unique=True,
        help_text=(
            "Monotonic rate-card version (the catalogue's rate_card_version, "
            "a u64). Captured on every ledger hold; settle prices on it."
        ),
    )
    platform_margin_bps = models.PositiveIntegerField(
        default=DEFAULT_PLATFORM_MARGIN_BPS,
        db_default=DEFAULT_PLATFORM_MARGIN_BPS,
        help_text="Platform margin in basis points (2000 = 20 %).",
    )
    min_margin_bps = models.PositiveIntegerField(
        default=0,
        db_default=0,
        help_text=(
            "Floor the platform margin on this card may not go below "
            "(CHECK platform_margin_bps >= min_margin_bps)."
        ),
    )
    active = models.BooleanField(
        default=False,
        db_default=False,
        help_text=(
            "May a NEW hold be admitted on this card? Only a published card "
            "can be active. More than one may be active during a rotation."
        ),
    )
    published_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text=(
            "Set once, when the card is published. From then on the card and "
            "its model rows are immutable (DB trigger); only `active` moves."
        ),
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "pricing_ratecard"
        ordering = ["-version"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(version__gte=1),
                name="pricing_ratecard_version_positive",
            ),
            models.CheckConstraint(
                condition=models.Q(platform_margin_bps__gte=models.F("min_margin_bps")),
                name="pricing_ratecard_margin_at_least_min",
            ),
            models.CheckConstraint(
                condition=models.Q(platform_margin_bps__lte=MAX_PLATFORM_MARGIN_BPS),
                name="pricing_ratecard_margin_sane",
            ),
            models.CheckConstraint(
                condition=models.Q(active=False) | models.Q(published_at__isnull=False),
                name="pricing_ratecard_active_requires_published",
            ),
        ]

    def __str__(self) -> str:
        state = "published" if self.published_at else "draft"
        return f"rate card v{self.version} ({state}, {self.platform_margin_bps} bps)"

    @property
    def is_published(self) -> bool:
        return self.published_at is not None


class RateCardModel(models.Model):
    """One model's prices on one rate card.

    ``model_id`` is the catalogue's public model id (today ``AIModel.model``)
    as TEXT, not a foreign key: the ledger's hold looks a row up by
    ``(rate_card_id, model_id)`` with the id the gateway sends, and an
    immutable card must not change meaning when an ``AIModel`` row is edited.
    """

    rate_card = models.ForeignKey(
        RateCard,
        on_delete=models.PROTECT,
        related_name="model_rows",
    )
    model_id = models.CharField(max_length=200)

    # nano-USD per MILLION tokens (crate ModelPrices units).
    input_nusd_per_mtok = models.PositiveBigIntegerField()
    cached_input_nusd_per_mtok = models.PositiveBigIntegerField()
    cache_write_5m_nusd_per_mtok = models.PositiveBigIntegerField()
    cache_write_1h_nusd_per_mtok = models.PositiveBigIntegerField()
    output_nusd_per_mtok = models.PositiveBigIntegerField()
    # nano-USD per unit.
    image_nusd = models.PositiveBigIntegerField()
    tool_call_nusd = models.PositiveBigIntegerField()

    min_charge_2z = models.PositiveIntegerField(
        default=1,
        help_text="Minimum charge per call, whole 2Z. Never below 1 (CHECK).",
    )

    class Meta:
        db_table = "pricing_ratecard_model"
        ordering = ["rate_card", "model_id"]
        constraints = [
            models.UniqueConstraint(
                fields=["rate_card", "model_id"],
                name="pricing_ratecard_model_unique",
            ),
            models.CheckConstraint(
                condition=models.Q(min_charge_2z__gte=1),
                name="pricing_ratecard_model_min_charge_2z_gte_1",
            ),
            models.CheckConstraint(
                condition=~models.Q(model_id=""),
                name="pricing_ratecard_model_id_nonempty",
            ),
            # f2z-ai-proto Catalog::validate refuses an all-zero price vector.
            models.CheckConstraint(
                condition=(
                    models.Q(input_nusd_per_mtok__gt=0)
                    | models.Q(cached_input_nusd_per_mtok__gt=0)
                    | models.Q(cache_write_5m_nusd_per_mtok__gt=0)
                    | models.Q(cache_write_1h_nusd_per_mtok__gt=0)
                    | models.Q(output_nusd_per_mtok__gt=0)
                    | models.Q(image_nusd__gt=0)
                    | models.Q(tool_call_nusd__gt=0)
                ),
                name="pricing_ratecard_model_not_all_zero",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.model_id} @ v{self.rate_card.version}"

    def model_prices(self):
        """The row as:class:`dj.apps.pricing.ai.ModelPrices`."""
        from .ai import ModelPrices

        return ModelPrices(
            input_nusd_per_mtok=self.input_nusd_per_mtok,
            cached_input_nusd_per_mtok=self.cached_input_nusd_per_mtok,
            cache_write_5m_nusd_per_mtok=self.cache_write_5m_nusd_per_mtok,
            cache_write_1h_nusd_per_mtok=self.cache_write_1h_nusd_per_mtok,
            output_nusd_per_mtok=self.output_nusd_per_mtok,
            image_nusd=self.image_nusd,
            tool_call_nusd=self.tool_call_nusd,
        )

    def price(self, usage, dev_markup_bps: int = 0):
        """Price ``usage`` (:class:`dj.apps.pricing.ai.Usage`) on this row's
        card: the card's margin, this model's prices and minimum."""
        from .ai import price_2z

        return price_2z(
            usage,
            self.model_prices(),
            self.rate_card.platform_margin_bps,
            dev_markup_bps,
            self.min_charge_2z,
        )
