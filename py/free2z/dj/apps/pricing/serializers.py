from rest_framework import serializers


class CardFeesSerializer(serializers.Serializer):
    """The card fee is ``max(min_fee_cents, ceil(base_cents * percent_fee))``.

    Informational only: clients must display the authoritative `card_cents`
    from `/api/pricing/quote/` (or the checkout quote) rather than recomputing
    a charge from these.
    """

    percent_fee = serializers.CharField(help_text="Card processing markup, e.g. '0.10'.")
    min_fee_cents = serializers.IntegerField(
        help_text="Minimum card fee in USD cents; the markup only applies above it."
    )


class ZecPromotionSerializer(serializers.Serializer):
    requested_code = serializers.CharField(allow_null=True)
    code_status = serializers.ChoiceField(choices=['none', 'active', 'unavailable'])
    multiplier = serializers.CharField()
    title = serializers.CharField(allow_null=True)
    ends_at = serializers.DateTimeField(allow_null=True)
    code = serializers.CharField(allow_null=True)


class PricingSerializer(serializers.Serializer):
    """Current live 2Z pricing across ZEC and card payments."""

    zec_usd = serializers.CharField(help_text="Aggregated ZEC/USD spot price.")
    spread = serializers.CharField(help_text="Spread applied to ZEC purchases, e.g. '0.10'.")
    tuzis_per_zec = serializers.CharField(help_text="2Z received per 1 ZEC after the spread.")
    zec_promotion = ZecPromotionSerializer()
    estimate_buffer = serializers.CharField(help_text="Conservative buffer used only for the displayed ZEC estimate.")
    estimated_tuzis_per_zec = serializers.CharField(help_text="Display estimate rate; actual credit uses processing-time settlement pricing.")
    tuzi_per_usd = serializers.IntegerField(help_text="Face-value 2Z per USD (100; 2Z == $0.01).")
    usd_per_tuzi = serializers.CharField(help_text="Face value of one 2Z in USD, e.g. '0.01'.")
    num_sources = serializers.IntegerField(help_text="Number of exchanges in the average.")
    sources = serializers.DictField(
        child=serializers.CharField(),
        help_text="Per-source ZEC/USD quotes used in the average.",
    )
    updated_at = serializers.DateTimeField(help_text="When this snapshot was taken.")
    stale = serializers.BooleanField(help_text="True if the snapshot is older than the freshness window.")
    bootstrap = serializers.BooleanField(help_text="True if this is a cold-start estimate (no live/cached price yet); show it as an estimate.")
    card = CardFeesSerializer()


class QuoteSerializer(serializers.Serializer):
    """Exact amounts to buy a given number of 2Z, both ways."""

    tuzis = serializers.IntegerField()
    zec_amount = serializers.CharField(help_text="Estimated ZEC amount (8dp); credits use actual value and processing price.")
    card_cents = serializers.IntegerField(help_text="USD cents Stripe would charge.")
    card_currency = serializers.CharField(help_text="ISO currency Stripe will charge.")
    card_pricing_version = serializers.CharField(
        help_text="Version of the authoritative card pricing contract."
    )
    tuzis_per_zec = serializers.CharField()
    zec_usd = serializers.CharField()
    updated_at = serializers.DateTimeField()
    stale = serializers.BooleanField()
    bootstrap = serializers.BooleanField(help_text="True if this is a cold-start estimate; don't present the ZEC amount as fresh.")


# ---------------------------------------------------------------------------
# Signed AI catalogue. SCHEMA ONLY: the view writes the body bytes
# itself (dj.apps.pricing.catalog.sign_catalog), because the catalogue member
# is served in canonical form and the ETag is a hash of the exact bytes.
# Member names and units are zuu f2z-ai-proto's `Catalog` / `CatalogModel`.
# ---------------------------------------------------------------------------


class CatalogModelPricesSerializer(serializers.Serializer):
    """Crate ``ModelPrices``: nano-USD per MILLION tokens for the four token
    buckets, nano-USD per unit for images and tool calls."""

    input_nusd_per_mtok = serializers.IntegerField(min_value=0)
    cached_input_nusd_per_mtok = serializers.IntegerField(min_value=0)
    cache_write_nusd_per_mtok = serializers.IntegerField(
        min_value=0, help_text="The 5-minute-TTL cache-write price (schema 1 has one)."
    )
    output_nusd_per_mtok = serializers.IntegerField(min_value=0)
    image_nusd = serializers.IntegerField(min_value=0)
    tool_call_nusd = serializers.IntegerField(min_value=0)


class CatalogModelCapabilitiesSerializer(serializers.Serializer):
    """Signed provider/model policy; the gateway also requires safe implementation."""

    vision = serializers.BooleanField(required=False, default=False)
    tools = serializers.BooleanField(required=False, default=False)
    reasoning = serializers.BooleanField(required=False, default=False)
    # No default on the two below: absent is NOT false here. The gateway
    # reads an absent member as "catalogue silent" and applies an interim
    # rule (zuu#1128, zuu#1142); this signer always emits both explicitly.
    structured_output = serializers.BooleanField(
        required=False,
        help_text="Strict JSON-schema response_format is supported. Always "
        "emitted by this signer; a gateway reads absence as 'not declared', "
        "never as false.",
    )
    strict_tools = serializers.BooleanField(
        required=False,
        help_text="`strict: true` on a function tool is supported. Always "
        "emitted by this signer; a gateway reads absence as 'not declared', "
        "never as false.",
    )
    reasoning_effort = serializers.BooleanField(
        required=False, default=False,
        help_text="`reasoning_effort` is supported (zuu#1170); not implied by "
        "`reasoning`. Always emitted by this signer; absent reads as false.",
    )


class CatalogModelControlsSerializer(serializers.Serializer):
    """Crate ``ModelControls``: signed narrowing of what a capability admits."""

    effort_levels = serializers.ListField(
        child=serializers.CharField(), required=False,
        help_text="The reasoning_effort levels the model takes (non-empty, "
        "distinct). Present only "
        "when capabilities.reasoning_effort is true; absent = not narrowed. "
        "A level a gateway cannot express is ignored there.",
    )


class CatalogModelSerializer(serializers.Serializer):
    id = serializers.CharField(help_text="Public model id a client names.")
    provider = serializers.CharField()
    provider_model_id = serializers.CharField(
        help_text="The provider's own model id the gateway sends upstream."
    )
    api_style = serializers.ChoiceField(
        choices=["openai_responses", "openai_chat", "anthropic_messages"]
    )
    prices = CatalogModelPricesSerializer()
    min_charge_2z = serializers.IntegerField(min_value=1, help_text="Whole 2Z per call.")
    safety_factor_bps = serializers.IntegerField(min_value=10000)
    context_window = serializers.IntegerField(min_value=0, help_text="Tokens.")
    max_output_tokens = serializers.IntegerField(min_value=0, help_text="Tokens.")
    ttfb_timeout_ms = serializers.IntegerField(min_value=0, help_text="Milliseconds.")
    idle_timeout_ms = serializers.IntegerField(
        min_value=1, max_value=300_000,
        help_text="Maximum stream silence in milliseconds; at most the gateway's 300s deadline.",
    )
    enabled = serializers.BooleanField()
    capabilities = CatalogModelCapabilitiesSerializer(
        required=False, help_text="Signed capability policy, always emitted. Absent vision/tools/"
        "reasoning mean false; absent structured_output/strict_tools means undeclared."
    )
    controls = CatalogModelControlsSerializer(
        required=False, help_text="Signed per-model narrowing (zuu#1170); present "
        "only when it narrows something."
    )


class CatalogSerializer(serializers.Serializer):
    """Crate ``Catalog`` (schema 1)."""

    schema = serializers.IntegerField(help_text="Always 1.")
    version = serializers.IntegerField(
        help_text="Unix microseconds of the newest change or the per-minute "
        "re-issue. Increases over time, but a later response can be LOWER by "
        "up to ~7 minutes (pods straddling a minute, a deleted model); see "
        "dj.apps.pricing.catalog for the bound."
    )
    issued_at = serializers.IntegerField(help_text="Unix seconds.")
    expires_at = serializers.IntegerField(help_text="Unix seconds; issued_at + 72h.")
    rate_card_version = serializers.IntegerField()
    platform_margin_bps = serializers.IntegerField()
    disabled_providers = serializers.ListField(child=serializers.CharField())
    models = CatalogModelSerializer(many=True)


class CatalogSignatureSerializer(serializers.Serializer):
    key_id = serializers.CharField(
        help_text="Which trusted key signed it. Trust comes from the verifier's "
        "own configuration, never from this response."
    )
    signature_hex = serializers.CharField(
        help_text="Ed25519 over b'free2z/ai-catalog/v1' || canonical_json(catalog); "
        "128 lowercase hex characters."
    )


class SignedCatalogSerializer(serializers.Serializer):
    catalog = CatalogSerializer(help_text="Served in canonical JSON form.")
    signature = CatalogSignatureSerializer()
