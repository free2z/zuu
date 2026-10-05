//! The quickstart's "first app" (`docs/free2z/sdk/QUICKSTART.md`), compiled by
//! CI so the guide cannot drift from the API: sign in, check the budget and
//! the balance, pick a model that can return JSON, **preflight** a strict
//! request, stream it, parse the JSON, read the receipt, sign out — against
//! local fakes of the issuer, the account API and the gateway.
//!
//! ```text
//! cargo run -p f2z-sdk --example first_app
//! ```
//!
//! Against production, change only the configuration: `Config::new("<your
//! client_id>")`, a real `UrlOpener` for the system browser, and a
//! keychain-backed `TokenStore`.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

#[path = "../tests/support/mod.rs"]
mod support;

use std::sync::Arc;
use std::time::Duration;

use f2z_sdk::ai::{Charge, ChatOptions, Preflight};
use f2z_sdk::oauth::LoopbackSession;
use f2z_sdk::proto::chat::{FinishReason, JsonSchemaFormat, Message, ResponseFormat};
use f2z_sdk::proto::{ChatRequest, ErrorCode, Event};
use f2z_sdk::{Client, Error, MemoryStore, SignInOptions, SpendCapHint};

#[tokio::main]
async fn main() -> Result<(), Error> {
    let fake = support::Fake::start().await;
    // One long-lived client per app; its clones share the session.
    let client = Client::new(fake.config(), Arc::new(MemoryStore::new()))?;

    // 1. Sign in, suggesting a 500 2Z lifetime budget for this app. The user
    //    decides; `grant()` says what they chose.
    let session = LoopbackSession::bind(support::loopback_browser()).await?;
    let options = SignInOptions::default().with_spend_cap(SpendCapHint::total(500));
    let signed_in = client.sign_in(&session, options).await?;
    if !signed_in.scopes.iter().any(|s| s == "ai:invoke") {
        println!("the user declined AI; hide the AI features");
        return Ok(());
    }

    // 2. Balance: integers in milli-2Z; format only for display.
    let balance = client.balance().await?;
    println!(
        "balance: {} 2Z available",
        balance.available_milli_2z.display_2z()
    );

    // 3. A model that can return JSON. Never hard-code a model id.
    let models = client.ai().models().await?;
    let model = models
        .models
        .iter()
        .find(|m| m.capabilities.structured_output)
        .expect("a model with structured_output");

    // 4. A strict request: the full 1800 tokens or a refusal up front, never
    //    a shorter, charged, truncated JSON document.
    let request = ChatRequest::new(
        model.id.clone(),
        vec![
            Message::system("You write short classroom activities."),
            Message::user("A two-step activity about one half."),
        ],
    )
    .with_max_output_tokens(1800)
    .strict()
    .with_response_format(ResponseFormat::JsonSchema {
        json_schema: JsonSchemaFormat {
            name: "activity".into(),
            schema: serde_json::json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "title": {"type": "string"},
                    "steps": {"type": "array", "items": {"type": "string"}}
                },
                "required": ["title", "steps"]
            }),
            strict: Some(true),
        },
    });

    // 5. Preflight before enabling "Generate": no hold, no charge.
    match client.ai().preflight(&request).await? {
        Preflight::Ready(estimate) => println!("ready: holds {} now", estimate.hold_2z),
        other => {
            println!("{}", recovery_copy(&other));
            return Ok(());
        }
    }
    // What the other outcomes look like (fake models that refuse):
    for refusing in ["needs-top-up", "needs-budget", "too-large"] {
        let mut probe = request.clone();
        probe.model = refusing.into();
        println!(
            "  {refusing}: {}",
            recovery_copy(&client.ai().preflight(&probe).await?)
        );
    }

    // 6. Stream it. Persist the key BEFORE sending if you want to recover the
    //    receipt after a crash; `with_max_retries(0)` keeps one key = one
    //    billable attempt (same-key network recovery stays on).
    let key = "persist-me-before-sending-3f9c";
    let options = ChatOptions::default()
        .with_idempotency_key(key)
        .with_max_retries(0);
    let mut stream = match client.ai().chat_with(request, options).await {
        Ok(stream) => stream,
        Err(e) => {
            println!("{}", error_copy(&e));
            return Ok(());
        }
    };
    let mut text = String::new();
    let mut truncated = false;
    while let Some(event) = stream.next().await? {
        match event {
            Event::Delta(d) => text.push_str(&d.text),
            Event::Done(done) => {
                truncated = done.finish_reason == FinishReason::Length;
                match Charge::from(done.outcome()) {
                    Charge::Charged { charged_2z, .. } => println!("charged {charged_2z}"),
                    Charge::NothingCharged => println!("nothing charged"),
                    _ => println!("settling…"),
                }
            }
            // A failed call may still have cost something: read its outcome.
            Event::Error(e) => println!("failed: {} ({:?})", e.code, Charge::from(e.outcome())),
            _ => {} // skip events this app does not know
        }
    }

    // 7. Parse — and still validate: model output is untrusted text.
    if truncated {
        println!("truncated JSON; do not parse");
    } else {
        let activity: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| Error::Protocol(e.to_string()))?;
        println!("activity: {}", activity["title"]);
    }

    // 8. The receipt (and the way to settle a cancelled or broken stream).
    if let Some(call_id) = stream.call_id() {
        let record = client
            .ai()
            .wait_for_call(call_id, Duration::from_secs(30))
            .await?;
        println!("receipt: {:?}", record.charge());
    }

    // 9. Sign out: clears the store; `true` if the IdP confirmed revocation.
    println!("signed out (revoked: {})", client.sign_out().await?);
    Ok(())
}

/// Developer-facing copy for each preflight outcome; write your own UI text.
fn recovery_copy(preflight: &Preflight) -> String {
    match preflight {
        Preflight::Ready(_) => "ready".into(),
        Preflight::NeedsTopUp {
            required_2z,
            available_milli_2z,
            ..
        } => format!(
            "needs {} 2Z, has {} 2Z: offer a purchase",
            required_2z.map_or("?".into(), |v| v.get().to_string()),
            available_milli_2z.map_or("?".into(), |v| v.display_2z().to_string()),
        ),
        Preflight::NeedsBudget { resets_at, .. } => format!(
            "this app's budget is used up: link to https://free2z.cash/account/apps{}",
            resets_at
                .as_deref()
                .map_or(String::new(), |r| format!(" (resets {r})"))
        ),
        Preflight::TooLarge(_) => "too long: shorten the input or lower max_output_tokens".into(),
        _ => "unknown outcome".into(),
    }
}

/// The recovery each error class needs. Switch on variants and codes, never
/// on messages.
fn error_copy(error: &Error) -> String {
    match error {
        Error::SignedOut(_) => "signed out: show sign-in".into(),
        Error::StepUpRequired(_) => "sign in again with SignInOptions::step_up, retry once".into(),
        Error::Api(e) => match e.error_code() {
            ErrorCode::InsufficientBalance => "offer a purchase".into(),
            ErrorCode::CapExceeded => "link to https://free2z.cash/account/apps".into(),
            ErrorCode::RateLimited | ErrorCode::ConcurrencyLimit | ErrorCode::Unavailable => {
                format!("busy; retry after {:?}", e.retry_after)
            }
            _ => format!("{} ({})", e.code, e.status),
        },
        Error::Unconfirmed {
            idempotency_key, ..
        } => format!("unknown outcome: re-send with key {idempotency_key}"),
        other => other.to_string(),
    }
}
