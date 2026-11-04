//! `/api/sdk/v1/balance` and `/api/sdk/v1/purchases` against the fake
//! account API.
//!
//! The purchase API is deprecated for apps since 0.4.0 but must keep working
//! for apps built on 0.3.0 that ask for `purchase:create` explicitly: these
//! tests pin that.

#![allow(
    deprecated,
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

/// The 0.3.0 default scopes: a pre-0.4.0 app that still buys 2Z by card.
fn purchasing(fake: &Fake) -> f2z_sdk::Config {
    fake.config().with_scopes([
        "openid",
        "profile",
        "offline_access",
        "balance:read",
        "purchase:create",
        "ai:invoke",
    ])
}

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
async fn the_default_scopes_cannot_create_a_purchase_any_more() {
    let fake = Fake::start().await;
    let client = signed_in(fake.config()).await;
    assert!(
        !client
            .granted_scopes()
            .await
            .contains(&"purchase:create".to_owned())
    );
    let err = client
        .create_purchase(&PurchaseRequest::card(
            Whole2z::new(500),
            Platform::Desktop,
            "http://127.0.0.1:1/r",
        ))
        .await
        .unwrap_err();
    let api = err.api().unwrap();
    assert_eq!((api.status, api.code.as_str()), (403, "insufficient_scope"));
    assert_eq!(fake.intents(), 0);
    // What such an app links instead: billing, on the website's origin.
    assert_eq!(
        client.billing_url(),
        format!(
            "{}/buy-2z?client_id={}",
            client.web_origin(),
            support::CLIENT_ID
        )
    );
}

#[tokio::test]
async fn a_card_purchase_is_created_opened_and_polled_to_credited() {
    let fake = Fake::start().await;
    let client = signed_in(purchasing(&fake)).await;
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
    let config = purchasing(&fake).with_request_timeout(Duration::from_millis(500));
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
    let client = signed_in(purchasing(&fake)).await;
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
    let client = signed_in(purchasing(&fake)).await;
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
    let client = signed_in(purchasing(&fake)).await;
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

#[tokio::test]
async fn grant_proof_is_fresh_typed_and_bound_to_the_account_and_client() {
    let fake = Fake::start().await;
    let client = signed_in(fake.config()).await;
    let grant = client.grant().await.unwrap();
    assert_eq!(grant.spend_cap_2z, Some(Whole2z::new(500)));
    assert_eq!(grant.cap_period, f2z_sdk::proto::grant::CapPeriod::Total);
    assert!(grant.enforced);
    let original = fake.grant_body.lock().unwrap().clone();
    for (field, value) in [
        ("grant_generation", serde_json::json!(0)),
        ("scopes", serde_json::json!([])),
        ("as_of", serde_json::json!("2026-02-30T00:00:00Z")),
    ] {
        fake.grant_body.lock().unwrap()[field] = value;
        assert!(matches!(client.grant().await, Err(Error::Protocol(_))));
        *fake.grant_body.lock().unwrap() = original.clone();
    }
    fake.expire_access_tokens();
    fake.grant_body.lock().unwrap()["enforced"] = serde_json::json!(false);
    assert!(!client.grant().await.unwrap().enforced);
    assert_eq!(fake.refresh_calls.load(Ordering::SeqCst), 1);
    fake.grant_body.lock().unwrap()["client_id"] = serde_json::json!("another-app");
    assert!(matches!(client.grant().await, Err(Error::Protocol(_))));
    fake.grant_body.lock().unwrap()["client_id"] = serde_json::json!(support::CLIENT_ID);
    fake.grant_body.lock().unwrap()["sub"] = serde_json::json!("another-user");
    assert!(matches!(client.grant().await, Err(Error::Protocol(_))));
}

#[tokio::test]
async fn grant_reply_cannot_survive_sign_out() {
    let fake = Fake::start().await;
    let client = signed_in(fake.config()).await;
    *fake.grant_delay.lock().unwrap() = Duration::from_millis(100);
    let task = {
        let c = client.clone();
        tokio::spawn(async move { c.grant().await })
    };
    while fake.grant_calls.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    client.sign_out().await.unwrap();
    assert!(matches!(task.await.unwrap(), Err(Error::SignedOut(_))));
}

#[tokio::test]
async fn report_call_posts_the_reason_and_detail_and_reads_both_receipts() {
    use f2z_sdk::ai::ReportReason;
    let fake = Fake::start().await;
    let client = signed_in(fake.config()).await;
    let call = "019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c";
    let first = client
        .ai()
        .report_call(call, ReportReason::Incorrect, Some("wrong_grade"))
        .await
        .unwrap();
    assert_eq!(first.call_id, call);
    assert_eq!(first.reason, ReportReason::Incorrect);
    // A repeat is a 200 for the same report, with the latest reason.
    let again = client
        .ai()
        .report_call(call, ReportReason::Unsafe, None)
        .await
        .unwrap();
    assert_eq!(again.report_id, first.report_id);
    assert_eq!(again.reason, ReportReason::Unsafe);
    assert_eq!(
        *fake.report_bodies.lock().unwrap(),
        vec![
            serde_json::json!({"reason": "incorrect", "detail": "wrong_grade"}),
            serde_json::json!({"reason": "unsafe"}),
        ]
    );
    // Not this user's call: the server's 404 envelope, typed.
    match client
        .ai()
        .report_call(
            "019a2f1c-0000-7000-8000-000000000404",
            ReportReason::Other,
            None,
        )
        .await
    {
        Err(Error::Api(e)) => assert_eq!((e.status, e.code.as_str()), (404, "not_found")),
        other => panic!("expected a 404 not_found, got {other:?}"),
    }
    // Refused locally: nothing reaches the server.
    let sent = fake.report_bodies.lock().unwrap().len();
    for detail in [
        "",
        "two\nlines",
        "bidi\u{202E}",
        "para\u{2029}",
        &"x".repeat(201),
    ] {
        assert!(matches!(
            client
                .ai()
                .report_call(call, ReportReason::Other, Some(detail))
                .await,
            Err(Error::Config(_))
        ));
    }
    assert!(matches!(
        client
            .ai()
            .report_call(call, ReportReason::Unknown, None)
            .await,
        Err(Error::Config(_))
    ));
    assert!(matches!(
        client
            .ai()
            .report_call("../grant", ReportReason::Other, None)
            .await,
        Err(Error::Config(_))
    ));
    assert_eq!(fake.report_bodies.lock().unwrap().len(), sent);
    // An uppercase UUID is sent in the server's lowercase form.
    let upper = client
        .ai()
        .report_call(&call.to_ascii_uppercase(), ReportReason::Other, None)
        .await
        .unwrap();
    assert_eq!(upper.call_id, call);
    assert_eq!(upper.report_id, first.report_id);
}

#[tokio::test]
async fn a_child_directed_client_never_sends_a_report_detail() {
    use f2z_sdk::ai::ReportReason;
    let fake = Fake::start().await;
    let client = signed_in(fake.config().with_child_directed(true)).await;
    assert!(client.child_directed());
    let call = "019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c";
    assert!(matches!(
        client
            .ai()
            .report_call(call, ReportReason::Incorrect, Some("wrong_grade"))
            .await,
        Err(Error::Config(_))
    ));
    assert!(fake.report_bodies.lock().unwrap().is_empty());
    client
        .ai()
        .report_call(call, ReportReason::Unsafe, None)
        .await
        .unwrap();
    assert_eq!(
        *fake.report_bodies.lock().unwrap(),
        vec![serde_json::json!({"reason": "unsafe"})]
    );
}
