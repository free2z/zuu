//! A same-key retry that straddles a `child_directed` flip
//! or a child-directed key rotation replays the call it retries — charged
//! once — and a child-directed caller never sends or stores the plain key.
//!
//! The ledger here holds many calls and resolves a claim the way
//! `ledger.call_claim` does: an existing call by id first, then a live
//! idempotency key, comparing the fingerprint; otherwise it inserts the call
//! and its key. Real gateway, real provider adapter, mock provider.
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
    auth::{Admitted, Gatekeeper, Principal, store::StoreError},
    catalog::Fixed,
    idempotency::FormStore,
    ledger::{Failure, Ledger, Operation},
    meter::{ChildDirectedKey, Metered},
};
use f2z_ai_testkit::mock::{MockProvider, Scenario};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use uuid::Uuid;

const SUBJECT: &str = "11111111-1111-4111-8111-111111111111";
const APP: &str = "22222222-2222-4222-8222-222222222222";
const RAW_KEY: &str = "lesson-for-alice-smith";

struct Gate;
#[async_trait]
impl Gatekeeper for Gate {
    async fn admit(&self, headers: &HeaderMap) -> Result<Admitted, ApiFailure> {
        Ok(Admitted {
            principal: Principal {
                sub: SUBJECT.into(),
                client_id: "opaque.native-client_7f3c2e".into(),
                app_id: APP.into(),
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

struct Call {
    fingerprint: String,
    request: Value,
    completion: Value,
    hold: Option<Uuid>,
    amount: i64,
    terminal: Option<&'static str>,
}

/// One `call_claim` as the ledger received it.
#[derive(Clone, Debug)]
struct Claim {
    call: Uuid,
    key: Option<String>,
    fingerprint: String,
    status: &'static str,
}

#[derive(Default)]
struct Book {
    calls: BTreeMap<Uuid, Call>,
    keys: BTreeMap<String, Uuid>,
    holds: BTreeMap<Uuid, Uuid>,
    claims: Vec<Claim>,
    charges: usize,
}

fn context() -> Value {
    json!({"status":"ok","available_milli_2z":100_000,"cap_remaining_milli_2z":null,"debt_milli_2z":0,"open_holds":0,"frozen":false,"consented_markup_bps":0,"effective_markup_bps":0})
}

fn envelope(id: Uuid, c: &Call) -> Value {
    let status = match c.terminal {
        Some("settled") if c.completion["partial"] == true => "settled_partial",
        Some("settled") => "settled",
        Some(_) => "released",
        None if c.completion.is_null() => "streaming",
        None => "settling",
    };
    json!({"call_id":id,"status":status,"request":c.request,"completion":c.completion,"created_at":"2026-10-14T00:00:00Z","settled_at":c.terminal.map(|_|"2026-10-14T00:00:01Z"),"error":null,
      "attempts":c.hold.map(|h|vec![json!({"hold_id":h,"attempt":1})]).unwrap_or_default(),
      "settlement":c.terminal.and_then(|outcome|c.hold.map(|h|json!({"hold_id":h,"outcome":outcome,"hold_milli_2z":c.amount,"priced_milli_2z":if outcome=="settled" {1000} else {0},"collected_milli_2z":if outcome=="settled" {1000} else {0},"shortfall_milli_2z":0,"applied_markup_bps":0,"usage":{}})))})
}

#[derive(Default)]
struct Ledgerish(Mutex<Book>);

impl Ledgerish {
    fn charges(&self) -> usize {
        self.0.lock().unwrap().charges
    }
    fn claims(&self) -> Vec<Claim> {
        self.0.lock().unwrap().claims.clone()
    }
    fn inserted(&self) -> Vec<Claim> {
        self.claims()
            .into_iter()
            .filter(|c| c.status == "claimed")
            .collect()
    }
    async fn settled(&self, n: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if self
                    .0
                    .lock()
                    .unwrap()
                    .calls
                    .values()
                    .filter(|c| c.terminal.is_some())
                    .count()
                    >= n
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
}

#[async_trait]
impl Ledger for Ledgerish {
    async fn execute(&self, op: &Operation) -> Result<Value, Failure> {
        let mut book = self.0.lock().unwrap();
        match op {
            Operation::Context(_) => Ok(context()),
            Operation::Claim {
                identity,
                call,
                key,
                fingerprint,
                request,
            } => {
                assert_eq!(identity.subject.to_string(), SUBJECT);
                // `call_claim`: an existing call by id first, then by key.
                let existing = if book.calls.contains_key(call) {
                    Some(*call)
                } else {
                    key.as_ref().and_then(|k| book.keys.get(k).copied())
                };
                let (status, id) = match existing {
                    Some(id) => {
                        let c = &book.calls[&id];
                        let status = if &c.fingerprint != fingerprint
                            || c.request.get("metadata") != request.get("metadata")
                            || c.request.get("requested_model") != request.get("requested_model")
                        {
                            "conflict"
                        } else if c.terminal.is_some() {
                            "replayed"
                        } else {
                            "pending"
                        };
                        (status, id)
                    }
                    None => {
                        book.calls.insert(
                            *call,
                            Call {
                                fingerprint: fingerprint.clone(),
                                request: request.clone(),
                                completion: Value::Null,
                                hold: None,
                                amount: 0,
                                terminal: None,
                            },
                        );
                        if let Some(k) = key {
                            book.keys.insert(k.clone(), *call);
                        }
                        ("claimed", *call)
                    }
                };
                book.claims.push(Claim {
                    call: *call,
                    key: key.clone(),
                    fingerprint: fingerprint.clone(),
                    status,
                });
                let record = envelope(id, &book.calls[&id]);
                Ok(json!({"status":status,"call_id":id,"record":record,"context":context()}))
            }
            Operation::Hold {
                call, amount_milli, ..
            } => {
                let hold = Uuid::now_v7();
                book.holds.insert(hold, *call);
                let c = book.calls.get_mut(call).unwrap();
                c.hold = Some(hold);
                c.amount = *amount_milli;
                Ok(
                    json!({"status":"held","state":"open","hold_id":hold,"amount":amount_milli,"applied_markup_bps":0,"available":100_000,"cap_remaining":null,"expires_at":"2026-10-14T00:05:00Z"}),
                )
            }
            Operation::Extend { .. } => Ok(
                json!({"status":"held","state":"open","amount":100_000,"available":100_000,"cap_remaining":null,"expires_at":"2026-10-14T00:05:00Z"}),
            ),
            Operation::Complete {
                call, completion, ..
            } => {
                let c = book.calls.get_mut(call).unwrap();
                if c.completion.is_null() {
                    c.completion = completion.clone();
                }
                let record = envelope(*call, c);
                Ok(json!({"status":"recorded","record":record}))
            }
            Operation::Settle { hold, .. } => {
                let call = book.holds[hold];
                let c = book.calls.get_mut(&call).unwrap();
                let first = c.terminal.is_none();
                c.terminal.get_or_insert("settled");
                if first {
                    book.charges += 1;
                }
                Ok(json!({"status":"settled"}))
            }
            Operation::Release { hold, .. } => {
                let call = book.holds[hold];
                let c = book.calls.get_mut(&call).unwrap();
                c.terminal.get_or_insert("released");
                Ok(json!({"status":c.terminal}))
            }
            Operation::Read { call, .. } => Ok(match book.calls.get(call) {
                Some(c) => json!({"status":"found","record":envelope(*call, c)}),
                None => json!({"status":"not_found","record":null}),
            }),
        }
    }
}

/// Redis, in memory; `down` makes every call fail like an outage.
#[derive(Default)]
struct Forms {
    values: Mutex<BTreeMap<String, String>>,
    down: AtomicBool,
}
#[async_trait]
impl FormStore for Forms {
    async fn get(&self, keys: &[String]) -> Result<Vec<Option<String>>, StoreError> {
        if self.down.load(Ordering::SeqCst) {
            return Err(StoreError);
        }
        let values = self.values.lock().unwrap();
        Ok(keys.iter().map(|k| values.get(k).cloned()).collect())
    }
    async fn put(&self, key: &str, value: &str, ttl: Duration) -> Result<(), StoreError> {
        if self.down.load(Ordering::SeqCst) {
            return Err(StoreError);
        }
        assert!(
            ttl < Duration::from_secs(24 * 3600),
            "outlives the ledger key"
        );
        self.values
            .lock()
            .unwrap()
            .insert(key.to_owned(), value.to_owned());
        Ok(())
    }
}

const KEY_A: [u8; 32] = [7; 32];
const KEY_B: [u8; 32] = [9; 32];

struct Gateway {
    running: support::Running,
    mock: MockProvider,
}

/// A gateway on the shared `ledger` and `forms`, with `current` (and
/// `previous`) child-directed keys. `forms: None` is the gateway without
/// the form lookup: every claim takes its canonical form.
async fn gateway(
    ledger: &Arc<Ledgerish>,
    forms: Option<&Arc<Forms>>,
    current: [u8; 32],
    previous: Option<[u8; 32]>,
) -> Gateway {
    let mock = MockProvider::start(Scenario::default()).await.unwrap();
    let mut meter = Metered::new(
        Arc::clone(ledger) as Arc<dyn Ledger>,
        adapter_support::backend(&mock.base_url(), adapter_support::tuning(0)),
    )
    .with_child_directed_key(Some(ChildDirectedKey::new(&current).unwrap()))
    .with_child_directed_key_previous(previous.map(|k| ChildDirectedKey::new(&k).unwrap()));
    if let Some(forms) = forms {
        meter = meter.with_form_store(Arc::clone(forms) as Arc<dyn FormStore>, "free2z".into());
    }
    let meter = Arc::new(meter);
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
    Gateway { running, mock }
}

impl Gateway {
    /// One keyed call, the app child-directed or not; `(status, replayed)`.
    async fn call(&self, child: bool) -> (StatusCode, bool) {
        let body = json!({"model":"m-responses","max_output_tokens":100,"messages":[{"role":"user","content":[{"type":"text","text":"2+2?"}]}]});
        let mut req = support::chat_request(body.to_string());
        req.headers_mut()
            .insert("idempotency-key", RAW_KEY.parse().unwrap());
        if child {
            req.headers_mut()
                .insert("test-child-directed", "1".parse().unwrap());
        }
        let response = support::send(self.running.public, req).await;
        let status = response.status();
        let replayed = response
            .headers()
            .get("x-f2z-replayed")
            .is_some_and(|v| v == "true");
        let _ = support::text(response).await;
        (status, replayed)
    }
    async fn forms_metric(&self, outcome: &str) -> String {
        support::metric(
            self.running.admin,
            &format!("f2z_ai_idempotency_forms_total{{outcome=\"{outcome}\"}}"),
        )
        .await
    }
    async fn shutdown(self) {
        self.mock.shutdown().await;
    }
}

/// The plain key text never reached the ledger in a child-directed claim,
/// and no claim that inserted a row from a child-directed call stored it.
fn assert_no_plain_key_from(claims: &[Claim]) {
    for claim in claims {
        assert_ne!(claim.key.as_deref(), Some(RAW_KEY), "{claim:?}");
        if let Some(key) = &claim.key {
            assert_eq!(key.len(), 64, "{claim:?}");
        }
    }
}

fn assert_redis_holds_no_key_text(forms: &Forms) {
    for (name, value) in forms.values.lock().unwrap().iter() {
        assert!(
            !name.contains("alice") && !value.contains("alice"),
            "{name} {value}"
        );
    }
}

// Not child-directed, then flagged: the retry derives the keyed form but
// names the plain-form call, which the ledger replays. One charge, and the
// child-directed retry sent neither the key text nor stored anything.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retry_across_a_flip_to_child_directed_replays_and_charges_once() {
    let ledger = Arc::new(Ledgerish::default());
    let forms = Arc::new(Forms::default());
    let g = gateway(&ledger, Some(&forms), KEY_A, None).await;
    assert_eq!(g.call(false).await, (StatusCode::OK, false));
    ledger.settled(1).await;
    let first = ledger.inserted();
    assert_eq!(first.len(), 1);
    assert_eq!(
        first[0].key.as_deref(),
        Some(RAW_KEY),
        "plain form for this app"
    );

    let before = ledger.claims().len();
    assert_eq!(g.call(true).await, (StatusCode::OK, true), "replayed");
    assert_eq!(ledger.charges(), 1, "charged once");
    let retry = ledger.claims()[before..].to_vec();
    assert_eq!(retry.len(), 1);
    assert_eq!(retry[0].call, first[0].call, "named the recorded call");
    assert_eq!(retry[0].status, "replayed");
    assert_no_plain_key_from(&retry);
    assert_eq!(ledger.inserted().len(), 1, "nothing newly stored");
    assert_redis_holds_no_key_text(&forms);
    assert_eq!(g.forms_metric("straddle").await, "1");
    g.shutdown().await;
}

// Child-directed, then the flag is cleared: the retry derives the plain form
// but names the keyed call, with the fingerprint under the key.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retry_across_a_flip_from_child_directed_replays_and_charges_once() {
    let ledger = Arc::new(Ledgerish::default());
    let forms = Arc::new(Forms::default());
    let g = gateway(&ledger, Some(&forms), KEY_A, None).await;
    assert_eq!(g.call(true).await, (StatusCode::OK, false));
    ledger.settled(1).await;
    let first = ledger.inserted();
    assert_no_plain_key_from(&first);

    assert_eq!(g.call(false).await, (StatusCode::OK, true), "replayed");
    assert_eq!(ledger.charges(), 1, "charged once");
    let last = ledger.claims().last().cloned().unwrap();
    assert_eq!(last.call, first[0].call);
    assert_eq!(
        last.fingerprint, first[0].fingerprint,
        "the keyed fingerprint"
    );
    assert_eq!(ledger.inserted().len(), 1);
    assert_redis_holds_no_key_text(&forms);
    // A same-form retry is the ordinary key path, unchanged.
    assert_eq!(g.call(true).await, (StatusCode::OK, true));
    assert_eq!(g.forms_metric("same").await, "1");
    assert_eq!(ledger.charges(), 1);
    g.shutdown().await;
}

// The key rotates from A to B with A kept as previous: a child-directed
// retry of a call claimed under A finds A's record and replays that call.
// Once A is dropped, the documented fallback: a new call.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retry_across_a_key_rotation_replays_while_the_previous_key_is_kept() {
    let ledger = Arc::new(Ledgerish::default());
    let forms = Arc::new(Forms::default());
    let before = gateway(&ledger, Some(&forms), KEY_A, None).await;
    assert_eq!(before.call(true).await, (StatusCode::OK, false));
    ledger.settled(1).await;
    let first = ledger.inserted();
    before.shutdown().await;

    let rotated = gateway(&ledger, Some(&forms), KEY_B, Some(KEY_A)).await;
    assert_eq!(rotated.call(true).await, (StatusCode::OK, true), "replayed");
    assert_eq!(ledger.charges(), 1, "charged once");
    let retry = ledger.claims().last().cloned().unwrap();
    assert_eq!(retry.call, first[0].call);
    assert_eq!(retry.fingerprint, first[0].fingerprint, "under key A");
    assert_ne!(retry.key, first[0].key, "the claim carries key B's form");
    assert_no_plain_key_from(&ledger.claims());
    assert_eq!(ledger.inserted().len(), 1);
    assert_eq!(rotated.forms_metric("straddle").await, "1");
    rotated.shutdown().await;

    let retired = gateway(&ledger, Some(&forms), KEY_B, None).await;
    assert_eq!(retired.call(true).await, (StatusCode::OK, false));
    assert_eq!(retired.forms_metric("miss").await, "1");
    ledger.settled(2).await;
    assert_eq!(ledger.charges(), 2, "without key A the retry is a new call");
    assert_no_plain_key_from(&ledger.claims());
    retired.shutdown().await;
}

// The negative control: the same flips on a gateway without the form
// lookup are charged twice. This is the bug, reproduced by this ledger, so
// the tests above prove the lookup rather than a lenient fake.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_the_form_lookup_a_straddling_retry_is_charged_twice() {
    for child_first in [false, true] {
        let ledger = Arc::new(Ledgerish::default());
        let g = gateway(&ledger, None, KEY_A, None).await;
        assert_eq!(g.call(child_first).await, (StatusCode::OK, false));
        ledger.settled(1).await;
        assert_eq!(g.call(!child_first).await, (StatusCode::OK, false));
        ledger.settled(2).await;
        assert_eq!(ledger.charges(), 2, "child_first={child_first}");
        g.shutdown().await;
    }
}

// Redis down: requests still succeed in their canonical form (the
// fallback), the double charge is possible again, and it is counted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_redis_down_the_canonical_form_is_used_and_counted() {
    let ledger = Arc::new(Ledgerish::default());
    let forms = Arc::new(Forms::default());
    let g = gateway(&ledger, Some(&forms), KEY_A, None).await;
    assert_eq!(g.call(false).await, (StatusCode::OK, false));
    ledger.settled(1).await;
    forms.down.store(true, Ordering::SeqCst);
    assert_eq!(g.call(true).await, (StatusCode::OK, false));
    ledger.settled(2).await;
    assert_eq!(ledger.charges(), 2, "the documented degraded case");
    assert_eq!(g.forms_metric("unavailable").await, "1");
    assert_eq!(g.forms_metric("write_failed").await, "1");
    assert_no_plain_key_from(&ledger.claims()[1..]);
    g.shutdown().await;
}

// A record naming a key this gateway does not hold is not trusted: the
// canonical form, counted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_record_naming_an_unknown_key_falls_back_and_is_counted() {
    let ledger = Arc::new(Ledgerish::default());
    let forms = Arc::new(Forms::default());
    let g = gateway(&ledger, Some(&forms), KEY_A, None).await;
    assert_eq!(g.call(true).await, (StatusCode::OK, false));
    ledger.settled(1).await;
    for value in forms.values.lock().unwrap().values_mut() {
        let call = value.rsplit(':').next().unwrap().to_owned();
        *value = format!("v1:keyed:0000000000000000:{call}");
    }
    assert_eq!(g.call(false).await, (StatusCode::OK, false));
    assert_eq!(g.forms_metric("unknown_record").await, "1");
    g.shutdown().await;
}

// A record whose call the ledger no longer holds: the claim by that id
// inserts a call afresh. The request still succeeds, and it is counted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_record_naming_a_call_the_ledger_lost_is_counted_as_orphaned() {
    let ledger = Arc::new(Ledgerish::default());
    let forms = Arc::new(Forms::default());
    let g = gateway(&ledger, Some(&forms), KEY_A, None).await;
    assert_eq!(g.call(true).await, (StatusCode::OK, false));
    ledger.settled(1).await;
    let lost = Uuid::now_v7();
    for value in forms.values.lock().unwrap().values_mut() {
        let (form, _) = value.rsplit_once(':').unwrap();
        *value = format!("{form}:{lost}");
    }
    assert_eq!(g.call(false).await, (StatusCode::OK, false));
    assert_eq!(g.forms_metric("orphaned").await, "1");
    let last = ledger.claims().last().cloned().unwrap();
    assert_eq!((last.call, last.status), (lost, "claimed"));
    g.shutdown().await;
}
