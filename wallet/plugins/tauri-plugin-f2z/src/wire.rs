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
    serde_json::from_value(input).map_err(|_| NativeError::new("invalid_request"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn integers_are_lossless_and_strict() {
        assert_eq!(value(&u64::MAX).unwrap(), json!("18446744073709551615"));
        for bad in ["01", "-1", "1.0", "", "18446744073709551616"] {
            assert!(decimal(bad).is_err());
        }
        assert_eq!(decimal("18446744073709551615").unwrap(), u64::MAX);
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
    fn raw_errors_never_cross_ipc() {
        for e in [
            Error::Storage("SECRET".into()),
            Error::Protocol("SECRET".into()),
            Error::Browser("SECRET".into()),
        ] {
            assert!(
                !serde_json::to_string(&NativeError::from(e))
                    .unwrap()
                    .contains("SECRET")
            );
        }
    }
}
