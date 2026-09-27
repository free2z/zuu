//! `/api/sdk/v1/balance` and `/api/sdk/v1/purchases` against the fake
//! account API.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod support;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use f2z_sdk::proto::{Milli2z, Whole2z};
use f2z_sdk::purchase::{Platform, PollOptions, PurchaseRequest, PurchaseStatus, ReturnListener};
use f2z_sdk::{Client, Error, MemoryStore, SignInOptions};
use support::{Fake, ScriptedBrowser};

async fn signed_in(config: f2z_sdk::Config) -> Client {
    let client = Client::new(config, Arc::new(MemoryStore::new())).unwrap();
    client
        .sign_in(
            &ScriptedBrowser::new("com.example.tutor:/oauth/callback"),
            SignInOptions::default(),
        )
        .await
        .unwrap();
    client
}

#[tokio::test]
async fn balance_decodes_and_a_401_is_refreshed_once() {
    let fake = Fake::start().await;
    let client = signed_in(fake.config()).await;
    let b = client.balance().await.unwrap();
    assert_eq!(b.available_milli_2z, Milli2z::new(41_500));
    assert!(!b.in_debt());

    fake.expire_access_tokens();
    client.balance().await.unwrap();
    assert_eq!(fake.refresh_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_missing_scope_is_the_envelope() {
    let fake = Fake::start().await;
    let config = fake
        .config()
        .with_scopes(["openid", "offline_access", "purchase:create"]);
    let client = signed_in(config).await;
    let err = client.balance().await.unwrap_err();
    let api = err.api().unwrap();
    assert_eq!(api.status, 403);
    assert_eq!(api.code, "insufficient_scope");
    assert_eq!(api.detail_str("scope"), Some("balance:read"));
}

#[tokio::test]
async fn a_card_purchase_is_created_opened_and_polled_to_credited() {
    let fake = Fake::start().await;
    let client = signed_in(fake.config()).await;
    let ret = ReturnListener::bind("/purchase-done").await.unwrap();
    assert!(ret.return_url().starts_with("http://127.0.0.1:"));

    let intent = client
        .create_purchase(&PurchaseRequest::card(
            Whole2z::new(500),
            Platform::Desktop,
            ret.return_url(),
        ))
        .await
        .unwrap();
    assert_eq!(intent.status, PurchaseStatus::Pending);
    assert!(
        intent
            .checkout_url()
            .unwrap()
            .starts_with("https://checkout.example/")
    );

    // The "browser" finishes checkout and lands on the return URL.
    let back = format!(
        "{}?purchase_id={}&status=success",
        ret.return_url(),
        intent.id
    );
    let browser = tokio::spawn(async move { reqwest::get(back).await.unwrap().status() });
    let returned = ret.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(returned.purchase_id.as_deref(), Some(intent.id.as_str()));
    assert_eq!(returned.status.as_deref(), Some("success"));
    assert_eq!(browser.await.unwrap(), 200);

    // The redirect is a convenience; the poll is the signal.
    let done = client
        .wait_for_purchase(&intent.id, PollOptions::max_wait(Duration::from_secs(20)))
        .await
        .unwrap();
    assert_eq!(done.status, PurchaseStatus::Credited);
    assert_eq!(done.credited_milli_2z, Some(Milli2z::new(500_000)));
    assert_eq!(
        client.balance().await.unwrap().available_milli_2z,
        Milli2z::new(541_500)
    );
}

/// A create whose response never arrives is re-sent with the SAME key, and
/// the server's replay means exactly one intent — one checkout — exists.
#[tokio::test]
async fn a_lost_create_response_is_recovered_with_the_same_key() {
    let fake = Fake::start().await;
    *fake.create_delay_first.lock().unwrap() = Duration::from_millis(1500);
    let config = fake
        .config()
        .with_request_timeout(Duration::from_millis(500));
    let client = signed_in(config).await;
    let intent = client
        .create_purchase(
            &PurchaseRequest::card(Whole2z::new(100), Platform::Ios, "http://127.0.0.1:1/r")
                .with_idempotency_key("key-lost-response"),
        )
        .await
        .unwrap();
    assert!(fake.create_calls.load(Ordering::SeqCst) >= 2);
    assert_eq!(fake.intents(), 1);
    assert_eq!(intent.quantity_2z, Whole2z::new(100));
}

#[tokio::test]
async fn purchase_refusals_carry_their_details_and_are_not_retried() {
    let fake = Fake::start().await;
    let client = signed_in(fake.config()).await;
    let err = client
        .create_purchase(&PurchaseRequest::card(
            Whole2z::new(5),
            Platform::Android,
            "http://127.0.0.1:1/r",
        ))
        .await
        .unwrap_err();
    let api = err.api().unwrap();
    assert_eq!((api.status, api.code.as_str()), (400, "invalid_quantity"));
    assert_eq!(api.detail_u64("min_2z"), Some(100));
    assert!(!api.retryable());
    assert_eq!(fake.create_calls.load(Ordering::SeqCst), 1);

    // The same key with a different body is a conflict, not a second intent.
    let key = "key-conflict";
    client
        .create_purchase(
            &PurchaseRequest::card(Whole2z::new(100), Platform::Web, "http://127.0.0.1:1/r")
                .with_idempotency_key(key),
        )
        .await
        .unwrap();
    let err = client
        .create_purchase(
            &PurchaseRequest::card(Whole2z::new(200), Platform::Web, "http://127.0.0.1:1/r")
                .with_idempotency_key(key),
        )
        .await
        .unwrap_err();
    assert_eq!(err.api().unwrap().code, "idempotency_conflict");
    assert!(matches!(
        client.purchase("0f6e3b2a-0000-0000-0000-000000000000").await,
        Err(Error::Api(e)) if e.code == "purchase_not_found"
    ));
}

#[tokio::test]
async fn broken_purchase_body_retries_the_same_intent() {
    let fake = Fake::start().await;
    let client = signed_in(fake.config()).await;
    fake.broken_purchase_bodies.store(1, Ordering::SeqCst);
    let intent = client
        .create_purchase(&PurchaseRequest::card(
            Whole2z::new(100),
            Platform::Web,
            "http://127.0.0.1:1/r",
        ))
        .await
        .unwrap();
    assert!(intent.id.ends_with("000000000000"));
    assert_eq!(fake.create_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn exhausted_purchase_body_retries_return_the_generated_recovery_key() {
    let fake = Fake::start().await;
    let client = signed_in(fake.config()).await;
    fake.broken_purchase_bodies.store(2, Ordering::SeqCst);
    let request = PurchaseRequest::card(Whole2z::new(100), Platform::Web, "http://127.0.0.1:1/r");
    let err = client.create_purchase(&request).await.unwrap_err();
    let Error::Unconfirmed {
        idempotency_key, ..
    } = err
    else {
        panic!("lost purchase recovery key: {err:?}")
    };
    fake.broken_purchase_bodies.store(0, Ordering::SeqCst);
    let recovered = client
        .create_purchase(&request.with_idempotency_key(idempotency_key))
        .await
        .unwrap();
    assert!(recovered.id.ends_with("000000000000"));
}
