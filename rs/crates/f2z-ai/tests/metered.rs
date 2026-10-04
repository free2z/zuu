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
    slow_completion: bool,
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
        if matches!(op, Operation::Complete { .. }) && self.0.lock().unwrap().slow_completion {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
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
    let mock = MockProvider::start(scenario).await.unwrap();
    let meter = Arc::new(
        Metered::new(
            db,
            adapter_support::backend(&mock.base_url(), adapter_support::tuning(0)),
        )
        .with_allowed_models(allowed.map(|ids| ids.into_iter().map(str::to_owned).collect())),
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
