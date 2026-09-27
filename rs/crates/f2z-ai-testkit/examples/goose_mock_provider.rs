//! A `goose` load-scenario skeleton against the mock provider.
//!
//! ```text
//! cargo run --release -p f2z-ai-testkit --example goose_mock_provider -- \
//!     --users 200 --hatch-rate 50 --run-time 30s
//! ```
//!
//! It starts a [`MockProvider`] in-process (paced at 50 tokens/s, 64 output
//! tokens, a 150 ms TTFB — roughly a small real model), then drives streaming
//! Chat Completions requests at it and fails any transaction whose stream does
//! not end in `data: [DONE]` with a usage chunk. Every goose option is
//! available on the command line; `--host` is ignored in favour of the mock's
//! own ephemeral address unless given.
//!
//! Read goose's two tables accordingly: **per-request** times stop at the
//! response headers, i.e. they measure time to first byte; **per-transaction**
//! times include reading the whole stream, i.e. they measure the stream.
//!
//! This is the skeleton the 10k-concurrent-stream test of epic #1047 grows
//! from: once the gateway (`f2z-ai`) exists, point `--host` at a gateway
//! whose provider base URL is the mock, and the same transaction measures the
//! gateway rather than the mock. The mock alone is the baseline that tells the
//! two apart.

use core::time::Duration;

use f2z_ai_testkit::mock::{MockProvider, Scenario as MockScenario};
use goose::prelude::*;

/// One streaming Chat Completions call, read to the end and validated.
async fn stream_chat(user: &mut GooseUser) -> TransactionResult {
    let body = serde_json::json!({
        "model": "load-test",
        "stream": true,
        "stream_options": {"include_usage": true},
        "messages": [{"role": "user", "content": "hello"}],
    });
    let builder = user
        .get_request_builder(&GooseMethod::Post, "/v1/chat/completions")?
        .header("content-type", "application/json")
        .body(body.to_string());
    let request = GooseRequest::builder()
        .method(GooseMethod::Post)
        .path("/v1/chat/completions")
        .set_request_builder(builder)
        .build();
    let mut goose = user.request(request).await?;
    let complete = match goose.response {
        Ok(response) => match response.text().await {
            Ok(text) => text.ends_with("data: [DONE]\n\n") && text.contains("\"prompt_tokens\""),
            Err(_) => false,
        },
        Err(_) => false,
    };
    if !complete {
        return user.set_failure(
            "stream did not complete with usage",
            &mut goose.request,
            None,
            None,
        );
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mock = MockProvider::start(
        MockScenario::default()
            .with_output_tokens(64)
            .with_tokens_per_sec(50)
            .with_ttfb(Duration::from_millis(150)),
    )
    .await?;
    let host = mock.base_url();

    GooseAttack::initialize()?
        .register_scenario(
            scenario!("StreamingChat").register_transaction(transaction!(stream_chat)),
        )
        .set_default(GooseDefault::Host, host.as_str())?
        .set_default(GooseDefault::Users, 20)?
        .set_default(GooseDefault::HatchRate, "20")?
        .set_default(GooseDefault::RunTime, 10)?
        .execute()
        .await?;

    mock.shutdown().await;
    Ok(())
}
