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
            },
            lease: None,
        })
    }
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
    amount: i64,
    terminal: Option<&'static str>,
    charges: usize,
    settle_requests: usize,
    revoked: bool,
    expire_at_completion: bool,
    revoke_after_hold: bool,
    lose_hold_replies: usize,
    lose_settle_reply: bool,
    available: u64,
}
impl Memory {
    fn context(&self) -> Value {
        json!({"status":"ok","available_milli_2z":self.available,"cap_remaining_milli_2z":null,"debt_milli_2z":0,"open_holds":0,"frozen":false,"consented_markup_bps":0,"effective_markup_bps":0})
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
          "attempts":self.hold.map(|id|vec![json!({"hold_id":id,"attempt":1})]).unwrap_or_default(),
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
        let mut m = self.0.lock().unwrap();
        match op {
            Operation::Context(_) => Ok(if m.revoked {
                json!({"status":"revoked"})
            } else {
                m.context()
            }),
            Operation::Claim {
                identity,
                call,
                key,
                fingerprint,
                request,
            } => {
                if m.revoked {
                    return Ok(
                        json!({"status":"revoked","call_id":null,"record":null,"context":{"status":"revoked"}}),
                    );
                }
                let status = if m.call.is_some() {
                    if &m.key != key || &m.fingerprint != fingerprint {
                        "conflict"
                    } else if m.terminal.is_some() {
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
            Operation::Hold { amount_milli, .. } => {
                if m.revoked {
                    return Ok(json!({"status":"revoked"}));
                }
                let replayed = m.hold.is_some();
                m.hold.get_or_insert_with(Uuid::now_v7);
                m.amount = *amount_milli;
                if m.revoke_after_hold {
                    m.revoked = true;
                }
                if m.lose_hold_replies > 0 {
                    m.lose_hold_replies -= 1;
                    return Err(Failure);
                }
                Ok(
                    json!({"status":if replayed {"replayed"} else {"held"},"state":m.terminal.unwrap_or("open"),"hold_id":m.hold,"amount":m.amount,"applied_markup_bps":0,"available":m.available,"cap_remaining":null,"expires_at":"2026-09-27T00:05:00Z"}),
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
                assert_eq!(Some(*call), m.call);
                assert_eq!(identity.grant_generation, 1);
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
                m.settle_requests += 1;
                if m.terminal.is_none() {
                    m.charges += 1;
                    m.terminal = Some("settled");
                }
                if m.lose_settle_reply {
                    m.lose_settle_reply = false;
                    return Err(Failure);
                }
                Ok(json!({"status":if m.terminal==Some("settled") {"settled"} else {"not_open"}}))
            }
            Operation::Release { hold, .. } => {
                assert_eq!(Some(*hold), m.hold);
                m.terminal.get_or_insert("released");
                Ok(json!({"status":m.terminal}))
            }
            Operation::Read { identity, call } => {
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
    let mock = MockProvider::start(scenario).await.unwrap();
    let meter = Arc::new(Metered::new(
        db,
        adapter_support::backend(&mock.base_url(), adapter_support::tuning(0)),
    ));
    let running = support::start(
        &support::config(&[]),
        Deps {
            gate: Arc::new(Gate),
            catalog: Arc::new(Fixed(adapter_support::catalog(10_000))),
            backend: meter.clone(),
            settler: meter,
        },
    )
    .await;
    support::wait_readyz(running.admin, StatusCode::OK).await;
    (running, mock)
}
fn request() -> Value {
    json!({"model":"m-responses","max_output_tokens":100,"messages":[{"role":"user","content":[{"type":"text","text":"hello tutor"}]}],"metadata":{"hold_2z":"essay"}})
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
    assert_eq!(record["metadata"]["hold_2z"], "essay");
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
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_usage_is_explicitly_released_never_invented_zero_usage_or_byte_charge() {
    let db = Arc::new(Database::new());
    let (r, mock) = launch(db.clone(), Scenario::default().without_usage()).await;
    let response = send(&r).await;
    assert_eq!(response.status(), StatusCode::OK);
    let text = support::text(response).await;
    assert!(text.contains("event: delta"), "{text}");
    assert!(text.contains("event: error"), "{text}");
    assert!(text.contains("\"settlement\":\"released\""), "{text}");
    assert!(!text.contains("event: done"));
    assert!(!text.contains("event: usage"));
    assert_eq!(db.0.lock().unwrap().charges, 0);
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

async fn send_nonstream(r: &support::Running) -> axum::http::Response<hyper::body::Incoming> {
    let mut value = request();
    value["stream"] = json!(false);
    let mut req = support::chat_request(value.to_string());
    req.headers_mut()
        .insert("idempotency-key", "lesson-1".parse().unwrap());
    support::send(r.public, req).await
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
async fn nonstream_missing_usage_keeps_partial_text_and_confirmed_release() {
    let db = Arc::new(Database::new());
    let (r, mock) = launch(db.clone(), Scenario::default().without_usage()).await;
    let response = send_nonstream(&r).await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let value: Value = serde_json::from_str(&support::text(response).await).unwrap();
    assert_eq!(value["error"]["details"]["settlement"], "released");
    assert_eq!(value["error"]["details"]["partial"], true);
    assert!(
        !value["error"]["details"]["message"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .is_empty()
    );
    assert_eq!(db.0.lock().unwrap().charges, 0);
    mock.shutdown().await;
}
