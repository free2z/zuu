//! Deliberately small, credential-free IPC values.
use f2z_sdk::{
    Error,
    ai::{CallRecord, Charge},
    proto::Event,
    purchase::PurchaseIntent,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub type Result<T> = std::result::Result<T, NativeError>;
#[derive(Clone, Debug, Serialize)]
#[serde(transparent)]
pub struct NativeError(Box<ErrorBody>);
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub code: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_up: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record: Option<Value>,
    /// The envelope's documented `details` (`errors.md`): what a refusal
    /// needs for its recovery UX (`required_2z`, `available_milli_2z`,
    /// `cap_remaining_milli_2z`, `resets_at`, `reason`, `field`, …), with
    /// integers as decimal strings. Only members `errors.md` documents are
    /// passed; anything else stays native.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}
impl std::ops::Deref for NativeError {
    type Target = ErrorBody;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl std::ops::DerefMut for NativeError {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl NativeError {
    pub fn new(code: &str) -> Self {
        Self(Box::new(ErrorBody {
            code: code.into(),
            retryable: false,
            status: None,
            retry_after_seconds: None,
            call_id: None,
            idempotency_key: None,
            step_up: None,
            record: None,
            details: None,
        }))
    }
    pub fn key(mut self, key: &str) -> Self {
        self.idempotency_key = Some(key.into());
        self
    }
    pub fn call(mut self, call: Option<&str>) -> Self {
        if self.call_id.is_none() {
            self.call_id = call.map(str::to_owned);
        }
        self
    }
}
fn safe_code(value: &str) -> String {
    if !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        value.into()
    } else {
        "unknown_error".into()
    }
}
impl From<Error> for NativeError {
    fn from(error: Error) -> Self {
        let mut result = Self::new("internal_error");
        match error {
            Error::Api(e) => {
                result.code = safe_code(&e.code);
                result.retryable = e.retryable();
                result.status = Some(e.status);
                result.retry_after_seconds = e.retry_after.map(|d| d.as_secs().to_string());
                result.details = api_details(e.details.as_ref());
                result.call_id = e.call_id;
            }
            Error::StepUpRequired(e) => {
                result.code = "insufficient_user_authentication".into();
                result.step_up = Some(
                    json!({"maxAge":e.max_age.map(|v|v.to_string()),"acrValues":e.acr_values}),
                );
            }
            Error::Unconfirmed {
                idempotency_key, ..
            } => {
                result.code = "unconfirmed".into();
                result.idempotency_key = Some(idempotency_key);
            }
            Error::StreamInterrupted { call_id } => {
                result.code = "stream_interrupted".into();
                result.call_id = call_id;
            }
            Error::Replayed(record) => {
                result.code = "replayed".into();
                result.call_id = Some(record.call_id.clone());
                result.record = call_record(&record).ok();
            }
            Error::ChatFailed(e) => {
                result.code = "chat_failed".into();
                result.retryable = e.retryable();
                result.call_id = e.call_id;
            }
            Error::SignedOut(_) => result.code = "signed_out".into(),
            Error::Cancelled => result.code = "cancelled".into(),
            Error::Storage(_) => result.code = "storage_unavailable".into(),
            Error::Transport(_) => result.code = "transport_error".into(),
            Error::Timeout(_) => result.code = "timeout".into(),
            Error::Authorization(e) | Error::Token(e) => result.code = safe_code(&e.error),
            Error::UserCancelled => result.code = "user_cancelled".into(),
            Error::BrowserUnavailable(_) => result.code = "browser_unavailable".into(),
            Error::Browser(_) => result.code = "browser_error".into(),
            Error::StateMismatch | Error::IssuerMismatch { .. } | Error::IdToken(_) => {
                result.code = "invalid_authentication_response".into()
            }
            Error::Config(_) => result.code = "configuration_error".into(),
            Error::Discovery(_) | Error::Protocol(_) => result.code = "protocol_error".into(),
            _ => {}
        }
        result
    }
}
/// `details` members safe and useful in JavaScript: those `errors.md`
/// documents for a refusal, plus the idempotency conflict's `call_id` and
/// `in_flight`. Never a provider message or a settlement blob.
fn api_details(details: Option<&serde_json::Map<String, Value>>) -> Option<Value> {
    let kept: serde_json::Map<String, Value> = details?
        .iter()
        .filter(|(k, _)| {
            f2z_sdk::proto::error::PRE_CALL_DETAILS.contains(&k.as_str())
                || matches!(k.as_str(), "call_id" | "in_flight")
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if kept.is_empty() {
        return None;
    }
    let mut value = Value::Object(kept);
    decimalize(&mut value);
    Some(value)
}
/// Preserve every unsigned integer exactly at the JavaScript boundary.
fn decimalize(value: &mut Value) {
    match value {
        Value::Number(n) if n.is_u64() => *value = Value::String(n.to_string()),
        Value::Array(a) => a.iter_mut().for_each(decimalize),
        Value::Object(o) => o.values_mut().for_each(decimalize),
        _ => {}
    }
}
pub fn value<T: Serialize>(input: &T) -> Result<Value> {
    let mut value = serde_json::to_value(input).map_err(|_| NativeError::new("protocol_error"))?;
    decimalize(&mut value);
    Ok(value)
}
pub fn charge(input: Charge) -> Value {
    match input {
        Charge::Charged {
            charged_2z,
            receipt_id,
            collected_milli_2z,
            shortfall_milli_2z,
        } => json!({
            "state":"charged", "charged2z":charged_2z.get().to_string(), "receiptId":receipt_id,
            "collectedMilli2z":collected_milli_2z.map(|v|v.get().to_string()),
            "shortfallMilli2z":shortfall_milli_2z.map(|v|v.get().to_string()) }),
        Charge::NothingCharged => json!({"state":"released","charged2z":"0"}),
        _ => json!({"state":"pending"}),
    }
}
pub fn call_record(record: &CallRecord) -> Result<Value> {
    let mut result = value(record)?;
    // Caller metadata is opaque JSON, not a monetary DTO. Preserve its types.
    result["metadata"] =
        serde_json::to_value(&record.metadata).map_err(|_| NativeError::new("protocol_error"))?;
    result["charge"] = charge(record.charge());
    if let Some(error) = result.get_mut("error").and_then(Value::as_object_mut) {
        error.remove("message");
    }
    Ok(result)
}
pub fn event(event: &Event) -> Result<Value> {
    let mut result = value(event)?;
    match event {
        Event::Done(e) => result["charge"] = charge(e.outcome().into()),
        Event::Error(e) => {
            result["charge"] = charge(e.outcome().into());
            if let Some(o) = result.as_object_mut() {
                o.remove("message");
            }
        }
        _ => {}
    }
    Ok(result)
}
pub fn purchase(purchase: &PurchaseIntent) -> Result<Value> {
    let mut result = value(purchase)?;
    result["checkoutAvailable"] = Value::Bool(purchase.checkout_url().is_some());
    let mut rail = serde_json::Map::new();
    if purchase.rail == f2z_sdk::purchase::Rail::Zcash {
        for name in [
            "address",
            "amount_zat",
            "zip321_uri",
            "rate",
            "confirmations_required",
            "confirmations",
            "min_credit_2z",
            "payments",
            "below_minimum_zat",
        ] {
            if let Some(v) = result["rail_data"].get(name) {
                rail.insert(name.into(), v.clone());
            }
        }
    }
    result["rail_data"] = Value::Object(rail);
    Ok(result)
}
pub fn decimal(input: &str) -> Result<u64> {
    if input.is_empty()
        || (input.len() > 1 && input.starts_with('0'))
        || !input.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(NativeError::new("invalid_integer"));
    }
    input
        .parse()
        .map_err(|_| NativeError::new("invalid_integer"))
}
pub fn key(input: &str) -> Result<()> {
    if input.is_empty() || input.len() > 128 || !input.bytes().all(|b| (33..=126).contains(&b)) {
        return Err(NativeError::new("invalid_operation_key"));
    }
    Ok(())
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignInOptions {
    pub prompt: Option<String>,
    pub max_age: Option<String>,
    pub acr_values: Option<String>,
    pub login_hint: Option<String>,
    pub ui_locales: Option<String>,
    /// Whole 2Z as a decimal string.
    pub spend_cap: Option<String>,
    /// `day` | `week` | `month` | `total`; only with `spend_cap`.
    pub spend_period: Option<String>,
}
impl SignInOptions {
    pub fn into_core(self) -> Result<f2z_sdk::SignInOptions> {
        let mut out = f2z_sdk::SignInOptions::default();
        out.prompt = match self.prompt.as_deref() {
            None => None,
            Some("none") => Some(f2z_sdk::oauth::Prompt::None),
            Some("login") => Some(f2z_sdk::oauth::Prompt::Login),
            Some("consent") => Some(f2z_sdk::oauth::Prompt::Consent),
            _ => return Err(NativeError::new("invalid_prompt")),
        };
        out.max_age = self.max_age.as_deref().map(decimal).transpose()?;
        out.acr_values = self.acr_values;
        out.login_hint = self.login_hint;
        out.ui_locales = self.ui_locales;
        out.spend_cap = match (self.spend_cap.as_deref(), self.spend_period.as_deref()) {
            (None, None) => None,
            (None, Some(_)) => return Err(NativeError::new("invalid_request")),
            (Some(cap), period) => {
                let cap = decimal(cap)?;
                if cap == 0 || cap > f2z_sdk::oauth::MAX_SPEND_CAP_HINT_2Z {
                    return Err(NativeError::new("invalid_request"));
                }
                let hint = f2z_sdk::SpendCapHint::new(cap);
                match period {
                    None => Some(hint),
                    Some("day") => Some(hint.with_period(f2z_sdk::CapPeriod::Day)),
                    Some("week") => Some(hint.with_period(f2z_sdk::CapPeriod::Week)),
                    Some("month") => Some(hint.with_period(f2z_sdk::CapPeriod::Month)),
                    Some("total") => Some(hint.with_period(f2z_sdk::CapPeriod::Total)),
                    Some(_) => return Err(NativeError::new("invalid_request")),
                }
            }
        };
        Ok(out)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurchaseRequest {
    pub rail: String,
    pub quantity_2z: String,
    pub idempotency_key: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatOperation {
    pub operation_id: String,
    pub idempotency_key: String,
    /// The session generation (`session().generation`) the caller expects:
    /// registration refuses with `session_changed` if the session is no
    /// longer that one, under the same lock that pins the call to it.
    /// Absent: no expectation (the call joins the current session).
    #[serde(default)]
    pub session_generation: Option<String>,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PollOptions {
    pub timeout_ms: Option<u64>,
}
impl PollOptions {
    pub fn duration(&self) -> Result<std::time::Duration> {
        let value = self.timeout_ms.unwrap_or(120_000);
        if !(1..=300_000).contains(&value) {
            return Err(NativeError::new("invalid_timeout"));
        }
        Ok(std::time::Duration::from_millis(value))
    }
}
pub fn chat_request(mut input: Value) -> Result<f2z_sdk::proto::ChatRequest> {
    if serde_json::to_vec(&input)
        .map_err(|_| NativeError::new("invalid_request"))?
        .len()
        > 1_048_576
    {
        return Err(NativeError::new("request_too_large"));
    }
    if let Some(tokens) = input.get_mut("max_output_tokens")
        && !tokens.is_null()
    {
        *tokens = json!(decimal(
            tokens
                .as_str()
                .ok_or_else(|| NativeError::new("invalid_integer"))?
        )?);
    }
    let request: f2z_sdk::proto::ChatRequest =
        serde_json::from_value(input).map_err(|_| NativeError::new("invalid_request"))?;
    // The gateway's limits, before the call is registered or sent.
    request
        .check_tools()
        .map_err(|_| NativeError::new("invalid_request"))?;
    if let Some(format) = &request.response_format {
        format
            .check()
            .map_err(|_| NativeError::new("invalid_request"))?;
    }
    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_output_flag_passes_through_as_a_boolean_only() {
        let base = json!({"model":"m","messages":[],"max_output_tokens":"1800"});
        let plain = chat_request(base.clone()).unwrap();
        assert!(!plain.max_output_tokens_strict);
        assert!(
            !serde_json::to_string(&plain)
                .unwrap()
                .contains("max_output_tokens_strict")
        );
        let mut strict = base.clone();
        strict["max_output_tokens_strict"] = json!(true);
        let strict = chat_request(strict).unwrap();
        assert!(strict.max_output_tokens_strict);
        assert_eq!(strict.max_output_tokens, Some(1800));
        let mut bad = base;
        bad["max_output_tokens_strict"] = json!("true");
        assert!(chat_request(bad).is_err());
    }
    #[test]
    fn response_format_passes_through_as_plain_json_only_when_set() {
        let base = json!({"model":"m","messages":[]});
        let plain = chat_request(base.clone()).unwrap();
        assert_eq!(plain.response_format, None);
        assert!(
            !serde_json::to_string(&plain)
                .unwrap()
                .contains("response_format")
        );
        let format = json!({"type":"json_schema","json_schema":{"name":"activity_spec",
            "schema":{"type":"object","properties":{"n":{"maximum":9}}},"strict":true}});
        let mut with = base.clone();
        with["response_format"] = format.clone();
        let with = chat_request(with).unwrap();
        // Unlike max_output_tokens, schema numbers are ordinary JSON.
        assert_eq!(
            serde_json::to_value(&with).unwrap()["response_format"],
            format
        );
        let too_big = json!({"type":"json_schema","json_schema":{"name":"n",
            "schema":{"d":"x".repeat(32 * 1024)}}});
        let bad_name = json!({"type":"json_schema","json_schema":{"name":"has space",
            "schema":{"type":"object"}}});
        for format in [
            json!({"type":"text"}),
            serde_json::Value::Null,
            too_big,
            bad_name,
        ] {
            let mut bad = base.clone();
            bad["response_format"] = format;
            assert!(chat_request(bad).is_err());
        }
    }
    /// zuu#1132: the app's schema member order survives the IPC `Value` and
    /// reaches the SDK request as written.
    #[test]
    fn schema_member_order_survives_the_bridge() {
        let schema = r#"{"type":"object","properties":{"reasoning":{"type":"string"},"answer":{"type":"number"}},"required":["reasoning","answer"]}"#;
        let input: Value = serde_json::from_str(&format!(
            r#"{{"model":"m","messages":[],"tools":[{{"name":"f","parameters":{schema}}}],"response_format":{{"type":"json_schema","json_schema":{{"name":"n","schema":{schema}}}}}}}"#
        ))
        .unwrap();
        let mut sorted = input.clone();
        let sent = serde_json::to_string(&chat_request(input).unwrap()).unwrap();
        assert!(
            sent.contains(&format!(r#""parameters":{schema}"#)),
            "{sent}"
        );
        assert!(sent.contains(&format!(r#""schema":{schema}"#)), "{sent}");
        // Negative control: the sorted `Value` a build without
        // `preserve_order` hands the command does not survive, so the
        // assertions above can fail.
        sorted.sort_all_objects();
        let control = serde_json::to_string(&chat_request(sorted).unwrap()).unwrap();
        assert!(!control.contains(schema), "{control}");
    }
    #[test]
    fn refusal_details_reach_javascript_documented_members_only() {
        let details = json!({"reason":"max_output_tokens_strict","required_2z":12,
            "available_milli_2z":500,"resets_at":null,"provider_message":"secret"});
        let kept = api_details(details.as_object()).unwrap();
        assert_eq!(
            kept,
            json!({"reason":"max_output_tokens_strict","required_2z":"12",
                "available_milli_2z":"500","resets_at":null})
        );
        assert_eq!(api_details(json!({"x":1}).as_object()), None);
        assert_eq!(api_details(None), None);
    }
    #[test]
    fn reasoning_effort_passes_through_only_when_set_and_only_known_levels() {
        let base = json!({"model":"m","messages":[]});
        let plain = chat_request(base.clone()).unwrap();
        assert_eq!(plain.reasoning_effort, None);
        assert!(
            !serde_json::to_string(&plain)
                .unwrap()
                .contains("reasoning_effort")
        );
        for level in ["minimal", "low", "medium", "high"] {
            let mut with = base.clone();
            with["reasoning_effort"] = json!(level);
            let with = chat_request(with).unwrap();
            assert_eq!(
                serde_json::to_value(&with).unwrap()["reasoning_effort"],
                json!(level)
            );
        }
        for bad in [
            json!("xhigh"),
            json!("none"),
            json!("High"),
            json!(1),
            Value::Null,
        ] {
            let mut with = base.clone();
            with["reasoning_effort"] = bad;
            assert!(chat_request(with).is_err());
        }
    }
    #[test]
    fn tool_controls_pass_through_as_plain_json_and_limits_hold() {
        let base = json!({"model":"m","messages":[],
            "tools":[{"name":"check_answer","parameters":{"type":"object"},"strict":true}]});
        let mut with = base.clone();
        with["tool_choice"] = json!({"type":"function","function":{"name":"check_answer"}});
        with["parallel_tool_calls"] = json!(false);
        let sent = serde_json::to_value(chat_request(with.clone()).unwrap()).unwrap();
        for member in ["tools", "tool_choice", "parallel_tool_calls"] {
            assert_eq!(sent[member], with[member], "{member}");
        }
        let plain = serde_json::to_string(&chat_request(base.clone()).unwrap()).unwrap();
        assert!(!plain.contains("tool_choice") && !plain.contains("parallel_tool_calls"));
        for (member, value) in [
            ("tool_choice", json!("any")),
            ("tool_choice", serde_json::Value::Null),
            (
                "tool_choice",
                json!({"type":"function","function":{"name":"other"}}),
            ),
            ("parallel_tool_calls", json!("false")),
        ] {
            let mut bad = base.clone();
            bad[member] = value;
            assert!(chat_request(bad).is_err(), "{member}");
        }
        assert!(chat_request(json!({"model":"m","messages":[],"tool_choice":"auto"})).is_err());
    }
    #[test]
    fn a_tool_call_fragment_crosses_ipc_with_a_decimal_index() {
        let fragment: Event = serde_json::from_value(json!({"type":"tool_call_delta",
            "index":2,"id":"call_q1","name":"check_answer","arguments":"{"}))
        .unwrap();
        assert_eq!(
            event(&fragment).unwrap(),
            json!({"type":"tool_call_delta","index":"2","id":"call_q1",
                "name":"check_answer","arguments":"{"})
        );
    }
    #[test]
    fn integers_are_lossless_and_strict() {
        assert_eq!(value(&u64::MAX).unwrap(), json!("18446744073709551615"));
        for bad in ["01", "-1", "1.0", "", "18446744073709551616"] {
            assert!(decimal(bad).is_err());
        }
        assert_eq!(decimal("18446744073709551615").unwrap(), u64::MAX);
    }
    #[test]
    fn model_capabilities_stay_booleans_while_limits_and_prices_become_decimals() {
        // The live gpt-4o entry of GET /v1/models (2026-10-05), plus an
        // unknown capability and an older entry with no capabilities at all.
        let models: f2z_sdk::ai::Models = serde_json::from_value(json!({
            "catalog_version": 1_791_205_020_000_000u64, "includes_markup_bps": 0,
            "models": [{"id":"gpt-4o","provider":"openai","display_name":"gpt-4o",
                "context_window":128000,"max_output_tokens":16384,
                "capabilities":{"vision":false,"tools":false,"reasoning":false,
                    "structured_output":true,"audio":true},
                "prices":{"input_milli_2z_per_mtok":300000,"image_milli_2z":0},
                "min_charge_2z":1,"ttfb_timeout_ms":60000},
                {"id":"old"}]
        }))
        .unwrap();
        let v = value(&models).unwrap();
        assert_eq!(v["catalog_version"], "1791205020000000");
        let m = &v["models"][0];
        assert_eq!(m["capabilities"]["structured_output"], true);
        assert_eq!(m["capabilities"]["tools"], false);
        assert_eq!(m["context_window"], "128000");
        assert_eq!(m["prices"]["input_milli_2z_per_mtok"], "300000");
        assert_eq!(m["min_charge_2z"], "1");
        assert_eq!(m["ttfb_timeout_ms"], "60000");
        // The typed Rust catalogue carries only the declared capabilities.
        assert!(m["capabilities"].get("audio").is_none());
        // Absent upstream: explicit `false` and `null` across IPC.
        let old = &v["models"][1];
        assert_eq!(old["capabilities"]["structured_output"], false);
        assert!(old["provider"].is_null() && old["min_charge_2z"].is_null());
    }
    #[test]
    fn record_metadata_is_opaque_while_receipt_integers_are_exact() {
        let metadata = json!({"attempt":1,"charged_2z":3,"nested":[0,-1,1.5,{"input_tokens":4}],"string":"5","flag":true});
        let record: CallRecord = serde_json::from_value(json!({
            "call_id":"c", "status":"settled", "charged_2z":u64::MAX,
            "receipt_id":"receipt", "usage":{"input_tokens":2,"output_tokens":3},
            "metadata":metadata
        }))
        .unwrap();
        let result = call_record(&record).unwrap();
        assert_eq!(result["metadata"], metadata);
        assert_eq!(result["charged_2z"], u64::MAX.to_string());
        assert_eq!(result["usage"]["input_tokens"], "2");
        let replay = NativeError::from(Error::Replayed(Box::new(record)));
        assert_eq!(replay.record.as_ref().unwrap()["metadata"], metadata);
    }
    #[test]
    fn provisional_charge_never_becomes_a_receipt() {
        let pending: Event = serde_json::from_value(
            json!({"type":"done","finish_reason":"stop","settlement":"pending","charged_2z":99}),
        )
        .unwrap();
        assert_eq!(event(&pending).unwrap()["charge"]["state"], "pending");
        let released: Event = serde_json::from_value(
            json!({"type":"done","finish_reason":"stop","settlement":"released"}),
        )
        .unwrap();
        assert_eq!(
            event(&released).unwrap()["charge"],
            json!({"state":"released","charged2z":"0"})
        );
        let settled: Event = serde_json::from_value(
            json!({"type":"done","finish_reason":"stop","charged_2z":1,"receipt_id":"receipt"}),
        )
        .unwrap();
        assert_eq!(event(&settled).unwrap()["charge"]["charged2z"], "1");
        let settled: Event = serde_json::from_value(json!({"type":"done","finish_reason":"stop","charged_2z":1,"receipt_id":"receipt","collected_milli_2z":900,"shortfall_milli_2z":100})).unwrap();
        assert_eq!(
            event(&settled).unwrap()["charge"]["collectedMilli2z"],
            "900"
        );
        assert_eq!(
            event(&settled).unwrap()["charge"]["shortfallMilli2z"],
            "100"
        );
    }
    #[test]
    fn checkout_tokens_stay_native_and_zcash_amounts_stay_exact() {
        let card: PurchaseIntent = serde_json::from_value(json!({"id":"p","rail":"card","status":"pending","quantity_2z":100,
            "price":{"currency":"USD","amount_minor":100},"rail_data":{"checkout_url":"https://checkout.example/SECRET","client_secret":"SECRET"}})).unwrap();
        let value = purchase(&card).unwrap();
        assert_eq!(value["checkoutAvailable"], true);
        assert!(!value.to_string().contains("SECRET"));
        let zcash: PurchaseIntent = serde_json::from_value(json!({"id":"p","rail":"zcash","status":"pending","quantity_2z":100,
            "price":{"currency":"ZEC","amount_minor":100},"rail_data":{"address":"u1test","amount_zat":u64::MAX,"confirmations":2,"unknown_secret":"SECRET"}})).unwrap();
        let value = purchase(&zcash).unwrap();
        assert_eq!(value["rail_data"]["amount_zat"], "18446744073709551615");
        assert!(!value.to_string().contains("SECRET"));
    }
    #[test]
    fn sign_in_spend_cap_hint_is_optional_and_strict() {
        let parse = |v: Value| {
            serde_json::from_value::<SignInOptions>(v)
                .unwrap()
                .into_core()
        };
        assert_eq!(parse(json!({})).unwrap().spend_cap, None);
        let total = parse(json!({"spendCap":"500","spendPeriod":"total"})).unwrap();
        assert_eq!(total.spend_cap, Some(f2z_sdk::SpendCapHint::total(500)));
        let bare = parse(json!({"spendCap":"7"})).unwrap();
        assert_eq!(bare.spend_cap, Some(f2z_sdk::SpendCapHint::new(7)));
        for bad in [
            json!({"spendCap":"0"}),
            json!({"spendCap":"2147483648"}),
            json!({"spendCap":"01"}),
            json!({"spendCap":"5","spendPeriod":"year"}),
            json!({"spendPeriod":"total"}),
        ] {
            assert!(parse(bad).is_err());
        }
        // An older guest that knows nothing of the hint is unaffected.
        assert!(parse(json!({"prompt":"consent","maxAge":"0"})).is_ok());
    }
    #[test]
    fn raw_errors_never_cross_ipc() {
        for e in [
            Error::Storage("SECRET".into()),
            Error::Protocol("SECRET".into()),
            Error::Browser("SECRET".into()),
            Error::BrowserUnavailable("SECRET".into()),
        ] {
            assert!(
                !serde_json::to_string(&NativeError::from(e))
                    .unwrap()
                    .contains("SECRET")
            );
        }
    }
}
