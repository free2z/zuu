//! Opt-in schema-2 catalogues with whole-request context pricing.
//!
//! This module does not change the gateway's schema-1 reader or HTTP model
//! listing. A consumer must explicitly adopt this contract together with its
//! ledger and typed model listing; flattening these prices for a v1 client is
//! unsafe. The signature envelope remains `free2z/ai-catalog/v1`: schema and
//! tier rules are inside the signed payload, not a new signature protocol.
//! Consumers must retain a monotonic publication sequence across schema
//! changes (or explicitly migrate their anti-replay state).

use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

use crate::amount::Nusd;
use crate::catalog::{
    Catalog, CatalogError, CatalogModel, DetachedSignature, TrustedKey,
    validate_signed_price_fields, verify_catalog_tree,
};
use crate::chat::Usage;
use crate::pricing::{Bps, ModelPrices, PricingError, metered_cost_nusd};

/// Schema understood only by the opt-in reader.
pub const CATALOG_SCHEMA_V2: u32 = 2;

/// The complete table applies when total actual input is strictly above the
/// threshold, including ALL output, not just the input above the threshold.
/// Unknown metadata is ignored for response compatibility. Changes to pricing
/// semantics require a schema revision, which consumers must validate before
/// using these values to quote a call.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextPriceTier {
    /// Ordinary + cache-read + cache-write input tokens; output is excluded.
    pub input_tokens_gt: u64,
    /// Complete replacement table, in the same units as base prices.
    pub prices: ModelPrices,
}

/// A schema-2 model. `base.prices` is only the base table; use
/// [`Self::cost_nusd`] to price actual usage.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogModelV2 {
    /// Existing model metadata and base prices, unchanged on the wire.
    #[serde(flatten)]
    pub base: CatalogModel,
    /// Optional single whole-request long-context tier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub long_context_pricing: Option<ContextPriceTier>,
}

/// A separately typed signed catalogue. No conversion to a schema-1 catalogue
/// is exposed: that would silently discard tiered money semantics.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogV2 {
    /// Exactly [`CATALOG_SCHEMA_V2`].
    pub schema: u32,
    /// Monotonic signed publication sequence; the caller enforces anti-replay.
    pub version: u64,
    /// Unix signing time.
    pub issued_at: u64,
    /// Exclusive Unix expiry.
    pub expires_at: u64,
    /// Immutable ledger rate-card version.
    pub rate_card_version: u64,
    /// Platform margin.
    pub platform_margin_bps: Bps,
    /// Providers disabled by policy.
    #[serde(default)]
    pub disabled_providers: Vec<String>,
    /// Models with explicit optional context pricing.
    pub models: Vec<CatalogModelV2>,
}

impl CatalogV2 {
    /// Validate the unchanged model invariants and the new tier rules.
    /// Individual zero-price dimensions remain valid.
    ///
    /// # Errors
    /// [`CatalogError::Invalid`] for unsupported schema or invalid terms.
    pub fn validate(&self) -> Result<(), CatalogError> {
        if self.schema != CATALOG_SCHEMA_V2 {
            return Err(CatalogError::Invalid("unsupported catalogue schema"));
        }
        // Reuse v1 structural rules without exposing a lossy conversion.
        Catalog {
            schema: crate::catalog::CATALOG_SCHEMA,
            version: self.version,
            issued_at: self.issued_at,
            expires_at: self.expires_at,
            rate_card_version: self.rate_card_version,
            platform_margin_bps: self.platform_margin_bps,
            disabled_providers: self.disabled_providers.clone(),
            models: self.models.iter().map(|m| m.base.clone()).collect(),
        }
        .validate()?;
        for model in &self.models {
            if let Some(tier) = &model.long_context_pricing {
                if tier.input_tokens_gt == 0 || tier.input_tokens_gt >= model.base.context_window {
                    return Err(CatalogError::Invalid(
                        "context threshold outside model context",
                    ));
                }
                // Monotonic rates make certified input/output bounds safe for
                // reservation. Later cheaper tiers need a max-over-tiers rule.
                if dimensions(&tier.prices)
                    .into_iter()
                    .zip(dimensions(&model.base.prices))
                    .any(|(long, base)| long < base)
                {
                    return Err(CatalogError::Invalid("context prices below base prices"));
                }
            }
        }
        Ok(())
    }
}

fn dimensions(p: &ModelPrices) -> [u64; 6] {
    [
        p.input_nusd_per_mtok,
        p.cached_input_nusd_per_mtok,
        p.cache_write_nusd_per_mtok,
        p.output_nusd_per_mtok,
        p.image_nusd,
        p.tool_call_nusd,
    ]
}

impl CatalogModelV2 {
    fn prices_for_input(&self, input: u64) -> &ModelPrices {
        match &self.long_context_pricing {
            Some(tier) if input > tier.input_tokens_gt => &tier.prices,
            _ => &self.base.prices,
        }
    }

    /// Price validated, exclusive usage buckets at the actual context tier.
    /// Output/reasoning tokens do not affect tier selection.
    ///
    /// # Errors
    /// [`PricingError::Overflow`] on an overflowing input sum or cost.
    pub fn cost_nusd(&self, usage: &Usage) -> Result<Nusd, PricingError> {
        let input = usage
            .input_tokens
            .checked_add(usage.cached_input_tokens)
            .and_then(|n| n.checked_add(usage.cache_write_tokens))
            .ok_or(PricingError::Overflow)?;
        metered_cost_nusd(usage, self.prices_for_input(input))
    }

    /// Conservative token-only reservation cost for a validated model.
    ///
    /// Bounds must cover provider framing and hidden input, not just visible
    /// prompt tokens. If no tighter provider bound is proven, use the entire
    /// model context for input. Context admission/output ceilings are separate
    /// obligations. This does not authorize image or tool-unit usage.
    /// The maximum of all three input rates covers any cache composition;
    /// output uses the whole-request tier selected by the input bound.
    ///
    /// # Errors
    /// [`PricingError::Overflow`] if the conservative cost cannot fit.
    pub fn token_reservation_cost_nusd(
        &self,
        input_bound: u64,
        output_bound: u64,
    ) -> Result<Nusd, PricingError> {
        let mut prices = *self.prices_for_input(input_bound);
        prices.input_nusd_per_mtok = prices
            .input_nusd_per_mtok
            .max(prices.cached_input_nusd_per_mtok)
            .max(prices.cache_write_nusd_per_mtok);
        metered_cost_nusd(
            &Usage {
                input_tokens: input_bound,
                output_tokens: output_bound,
                ..Usage::default()
            },
            &prices,
        )
    }
}

/// Verify a schema-2 catalogue using the existing signing envelope. This does
/// not check publication monotonicity; the caller must retain its high-water
/// mark and immutable historical terms for admitted calls.
///
/// # Errors
/// [`CatalogError`] for signature, shape, schema, structural or expiry failure.
pub fn verify_catalog_v2(
    payload: &[u8],
    signature: &DetachedSignature,
    trusted: &[TrustedKey],
    now_unix: u64,
) -> Result<CatalogV2, CatalogError> {
    let tree = verify_catalog_tree(payload, signature, trusted)?;
    validate_signed_price_fields(&tree, true)?;
    let catalog: CatalogV2 = serde_json::from_value(tree).map_err(CatalogError::Json)?;
    catalog.validate()?;
    if now_unix >= catalog.expires_at {
        return Err(CatalogError::Expired);
    }
    Ok(catalog)
}
