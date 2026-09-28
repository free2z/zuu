//! Sign-in, refresh, revocation and the negative controls of
//! `docs/free2z/sdk/spec/oidc.md` §11, against the fake issuer over real HTTP.
//!
//! Every refusal test is paired with a success test on the same fake, so a
//! refusal cannot pass because the flow was broken anyway.

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

use f2z_sdk::oauth::{LoopbackSession, Prompt};
use f2z_sdk::{
    Client, Error, MemoryStore, Persistence, SignInOptions, SignedOutReason, TokenStore,
};
use support::{
    CLIENT_ID, Fake, SUBJECT, ScriptedBrowser, follow_authorize, get_param, loopback_browser,
    set_param,
};

const MOBILE_REDIRECT: &str = "com.example.tutor:/oauth/callback";

fn account(fake: &Fake) -> String {
    format!("{} {CLIENT_ID}", fake.issuer)
}

fn stored_refresh_token(store: &MemoryStore, fake: &Fake) -> Option<String> {
    let blob = store.load(&account(fake)).unwrap()?;
    let v: serde_json::Value = serde_json::from_str(blob.expose()).unwrap();
    Some(v["refresh_token"].as_str().unwrap().to_owned())
}

async fn signed_in(fake: &Fake) -> (Client, Arc<MemoryStore>) {
    let store = Arc::new(MemoryStore::new());
    let client = Client::new(fake.config(), store.clone()).unwrap();
    client
        .sign_in(
            &ScriptedBrowser::new(MOBILE_REDIRECT),
            SignInOptions::default(),
        )
        .await
        .unwrap();
    (client, store)
}

#[tokio::test]
async fn desktop_loopback_sign_in_end_to_end() {
    let fake = Fake::start().await;
    let store = Arc::new(MemoryStore::new());
    let client = Client::new(fake.config(), store.clone()).unwrap();
    let session = LoopbackSession::bind(loopback_browser()).await.unwrap();

    let signed = client
        .sign_in(&session, SignInOptions::default())
        .await
        .unwrap();

    assert_eq!(signed.subject.as_deref(), Some(SUBJECT));
    let claims = signed.id_token.unwrap();
    assert_eq!(claims.preferred_username.as_deref(), Some("tutor_user"));
    assert_eq!(claims.acr.as_deref(), Some("urn:f2z:acr:1fa"));
    assert!(signed.refreshable);
    assert!(signed.scopes.contains(&"ai:invoke".to_owned()));
    assert_eq!(signed.persistence, Persistence::MemoryOnly);
    assert_eq!(client.token_persistence(), Persistence::MemoryOnly);
    assert!(stored_refresh_token(&store, &fake).is_some());
    assert!(client.is_signed_in().await.unwrap());
    assert_eq!(client.subject().await.as_deref(), Some(SUBJECT));
    // The access token is usable at once, without a refresh.
    client.balance().await.unwrap();
    assert_eq!(fake.refresh_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn the_authorization_request_is_s256_with_fresh_state_and_nonce() {
    let fake = Fake::start().await;
    let client = Client::new(fake.config(), Arc::new(MemoryStore::new())).unwrap();
    let browser = ScriptedBrowser::new(MOBILE_REDIRECT);
    client
        .sign_in(&browser, SignInOptions::default())
        .await
        .unwrap();
    client
        .sign_in(
            &browser,
            SignInOptions::default().with_prompt(Prompt::Login),
        )
        .await
        .unwrap();
    let seen = browser.seen.lock().unwrap().clone();
    let (a, b) = (&seen[0], &seen[1]);
    for url in [a, b] {
        assert_eq!(get_param(url, "response_type").as_deref(), Some("code"));
        assert_eq!(
            get_param(url, "code_challenge_method").as_deref(),
            Some("S256")
        );
        assert_eq!(get_param(url, "code_challenge").unwrap().len(), 43);
        assert!(get_param(url, "state").unwrap().len() >= 22, "≥128 bits");
        assert!(get_param(url, "nonce").is_some());
        assert_eq!(
            get_param(url, "redirect_uri").as_deref(),
            Some(MOBILE_REDIRECT)
        );
        assert!(
            get_param(url, "code_verifier").is_none(),
            "the verifier never leaves"
        );
    }
    for p in ["code_challenge", "state", "nonce"] {
        assert_ne!(
            get_param(a, p),
            get_param(b, p),
            "{p} must be fresh per request"
        );
    }
    assert_eq!(get_param(b, "prompt").as_deref(), Some("login"));
}

/// Negative control: an authorization code injected from another
/// authorization request (bound to someone else's PKCE challenge) is refused
/// at the token endpoint, because our verifier does not match it.
#[tokio::test]
async fn an_injected_code_with_another_pkce_challenge_is_refused() {
    let fake = Fake::start().await;
    let client = Client::new(fake.config(), Arc::new(MemoryStore::new())).unwrap();
    let browser =
        ScriptedBrowser::new(MOBILE_REDIRECT).with_tamper(|auth_url, callback| async move {
            // The attacker runs the same request with their own challenge.
            let attacker_url = set_param(
                &auth_url,
                "code_challenge",
                "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            );
            let attacker_callback = follow_authorize(&attacker_url).await;
            let attacker_code = get_param(&attacker_callback, "code").unwrap();
            set_param(&callback, "code", &attacker_code)
        });
    let err = client
        .sign_in(&browser, SignInOptions::default())
        .await
        .unwrap_err();
    match err {
        Error::Token(e) => assert_eq!(e.error, "invalid_grant"),
        other => panic!("expected invalid_grant, got {other:?}"),
    }
    assert_eq!(fake.auth_code_calls.load(Ordering::SeqCst), 1);
    assert!(!client.is_signed_in().await.unwrap());
}

/// Negative control (RFC 9207 mix-up defence): a response whose `iss` is not
/// our issuer is refused, and its code is never sent to the token endpoint.
#[tokio::test]
async fn iss_mismatch_is_refused_before_the_code_is_used() {
    let fake = Fake::start().await;
    let client = Client::new(fake.config(), Arc::new(MemoryStore::new())).unwrap();
    let evil = ScriptedBrowser::new(MOBILE_REDIRECT).with_tamper(|_, callback| async move {
        set_param(&callback, "iss", "https://evil.example")
    });
    match client.sign_in(&evil, SignInOptions::default()).await {
        Err(Error::IssuerMismatch { got, .. }) => {
            assert_eq!(got.as_deref(), Some("https://evil.example"));
        }
        other => panic!("expected IssuerMismatch, got {other:?}"),
    }
    let missing = ScriptedBrowser::new(MOBILE_REDIRECT).with_tamper(|_, callback| async move {
        let mut u = url::Url::parse(&callback).unwrap();
        let kept: Vec<(String, String)> = u
            .query_pairs()
            .filter(|(k, _)| k != "iss")
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        u.query_pairs_mut().clear().extend_pairs(kept);
        u.into()
    });
    assert!(matches!(
        client.sign_in(&missing, SignInOptions::default()).await,
        Err(Error::IssuerMismatch { got: None, .. })
    ));
    assert_eq!(
        fake.auth_code_calls.load(Ordering::SeqCst),
        0,
        "code never used"
    );
}

/// Negative control: a response carrying another request's `state` is
/// refused before its code is used.
#[tokio::test]
async fn state_mismatch_is_refused_before_the_code_is_used() {
    let fake = Fake::start().await;
    let client = Client::new(fake.config(), Arc::new(MemoryStore::new())).unwrap();
    let forged = ScriptedBrowser::new(MOBILE_REDIRECT).with_tamper(|_, callback| async move {
        set_param(
            &callback,
            "state",
            "an-attackers-state-value-from-elsewhere",
        )
    });
    assert!(matches!(
        client.sign_in(&forged, SignInOptions::default()).await,
        Err(Error::StateMismatch)
    ));
    assert_eq!(
        fake.auth_code_calls.load(Ordering::SeqCst),
        0,
        "code never used"
    );
}

#[tokio::test]
async fn an_error_response_is_reported_only_after_iss_and_state_verify() {
    let fake = Fake::start().await;
    let client = Client::new(fake.config(), Arc::new(MemoryStore::new())).unwrap();
    let denied = ScriptedBrowser::new(MOBILE_REDIRECT).with_tamper(|_, callback| async move {
        let state = get_param(&callback, "state").unwrap();
        let iss = get_param(&callback, "iss").unwrap();
        let mut u = url::Url::parse(MOBILE_REDIRECT).unwrap();
        u.query_pairs_mut()
            .append_pair("error", "access_denied")
            .append_pair("state", &state)
            .append_pair("iss", &iss);
        u.into()
    });
    match client.sign_in(&denied, SignInOptions::default()).await {
        Err(Error::Authorization(e)) => assert_eq!(e.error, "access_denied"),
        other => panic!("expected access_denied, got {other:?}"),
    }
}

#[tokio::test]
async fn an_id_token_with_the_wrong_nonce_is_refused() {
    let fake = Fake::start().await;
    *fake.id_token_nonce_override.lock().unwrap() = Some("replayed-nonce".into());
    let store = Arc::new(MemoryStore::new());
    let client = Client::new(fake.config(), store.clone()).unwrap();
    match client
        .sign_in(
            &ScriptedBrowser::new(MOBILE_REDIRECT),
            SignInOptions::default(),
        )
        .await
    {
        Err(Error::IdToken(m)) => assert!(m.contains("nonce"), "{m}"),
        other => panic!("expected IdToken, got {other:?}"),
    }
    assert!(stored_refresh_token(&store, &fake).is_none());
}

#[tokio::test]
async fn declined_scopes_are_reported_and_no_refresh_token_is_kept() {
    let fake = Fake::start().await;
    *fake.declined_scopes.lock().unwrap() = vec!["offline_access".into(), "ai:invoke".into()];
    let store = Arc::new(MemoryStore::new());
    let client = Client::new(fake.config(), store.clone()).unwrap();
    let signed = client
        .sign_in(
            &ScriptedBrowser::new(MOBILE_REDIRECT),
            SignInOptions::default(),
        )
        .await
        .unwrap();
    assert!(!signed.refreshable);
    assert!(!signed.scopes.contains(&"ai:invoke".to_owned()));
    assert!(stored_refresh_token(&store, &fake).is_none());
    // Without a refresh token, an expired access token is the end.
    fake.expire_access_tokens();
    assert!(matches!(
        client.balance().await,
        Err(Error::SignedOut(SignedOutReason::NoSession))
    ));
}

/// Single-flight refresh: 16 concurrent requests all see `401
/// invalid_token`, and exactly one refresh reaches the IdP. The fake runs
/// with no grace and a slow refresh, so a second refresh of the same token
/// would be reuse — the family would die and requests would fail.
#[tokio::test]
async fn concurrent_401s_cause_exactly_one_refresh() {
    let fake = Fake::start().await;
    let (client, store) = signed_in(&fake).await;
    *fake.grace.lock().unwrap() = Duration::ZERO;
    *fake.refresh_delay.lock().unwrap() = Duration::from_millis(200);
    let before = stored_refresh_token(&store, &fake).unwrap();
    fake.expire_access_tokens();

    let mut tasks = Vec::new();
    for _ in 0..16 {
        let c = client.clone();
        tasks.push(tokio::spawn(async move { c.balance().await }));
    }
    for t in tasks {
        t.await.unwrap().unwrap();
    }
    assert_eq!(fake.refresh_calls.load(Ordering::SeqCst), 1);
    assert_eq!(fake.live_refresh_tokens(), 1);
    let after = stored_refresh_token(&store, &fake).unwrap();
    assert_ne!(before, after, "the rotated refresh token is persisted");
}

/// The negative control for the test above: the fake really does treat a
/// second presentation of a rotated token as reuse. Without single-flight,
/// that is what two parallel refreshes are.
#[tokio::test]
async fn the_fake_treats_a_second_refresh_of_one_token_as_reuse() {
    let fake = Fake::start().await;
    let (_client, store) = signed_in(&fake).await;
    *fake.grace.lock().unwrap() = Duration::ZERO;
    let rt = stored_refresh_token(&store, &fake).unwrap();
    let http = reqwest::Client::new();
    let body = format!("grant_type=refresh_token&refresh_token={rt}&client_id={CLIENT_ID}");
    let post = || {
        http.post(format!("{}/api/oauth/token", fake.issuer))
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body.clone())
            .send()
    };
    assert_eq!(post().await.unwrap().status(), 200);
    let second = post().await.unwrap();
    assert_eq!(second.status(), 400);
    assert!(second.text().await.unwrap().contains("invalid_grant"));
    assert_eq!(fake.live_refresh_tokens(), 0, "the whole family is revoked");
}

/// A refresh token presented after it was rotated (a stale copy restored on
/// another device, or a thief's) is refused; the SDK signs out, clears the
/// store, and never retries.
#[tokio::test]
async fn refresh_reuse_signs_out_and_clears_the_store() {
    let fake = Fake::start().await;
    let (client, store) = signed_in(&fake).await;
    *fake.grace.lock().unwrap() = Duration::ZERO;
    let stale = store.load(&account(&fake)).unwrap().unwrap();

    // The legitimate client rotates.
    fake.expire_access_tokens();
    client.balance().await.unwrap();
    assert_eq!(fake.refresh_calls.load(Ordering::SeqCst), 1);

    // A second client starts from the stale copy.
    let stale_store = Arc::new(MemoryStore::new());
    stale_store.save(&account(&fake), &stale).unwrap();
    let other = Client::new(fake.config(), stale_store.clone()).unwrap();
    assert!(matches!(
        other.balance().await,
        Err(Error::SignedOut(SignedOutReason::RefreshRejected))
    ));
    assert!(stale_store.load(&account(&fake)).unwrap().is_none());
    assert_eq!(fake.refresh_calls.load(Ordering::SeqCst), 2, "no retry");

    // Reuse killed the family: the legitimate client is signed out too at its
    // next refresh.
    fake.expire_access_tokens();
    assert!(matches!(
        client.balance().await,
        Err(Error::SignedOut(SignedOutReason::RefreshRejected))
    ));
}

#[tokio::test]
async fn a_restarted_client_restores_from_the_store() {
    let fake = Fake::start().await;
    let (_first, store) = signed_in(&fake).await;
    let second = Client::new(fake.config(), store.clone()).unwrap();
    assert!(second.is_signed_in().await.unwrap());
    // No access token in the new process's memory: it refreshes once.
    second.balance().await.unwrap();
    second.balance().await.unwrap();
    assert_eq!(fake.refresh_calls.load(Ordering::SeqCst), 1);
    assert_eq!(second.subject().await.as_deref(), Some(SUBJECT));
}

#[tokio::test]
async fn token_revoked_clears_the_session() {
    let fake = Fake::start().await;
    let (client, store) = signed_in(&fake).await;
    fake.revoke_grant();
    assert!(matches!(
        client.balance().await,
        Err(Error::SignedOut(SignedOutReason::TokenRevoked))
    ));
    assert!(stored_refresh_token(&store, &fake).is_none());
    assert!(!client.is_signed_in().await.unwrap());
}

#[tokio::test]
async fn a_step_up_challenge_is_surfaced_with_its_parameters() {
    let fake = Fake::start().await;
    let (client, _) = signed_in(&fake).await;
    fake.require_step_up.store(true, Ordering::SeqCst);
    let Err(Error::StepUpRequired(challenge)) = client.balance().await else {
        panic!("expected step-up");
    };
    assert_eq!(challenge.max_age, Some(300));
    assert_eq!(challenge.acr_values.as_deref(), Some("urn:f2z:acr:mfa"));

    // Answering it: a new authorization with max_age, acr_values and
    // prompt=login.
    let browser = ScriptedBrowser::new(MOBILE_REDIRECT);
    client
        .sign_in(&browser, SignInOptions::step_up(&challenge))
        .await
        .unwrap();
    let url = browser.seen.lock().unwrap()[0].clone();
    assert_eq!(get_param(&url, "max_age").as_deref(), Some("300"));
    assert_eq!(
        get_param(&url, "acr_values").as_deref(),
        Some("urn:f2z:acr:mfa")
    );
    assert_eq!(get_param(&url, "prompt").as_deref(), Some("login"));
}

#[tokio::test]
async fn sign_out_revokes_the_family_and_clears_everything() {
    let fake = Fake::start().await;
    let (client, store) = signed_in(&fake).await;
    assert_eq!(fake.live_refresh_tokens(), 1);
    assert!(client.sign_out().await.unwrap(), "the IdP confirmed");
    assert_eq!(fake.revoke_calls.load(Ordering::SeqCst), 1);
    assert_eq!(fake.live_refresh_tokens(), 0);
    assert!(stored_refresh_token(&store, &fake).is_none());
    assert!(matches!(
        client.access_token().await,
        Err(Error::SignedOut(SignedOutReason::NoSession))
    ));
}

#[tokio::test]
async fn signing_in_again_revokes_the_previous_family() {
    let fake = Fake::start().await;
    let (client, _) = signed_in(&fake).await;
    client
        .sign_in(
            &ScriptedBrowser::new(MOBILE_REDIRECT),
            SignInOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(fake.revoke_calls.load(Ordering::SeqCst), 1);
    assert_eq!(fake.live_refresh_tokens(), 1);
}

#[tokio::test]
async fn an_unregistered_redirect_times_out_as_a_registration_mistake() {
    let fake = Fake::start().await;
    let config = fake
        .config()
        .with_callback_timeout(Duration::from_millis(300));
    let client = Client::new(config, Arc::new(MemoryStore::new())).unwrap();
    // The IdP refuses to redirect to an unregistered URI; the browser just
    // sits on the IdP's error page and nothing comes back.
    let session = LoopbackSession::bind_with_path(
        |_: &str| -> Result<(), String> { Ok(()) },
        "/not-registered",
    )
    .await
    .unwrap();
    assert!(matches!(
        client.sign_in(&session, SignInOptions::default()).await,
        Err(Error::Timeout(_))
    ));
}

/// A sign-out that completes while a sign-in waits on the browser wins: the
/// late sign-in installs nothing and revokes what it was issued.
#[tokio::test]
async fn a_sign_out_during_a_pending_sign_in_is_not_undone() {
    let fake = Fake::start().await;
    let (client, store) = signed_in(&fake).await;
    let during = client.clone();
    let browser = ScriptedBrowser::new(MOBILE_REDIRECT).with_tamper(move |_, callback| {
        let c = during.clone();
        async move {
            c.sign_out().await.unwrap();
            callback
        }
    });
    assert!(matches!(
        client.sign_in(&browser, SignInOptions::default()).await,
        Err(Error::SignedOut(SignedOutReason::SessionChanged))
    ));
    assert!(!client.is_signed_in().await.unwrap());
    assert!(stored_refresh_token(&store, &fake).is_none());
    assert_eq!(
        fake.live_refresh_tokens(),
        0,
        "the late tokens were revoked"
    );
}

/// A sign-out whose revocation stalls and whose caller gives up still leaves
/// nothing restorable, and the revocation still happens.
#[tokio::test]
async fn a_cancelled_sign_out_still_clears_the_store_and_revokes() {
    let fake = Fake::start().await;
    let (client, store) = signed_in(&fake).await;
    *fake.revoke_delay.lock().unwrap() = Duration::from_millis(400);
    let _ = tokio::time::timeout(Duration::from_millis(100), client.sign_out()).await;
    assert!(stored_refresh_token(&store, &fake).is_none());
    let restarted = Client::new(fake.config(), store.clone()).unwrap();
    assert!(!restarted.is_signed_in().await.unwrap());
    for _ in 0..50 {
        if fake.live_refresh_tokens() == 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the refresh token family was never revoked");
}

/// A store whose saves are slow, like a keychain waiting on the user.
struct SlowStore {
    inner: MemoryStore,
    save_delay: Duration,
}

impl TokenStore for SlowStore {
    fn load(&self, account: &str) -> Result<Option<f2z_sdk::Secret>, f2z_sdk::StoreError> {
        self.inner.load(account)
    }
    fn save(&self, account: &str, value: &f2z_sdk::Secret) -> Result<(), f2z_sdk::StoreError> {
        std::thread::sleep(self.save_delay);
        self.inner.save(account, value)
    }
    fn delete(&self, account: &str) -> Result<(), f2z_sdk::StoreError> {
        self.inner.delete(account)
    }
    fn persistence(&self) -> Persistence {
        Persistence::Persistent
    }
}

/// A slow save whose caller was cancelled must not land after a later
/// sign-out and resurrect the session.
#[tokio::test]
async fn a_cancelled_slow_save_cannot_undo_a_later_sign_out() {
    let fake = Fake::start().await;
    let store = Arc::new(SlowStore {
        inner: MemoryStore::new(),
        save_delay: Duration::from_millis(300),
    });
    let client = Client::new(fake.config(), store.clone()).unwrap();
    client
        .sign_in(
            &ScriptedBrowser::new(MOBILE_REDIRECT),
            SignInOptions::default(),
        )
        .await
        .unwrap();
    fake.expire_access_tokens();
    // The refresh's save starts; its caller gives up.
    let _ = tokio::time::timeout(Duration::from_millis(50), client.balance()).await;
    client.sign_out().await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(store.inner.load(&account(&fake)).unwrap().is_none());
}

/// A `401 token_revoked` for a request sent under an earlier session does not
/// sign out whoever signed in since.
#[tokio::test]
async fn a_late_token_revoked_does_not_clear_a_newer_session() {
    let fake = Fake::start().await;
    let (client, store) = signed_in(&fake).await;
    *fake.balance_delay.lock().unwrap() = Duration::from_millis(300);
    let old = client.clone();
    let pending = tokio::spawn(async move { old.balance().await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    fake.revoke_grant();
    client
        .sign_in(
            &ScriptedBrowser::new(MOBILE_REDIRECT),
            SignInOptions::default(),
        )
        .await
        .unwrap();
    assert!(matches!(
        pending.await.unwrap(),
        Err(Error::SignedOut(SignedOutReason::TokenRevoked))
    ));
    assert!(client.is_signed_in().await.unwrap());
    assert!(stored_refresh_token(&store, &fake).is_some());
}

#[tokio::test]
async fn cancelled_refresh_persists_the_rotated_token_after_response_headers() {
    let fake = Fake::start().await;
    let (client, store) = signed_in(&fake).await;
    let before = stored_refresh_token(&store, &fake).unwrap();
    *fake.grace.lock().unwrap() = Duration::ZERO;
    *fake.refresh_body_delay.lock().unwrap() = Duration::from_millis(200);
    fake.expire_access_tokens();
    assert!(
        tokio::time::timeout(Duration::from_millis(80), client.balance())
            .await
            .is_err()
    );
    assert_eq!(fake.refresh_calls.load(Ordering::SeqCst), 1);
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_ne!(stored_refresh_token(&store, &fake).unwrap(), before);
    // A new process can use the persisted successor with zero grace.
    let restored = Client::new(fake.config(), store).unwrap();
    restored.balance().await.unwrap();
    assert_eq!(fake.live_refresh_tokens(), 1);
}

struct BlockingStore {
    inner: MemoryStore,
    block_save: std::sync::atomic::AtomicBool,
    block_delete: std::sync::atomic::AtomicBool,
    fail_save: std::sync::atomic::AtomicBool,
    fail_delete: std::sync::atomic::AtomicBool,
    entered: std::sync::atomic::AtomicBool,
}
impl BlockingStore {
    fn new() -> Self {
        Self {
            inner: MemoryStore::new(),
            block_save: false.into(),
            block_delete: false.into(),
            fail_save: false.into(),
            fail_delete: false.into(),
            entered: false.into(),
        }
    }
    fn block(&self) {
        self.entered.store(true, Ordering::SeqCst);
        // Bounded OS-thread watchdog makes the negative control fail instead
        // of deadlocking the single-thread Tokio test runtime forever.
        std::thread::sleep(Duration::from_millis(600));
    }
    async fn wait_entered(&self) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !self.entered.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
    }
}
impl TokenStore for BlockingStore {
    fn load(&self, account: &str) -> Result<Option<f2z_sdk::Secret>, f2z_sdk::StoreError> {
        self.inner.load(account)
    }
    fn save(&self, account: &str, value: &f2z_sdk::Secret) -> Result<(), f2z_sdk::StoreError> {
        if self.block_save.load(Ordering::SeqCst) {
            self.block();
        }
        if self.fail_save.load(Ordering::SeqCst) {
            return Err(f2z_sdk::StoreError("injected keychain failure".into()));
        }
        self.inner.save(account, value)
    }
    fn delete(&self, account: &str) -> Result<(), f2z_sdk::StoreError> {
        if self.block_delete.load(Ordering::SeqCst) {
            self.block();
        }
        if self.fail_delete.load(Ordering::SeqCst) {
            return Err(f2z_sdk::StoreError("injected deletion failure".into()));
        }
        self.inner.delete(account)
    }
    fn persistence(&self) -> Persistence {
        Persistence::Persistent
    }
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_keychain_save_does_not_block_the_runtime_on_sign_out() {
    let fake = Fake::start().await;
    let store = Arc::new(BlockingStore::new());
    store.block_save.store(true, Ordering::SeqCst);
    let client = Client::new(fake.config(), store.clone()).unwrap();
    let signer = client.clone();
    let signin = tokio::spawn(async move {
        signer
            .sign_in(
                &ScriptedBrowser::new(MOBILE_REDIRECT),
                SignInOptions::default(),
            )
            .await
    });
    store.wait_entered().await;
    signin.abort();
    let _ = signin.await;
    let logout = tokio::spawn(async move { client.sign_out().await });
    let start = std::time::Instant::now();
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(
        start.elapsed() < Duration::from_millis(250),
        "runtime was blocked by keychain I/O"
    );
    logout.await.unwrap().unwrap();
    assert!(store.inner.load(&account(&fake)).unwrap().is_none());
}

#[tokio::test]
async fn cancelled_sign_out_during_keychain_delete_still_revokes() {
    let fake = Fake::start().await;
    let store = Arc::new(BlockingStore::new());
    let client = Client::new(fake.config(), store.clone()).unwrap();
    client
        .sign_in(
            &ScriptedBrowser::new(MOBILE_REDIRECT),
            SignInOptions::default(),
        )
        .await
        .unwrap();
    store.block_delete.store(true, Ordering::SeqCst);
    let logout = tokio::spawn(async move { client.sign_out().await });
    store.wait_entered().await;
    logout.abort();
    let _ = logout.await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        fake.live_refresh_tokens(),
        0,
        "revocation must not wait for local I/O"
    );
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(store.inner.load(&account(&fake)).unwrap().is_none());
}

#[tokio::test]
async fn failed_account_switch_persistence_revokes_the_previous_family() {
    let fake = Fake::start().await;
    let store = Arc::new(BlockingStore::new());
    let client = Client::new(fake.config(), store.clone()).unwrap();
    client
        .sign_in(
            &ScriptedBrowser::new(MOBILE_REDIRECT),
            SignInOptions::default(),
        )
        .await
        .unwrap();
    store.fail_save.store(true, Ordering::SeqCst);
    assert!(matches!(
        client
            .sign_in(
                &ScriptedBrowser::new(MOBILE_REDIRECT),
                SignInOptions::default()
            )
            .await,
        Err(Error::Storage(_))
    ));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(fake.revoke_calls.load(Ordering::SeqCst), 1);
    // Prior durable authority was removed before the new save.
    let restored = Client::new(fake.config(), store).unwrap();
    assert!(matches!(
        restored.balance().await,
        Err(Error::SignedOut(SignedOutReason::NoSession))
    ));
    client.balance().await.unwrap();
}

#[tokio::test]
async fn cancelled_account_switch_persistence_revokes_the_previous_family() {
    let fake = Fake::start().await;
    let store = Arc::new(BlockingStore::new());
    let client = Client::new(fake.config(), store.clone()).unwrap();
    client
        .sign_in(
            &ScriptedBrowser::new(MOBILE_REDIRECT),
            SignInOptions::default(),
        )
        .await
        .unwrap();
    let old_blob = store.inner.load(&account(&fake)).unwrap().unwrap();
    store.block_save.store(true, Ordering::SeqCst);
    let signin = tokio::spawn(async move {
        client
            .sign_in(
                &ScriptedBrowser::new(MOBILE_REDIRECT),
                SignInOptions::default(),
            )
            .await
    });
    store.wait_entered().await;
    signin.abort();
    let _ = signin.await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let snapshot = Arc::new(MemoryStore::new());
    snapshot.save(&account(&fake), &old_blob).unwrap();
    let restored = Client::new(fake.config(), snapshot).unwrap();
    assert!(matches!(
        restored.balance().await,
        Err(Error::SignedOut(SignedOutReason::RefreshRejected))
    ));
}

#[tokio::test]
async fn lost_refresh_response_is_recovered_with_the_same_predecessor() {
    let fake = Fake::start().await;
    let (client, store) = signed_in(&fake).await;
    let before = stored_refresh_token(&store, &fake).unwrap();
    fake.break_refresh_response_once
        .store(true, Ordering::SeqCst);
    fake.expire_access_tokens();
    client.balance().await.unwrap();
    assert_eq!(fake.refresh_calls.load(Ordering::SeqCst), 2);
    assert_ne!(stored_refresh_token(&store, &fake).unwrap(), before);
    assert_eq!(fake.live_refresh_tokens(), 1);
    // Expire grace: only the persisted successor can now work.
    *fake.grace.lock().unwrap() = Duration::ZERO;
    Client::new(fake.config(), store)
        .unwrap()
        .balance()
        .await
        .unwrap();
}

#[tokio::test]
async fn save_failure_and_revoke_unavailable_cannot_restore_the_old_account() {
    let fake = Fake::start().await;
    let store = Arc::new(BlockingStore::new());
    let client = Client::new(fake.config(), store.clone()).unwrap();
    client
        .sign_in(
            &ScriptedBrowser::new(MOBILE_REDIRECT),
            SignInOptions::default(),
        )
        .await
        .unwrap();
    store.fail_save.store(true, Ordering::SeqCst);
    fake.refuse_revocation.store(true, Ordering::SeqCst);
    assert!(matches!(
        client
            .sign_in(
                &ScriptedBrowser::new(MOBILE_REDIRECT),
                SignInOptions::default()
            )
            .await,
        Err(Error::Storage(_))
    ));
    assert!(store.inner.load(&account(&fake)).unwrap().is_none());
    let restored = Client::new(fake.config(), store).unwrap();
    assert!(matches!(
        restored.balance().await,
        Err(Error::SignedOut(SignedOutReason::NoSession))
    ));
    client.balance().await.unwrap();
}

#[tokio::test]
async fn failed_prior_deletion_does_not_activate_the_replacement() {
    let fake = Fake::start().await;
    let store = Arc::new(BlockingStore::new());
    let client = Client::new(fake.config(), store.clone()).unwrap();
    client
        .sign_in(
            &ScriptedBrowser::new(MOBILE_REDIRECT),
            SignInOptions::default(),
        )
        .await
        .unwrap();
    let previous_access = client.access_token().await.unwrap();
    let previous_blob = store.inner.load(&account(&fake)).unwrap();
    store.fail_delete.store(true, Ordering::SeqCst);
    assert!(matches!(
        client
            .sign_in(
                &ScriptedBrowser::new(MOBILE_REDIRECT),
                SignInOptions::default()
            )
            .await,
        Err(Error::Storage(_))
    ));
    assert_eq!(client.access_token().await.unwrap(), previous_access);
    assert_eq!(store.inner.load(&account(&fake)).unwrap(), previous_blob);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        fake.live_refresh_tokens(),
        1,
        "replacement grant must be revoked"
    );
    Client::new(fake.config(), store)
        .unwrap()
        .balance()
        .await
        .unwrap();
}

#[tokio::test]
async fn slow_refresh_success_within_configured_timeout_is_not_retried() {
    let fake = Fake::start().await;
    let (client, _) = signed_in(&fake).await;
    *fake.refresh_body_delay.lock().unwrap() = Duration::from_secs(20);
    fake.expire_access_tokens();
    client.balance().await.unwrap();
    assert_eq!(fake.refresh_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancelled_account_switch_during_delete_finishes_before_queued_sign_out() {
    let fake = Fake::start().await;
    let store = Arc::new(BlockingStore::new());
    let client = Client::new(fake.config(), store.clone()).unwrap();
    client
        .sign_in(
            &ScriptedBrowser::new(MOBILE_REDIRECT),
            SignInOptions::default(),
        )
        .await
        .unwrap();
    store.block_delete.store(true, Ordering::SeqCst);
    let signer = client.clone();
    let signin = tokio::spawn(async move {
        signer
            .sign_in(
                &ScriptedBrowser::new(MOBILE_REDIRECT),
                SignInOptions::default(),
            )
            .await
    });
    store.wait_entered().await;
    signin.abort();
    let _ = signin.await;
    client.sign_out().await.unwrap();
    assert!(!client.is_signed_in().await.unwrap());
    assert!(store.inner.load(&account(&fake)).unwrap().is_none());
    assert_eq!(
        fake.live_refresh_tokens(),
        0,
        "cancelled switch leaked the new grant"
    );
}

struct HangingStore {
    inner: MemoryStore,
    hang_load: std::sync::atomic::AtomicBool,
    loads: std::sync::atomic::AtomicUsize,
    deletes: std::sync::atomic::AtomicUsize,
    hang: std::sync::atomic::AtomicBool,
    entered: std::sync::atomic::AtomicBool,
    released: std::sync::Mutex<bool>,
    wake: std::sync::Condvar,
}
impl HangingStore {
    fn wait(&self) {
        self.entered.store(true, Ordering::SeqCst);
        let mut released = self.released.lock().unwrap();
        while !*released {
            released = self.wake.wait(released).unwrap();
        }
    }
}
impl TokenStore for HangingStore {
    fn load(&self, account: &str) -> Result<Option<f2z_sdk::Secret>, f2z_sdk::StoreError> {
        self.loads.fetch_add(1, Ordering::SeqCst);
        if self.hang_load.load(Ordering::SeqCst) {
            self.wait();
        }
        self.inner.load(account)
    }
    fn save(&self, account: &str, value: &f2z_sdk::Secret) -> Result<(), f2z_sdk::StoreError> {
        if self.hang.load(Ordering::SeqCst) {
            self.wait();
        }
        self.inner.save(account, value)
    }
    fn delete(&self, account: &str) -> Result<(), f2z_sdk::StoreError> {
        self.deletes.fetch_add(1, Ordering::SeqCst);
        self.inner.delete(account)
    }
    fn persistence(&self) -> Persistence {
        Persistence::Persistent
    }
}
struct ReleaseStore(Arc<HangingStore>);
impl Drop for ReleaseStore {
    fn drop(&mut self) {
        *self.0.released.lock().unwrap() = true;
        self.0.wake.notify_all();
    }
}

#[tokio::test]
async fn a_hung_detached_refresh_save_does_not_prevent_sign_out_revocation() {
    let fake = Fake::start().await;
    let store = Arc::new(HangingStore {
        inner: MemoryStore::new(),
        hang_load: false.into(),
        loads: 0.into(),
        deletes: 0.into(),
        hang: false.into(),
        entered: false.into(),
        released: std::sync::Mutex::new(false),
        wake: std::sync::Condvar::new(),
    });
    let cleanup = ReleaseStore(store.clone());
    let client = Client::new(
        fake.config()
            .with_request_timeout(Duration::from_millis(200)),
        store.clone(),
    )
    .unwrap();
    client
        .sign_in(
            &ScriptedBrowser::new(MOBILE_REDIRECT),
            SignInOptions::default(),
        )
        .await
        .unwrap();
    store.hang.store(true, Ordering::SeqCst);
    fake.expire_access_tokens();
    let refresher = client.clone();
    let request = tokio::spawn(async move { refresher.balance().await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while !store.entered.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    request.abort();
    let _ = request.await;
    let result = tokio::time::timeout(Duration::from_secs(2), client.sign_out())
        .await
        .expect("hung keychain retained session lock and prevented sign-out");
    assert!(
        matches!(result, Err(Error::Storage(_))),
        "durable delete is still blocked"
    );
    assert_eq!(
        fake.live_refresh_tokens(),
        0,
        "remote revocation must not wait for keychain"
    );
    assert!(!client.is_signed_in().await.unwrap());
    let deletes_before_release = store.deletes.load(Ordering::SeqCst);
    for _ in 0..8 {
        assert!(matches!(client.sign_out().await, Err(Error::Storage(_))));
    }
    // Only test cleanup releases the OS operation; late save then delete must
    // retain their order and cannot restore the signed-out session.
    drop(cleanup);
    tokio::time::timeout(Duration::from_secs(2), async {
        while store.inner.load(&account(&fake)).unwrap().is_some() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        store.deletes.load(Ordering::SeqCst),
        deletes_before_release + 1,
        "repeated timed-out deletes must coalesce to one pending operation"
    );
}

#[tokio::test]
async fn repeated_timed_out_loads_share_one_blocking_operation() {
    let fake = Fake::start().await;
    let store = Arc::new(HangingStore {
        inner: MemoryStore::new(),
        hang_load: true.into(),
        loads: 0.into(),
        deletes: 0.into(),
        hang: false.into(),
        entered: false.into(),
        released: std::sync::Mutex::new(false),
        wake: std::sync::Condvar::new(),
    });
    let cleanup = ReleaseStore(store.clone());
    let client = Client::new(
        fake.config()
            .with_request_timeout(Duration::from_millis(20)),
        store.clone(),
    )
    .unwrap();
    for _ in 0..12 {
        assert!(matches!(
            client.is_signed_in().await,
            Err(Error::Storage(_))
        ));
    }
    assert_eq!(
        store.loads.load(Ordering::SeqCst),
        1,
        "retries spawned more blocked keychain loads"
    );
    drop(cleanup);
    assert!(!client.is_signed_in().await.unwrap());
}

#[tokio::test]
async fn hung_initial_read_does_not_block_sign_out_deletion() {
    let fake = Fake::start().await;
    let store = Arc::new(HangingStore {
        inner: MemoryStore::new(),
        hang_load: false.into(),
        loads: 0.into(),
        deletes: 0.into(),
        hang: false.into(),
        entered: false.into(),
        released: std::sync::Mutex::new(false),
        wake: std::sync::Condvar::new(),
    });
    let cleanup = ReleaseStore(store.clone());
    let config = fake
        .config()
        .with_request_timeout(Duration::from_millis(30));
    let initial = Client::new(config.clone(), store.clone()).unwrap();
    initial
        .sign_in(
            &ScriptedBrowser::new(MOBILE_REDIRECT),
            SignInOptions::default(),
        )
        .await
        .unwrap();
    assert!(store.inner.load(&account(&fake)).unwrap().is_some());
    drop(initial);
    store.hang_load.store(true, Ordering::SeqCst);
    let client = Client::new(config.clone(), store.clone()).unwrap();
    assert!(matches!(
        client.is_signed_in().await,
        Err(Error::Storage(_))
    ));
    assert!(
        !client
            .sign_out()
            .await
            .expect("hung read prevented independent deletion")
    );
    assert!(store.inner.load(&account(&fake)).unwrap().is_none());
    drop(cleanup);
    assert!(!client.is_signed_in().await.unwrap());
    let restarted = Client::new(config, store).unwrap();
    assert!(
        !restarted.is_signed_in().await.unwrap(),
        "deleted session restored after restart"
    );
}
