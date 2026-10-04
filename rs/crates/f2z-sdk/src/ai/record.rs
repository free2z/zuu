//! `GET /v1/calls/{id}` (`docs/free2z/sdk/spec/chat-api.md` §7), the models list
//! (§5), and [`Charge`], the owned form of `f2z_ai_proto`'s `Outcome`.

use f2z_ai_proto::chat::{FinishReason, Usage, UsageSource};
use f2z_ai_proto::settlement::{NotFinal, Outcome, SettlementError};
use f2z_ai_proto::{Milli2z, Whole2z};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// What a call cost, as far as is known. Built from `f2z_ai_proto`'s
/// `outcome()`, never from `charged_2z` directly.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Charge {
    /// Final: charged. When `shortfall_milli_2z` is non-zero, show "priced
    /// at N, M taken" from `collected_milli_2z`.
    Charged {
        /// The final charge.
        charged_2z: Whole2z,
        /// The ledger's settlement id.
        receipt_id: String,
        /// What was actually taken, when reported.
        collected_milli_2z: Option<Milli2z>,
        /// What was written off, when reported.
        shortfall_milli_2z: Option<Milli2z>,
    },
    /// Final: nothing was charged.
    NothingCharged,
    /// **Not final.** Say "settling" and read [`crate::ai::Ai::call`] (or
    /// [`crate::ai::Ai::wait_for_call`]) until the record is terminal; never
    /// show a number.
    NotFinal(NotFinal),
}

impl Charge {
    /// Whether the charge is known.
    #[must_use]
    pub fn is_final(&self) -> bool {
        !matches!(self, Self::NotFinal(_))
    }

    /// The final charge: `Some(0)` when nothing was charged, `None` when not
    /// final.
    #[must_use]
    pub fn charged_2z(&self) -> Option<Whole2z> {
        match self {
            Self::Charged { charged_2z, .. } => Some(*charged_2z),
            Self::NothingCharged => Some(Whole2z::ZERO),
            Self::NotFinal(_) => None,
        }
    }
}

impl From<Outcome<'_>> for Charge {
    fn from(outcome: Outcome<'_>) -> Self {
        match outcome {
            Outcome::Charged {
                charged_2z,
                receipt_id,
                collected_milli_2z,
                shortfall_milli_2z,
            } => Self::Charged {
                charged_2z,
                receipt_id: receipt_id.to_owned(),
                collected_milli_2z,
                shortfall_milli_2z,
            },
            Outcome::NothingCharged => Self::NothingCharged,
            Outcome::NotFinal(n) => Self::NotFinal(n),
            // A variant newer than this SDK: never treat it as final.
            _ => Self::NotFinal(NotFinal::Unknown),
        }
    }
}

/// Where a call record is (§7).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallStatus {
    /// The hold exists; the call is in progress.
    Streaming,
    /// The provider finished; the ledger has not confirmed.
    Settling,
    /// Charged.
    Settled,
    /// An error after output; charged for what was produced.
    SettledPartial,
    /// Nothing charged.
    Released,
    /// A status newer than this SDK. Not terminal.
    #[serde(other)]
    Unknown,
}

impl CallStatus {
    /// `settled`, `settled_partial` or `released`: the charge is final.
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Settled | Self::SettledPartial | Self::Released)
    }
}

/// The error of a failed call record.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CallError {
    /// The code, as in `errors.md`.
    pub code: String,
    /// For a log.
    #[serde(default)]
    pub message: String,
}

/// One call's record (§7). No message content: the gateway keeps none.
/// Unknown fields are ignored.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CallRecord {
    /// The call.
    pub call_id: String,
    /// Where it is.
    pub status: CallStatus,
    /// The model that served it.
    #[serde(default)]
    pub model: Option<String>,
    /// The model asked for.
    #[serde(default)]
    pub requested_model: Option<String>,
    /// The provider.
    #[serde(default)]
    pub provider: Option<String>,
    /// Why generation stopped.
    #[serde(default)]
    pub finish_reason: Option<FinishReason>,
    /// What it used.
    #[serde(default)]
    pub usage: Option<Usage>,
    /// Where `usage` came from.
    #[serde(default)]
    pub usage_source: Option<UsageSource>,
    /// The final reservation.
    #[serde(default)]
    pub hold_2z: Option<Whole2z>,
    /// The charge. **Read [`CallRecord::charge`]**, which also looks at
    /// `status`.
    #[serde(default)]
    pub charged_2z: Option<Whole2z>,
    /// The ledger's settlement id.
    #[serde(default)]
    pub receipt_id: Option<String>,
    /// What was actually taken.
    #[serde(default)]
    pub collected_milli_2z: Option<Milli2z>,
    /// What was given back.
    #[serde(default)]
    pub released_2z: Option<Whole2z>,
    /// What was written off.
    #[serde(default)]
    pub shortfall_milli_2z: Option<Milli2z>,
    /// The signed catalogue version it was priced from.
    #[serde(default)]
    pub catalog_version: Option<u64>,
    /// The markup applied, in basis points.
    #[serde(default)]
    pub markup_bps: Option<u64>,
    /// The request's `metadata`.
    #[serde(default)]
    pub metadata: Option<Map<String, Value>>,
    /// Set when the call ended in an error.
    #[serde(default)]
    pub error: Option<CallError>,
    /// Whether this record came back from an idempotent replay.
    #[serde(default)]
    pub replayed: bool,
    /// RFC 3339.
    #[serde(default)]
    pub created_at: Option<String>,
    /// RFC 3339, once settled.
    #[serde(default)]
    pub settled_at: Option<String>,
}

impl CallRecord {
    /// What the call cost. Final only once [`CallStatus::is_terminal`].
    #[must_use]
    pub fn charge(&self) -> Charge {
        match self.status {
            CallStatus::Released => Charge::NothingCharged,
            CallStatus::Settled | CallStatus::SettledPartial => {
                match (self.charged_2z, self.receipt_id.as_deref()) {
                    (Some(c), Some(r)) if c != Whole2z::ZERO && !r.is_empty() => Charge::Charged {
                        charged_2z: c,
                        receipt_id: r.to_owned(),
                        collected_milli_2z: self.collected_milli_2z,
                        shortfall_milli_2z: self.shortfall_milli_2z,
                    },
                    (Some(c), None) if c == Whole2z::ZERO => Charge::NothingCharged,
                    (None, _) => {
                        Charge::NotFinal(NotFinal::Invalid(SettlementError::Missing("charged_2z")))
                    }
                    (Some(_), _) => {
                        Charge::NotFinal(NotFinal::Invalid(SettlementError::Missing("receipt_id")))
                    }
                }
            }
            CallStatus::Streaming | CallStatus::Settling => Charge::NotFinal(NotFinal::Pending),
            CallStatus::Unknown => Charge::NotFinal(NotFinal::Unknown),
        }
    }
}

/// `GET /v1/models`: the catalogue as this app's users pay for it. Prices
/// include the platform margin and the app's markup.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Models {
    /// The signed catalogue's version; only increases.
    #[serde(default)]
    pub catalog_version: u64,
    /// The markup already inside every price, in basis points.
    #[serde(default)]
    pub includes_markup_bps: u64,
    /// The callable models.
    #[serde(default)]
    pub models: Vec<ModelInfo>,
}

/// One model of [`Models`].
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelInfo {
    /// What a request names.
    pub id: String,
    /// `openai`, `anthropic`, `xai`, …
    #[serde(default)]
    pub provider: Option<String>,
    /// For a picker.
    #[serde(default)]
    pub display_name: Option<String>,
    /// Input plus output, tokens.
    #[serde(default)]
    pub context_window: Option<u64>,
    /// The most a call can generate.
    #[serde(default)]
    pub max_output_tokens: Option<u64>,
    /// What it can do.
    #[serde(default)]
    pub capabilities: Capabilities,
    /// Published rates, milli-2Z per million tokens or per unit.
    #[serde(default)]
    pub prices: Map<String, Value>,
    /// The floor for one call, whole 2Z (never below 1).
    #[serde(default)]
    pub min_charge_2z: Option<Whole2z>,
    /// How long the gateway waits for a first byte.
    #[serde(default)]
    pub ttfb_timeout_ms: Option<u64>,
}

/// A model's capabilities.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    /// Accepts image parts.
    #[serde(default)]
    pub vision: bool,
    /// Accepts `tools`.
    #[serde(default)]
    pub tools: bool,
    /// Reasons before answering (billed as output).
    #[serde(default)]
    pub reasoning: bool,
    /// Accepts `response_format` (JSON / JSON-schema output). `false` from a
    /// gateway that predates the field.
    #[serde(default)]
    pub structured_output: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(v: Value) -> CallRecord {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn the_spec_record_is_charged() {
        let r = record(serde_json::json!({
            "call_id": "019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c", "status": "settled",
            "model": "example-model-small", "finish_reason": "stop",
            "usage": {"input_tokens": 1187, "output_tokens": 342},
            "usage_source": "provider", "hold_2z": 2, "charged_2z": 1,
            "receipt_id": "rcpt_1", "collected_milli_2z": 1000, "released_2z": 1,
            "shortfall_milli_2z": 0, "catalog_version": 7, "markup_bps": 0,
            "metadata": {"lesson": "q"}, "error": null, "replayed": false,
            "created_at": "2026-09-26T21:04:11Z", "settled_at": "2026-09-26T21:04:14Z"
        }));
        assert_eq!(r.charge().charged_2z(), Some(Whole2z::new(1)));
    }

    #[test]
    fn in_progress_and_unknown_are_not_final() {
        let r = record(serde_json::json!({"call_id": "c", "status": "settling", "charged_2z": 5}));
        assert_eq!(r.charge(), Charge::NotFinal(NotFinal::Pending));
        let r = record(serde_json::json!({"call_id": "c", "status": "archived"}));
        assert!(!r.status.is_terminal());
        assert!(!r.charge().is_final());
        let r = record(serde_json::json!({"call_id": "c", "status": "released", "charged_2z": 0}));
        assert_eq!(r.charge(), Charge::NothingCharged);
    }

    #[test]
    fn the_spec_models_list_decodes() {
        let m: Models = serde_json::from_value(serde_json::json!({
            "catalog_version": 7, "includes_markup_bps": 0,
            "models": [{"id": "example-model-small", "provider": "example-provider",
              "display_name": "Example", "context_window": 400000, "max_output_tokens": 128000,
              "capabilities": {"vision": true, "tools": true, "reasoning": true},
              "prices": {"input_milli_2z_per_mtok": 300000}, "min_charge_2z": 1,
              "ttfb_timeout_ms": 30000}]
        }))
        .unwrap();
        assert!(m.models[0].capabilities.vision);
        // Absent (an older gateway) reads as unsupported.
        assert!(!m.models[0].capabilities.structured_output);
        let caps: Capabilities =
            serde_json::from_value(serde_json::json!({"structured_output": true})).unwrap();
        assert!(caps.structured_output);
    }
}
