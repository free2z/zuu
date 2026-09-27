//! `f2z-ai-proto`'s shared pricing fixtures, typed.
//!
//! The files live in `rs/crates/f2z-ai-proto/fixtures/pricing/` and are the
//! parity contract every implementation of the pricing formula — Rust, Python,
//! the ledger's SQL — is tested against. They are compiled in here (not
//! copied) so the gateway's tests, and the in-memory ledger's, are driven by
//! exactly the same numbers, and a change to a fixture reaches every consumer
//! in the same commit.

use core::fmt;

use f2z_ai_proto::Usage;
use f2z_ai_proto::pricing::{Bps, Charge, ModelPrices};
use serde::Deserialize;

const WORKED_EXAMPLES: &str =
    include_str!("../../f2z-ai-proto/fixtures/pricing/worked_examples.json");
const FROM_USAGE: &str = include_str!("../../f2z-ai-proto/fixtures/pricing/from_usage.json");

/// The fixture schema this module understands.
pub const FIXTURE_SCHEMA: u32 = 1;

/// A fixture file did not parse, or has a schema this module does not know.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FixtureError(pub String);

impl fmt::Display for FixtureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "pricing fixture: {}", self.0)
    }
}

impl std::error::Error for FixtureError {}

/// One case of `worked_examples.json`: a metered cost, priced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CostCase {
    /// The case name.
    pub name: String,
    /// The metered provider cost, nano-USD.
    pub cost_nusd: u64,
    /// The platform margin.
    pub platform_margin: Bps,
    /// The developer markup.
    pub dev_markup: Bps,
    /// The minimum charge, whole 2Z.
    pub min_charge_2z: u64,
    /// The independently computed price.
    pub expected: Charge,
}

/// One case of `from_usage.json`: a usage vector, metered then priced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsageCase {
    /// The case name.
    pub name: String,
    /// The usage.
    pub usage: Usage,
    /// The model's provider prices.
    pub prices: ModelPrices,
    /// The platform margin.
    pub platform_margin: Bps,
    /// The developer markup.
    pub dev_markup: Bps,
    /// The minimum charge, whole 2Z.
    pub min_charge_2z: u64,
    /// The metered cost settle receives.
    pub expected_cost_nusd: u64,
    /// The independently computed price.
    pub expected: Charge,
}

#[derive(Deserialize)]
struct File<C> {
    schema: u32,
    cases: Vec<C>,
}

#[derive(Deserialize)]
struct RawCharge {
    total_milli: u64,
    provider_milli: u64,
    developer_milli: u64,
    platform_milli: u64,
}

impl From<&RawCharge> for Charge {
    fn from(r: &RawCharge) -> Self {
        Self {
            total_milli: r.total_milli,
            provider_milli: r.provider_milli,
            developer_milli: r.developer_milli,
            platform_milli: r.platform_milli,
        }
    }
}

#[derive(Deserialize)]
struct RawCost {
    name: String,
    input: RawCostInput,
    expected: RawCharge,
}

#[derive(Deserialize)]
struct RawCostInput {
    cost_nusd: u64,
    platform_margin_bps: u32,
    dev_markup_bps: u32,
    min_charge_2z: u64,
}

#[derive(Deserialize)]
struct RawUsage {
    name: String,
    input: RawUsageInput,
    expected: RawUsageExpected,
}

#[derive(Deserialize)]
struct RawUsageInput {
    usage: Usage,
    prices: ModelPrices,
    platform_margin_bps: u32,
    dev_markup_bps: u32,
    min_charge_2z: u64,
}

#[derive(Deserialize)]
struct RawUsageExpected {
    cost_nusd: u64,
    #[serde(flatten)]
    charge: RawCharge,
}

fn parse<C: for<'de> Deserialize<'de>>(name: &str, text: &str) -> Result<Vec<C>, FixtureError> {
    let file: File<C> =
        serde_json::from_str(text).map_err(|e| FixtureError(format!("{name}: {e}")))?;
    if file.schema != FIXTURE_SCHEMA {
        return Err(FixtureError(format!(
            "{name}: schema {} is not {FIXTURE_SCHEMA}",
            file.schema
        )));
    }
    if file.cases.is_empty() {
        // An empty fixture file would pass every test vacuously.
        return Err(FixtureError(format!("{name}: no cases")));
    }
    Ok(file.cases)
}

/// Every case of `worked_examples.json`.
///
/// # Errors
///
/// The file does not parse, has another schema, or has no cases.
pub fn cost_cases() -> Result<Vec<CostCase>, FixtureError> {
    Ok(parse::<RawCost>("worked_examples.json", WORKED_EXAMPLES)?
        .into_iter()
        .map(|c| CostCase {
            name: c.name,
            cost_nusd: c.input.cost_nusd,
            platform_margin: Bps(c.input.platform_margin_bps),
            dev_markup: Bps(c.input.dev_markup_bps),
            min_charge_2z: c.input.min_charge_2z,
            expected: Charge::from(&c.expected),
        })
        .collect())
}

/// Every case of `from_usage.json`.
///
/// # Errors
///
/// The file does not parse, has another schema, or has no cases.
pub fn usage_cases() -> Result<Vec<UsageCase>, FixtureError> {
    Ok(parse::<RawUsage>("from_usage.json", FROM_USAGE)?
        .into_iter()
        .map(|c| UsageCase {
            name: c.name,
            usage: c.input.usage,
            prices: c.input.prices,
            platform_margin: Bps(c.input.platform_margin_bps),
            dev_markup: Bps(c.input.dev_markup_bps),
            min_charge_2z: c.input.min_charge_2z,
            expected_cost_nusd: c.expected.cost_nusd,
            expected: Charge::from(&c.expected.charge),
        })
        .collect())
}
