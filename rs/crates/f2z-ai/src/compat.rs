//! Strict request-side decoding primitives for compatibility encodings.
//!
//! Compatibility input is deliberately converted to the unified request
//! before admission reaches the metered backend. Unknown members are rejected
//! here rather than forwarded to a provider.
use f2z_ai_proto::chat::ChatRequest;
use serde_json::{Map, Value};

/// Decode the documented OpenAI Chat Completions request subset into the
/// gateway's native request. This function performs no provider I/O.
pub fn decode_chat_completions(input: &[u8]) -> Result<ChatRequest, DecodeError> {
    let value: Value =
        serde_json::from_slice(input).map_err(|_| DecodeError::new("/", "invalid_json"))?;
    let mut object = value
        .as_object()
        .cloned()
        .ok_or_else(|| DecodeError::new("/", "object_required"))?;
    const ACCEPTED: &[&str] = &[
        "model",
        "messages",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "max_tokens",
        "max_completion_tokens",
        "temperature",
        "top_p",
        "top_k",
        "stop",
        "seed",
        "logprobs",
        "top_logprobs",
        "frequency_penalty",
        "presence_penalty",
        "response_format",
        "reasoning_effort",
        "stream",
        "metadata",
        "f2z",
        "store",
        "n",
        "stream_options",
        "logit_bias",
    ];
    for key in object.keys() {
        if !ACCEPTED.contains(&key.as_str()) {
            let reason = match key.as_str() {
                "service_tier" => "stateless",
                "modalities" | "audio" | "prediction" => "modality_unsupported",
                "web_search_options" => "hosted_tool_unsupported",
                "functions" | "function_call" => "unsupported",
                "user" | "safety_identifier" | "prompt_cache_key" => "privacy_baseline",
                _ => "unknown",
            };
            return Err(DecodeError::new(
                &format!("/{}", pointer_segment(key)),
                reason,
            ));
        }
    }
    // Validate scalar shapes at their original compat paths before the
    // transformed request reaches serde's native schema.
    for (key, value) in &object {
        let valid = match key.as_str() {
            "model" => value.is_string(),
            "max_tokens" | "max_completion_tokens" | "top_k" | "top_logprobs" => {
                value.as_u64().is_some()
            }
            "seed" => value.as_i64().is_some(),
            "temperature" | "top_p" | "frequency_penalty" | "presence_penalty" => value.is_number(),
            "stream" | "parallel_tool_calls" | "logprobs" => value.is_boolean(),
            "reasoning_effort" => value.is_string(),
            "metadata" => value.is_object(),
            _ => true,
        };
        if !valid {
            return Err(DecodeError::new(
                &format!("/{}", pointer_segment(key)),
                "invalid_field",
            ));
        }
    }
    validate_nested_fields(&object)?;
    if !object.contains_key("model") {
        return Err(DecodeError::new("/model", "required"));
    }
    if let Some(store) = object.remove("store")
        && store != Value::Bool(false)
    {
        return Err(DecodeError::new("/store", "stateless"));
    }
    if let Some(n) = object.remove("n")
        && n != serde_json::json!(1)
    {
        return Err(DecodeError::new("/n", "unsupported"));
    }
    if object.contains_key("logit_bias") {
        return Err(DecodeError::new("/logit_bias", "unsupported"));
    }
    if let Some(options) = object.remove("stream_options") {
        let options = options
            .as_object()
            .ok_or_else(|| DecodeError::new("/stream_options", "object_required"))?;
        for (key, value) in options {
            if key != "include_usage" {
                return Err(DecodeError::new(
                    &format!("/stream_options/{}", pointer_segment(key)),
                    "unknown",
                ));
            }
            if !value.is_boolean() {
                return Err(DecodeError::new(
                    "/stream_options/include_usage",
                    "invalid_field",
                ));
            }
        }
    }
    object.entry("stream").or_insert(Value::Bool(false));
    let max_tokens = object.remove("max_tokens");
    let max_completion_tokens = object.remove("max_completion_tokens");
    if max_tokens.is_some()
        && max_completion_tokens.is_some()
        && max_tokens != max_completion_tokens
    {
        return Err(DecodeError::new("/max_tokens", "alias_conflict"));
    }
    if let Some(v) = max_tokens.or(max_completion_tokens) {
        object.insert("max_output_tokens".into(), v);
    }
    let f2z = object.remove("f2z");
    if let Some(ext) = f2z {
        let ext = ext
            .as_object()
            .ok_or_else(|| DecodeError::new("/f2z", "object_required"))?;
        for key in ext.keys() {
            if key != "max_output_tokens_strict" {
                return Err(DecodeError::new(
                    &format!("/f2z/{}", pointer_segment(key)),
                    "unknown",
                ));
            }
        }
        if let Some(v) = ext.get("max_output_tokens_strict") {
            if !v.is_boolean() {
                return Err(DecodeError::new(
                    "/f2z/max_output_tokens_strict",
                    "invalid_field",
                ));
            }
            object.insert("max_output_tokens_strict".into(), v.clone());
        }
    }
    if let Some(tools) = object.get_mut("tools") {
        let tools = tools
            .as_array_mut()
            .ok_or_else(|| DecodeError::new("/tools", "array_required"))?;
        for (i, tool) in tools.iter_mut().enumerate() {
            let path = format!("/tools/{i}");
            let wrapper = tool
                .as_object()
                .ok_or_else(|| DecodeError::new(&path, "object_required"))?;
            if let Some(key) = wrapper.keys().find(|k| *k != "type" && *k != "function") {
                return Err(DecodeError::new(
                    &format!("{path}/{}", pointer_segment(key)),
                    "unknown",
                ));
            }
            if wrapper.get("type").and_then(Value::as_str) != Some("function") {
                return Err(DecodeError::new(
                    &format!("{path}/type"),
                    "hosted_tool_unsupported",
                ));
            }
            let function = wrapper
                .get("function")
                .and_then(Value::as_object)
                .ok_or_else(|| DecodeError::new(&format!("{path}/function"), "object_required"))?;
            for (key, value) in function {
                let valid = match key.as_str() {
                    "name" | "description" => value.is_string(),
                    "parameters" => value.is_object(),
                    "strict" => value.is_boolean(),
                    _ => {
                        return Err(DecodeError::new(
                            &format!("{path}/function/{}", pointer_segment(key)),
                            "unknown",
                        ));
                    }
                };
                if !valid {
                    return Err(DecodeError::new(
                        &format!("{path}/function/{}", pointer_segment(key)),
                        "invalid_field",
                    ));
                }
            }
            for required in ["name", "parameters"] {
                if !function.contains_key(required) {
                    return Err(DecodeError::new(
                        &format!("{path}/function/{required}"),
                        "required",
                    ));
                }
            }
            *tool = Value::Object(function.clone());
        }
    }
    let messages = object
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| DecodeError::new("/messages", "array_required"))?;
    for (index, message) in messages.iter_mut().enumerate() {
        let path = format!("/messages/{index}");
        let m = message
            .as_object_mut()
            .ok_or_else(|| DecodeError::new(&path, "object_required"))?;
        for key in m.keys() {
            if !["role", "content", "tool_calls", "tool_call_id"].contains(&key.as_str()) {
                return Err(DecodeError::new(
                    &format!("{path}/{}", pointer_segment(key)),
                    "unsupported",
                ));
            }
        }
        let role = m
            .get("role")
            .and_then(Value::as_str)
            .ok_or_else(|| DecodeError::new(&format!("{path}/role"), "required"))?;
        if !["system", "user", "assistant", "tool"].contains(&role) {
            return Err(DecodeError::new(&format!("{path}/role"), "unsupported"));
        }
        if m.get("content") == Some(&Value::Null) {
            if role != "assistant" || !m.contains_key("tool_calls") {
                return Err(DecodeError::new(
                    &format!("{path}/content"),
                    "invalid_field",
                ));
            }
            m.remove("content");
        }
        if let Some(content) = m.get_mut("content") {
            if let Some(parts) = content.as_array_mut() {
                for (part_index, part) in parts.iter_mut().enumerate() {
                    let p = part.as_object().ok_or_else(|| {
                        DecodeError::new(&format!("{path}/content/{part_index}"), "object_required")
                    })?;
                    match p.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(key) = p.keys().find(|k| *k != "type" && *k != "text") {
                                return Err(DecodeError::new(
                                    &format!(
                                        "{path}/content/{part_index}/{}",
                                        pointer_segment(key)
                                    ),
                                    "unknown",
                                ));
                            }
                            let text = p.get("text").and_then(Value::as_str).ok_or_else(|| {
                                DecodeError::new(
                                    &format!("{path}/content/{part_index}/text"),
                                    "invalid_field",
                                )
                            })?;
                            *part = serde_json::json!({"type":"text","text":text});
                        }
                        Some("image_url") => {
                            checked_object(
                                part,
                                &format!("{path}/content/{part_index}"),
                                &["type", "image_url"],
                            )?;
                            let image_path = format!("{path}/content/{part_index}/image_url");
                            checked_object(&p["image_url"], &image_path, &["url"])?;
                            let url = p
                                .get("image_url")
                                .and_then(|v| v.get("url"))
                                .and_then(Value::as_str)
                                .ok_or_else(|| {
                                    DecodeError::new(
                                        &format!("{path}/content/{part_index}/image_url/url"),
                                        "required",
                                    )
                                })?;
                            let (media_type, data) = url
                                .strip_prefix("data:")
                                .and_then(|s| s.split_once(";base64,"))
                                .ok_or_else(|| {
                                    DecodeError::new(
                                        &format!("{path}/content/{part_index}/image_url/url"),
                                        "url_fetch_unsupported",
                                    )
                                })?;
                            *part = serde_json::json!({"type":"image","media_type":media_type,"data":data});
                        }
                        _ => {
                            return Err(DecodeError::new(
                                &format!("{path}/content/{part_index}/type"),
                                "unsupported",
                            ));
                        }
                    }
                }
            } else if let Some(text) = content.as_str() {
                *content = serde_json::json!([{"type":"text","text":text}]);
            } else {
                return Err(DecodeError::new(
                    &format!("{path}/content"),
                    "invalid_field",
                ));
            }
        }
        // OpenAI tool calls use function.name + JSON arguments; the unified
        // protocol uses flat name/arguments. Validate instead of forwarding.
        if m.get("tool_calls").is_some_and(|v| !v.is_array()) {
            return Err(DecodeError::new(
                &format!("{path}/tool_calls"),
                "array_required",
            ));
        }
        if let Some(calls) = m.get_mut("tool_calls").and_then(Value::as_array_mut) {
            for (call_index, call) in calls.iter_mut().enumerate() {
                let c = call.as_object().ok_or_else(|| {
                    DecodeError::new(
                        &format!("{path}/tool_calls/{call_index}"),
                        "object_required",
                    )
                })?;
                let call_path = format!("{path}/tool_calls/{call_index}");
                checked_object(call, &call_path, &["id", "type", "function"])?;
                if c.get("type").and_then(Value::as_str) != Some("function") {
                    return Err(DecodeError::new(
                        &format!("{call_path}/type"),
                        "unsupported",
                    ));
                }
                let f = c
                    .get("function")
                    .and_then(Value::as_object)
                    .ok_or_else(|| {
                        DecodeError::new(
                            &format!("{path}/tool_calls/{call_index}/function"),
                            "required",
                        )
                    })?;
                checked_object(
                    &c["function"],
                    &format!("{call_path}/function"),
                    &["name", "arguments"],
                )?;
                for (member, value) in [
                    ("id", c.get("id")),
                    ("function/name", f.get("name")),
                    ("function/arguments", f.get("arguments")),
                ] {
                    if !value.is_some_and(Value::is_string) {
                        return Err(DecodeError::new(
                            &format!("{path}/tool_calls/{call_index}/{member}"),
                            "invalid_field",
                        ));
                    }
                }
                *call = serde_json::json!({"id":c.get("id"),"name":f.get("name"),"arguments":f.get("arguments")});
            }
        }
    }
    let mut native = Map::new();
    for (key, value) in object {
        native.insert(key, value);
    }
    match serde_json::from_value(Value::Object(native.clone())) {
        Ok(request) => Ok(request),
        Err(_) => {
            // Nested shapes were checked above. Diagnose any future native
            // scalar constraint at its submitted top-level field, without
            // returning serde's error text (which can quote prompt values).
            for (key, value) in &native {
                let mut probe = Map::new();
                probe.insert("model".into(), "probe".into());
                probe.insert("messages".into(), Value::Array(Vec::new()));
                probe.insert(key.clone(), value.clone());
                if serde_json::from_value::<ChatRequest>(Value::Object(probe)).is_err() {
                    let key = match key.as_str() {
                        "max_output_tokens" => "max_completion_tokens",
                        "max_output_tokens_strict" => "f2z/max_output_tokens_strict",
                        key => key,
                    };
                    return Err(DecodeError::new(&format!("/{key}"), "invalid_field"));
                }
            }
            Err(DecodeError::new("/", "invalid_field"))
        }
    }
}

fn checked_object<'a>(
    value: &'a Value,
    path: &str,
    allowed: &[&str],
) -> Result<&'a Map<String, Value>, DecodeError> {
    let object = value
        .as_object()
        .ok_or_else(|| DecodeError::new(path, "object_required"))?;
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(DecodeError::new(
            &format!("{path}/{}", pointer_segment(key)),
            "unknown",
        ));
    }
    Ok(object)
}

fn string_member(object: &Map<String, Value>, key: &str, path: &str) -> Result<(), DecodeError> {
    if !object.get(key).is_some_and(Value::is_string) {
        return Err(DecodeError::new(&format!("{path}/{key}"), "invalid_field"));
    }
    Ok(())
}

// These shapes are transformed or decoded by native custom deserializers.
// Validate at the original boundary so malformed nested values retain their
// exact submitted pointer instead of collapsing to the root of the request.
fn validate_nested_fields(object: &Map<String, Value>) -> Result<(), DecodeError> {
    if let Some(metadata) = object.get("metadata").and_then(Value::as_object) {
        for (key, value) in metadata {
            if !value.is_string() {
                return Err(DecodeError::new(
                    &format!("/metadata/{}", pointer_segment(key)),
                    "invalid_field",
                ));
            }
        }
    }
    if let Some(stop) = object.get("stop") {
        let items = stop
            .as_array()
            .ok_or_else(|| DecodeError::new("/stop", "array_required"))?;
        for (i, item) in items.iter().enumerate() {
            if !item.is_string() {
                return Err(DecodeError::new(&format!("/stop/{i}"), "invalid_field"));
            }
        }
    }
    if let Some(effort) = object.get("reasoning_effort")
        && !matches!(effort.as_str(), Some("minimal" | "low" | "medium" | "high"))
    {
        return Err(DecodeError::new(
            "/reasoning_effort",
            "reasoning_effort_unsupported",
        ));
    }
    if let Some(choice) = object.get("tool_choice") {
        if let Some(mode) = choice.as_str() {
            if !matches!(mode, "auto" | "none" | "required") {
                return Err(DecodeError::new("/tool_choice", "unsupported"));
            }
        } else {
            let choice = checked_object(choice, "/tool_choice", &["type", "function"])?;
            if choice.get("type").and_then(Value::as_str) != Some("function") {
                return Err(DecodeError::new("/tool_choice/type", "unsupported"));
            }
            let function = checked_object(
                choice.get("function").unwrap_or(&Value::Null),
                "/tool_choice/function",
                &["name"],
            )?;
            string_member(function, "name", "/tool_choice/function")?;
        }
    }
    if let Some(format) = object.get("response_format") {
        let format = format
            .as_object()
            .ok_or_else(|| DecodeError::new("/response_format", "object_required"))?;
        let allowed: &[&str] = match format.get("type").and_then(Value::as_str) {
            Some("json_object") => &["type"],
            Some("json_schema") => &["type", "json_schema"],
            _ => return Err(DecodeError::new("/response_format/type", "unsupported")),
        };
        checked_object(&Value::Object(format.clone()), "/response_format", allowed)?;
        if allowed.len() == 2 {
            let schema = checked_object(
                format.get("json_schema").unwrap_or(&Value::Null),
                "/response_format/json_schema",
                &["name", "schema", "strict"],
            )?;
            string_member(schema, "name", "/response_format/json_schema")?;
            if !schema.contains_key("schema") {
                return Err(DecodeError::new(
                    "/response_format/json_schema/schema",
                    "required",
                ));
            }
            if schema.get("strict").is_some_and(|v| !v.is_boolean()) {
                return Err(DecodeError::new(
                    "/response_format/json_schema/strict",
                    "invalid_field",
                ));
            }
        }
    }
    if let Some(messages) = object.get("messages").and_then(Value::as_array) {
        for (i, message) in messages.iter().enumerate() {
            if message.get("tool_call_id").is_some_and(|v| !v.is_string()) {
                return Err(DecodeError::new(
                    &format!("/messages/{i}/tool_call_id"),
                    "invalid_field",
                ));
            }
        }
    }
    Ok(())
}

fn pointer_segment(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

/// A content-free, JSON-pointer-addressed decoder refusal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodeError {
    /// JSON pointer to the refused member.
    pub param: String,
    /// Stable, content-free refusal reason.
    pub reason: &'static str,
}
impl DecodeError {
    fn new(param: &str, reason: &'static str) -> Self {
        Self {
            param: param.to_owned(),
            reason,
        }
    }
}

/// Render the gateway's internal SSE frames as Chat Completions chunks.
pub(crate) struct ChatStream {
    body: crate::call::DeliveryBody,
    meta: Option<f2z_ai_proto::event::Meta>,
    usage: Option<f2z_ai_proto::chat::Usage>,
    usage_source: Option<f2z_ai_proto::chat::UsageSource>,
    created: u64,
    fragment_indices: std::collections::HashMap<u32, u32>,
    fragment_ids: std::collections::HashMap<String, u32>,
    completed_tools: u32,
    include_usage: bool,
}

impl ChatStream {
    pub(crate) fn new(body: crate::call::DeliveryBody, include_usage: bool) -> Self {
        Self {
            body,
            meta: None,
            usage: None,
            usage_source: None,
            created: crate::catalog::now_unix(),
            fragment_indices: Default::default(),
            fragment_ids: Default::default(),
            completed_tools: 0,
            include_usage,
        }
    }
    fn chunk(&self, delta: Value, finish: Value, extra: Value) -> Value {
        let Some(meta) = self.meta.as_ref() else {
            return Value::Null;
        };
        let mut v = serde_json::json!({"id":meta.call_id,"object":"chat.completion.chunk","created":self.created,"model":meta.model,"choices":[{"index":0,"delta":delta,"finish_reason":finish}]});
        if let Some(extra) = extra.as_object()
            && let Some(object) = v.as_object_mut()
        {
            object.extend(extra.clone());
        }
        v
    }
    fn render(&mut self, event: f2z_ai_proto::Event) -> Option<String> {
        use f2z_ai_proto::Event;
        let v = match event {
            Event::Meta(meta) => {
                self.meta = Some(meta.clone());
                self.chunk(
                    serde_json::json!({"role":"assistant","content":""}),
                    Value::Null,
                    serde_json::json!({"f2z":meta}),
                )
            }
            Event::Delta(delta) if self.meta.is_some() => {
                let mut chunk = self.chunk(
                    serde_json::json!({"content":delta.text}),
                    Value::Null,
                    Value::Null,
                );
                if let Some(logprobs) = delta.logprobs
                    && let Some(choice) = chunk
                        .get_mut("choices")
                        .and_then(Value::as_array_mut)
                        .and_then(|c| c.first_mut())
                        .and_then(Value::as_object_mut)
                {
                    choice.insert("logprobs".into(), logprobs);
                }
                chunk
            }
            Event::ToolCallDelta(delta) if self.meta.is_some() => {
                let next = u32::try_from(self.fragment_indices.len()).unwrap_or(u32::MAX);
                let index = *self.fragment_indices.entry(delta.index).or_insert(next);
                if let Some(id) = &delta.id {
                    self.fragment_ids.insert(id.clone(), index);
                }
                let mut function = serde_json::json!({"arguments":delta.arguments});
                if let Some(name) = delta.name
                    && let Some(object) = function.as_object_mut()
                {
                    object.insert("name".into(), name.into());
                }
                let mut call = serde_json::json!({"index":index,"function":function});
                if let Some(id) = delta.id
                    && let Some(object) = call.as_object_mut()
                {
                    object.insert("id".into(), id.into());
                    object.insert("type".into(), "function".into());
                }
                self.chunk(
                    serde_json::json!({"tool_calls":[call]}),
                    Value::Null,
                    Value::Null,
                )
            }
            Event::ToolCall(tool) if self.meta.is_some() => {
                if self.fragment_ids.contains_key(&tool.id) {
                    return None;
                }
                let index = self
                    .completed_tools
                    .max(u32::try_from(self.fragment_indices.len()).unwrap_or(u32::MAX));
                self.completed_tools = index.saturating_add(1);
                self.chunk(serde_json::json!({"tool_calls":[{"index":index,"id":tool.id,"type":"function","function":{"name":tool.name,"arguments":tool.arguments}}]}), Value::Null, Value::Null)
            }
            Event::Usage(usage) => {
                self.usage = Some(usage.usage);
                self.usage_source = Some(usage.source);
                return None;
            }
            Event::Done(done) if self.meta.is_some() => {
                let usage = self.usage.map(|u| {
                    compat_usage(
                        u,
                        self.meta.as_ref().and_then(|m| m.provider.as_deref()) == Some("xai"),
                    )
                });
                let mut f2z = serde_json::to_value(self.meta.as_ref()).unwrap_or(Value::Null);
                if let (Some(target), Ok(Value::Object(fields))) =
                    (f2z.as_object_mut(), serde_json::to_value(&done))
                {
                    target.extend(fields);
                    if let Some(source) = self.usage_source {
                        target.insert("usage_source".into(), serde_json::json!(source));
                    }
                }
                let result = self.chunk(
                    serde_json::json!({}),
                    serde_json::to_value(done.finish_reason).unwrap_or(Value::Null),
                    serde_json::json!({"usage":usage,"f2z":f2z}),
                );
                let trailing = if self.include_usage {
                    let meta = self.meta.as_ref()?;
                    let chunk = serde_json::json!({"id":meta.call_id,"object":"chat.completion.chunk","created":self.created,"model":meta.model,"choices":[],"usage":usage});
                    format!("data: {chunk}\n\n")
                } else {
                    String::new()
                };
                return Some(format!("data: {result}\n\n{trailing}data: [DONE]\n\n"));
            }
            Event::Error(error) => {
                serde_json::json!({"error":{"code":error.code,"message":error.message,"type":crate::error::compat_error_type(error.code.as_str()),"param":null,"details":error}})
            }
            _ => return None,
        };
        Some(format!("data: {v}\n\n"))
    }
}

fn compat_usage(u: f2z_ai_proto::chat::Usage, xai: bool) -> Value {
    let prompt = u
        .input_tokens
        .saturating_add(u.cached_input_tokens)
        .saturating_add(u.cache_write_tokens);
    let completion = if xai {
        u.output_tokens.saturating_sub(u.reasoning_tokens)
    } else {
        u.output_tokens
    };
    serde_json::json!({"prompt_tokens":prompt,"completion_tokens":completion,"total_tokens":prompt.saturating_add(completion),"prompt_tokens_details":{"cached_tokens":u.cached_input_tokens},"completion_tokens_details":{"reasoning_tokens":u.reasoning_tokens}})
}

impl http_body::Body for ChatStream {
    type Data = bytes::Bytes;
    type Error = crate::call::DeliveryEnded;
    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        use std::task::Poll;
        loop {
            match std::pin::Pin::new(&mut self.body).poll_frame(cx) {
                Poll::Ready(Some(Ok(frame))) => {
                    let Ok(data) = frame.into_data() else {
                        continue;
                    };
                    if data.starts_with(b":") {
                        return Poll::Ready(Some(Ok(http_body::Frame::data(data))));
                    }
                    let Ok(event) = crate::nonstream::event(&data) else {
                        continue;
                    };
                    if let Some(output) = self.render(event) {
                        return Poll::Ready(Some(Ok(http_body::Frame::data(output.into()))));
                    }
                }
                other => return other,
            }
        }
    }
}

pub(crate) fn render_nonstream(value: Value, success: bool) -> Value {
    if !success {
        let mut value = value;
        let details = value
            .pointer("/error/details")
            .cloned()
            .unwrap_or(Value::Null);
        if let Some(error) = value.get_mut("error").and_then(Value::as_object_mut) {
            let kind = error
                .get("code")
                .and_then(Value::as_str)
                .map(crate::error::compat_error_type)
                .unwrap_or("server_error");
            error.insert("type".into(), kind.into());
            error.insert("param".into(), Value::Null);
        }
        if let Some(object) = value.as_object_mut() {
            object.insert("f2z".into(), details);
        }
        return value;
    }
    let message = value.get("message").unwrap_or(&Value::Null);
    let text = message
        .get("content")
        .unwrap_or(&Value::Null)
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<String>()
        })
        .unwrap_or_default();
    let calls: Vec<Value> = message.get("tool_calls").unwrap_or(&Value::Null).as_array().into_iter().flatten().map(|c| serde_json::json!({"id":c["id"],"type":"function","function":{"name":c["name"],"arguments":c["arguments"]}})).collect();
    let mut assistant = serde_json::json!({"role":"assistant","content":text});
    if !calls.is_empty()
        && let Some(object) = assistant.as_object_mut()
    {
        object.insert("tool_calls".into(), calls.into());
    }
    let usage = serde_json::from_value::<f2z_ai_proto::chat::Usage>(
        value.get("usage").cloned().unwrap_or(Value::Null),
    )
    .ok()
    .map(|u| {
        compat_usage(
            u,
            value.get("provider").and_then(Value::as_str) == Some("xai"),
        )
    });
    let mut choice = serde_json::json!({"index":0,"message":assistant,"finish_reason":value.get("finish_reason")});
    if let Some(chunks) = message.get("logprobs").and_then(Value::as_array)
        && !chunks.is_empty()
    {
        let mut combined = Map::new();
        for chunk in chunks {
            if let Some(fields) = chunk.as_object() {
                for (key, data) in fields {
                    if let Some(items) = data.as_array() {
                        let dest = combined
                            .entry(key.clone())
                            .or_insert_with(|| Value::Array(Vec::new()));
                        if let Some(dest) = dest.as_array_mut() {
                            dest.extend(items.clone());
                        }
                    }
                }
            }
        }
        if let Some(object) = choice.as_object_mut() {
            object.insert("logprobs".into(), Value::Object(combined));
        }
    }
    serde_json::json!({"id":value.get("call_id"),"object":"chat.completion","created":crate::catalog::now_unix(),"model":value.get("model"),"choices":[choice],"usage":usage,"f2z":value})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_nested_fields_report_submitted_json_pointers() {
        for (field, value, pointer) in [
            ("stop", serde_json::json!(["ok", 12]), "/stop/1"),
            ("seed", serde_json::json!(18446744073709551615u64), "/seed"),
            (
                "metadata",
                serde_json::json!({"a/b~":12}),
                "/metadata/a~1b~0",
            ),
            (
                "tool_choice",
                serde_json::json!({"type":"function","function":{"name":12}}),
                "/tool_choice/function/name",
            ),
            (
                "tool_choice",
                serde_json::json!({"type":"function","function":{"name":"f","extra":true}}),
                "/tool_choice/function/extra",
            ),
            (
                "response_format",
                serde_json::json!({"type":"json_schema","json_schema":{"name":"f","schema":{},"strict":null}}),
                "/response_format/json_schema/strict",
            ),
            (
                "response_format",
                serde_json::json!({"type":"json_schema","json_schema":{"name":12,"schema":{}}}),
                "/response_format/json_schema/name",
            ),
            (
                "response_format",
                serde_json::json!({"type":"json_object","extra":true}),
                "/response_format/extra",
            ),
            (
                "messages",
                serde_json::json!([{"role":"tool","tool_call_id":12}]),
                "/messages/0/tool_call_id",
            ),
            (
                "messages",
                serde_json::json!([{"role":"user","content":[{"type":"text","text":12}]}]),
                "/messages/0/content/0/text",
            ),
            (
                "messages",
                serde_json::json!([{"role":"user","content":[{"type":"text","text":"x","extra":true}]}]),
                "/messages/0/content/0/extra",
            ),
            (
                "messages",
                serde_json::json!([{"role":"assistant","tool_calls":[{"id":"c","type":"function","function":{"name":"f","arguments":{},"extra":true}}]}]),
                "/messages/0/tool_calls/0/function/extra",
            ),
            (
                "tools",
                serde_json::json!([{"type":"function","function":{"name":"f","parameters":{},"extra":true}}]),
                "/tools/0/function/extra",
            ),
        ] {
            let mut request =
                serde_json::json!({"model":"m","messages":[{"role":"user","content":"hello"}]});
            request[field] = value;
            assert_eq!(
                decode_chat_completions(request.to_string().as_bytes())
                    .unwrap_err()
                    .param,
                pointer
            );
        }
    }
    #[test]
    fn maps_standard_text_request_to_native_chat_request() {
        let request = decode_chat_completions(br#"{"model":"m","messages":[{"role":"user","content":"hello"}],"max_completion_tokens":12,"stream":false}"#).unwrap();
        assert_eq!(request.max_output_tokens, Some(12));
        assert_eq!(request.messages[0].content.len(), 1);
    }
    #[test]
    fn refuses_unknown_and_unsupported_fields_without_forwarding() {
        for (body, param, reason) in [
            (
                br#"{"model":"m","messages":[],"vendor_extension":1}"#.as_slice(),
                "/vendor_extension",
                "unknown",
            ),
            (
                br#"{"model":"m","messages":[],"store":true}"#.as_slice(),
                "/store",
                "stateless",
            ),
        ] {
            let error = decode_chat_completions(body).unwrap_err();
            assert_eq!((error.param.as_str(), error.reason), (param, reason));
        }
    }
    #[test]
    fn aliases_defaults_and_function_tools() {
        let request = decode_chat_completions(br#"{"model":"m","messages":[{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"f","arguments":"{}"}}]}],"tools":[{"type":"function","function":{"name":"f","parameters":{"type":"object"}}}],"max_tokens":12,"max_completion_tokens":12,"store":false,"n":1}"#).unwrap();
        assert!(!request.stream);
        assert_eq!(request.max_output_tokens, Some(12));
        assert_eq!(request.tools[0].name, "f");
        assert_eq!(request.messages[0].tool_calls[0].name, "f");
    }
    #[test]
    fn nested_unknowns_and_remote_images_are_refused() {
        for (body, param) in [
            (br#"{"model":"m","messages":[{"role":"user","name":"x","content":"hi"}]}"#.as_slice(), "/messages/0/name"),
            (br#"{"model":"m","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://example.com/x"}}]}]}"#.as_slice(), "/messages/0/content/0/image_url/url"),
        ] {
            assert_eq!(decode_chat_completions(body).unwrap_err().param, param);
        }
    }
    #[test]
    fn documented_refusals_preserve_pointer_and_reason() {
        for (field, value, reason) in [
            ("service_tier", serde_json::json!("priority"), "stateless"),
            ("store", serde_json::json!(true), "stateless"),
            (
                "modalities",
                serde_json::json!(["audio"]),
                "modality_unsupported",
            ),
            ("audio", serde_json::json!({}), "modality_unsupported"),
            ("prediction", serde_json::json!({}), "modality_unsupported"),
            (
                "web_search_options",
                serde_json::json!({}),
                "hosted_tool_unsupported",
            ),
            ("functions", serde_json::json!([]), "unsupported"),
            ("function_call", serde_json::json!("auto"), "unsupported"),
            ("n", serde_json::json!(2), "unsupported"),
            ("logit_bias", serde_json::json!({}), "unsupported"),
            ("user", serde_json::json!("client"), "privacy_baseline"),
            (
                "safety_identifier",
                serde_json::json!("client"),
                "privacy_baseline",
            ),
            (
                "prompt_cache_key",
                serde_json::json!("key"),
                "privacy_baseline",
            ),
            ("vendor_field", serde_json::json!(true), "unknown"),
        ] {
            let mut body = serde_json::json!({"model":"m", "messages":[]});
            body[field] = value;
            let error = decode_chat_completions(body.to_string().as_bytes()).unwrap_err();
            assert_eq!(error.param, format!("/{field}"));
            assert_eq!(error.reason, reason);
        }
    }
    #[test]
    fn unrepresentable_native_roles_and_parts_are_addressed() {
        for (message, path, reason) in [
            (
                serde_json::json!({"role":"developer","content":"x"}),
                "/messages/0/role",
                "unsupported",
            ),
            (
                serde_json::json!({"role":"user","name":"x","content":"x"}),
                "/messages/0/name",
                "unsupported",
            ),
            (
                serde_json::json!({"role":"user","content":[{"type":"file","file":{}}]}),
                "/messages/0/content/0/type",
                "unsupported",
            ),
            (
                serde_json::json!({"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,AA==","detail":"high"}}]}),
                "/messages/0/content/0/image_url/detail",
                "unknown",
            ),
            (
                serde_json::json!({"role":"user","content":[{"type":"image_url","image_url":{"url":"https://example.org/image"}}]}),
                "/messages/0/content/0/image_url/url",
                "url_fetch_unsupported",
            ),
        ] {
            let request = serde_json::json!({"model":"m","messages":[message]});
            let error = decode_chat_completions(request.to_string().as_bytes()).unwrap_err();
            assert_eq!((error.param.as_str(), error.reason), (path, reason));
        }
    }
    #[test]
    fn malformed_mapped_scalars_report_the_original_member() {
        for (field, value) in [
            ("model", serde_json::json!(17)),
            ("max_tokens", serde_json::json!("many")),
            ("max_completion_tokens", serde_json::json!(-1)),
            ("temperature", serde_json::json!("hot")),
            ("stream", serde_json::json!("yes")),
            ("top_p", serde_json::json!(null)),
        ] {
            let mut request = serde_json::json!({"model":"m","messages":[]});
            request[field] = value;
            let error = decode_chat_completions(request.to_string().as_bytes()).unwrap_err();
            assert_eq!(
                (error.param.as_str(), error.reason),
                (format!("/{field}").as_str(), "invalid_field")
            );
        }
    }
    #[test]
    fn nested_fields_name_the_submitted_compat_pointer() {
        let cases = [
            (
                serde_json::json!({"model":"m","messages":[],"tools":[{"type":"function","function":{"name":"f","parameters":{},"mystery":1}}]}),
                "/tools/0/function/mystery",
                "unknown",
            ),
            (
                serde_json::json!({"model":"m","messages":[],"tools":[{"type":"function","function":{"name":1,"parameters":{}}}]}),
                "/tools/0/function/name",
                "invalid_field",
            ),
            (
                serde_json::json!({"model":"m","messages":[{"role":"user","content":[{"type":"text","text":17}]}]}),
                "/messages/0/content/0/text",
                "invalid_field",
            ),
        ];
        for (request, param, reason) in cases {
            let error = decode_chat_completions(request.to_string().as_bytes()).unwrap_err();
            assert_eq!((error.param.as_str(), error.reason), (param, reason));
        }
    }
}
