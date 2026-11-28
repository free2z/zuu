//! Real gateway + real provider adapter, with a fault-injected durable-function seam.
#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]
mod adapter_support;
mod support;
use async_trait::async_trait;
use axum::http::{HeaderMap, StatusCode};
use f2z_ai::{
    ApiFailure, Deps,
    auth::{Admitted, Gatekeeper, Principal},
    catalog::Fixed,
    ledger::{Failure, Identity, Ledger, Operation},
    meter::Metered,
};
use f2z_ai_testkit::mock::{MockProvider, Scenario};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use uuid::Uuid;

struct Gate;
#[async_trait]
impl Gatekeeper for Gate {
    async fn admit(&self, headers: &HeaderMap) -> Result<Admitted, ApiFailure> {
        Ok(Admitted {
            principal: Principal {
                sub: headers
                    .get("test-subject")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("11111111-1111-4111-8111-111111111111")
                    .into(),
                client_id: "opaque.native-client_7f3c2e".into(),
                app_id: "22222222-2222-4222-8222-222222222222".into(),
                scope: "ai:invoke".into(),
                aep: 1,
                agen: 1,
                exp: u64::MAX,
                jti: "test".into(),
                child_directed: headers.contains_key("test-child-directed"),
            },
            lease: None,
        })
    }
}
#[derive(Clone)]
struct Attempt {
    id: Uuid,
    number: i32,
    model: String,
    amount: i64,
    outcome: Option<&'static str>,
}
#[derive(Default)]
struct Memory {
    call: Option<Uuid>,
    identity: Option<Identity>,
    key: Option<String>,
    fingerprint: String,
    request: Value,
    completion: Value,
    hold: Option<Uuid>,
    attempts: Vec<Attempt>,
    operations: Vec<Operation>,
    refuse_attempt: Option<i32>,
    lose_attempt_replies: Option<i32>,
    lose_release_replies: usize,
    fail_release: bool,
    slow_release: bool,
    release_started: bool,
    fail_reads: bool,
    available_after_release: Option<u64>,
    amount: i64,
    terminal: Option<&'static str>,
    charges: usize,
    hold_requests: usize,
    settle_requests: usize,
    revoked: bool,
    expire_at_completion: bool,
    revoke_after_hold: bool,
    lose_hold_replies: usize,
    lose_settle_reply: bool,
    omit_settle_cap: bool,
    malformed_settle_cap: bool,
    unsafe_settle_cap: bool,
    fail_context_after_settle: bool,
    terminalize_on_first_complete: bool,
    available: u64,
    cap_remaining_milli_2z: Option<u64>,
    slow_completion: bool,
    /// Mimic a ledger before `ledger.0006_call_features`: its
    /// `gateway_metadata_valid` refuses any key it does not name, so
    /// `call_claim` raises (22023), which the adapter reports as `Failure`.
    old_ledger: bool,
    claims: usize,
    context_requests: usize,
    /// The usage vector the last `Settle` carried.
    settled_usage: Value,
}
impl Memory {
    fn context(&self) -> Value {
        json!({"status":"ok","available_milli_2z":self.available,"cap_remaining_milli_2z":self.cap_remaining_milli_2z,"debt_milli_2z":0,"open_holds":0,"frozen":false,"consented_markup_bps":0,"effective_markup_bps":0})
    }
    fn record(&self) -> Value {
        let status = match self.terminal {
            Some("settled") => {
                if self.completion["partial"] == true {
                    "settled_partial"
                } else {
                    "settled"
                }
            }
            Some("released") if self.completion.is_null() => "streaming",
            Some(_) => "released",
            None => {
                if self.completion.is_null() {
                    "streaming"
                } else {
                    "settling"
                }
            }
        };
        json!({"call_id":self.call,"status":status,"request":self.request,"completion":self.completion,"created_at":"2026-09-27T00:00:00Z","settled_at":self.terminal.map(|_|"2026-09-27T00:00:01Z"),"error":null,
          "attempts":self.attempts.iter().rev().map(|a|json!({"hold_id":a.id,"attempt":a.number,"model":a.model})).collect::<Vec<_>>(),
          "settlement":self.terminal.and_then(|outcome|self.hold.map(|id|json!({"hold_id":id,"outcome":outcome,"hold_milli_2z":self.amount,"priced_milli_2z":if outcome=="settled" {1000} else {0},"collected_milli_2z":if outcome=="settled" {1000} else {0},"shortfall_milli_2z":0,"applied_markup_bps":0,"usage":{"private_debug":"must not project"}})))})
    }
}
struct Database(Mutex<Memory>);
impl Database {
    fn new() -> Self {
        Self(Mutex::new(Memory {
            available: 100_000,
            ..Memory::default()
        }))
    }
}
#[async_trait]
impl Ledger for Database {
    async fn execute(&self, op: &Operation) -> Result<Value, Failure> {
        if matches!(op, Operation::Complete { .. }) && self.0.lock().unwrap().slow_completion {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        if matches!(op, Operation::Release { .. }) && self.0.lock().unwrap().slow_release {
            self.0.lock().unwrap().release_started = true;
            tokio::time::sleep(Duration::from_millis(600)).await;
        }
        let mut m = self.0.lock().unwrap();
        m.operations.push(op.clone());
        match op {
            Operation::Context(_) => {
                m.context_requests += 1;
                if m.terminal == Some("settled") && m.fail_context_after_settle {
                    return Err(Failure);
                }
                Ok(if m.revoked {
                    json!({"status":"revoked"})
                } else {
                    m.context()
                })
            }
            Operation::Claim {
                identity,
                call,
                key,
                fingerprint,
                request,
            } => {
                m.claims += 1;
                if m.old_ledger && request.get("features").is_some() {
                    return Err(Failure);
                }
                if m.revoked {
                    return Ok(
                        json!({"status":"revoked","call_id":null,"record":null,"context":{"status":"revoked"}}),
                    );
                }
                let status = if m.call.is_some() {
                    if &m.key != key || &m.fingerprint != fingerprint {
                        "conflict"
                    } else if matches!(
                        m.record()["status"].as_str(),
                        Some("settled" | "settled_partial" | "released")
                    ) {
                        "replayed"
                    } else {
                        "pending"
                    }
                } else {
                    m.call = Some(*call);
                    m.identity = Some(*identity);
                    m.key = key.clone();
                    m.fingerprint = fingerprint.clone();
                    m.request = request.clone();
                    "claimed"
                };
                Ok(
                    json!({"status":status,"call_id":m.call,"record":m.record(),"context":m.context()}),
                )
            }
            Operation::Hold {
                amount_milli,
                attempt,
                model,
                ..
            } => {
                m.hold_requests += 1;
                if m.revoked {
                    return Ok(json!({"status":"revoked"}));
                }
                if m.refuse_attempt == Some(*attempt) {
                    return Ok(json!({"status":"insufficient_balance"}));
                }
                let existing = m.attempts.iter().find(|a| a.number == *attempt).cloned();
                let replayed = existing.is_some();
                let id = if let Some(a) = existing {
                    assert_eq!(a.amount, *amount_milli, "hold intent changed");
                    assert_eq!(&a.model, model);
                    a.id
                } else {
                    assert!(
                        m.completion.is_null(),
                        "completed calls admit no new attempt"
                    );
                    assert!(
                        m.attempts.iter().all(|a| a.outcome == Some("released")),
                        "previous attempt hold must be released before the next hold"
                    );
                    let id = Uuid::now_v7();
                    m.attempts.push(Attempt {
                        id,
                        number: *attempt,
                        model: model.clone(),
                        amount: *amount_milli,
                        outcome: None,
                    });
                    m.terminal = None;
                    id
                };
                m.hold = Some(id);
                m.amount = *amount_milli;
                if m.revoke_after_hold {
                    m.revoked = true;
                }
                if m.lose_hold_replies > 0 || m.lose_attempt_replies == Some(*attempt) {
                    m.lose_hold_replies = m.lose_hold_replies.saturating_sub(1);
                    return Err(Failure);
                }
                Ok(
                    json!({"status":if replayed {"replayed"} else {"held"},"state":m.terminal.unwrap_or("open"),"hold_id":id,"amount":m.amount,"applied_markup_bps":0,"available":m.available,"cap_remaining":null,"expires_at":"2026-09-27T00:05:00Z"}),
                )
            }
            Operation::Extend { .. } => Ok(
                json!({"status":"held","state":"open","amount":m.amount,"available":m.available,"cap_remaining":null,"expires_at":"2026-09-27T00:05:00Z"}),
            ),
            Operation::Complete {
                identity,
                call,
                completion,
                no_hold,
            } => {
                if m.terminalize_on_first_complete && m.terminal.is_none() {
                    // Model another durable settler winning just before this
                    // completion recovery reads the call envelope.
                    m.terminalize_on_first_complete = false;
                    m.completion = completion.clone();
                    m.terminal = Some("settled");
                    m.charges += 1;
                    if let Some(cap) = m.cap_remaining_milli_2z.as_mut() {
                        *cap = cap.saturating_sub(1_000);
                    }
                }
                if m.old_ledger && m.call.is_none() {
                    // The refused claim inserted nothing: the settler's
                    // completion of it finds no call, as the real ledger's does.
                    return Ok(json!({"status":"not_found","record":null}));
                }
                assert_eq!(Some(*call), m.call);
                assert_eq!(identity.grant_generation, 1);
                // The production ledger's `gateway_metadata_valid` accepts an
                // error of exactly `code` and `message`, strings of 1–256
                // characters, and raises on anything else.
                if let Some(error) = completion.get("error").filter(|e| !e.is_null()) {
                    let error = error.as_object().expect("error is an object");
                    assert!(error.contains_key("code") && error.contains_key("message"));
                    for (key, value) in error {
                        assert!(
                            key == "code" || key == "message",
                            "ledger refuses error.{key}"
                        );
                        let n = value.as_str().expect("string").chars().count();
                        assert!((1..=256).contains(&n), "error.{key} is {n} characters");
                    }
                }
                if m.completion.is_null() {
                    m.completion = completion.clone();
                } else {
                    assert_eq!(&m.completion, completion, "completion intent changed");
                }
                if m.expire_at_completion {
                    m.terminal = Some("expired");
                    m.expire_at_completion = false;
                }
                if *no_hold {
                    assert!(m.hold.is_none(), "false no-hold claim would strand money");
                    m.terminal = Some("released");
                }
                let terminal = m.terminal;
                if let Some(a) = m.attempts.last_mut() {
                    a.outcome = terminal;
                }
                Ok(json!({"status":"recorded","record":m.record()}))
            }
            Operation::Settle {
                hold,
                cost_nusd,
                usage,
            } => {
                assert_eq!(Some(*hold), m.hold);
                assert!(*cost_nusd > 0);
                assert!(usage["input_tokens"].as_u64().unwrap() > 0);
                m.settled_usage = usage.clone();
                m.settle_requests += 1;
                let replayed = m.terminal == Some("settled");
                if m.terminal.is_none() {
                    m.charges += 1;
                    m.terminal = Some("settled");
                    if let Some(cap) = m.cap_remaining_milli_2z.as_mut() {
                        *cap = cap.saturating_sub(1_000);
                    }
                }
                let terminal = m.terminal;
                m.attempts.last_mut().unwrap().outcome = terminal;
                if m.lose_settle_reply {
                    m.lose_settle_reply = false;
                    return Err(Failure);
                }
                let mut result = json!({
                    "status":if m.terminal==Some("settled") {"settled"} else {"not_open"},
                    "state":m.terminal,
                    "priced":if m.terminal==Some("settled") {1000} else {0},
                    "charged":if m.terminal==Some("settled") {1000} else {0},
                    "shortfall":0,
                    "available":m.available,
                });
                result["transfer_id"] = if m.terminal == Some("settled") {
                    json!(1)
                } else {
                    Value::Null
                };
                if !m.omit_settle_cap {
                    result["cap_remaining"] = if m.malformed_settle_cap {
                        json!("not-an-integer")
                    } else if m.unsafe_settle_cap {
                        json!(9_007_199_254_740_992_u64)
                    } else if replayed {
                        Value::Null
                    } else {
                        json!(m.cap_remaining_milli_2z)
                    };
                }
                Ok(result)
            }
            Operation::Release { hold, .. } => {
                if m.fail_release {
                    return Err(Failure);
                }
                let a = m.attempts.iter_mut().find(|a| a.id == *hold).unwrap();
                a.outcome.get_or_insert("released");
                let outcome = a.outcome;
                if m.hold == Some(*hold) {
                    m.terminal = outcome;
                }
                if let Some(available) = m.available_after_release {
                    m.available = available;
                }
                if m.lose_release_replies > 0 {
                    m.lose_release_replies -= 1;
                    return Err(Failure);
                }
                Ok(json!({"status":outcome}))
            }
            Operation::Read { identity, call } => {
                if m.fail_reads {
                    return Err(Failure);
                }
                if Some(*call) != m.call
                    || m.identity
                        .is_none_or(|i| i.subject != identity.subject || i.app != identity.app)
                {
                    Ok(json!({"status":"not_found","record":null}))
                } else {
                    Ok(json!({"status":"found","record":m.record()}))
                }
            }
        }
    }
}
async fn launch(db: Arc<Database>, scenario: Scenario) -> (support::Running, MockProvider) {
    launch_policy(db, scenario, None).await
}
async fn launch_policy(
    db: Arc<Database>,
    scenario: Scenario,
    allowed: Option<Vec<&str>>,
) -> (support::Running, MockProvider) {
    launch_catalog(db, scenario, allowed, adapter_support::catalog(10_000)).await
}
async fn launch_catalog(
    db: Arc<Database>,
    scenario: Scenario,
    allowed: Option<Vec<&str>>,
    catalog: f2z_ai::catalog::VerifiedCatalog,
) -> (support::Running, MockProvider) {
    launch_meta(db, scenario, allowed, catalog, false).await
}
async fn launch_meta(
    db: Arc<Database>,
    scenario: Scenario,
    allowed: Option<Vec<&str>>,
    catalog: f2z_ai::catalog::VerifiedCatalog,
    features_meta: bool,
) -> (support::Running, MockProvider) {
    let mock = MockProvider::start(scenario).await.unwrap();
    let meter = Arc::new(
        Metered::new(
            db,
            adapter_support::backend(&mock.base_url(), adapter_support::tuning(0)),
            adapter_support::claim_key(),
        )
        .with_allowed_models(allowed.map(|ids| ids.into_iter().map(str::to_owned).collect()))
        .with_features_meta(features_meta),
    );
    let running = support::start(
        &support::config(&[]),
        Deps {
            gate: Arc::new(Gate),
            catalog: Arc::new(Fixed(catalog)),
            backend: meter.clone(),
            settler: meter,
        },
    )
    .await;
    support::wait_readyz(running.admin, StatusCode::OK).await;
    (running, mock)
}
fn request() -> Value {
    json!({"model":"m-responses","max_output_tokens":100,"messages":[{"role":"user","content":[{"type":"text","text":"hello tutor"}]}]})
}
async fn send(r: &support::Running) -> axum::http::Response<hyper::body::Incoming> {
    let mut req = support::chat_request(request().to_string());
    req.headers_mut()
        .insert("idempotency-key", "lesson-1".parse().unwrap());
    support::send(r.public, req).await
}
async fn final_state(db: &Database) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if db.0.lock().unwrap().terminal.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn paid_stream_lost_settle_response_replay_and_account_scoped_receipt() {
    let db = Arc::new(Database::new());
    db.0.lock().unwrap().lose_settle_reply = true;
    let (r, mock) = launch(db.clone(), Scenario::default()).await;
    let response = send(&r).await;
    assert_eq!(response.status(), StatusCode::OK);
    let id = response.headers()["x-f2z-call-id"]
        .to_str()
        .unwrap()
        .to_owned();
    let text = support::text(response).await;
    assert!(text.contains("event: meta"), "{text}");
    assert!(text.contains("event: done"), "{text}");
    assert!(text.contains("\"charged_2z\":1"), "{text}");
    {
        let mut state = db.0.lock().unwrap();
        assert_eq!(state.charges, 1);
        assert_eq!(state.settle_requests, 2);
        state.available = 0;
    }
    let replay = send(&r).await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(replay.headers()["x-f2z-replayed"], "true");
    let record: Value = serde_json::from_str(&support::text(replay).await).unwrap();
    assert_eq!(record["status"], "settled");
    assert_eq!(record["metadata"], json!({}), "no caller text (zuu#1225)");
    assert!(!record.to_string().contains("private_debug"));
    assert_eq!(db.0.lock().unwrap().charges, 1);
    let foreign = axum::http::Request::get(format!("/v1/calls/{id}"))
        .header("host", "gateway")
        .header("test-subject", "33333333-3333-4333-8333-333333333333")
        .body(axum::body::Body::empty())
        .unwrap();
    assert_eq!(
        support::send(r.public, foreign).await.status(),
        StatusCode::NOT_FOUND
    );
    mock.shutdown().await;
}
// zuu#1163 — the `: ping` keep-alive (chat-api.md §3). A reasoning model can
// be silent for longer than the TypeScript SDK's 45 s idle watchdog before its first
// content event; without pings the client drops the stream while the call
// reads to completion and settles, so the user pays for an answer they never
// received. These run on a paused clock: the silences are real 50 s waits in
// virtual time, against the real adapter and the testkit mock.

/// Drive the paused clock by hand, 50 ms of virtual time per ~0.5 ms of real
/// time. Tokio's own auto-advance is unusable here: it jumps the clock
/// whenever the runtime is idle, including while the kernel is still
/// delivering a loopback write, so provider deadlines fire spuriously. This
/// task is always runnable, so the runtime never idles and the clock moves
/// only here; the real sleep gives the kernel its turn.
fn drive_clock() -> tokio::task::JoinHandle<()> {
    tokio::spawn(async {
        loop {
            std::thread::sleep(Duration::from_micros(500));
            tokio::time::advance(Duration::from_millis(50)).await;
        }
    })
}

/// The SDKs' idle watchdog (`ts/free2z/sdk` `streamIdleTimeoutMs` default).
const SDK_IDLE: Duration = Duration::from_secs(45);
/// Longer than [`SDK_IDLE`].
const SILENCE: Duration = Duration::from_secs(50);

/// A gateway whose provider may be silent for minutes, with `keepalive` as
/// its ping interval (`None`: no pings — the negative control).
async fn launch_keepalive(
    db: Arc<Database>,
    scenario: Scenario,
    keepalive: Option<Duration>,
) -> (support::Running, MockProvider) {
    let mock = MockProvider::start(scenario).await.unwrap();
    let mut tuning = adapter_support::tuning(0);
    tuning.timeouts.idle = Duration::from_secs(120);
    tuning.timeouts.hard_limit = Duration::from_secs(300);
    let meter = Arc::new(Metered::new(
        db,
        adapter_support::backend(&mock.base_url(), tuning),
        adapter_support::claim_key(),
    ));
    let mut config = support::config(&[]);
    config.stream_keepalive = keepalive;
    let running = support::start(
        &config,
        Deps {
            gate: Arc::new(Gate),
            catalog: Arc::new(Fixed(adapter_support::catalog_with(120_000, Some(120_000)))),
            backend: meter.clone(),
            settler: meter,
        },
    )
    .await;
    support::wait_readyz(running.admin, StatusCode::OK).await;
    (running, mock)
}

/// Read a streamed body the way both SDKs do: any byte — a comment included
/// — resets a [`SDK_IDLE`] watchdog. `Err` carries what had arrived when the
/// watchdog fired.
async fn read_like_the_sdk(
    response: axum::http::Response<hyper::body::Incoming>,
) -> Result<String, String> {
    let mut body = response.into_body();
    let mut text = String::new();
    loop {
        match tokio::time::timeout(SDK_IDLE, support::next_frame(&mut body)).await {
            Err(_) => return Err(text),
            Ok(Ok(Some(bytes))) => text.push_str(std::str::from_utf8(&bytes).unwrap()),
            Ok(Ok(None)) => return Ok(text),
            Ok(Err(e)) => panic!("the stream failed: {e}; after {text}"),
        }
    }
}

/// Wait (in virtual time) for the call to reach a terminal ledger state.
async fn settled(db: &Database) -> &'static str {
    tokio::time::timeout(Duration::from_secs(300), async {
        loop {
            if let Some(terminal) = db.0.lock().unwrap().terminal {
                return terminal;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test(start_paused = true)]
async fn pings_keep_the_client_through_a_silent_provider_and_stop_at_the_terminal_event() {
    let clock = drive_clock();
    let db = Arc::new(Database::new());
    // Silent for 50 s before the first byte, and again for 50 s before the
    // second visible delta — after `meta`.
    let scenario = Scenario::default()
        .with_ttfb(SILENCE)
        .with_stall(1, SILENCE);
    let (r, mock) = launch_keepalive(db.clone(), scenario, Some(Duration::from_secs(15))).await;
    let response = send(&r).await;
    assert_eq!(response.status(), StatusCode::OK);
    let text = read_like_the_sdk(response)
        .await
        .unwrap_or_else(|partial| panic!("the watchdog fired despite the pings: {partial}"));

    let meta = text.find("event: meta").expect("no meta");
    let done = text.rfind("event: done").expect("no done");
    let deltas: Vec<usize> = text.match_indices("event: delta").map(|(i, _)| i).collect();
    assert!(deltas.len() >= 2, "{text}");
    // 15, 30 and 45 s into the 50 s wait for the first byte: before `meta`.
    assert_eq!(text[..meta].matches(": ping\n\n").count(), 3, "{text}");
    assert!(text.starts_with(": ping\n\n"), "{text}");
    // And again during the stall between the first two deltas, after `meta`.
    assert_eq!(
        text[deltas[0]..deltas[1]].matches(": ping\n\n").count(),
        3,
        "{text}"
    );
    // Never after the terminal event; the stream ends with it.
    assert!(!text[done..].contains(": ping"), "{text}");
    // Events are delivered intact around the comments.
    for block in text
        .split("\n\n")
        .filter(|b| !b.is_empty() && !b.starts_with(':'))
    {
        assert!(block.starts_with("event: "), "{block:?} in {text}");
    }
    assert!(text.contains("\"charged_2z\":1"), "{text}");
    assert_eq!(settled(&db).await, "settled");
    mock.shutdown().await;
    clock.abort();
}

#[tokio::test(start_paused = true)]
async fn without_pings_the_client_drops_a_silent_stream_that_is_still_charged() {
    // The negative control: the same 50 s pre-`meta` silence with the
    // emitter off. The SDK's watchdog fires with nothing received after the
    // headers, while the gateway reads the provider to completion and
    // settles — zuu#1163's defect, as it was.
    let clock = drive_clock();
    let db = Arc::new(Database::new());
    let (r, mock) =
        launch_keepalive(db.clone(), Scenario::default().with_ttfb(SILENCE), None).await;
    let response = send(&r).await;
    assert_eq!(response.status(), StatusCode::OK);
    let partial = read_like_the_sdk(response)
        .await
        .expect_err("the watchdog should have fired: nothing was sent for 50 s");
    assert_eq!(
        partial, "",
        "nothing should have arrived before the watchdog"
    );
    assert_eq!(settled(&db).await, "settled");
    assert_eq!(db.0.lock().unwrap().charges, 1);
    mock.shutdown().await;
    clock.abort();
}

#[tokio::test(start_paused = true)]
async fn a_non_streamed_call_gets_no_pings() {
    let clock = drive_clock();
    let db = Arc::new(Database::new());
    let (r, mock) = launch_keepalive(
        db.clone(),
        Scenario::default().with_ttfb(SILENCE),
        Some(Duration::from_secs(15)),
    )
    .await;
    let response = send_nonstream(&r).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "application/json");
    let text = support::text(response).await;
    assert!(!text.contains("ping"), "{text}");
    let reply: f2z_ai_proto::chat::ChatResponse = serde_json::from_str(&text).unwrap();
    reply.check().unwrap();
    assert_eq!(reply.charged_2z, Some(f2z_ai_proto::Whole2z::new(1)));
    mock.shutdown().await;
    clock.abort();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lost_hold_reply_is_recovered_without_provider_charge() {
    let db = Arc::new(Database::new());
    db.0.lock().unwrap().lose_hold_replies = 2;
    let (r, mock) = launch(db.clone(), Scenario::default()).await;
    let response = send(&r).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    final_state(&db).await;
    {
        let state = db.0.lock().unwrap();
        assert_eq!(state.terminal, Some("released"));
        assert_eq!(state.charges, 0);
    }
    mock.shutdown().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn models_etag_is_private_and_estimate_creates_no_call_or_hold() {
    let db = Arc::new(Database::new());
    let (r, mock) = launch(db.clone(), Scenario::default()).await;
    let req = axum::http::Request::get("/v1/models")
        .header("host", "gateway")
        .body(axum::body::Body::empty())
        .unwrap();
    let response = support::send(r.public, req).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "private, max-age=60");
    let etag = response.headers()["etag"].clone();
    let req = axum::http::Request::get("/v1/models")
        .header("host", "gateway")
        .header("if-none-match", etag)
        .body(axum::body::Body::empty())
        .unwrap();
    assert_eq!(
        support::send(r.public, req).await.status(),
        StatusCode::NOT_MODIFIED
    );
    let req = axum::http::Request::post("/v1/chat/estimate")
        .header("host", "gateway")
        .header("content-type", "application/json")
        .body(axum::body::Body::from(request().to_string()))
        .unwrap();
    let response = support::send(r.public, req).await;
    assert_eq!(response.status(), StatusCode::OK);
    let estimate: Value = serde_json::from_str(&support::text(response).await).unwrap();
    assert_eq!(estimate["hold_2z"], 1);
    assert!(db.0.lock().unwrap().call.is_none());
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn admitted_call_settles_after_revocation_without_reauthorization() {
    let db = Arc::new(Database::new());
    db.0.lock().unwrap().revoke_after_hold = true;
    let (r, mock) = launch(db.clone(), Scenario::default()).await;
    let response = send(&r).await;
    assert_eq!(response.status(), StatusCode::OK);
    let text = support::text(response).await;
    assert!(text.contains("\"charged_2z\":1"), "{text}");
    assert_eq!(db.0.lock().unwrap().charges, 1);
    mock.shutdown().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lost_hold_reply_then_revocation_recovers_attempt_before_release() {
    let db = Arc::new(Database::new());
    {
        let mut state = db.0.lock().unwrap();
        state.revoke_after_hold = true;
        state.lose_hold_replies = 1;
    }
    let (r, mock) = launch(db.clone(), Scenario::default()).await;
    let response = send(&r).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    final_state(&db).await;
    assert_eq!(db.0.lock().unwrap().terminal, Some("released"));
    assert_eq!(db.0.lock().unwrap().charges, 0);
    mock.shutdown().await;
}
/// The text of every `delta` in an SSE body.
fn delivered_text(sse: &str) -> String {
    let mut text = String::new();
    let mut lines = sse.lines();
    while let Some(line) = lines.next() {
        if line == "event: delta"
            && let Some(data) = lines.next().and_then(|d| d.strip_prefix("data: "))
        {
            let delta: Value = serde_json::from_str(data).unwrap();
            text.push_str(delta["text"].as_str().unwrap());
        }
    }
    text
}
/// The expected metering.md §5.4 usage for `text` delivered on `request`:
/// `input_tokens` is the hold's estimate, `output_tokens` the delivered text
/// tokenised and scaled by 11,000 bps.
async fn expected_estimate(r: &support::Running, request: &Value, text: &str) -> (u64, u64) {
    let input = estimate_input(r, request).await;
    let raw = f2z_ai::estimate::Encoding::O200kBase.count(text);
    (input, raw + raw.div_ceil(10))
}
// free2z/zuu#1164: a stream that ends without its usage frame used to
// release the whole hold (the platform absorbed the call, and a refund was
// repeatable with a 1 2Z balance). It settles on metering.md §5.4's
// estimate: the hold's input estimate plus the produced output tokenised.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_usage_settles_on_the_estimate_never_zero_and_never_above_the_hold() {
    let db = Arc::new(Database::new());
    let (r, mock) = launch(db.clone(), Scenario::default().without_usage()).await;
    let response = send(&r).await;
    assert_eq!(response.status(), StatusCode::OK);
    let text = support::text(response).await;
    assert!(text.contains("event: delta"), "{text}");
    assert!(!text.contains("event: error"), "{text}");
    assert!(text.contains("event: usage"), "{text}");
    assert!(text.contains("\"source\":\"estimated\""), "{text}");
    assert!(text.contains("event: done"), "{text}");
    assert!(text.contains("\"settlement\":\"settled\""), "{text}");
    assert!(text.contains("\"usage_source\":\"estimated\""), "{text}");
    final_state(&db).await;
    let delivered = delivered_text(&text);
    assert!(!delivered.is_empty());
    let (input, output) = expected_estimate(&r, &request(), &delivered).await;
    {
        let state = db.0.lock().unwrap();
        assert_eq!(state.charges, 1);
        assert_eq!(state.terminal, Some("settled"));
        assert_eq!(state.settled_usage["input_tokens"], input);
        assert_eq!(state.settled_usage["output_tokens"], output);
        // Never above the hold: the input is the hold's own estimate and the
        // output is within the cap the provider was given.
        assert!(output <= 100, "{output}");
        for bucket in [
            "cached_input_tokens",
            "cache_write_tokens",
            "reasoning_tokens",
            "tool_calls",
        ] {
            assert_eq!(state.settled_usage[bucket], 0, "{bucket}");
        }
    }
    // The record says so, for the count metering.md §5.4 asks for.
    let record = db.0.lock().unwrap().record();
    assert_eq!(record["completion"]["usage_source"], "estimated");
    mock.shutdown().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stream_cut_after_output_settles_partial_on_the_estimate() {
    let db = Arc::new(Database::new());
    // Cut half way through the body: after the first deltas, before the
    // usage frame (the recipe `adapter_faults.rs` uses).
    let scenario = Scenario::default().with_output_tokens(64);
    let ctx = f2z_ai_testkit::mock::RenderContext {
        model: format!("{}-upstream", adapter_support::RESPONSES.id),
        include_usage: true,
        request_seq: 1,
    };
    let byte = (f2z_ai_testkit::mock::plan(adapter_support::RESPONSES.style, &scenario, &ctx)
        .body_bytes()
        .len()
        / 2) as u64;
    let (r, mock) = launch(
        db.clone(),
        scenario.with_fault(f2z_ai_testkit::mock::Fault::DisconnectAtByte { byte }),
    )
    .await;
    let text = support::text(send(&r).await).await;
    assert!(text.contains("event: delta"), "{text}");
    assert!(text.contains("event: error"), "{text}");
    assert!(text.contains("\"code\":\"provider_error\""), "{text}");
    assert!(text.contains("\"settlement\":\"settled\""), "{text}");
    assert!(text.contains("\"partial\":true"), "{text}");
    final_state(&db).await;
    let delivered = delivered_text(&text);
    let (input, output) = expected_estimate(&r, &request(), &delivered).await;
    {
        let state = db.0.lock().unwrap();
        assert_eq!(state.charges, 1);
        assert_eq!(state.settled_usage["input_tokens"], input);
        assert_eq!(state.settled_usage["output_tokens"], output);
        assert_eq!(state.record()["status"], "settled_partial");
    }
    mock.shutdown().await;
}
// A nonreasoning idle-timeout control: an accepted provider request that
// sends no visible output still settles on the input estimate. Reasoning
// rows additionally reserve their held output ceiling under §5.4.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_timeout_before_any_output_still_charges_the_input_estimate() {
    let db = Arc::new(Database::new());
    let (r, mock) = launch_catalog(
        db.clone(),
        Scenario::default().with_stall(0, Duration::from_millis(1_500)),
        None,
        adapter_support::catalog_with(10_000, Some(150)),
    )
    .await;
    let text = support::text(send(&r).await).await;
    assert!(!text.contains("event: delta"), "{text}");
    assert!(text.contains("\"code\":\"provider_timeout\""), "{text}");
    assert!(text.contains("\"settlement\":\"settled\""), "{text}");
    assert!(!text.contains("released"), "{text}");
    // A charged terminal is never a lone `error`: `meta` precedes it
    // (chat-api.md §2.3), so a client reading to the spec sees the charge.
    let events: Vec<&str> = text
        .lines()
        .filter_map(|l| l.strip_prefix("event: "))
        .collect();
    assert_eq!(events, ["meta", "usage", "error"], "{text}");
    final_state(&db).await;
    let input = estimate_input(&r, &request()).await;
    {
        let state = db.0.lock().unwrap();
        assert_eq!(state.charges, 1);
        assert_eq!(state.settled_usage["input_tokens"], input);
        assert_eq!(state.settled_usage["output_tokens"], 0);
        assert_eq!(state.record()["completion"]["usage_source"], "estimated");
    }
    mock.shutdown().await;
}

fn interruption_catalog(reasoning: bool) -> f2z_ai::catalog::VerifiedCatalog {
    let mut catalog = priced_catalog().catalog().clone();
    let model = catalog
        .models
        .iter_mut()
        .find(|model| model.id == "m-chat")
        .unwrap();
    model.capabilities.reasoning = reasoning;
    f2z_ai::catalog::VerifiedCatalog::from_verified(catalog).unwrap()
}

fn reasoning_effort_interruption_catalog() -> f2z_ai::catalog::VerifiedCatalog {
    let mut catalog = interruption_catalog(false).catalog().clone();
    let model = catalog
        .models
        .iter_mut()
        .find(|model| model.id == "m-chat")
        .unwrap();
    model.capabilities.reasoning_effort = true;
    model.controls.effort_levels = Some(vec!["low".into()]);
    f2z_ai::catalog::VerifiedCatalog::from_verified(catalog).unwrap()
}

fn meta_event(text: &str) -> Value {
    let data = text
        .lines()
        .skip_while(|line| *line != "event: meta")
        .nth(1)
        .and_then(|line| line.strip_prefix("data: "))
        .expect("accepted call emits meta before settlement");
    serde_json::from_str(data).unwrap()
}

// free2z/zuu#1179: when an accepted reasoning request loses full usage,
// visible deltas cannot bound its hidden output. Idle and hard deadlines use
// the provider-sent, affordability-clamped output ceiling. The paired
// nonreasoning cases pin the old visible-only estimate as the negative
// control: changing the reasoning estimate back to visible-only makes both
// reasoning assertions below fail.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reasoning_timeouts_settle_at_the_provider_output_cap() {
    for (deadline, reasoning, signed_effort, request_effort, expected_visible) in [
        ("idle", true, false, false, false),
        ("idle", false, false, false, false),
        ("hard", true, false, false, true),
        ("hard", false, false, false, true),
        // Signed effort metadata qualifies with or without a request value;
        // the first row also covers an actual request value.
        ("hard", false, true, true, true),
        ("hard", false, true, false, true),
    ] {
        let db = Arc::new(Database::new());
        db.0.lock().unwrap().available = 5_000;
        let scenario = if deadline == "idle" {
            Scenario::default()
                .with_output_tokens(64)
                .with_reasoning_tokens(64)
                .with_stall(0, Duration::from_secs(2))
        } else {
            Scenario::default()
                .with_output_tokens(64)
                .with_reasoning_tokens(48)
                .with_stall(1, Duration::from_secs(2))
        };
        let mock = MockProvider::start(scenario.without_usage()).await.unwrap();
        let mut tuning = adapter_support::tuning(0);
        tuning.timeouts.idle = if deadline == "idle" {
            Duration::from_millis(150)
        } else {
            Duration::from_secs(5)
        };
        tuning.timeouts.hard_limit = if deadline == "hard" {
            Duration::from_millis(250)
        } else {
            Duration::from_secs(5)
        };
        let meter = Arc::new(Metered::new(
            db.clone(),
            adapter_support::backend(&mock.base_url(), tuning),
            adapter_support::claim_key(),
        ));
        let catalog = if signed_effort {
            reasoning_effort_interruption_catalog()
        } else {
            interruption_catalog(reasoning)
        };
        let running = support::start(
            &support::config(&[]),
            Deps {
                gate: Arc::new(Gate),
                catalog: Arc::new(Fixed(catalog)),
                backend: meter.clone(),
                settler: meter,
            },
        )
        .await;
        support::wait_readyz(running.admin, StatusCode::OK).await;
        let mut body = request();
        body["model"] = json!("m-chat");
        body["max_output_tokens"] = json!(1800);
        if request_effort {
            body["reasoning_effort"] = json!("low");
        }
        let mut req = support::chat_request(body.to_string());
        req.headers_mut().insert(
            "idempotency-key",
            format!("reasoning-{deadline}-{reasoning}-{signed_effort}-{request_effort}")
                .parse()
                .unwrap(),
        );
        let text = support::text(support::send(running.public, req).await).await;
        assert!(
            text.contains("\"code\":\"provider_timeout\""),
            "{deadline}: {text}"
        );
        assert!(
            text.contains("\"settlement\":\"settled\""),
            "{deadline}: {text}"
        );
        assert!(
            text.contains("\"source\":\"estimated\""),
            "{deadline}: {text}"
        );
        final_state(&db).await;

        let meta = meta_event(&text);
        let output_cap = meta["max_output_tokens"].as_u64().unwrap();
        assert!(
            output_cap < 1800,
            "fixture did not clamp the request: {meta}"
        );
        let sent = mock.recorded_requests();
        assert_eq!(sent.len(), 1, "exactly one request reached provider");
        assert_eq!(sent[0].body["max_completion_tokens"], output_cap);
        if signed_effort && !request_effort {
            assert!(sent[0].body.get("reasoning_effort").is_none());
        }
        let expected_output = if reasoning || signed_effort || request_effort {
            output_cap
        } else if expected_visible {
            let visible = delivered_text(&text);
            let tokens = f2z_ai::estimate::Encoding::O200kBase.count(&visible);
            (tokens + tokens.div_ceil(10)).min(output_cap)
        } else {
            0
        };
        {
            let state = db.0.lock().unwrap();
            assert_eq!(
                state.charges, 1,
                "one charge for {deadline}/{reasoning}/{signed_effort}/{request_effort}"
            );
            assert_eq!(state.terminal, Some("settled"));
            assert_eq!(state.settle_requests, 1);
            assert!(state.settled_usage["input_tokens"].as_u64().unwrap() > 0);
            assert_eq!(state.settled_usage["output_tokens"], expected_output);
            assert!(expected_output <= output_cap);
            assert_eq!(state.record()["completion"]["usage_source"], "estimated");
            assert!(
                state.record()["settlement"]["priced_milli_2z"]
                    .as_u64()
                    .unwrap()
                    <= state.record()["settlement"]["hold_milli_2z"]
                        .as_u64()
                        .unwrap()
            );
            assert_eq!(state.record()["settlement"]["shortfall_milli_2z"], 0);
        }
        if reasoning || signed_effort || request_effort {
            assert_eq!(
                expected_output, output_cap,
                "{deadline}: hidden reasoning is bounded by the held cap"
            );
        } else if expected_visible {
            assert!(
                expected_output < output_cap,
                "visible-only control must stay below the cap"
            );
        }
        mock.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reasoning_requests_keep_complete_provider_usage_unchanged() {
    let db = Arc::new(Database::new());
    let scenario = Scenario::default()
        .with_output_tokens(64)
        .with_reasoning_tokens(48);
    let mock = MockProvider::start(scenario).await.unwrap();
    let meter = Arc::new(Metered::new(
        db.clone(),
        adapter_support::backend(&mock.base_url(), adapter_support::tuning(0)),
        adapter_support::claim_key(),
    ));
    let running = support::start(
        &support::config(&[]),
        Deps {
            gate: Arc::new(Gate),
            catalog: Arc::new(Fixed(interruption_catalog(true))),
            backend: meter.clone(),
            settler: meter,
        },
    )
    .await;
    support::wait_readyz(running.admin, StatusCode::OK).await;
    let mut body = request();
    body["model"] = json!("m-chat");
    body["max_output_tokens"] = json!(1800);
    let mut req = support::chat_request(body.to_string());
    req.headers_mut().insert(
        "idempotency-key",
        "reasoning-provider-usage".parse().unwrap(),
    );
    let text = support::text(support::send(running.public, req).await).await;
    assert!(text.contains("event: done"), "{text}");
    assert!(text.contains("\"source\":\"provider\""), "{text}");
    final_state(&db).await;
    {
        let state = db.0.lock().unwrap();
        assert_eq!(state.charges, 1);
        assert_eq!(state.settle_requests, 1);
        assert_eq!(state.settled_usage["output_tokens"], 64);
        assert_eq!(state.settled_usage["reasoning_tokens"], 48);
        assert_eq!(state.record()["completion"]["usage_source"], "provider");
    }
    mock.shutdown().await;
}
/// A Chat Completions server replaying `chunks` as an SSE body, byte for
/// byte, then closing — the recipe of the tool-fragment test below.
async fn replay_server(chunks: &[Value]) -> (String, tokio::task::JoinHandle<()>) {
    let body: String = chunks
        .iter()
        .map(|c| match c {
            Value::String(s) => format!("data: {s}\n\n"),
            other => format!("data: {other}\n\n"),
        })
        .collect();
    let app = axum::Router::new().route(
        "/v1/chat/completions",
        axum::routing::post(move || {
            let body = body.clone();
            async move { ([("content-type", "text/event-stream")], body) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (base, server)
}
// A tool stream cut before its complete `tool_call` (and its usage): the
// arguments the model generated were billed by the provider, and the
// fragments are the only record of them. They are counted — once, not
// beside the complete call — streamed or not (`stream: false` drops the
// fragments on the wire, never from the bill).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tool_stream_cut_mid_call_bills_the_generated_arguments_from_its_fragments() {
    let fixture = tool_fixture("openai_strict_forced_streamed.json");
    let chunks = fixture["provider_stream"].as_array().unwrap();
    // Every fragment, then the cut: no finish chunk, no usage, no [DONE].
    let fragments_only: Vec<Value> = chunks
        .iter()
        .take_while(|c| c["choices"][0]["finish_reason"].is_null() && *c != &json!("[DONE]"))
        .cloned()
        .collect();
    assert_eq!(fragments_only.len(), 8, "{fragments_only:?}");
    let (base, server) = replay_server(&fragments_only).await;
    let (catalog, model) = refusal_catalog("openai_interim");
    let generated = "check_answer{\"question_id\":\"q1\",\"answer\":\"x = 4\"}";
    let raw = f2z_ai::estimate::Encoding::O200kBase.count(generated);
    let expected_output = raw + raw.div_ceil(10);
    for stream in [true, false] {
        let db = Arc::new(Database::new());
        let meter = Arc::new(Metered::new(
            db.clone(),
            adapter_support::backend(&base, adapter_support::tuning(0)),
            adapter_support::claim_key(),
        ));
        let r = support::start(
            &support::config(&[]),
            Deps {
                gate: Arc::new(Gate),
                catalog: Arc::new(Fixed(catalog.clone())),
                backend: meter.clone(),
                settler: meter,
            },
        )
        .await;
        support::wait_readyz(r.admin, StatusCode::OK).await;
        let mut request = fixture["request"].clone();
        request["model"] = json!(model);
        request["stream"] = json!(stream);
        let input = estimate_input(&r, &request).await;
        let response = support::send(r.public, support::chat_request(request.to_string())).await;
        let text = support::text(response).await;
        if stream {
            assert!(text.contains("event: tool_call_delta"), "{text}");
            assert!(!text.contains("event: tool_call\n"), "{text}");
            assert!(text.contains("\"code\":\"provider_error\""), "{text}");
            assert!(text.contains("\"settlement\":\"settled\""), "{text}");
        } else {
            let value: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(value["error"]["code"], "provider_error", "{text}");
            assert_eq!(value["error"]["details"]["settlement"], "settled", "{text}");
        }
        final_state(&db).await;
        let state = db.0.lock().unwrap();
        assert_eq!(state.charges, 1, "stream={stream}");
        assert_eq!(
            state.settled_usage["input_tokens"], input,
            "stream={stream}"
        );
        assert_eq!(
            state.settled_usage["output_tokens"], expected_output,
            "stream={stream}: {}",
            state.settled_usage
        );
        assert_eq!(state.record()["completion"]["usage_source"], "estimated");
    }
    server.abort();
}
// A drain that cuts a silent, accepted stream: the provider answered 2xx and
// was still thinking when the window closed, so it bills the request. The
// hold settles on the input estimate — it is not refunded because the
// upstream had no outcome to hand the settler.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_drain_that_cuts_a_silent_accepted_stream_settles_on_the_input_estimate() {
    let db = Arc::new(Database::new());
    let mock = MockProvider::start(Scenario::default().with_stall(0, SILENCE))
        .await
        .unwrap();
    let mut tuning = adapter_support::tuning(0);
    tuning.timeouts.idle = Duration::from_secs(120);
    let meter = Arc::new(Metered::new(
        db.clone(),
        adapter_support::backend(&mock.base_url(), tuning),
        adapter_support::claim_key(),
    ));
    let running = support::start(
        &support::config(&[
            ("F2Z_AI_DRAIN_TIMEOUT_SECS", "1"),
            ("F2Z_AI_ABORT_GRACE_SECS", "1"),
        ]),
        Deps {
            gate: Arc::new(Gate),
            catalog: Arc::new(Fixed(adapter_support::catalog_with(120_000, Some(120_000)))),
            backend: meter.clone(),
            settler: meter,
        },
    )
    .await;
    let (public, admin, gateway) = (running.public, running.admin, running.gateway);
    support::wait_readyz(admin, StatusCode::OK).await;
    let mut req = support::chat_request(request().to_string());
    req.headers_mut()
        .insert("idempotency-key", "lesson-drain".parse().unwrap());
    let response = support::send(public, req).await;
    assert_eq!(response.status(), StatusCode::OK);
    // The provider has the request (2xx head, then silence). Drain.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (signal, fired) = tokio::sync::oneshot::channel::<()>();
    let run = tokio::spawn(gateway.run_until(async move {
        let _ = fired.await;
    }));
    signal.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(15), run)
        .await
        .expect("the drain did not finish")
        .unwrap();
    drop(response);
    final_state(&db).await;
    {
        let state = db.0.lock().unwrap();
        assert_eq!(
            state.terminal,
            Some("settled"),
            "a silent accepted call was refunded"
        );
        assert_eq!(state.charges, 1);
        assert!(state.settled_usage["input_tokens"].as_u64().unwrap() > 0);
        assert_eq!(state.settled_usage["output_tokens"], 0);
        assert_eq!(state.record()["completion"]["usage_source"], "estimated");
        assert_eq!(state.record()["completion"]["error"]["code"], "unavailable");
    }
    mock.shutdown().await;
}
// A provider's OWN error event before any content is its in-stream refusal
// (Anthropic's `overloaded_error` is a 529 that happens to arrive after the
// head): it does not bill, so the hold is released — a lone error with
// `charged_2z: 0`, as chat-api.md §2.3 has always said.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_provider_error_event_before_content_releases_like_a_refusal() {
    for model in ["m-anthropic", "m-chat", "m-responses"] {
        let db = Arc::new(Database::new());
        let (r, mock) = launch(
            db.clone(),
            Scenario::default().with_fault(f2z_ai_testkit::mock::Fault::ErrorEventAtByte {
                byte: 0,
                status: 529,
            }),
        )
        .await;
        let mut request = request();
        request["model"] = json!(model);
        let mut req = support::chat_request(request.to_string());
        req.headers_mut()
            .insert("idempotency-key", "lesson-1".parse().unwrap());
        let text = support::text(support::send(r.public, req).await).await;
        assert!(
            text.contains("\"settlement\":\"released\""),
            "{model}: {text}"
        );
        assert!(text.contains("\"charged_2z\":0"), "{model}: {text}");
        assert!(!text.contains("event: meta"), "{model}: {text}");
        final_state(&db).await;
        {
            let state = db.0.lock().unwrap();
            assert_eq!(state.charges, 0, "{model}");
            assert_eq!(state.terminal, Some("released"), "{model}");
        }
        mock.shutdown().await;
    }
}
// Anthropic's `message_start` reports the exact input counts before any
// output; a stream that then loses its usage frame settles on THOSE, not on
// the byte bound the hold was sized with.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_anthropic_stream_cut_after_message_start_settles_on_its_reported_input() {
    let db = Arc::new(Database::new());
    let scenario = Scenario::default()
        .with_input_tokens(40)
        .with_cache(5, 3)
        .with_output_tokens(64);
    let ctx = f2z_ai_testkit::mock::RenderContext {
        model: format!("{}-upstream", adapter_support::ANTHROPIC.id),
        include_usage: true,
        request_seq: 1,
    };
    let byte = (f2z_ai_testkit::mock::plan(adapter_support::ANTHROPIC.style, &scenario, &ctx)
        .body_bytes()
        .len()
        / 2) as u64;
    let (r, mock) = launch(
        db.clone(),
        scenario.with_fault(f2z_ai_testkit::mock::Fault::DisconnectAtByte { byte }),
    )
    .await;
    let mut request = request();
    request["model"] = json!("m-anthropic");
    let estimate = estimate_input(&r, &request).await;
    let mut req = support::chat_request(request.to_string());
    req.headers_mut()
        .insert("idempotency-key", "lesson-1".parse().unwrap());
    let text = support::text(support::send(r.public, req).await).await;
    assert!(text.contains("\"settlement\":\"settled\""), "{text}");
    final_state(&db).await;
    {
        let state = db.0.lock().unwrap();
        assert_eq!(state.charges, 1);
        // The byte bound (far above 48) sized the hold; the provider's own
        // counts settle it.
        assert!(estimate > 48, "{estimate}");
        assert_eq!(
            state.settled_usage["input_tokens"], 40,
            "{}",
            state.settled_usage
        );
        assert_eq!(state.settled_usage["cached_input_tokens"], 5);
        assert_eq!(state.settled_usage["cache_write_tokens"], 3);
        assert!(state.settled_usage["output_tokens"].as_u64().unwrap() > 0);
    }
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_anthropic_tool_cut_settles_its_name_and_argument_fragments_in_both_relay_modes() {
    let mut value = serde_json::to_value(adapter_support::catalog(10_000).catalog()).unwrap();
    for model in value["models"].as_array_mut().unwrap() {
        if model["id"] == "m-anthropic" {
            model["capabilities"] = json!({"tools": true});
        }
    }
    let catalog =
        f2z_ai::catalog::VerifiedCatalog::from_verified(serde_json::from_value(value).unwrap())
            .unwrap();
    let fixture = include_str!("fixtures/anthropic/tool_use_cut_after_2_arguments.sse");
    let generated = "lookup{\"query\":\"harbor\"";
    let raw = f2z_ai::estimate::Encoding::O200kBase.count(generated);
    let calculated_output = raw + raw.div_ceil(10);
    assert_eq!(calculated_output, 8);

    for (stream, relay_mode) in [(true, "stream"), (false, "nonstream")] {
        for output_cap in [100, 5] {
            let expected_output = calculated_output.min(output_cap);
            assert_eq!(expected_output, if output_cap == 100 { 8 } else { 5 });
            let db = Arc::new(Database::new());
            let (r, mock) = launch_catalog(
                db.clone(),
                Scenario::default().with_replay(fixture),
                None,
                catalog.clone(),
            )
            .await;
            let mut body = request();
            body["model"] = json!("m-anthropic");
            body["stream"] = json!(stream);
            body["max_output_tokens"] = json!(output_cap);
            body["tools"] = json!([{"name":"lookup","parameters":{"type":"object"}}]);
            let mut req = support::chat_request(body.to_string());
            req.headers_mut().insert(
                "idempotency-key",
                format!("anthropic-tool-{relay_mode}-{output_cap}")
                    .parse()
                    .unwrap(),
            );
            let text = support::text(support::send(r.public, req).await).await;
            if stream {
                assert!(text.contains("event: tool_call_delta"), "{text}");
                assert!(!text.contains("event: tool_call\n"), "{text}");
                assert!(text.contains("\"source\":\"estimated\""), "{text}");
            } else {
                assert!(!text.contains("tool_call_delta"), "{text}");
            }
            assert!(text.contains("\"settlement\":\"settled\""), "{text}");
            final_state(&db).await;
            {
                let state = db.0.lock().unwrap();
                assert_eq!(state.charges, 1, "{relay_mode}, cap={output_cap}");
                assert_eq!(state.settle_requests, 1, "{relay_mode}, cap={output_cap}");
                assert_eq!(
                    state.settled_usage["output_tokens"], expected_output,
                    "{relay_mode}, cap={output_cap}"
                );
                assert_eq!(state.settled_usage["tool_calls"], 0);
                assert_eq!(
                    state.record()["status"],
                    if stream { "settled_partial" } else { "settled" }
                );
                assert_eq!(state.completion["usage_source"], "estimated");
            }
            mock.shutdown().await;
        }
    }
}
// The same drain on an Anthropic stream that had sent `message_start`:
// its exact input counts (a mostly cached prompt) settle the call, not the
// byte bound the hold was sized with — the parser's knowledge is taken
// before the upstream is dropped.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_drain_after_anthropic_message_start_settles_on_its_reported_input() {
    let db = Arc::new(Database::new());
    let mock = MockProvider::start(
        Scenario::default()
            .with_input_tokens(40)
            .with_cache(5, 3)
            .with_stall(0, SILENCE),
    )
    .await
    .unwrap();
    let mut tuning = adapter_support::tuning(0);
    tuning.timeouts.idle = Duration::from_secs(120);
    let meter = Arc::new(Metered::new(
        db.clone(),
        adapter_support::backend(&mock.base_url(), tuning),
        adapter_support::claim_key(),
    ));
    let running = support::start(
        &support::config(&[
            ("F2Z_AI_DRAIN_TIMEOUT_SECS", "1"),
            ("F2Z_AI_ABORT_GRACE_SECS", "1"),
        ]),
        Deps {
            gate: Arc::new(Gate),
            catalog: Arc::new(Fixed(adapter_support::catalog_with(120_000, Some(120_000)))),
            backend: meter.clone(),
            settler: meter,
        },
    )
    .await;
    support::wait_readyz(running.admin, StatusCode::OK).await;
    let mut request = request();
    request["model"] = json!("m-anthropic");
    // The byte bound sized the hold, far above the 48 tokens Anthropic reports.
    let estimate = estimate_input(&running, &request).await;
    assert!(estimate > 48, "{estimate}");
    let mut req = support::chat_request(request.to_string());
    req.headers_mut()
        .insert("idempotency-key", "lesson-drain".parse().unwrap());
    let response = support::send(running.public, req).await;
    assert_eq!(response.status(), StatusCode::OK);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (signal, fired) = tokio::sync::oneshot::channel::<()>();
    let run = tokio::spawn(running.gateway.run_until(async move {
        let _ = fired.await;
    }));
    signal.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(15), run)
        .await
        .expect("the drain did not finish")
        .unwrap();
    drop(response);
    final_state(&db).await;
    {
        let state = db.0.lock().unwrap();
        assert_eq!(state.terminal, Some("settled"));
        assert_eq!(
            state.settled_usage["input_tokens"], 40,
            "{}",
            state.settled_usage
        );
        assert_eq!(state.settled_usage["cached_input_tokens"], 5);
        assert_eq!(state.settled_usage["cache_write_tokens"], 3);
        assert_eq!(state.settled_usage["output_tokens"], 0);
        assert_eq!(state.record()["completion"]["error"]["code"], "unavailable");
    }
    mock.shutdown().await;
}
// Chat Completions sends nothing before the first content chunk, so a
// reasoning model that thinks past `ttfb_timeout_ms` after its 2xx head
// ends as `provider_timeout` / `first_byte` — an accepted request the
// provider bills. Charged on the input estimate, after a `meta`. The
// provider here is a raw socket: head, flush, silence.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_head_then_silence_past_ttfb_is_charged_the_input_estimate_after_meta() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut buf = vec![0u8; 65536];
                let mut read = 0usize;
                // Read to the end of the headers, then the body length.
                let length = loop {
                    let n = socket.read(&mut buf[read..]).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    read += n;
                    let text = String::from_utf8_lossy(&buf[..read]).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if read >= end + 4 + length {
                            break length;
                        }
                    }
                };
                let _ = length;
                socket
                    .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n")
                    .await
                    .unwrap();
                socket.flush().await.unwrap();
                // The head is out; now silence past the first-byte limit.
                tokio::time::sleep(Duration::from_secs(5)).await;
            });
        }
    });
    let db = Arc::new(Database::new());
    let meter = Arc::new(Metered::new(
        db.clone(),
        adapter_support::backend(&base, adapter_support::tuning(0)),
        adapter_support::claim_key(),
    ));
    let r = support::start(
        &support::config(&[]),
        Deps {
            gate: Arc::new(Gate),
            catalog: Arc::new(Fixed(adapter_support::catalog_with(300, None))),
            backend: meter.clone(),
            settler: meter,
        },
    )
    .await;
    support::wait_readyz(r.admin, StatusCode::OK).await;
    let mut request = request();
    request["model"] = json!("m-chat");
    let input = estimate_input(&r, &request).await;
    let mut req = support::chat_request(request.to_string());
    req.headers_mut()
        .insert("idempotency-key", "lesson-1".parse().unwrap());
    let text = support::text(support::send(r.public, req).await).await;
    // The stream-level `error` carries the code and the settlement; the
    // phase (`first_byte`) is the adapter's and is pinned in
    // `adapter_faults.rs`.
    assert!(text.contains("\"code\":\"provider_timeout\""), "{text}");
    assert!(text.contains("\"settlement\":\"settled\""), "{text}");
    assert!(text.contains("\"source\":\"estimated\""), "{text}");
    let events: Vec<&str> = text
        .lines()
        .filter_map(|l| l.strip_prefix("event: "))
        .collect();
    assert_eq!(events, ["meta", "usage", "error"], "{text}");
    final_state(&db).await;
    {
        let state = db.0.lock().unwrap();
        assert_eq!(state.charges, 1);
        assert_eq!(state.settled_usage["input_tokens"], input);
        assert_eq!(state.settled_usage["output_tokens"], 0);
        assert_eq!(state.record()["completion"]["usage_source"], "estimated");
    }
    server.abort();
}
// The Responses adapter keeps reading after a provider `error` event (a
// `response.failed` with usage may follow). When the provider then stalls
// instead, the idle timeout must not outrank the provider's own refusal:
// the request was refused before any content and is released, not charged.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_responses_error_event_then_silence_is_still_a_refusal() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut buf = vec![0u8; 65536];
                let mut read = 0usize;
                loop {
                    let n = socket.read(&mut buf[read..]).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    read += n;
                    let text = String::from_utf8_lossy(&buf[..read]).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if read >= end + 4 + length {
                            break;
                        }
                    }
                }
                let frame = "event: error\ndata: {\"type\":\"error\",\"code\":\"server_error\",\"message\":\"overloaded\",\"param\":null,\"sequence_number\":1}\n\n";
                let body = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n{:x}\r\n{frame}\r\n",
                    frame.len()
                );
                socket.write_all(body.as_bytes()).await.unwrap();
                socket.flush().await.unwrap();
                // The provider has refused; now it stalls past the idle limit.
                tokio::time::sleep(Duration::from_secs(5)).await;
            });
        }
    });
    let db = Arc::new(Database::new());
    let meter = Arc::new(Metered::new(
        db.clone(),
        adapter_support::backend(&base, adapter_support::tuning(0)),
        adapter_support::claim_key(),
    ));
    let r = support::start(
        &support::config(&[]),
        Deps {
            gate: Arc::new(Gate),
            catalog: Arc::new(Fixed(adapter_support::catalog_with(10_000, Some(200)))),
            backend: meter.clone(),
            settler: meter,
        },
    )
    .await;
    support::wait_readyz(r.admin, StatusCode::OK).await;
    let text = support::text(send(&r).await).await;
    assert!(text.contains("\"code\":\"provider_error\""), "{text}");
    assert!(text.contains("\"settlement\":\"released\""), "{text}");
    assert!(!text.contains("event: meta"), "{text}");
    final_state(&db).await;
    {
        let state = db.0.lock().unwrap();
        assert_eq!(state.charges, 0);
        assert_eq!(state.terminal, Some("released"));
    }
    server.abort();
}
// Generated tool arguments commit the call in every mode: with
// `stream: false` the fragments never reach the wire, but a provider error
// after them is an error AFTER output (the provider bills the arguments),
// settled on the estimate — not a pre-content refusal that releases.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unrelayed_tool_fragments_still_commit_a_nonstreamed_call() {
    let fixture = tool_fixture("openai_strict_forced_streamed.json");
    let chunks = fixture["provider_stream"].as_array().unwrap();
    let mut fragments_then_error: Vec<Value> = chunks
        .iter()
        .take_while(|c| c["choices"][0]["finish_reason"].is_null() && *c != &json!("[DONE]"))
        .cloned()
        .collect();
    fragments_then_error.push(json!({"error": {"message": "The server had an error while processing your request.", "type": "server_error", "param": null, "code": null}}));
    let (base, server) = replay_server(&fragments_then_error).await;
    let (catalog, model) = refusal_catalog("openai_interim");
    let generated = "check_answer{\"question_id\":\"q1\",\"answer\":\"x = 4\"}";
    let raw = f2z_ai::estimate::Encoding::O200kBase.count(generated);
    for stream in [false, true] {
        let db = Arc::new(Database::new());
        let meter = Arc::new(Metered::new(
            db.clone(),
            adapter_support::backend(&base, adapter_support::tuning(0)),
            adapter_support::claim_key(),
        ));
        let r = support::start(
            &support::config(&[]),
            Deps {
                gate: Arc::new(Gate),
                catalog: Arc::new(Fixed(catalog.clone())),
                backend: meter.clone(),
                settler: meter,
            },
        )
        .await;
        support::wait_readyz(r.admin, StatusCode::OK).await;
        let mut request = fixture["request"].clone();
        request["model"] = json!(model);
        request["stream"] = json!(stream);
        let text = support::text(
            support::send(r.public, support::chat_request(request.to_string())).await,
        )
        .await;
        assert!(text.contains("provider_error"), "stream={stream}: {text}");
        assert!(
            text.contains("\"settlement\":\"settled\""),
            "stream={stream}: {text}"
        );
        final_state(&db).await;
        {
            let state = db.0.lock().unwrap();
            assert_eq!(state.charges, 1, "stream={stream}");
            assert_eq!(
                state.settled_usage["output_tokens"],
                raw + raw.div_ceil(10),
                "stream={stream}: {}",
                state.settled_usage
            );
        }
    }
    server.abort();
}
// Negative control for the three above: a request the provider REFUSED (a
// 503 head, no stream) is not billed by it, and the hold is released with
// nothing charged — the estimate applies only to an accepted request.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_request_releases_the_hold_and_charges_nothing() {
    let db = Arc::new(Database::new());
    let (r, mock) = launch(
        db.clone(),
        Scenario::default().with_fault(f2z_ai_testkit::mock::Fault::Status { status: 503 }),
    )
    .await;
    let text = support::text(send(&r).await).await;
    assert!(text.contains("event: error"), "{text}");
    assert!(text.contains("\"settlement\":\"released\""), "{text}");
    assert!(!text.contains("event: usage"), "{text}");
    final_state(&db).await;
    {
        let state = db.0.lock().unwrap();
        assert_eq!(state.charges, 0);
        assert_eq!(state.terminal, Some("released"));
        assert_eq!(state.settle_requests, 0);
    }
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expired_hold_records_late_provider_cost_without_changing_terminal_winner() {
    let db = Arc::new(Database::new());
    db.0.lock().unwrap().expire_at_completion = true;
    let (r, mock) = launch(db.clone(), Scenario::default()).await;
    let text = support::text(send(&r).await).await;
    assert!(text.contains("\"settlement\":\"released\""), "{text}");
    {
        let state = db.0.lock().unwrap();
        assert_eq!(state.charges, 0);
        assert_eq!(state.settle_requests, 1);
        assert_eq!(state.terminal, Some("expired"));
    }
    mock.shutdown().await;
}

fn tool_catalog() -> f2z_ai::catalog::VerifiedCatalog {
    let mut catalog = adapter_support::catalog(10_000).catalog().clone();
    for model in &mut catalog.models {
        model.capabilities.tools = true;
    }
    f2z_ai::catalog::VerifiedCatalog::from_verified(catalog).unwrap()
}
fn tool_request() -> Value {
    let mut request = request();
    request["tools"] = json!([{"name":"lookup","description":"Find a formula","parameters":{"type":"object","properties":{"name":{"type":"string"}}}}]);
    request["messages"] = json!([
        {"role":"user","content":[{"type":"text","text":"Check the formula"}]},
        {"role":"assistant","content":[],"tool_calls":[{"id":"prior","name":"lookup","arguments":"{\"name\":\"area\"}"}]},
        {"role":"tool","tool_call_id":"prior","content":[{"type":"text","text":"area = width * height"}]}
    ]);
    request
}
async fn estimate_input(r: &support::Running, request: &Value) -> u64 {
    let req = axum::http::Request::post("/v1/chat/estimate")
        .header("host", "gateway")
        .header("content-type", "application/json")
        .body(axum::body::Body::from(request.to_string()))
        .unwrap();
    let response = support::send(r.public, req).await;
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_str::<Value>(&support::text(response).await).unwrap()["input_tokens"]
        .as_u64()
        .unwrap()
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn old_catalogues_refuse_tools_before_hold_or_provider_io() {
    let db = Arc::new(Database::new());
    let (r, mock) = launch(db.clone(), Scenario::default()).await;
    let response = support::send(r.public, support::chat_request(tool_request().to_string())).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(support::error_of(response).await["code"], "invalid_request");
    assert!(db.0.lock().unwrap().hold.is_none());
    assert_eq!(mock.recorded_requests().len(), 0);
    mock.shutdown().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn signed_tools_reserve_definitions_relay_calls_and_replay_one_charge() {
    metered_tool_turn(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nonstream_tools_return_typed_calls_and_replay_one_charge() {
    metered_tool_turn(false).await;
}

async fn metered_tool_turn(stream: bool) {
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = requests.clone();
    let app = axum::Router::new().route("/v1/responses", axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
        let captured = captured.clone();
        async move {
            captured.lock().unwrap().push(body);
            let frames = [
                json!({"type":"response.output_item.done","item":{"type":"function_call","call_id":"next","name":"lookup","arguments":"{\"name\":\"volume\"}"}}),
                json!({"type":"response.completed","response":{"usage":{"input_tokens":50,"output_tokens":10},"output":[{"type":"function_call"}]}}),
            ];
            let body = frames.iter().map(|v| format!("event: {}\ndata: {v}\n\n", v["type"].as_str().unwrap())).collect::<String>();
            ([("content-type", "text/event-stream")], body)
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let db = Arc::new(Database::new());
    let meter = Arc::new(Metered::new(
        db.clone(),
        adapter_support::backend(&base, adapter_support::tuning(0)),
        adapter_support::claim_key(),
    ));
    let r = support::start(
        &support::config(&[]),
        Deps {
            gate: Arc::new(Gate),
            catalog: Arc::new(Fixed(tool_catalog())),
            backend: meter.clone(),
            settler: meter,
        },
    )
    .await;
    support::wait_readyz(r.admin, StatusCode::OK).await;
    let mut request = tool_request();
    request["stream"] = json!(stream);
    let small = estimate_input(&r, &request).await;
    request["tools"][0]["description"] = json!("d".repeat(12_000));
    let larger = estimate_input(&r, &request).await;
    assert!(
        larger >= small + 11_000,
        "tool definition omitted from reservation"
    );
    assert!(db.0.lock().unwrap().hold.is_none());
    let models = axum::http::Request::get("/v1/models")
        .header("host", "gateway")
        .body(axum::body::Body::empty())
        .unwrap();
    let models: Value =
        serde_json::from_str(&support::text(support::send(r.public, models).await).await).unwrap();
    assert_eq!(models["models"][0]["capabilities"]["tools"], true);
    for replay in [false, true] {
        let mut req = support::chat_request(request.to_string());
        req.headers_mut()
            .insert("idempotency-key", "tool-turn-1".parse().unwrap());
        let response = support::send(r.public, req).await;
        assert_eq!(response.status(), StatusCode::OK);
        if replay {
            assert_eq!(response.headers()["x-f2z-replayed"], "true");
        }
        let text = support::text(response).await;
        assert!(text.contains("\"charged_2z\":1"), "{text}");
        if !replay && stream {
            assert!(text.contains("event: tool_call"), "{text}");
            assert!(text.contains("\"finish_reason\":\"tool_calls\""), "{text}");
        } else if !replay {
            let reply: f2z_ai_proto::chat::ChatResponse = serde_json::from_str(&text).unwrap();
            reply.check().unwrap();
            assert_eq!(
                reply.finish_reason,
                f2z_ai_proto::chat::FinishReason::ToolCalls
            );
            assert_eq!(reply.message.tool_calls[0].name, "lookup");
            assert_eq!(
                reply.message.tool_calls[0].arguments,
                "{\"name\":\"volume\"}"
            );
            assert_eq!(reply.charged_2z, Some(f2z_ai_proto::Whole2z::new(1)));
        }
    }
    assert_eq!(db.0.lock().unwrap().charges, 1);
    let sent = requests.lock().unwrap();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["tools"][0]["name"], "lookup");
    assert!(
        sent[0]["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["type"] == "function_call_output")
    );
    assert!(
        !sent[0].to_string().contains("essay"),
        "metadata sent to provider"
    );
    drop(sent);
    server.abort();
}

async fn send_nonstream(r: &support::Running) -> axum::http::Response<hyper::body::Incoming> {
    let mut value = request();
    value["stream"] = json!(false);
    let mut req = support::chat_request(value.to_string());
    req.headers_mut()
        .insert("idempotency-key", "lesson-1".parse().unwrap());
    support::send(r.public, req).await
}

fn settled_wire(text: &str, stream: bool) -> Value {
    if stream {
        let data = text
            .split("\n\n")
            .find_map(|frame| frame.strip_prefix("event: done\ndata: "))
            .unwrap_or_else(|| panic!("missing done event: {text}"));
        serde_json::from_str::<Value>(data).unwrap()
    } else {
        serde_json::from_str::<Value>(text).unwrap()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nonstream_uses_confirmed_settlement_and_replays_receipt_json() {
    let db = Arc::new(Database::new());
    db.0.lock().unwrap().lose_settle_reply = true;
    let (r, mock) = launch(db.clone(), Scenario::default()).await;
    let response = send_nonstream(&r).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "application/json");
    assert_eq!(response.headers()["cache-control"], "no-store");
    let call_id = response.headers()["x-f2z-call-id"]
        .to_str()
        .unwrap()
        .to_owned();
    let text = support::text(response).await;
    let reply: f2z_ai_proto::chat::ChatResponse = serde_json::from_str(&text).unwrap();
    reply.check().unwrap();
    assert_eq!(reply.call_id, call_id);
    assert!(!reply.message.text().is_empty());
    assert_eq!(reply.charged_2z, Some(f2z_ai_proto::Whole2z::new(1)));
    assert_eq!(db.0.lock().unwrap().charges, 1);
    let replay = send_nonstream(&r).await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(replay.headers()["x-f2z-replayed"], "true");
    let receipt: Value = serde_json::from_str(&support::text(replay).await).unwrap();
    assert_eq!(receipt["call_id"], call_id);
    assert_eq!(db.0.lock().unwrap().charges, 1);
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settled_chat_responses_include_the_ledger_post_settlement_cap() {
    for (stream, capped) in [(true, true), (true, false), (false, true), (false, false)] {
        let db = Arc::new(Database::new());
        if capped {
            db.0.lock().unwrap().cap_remaining_milli_2z = Some(200_000);
        }
        let (r, mock) = launch(db.clone(), Scenario::default()).await;
        let response = if stream {
            send(&r).await
        } else {
            send_nonstream(&r).await
        };
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "stream={stream}, capped={capped}"
        );
        let text = support::text(response).await;
        let completed = settled_wire(&text, stream);
        assert!(
            completed
                .as_object()
                .unwrap()
                .contains_key("cap_remaining_milli_2z"),
            "settled response omitted cap field: {completed}"
        );
        if capped {
            assert_eq!(completed["cap_remaining_milli_2z"], json!(199_000));
        } else {
            assert_eq!(completed["cap_remaining_milli_2z"], Value::Null);
        }
        {
            let state = db.0.lock().unwrap();
            assert_eq!(state.charges, 1, "stream={stream}, capped={capped}");
            assert_eq!(state.hold_requests, 1, "stream={stream}, capped={capped}");
            assert_eq!(state.settle_requests, 1, "stream={stream}, capped={capped}");
        }
        mock.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ambiguous_settle_replay_resolves_null_cap_from_context_without_rebilling() {
    for (stream, capped) in [(true, true), (false, false)] {
        let db = Arc::new(Database::new());
        {
            let mut state = db.0.lock().unwrap();
            state.lose_settle_reply = true;
            if capped {
                state.cap_remaining_milli_2z = Some(200_000);
            }
        }
        let (r, mock) = launch(db.clone(), Scenario::default()).await;
        let response = if stream {
            send(&r).await
        } else {
            send_nonstream(&r).await
        };
        assert_eq!(response.status(), StatusCode::OK);
        let wire = settled_wire(&support::text(response).await, stream);
        assert_eq!(wire["settlement"], "settled");
        assert!(
            wire.as_object()
                .unwrap()
                .contains_key("cap_remaining_milli_2z")
        );
        assert_eq!(
            wire["cap_remaining_milli_2z"],
            if capped { json!(199_000) } else { Value::Null }
        );
        {
            let state = db.0.lock().unwrap();
            assert_eq!(state.hold_requests, 1);
            assert_eq!(
                state.settle_requests, 2,
                "same idempotent settle is recovered"
            );
            assert_eq!(state.charges, 1, "settle replay must not rebill");
            assert!(state.context_requests > 0, "ambiguous NULL needs context");
        }
        mock.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn already_terminal_completion_recovery_reads_cap_without_resettling() {
    for (stream, capped) in [(true, true), (false, false)] {
        let db = Arc::new(Database::new());
        {
            let mut state = db.0.lock().unwrap();
            state.terminalize_on_first_complete = true;
            if capped {
                state.cap_remaining_milli_2z = Some(200_000);
            }
        }
        let (r, mock) = launch(db.clone(), Scenario::default()).await;
        let response = if stream {
            send(&r).await
        } else {
            send_nonstream(&r).await
        };
        assert_eq!(response.status(), StatusCode::OK);
        let wire = settled_wire(&support::text(response).await, stream);
        assert_eq!(wire["settlement"], "settled");
        assert!(
            wire.as_object()
                .unwrap()
                .contains_key("cap_remaining_milli_2z")
        );
        assert_eq!(
            wire["cap_remaining_milli_2z"],
            if capped { json!(199_000) } else { Value::Null }
        );
        {
            let state = db.0.lock().unwrap();
            assert_eq!(state.hold_requests, 1);
            assert_eq!(
                state.settle_requests, 0,
                "terminal recovery must not resettle"
            );
            assert_eq!(state.charges, 1);
            assert!(
                state.context_requests > 0,
                "terminal call record has no cap"
            );
        }
        mock.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unavailable_or_invalid_cap_metadata_stays_absent_after_completed_billing() {
    for (stream, malformed, unsafe_value) in [
        (true, false, false),
        (false, true, false),
        (true, false, true),
    ] {
        let db = Arc::new(Database::new());
        {
            let mut state = db.0.lock().unwrap();
            state.omit_settle_cap = !malformed && !unsafe_value;
            state.malformed_settle_cap = malformed;
            state.unsafe_settle_cap = unsafe_value;
            state.fail_context_after_settle = true;
            state.cap_remaining_milli_2z = Some(200_000);
        }
        let (r, mock) = launch(db.clone(), Scenario::default()).await;
        let response = if stream {
            send(&r).await
        } else {
            send_nonstream(&r).await
        };
        assert_eq!(response.status(), StatusCode::OK);
        let wire = settled_wire(&support::text(response).await, stream);
        assert_eq!(wire["settlement"], "settled");
        assert_eq!(wire["charged_2z"], json!(1));
        assert!(
            !wire
                .as_object()
                .unwrap()
                .contains_key("cap_remaining_milli_2z")
        );
        {
            let state = db.0.lock().unwrap();
            assert_eq!(state.hold_requests, 1);
            assert_eq!(state.settle_requests, 1);
            assert_eq!(state.charges, 1);
        }
        mock.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nonstream_missing_usage_settles_on_the_estimate_and_returns_the_message() {
    let db = Arc::new(Database::new());
    let (r, mock) = launch(db.clone(), Scenario::default().without_usage()).await;
    let response = send_nonstream(&r).await;
    assert_eq!(response.status(), StatusCode::OK);
    let value: Value = serde_json::from_str(&support::text(response).await).unwrap();
    assert_eq!(value["settlement"], "settled");
    assert_eq!(value["usage_source"], "estimated");
    let content = value["message"]["content"][0]["text"].as_str().unwrap();
    assert!(!content.is_empty());
    final_state(&db).await;
    let (input, output) = expected_estimate(&r, &request(), content).await;
    assert_eq!(value["usage"]["input_tokens"], input);
    assert_eq!(value["usage"]["output_tokens"], output);
    {
        let state = db.0.lock().unwrap();
        assert_eq!(state.charges, 1);
        assert_eq!(state.settled_usage["output_tokens"], output);
    }
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn model_policy_hides_denies_and_terminalizes_without_paid_work() {
    let db = Arc::new(Database::new());
    // Model a slow durable completion: detached settlement cannot make an
    // early HTTP refusal look correct by winning the immediate replay race.
    db.0.lock().unwrap().slow_completion = true;
    let (r, mock) = launch_policy(db.clone(), Scenario::default(), Some(vec![])).await;
    let models = axum::http::Request::get("/v1/models")
        .header("host", "gateway")
        .body(axum::body::Body::empty())
        .unwrap();
    let listed: Value =
        serde_json::from_str(&support::text(support::send(r.public, models).await).await).unwrap();
    assert_eq!(listed["models"], json!([]));
    let estimate = axum::http::Request::post("/v1/chat/estimate")
        .header("host", "gateway")
        .header("content-type", "application/json")
        .body(axum::body::Body::from(request().to_string()))
        .unwrap();
    assert_eq!(
        support::send(r.public, estimate).await.status(),
        StatusCode::FORBIDDEN
    );
    assert!(db.0.lock().unwrap().call.is_none());
    let denied = send(&r).await;
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    assert!(support::text(denied).await.contains("model_disabled"));
    // No sleep/poll: the first refusal must already have made the claim terminal.
    let replay = send(&r).await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(replay.headers()["x-f2z-replayed"], "true");
    let record: Value = serde_json::from_str(&support::text(replay).await).unwrap();
    assert_eq!(record["status"], "released");
    assert_eq!(record["charged_2z"], 0);
    assert_eq!(record["error"]["code"], "model_disabled");
    {
        let state = db.0.lock().unwrap();
        assert!(state.hold.is_none());
        assert_eq!(state.charges, 0);
    }
    assert!(mock.recorded_requests().is_empty());
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disabling_a_model_preserves_completed_same_key_recovery() {
    let db = Arc::new(Database::new());
    let (allowed, first_provider) =
        launch_policy(db.clone(), Scenario::default(), Some(vec!["m-responses"])).await;
    let response = send(&allowed).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(support::text(response).await.contains("event: done"));
    final_state(&db).await;
    let (denied, second_provider) =
        launch_policy(db.clone(), Scenario::default(), Some(vec![])).await;
    let response = send(&denied).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["x-f2z-replayed"], "true");
    let receipt: Value = serde_json::from_str(&support::text(response).await).unwrap();
    assert_eq!(receipt["status"], "settled");
    assert_eq!(receipt["charged_2z"], 1);
    assert_eq!(db.0.lock().unwrap().charges, 1);
    assert_eq!(first_provider.recorded_requests().len(), 1);
    assert!(second_provider.recorded_requests().is_empty());
    first_provider.shutdown().await;
    second_provider.shutdown().await;
}

/// ~100 output tokens per whole 2Z, so a few 2Z of balance clamps a 1800-token
/// request (free2z/zuu#1122).
fn priced_catalog() -> f2z_ai::catalog::VerifiedCatalog {
    let mut catalog = adapter_support::catalog(10_000).catalog().clone();
    for model in &mut catalog.models {
        model.prices.output_nusd_per_mtok = 100_000_000_000;
    }
    f2z_ai::catalog::VerifiedCatalog::from_verified(catalog).unwrap()
}
fn aha_request(strict: bool) -> Value {
    json!({"model":"m-responses","max_output_tokens":1800,"max_output_tokens_strict":strict,
        "messages":[{"role":"user","content":[{"type":"text","text":"teach me fractions"}]}]})
}
fn exact_one_token_hold(request: &Value, catalog: &f2z_ai::catalog::VerifiedCatalog) -> (u64, u64) {
    use f2z_ai_proto::{
        chat::{ChatRequest, Usage},
        pricing::{Bps, apply_safety_factor, metered_cost_nusd, price_nusd},
    };

    let request: ChatRequest = serde_json::from_value(request.clone()).unwrap();
    let model = catalog.catalog().callable_model(&request.model).unwrap();
    let estimate = f2z_ai::estimate::input_tokens(&request, model).unwrap();
    let input = apply_safety_factor(
        estimate.tokens + f2z_ai::provider::reserved_overhead_tokens(&request, model),
        model.safety_factor_bps,
    )
    .unwrap();
    let mut prices = model.prices;
    prices.input_nusd_per_mtok = prices
        .input_nusd_per_mtok
        .max(prices.cached_input_nusd_per_mtok)
        .max(prices.cache_write_nusd_per_mtok);
    let usage = Usage {
        input_tokens: input,
        output_tokens: 1,
        tool_calls: if prices.tool_call_nusd > 0 { 8 } else { 0 },
        ..Usage::default()
    };
    let cost = metered_cost_nusd(&usage, &prices).unwrap();
    let required = price_nusd(
        cost,
        catalog.catalog().platform_margin_bps,
        Bps::ZERO,
        model.min_charge_2z,
    )
    .unwrap()
    .total_2z()
    .get();
    (input, required)
}
async fn post(r: &support::Running, path: &str, body: &Value) -> (StatusCode, Value) {
    let mut req = axum::http::Request::post(path)
        .header("host", "gateway")
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body.to_string()))
        .unwrap();
    req.headers_mut()
        .insert("idempotency-key", "aha-lesson-1".parse().unwrap());
    let response = support::send(r.public, req).await;
    let status = response.status();
    let text = support::text(response).await;
    (
        status,
        serde_json::from_str(&text).unwrap_or(Value::String(text)),
    )
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn strict_output_limit_is_refused_before_any_hold_charge_or_provider_request() {
    let db = Arc::new(Database::new());
    db.0.lock().unwrap().available = 5_000;
    let (r, mock) = launch_catalog(db.clone(), Scenario::default(), None, priced_catalog()).await;

    // The pre-check: the estimate reports the post-clamp limit.
    let (status, estimate) = post(&r, "/v1/chat/estimate", &aha_request(false)).await;
    assert_eq!(status, StatusCode::OK, "{estimate}");
    let effective = estimate["max_output_tokens"].as_u64().unwrap();
    assert!(effective < 1800, "{estimate}");
    // A strict estimate answers with the refusal the call would get.
    let (status, refused) = post(&r, "/v1/chat/estimate", &aha_request(true)).await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED, "{refused}");
    assert_eq!(refused["error"]["code"], "insufficient_balance");
    assert_eq!(
        refused["error"]["details"]["reason"],
        "max_output_tokens_strict"
    );
    assert!(
        db.0.lock().unwrap().call.is_none(),
        "an estimate creates no call"
    );

    let (status, refused) = post(&r, "/v1/chat", &aha_request(true)).await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED, "{refused}");
    assert_eq!(refused["error"]["code"], "insufficient_balance");
    assert_eq!(refused["error"]["details"]["max_output_tokens"], 1800);
    assert!(refused["error"]["details"]["required_2z"].as_u64().unwrap() > 5);
    final_state(&db).await;
    {
        let state = db.0.lock().unwrap();
        assert!(state.hold.is_none(), "no hold was taken");
        assert_eq!(state.charges, 0);
        assert_eq!(state.terminal, Some("released"));
    }
    assert_eq!(mock.request_count(), 0, "the provider was never called");

    // AHA's recover(): after a top-up, the same key is replayed. It must name
    // the original strict refusal — not an abandoned-claim `unavailable` — and
    // must not run the call now that it would be affordable.
    db.0.lock().unwrap().available = 1_000_000;
    let (status, record) = post(&r, "/v1/chat", &aha_request(true)).await;
    assert_eq!(status, StatusCode::OK, "{record}");
    assert_eq!(record["replayed"], true, "{record}");
    assert_eq!(record["status"], "released");
    assert_eq!(record["charged_2z"], 0);
    assert_eq!(record["error"]["code"], "insufficient_balance", "{record}");
    assert!(
        record["error"]["message"]
            .as_str()
            .unwrap()
            .contains("max_output_tokens_strict"),
        "{record}"
    );
    assert_eq!(db.0.lock().unwrap().charges, 0);
    assert_eq!(mock.request_count(), 0);
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn non_strict_estimate_refusals_report_exact_minimum_and_do_not_reserve_or_start_provider() {
    let catalog = priced_catalog();
    let request = aha_request(false);
    let (input, required) = exact_one_token_hold(&request, &catalog);
    assert!(required > 0);
    let required_milli = required * 1_000;

    for (available, cap, expected_code, expected_status) in [
        (
            required_milli - 1,
            None,
            "insufficient_balance",
            StatusCode::PAYMENT_REQUIRED,
        ),
        (
            0,
            None,
            "insufficient_balance",
            StatusCode::PAYMENT_REQUIRED,
        ),
        (
            required_milli + 10_000,
            Some(required_milli - 1),
            "cap_exceeded",
            StatusCode::FORBIDDEN,
        ),
    ] {
        let db = Arc::new(Database::new());
        {
            let mut state = db.0.lock().unwrap();
            state.available = available;
            state.cap_remaining_milli_2z = cap;
        }
        let (r, mock) =
            launch_catalog(db.clone(), Scenario::default(), None, catalog.clone()).await;

        let (status, refusal) = post(&r, "/v1/chat/estimate", &request).await;
        assert_eq!(status, expected_status, "{refusal}");
        let details = &refusal["error"]["details"];
        assert_eq!(refusal["error"]["code"], expected_code, "{refusal}");
        for key in [
            "input_tokens_estimate",
            "required_2z",
            "available_milli_2z",
            "min_charge_2z",
            "cap_remaining_milli_2z",
        ] {
            assert!(
                details
                    .as_object()
                    .is_some_and(|details| details.contains_key(key)),
                "estimate refusal omitted details.{key}: {refusal}"
            );
        }
        assert_eq!(details["input_tokens_estimate"], input, "{refusal}");
        assert_eq!(details["required_2z"], required, "{refusal}");
        assert_eq!(details["available_milli_2z"], available, "{refusal}");
        assert_eq!(details["min_charge_2z"], 1, "{refusal}");
        assert_eq!(
            details["cap_remaining_milli_2z"],
            cap.map_or(Value::Null, |amount| json!(amount)),
            "{refusal}"
        );
        assert!(
            db.0.lock().unwrap().call.is_none(),
            "estimate claimed a call"
        );
        assert!(db.0.lock().unwrap().hold.is_none());
        assert_eq!(mock.request_count(), 0);

        let (status, refusal) = post(&r, "/v1/chat", &request).await;
        assert_eq!(status, expected_status, "{refusal}");
        let details = &refusal["error"]["details"];
        assert_eq!(refusal["error"]["code"], expected_code, "{refusal}");
        for key in [
            "input_tokens_estimate",
            "required_2z",
            "available_milli_2z",
            "min_charge_2z",
            "cap_remaining_milli_2z",
        ] {
            assert!(
                details
                    .as_object()
                    .is_some_and(|details| details.contains_key(key)),
                "chat refusal omitted details.{key}: {refusal}"
            );
        }
        assert_eq!(details["input_tokens_estimate"], input, "{refusal}");
        assert_eq!(details["required_2z"], required, "{refusal}");
        assert_eq!(details["available_milli_2z"], available, "{refusal}");
        assert_eq!(details["min_charge_2z"], 1, "{refusal}");
        assert_eq!(
            details["cap_remaining_milli_2z"],
            cap.map_or(Value::Null, |amount| json!(amount)),
            "{refusal}"
        );
        final_state(&db).await;
        {
            let state = db.0.lock().unwrap();
            assert!(state.hold.is_none(), "chat refusal reserved a hold");
            assert_eq!(state.charges, 0);
            assert_eq!(state.terminal, Some("released"));
            assert_eq!(state.claims, 1);
        }
        assert_eq!(mock.request_count(), 0, "chat refusal started the provider");
        mock.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn strict_cap_refusal_pins_supported_details_and_has_no_paid_work() {
    let db = Arc::new(Database::new());
    {
        let mut state = db.0.lock().unwrap();
        state.available = 10_000_000;
        state.cap_remaining_milli_2z = Some(5_000);
    }
    let (r, mock) = launch_catalog(db.clone(), Scenario::default(), None, priced_catalog()).await;

    // The estimate and real call use the same ledger snapshot. Pin the
    // request-specific required amount without duplicating the pricing math.
    let (status, estimate) = post(&r, "/v1/chat/estimate", &aha_request(true)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{estimate}");
    let expected_required = estimate["error"]["details"]["required_2z"]
        .as_u64()
        .unwrap();

    let (status, refused) = post(&r, "/v1/chat", &aha_request(true)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(refused["error"]["code"], "cap_exceeded");
    let details = refused["error"]["details"].as_object().unwrap();
    let keys: std::collections::BTreeSet<_> = details.keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "available_milli_2z",
            "cap_remaining_milli_2z",
            "max_output_tokens",
            "min_charge_2z",
            "reason",
            "required_2z",
        ]
        .into_iter()
        .collect()
    );
    assert_eq!(details["reason"], "max_output_tokens_strict");
    assert_eq!(details["max_output_tokens"], 1800);
    assert_eq!(details["required_2z"], expected_required);
    assert_eq!(details["available_milli_2z"], 10_000_000);
    assert_eq!(details["min_charge_2z"], 1);
    assert_eq!(details["cap_remaining_milli_2z"], 5_000);
    for unsupported in ["cap_2z", "cap_period", "resets_at"] {
        assert!(
            !details.contains_key(unsupported),
            "the ledger context has no {unsupported} metadata: {details:?}"
        );
    }

    final_state(&db).await;
    {
        let state = db.0.lock().unwrap();
        assert!(state.hold.is_none(), "no hold was taken");
        assert_eq!(state.charges, 0);
        assert_eq!(state.terminal, Some("released"));
    }
    assert_eq!(mock.request_count(), 0, "the provider was never called");
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_strict_the_same_request_is_clamped_held_and_charged() {
    // Negative control for the test above: identical balance and request,
    // flag off — the #1122 behaviour, which stays the default.
    let db = Arc::new(Database::new());
    db.0.lock().unwrap().available = 5_000;
    let (r, mock) = launch_catalog(db.clone(), Scenario::default(), None, priced_catalog()).await;
    let (status, body) = post(&r, "/v1/chat", &aha_request(false)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let text = body.as_str().unwrap().to_owned();
    let meta = text
        .lines()
        .skip_while(|l| *l != "event: meta")
        .nth(1)
        .and_then(|l| l.strip_prefix("data: "))
        .unwrap();
    let meta: Value = serde_json::from_str(meta).unwrap();
    assert!(meta["max_output_tokens"].as_u64().unwrap() < 1800, "{meta}");
    final_state(&db).await;
    assert!(db.0.lock().unwrap().hold.is_some());
    assert_eq!(db.0.lock().unwrap().charges, 1);
    assert_eq!(mock.request_count(), 1);
    mock.shutdown().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn strict_output_limit_that_fits_runs_at_the_full_limit() {
    let db = Arc::new(Database::new());
    db.0.lock().unwrap().available = 1_000_000;
    let (r, mock) = launch_catalog(db.clone(), Scenario::default(), None, priced_catalog()).await;
    let (status, body) = post(&r, "/v1/chat", &aha_request(true)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(
        body.as_str()
            .unwrap()
            .contains("\"max_output_tokens\":1800"),
        "{body}"
    );
    final_state(&db).await;
    assert_eq!(db.0.lock().unwrap().charges, 1);
    mock.shutdown().await;
}

// Structured output through the whole metered path: admitted for an OpenAI
// Chat Completions model with no catalogue declaration (gpt-4o tonight),
// passed to the provider, charged as any call; refused before hold and
// provider I/O where it cannot be honoured.
fn structured_catalog() -> f2z_ai::catalog::VerifiedCatalog {
    let mut catalog = adapter_support::catalog(10_000).catalog().clone();
    for model in &mut catalog.models {
        if model.id == "m-chat" {
            model.provider = "openai".into();
        }
    }
    f2z_ai::catalog::VerifiedCatalog::from_verified(catalog).unwrap()
}
fn structured_request(model: &str) -> Value {
    let mut request = request();
    request["model"] = json!(model);
    request["stream"] = json!(false);
    request["response_format"] = json!({"type":"json_schema","json_schema":{
        "name":"activity_spec","strict":true,
        "schema":{"type":"object","additionalProperties":false,
                  "properties":{"title":{"type":"string"}},"required":["title"]}}});
    request
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn structured_output_is_relayed_and_charged_like_any_call() {
    let db = Arc::new(Database::new());
    let (r, mock) =
        launch_catalog(db.clone(), Scenario::default(), None, structured_catalog()).await;
    let models = axum::http::Request::get("/v1/models")
        .header("host", "gateway")
        .body(axum::body::Body::empty())
        .unwrap();
    let models: Value =
        serde_json::from_str(&support::text(support::send(r.public, models).await).await).unwrap();
    for model in models["models"].as_array().unwrap() {
        assert_eq!(
            model["capabilities"]["structured_output"],
            model["id"] == "m-chat",
            "{model}"
        );
    }
    let request = structured_request("m-chat");
    let response = support::send(r.public, support::chat_request(request.to_string())).await;
    assert_eq!(response.status(), StatusCode::OK);
    let reply: f2z_ai_proto::chat::ChatResponse =
        serde_json::from_str(&support::text(response).await).unwrap();
    reply.check().unwrap();
    assert_eq!(reply.charged_2z, Some(f2z_ai_proto::Whole2z::new(1)));
    assert_eq!(db.0.lock().unwrap().charges, 1);
    let sent = mock.recorded_requests();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].body["response_format"], request["response_format"]);
    assert!(
        !sent[0].body.to_string().contains("essay"),
        "metadata sent to provider"
    );
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsupported_structured_output_is_refused_before_hold_or_provider_io() {
    let db = Arc::new(Database::new());
    let (r, mock) =
        launch_catalog(db.clone(), Scenario::default(), None, structured_catalog()).await;
    let response = support::send(
        r.public,
        support::chat_request(structured_request("m-responses").to_string()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let error = support::error_of(response).await;
    assert_eq!(error["code"], "invalid_request");
    assert_eq!(error["details"]["reason"], "response_format_unsupported");
    assert_eq!(error["details"]["field"], "response_format");
    assert!(db.0.lock().unwrap().hold.is_none());
    assert_eq!(mock.recorded_requests().len(), 0);
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unsupported_structured_output_refusal_is_what_its_key_replays() {
    let db = Arc::new(Database::new());
    let (r, mock) =
        launch_catalog(db.clone(), Scenario::default(), None, structured_catalog()).await;
    let request = structured_request("m-responses");
    let (status, refused) = post(&r, "/v1/chat", &request).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    assert_eq!(
        refused["error"]["details"]["reason"],
        "response_format_unsupported"
    );
    final_state(&db).await;
    assert_eq!(db.0.lock().unwrap().terminal, Some("released"));
    // The same key answers with the original refusal, never `unavailable`.
    let (status, record) = post(&r, "/v1/chat", &request).await;
    assert_eq!(status, StatusCode::OK, "{record}");
    assert_eq!(record["replayed"], true, "{record}");
    assert_eq!(record["charged_2z"], 0);
    assert_eq!(record["error"]["code"], "invalid_request", "{record}");
    assert!(
        record["error"]["message"]
            .as_str()
            .unwrap()
            .contains("response_format"),
        "{record}"
    );
    assert!(db.0.lock().unwrap().hold.is_none());
    assert_eq!(mock.request_count(), 0);
    mock.shutdown().await;
}

// response_format forwarding, end to end (P0 investigation, 2026-10-05): a
// third-party app reported gpt-4o output that broke its strict json_schema.
// These pin, through the real HTTP server, the metering layer, the real
// Chat Completions adapter and the mock provider, that the upstream body
// carries exactly the client's `response_format` — streaming, nonstreaming
// and after an estimate — never one with a member missing, a value changed
// or an array reordered; that a request without one sends none; and that a
// model which cannot honour it is refused before any provider request
// rather than called without it.

/// A schema with everything a strict OpenAI schema uses: nested objects,
/// `required` at every level, `additionalProperties: false`, a number with a
/// fractional bound, a boolean, an array of objects, and an `enum`. The
/// `required` lists and the `enum` are deliberately NOT in alphabetical
/// order, and neither are the property names, so a canonicalizer that sorted
/// arrays — or lost a member while re-ordering objects — shows up here.
fn activity_spec_format() -> Value {
    json!({"type": "json_schema", "json_schema": {
        "name": "activity_spec",
        "strict": true,
        "schema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "title": {"type": "string", "description": "short title"},
                "difficulty": {"type": "number", "minimum": 0.5, "maximum": 9.75},
                "graded": {"type": "boolean"},
                "kind": {"type": "string", "enum": ["quiz", "essay", "drill", "lab"]},
                "settings": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "time_limit_s": {"type": "integer"},
                        "shuffle": {"type": "boolean"}
                    },
                    "required": ["time_limit_s", "shuffle"]
                },
                "steps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                            "prompt": {"type": "string"},
                            "points": {"type": "number"},
                            "optional": {"type": "boolean"}
                        },
                        "required": ["prompt", "points", "optional"]
                    }
                }
            },
            "required": ["title", "difficulty", "graded", "kind", "settings", "steps"]
        }
    }})
}

fn chat_with_format(model: &str, stream: bool, format: Option<Value>) -> Value {
    let mut request = request();
    request["model"] = json!(model);
    request["stream"] = json!(stream);
    if let Some(format) = format {
        request["response_format"] = format;
    }
    request
}

/// Assert the one recorded upstream request carries `sent` unchanged, and
/// print it so the evidence is readable in `--nocapture` output.
fn assert_forwarded_unchanged(mock: &MockProvider, sent: &Value, label: &str) {
    let recorded = mock.recorded_requests();
    assert_eq!(recorded.len(), 1, "{label}: exactly one provider request");
    let body = &recorded[0].body;
    assert_eq!(
        recorded[0].style,
        f2z_ai_testkit::mock::ProviderStyle::ChatCompletions,
        "{label}"
    );
    assert_eq!(body["stream"], true, "{label}: upstream is always streamed");
    let upstream = &body["response_format"];
    println!(
        "[{label}] upstream response_format = {}",
        serde_json::to_string_pretty(upstream).unwrap()
    );
    // Deep equality as values: object member order may differ (documented
    // on `JsonSchemaFormat::schema`), but `Value` array equality is ordered,
    // so every `required` and `enum` must also keep its order.
    assert_eq!(upstream, sent, "{label}: response_format altered upstream");
    assert_eq!(upstream["type"], "json_schema", "{label}");
    assert_eq!(upstream["json_schema"]["name"], "activity_spec", "{label}");
    assert_eq!(upstream["json_schema"]["strict"], json!(true), "{label}");
    let schema = &upstream["json_schema"]["schema"];
    assert_eq!(schema["additionalProperties"], json!(false), "{label}");
    assert_eq!(
        schema["required"],
        json!(["title", "difficulty", "graded", "kind", "settings", "steps"]),
        "{label}: top-level required order"
    );
    assert_eq!(
        schema["properties"]["kind"]["enum"],
        json!(["quiz", "essay", "drill", "lab"]),
        "{label}: enum order"
    );
    assert_eq!(
        schema["properties"]["settings"]["required"],
        json!(["time_limit_s", "shuffle"]),
        "{label}: nested required order"
    );
    assert_eq!(
        schema["properties"]["steps"]["items"]["required"],
        json!(["prompt", "points", "optional"]),
        "{label}: array-item required order"
    );
    assert_eq!(
        schema["properties"]["steps"]["items"]["additionalProperties"],
        json!(false),
        "{label}"
    );
    assert_eq!(
        schema["properties"]["difficulty"]["minimum"],
        json!(0.5),
        "{label}: fractional bound survives"
    );
    // Nothing the client did not send rides along inside the format.
    assert_eq!(
        upstream.as_object().unwrap().len(),
        2,
        "{label}: response_format members"
    );
    assert_eq!(
        upstream["json_schema"].as_object().unwrap().len(),
        3,
        "{label}: json_schema members"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn strict_json_schema_reaches_the_provider_unchanged_streaming_and_not() {
    for stream in [true, false] {
        let label = if stream { "stream" } else { "nonstream" };
        let db = Arc::new(Database::new());
        let (r, mock) =
            launch_catalog(db.clone(), Scenario::default(), None, structured_catalog()).await;
        let request = chat_with_format("m-chat", stream, Some(activity_spec_format()));
        let (status, reply) = post(&r, "/v1/chat", &request).await;
        assert_eq!(status, StatusCode::OK, "{label}: {reply}");
        if stream {
            let sse = reply.as_str().unwrap();
            assert!(sse.contains("event: delta"), "{sse}");
            assert!(!sse.contains("event: error"), "{sse}");
        } else {
            assert!(reply["message"].is_object(), "{reply}");
        }
        assert_forwarded_unchanged(&mock, &request["response_format"], label);
        mock.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_estimate_then_chat_hand_off_forwards_the_same_response_format() {
    for stream in [true, false] {
        let label = if stream {
            "estimate->stream"
        } else {
            "estimate->nonstream"
        };
        let db = Arc::new(Database::new());
        let (r, mock) =
            launch_catalog(db.clone(), Scenario::default(), None, structured_catalog()).await;
        let request = chat_with_format("m-chat", stream, Some(activity_spec_format()));
        let (status, estimate) = post(&r, "/v1/chat/estimate", &request).await;
        assert_eq!(status, StatusCode::OK, "{label}: {estimate}");
        assert!(estimate["hold_2z"].as_u64().unwrap() >= 1, "{estimate}");
        assert_eq!(mock.request_count(), 0, "an estimate calls no provider");
        assert!(
            db.0.lock().unwrap().call.is_none(),
            "an estimate is no call"
        );
        let (status, reply) = post(&r, "/v1/chat", &request).await;
        assert_eq!(status, StatusCode::OK, "{label}: {reply}");
        assert_forwarded_unchanged(&mock, &request["response_format"], label);
        mock.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn json_object_reaches_the_provider_unchanged() {
    let db = Arc::new(Database::new());
    let (r, mock) =
        launch_catalog(db.clone(), Scenario::default(), None, structured_catalog()).await;
    let request = chat_with_format("m-chat", true, Some(json!({"type": "json_object"})));
    let (status, reply) = post(&r, "/v1/chat", &request).await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    let recorded = mock.recorded_requests();
    assert_eq!(recorded.len(), 1);
    assert_eq!(
        recorded[0].body["response_format"],
        json!({"type": "json_object"})
    );
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_request_without_response_format_sends_none_upstream() {
    for stream in [true, false] {
        let db = Arc::new(Database::new());
        let (r, mock) =
            launch_catalog(db.clone(), Scenario::default(), None, structured_catalog()).await;
        let request = chat_with_format("m-chat", stream, None);
        let (status, reply) = post(&r, "/v1/chat", &request).await;
        assert_eq!(status, StatusCode::OK, "{reply}");
        let recorded = mock.recorded_requests();
        assert_eq!(recorded.len(), 1);
        assert!(
            recorded[0].body.get("response_format").is_none(),
            "stream={stream}: {}",
            recorded[0].body
        );
        mock.shutdown().await;
    }
}

/// The silent-fallback hypothesis: every way a model can lack structured
/// output — a Chat Completions model whose catalogue row declares nothing
/// and whose provider is not `openai`, an OpenAI model that declares
/// `structured_output: false`, and the two adapters with no translation —
/// is refused with `response_format_unsupported` on `/v1/chat` (streaming
/// and not) and on `/v1/chat/estimate`, before any hold and before any
/// provider request.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_model_without_structured_output_is_refused_before_any_provider_request() {
    let undeclared_compatible = adapter_support::catalog(10_000); // m-chat: provider "chatco"
    let mut declared_false = structured_catalog().catalog().clone();
    for model in &mut declared_false.models {
        if model.id == "m-chat" {
            model.capabilities.structured_output = Some(false);
        }
    }
    let declared_false = f2z_ai::catalog::VerifiedCatalog::from_verified(declared_false).unwrap();
    let cases = [
        (
            "m-chat (chatco, undeclared)",
            "m-chat",
            undeclared_compatible.clone(),
        ),
        ("m-chat (openai, declared false)", "m-chat", declared_false),
        (
            "m-responses (openai responses)",
            "m-responses",
            structured_catalog(),
        ),
        ("m-anthropic", "m-anthropic", undeclared_compatible),
    ];
    for (label, model, catalog) in cases {
        for (path, stream) in [
            ("/v1/chat/estimate", true),
            ("/v1/chat", true),
            ("/v1/chat", false),
        ] {
            let db = Arc::new(Database::new());
            let (r, mock) =
                launch_catalog(db.clone(), Scenario::default(), None, catalog.clone()).await;
            let request = chat_with_format(model, stream, Some(activity_spec_format()));
            let (status, refused) = post(&r, path, &request).await;
            let at = format!("{label} {path} stream={stream}");
            assert_eq!(status, StatusCode::BAD_REQUEST, "{at}: {refused}");
            assert_eq!(
                refused["error"]["code"], "invalid_request",
                "{at}: {refused}"
            );
            assert_eq!(
                refused["error"]["details"]["reason"], "response_format_unsupported",
                "{at}: {refused}"
            );
            assert_eq!(
                refused["error"]["details"]["field"], "response_format",
                "{at}"
            );
            assert!(db.0.lock().unwrap().hold.is_none(), "{at}: no hold");
            assert_eq!(db.0.lock().unwrap().charges, 0, "{at}: no charge");
            assert_eq!(mock.request_count(), 0, "{at}: no provider request");
            mock.shutdown().await;
        }
    }
}

// The 2026-10-05 incident: "did the client send response_format?" had no
// durable answer. With `ledger_features_meta` on, the claim stores a
// content-free `features` object and `GET /v1/calls/{id}` returns it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn features_are_recorded_on_the_claim_and_the_receipt_when_enabled() {
    let db = Arc::new(Database::new());
    let (r, mock) = launch_meta(
        db.clone(),
        Scenario::default(),
        None,
        structured_catalog(),
        true,
    )
    .await;
    let request = structured_request("m-chat");
    let response = support::send(r.public, support::chat_request(request.to_string())).await;
    assert_eq!(response.status(), StatusCode::OK);
    let id = response.headers()["x-f2z-call-id"]
        .to_str()
        .unwrap()
        .to_owned();
    let _ = support::text(response).await;
    final_state(&db).await;
    let schema_bytes = serde_json::to_vec(&request["response_format"]["json_schema"]["schema"])
        .unwrap()
        .len();
    // The schema name is caller-chosen text: never recorded (zuu#1225).
    let expected = json!({"response_format":"json_schema","response_format_strict":true,
        "response_format_schema_name":null,"response_format_schema_bytes":schema_bytes,
        "tools":0,"max_output_tokens_strict":false,"stream":false,"fallback":0});
    let claimed = db.0.lock().unwrap().request.clone();
    assert_eq!(claimed["features"], expected);
    // Content-free: neither the schema's members nor the prompt.
    assert!(!claimed.to_string().contains("additionalProperties"));
    assert!(!claimed.to_string().contains("hello tutor"));
    let read = axum::http::Request::get(format!("/v1/calls/{id}"))
        .header("host", "gateway")
        .body(axum::body::Body::empty())
        .unwrap();
    let record: Value =
        serde_json::from_str(&support::text(support::send(r.public, read).await).await).unwrap();
    assert_eq!(record["features"], expected, "{record}");
    mock.shutdown().await;
}

// zuu#1225: the baseline is the same for every app, whatever its
// audience: the call record keeps no caller-chosen text. `metadata` is
// refused before any paid work, an unknown model id before the claim would
// record it, the schema name is not recorded, and the `Idempotency-Key` and
// fingerprint are stored only as keyed HMACs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_apps_call_record_keeps_caller_chosen_text() {
    for child in [false, true] {
        call_record_keeps_no_caller_chosen_text(child).await;
    }
}

async fn call_record_keeps_no_caller_chosen_text(child: bool) {
    let db = Arc::new(Database::new());
    let (r, mock) = launch_meta(
        db.clone(),
        Scenario::default(),
        None,
        structured_catalog(),
        true,
    )
    .await;
    let as_app = |body: &Value| {
        let mut req = support::chat_request(body.to_string());
        if child {
            req.headers_mut()
                .insert("test-child-directed", "1".parse().unwrap());
        }
        req
    };

    let mut with_metadata = structured_request("m-chat");
    with_metadata["metadata"] = json!({"lesson": "alice-smith-fractions"});
    for route in ["/v1/chat", "/v1/chat/estimate"] {
        let mut req = as_app(&with_metadata);
        *req.uri_mut() = route.parse().unwrap();
        let refused = support::send(r.public, req).await;
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST, "{route}");
        let body = support::text(refused).await;
        assert!(body.contains("\"metadata\""), "{body}");
        assert!(body.contains("privacy_baseline"), "{body}");
    }
    assert!(db.0.lock().unwrap().hold.is_none(), "no hold");
    assert_eq!(db.0.lock().unwrap().request, Value::Null, "nothing claimed");
    assert_eq!(mock.request_count(), 0, "no provider request");

    // A model id is caller-chosen text too, fallbacks included.
    let unknown = structured_request("Alice_Smith_age_8");
    let mut fallback = structured_request("m-chat");
    fallback["fallback"] = json!(["Alice_Smith_age_8"]);
    for body in [unknown, fallback] {
        let refused = support::send(r.public, as_app(&body)).await;
        assert_eq!(refused.status(), StatusCode::NOT_FOUND, "{body}");
        let _ = support::text(refused).await;
    }
    assert_eq!(db.0.lock().unwrap().request, Value::Null, "nothing claimed");
    assert_eq!(mock.request_count(), 0, "no provider request");

    let request = structured_request("m-chat");
    let keyed = || {
        let mut req = as_app(&request);
        req.headers_mut()
            .insert("idempotency-key", "lesson-for-alice-smith".parse().unwrap());
        req
    };
    let response = support::send(r.public, keyed()).await;
    assert_eq!(response.status(), StatusCode::OK);
    let _ = support::text(response).await;
    final_state(&db).await;
    let claimed = db.0.lock().unwrap().request.clone();
    assert_eq!(claimed["metadata"], json!({}), "{claimed}");
    assert_eq!(claimed["features"]["response_format"], "json_schema");
    assert_eq!(
        claimed["features"]["response_format_schema_name"],
        Value::Null
    );
    assert!(!claimed.to_string().contains("activity_spec"), "{claimed}");
    assert!(!claimed.to_string().contains("hello tutor"), "{claimed}");
    {
        let state = db.0.lock().unwrap();
        let key = state.key.clone().unwrap();
        assert_eq!(key.len(), 64, "{key}");
        assert!(key.bytes().all(|b| b.is_ascii_hexdigit()), "{key}");
        assert!(!key.contains("alice"), "{key}");
        let unkeyed: String = ring::digest::digest(
            &ring::digest::SHA256,
            &serde_json::to_vec(
                &serde_json::from_value::<f2z_ai_proto::chat::ChatRequest>(request.clone())
                    .unwrap(),
            )
            .unwrap(),
        )
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
        assert_eq!(state.fingerprint.len(), 64);
        assert_ne!(state.fingerprint, unkeyed, "not the unkeyed SHA-256");
    }
    // The receipt shows the same: no caller text to read back.
    let call = db.0.lock().unwrap().call.unwrap();
    let mut read = axum::http::Request::get(format!("/v1/calls/{call}"))
        .header("host", "gateway")
        .body(axum::body::Body::empty())
        .unwrap();
    if child {
        read.headers_mut()
            .insert("test-child-directed", "1".parse().unwrap());
    }
    let receipt = support::text(support::send(r.public, read).await).await;
    assert!(receipt.contains("\"metadata\":{}"), "{receipt}");
    assert!(!receipt.contains("activity_spec"), "{receipt}");
    let replay = support::send(r.public, keyed()).await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(replay.headers()["x-f2z-replayed"], "true");
    let _ = support::text(replay).await;
    assert_eq!(db.0.lock().unwrap().charges, 1, "one charge");
    mock.shutdown().await;
}

// zuu#1225: discovery no longer depends on the audience — a child-directed
// and an ordinary app see the same models, under the same ETag.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_app_is_shown_the_same_models() {
    let db = Arc::new(Database::new());
    let (r, mock) = launch_catalog(db, Scenario::default(), None, structured_catalog()).await;
    let list = |child: bool| {
        let mut req = axum::http::Request::get("/v1/models").header("host", "gateway");
        if child {
            req = req.header("test-child-directed", "1");
        }
        req.body(axum::body::Body::empty()).unwrap()
    };
    let ordinary = support::send(r.public, list(false)).await;
    let ordinary_etag = ordinary.headers()["etag"].clone();
    let ordinary = support::text(ordinary).await;
    let child = support::send(r.public, list(true)).await;
    assert_eq!(child.headers()["etag"], ordinary_etag);
    assert_eq!(support::text(child).await, ordinary);
    mock.shutdown().await;
}

// Off (the default), nothing new reaches the ledger: a ledger without
// `ledger.0006_call_features`, which refuses any unknown claim key, still
// admits and charges the call. This is the deploy-in-either-order guarantee.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn by_default_an_old_ledger_never_sees_features_and_the_call_succeeds() {
    let db = Arc::new(Database::new());
    db.0.lock().unwrap().old_ledger = true;
    let (r, mock) =
        launch_catalog(db.clone(), Scenario::default(), None, structured_catalog()).await;
    let response = support::send(
        r.public,
        support::chat_request(structured_request("m-chat").to_string()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let _ = support::text(response).await;
    final_state(&db).await;
    {
        let state = db.0.lock().unwrap();
        assert!(state.request.get("features").is_none(), "{}", state.request);
        assert_eq!(state.charges, 1);
    }
    mock.shutdown().await;
}

// Negative control for the flag: enabled against that old ledger, every claim
// is refused before any hold or provider request — which is exactly why the
// flag is flipped only after the migration is live.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enabled_against_an_old_ledger_the_claim_is_refused_before_any_paid_work() {
    let db = Arc::new(Database::new());
    db.0.lock().unwrap().old_ledger = true;
    let (r, mock) = launch_meta(
        db.clone(),
        Scenario::default(),
        None,
        structured_catalog(),
        true,
    )
    .await;
    let response = support::send(
        r.public,
        support::chat_request(structured_request("m-chat").to_string()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    {
        let state = db.0.lock().unwrap();
        assert!(state.claims >= 1 && state.hold.is_none() && state.charges == 0);
    }
    assert_eq!(mock.recorded_requests().len(), 0);
    mock.shutdown().await;
}

// zuu#1128: tool calling through the whole metered path.
fn tool_fixture(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/tool_calling")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The catalogue a `refusals.json` case names, and the model id to call.
fn refusal_catalog(case: &str) -> (f2z_ai::catalog::VerifiedCatalog, &'static str) {
    let mut catalog = tool_catalog().catalog().clone();
    let id = match case {
        "xai" => "m-xai",
        "responses" => "m-responses",
        "no_tools" => {
            catalog = adapter_support::catalog(10_000).catalog().clone();
            "m-chat"
        }
        "openai_strict_off" | "openai_interim" => {
            for model in &mut catalog.models {
                if model.id == "m-chat" {
                    model.provider = "openai".into();
                    model.capabilities.strict_tools =
                        (case == "openai_strict_off").then_some(false);
                }
            }
            "m-chat"
        }
        other => panic!("no catalogue for {other}"),
    };
    (
        f2z_ai::catalog::VerifiedCatalog::from_verified(catalog).unwrap(),
        id,
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsupported_tool_features_are_refused_before_hold_and_replay_as_terminal() {
    let refusals = tool_fixture("refusals.json");
    for case in refusals["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let (catalog, model) = refusal_catalog(case["model"].as_str().unwrap());
        let db = Arc::new(Database::new());
        let (r, mock) = launch_catalog(db.clone(), Scenario::default(), None, catalog).await;
        let mut request = case["request"].clone();
        request["model"] = json!(model);
        let (status, refused) = post(&r, "/v1/chat", &request).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{name}: {refused}");
        assert_eq!(refused["error"]["code"], "invalid_request", "{name}");
        assert_eq!(
            refused["error"]["details"]["reason"], "tools_unsupported",
            "{name}: {refused}"
        );
        assert_eq!(
            refused["error"]["details"]["field"], case["field"],
            "{name}"
        );
        assert!(db.0.lock().unwrap().hold.is_none(), "{name}: held");
        assert_eq!(mock.request_count(), 0, "{name}: reached the provider");
        // The estimate refuses identically, and holds nothing either.
        let (status, estimate) = post(&r, "/v1/chat/estimate", &request).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{name}: {estimate}");
        // The same key answers with the refusal, never `unavailable`.
        final_state(&db).await;
        let (status, record) = post(&r, "/v1/chat", &request).await;
        assert_eq!(status, StatusCode::OK, "{name}: {record}");
        assert_eq!(record["replayed"], true, "{name}");
        assert_eq!(record["charged_2z"], 0, "{name}");
        assert_eq!(
            record["error"]["code"], "invalid_request",
            "{name}: {record}"
        );
        assert_eq!(mock.request_count(), 0, "{name}");
        mock.shutdown().await;
    }
}

/// Negative control for the strict refusal: the same OpenAI model with the
/// catalogue silent (the interim rule), or the same request without
/// `strict`, is held, sent with the tool, and charged.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn strict_tools_pass_where_the_catalogue_allows_them() {
    let refusals = tool_fixture("refusals.json");
    let strict = refusals["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "openai_strict_declared_false")
        .unwrap()
        .clone();
    let mut relaxed = strict["request"].clone();
    relaxed["tools"][0]
        .as_object_mut()
        .unwrap()
        .remove("strict");
    for (catalog, request, sent_strict) in [
        ("openai_interim", strict["request"].clone(), true),
        ("openai_strict_off", relaxed, false),
    ] {
        let (catalog, model) = refusal_catalog(catalog);
        let db = Arc::new(Database::new());
        let (r, mock) = launch_catalog(db.clone(), Scenario::default(), None, catalog).await;
        let mut request = request;
        request["model"] = json!(model);
        request["stream"] = json!(false);
        let (status, reply) = post(&r, "/v1/chat", &request).await;
        assert_eq!(status, StatusCode::OK, "{reply}");
        assert_eq!(reply["charged_2z"], 1, "{reply}");
        let sent = mock.recorded_requests();
        assert_eq!(sent.len(), 1);
        let function = &sent[0].body["tools"][0]["function"];
        assert_eq!(function["name"], "check_answer");
        assert_eq!(
            function.get("strict") == Some(&json!(true)),
            sent_strict,
            "{function}"
        );
        mock.shutdown().await;
    }
}

/// A Chat Completions tool turn through the metered gateway: streamed, the
/// client sees every fragment and then the complete call; not streamed, the
/// response carries the call; either way one charge and
/// `finish_reason: "tool_calls"`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_chat_completions_tool_turn_streams_fragments_then_the_call() {
    let fixture = tool_fixture("openai_strict_forced_streamed.json");
    let body: String = fixture["provider_stream"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| match c {
            Value::String(s) => format!("data: {s}\n\n"),
            other => format!("data: {other}\n\n"),
        })
        .collect();
    let app = axum::Router::new().route(
        "/v1/chat/completions",
        axum::routing::post(move || {
            let body = body.clone();
            async move { ([("content-type", "text/event-stream")], body) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let (catalog, model) = refusal_catalog("openai_interim");
    let expected: Vec<f2z_ai_proto::chat::ToolCall> = fixture["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["type"] == "tool_call")
        .map(|e| serde_json::from_value(e.clone()).unwrap())
        .collect();
    for stream in [true, false] {
        let db = Arc::new(Database::new());
        let meter = Arc::new(Metered::new(
            db.clone(),
            adapter_support::backend(&base, adapter_support::tuning(0)),
            adapter_support::claim_key(),
        ));
        let r = support::start(
            &support::config(&[]),
            Deps {
                gate: Arc::new(Gate),
                catalog: Arc::new(Fixed(catalog.clone())),
                backend: meter.clone(),
                settler: meter,
            },
        )
        .await;
        support::wait_readyz(r.admin, StatusCode::OK).await;
        let mut request = fixture["request"].clone();
        request["model"] = json!(model);
        request["stream"] = json!(stream);
        let response = support::send(r.public, support::chat_request(request.to_string())).await;
        assert_eq!(response.status(), StatusCode::OK);
        let text = support::text(response).await;
        if stream {
            let names: Vec<&str> = text
                .lines()
                .filter_map(|l| l.strip_prefix("event: "))
                .collect();
            let fragments = names.iter().filter(|n| **n == "tool_call_delta").count();
            assert_eq!(fragments, 8, "{text}");
            let first_call = names.iter().position(|n| *n == "tool_call").unwrap();
            let last_fragment = names.iter().rposition(|n| *n == "tool_call_delta").unwrap();
            assert!(last_fragment < first_call, "{names:?}");
            assert_eq!(names.first(), Some(&"meta"), "{names:?}");
            assert_eq!(names.last(), Some(&"done"), "{names:?}");
            assert!(text.contains("\"finish_reason\":\"tool_calls\""), "{text}");
            let calls: Vec<f2z_ai_proto::chat::ToolCall> = text
                .split("event: tool_call\ndata: ")
                .skip(1)
                .map(|rest| serde_json::from_str(rest.lines().next().unwrap()).unwrap())
                .collect();
            assert_eq!(calls, expected);
        } else {
            assert!(!text.contains("tool_call_delta"), "{text}");
            let reply: f2z_ai_proto::chat::ChatResponse = serde_json::from_str(&text).unwrap();
            reply.check().unwrap();
            assert_eq!(
                reply.finish_reason,
                f2z_ai_proto::chat::FinishReason::ToolCalls
            );
            assert_eq!(reply.message.tool_calls, expected);
            assert_eq!(reply.usage.input_tokens, 96);
        }
        final_state(&db).await;
        assert_eq!(db.0.lock().unwrap().charges, 1);
    }
    server.abort();
}

// zuu#1177: the real HTTP -> metered admission -> ledger/adapter path.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn signed_tools_effort_conflict_refuses_before_reservation_and_provider() {
    for level in ["minimal", "low", "medium", "high"] {
        let db = Arc::new(Database::new());
        let catalog = effort_tool_catalog(true);
        let (r, mock) = launch_catalog(db.clone(), Scenario::default(), None, catalog).await;
        let mut request = tool_request();
        request["model"] = json!("m-chat");
        request["reasoning_effort"] = json!(level);
        request["stream"] = json!(level == "high");
        let (status, refused) = post(&r, "/v1/chat", &request).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert_eq!(refused["error"]["code"], "invalid_request");
        let api_error: f2z_ai_proto::error::ApiError =
            serde_json::from_value(refused["error"].clone()).unwrap();
        assert!(!api_error.retryable());
        assert!(f2z_ai_proto::error::ErrorCode::ProviderError.retryable());
        assert_eq!(refused["error"]["details"]["field"], "reasoning_effort");
        assert_eq!(
            refused["error"]["details"]["reason"],
            "reasoning_effort_unsupported"
        );
        assert_eq!(refused["error"]["details"]["conflict"], "tools");
        let (status, estimate) = post(&r, "/v1/chat/estimate", &request).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{estimate}");
        assert_eq!(estimate["error"]["details"], refused["error"]["details"]);
        final_state(&db).await;
        let (status, replay) = post(&r, "/v1/chat", &request).await;
        assert_eq!(status, StatusCode::OK, "{replay}");
        assert_eq!(replay["replayed"], true);
        assert_eq!(replay["error"]["code"], "invalid_request");
        {
            let state = db.0.lock().unwrap();
            assert!(state.hold.is_none());
            assert_eq!(state.hold_requests, 0);
            assert_eq!(state.charges, 0);
        }
        assert_eq!(mock.request_count(), 0);
        mock.shutdown().await;
    }
}

fn effort_tool_catalog(restricted: bool) -> f2z_ai::catalog::VerifiedCatalog {
    let mut catalog = tool_catalog().catalog().clone();
    for model in &mut catalog.models {
        model.capabilities.reasoning_effort = true;
        model.controls.tools_require_effort_none = restricted;
    }
    f2z_ai::catalog::VerifiedCatalog::from_verified(catalog).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn signed_tools_effort_control_preserves_supported_requests() {
    // Restricted: tools + omitted effort, effort + no tools, neither.
    // Unrestricted: tools + effort (same model id, metadata alone decides).
    for (restricted, tools, effort) in [
        (true, true, None),
        (true, false, Some("high")),
        (true, false, None),
        (false, true, Some("low")),
    ] {
        let db = Arc::new(Database::new());
        let (r, mock) = launch_catalog(
            db.clone(),
            Scenario::default(),
            None,
            effort_tool_catalog(restricted),
        )
        .await;
        let models = axum::http::Request::get("/v1/models")
            .header("host", "gateway")
            .body(axum::body::Body::empty())
            .unwrap();
        let models: Value =
            serde_json::from_str(&support::text(support::send(r.public, models).await).await)
                .unwrap();
        let advertised = models["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == "m-chat")
            .unwrap();
        assert_eq!(
            advertised["controls"]["tools_require_effort_none"].as_bool(),
            restricted.then_some(true)
        );
        let mut request = request();
        request["model"] = json!("m-chat");
        request["stream"] = json!(false);
        if tools {
            request["tools"] = tool_request()["tools"].clone();
        }
        if let Some(level) = effort {
            request["reasoning_effort"] = json!(level);
        }
        let (status, estimate) = post(&r, "/v1/chat/estimate", &request).await;
        assert_eq!(status, StatusCode::OK, "{estimate}");
        let (status, response) = post(&r, "/v1/chat", &request).await;
        assert_eq!(status, StatusCode::OK, "{response}");
        final_state(&db).await;
        assert_eq!(db.0.lock().unwrap().hold_requests, 1);
        assert_eq!(mock.request_count(), 1);
        let sent = mock.recorded_requests();
        assert_eq!(
            sent[0].body.get("reasoning_effort"),
            effort.map(|v| json!(v)).as_ref()
        );
        assert_eq!(sent[0].body.get("tools").is_some(), tools);
        mock.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sampling_refusals_are_terminal_without_holds_or_upstream_calls() {
    let cases = [
        ("temperature", json!(1.5), "range", true),
        ("temperature", json!(null), "null", false),
        ("n", json!(null), "null", false),
        ("n", json!(2), "n_unsupported", false),
        ("logit_bias", json!({"SECRET":1}), "unsupported", false),
        ("top_logprobs", json!(3), "requires_logprobs", false),
        ("top_logprobs", json!(21), "range", false),
        ("seed", json!(42), "unsupported", false),
    ];
    for (field, value, reason, anthropic) in cases {
        let db = Arc::new(Database::new());
        let mut catalog = tool_catalog().catalog().clone();
        for model in &mut catalog.models {
            model.capabilities.seed = false;
            if anthropic {
                model.api_style = f2z_ai_proto::catalog::ApiStyle::AnthropicMessages;
            }
        }
        let catalog = f2z_ai::catalog::VerifiedCatalog::from_verified(catalog).unwrap();
        let (r, mock) = launch_catalog(db.clone(), Scenario::default(), None, catalog).await;
        let mut body = request();
        body["model"] = json!("m-chat");
        body[field] = value;
        let (status, refused) = post(&r, "/v1/chat", &body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert_eq!(refused["error"]["code"], "invalid_request");
        assert_eq!(refused["error"]["details"]["field"], field);
        assert_eq!(refused["error"]["details"]["reason"], reason);
        if reason != "null" {
            // Plan-time typed refusals persist as the operation's terminal answer.
            // Decoder failures follow the existing decoder policy.
            if field != "logit_bias" || !body[field].is_null() {
                final_state(&db).await;
                let (_, replay) = post(&r, "/v1/chat", &body).await;
                assert_eq!(replay["replayed"], true, "{replay}");
                assert_eq!(replay["error"]["code"], "invalid_request");
                // Like existing response_format refusals, the ledger retains code/message only.
            }
        }
        assert_eq!(db.0.lock().unwrap().hold_requests, 0);
        assert_eq!(db.0.lock().unwrap().charges, 0);
        assert_eq!(mock.request_count(), 0);
        mock.shutdown().await;
    }
}

// zuu#1144: the same controls cross admission, the ledger and real adapters.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forced_tool_choice_signed_policy_precedes_holds_and_provider_io() {
    for id in ["m-chat", "m-anthropic", "m-xai"] {
        for declared in [None, Some(false), Some(true)] {
            for choice in [
                json!("required"),
                json!({"type":"function","function":{"name":"lookup"}}),
                json!("auto"),
                json!("none"),
            ] {
                for (path, stream) in [
                    ("/v1/chat/estimate", false),
                    ("/v1/chat", false),
                    ("/v1/chat", true),
                ] {
                    let mut catalog = tool_catalog().catalog().clone();
                    for model in &mut catalog.models {
                        model.capabilities.forced_tool_choice = declared;
                    }
                    let catalog = f2z_ai::catalog::VerifiedCatalog::from_verified(catalog).unwrap();
                    let db = Arc::new(Database::new());
                    let (r, mock) =
                        launch_catalog(db.clone(), Scenario::default(), None, catalog).await;
                    let mut body = request();
                    body["model"] = json!(id);
                    body["stream"] = json!(stream);
                    body["tools"] = json!([{"name":"lookup","parameters":{"type":"object"}}]);
                    body["tool_choice"] = choice.clone();
                    body["parallel_tool_calls"] = json!(false);
                    if path == "/v1/chat/estimate" && choice == json!("required") {
                        let get = axum::http::Request::get("/v1/models")
                            .header("host", "gateway")
                            .body(axum::body::Body::empty())
                            .unwrap();
                        let listed: Value = serde_json::from_str(
                            &support::text(support::send(r.public, get).await).await,
                        )
                        .unwrap();
                        let model = listed["models"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|m| m["id"] == id)
                            .unwrap();
                        assert_eq!(
                            model["capabilities"]["forced_tool_choice"],
                            declared.unwrap_or(true)
                        );
                    }
                    let forced = choice == json!("required") || choice.is_object();
                    let (status, reply) = post(&r, path, &body).await;
                    if declared == Some(false) && forced {
                        assert_eq!(
                            status,
                            StatusCode::BAD_REQUEST,
                            "{id} {declared:?} {choice}: {reply}"
                        );
                        assert_eq!(reply["error"]["code"], "invalid_request");
                        let error: f2z_ai_proto::error::ApiError =
                            serde_json::from_value(reply["error"].clone()).unwrap();
                        assert!(!error.retryable());
                        assert_eq!(reply["error"]["details"]["reason"], "tools_unsupported");
                        assert_eq!(reply["error"]["details"]["field"], "tool_choice");
                        let state = db.0.lock().unwrap();
                        assert_eq!(state.hold_requests, 0);
                        assert_eq!(state.charges, 0);
                        assert_eq!(mock.request_count(), 0);
                    } else {
                        assert_eq!(
                            status,
                            StatusCode::OK,
                            "{id} {declared:?} {choice}: {reply}"
                        );
                        if path == "/v1/chat" {
                            final_state(&db).await;
                            assert_eq!(db.0.lock().unwrap().hold_requests, 1);
                            assert_eq!(mock.request_count(), 1);
                            let sent = mock.recorded_requests();
                            if id == "m-anthropic" {
                                let expected = if choice.is_object() {
                                    "tool"
                                } else if forced {
                                    "any"
                                } else {
                                    choice.as_str().unwrap()
                                };
                                assert_eq!(sent[0].body["tool_choice"]["type"], expected);
                                // none suppresses tools and therefore has no parallel control.
                                if choice != json!("none") {
                                    assert_eq!(
                                        sent[0].body["tool_choice"]["disable_parallel_tool_use"],
                                        true
                                    );
                                }
                            } else {
                                assert_eq!(sent[0].body["tool_choice"], choice);
                                assert_eq!(sent[0].body["parallel_tool_calls"], false);
                            }
                        }
                    }
                    mock.shutdown().await;
                }
            }
        }
    }
}

// S12: testkit synthetic documented-shape streams, source:
// f2z-ai-testkit::mock module docs. No live providers or credentials.
struct FallbackGate {
    limits: f2z_ai::auth::limits::Limits,
    admissions: std::sync::atomic::AtomicUsize,
}
#[async_trait]
impl Gatekeeper for FallbackGate {
    async fn admit(&self, headers: &HeaderMap) -> Result<Admitted, ApiFailure> {
        let mut admitted = Gate.admit(headers).await?;
        let p = &admitted.principal;
        admitted.lease = Some(
            self.limits
                .admit(&f2z_ai::auth::jwt::Claims {
                    sub: p.sub.clone(),
                    client_id: p.client_id.clone(),
                    app_id: p.app_id.clone(),
                    scope: p.scope.clone(),
                    aep: p.aep,
                    agen: p.agen,
                    exp: p.exp,
                    jti: p.jti.clone(),
                    child_directed: false,
                })
                .await?,
        );
        self.admissions
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(admitted)
    }
}
struct FallbackRig {
    r: support::Running,
    primary: MockProvider,
    fallback: MockProvider,
    gate: Arc<FallbackGate>,
}
impl FallbackRig {
    async fn start(db: Arc<Database>, primary: Scenario, fallback: Scenario) -> Self {
        Self::policy(db, primary, fallback, None).await
    }
    async fn policy(
        db: Arc<Database>,
        primary: Scenario,
        fallback: Scenario,
        allowed: Option<Vec<&str>>,
    ) -> Self {
        let primary = MockProvider::start(primary).await.unwrap();
        let fallback = MockProvider::start(fallback).await.unwrap();
        let providers = [
            ("openai", primary.base_url()),
            ("chatco", fallback.base_url()),
            ("anthropic", fallback.base_url()),
        ]
        .into_iter()
        .map(|(name, base_url)| {
            (
                name.into(),
                f2z_ai::config::ProviderConfig {
                    base_url,
                    api_key: "synthetic-unused-key".into(),
                    completion_tokens_include_reasoning: true,
                },
            )
        })
        .collect();
        let backend =
            f2z_ai::provider::ProviderBackend::new(&providers, adapter_support::tuning(0)).unwrap();
        let meter = Arc::new(
            Metered::new(db, backend, adapter_support::claim_key())
                .with_allowed_models(
                    allowed.map(|ids| ids.into_iter().map(str::to_owned).collect()),
                )
                .with_features_meta(true),
        );
        let gate = Arc::new(FallbackGate {
            limits: f2z_ai::auth::limits::Limits::new(
                f2z_ai::auth::limits::LimitsConfig {
                    user: f2z_ai::auth::store::Rate {
                        per_minute: 10000,
                        burst: 1000,
                    },
                    app: None,
                    concurrency: 1,
                    lease_ttl: Duration::from_secs(360),
                },
                None,
                "fallback-test".into(),
            ),
            admissions: std::sync::atomic::AtomicUsize::new(0),
        });
        // Fallback is pricier, with its own output ceiling.
        let mut catalog = serde_json::to_value(adapter_support::catalog(10_000).catalog()).unwrap();
        catalog["models"][0]["max_output_tokens"] = json!(11);
        catalog["models"][2]["max_output_tokens"] = json!(37);
        catalog["models"][2]["prices"]["output_nusd_per_mtok"] = json!(900_000_000_000_u64);
        let catalog = f2z_ai::catalog::VerifiedCatalog::from_verified(
            serde_json::from_value(catalog).unwrap(),
        )
        .unwrap();
        let r = support::start(
            &support::config(&[]),
            Deps {
                gate: gate.clone(),
                catalog: Arc::new(Fixed(catalog)),
                backend: meter.clone(),
                settler: meter,
            },
        )
        .await;
        support::wait_readyz(r.admin, StatusCode::OK).await;
        Self {
            r,
            primary,
            fallback,
            gate,
        }
    }
    async fn send(&self, stream: bool) -> axum::http::Response<hyper::body::Incoming> {
        let mut body = request();
        body["stream"] = json!(stream);
        body["fallback"] = json!(["m-responses", "m-chat", "m-chat", "m-responses"]);
        let mut req = support::chat_request(body.to_string());
        req.headers_mut()
            .insert("idempotency-key", "fallback-call".parse().unwrap());
        support::send(self.r.public, req).await
    }
    async fn stop(self) {
        self.primary.shutdown().await;
        self.fallback.shutdown().await;
        self.r.gateway.run_until(async {}).await;
    }
}
fn primary_503() -> Scenario {
    Scenario {
        fault: f2z_ai_testkit::mock::Fault::Status { status: 503 },
        ..Scenario::default()
    }
}
fn assert_closed_attempts(db: &Database, expected: &[&str], charges: usize) {
    let m = db.0.lock().unwrap();
    assert_eq!(
        m.attempts
            .iter()
            .map(|a| a.outcome.unwrap_or("OPEN"))
            .collect::<Vec<_>>(),
        expected
    );
    assert_eq!(m.charges, charges);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fallback_primary_503_answers_with_one_lease_one_settlement_and_actual_model() {
    for stream in [true, false] {
        let db = Arc::new(Database::new());
        // Cross the 250 ms tick during switching: next() cancellation must
        // not repeat release or renumber attempts.
        db.0.lock().unwrap().slow_release = true;
        let rig = FallbackRig::start(db.clone(), primary_503(), Scenario::default()).await;
        let response = rig.send(stream).await;
        assert_eq!(response.status(), StatusCode::OK);
        if stream {
            assert_eq!(
                rig.gate
                    .limits
                    .open_calls("11111111-1111-4111-8111-111111111111"),
                1
            );
            let competing = rig.send(true).await;
            assert_eq!(competing.status(), StatusCode::TOO_MANY_REQUESTS);
            drop(competing);
        }
        let text = support::text(response).await;
        if stream {
            assert_eq!(text.matches("event: meta").count(), 1, "{text}");
            assert_eq!(text.matches("event: done").count(), 1, "{text}");
            assert!(text.contains("\"model\":\"m-chat\""), "{text}");
            assert!(
                text.contains("\"requested_model\":\"m-responses\""),
                "{text}"
            );
            assert!(text.contains("\"max_output_tokens\":37"), "{text}");
        } else {
            let v: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(v["model"], "m-chat");
            assert_eq!(v["requested_model"], "m-responses");
        }
        final_state(&db).await;
        assert_closed_attempts(&db, &["released", "settled"], 1);
        {
            let m = db.0.lock().unwrap();
            assert_eq!(m.claims, 1);
            assert_eq!(m.settle_requests, 1);
            assert_eq!(m.hold_requests, 2);
            assert!(m.attempts[1].amount > m.attempts[0].amount);
            assert_eq!(m.completion["model"], "m-chat");
            let usage = Scenario::default()
                .expected_usage(f2z_ai_testkit::mock::ProviderStyle::ChatCompletions, true)
                .unwrap();
            assert_eq!(m.settled_usage, json!(usage));
            let expected_cost = (u128::from(usage.input_tokens) * 1_000
                + u128::from(usage.cached_input_tokens) * 100
                + u128::from(usage.output_tokens) * 900_000_000_000)
                .div_ceil(1_000_000);
            assert!(m.operations.iter().any(|op| matches!(op,
                Operation::Settle { cost_nusd, .. } if u128::try_from(*cost_nusd).unwrap() == expected_cost)),
                "settlement must use the answering model's prices");

            assert_eq!(m.request["features"]["fallback"], 4);
            let second_hold = m
                .operations
                .iter()
                .position(|op| matches!(op, Operation::Hold { attempt: 2, .. }))
                .unwrap();
            assert!(
                m.operations
                    .iter()
                    .enumerate()
                    .filter(|(_, op)| matches!(op, Operation::Complete { .. }))
                    .all(|(i, _)| i > second_hold),
                "switching must not complete the call"
            );
        }
        assert_eq!(
            rig.gate
                .admissions
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert_eq!(rig.primary.request_count(), 1);
        assert_eq!(rig.fallback.request_count(), 1);
        tokio::time::timeout(Duration::from_secs(2), async {
            while rig
                .gate
                .limits
                .open_calls("11111111-1111-4111-8111-111111111111")
                != 0
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let replay = rig.send(stream).await;
        assert_eq!(replay.headers()["x-f2z-replayed"], "true");
        let receipt: Value = serde_json::from_str(&support::text(replay).await).unwrap();
        assert_eq!(receipt["model"], "m-chat");
        assert_eq!(receipt["requested_model"], "m-responses");
        assert_closed_attempts(&db, &["released", "settled"], 1);
        rig.stop().await;
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fallback_hold_refusal_releases_primary_and_reports_last_code() {
    for stream in [true, false] {
        let db = Arc::new(Database::new());
        db.0.lock().unwrap().refuse_attempt = Some(2);
        let rig = FallbackRig::start(db.clone(), primary_503(), Scenario::default()).await;
        let response = rig.send(stream).await;
        assert_eq!(
            response.status(),
            if stream {
                StatusCode::OK
            } else {
                StatusCode::PAYMENT_REQUIRED
            }
        );
        let text = support::text(response).await;
        assert!(text.contains("insufficient_balance"), "{text}");
        assert!(!text.contains("event: meta"), "{text}");
        assert_closed_attempts(&db, &["released"], 0);
        {
            let m = db.0.lock().unwrap();
            assert_eq!(m.hold_requests, 2);
            assert!(
                m.operations
                    .iter()
                    .any(|op| matches!(op, Operation::Complete { no_hold: false, .. }))
            );
        }
        assert_eq!(rig.fallback.request_count(), 0);
        rig.stop().await;
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fallback_exhaustion_uses_last_provider_code_and_never_repeats_a_model() {
    let db = Arc::new(Database::new());
    let rig = FallbackRig::start(
        db.clone(),
        primary_503(),
        Scenario {
            fault: f2z_ai_testkit::mock::Fault::Status { status: 504 },
            ..Scenario::default()
        },
    )
    .await;
    let text = support::text(rig.send(true).await).await;
    assert!(text.contains("provider_timeout"), "{text}");
    assert!(!text.contains("event: meta"), "{text}");
    final_state(&db).await;
    assert_closed_attempts(&db, &["released", "released"], 0);
    assert_eq!(rig.primary.request_count(), 1);
    assert_eq!(rig.fallback.request_count(), 1);
    rig.stop().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fallback_never_switches_after_meta_or_provider_acceptance() {
    for fault in [
        f2z_ai_testkit::mock::Fault::ErrorEventAtByte {
            byte: 0,
            status: 503,
        },
        f2z_ai_testkit::mock::Fault::DisconnectAtByte { byte: 0 },
    ] {
        let db = Arc::new(Database::new());
        let rig = FallbackRig::start(
            db.clone(),
            Scenario {
                fault,
                ..Scenario::default()
            },
            Scenario::default(),
        )
        .await;
        let text = support::text(rig.send(true).await).await;
        assert!(text.contains("event: error"), "{text}");
        final_state(&db).await;
        assert_eq!(db.0.lock().unwrap().attempts.len(), 1);
        assert_eq!(rig.fallback.request_count(), 0);
        rig.stop().await;
    }
    let db = Arc::new(Database::new());
    let rig = FallbackRig::start(
        db.clone(),
        Scenario {
            ending: f2z_ai_testkit::mock::Ending::Failed,
            ..Scenario::default()
        },
        Scenario::default(),
    )
    .await;
    let text = support::text(rig.send(true).await).await;
    assert!(text.contains("event: meta"), "{text}");
    assert!(text.contains("event: error"), "{text}");
    assert_closed_attempts(&db, &["settled"], 1);
    assert_eq!(rig.fallback.request_count(), 0);
    rig.stop().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fallback_pre_meta_client_disconnect_keeps_single_lease_until_release_and_tries_no_fallback()
 {
    let db = Arc::new(Database::new());
    db.0.lock().unwrap().slow_completion = true;
    let rig = FallbackRig::start(
        db.clone(),
        Scenario {
            ttfb: Duration::from_millis(800),
            ..primary_503()
        },
        Scenario::default(),
    )
    .await;
    let response = rig.send(true).await;
    assert_eq!(
        rig.gate
            .limits
            .open_calls("11111111-1111-4111-8111-111111111111"),
        1
    );
    drop(response);
    let refused = rig.send(true).await;
    assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(support::text(refused).await.contains("concurrency_limit"));
    final_state(&db).await;
    assert_closed_attempts(&db, &["released"], 0);
    assert_eq!(rig.fallback.request_count(), 0);
    assert_eq!(
        rig.gate
            .admissions
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        while rig
            .gate
            .limits
            .open_calls("11111111-1111-4111-8111-111111111111")
            != 0
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    rig.stop().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fallback_ambiguous_release_is_read_back_before_next_hold_and_settles_only_once() {
    let db = Arc::new(Database::new());
    {
        let mut m = db.0.lock().unwrap();
        m.lose_release_replies = 2;
        m.lose_settle_reply = true;
    }
    let rig = FallbackRig::start(db.clone(), primary_503(), Scenario::default()).await;
    let text = support::text(rig.send(true).await).await;
    assert!(text.contains("event: done"), "{text}");
    assert_closed_attempts(&db, &["released", "settled"], 1);
    {
        let m = db.0.lock().unwrap();
        assert_eq!(m.settle_requests, 2);
        let read = m
            .operations
            .iter()
            .position(|o| matches!(o, Operation::Read { .. }))
            .unwrap();
        let second = m
            .operations
            .iter()
            .position(|o| matches!(o, Operation::Hold { attempt: 2, .. }))
            .unwrap();
        assert!(read < second);
    }
    rig.stop().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fallback_ambiguous_hold_recovers_matching_attempt_without_reserving_again() {
    let db = Arc::new(Database::new());
    db.0.lock().unwrap().lose_attempt_replies = Some(2);
    let rig = FallbackRig::start(db.clone(), primary_503(), Scenario::default()).await;
    let text = support::text(rig.send(true).await).await;
    assert!(text.contains("unavailable"), "{text}");
    final_state(&db).await;
    assert_closed_attempts(&db, &["released", "released"], 0);
    assert_eq!(rig.fallback.request_count(), 0);
    assert_eq!(
        db.0.lock().unwrap().hold_requests,
        3,
        "two identical hold-2 operations; finalizer only recovers"
    );
    rig.stop().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fallback_unconfirmed_release_stops_before_any_next_hold() {
    let db = Arc::new(Database::new());
    {
        let mut m = db.0.lock().unwrap();
        m.fail_release = true;
        m.fail_reads = true;
    }
    let rig = FallbackRig::start(db.clone(), primary_503(), Scenario::default()).await;
    let text = support::text(rig.send(true).await).await;
    assert!(text.contains("unavailable"), "{text}");
    assert_eq!(rig.fallback.request_count(), 0);
    assert_eq!(db.0.lock().unwrap().hold_requests, 1);
    {
        let mut m = db.0.lock().unwrap();
        m.fail_release = false;
        m.fail_reads = false;
    }
    final_state(&db).await;
    assert_closed_attempts(&db, &["released"], 0);
    rig.stop().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fallback_disabled_model_is_terminal_after_primary_release() {
    let db = Arc::new(Database::new());
    let rig = FallbackRig::policy(
        db.clone(),
        primary_503(),
        Scenario::default(),
        Some(vec!["m-responses"]),
    )
    .await;
    let text = support::text(rig.send(true).await).await;
    assert!(text.contains("model_disabled"), "{text}");
    assert_closed_attempts(&db, &["released"], 0);
    assert_eq!(db.0.lock().unwrap().hold_requests, 1);
    assert_eq!(rig.fallback.request_count(), 0);
    rig.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fallback_replans_at_current_affordability_and_uses_its_own_clamp() {
    for available in [0, 2_000] {
        let db = Arc::new(Database::new());
        db.0.lock().unwrap().available_after_release = Some(available);
        let rig = FallbackRig::start(db.clone(), primary_503(), Scenario::default()).await;
        let text = support::text(rig.send(true).await).await;
        if available == 0 {
            assert!(text.contains("insufficient_balance"), "{text}");
            assert!(!text.contains("event: meta"), "{text}");
            assert_closed_attempts(&db, &["released"], 0);
            assert_eq!(db.0.lock().unwrap().hold_requests, 1);
            assert_eq!(rig.fallback.request_count(), 0);
        } else {
            assert!(text.contains("event: done"), "{text}");
            assert_closed_attempts(&db, &["released", "settled"], 1);
            let meta: Value = text
                .lines()
                .find_map(|line| {
                    line.strip_prefix("data: ")
                        .and_then(|line| serde_json::from_str::<Value>(line).ok())
                        .filter(|v| v.get("max_output_tokens").is_some())
                })
                .unwrap();
            let output = meta["max_output_tokens"].as_u64().unwrap();
            assert!(
                output > 11 && output < 37,
                "fallback reuses neither primary's clamp nor stale balance: {meta}"
            );
            assert!(db.0.lock().unwrap().attempts[1].amount <= available as i64);
        }
        rig.stop().await;
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fallback_never_resends_an_ambiguous_intermediary_failure() {
    for status in [408, 502, 504] {
        let db = Arc::new(Database::new());
        let rig = FallbackRig::start(
            db.clone(),
            Scenario {
                fault: f2z_ai_testkit::mock::Fault::Status { status },
                ..Scenario::default()
            },
            Scenario::default(),
        )
        .await;
        let text = support::text(rig.send(true).await).await;
        assert!(text.contains("event: error"), "{text}");
        assert_closed_attempts(&db, &["released"], 0);
        assert_eq!(rig.fallback.request_count(), 0);
        rig.stop().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fallback_disconnect_during_switching_release_takes_no_next_hold() {
    let db = Arc::new(Database::new());
    db.0.lock().unwrap().slow_release = true;
    let rig = FallbackRig::start(db.clone(), primary_503(), Scenario::default()).await;
    let response = rig.send(true).await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while !db.0.lock().unwrap().release_started {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    drop(response);
    tokio::time::timeout(Duration::from_secs(3), async {
        while rig
            .gate
            .limits
            .open_calls("11111111-1111-4111-8111-111111111111")
            != 0
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_closed_attempts(&db, &["released"], 0);
    assert_eq!(db.0.lock().unwrap().hold_requests, 1);
    assert_eq!(rig.fallback.request_count(), 0);
    rig.stop().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fallback_order_and_deduplication_extend_to_more_than_two_attempts() {
    let db = Arc::new(Database::new());
    let rig = FallbackRig::start(db.clone(), primary_503(), primary_503()).await;
    let mut body = request();
    body["fallback"] = json!(["m-chat", "m-chat", "m-responses", "m-anthropic", "m-chat"]);
    let text = support::text(support::post_chat(rig.r.public, &body).await).await;
    assert!(text.contains("provider_error"), "{text}");
    assert_closed_attempts(&db, &["released", "released", "released"], 0);
    {
        let m = db.0.lock().unwrap();
        assert_eq!(
            m.attempts
                .iter()
                .map(|a| (a.number, a.model.as_str()))
                .collect::<Vec<_>>(),
            vec![(1, "m-responses"), (2, "m-chat"), (3, "m-anthropic")]
        );
    }
    assert_eq!(rig.primary.request_count(), 1);
    assert_eq!(rig.fallback.request_count(), 2);
    rig.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fallback_fingerprint_keeps_the_original_list_before_attempt_requests_are_trimmed() {
    let db = Arc::new(Database::new());
    let rig = FallbackRig::start(db.clone(), primary_503(), Scenario::default()).await;
    let text = support::text(rig.send(true).await).await;
    assert!(text.contains("event: done"), "{text}");
    tokio::time::timeout(Duration::from_secs(2), async {
        while rig
            .gate
            .limits
            .open_calls("11111111-1111-4111-8111-111111111111")
            != 0
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let mut body = request();
    // Same distinct attempt order, different original routing data. The
    // fingerprint and feature count must describe the caller's complete list.
    body["fallback"] = json!(["m-chat"]);
    let mut req = support::chat_request(body.to_string());
    req.headers_mut()
        .insert("idempotency-key", "fallback-call".parse().unwrap());
    let conflict = support::send(rig.r.public, req).await;
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    assert!(
        support::text(conflict)
            .await
            .contains("idempotency_conflict")
    );
    assert_eq!(db.0.lock().unwrap().request["features"]["fallback"], 4);
    assert_closed_attempts(&db, &["released", "settled"], 1);
    assert_eq!(rig.primary.request_count(), 1);
    assert_eq!(rig.fallback.request_count(), 1);
    rig.stop().await;
}
