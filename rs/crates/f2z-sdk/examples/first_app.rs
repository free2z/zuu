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
//! Against production, change the configuration — `Config::new("<your
//! client_id>")`, a real `UrlOpener` for the system browser, and a
//! keychain-backed `TokenStore` — and delete the FAKE ONLY refusal demo in
//! step 5.

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

    // 2. The budget the user actually chose. A capped grant whose cap is not
    //    enforced yet is an unproven budget: do no paid work against it.
    let grant = client.grant().await?;
    if grant.spend_cap_2z.is_some() && !grant.enforced {
        println!(
            "budget not enforced yet ({:?}); paid AI disabled",
            grant.enforcement_reason
        );
        return Ok(());
    }

    //    Balance: integers in milli-2Z; format only for display.
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
    // FAKE ONLY — delete against production: these model ids exist only in
    // the local fake, and the real gateway answers `model_not_found`.
    for refusing in ["needs-top-up", "needs-budget", "too-large"] {
        let mut probe = request.clone();
        probe.model = refusing.into();
        println!(
            "  {refusing}: {}",
            recovery_copy(&client.ai().preflight(&probe).await?)
        );
    }

    // 6. Stream it. Persist the key (and when you sent it) BEFORE sending if
    //    you want to recover the receipt after a crash — for 24 hours; after
    //    that a re-send is a NEW billable call; `with_max_retries(0)` keeps one key = one
    //    billable attempt (same-key network recovery stays on).
    //    A FRESH key per new operation; reuse one only to recover that call.
    let key = new_idempotency_key();
    let options = ChatOptions::default()
        .with_idempotency_key(key.clone())
        .with_max_retries(0);
    let mut stream = match client.ai().chat_with(request, options).await {
        Ok(stream) => stream,
        // Same-key recovery found the call already ran: this IS its receipt,
        // and it may have charged. Show it; never offer a new attempt.
        Err(Error::Replayed(record)) => {
            println!("already done: {:?}", record.charge());
            return Ok(());
        }
        Err(e) => {
            println!("{}", error_copy(&e));
            return Ok(());
        }
    };
    // Read to the end WITHOUT `?`: a broken stream is exactly when the call
    // may still settle and charge, so the receipt step below must still run.
    let mut text = String::new();
    let mut finished = None; // Some(finish_reason) only on a `done` event
    loop {
        match stream.next().await {
            Ok(Some(Event::Delta(d))) => text.push_str(&d.text),
            Ok(Some(Event::Done(done))) => {
                finished = Some(done.finish_reason);
                match Charge::from(done.outcome()) {
                    Charge::Charged { charged_2z, .. } => println!("charged {charged_2z}"),
                    Charge::NothingCharged => println!("nothing charged"),
                    _ => println!("settling…"),
                }
            }
            // A failed call may still have cost something: read its outcome.
            Ok(Some(Event::Error(e))) => {
                println!("failed: {} ({:?})", e.code, Charge::from(e.outcome()));
            }
            Ok(Some(_)) => {} // skip events this app does not know
            Ok(None) => break,
            Err(e) => {
                println!("{}", error_copy(&e)); // keep the partial text
                break;
            }
        }
    }

    // 7. Parse only a completed answer — and still validate it: model output
    //    is untrusted text. `length` is truncated JSON.
    match finished {
        Some(FinishReason::Stop) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(activity) => println!("activity: {}", activity["title"]),
            Err(e) => println!("not the JSON we asked for ({e}); show an error, not a crash"),
        },
        Some(other) => println!("finished with {other:?}; do not parse"),
        None => println!("no answer; partial text kept: {} bytes", text.len()),
    }

    // 8. The receipt — always, whatever happened above: a cancelled, broken
    //    or failed call can still settle and charge. A `None` call id here
    //    means re-send the same request with the same key to recover it.
    match stream.call_id() {
        Some(call_id) => {
            let record = client
                .ai()
                .wait_for_call(call_id, Duration::from_secs(30))
                .await?;
            println!("receipt: {:?}", record.charge());
        }
        None => println!("no call id: recover the receipt by re-sending with key {key}"),
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

/// 128 random bits, hex: one per new operation. Persist it with the request
/// before sending; re-send it only to recover that same call.
fn new_idempotency_key() -> String {
    use ring::rand::SecureRandom;
    let mut bytes = [0_u8; 16];
    ring::rand::SystemRandom::new()
        .fill(&mut bytes)
        .expect("system randomness");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
