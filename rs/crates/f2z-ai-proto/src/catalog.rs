//! The model catalogue, and verification of its detached Ed25519 signature.
//!
//! The catalogue is the gateway's only source of prices. It is published by
//! the platform as JSON with a **detached** Ed25519 signature, and the gateway
//! refuses to price a call without a verified one.
//!
//! # What the signature covers
//!
//! ```text
//! message   = CATALOG_SIGNING_LABEL || canonical_json(payload)
//! signature = Ed25519-Sign(catalogue key, message)       64 bytes, hex on the wire
//! ```
//!
//! `canonical_json` is [`crate::canonical`] (RFC 8785 over integers only), so
//! the payload may be served with any whitespace or member order and still
//! verify. The label is domain separation: a catalogue key signing anything
//! else cannot produce a valid catalogue signature, and a catalogue signature
//! is not a valid signature over any other free2z message.
//!
//! # Verify, then use exactly what was verified
//!
//! [`verify_catalog`] parses the payload once into a JSON tree, computes the
//! signing message from that tree, verifies, and then deserializes the typed
//! [`Catalog`] **from the same tree**. There is no second parse whose result
//! could differ from what the signature covered. A payload with a duplicate
//! member name is refused before verification (RFC 8785 §3.1): another
//! consumer of the same bytes might resolve the duplicate differently.
//!
//! Verification uses `verify_strict`, which rejects the non-canonical and
//! small-order encodings plain `verify` tolerates. Every signature an honest
//! Ed25519 signer produces passes it.

use alloc::collections::BTreeSet;
use alloc::string::String;
use alloc::vec::Vec;
use core::fmt;

use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::amount::Whole2z;
use crate::canonical::{CanonicalError, parse_strict, to_canonical_json};
use crate::pricing::{Bps, ModelPrices};

/// Domain-separation prefix of the catalogue signing message.
pub const CATALOG_SIGNING_LABEL: &[u8] = b"free2z/ai-catalog/v1";

/// The schema understood by the original reader and the active gateway.
///
/// Changes an old consumer must not silently misread require a new schema
/// and an explicitly versioned reader (see [`crate::catalog_v2`]). In
/// particular, [`ModelPrices`] refuses unknown price dimensions so older
/// consumers cannot silently price a new dimension at zero.
pub const CATALOG_SCHEMA: u32 = 1;

/// The largest platform margin [`Catalog::validate`] accepts: 1 000 %.
pub const MAX_PLATFORM_MARGIN_BPS: Bps = Bps(100_000);

/// The signed model catalogue.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Catalog {
    /// Must equal [`CATALOG_SCHEMA`].
    pub schema: u32,
    /// Monotonically increasing per published catalogue. A consumer must
    /// refuse a catalogue whose version is lower than one it has already
    /// accepted: an old catalogue is still validly signed, and replaying one
    /// could reinstate old, lower prices.
    pub version: u64,
    /// Unix seconds at which this catalogue was signed.
    pub issued_at: u64,
    /// Unix seconds after which this catalogue must not be used.
    /// [`verify_catalog`] refuses it from this instant on.
    ///
    /// This is the defence against a **frozen** catalogue: without an expiry,
    /// an attacker (or a stuck cache) that keeps serving one old, validly
    /// signed catalogue could pin prices forever, and the version check only
    /// helps a consumer that has already seen a newer one. The cost is that a
    /// signer outage longer than `expires_at − issued_at` stops pricing: the
    /// window must be chosen to exceed the longest tolerable signer outage,
    /// and publishing a fresh signature is required even when nothing changed.
    pub expires_at: u64,
    /// The rate card the ledger settles against; carried into every hold and
    /// settle so the two sides price with the same numbers.
    pub rate_card_version: u64,
    /// The platform margin applied to every call.
    pub platform_margin_bps: Bps,
    /// Providers disabled by policy. A model whose `provider` is listed here
    /// is not callable, whatever its own `enabled` says.
    #[serde(default)]
    pub disabled_providers: Vec<String>,
    /// The models.
    pub models: Vec<CatalogModel>,
}

/// Audited provider features carried inside the signed catalogue.
/// Old catalogues and absent members conservatively advertise no support.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelCapabilities {
    /// Image input is supported by this model.
    pub vision: bool,
    /// Client function tools and their result messages are supported.
    pub tools: bool,
    /// The model can produce reasoning output.
    pub reasoning: bool,
    /// `ChatRequest::response_format` (JSON / JSON-schema output) is
    /// supported. **Tri-state**, unlike the members above: `Some(true)` and
    /// `Some(false)` are an audited declaration; `None` (absent) means the
    /// catalogue does not say, and the gateway applies its documented interim
    /// rule (the `f2z-ai` crate's `provider::structured_output_supported`)
    /// instead of reading absence as `false`. A present `null` is refused.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "declared_bool"
    )]
    pub structured_output: Option<bool>,
    /// `Tool::strict: true` (provider-enforced argument schemas) is
    /// supported. Tri-state like `structured_output`: absent means the
    /// catalogue does not say, and the gateway applies its documented
    /// interim rule (the `f2z-ai` crate's `provider::strict_tools_supported`).
    /// A present `null` is refused.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "declared_bool"
    )]
    pub strict_tools: Option<bool>,
    /// `ChatRequest::reasoning_effort` is supported: the model takes the
    /// provider's own effort control (OpenAI/xAI `reasoning_effort`). Not the
    /// same claim as [`ModelCapabilities::reasoning`], which says the model
    /// *reasons*: a reasoning model may still take no effort control (Anthropic's
    /// budget-only `thinking`). Absent reads as `false`
    /// and is omitted when serialized, so a catalogue without it re-encodes
    /// exactly as before. Which levels: [`ModelControls::effort_levels`].
    #[serde(skip_serializing_if = "core::ops::Not::not")]
    pub reasoning_effort: bool,
}

fn declared_bool<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<bool>, D::Error> {
    bool::deserialize(d).map(Some)
}

impl ModelCapabilities {
    fn is_empty(&self) -> bool {
        !self.vision
            && !self.tools
            && !self.reasoning
            && self.structured_output.is_none()
            && self.strict_tools.is_none()
            && !self.reasoning_effort
    }
}

/// Signed, per-model narrowing of what a capability admits — the
/// catalogue's `controls` object. Every member is optional and absent means
/// "not narrowed": the capability alone decides.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelControls {
    /// The `reasoning_effort` levels this model accepts, as wire strings
    /// (`"low"`, `"high"`, …). Only read when
    /// [`ModelCapabilities::reasoning_effort`] is `true`. Present: a level not
    /// listed is refused before any hold. Absent: every level the request
    /// wire can express is forwarded, and a level the provider rejects comes
    /// back as its own `400` before any output (`provider_error`, hold
    /// released, nothing charged) — so the signer should list them. A
    /// string this crate does not know (`"xhigh"`, `"none"`) is kept and
    /// simply unreachable: one newer level must not make an older gateway
    /// refuse the whole signed catalogue.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort_levels: Option<Vec<String>>,
}

impl ModelControls {
    fn is_empty(&self) -> bool {
        self.effort_levels.is_none()
    }
}

/// One model in the [`Catalog`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogModel {
    /// The public model id a client names in `ChatRequest::model`.
    pub id: String,
    /// The provider, e.g. `"openai"`, `"anthropic"`, `"xai"`.
    pub provider: String,
    /// The provider's own model id the gateway sends upstream.
    pub provider_model_id: String,
    /// Which upstream API shape the gateway speaks to this model.
    pub api_style: ApiStyle,
    /// Audited features, never inferred from the provider/model name.
    /// The gateway exposes only the intersection with features it implements.
    #[serde(default, skip_serializing_if = "ModelCapabilities::is_empty")]
    pub capabilities: ModelCapabilities,
    /// Per-model narrowing of capabilities; see [`ModelControls`]. Absent
    /// (every catalogue signed before it) is omitted when serialized.
    #[serde(default, skip_serializing_if = "ModelControls::is_empty")]
    pub controls: ModelControls,
    /// Prices. See [`ModelPrices`] for units.
    pub prices: ModelPrices,
    /// The minimum charge per call, in whole 2Z.
    pub min_charge_2z: Whole2z,
    /// Tokenizer safety factor for input estimation, in basis points
    /// (`11_500` = ×1.15). Never below `10_000`.
    pub safety_factor_bps: Bps,
    /// Context window, in tokens.
    pub context_window: u64,
    /// The model's own output ceiling, in tokens.
    pub max_output_tokens: u64,
    /// Time-to-first-byte timeout, in milliseconds.
    pub ttfb_timeout_ms: u64,
    /// Stream idle timeout, in milliseconds: the longest the gateway waits
    /// between two chunks of this model's stream before ending it with
    /// `provider_timeout` (`idle`). Absent means the gateway default (60 s).
    /// A model that reasons silently — OpenAI Responses sends no keepalive
    /// while it thinks — needs a longer one; the call's 300 s hard limit
    /// bounds it either way. Optional so a catalogue without it still
    /// deserialises; when present it must be at least 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_timeout_ms: Option<u64>,
    /// Whether the model is callable.
    pub enabled: bool,
}

/// The upstream API a model is reached through.
///
/// A style newer than this crate deserializes as [`ApiStyle::Unknown`] rather
/// than failing the whole catalogue: one new model must not make every older
/// gateway refuse the entire signed price list (and so price nothing). Such a
/// model is simply not callable here — [`Catalog::callable_model`] skips it.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiStyle {
    /// OpenAI Responses API.
    OpenaiResponses,
    /// OpenAI Chat Completions, and compatible APIs (xAI).
    OpenaiChat,
    /// Anthropic Messages API.
    AnthropicMessages,
    /// A style newer than this crate. Deserialization only; never callable.
    #[serde(other)]
    Unknown,
}

impl Catalog {
    /// The model named `id`, if it exists **and** is callable: enabled, not
    /// from a disabled provider, and reached through an [`ApiStyle`] this
    /// crate knows.
    #[must_use]
    pub fn callable_model(&self, id: &str) -> Option<&CatalogModel> {
        self.models.iter().find(|m| {
            m.id == id
                && m.enabled
                && m.api_style != ApiStyle::Unknown
                && !self.disabled_providers.contains(&m.provider)
        })
    }

    /// Structural checks a signature cannot make. A signed catalogue is
    /// trusted to be *authentic*, not to be *sane*: a signer bug should stop
    /// the gateway loudly rather than price every call at zero.
    ///
    /// * the schema is [`CATALOG_SCHEMA`], and `expires_at > issued_at`;
    /// * `platform_margin_bps ≤` [`MAX_PLATFORM_MARGIN_BPS`];
    /// * model ids are non-empty and unique;
    /// * every model has `min_charge_2z ≥ 1` — the per-call floor is what
    ///   makes a call with no billable usage still cost something;
    /// * `max_output_tokens ≤ context_window`;
    /// * prices are not all zero;
    /// * the safety factor only ever scales an estimate up.
    ///
    /// # Errors
    ///
    /// [`CatalogError::Invalid`] naming the first violation.
    pub fn validate(&self) -> Result<(), CatalogError> {
        if self.schema != CATALOG_SCHEMA {
            return Err(CatalogError::Invalid("unsupported catalogue schema"));
        }
        if self.expires_at <= self.issued_at {
            return Err(CatalogError::Invalid("expires_at not after issued_at"));
        }
        if self.platform_margin_bps > MAX_PLATFORM_MARGIN_BPS {
            return Err(CatalogError::Invalid(
                "platform margin above the sane bound",
            ));
        }
        let mut seen = BTreeSet::new();
        for model in &self.models {
            if model.id.is_empty() {
                return Err(CatalogError::Invalid("empty model id"));
            }
            if !seen.insert(model.id.as_str()) {
                return Err(CatalogError::Invalid("duplicate model id"));
            }
            if model.safety_factor_bps < Bps(crate::pricing::BPS_DENOMINATOR) {
                return Err(CatalogError::Invalid("safety factor below 1.0"));
            }
            if model.min_charge_2z == Whole2z::ZERO {
                return Err(CatalogError::Invalid("min_charge_2z below 1"));
            }
            if model.max_output_tokens > model.context_window {
                return Err(CatalogError::Invalid(
                    "max_output_tokens exceeds context_window",
                ));
            }
            if model.idle_timeout_ms == Some(0) {
                return Err(CatalogError::Invalid("idle_timeout_ms of 0"));
            }
            if model.prices == ModelPrices::default() {
                return Err(CatalogError::Invalid("all prices are zero"));
            }
        }
        Ok(())
    }
}

/// A key the consumer trusts to sign catalogues, with the id the platform
/// publishes it under. Rotation is two trusted keys at once.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrustedKey {
    /// The key id the detached signature names.
    pub key_id: String,
    /// The Ed25519 public key.
    pub key: VerifyingKey,
}

impl TrustedKey {
    /// A trusted key from its 64-character lowercase hex encoding.
    ///
    /// # Errors
    ///
    /// [`CatalogError::BadKey`] if the hex or the point is invalid.
    pub fn from_hex(key_id: impl Into<String>, public_key_hex: &str) -> Result<Self, CatalogError> {
        let bytes = decode_hex::<32>(public_key_hex).ok_or(CatalogError::BadKey)?;
        let key = VerifyingKey::from_bytes(&bytes).map_err(|_| CatalogError::BadKey)?;
        Ok(Self {
            key_id: key_id.into(),
            key,
        })
    }
}

/// A detached catalogue signature: which key, and the 64 signature bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DetachedSignature {
    /// The [`TrustedKey::key_id`] of the signing key.
    pub key_id: String,
    /// The signature.
    pub signature: Signature,
}

impl DetachedSignature {
    /// A signature from its 128-character lowercase hex encoding.
    ///
    /// # Errors
    ///
    /// [`CatalogError::BadSignatureEncoding`] if the hex is invalid.
    pub fn from_hex(key_id: impl Into<String>, signature_hex: &str) -> Result<Self, CatalogError> {
        let bytes = decode_hex::<64>(signature_hex).ok_or(CatalogError::BadSignatureEncoding)?;
        Ok(Self {
            key_id: key_id.into(),
            signature: Signature::from_bytes(&bytes),
        })
    }
}

/// Why a catalogue was refused.
#[non_exhaustive]
#[derive(Debug)]
pub enum CatalogError {
    /// The payload is not JSON.
    Json(serde_json::Error),
    /// The payload has no canonical form (a float or an unsafe integer).
    Canonical(CanonicalError),
    /// The signature names a key id nobody trusts.
    UnknownKey,
    /// A public key is malformed.
    BadKey,
    /// The signature is not 128 lowercase hex characters.
    BadSignatureEncoding,
    /// The signature does not verify.
    BadSignature,
    /// Verified, but not a valid catalogue.
    Invalid(&'static str),
    /// Verified, but `now ≥ expires_at`.
    Expired,
}

impl fmt::Display for CatalogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(e) => write!(f, "catalogue is not valid JSON: {e}"),
            Self::Canonical(e) => write!(f, "catalogue has no canonical form: {e}"),
            Self::UnknownKey => f.write_str("catalogue signed by an untrusted key id"),
            Self::BadKey => f.write_str("malformed catalogue public key"),
            Self::BadSignatureEncoding => f.write_str("malformed catalogue signature"),
            Self::BadSignature => f.write_str("catalogue signature does not verify"),
            Self::Invalid(why) => write!(f, "invalid catalogue: {why}"),
            Self::Expired => f.write_str("catalogue has expired"),
        }
    }
}

impl core::error::Error for CatalogError {}

/// The exact bytes a catalogue signature covers, for a payload already
/// parsed into a JSON tree: `CATALOG_SIGNING_LABEL || canonical_json(payload)`.
///
/// The platform's signer computes the same bytes; `fixtures/catalog/` pins
/// them.
///
/// # Errors
///
/// [`CatalogError::Canonical`] if the payload has no canonical form.
pub fn catalog_signing_message(payload: &Value) -> Result<Vec<u8>, CatalogError> {
    let canonical = to_canonical_json(payload).map_err(CatalogError::Canonical)?;
    let mut message =
        Vec::with_capacity(CATALOG_SIGNING_LABEL.len().saturating_add(canonical.len()));
    message.extend_from_slice(CATALOG_SIGNING_LABEL);
    message.extend_from_slice(&canonical);
    Ok(message)
}

/// Verify a served catalogue and return it.
///
/// `payload` is the catalogue JSON as served; `signature` is its detached
/// signature; `trusted` is every key currently trusted. The signature must
/// name a trusted key id and verify under that key, and the verified document
/// must pass [`Catalog::validate`].
///
/// `now_unix` is the caller's clock (this crate reads none); the catalogue
/// is refused when `now_unix ≥ expires_at`. The caller should re-check expiry
/// on its own schedule while it keeps using a catalogue, not only on accept.
///
/// This does **not** check [`Catalog::version`] against a previously accepted
/// catalogue; only the caller knows that value, and it must refuse a lower
/// one.
///
/// # Errors
///
/// A [`CatalogError`] saying which step refused it.
pub fn verify_catalog(
    payload: &[u8],
    signature: &DetachedSignature,
    trusted: &[TrustedKey],
    now_unix: u64,
) -> Result<Catalog, CatalogError> {
    let tree = verify_catalog_tree(payload, signature, trusted)?;
    // Inspect the signed tree before an older typed reader can discard a new
    // money field. Explicit null is presence too, not a schema-1 extension.
    if tree
        .get("models")
        .and_then(Value::as_array)
        .is_some_and(|models| {
            models
                .iter()
                .any(|model| model.get("long_context_pricing").is_some())
        })
    {
        return Err(CatalogError::Invalid(
            "context pricing requires catalogue schema 2",
        ));
    }
    let catalog: Catalog = serde_json::from_value(tree).map_err(CatalogError::Json)?;
    catalog.validate()?;
    if now_unix >= catalog.expires_at {
        return Err(CatalogError::Expired);
    }
    Ok(catalog)
}

/// Shared signature boundary; version-specific readers use this same tree.
pub(crate) fn verify_catalog_tree(
    payload: &[u8],
    signature: &DetachedSignature,
    trusted: &[TrustedKey],
) -> Result<Value, CatalogError> {
    let key = trusted
        .iter()
        .find(|k| k.key_id == signature.key_id)
        .ok_or(CatalogError::UnknownKey)?;
    let tree = parse_strict(payload).map_err(CatalogError::Json)?;
    let message = catalog_signing_message(&tree)?;
    key.key
        .verify_strict(&message, &signature.signature)
        .map_err(|_| CatalogError::BadSignature)?;
    Ok(tree)
}

/// Decode exactly `N` bytes of lowercase hex. Uppercase is refused so that a
/// key or signature has exactly one spelling.
fn decode_hex<const N: usize>(hex: &str) -> Option<[u8; N]> {
    let bytes = hex.as_bytes();
    if bytes.len() != N.checked_mul(2)? {
        return None;
    }
    let mut out = [0u8; N];
    for (slot, pair) in out.iter_mut().zip(bytes.chunks_exact(2)) {
        let [hi, lo] = pair else { return None };
        *slot = nibble(*hi)?.checked_mul(16)?.checked_add(nibble(*lo)?)?;
    }
    Some(out)
}

fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => c.checked_sub(b'0'),
        b'a'..=b'f' => c.checked_sub(b'a')?.checked_add(10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_default_closed_and_require_boolean_assertions() {
        assert_eq!(
            serde_json::from_str::<ModelCapabilities>("{}").ok(),
            Some(ModelCapabilities::default())
        );
        assert_eq!(
            serde_json::from_str::<ModelCapabilities>(r#"{"tools":true}"#).ok(),
            Some(ModelCapabilities {
                tools: true,
                ..ModelCapabilities::default()
            })
        );
        for invalid in [
            r#"{"tools":"true"}"#,
            r#"{"vision":null}"#,
            r#"{"reasoning":1}"#,
            r#"{"structured_output":null}"#,
            r#"{"structured_output":"true"}"#,
        ] {
            assert!(serde_json::from_str::<ModelCapabilities>(invalid).is_err());
        }
    }

    #[test]
    fn structured_output_is_tri_state_and_absent_is_not_serialized() {
        let absent: ModelCapabilities = serde_json::from_str(r#"{"tools":true}"#).unwrap();
        assert_eq!(absent.structured_output, None);
        assert_eq!(
            serde_json::to_string(&absent).unwrap(),
            r#"{"vision":false,"tools":true,"reasoning":false}"#
        );
        for (wire, declared) in [
            (r#"{"structured_output":true}"#, Some(true)),
            (r#"{"structured_output":false}"#, Some(false)),
        ] {
            let caps: ModelCapabilities = serde_json::from_str(wire).unwrap();
            assert_eq!(caps.structured_output, declared, "{wire}");
            assert!(!caps.is_empty(), "a declaration is never dropped: {wire}");
        }
    }

    #[test]
    fn hex_is_lowercase_and_exact_length() {
        assert_eq!(decode_hex::<2>("0aff"), Some([0x0a, 0xff]));
        assert_eq!(decode_hex::<2>("0AFF"), None);
        assert_eq!(decode_hex::<2>("0af"), None);
        assert_eq!(decode_hex::<2>("0aff00"), None);
        assert_eq!(decode_hex::<2>("0agf"), None);
    }
}
