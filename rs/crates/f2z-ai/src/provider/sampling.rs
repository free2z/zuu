//! Sampling admission and translation. No provider defaults are fabricated.
use super::*;
use serde_json::json;

pub(crate) const FIELDS: [&str; 11] = [
    "temperature",
    "top_p",
    "top_k",
    "stop",
    "seed",
    "logprobs",
    "top_logprobs",
    "frequency_penalty",
    "presence_penalty",
    "n",
    "logit_bias",
];

pub(super) fn refusal(field: &str, reason: &str) -> ApiFailure {
    ApiFailure::new(
        ErrorCode::InvalidRequest,
        "sampling control cannot be honoured",
    )
    .detail("field", field)
    .detail("reason", reason)
}

/// Validate even on the decoder's error path, without quoting caller data.
pub(crate) fn shape(value: &Value) -> Option<ApiFailure> {
    for field in FIELDS {
        let Some(v) = value.get(field) else { continue };
        let reason = if v.is_null() {
            Some("null")
        } else if field == "logit_bias" {
            Some("unsupported")
        } else if field == "n" && v.as_u64() != Some(1) {
            Some("n_unsupported")
        } else {
            let valid = match field {
                "temperature" => v.as_f64().is_some_and(|v| (0.0..=2.0).contains(&v)),
                "top_p" => v.as_f64().is_some_and(|v| (0.0..=1.0).contains(&v)),
                "frequency_penalty" | "presence_penalty" => {
                    v.as_f64().is_some_and(|v| (-2.0..=2.0).contains(&v))
                }
                "top_k" => v.as_u64().is_some_and(|v| v > 0),
                "top_logprobs" => v.as_u64().is_some_and(|v| v <= 20),
                "seed" => v.as_i64().is_some(),
                "logprobs" => v.is_boolean(),
                "stop" => v
                    .as_array()
                    .is_some_and(|v| v.len() <= 4 && v.iter().all(Value::is_string)),
                "n" => true,
                _ => false,
            };
            (!valid).then_some("range")
        };
        if let Some(reason) = reason {
            return Some(refusal(field, reason));
        }
    }
    if value.get("top_logprobs").is_some()
        && value.get("logprobs").and_then(Value::as_bool) != Some(true)
    {
        return Some(refusal("top_logprobs", "requires_logprobs"));
    }
    None
}

fn values(request: &ChatRequest) -> Value {
    let mut fields = serde_json::Map::new();
    if let Some(value) = &request.temperature {
        fields.insert("temperature".into(), json!(value));
    }
    if let Some(value) = &request.top_p {
        fields.insert("top_p".into(), json!(value));
    }
    if let Some(value) = &request.top_k {
        fields.insert("top_k".into(), json!(value));
    }
    if let Some(value) = &request.stop {
        fields.insert("stop".into(), json!(value));
    }
    if let Some(value) = &request.seed {
        fields.insert("seed".into(), json!(value));
    }
    if let Some(value) = &request.logprobs {
        fields.insert("logprobs".into(), json!(value));
    }
    if let Some(value) = &request.top_logprobs {
        fields.insert("top_logprobs".into(), json!(value));
    }
    if let Some(value) = &request.frequency_penalty {
        fields.insert("frequency_penalty".into(), json!(value));
    }
    if let Some(value) = &request.presence_penalty {
        fields.insert("presence_penalty".into(), json!(value));
    }
    if let Some(value) = &request.n {
        fields.insert("n".into(), json!(value));
    }
    if let Some(value) = &request.logit_bias {
        fields.insert("logit_bias".into(), json!(value));
    }
    Value::Object(fields)
}

pub(crate) fn check(request: &ChatRequest, model: &CatalogModel) -> Result<(), ApiFailure> {
    let value = values(request);
    if let Some(error) = shape(&value) {
        return Err(error);
    }
    let anthropic = model.api_style == ApiStyle::AnthropicMessages;
    let responses = model.api_style == ApiStyle::OpenaiResponses;
    for (field, supported) in [
        ("temperature", model.controls.temperature != Some(false)),
        ("top_p", model.controls.top_p != Some(false)),
        (
            "top_k",
            !responses && (anthropic || model.capabilities.top_k),
        ),
        ("stop", !responses),
        ("seed", !anthropic && !responses && model.capabilities.seed),
        ("logprobs", !anthropic && model.capabilities.logprobs),
        ("top_logprobs", !anthropic && model.capabilities.logprobs),
        (
            "frequency_penalty",
            !anthropic && !responses && model.capabilities.penalties,
        ),
        (
            "presence_penalty",
            !anthropic && !responses && model.capabilities.penalties,
        ),
    ] {
        if value.get(field).is_some() && !supported {
            return Err(refusal(field, "unsupported"));
        }
    }
    if anthropic && request.temperature.is_some_and(|v| v > 1.0) {
        return Err(refusal("temperature", "range"));
    }
    if model.controls.temperature_top_p_exclusive
        && request.temperature.is_some()
        && request.top_p.is_some()
    {
        return Err(refusal("controls", "conflict"));
    }
    Ok(())
}

pub(super) fn insert(
    body: &mut serde_json::Map<String, Value>,
    request: &ChatRequest,
    model: &CatalogModel,
) -> Result<(), ApiFailure> {
    check(request, model)?;
    let value = values(request);
    for field in FIELDS {
        let Some(v) = value.get(field) else { continue };
        if field == "n" && model.api_style != ApiStyle::OpenaiChat {
            continue;
        }
        if model.api_style == ApiStyle::OpenaiResponses && field == "logprobs" {
            if v == &Value::Bool(true) {
                body.insert("include".into(), json!(["message.output_text.logprobs"]));
            }
            continue;
        }
        let name = if field == "stop" && model.api_style == ApiStyle::AnthropicMessages {
            "stop_sequences"
        } else {
            field
        };
        body.insert(name.into(), v.clone());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sampling_shape_errors_name_fields_without_content() {
        for field in FIELDS {
            let e = shape(&json!({field: null})).unwrap();
            assert_eq!(e.detail_of("field"), Some(&json!(field)));
            assert_eq!(e.detail_of("reason"), Some(&json!("null")));
        }
        for (field, value, reason) in [
            ("n", json!(2), "n_unsupported"),
            ("logit_bias", json!({"SECRET":1}), "unsupported"),
            ("stop", json!(["1", "2", "3", "4", "5"]), "range"),
            ("top_logprobs", json!(21), "range"),
            ("top_logprobs", json!(2), "requires_logprobs"),
        ] {
            let e = shape(&json!({field: value})).unwrap();
            assert_eq!(e.detail_of("field"), Some(&json!(field)));
            assert_eq!(e.detail_of("reason"), Some(&json!(reason)));
        }
    }
}
