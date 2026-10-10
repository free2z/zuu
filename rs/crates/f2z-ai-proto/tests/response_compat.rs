//! Additive response metadata is tolerant; caller requests remain strict.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_ai_proto::ModelPrices;
use f2z_ai_proto::catalog_v2::ContextPriceTier;
use f2z_ai_proto::chat::{ChatRequest, ChatResponse};
use serde_json::json;

#[test]
fn chat_responses_ignore_unknown_gateway_members() {
    let mut response = json!({
        "call_id": "call_test",
        "model": "model-test",
        "message": { "content": [{ "type": "text", "text": "answer" }] },
        "finish_reason": "stop",
        "usage": { "input_tokens": 1, "output_tokens": 1 },
        "settlement": "settled",
        "charged_2z": 1,
        "receipt_id": "receipt-test",
        "collected_milli_2z": 1000
    });
    response["gateway_extension"] = json!({"version": 2});
    response["message"]["future_message_member"] = json!(true);
    response["message"]["content"][0]["future_part_member"] = json!("ignored");
    response["usage"]["future_usage_member"] = json!(7);

    let decoded: ChatResponse = serde_json::from_value(response).unwrap();
    assert_eq!(decoded.message.text(), "answer");
    assert_eq!(decoded.usage.input_tokens, 1);
}

#[test]
fn response_catalogue_price_types_ignore_additive_metadata() {
    let prices: ModelPrices = serde_json::from_value(json!({
        "input_nusd_per_mtok": 10,
        "cached_input_nusd_per_mtok": 20,
        "cache_write_nusd_per_mtok": 30,
        "output_nusd_per_mtok": 40,
        "image_nusd": 50,
        "tool_call_nusd": 60,
        "new_price_metadata": {"unit": "future"}
    }))
    .unwrap();
    let tier: ContextPriceTier = serde_json::from_value(json!({
        "input_tokens_gt": 100,
        "prices": serde_json::to_value(prices).unwrap(),
        "new_tier_metadata": true
    }))
    .unwrap();
    assert_eq!(tier.input_tokens_gt, 100);
    assert_eq!(tier.prices.output_nusd_per_mtok, 40);
}

#[test]
fn request_messages_and_content_parts_still_reject_unknown_members() {
    for request in [
        json!({
            "model": "model-test",
            "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}], "future": true}]
        }),
        json!({
            "model": "model-test",
            "messages": [{"role": "user", "content": [{"type": "text", "text": "hi", "future": true}]}]
        }),
        json!({
            "model": "model-test",
            "messages": [{"role": "assistant", "tool_calls": [{"id": "c1", "name": "lookup", "arguments": "{}", "future": true}]}]
        }),
        json!({ "model": "model-test", "messages": [], "future_request_member": true }),
    ] {
        assert!(
            serde_json::from_value::<ChatRequest>(request).is_err(),
            "request decoder accepted an unknown nested member"
        );
    }
}
