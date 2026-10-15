//! zuu#1225: every app's claim is keyed, whatever its audience. A same-key
//! retry of a call claimed in another form — the plain form the image before
//! zuu#1225 stored for ordinary apps, or under a key since rotated — replays
//! the call it retries, charged once, and no claim ever carries the key text.
//!
//! The ledger here holds many calls and resolves a claim the way
//! `ledger.call_claim` does: an existing call by id first, then a live
//! idempotency key, comparing the fingerprint; otherwise it inserts the call
//! and its key. Real gateway, real provider adapter, mock provider.
//!
//! The ledger's key rows and the Redis records expire on one simulated
//! [`Clock`] the tests advance, so a record's TTL is tested against the key
//! row it must outlive (tuzi#2670), not just its size.
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
    idempotency::{FormStore, RECORD_TTL},
    ledger::{Failure, Ledger, Operation},
    meter::{ClaimKey, Metered},
};
use f2z_ai_testkit::mock::{MockProvider, Scenario};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use uuid::Uuid;

const SUBJECT: &str = "11111111-1111-4111-8111-111111111111";
const APP: &str = "22222222-2222-4222-8222-222222222222";
const RAW_KEY: &str = "lesson-for-alice-smith";

/// `ledger.call_claim`'s key lifetime, `now() + interval '24 hours'` (tuzi
/// `py/dj/apps/ledger/migrations/_call_recovery.py`), written out here rather
/// than read from the gateway so the fake ledger models the SQL.
const LEDGER_KEY_LIFETIME: Duration = Duration::from_secs(24 * 3600);

/// Simulated time, in milliseconds since the test began, shared by the
/// ledger's key rows and the Redis records. It moves only when a test moves it.
#[derive(Clone, Default)]
struct Clock(Arc<AtomicU64>);
impl Clock {
    fn now(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
    fn set(&self, since_start: Duration) {
        self.0.store(
            u64::try_from(since_start.as_millis()).unwrap(),
            Ordering::SeqCst,
        );
    }
    fn after(&self, d: Duration) -> u64 {
        self.now() + u64::try_from(d.as_millis()).unwrap()
    }
}

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
    /// key → (call, expires at); found only while `expires > now`.
    keys: BTreeMap<String, (Uuid, u64)>,
    clock: Clock,
    holds: BTreeMap<Uuid, Uuid>,
    claims: Vec<Claim>,
    charges: usize,
    /// Claims still to fail like an outage (each request tries twice).
    fail_claims: u32,
    /// Every `Complete` the ledger received: `(call, no_hold)`.
    completes: Vec<(Uuid, bool)>,
    /// Claims this holds back (`slow_for`, default 300 ms) before they
    /// reach the book, to fix which of two racing claims the ledger sees
    /// first, or to outlast a request's start deadline.
    slow: Option<Slow>,
    slow_for: Option<Duration>,
}

type Slow = Arc<dyn Fn(&Operation) -> bool + Send + Sync>;

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
    fn on(clock: &Clock) -> Self {
        Self(Mutex::new(Book {
            clock: clock.clone(),
            ..Book::default()
        }))
    }
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
        if let Operation::Claim { .. } = op {
            let (slow, slow_for) = {
                let book = self.0.lock().unwrap();
                (book.slow.clone(), book.slow_for)
            };
            if slow.is_some_and(|slow| slow(op)) {
                tokio::time::sleep(slow_for.unwrap_or(Duration::from_millis(300))).await;
            }
            let mut book = self.0.lock().unwrap();
            if book.fail_claims > 0 {
                book.fail_claims -= 1;
                return Err(Failure);
            }
        }
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
                    let now = book.clock.now();
                    key.as_ref()
                        .and_then(|k| book.keys.get(k))
                        .filter(|(_, expires)| *expires > now)
                        .map(|(id, _)| *id)
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
                            // ON CONFLICT DO UPDATE: an expired row is replaced.
                            let expires = book.clock.after(LEDGER_KEY_LIFETIME);
                            book.keys.insert(k.clone(), (*call, expires));
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
                call,
                completion,
                no_hold,
                ..
            } => {
                book.completes.push((*call, *no_hold));
                // A request whose claim failed never inserted its call.
                let Some(c) = book.calls.get_mut(call) else {
                    return Ok(json!({"status":"not_found","record":null}));
                };
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

/// Redis, in memory, expiring each value at its `PX` on the [`Clock`];
/// `down` makes every call fail like an outage. `ttl_override` replaces the
/// TTL the gateway asks for — only the negative control sets it.
///
/// `race` holds every reservation until that many have arrived, so
/// concurrent requests reach Redis together. `split` makes a reservation
/// non-atomic — a read, then (after the race barrier) a write — which is
/// what lookup-before-claim, write-after-claim amounted to before zuu#1225:
/// only the negative control sets it.
#[derive(Default)]
struct Forms {
    /// key → (value, expires at).
    values: Mutex<BTreeMap<String, (String, u64)>>,
    down: AtomicBool,
    clock: Clock,
    ttl_override: Option<Duration>,
    race: Mutex<Option<Arc<tokio::sync::Barrier>>>,
    split: bool,
}
impl Forms {
    fn on(clock: &Clock) -> Self {
        Self {
            clock: clock.clone(),
            ..Self::default()
        }
    }
    /// Hold reservations until two have arrived; `split` as documented.
    fn racing(split: bool) -> Self {
        Self {
            race: Mutex::new(Some(Arc::new(tokio::sync::Barrier::new(2)))),
            split,
            ..Self::default()
        }
    }
    fn barrier(&self) -> Option<Arc<tokio::sync::Barrier>> {
        self.race.lock().unwrap().clone()
    }
    /// The live records' values.
    fn live(&self) -> Vec<String> {
        let now = self.clock.now();
        self.values
            .lock()
            .unwrap()
            .values()
            .filter(|(_, expires)| *expires > now)
            .map(|(v, _)| v.clone())
            .collect()
    }
    fn rewrite(&self, f: impl Fn(&str) -> String) {
        for (value, _) in self.values.lock().unwrap().values_mut() {
            *value = f(value);
        }
    }
}
#[async_trait]
impl FormStore for Forms {
    async fn get(&self, keys: &[String]) -> Result<Vec<Option<String>>, StoreError> {
        if self.down.load(Ordering::SeqCst) {
            return Err(StoreError);
        }
        let now = self.clock.now();
        let values = self.values.lock().unwrap();
        Ok(keys
            .iter()
            .map(|k| {
                values
                    .get(k)
                    .filter(|(_, expires)| *expires > now)
                    .map(|(v, _)| v.clone())
            })
            .collect())
    }
    async fn reserve(
        &self,
        keys: &[String],
        value: &str,
        ttl: Duration,
    ) -> Result<Option<String>, StoreError> {
        if self.down.load(Ordering::SeqCst) {
            return Err(StoreError);
        }
        let first = |values: &BTreeMap<String, (String, u64)>| {
            let now = self.clock.now();
            keys.iter()
                .find_map(|k| values.get(k).filter(|(_, expires)| *expires > now))
                .map(|(v, _)| v.clone())
        };
        let write = |values: &mut BTreeMap<String, (String, u64)>| {
            let expires = self.clock.after(self.ttl_override.unwrap_or(ttl));
            for key in keys {
                values.insert(key.clone(), (value.to_owned(), expires));
            }
        };
        if self.split {
            let found = first(&self.values.lock().unwrap());
            if let Some(race) = self.barrier() {
                race.wait().await;
            }
            if found.is_none() {
                write(&mut self.values.lock().unwrap());
            }
            return Ok(found);
        }
        if let Some(race) = self.barrier() {
            race.wait().await;
        }
        let mut values = self.values.lock().unwrap();
        let found = first(&values);
        if found.is_none() {
            write(&mut values);
        }
        Ok(found)
    }
    async fn put(&self, key: &str, value: &str, ttl: Duration) -> Result<(), StoreError> {
        if self.down.load(Ordering::SeqCst) {
            return Err(StoreError);
        }
        let expires = self.clock.after(self.ttl_override.unwrap_or(ttl));
        self.values
            .lock()
            .unwrap()
            .insert(key.to_owned(), (value.to_owned(), expires));
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
    gateway_with(ledger, forms, current, previous, &[]).await
}

/// [`gateway`], with configuration overrides.
async fn gateway_with(
    ledger: &Arc<Ledgerish>,
    forms: Option<&Arc<Forms>>,
    current: [u8; 32],
    previous: Option<[u8; 32]>,
    overrides: &[(&str, &str)],
) -> Gateway {
    let mock = MockProvider::start(Scenario::default()).await.unwrap();
    let mut meter = Metered::new(
        Arc::clone(ledger) as Arc<dyn Ledger>,
        adapter_support::backend(&mock.base_url(), adapter_support::tuning(0)),
        ClaimKey::new(&current).unwrap(),
    )
    .with_key_previous(previous.map(|k| ClaimKey::new(&k).unwrap()));
    if let Some(forms) = forms {
        meter = meter.with_form_store(Arc::clone(forms) as Arc<dyn FormStore>, "free2z".into());
    }
    let meter = Arc::new(meter);
    let running = support::start(
        &support::config(overrides),
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
        let mut req = support::chat_request(call_body().to_string());
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

/// The request [`Gateway::call`] sends.
fn call_body() -> Value {
    json!({"model":"m-responses","max_output_tokens":100,"messages":[{"role":"user","content":[{"type":"text","text":"2+2?"}]}]})
}

/// The unkeyed SHA-256 fingerprint the previous image stored for an
/// ordinary app: lowercase hex of the request as the gateway serializes it
/// (no tools or schema here, so nothing for the canonical form to sort).
fn plain_fingerprint(body: &Value) -> String {
    let request: f2z_ai_proto::chat::ChatRequest = serde_json::from_value(body.clone()).unwrap();
    let bytes = serde_json::to_vec(&request).unwrap();
    ring::digest::digest(&ring::digest::SHA256, &bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Rewrite the one call on `ledger` and its record in `forms` into what the
/// image before zuu#1225 stored for an ordinary (not child-directed) app
/// while the key was configured: the `Idempotency-Key` as sent, the unkeyed
/// fingerprint, and a `v1:plain:<call>` form record under the same Redis
/// key (an HMAC of the key text, derived the same way by both images). This
/// image no longer produces that form, so the test writes it: the shape a
/// retry must still replay for 24 h 10 m after this image is deployed.
fn as_the_previous_image_stored_it(ledger: &Ledgerish, forms: Option<&Forms>) -> Uuid {
    let mut book = ledger.0.lock().unwrap();
    assert_eq!(book.calls.len(), 1);
    let call = *book.calls.keys().next().unwrap();
    book.calls.get_mut(&call).unwrap().fingerprint = plain_fingerprint(&call_body());
    let rows: Vec<String> = book.keys.keys().cloned().collect();
    assert_eq!(rows.len(), 1);
    let (id, expires) = book.keys.remove(&rows[0]).unwrap();
    book.keys.insert(RAW_KEY.to_owned(), (id, expires));
    drop(book);
    if let Some(forms) = forms {
        assert_eq!(forms.live().len(), 1);
        forms.rewrite(|_| format!("v1:plain:{call}"));
    }
    call
}

/// Every claim, whatever the app's audience: the key is a 64-hex HMAC,
/// never the text the caller sent.
fn assert_every_claim_keyed(claims: &[Claim]) {
    for claim in claims {
        let key = claim.key.as_deref().unwrap();
        assert_ne!(key, RAW_KEY, "{claim:?}");
        assert_eq!(key.len(), 64, "{claim:?}");
        assert!(key.bytes().all(|b| b.is_ascii_hexdigit()), "{claim:?}");
    }
}

fn assert_redis_holds_no_key_text(forms: &Forms) {
    for (name, (value, _)) in forms.values.lock().unwrap().iter() {
        assert!(
            !name.contains("alice") && !value.contains("alice"),
            "{name} {value}"
        );
    }
}

/// One keyed call, rewritten into the previous image's plain form, then a
/// keyed retry `age` after it on a ledger and Redis sharing one clock: the
/// charges, and the gateway for its metrics. The first call's own lookup
/// counts one `miss`.
async fn plain_then_keyed_at(age: Duration, forms: Forms) -> (usize, Gateway) {
    let clock = forms.clock.clone();
    let ledger = Arc::new(Ledgerish::on(&clock));
    let forms = Arc::new(forms);
    let g = gateway(&ledger, Some(&forms), KEY_A, None).await;
    assert_eq!(g.call(false).await, (StatusCode::OK, false));
    ledger.settled(1).await;
    as_the_previous_image_stored_it(&ledger, Some(&forms));
    clock.set(age);
    let (status, replayed) = g.call(false).await;
    assert_eq!(status, StatusCode::OK);
    if !replayed {
        ledger.settled(2).await;
    }
    (ledger.charges(), g)
}

// The transition. An ordinary app's call claimed in the plain form by the
// image before this one, retried after the deploy with the same key: the
// retry derives the keyed form, finds the plain form record, names the
// recorded call, and is replayed — charged once — while its own claim
// carries only the HMAC and inserts nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_ordinary_apps_plain_form_call_is_replayed_by_a_keyed_retry_and_charged_once() {
    let ledger = Arc::new(Ledgerish::default());
    let forms = Arc::new(Forms::default());
    let g = gateway(&ledger, Some(&forms), KEY_A, None).await;
    assert_eq!(g.call(false).await, (StatusCode::OK, false));
    ledger.settled(1).await;
    let call = as_the_previous_image_stored_it(&ledger, Some(&forms));

    let before = ledger.claims().len();
    assert_eq!(g.call(false).await, (StatusCode::OK, true), "replayed");
    assert_eq!(ledger.charges(), 1, "charged once");
    let retry = ledger.claims()[before..].to_vec();
    assert_eq!(retry.len(), 1);
    assert_eq!((retry[0].call, retry[0].status), (call, "replayed"));
    assert_eq!(retry[0].fingerprint, plain_fingerprint(&call_body()));
    assert_every_claim_keyed(&retry);
    assert_eq!(ledger.inserted().len(), 1, "nothing newly stored");
    assert_redis_holds_no_key_text(&forms);
    assert_eq!(g.forms_metric("straddle").await, "1");
    g.shutdown().await;
}

// The negative control: the same plain-form call with no form record — the
// previous image ran without the key, or the record was lost — is charged a
// second time by the keyed retry. This is the bug, reproduced by this
// ledger, so the replay above is the record's doing rather than a lenient
// fake — and the reason this image is deployed only once the key has been
// live on the previous one for at least 24 h 10 m.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_a_form_record_a_plain_form_call_retried_keyed_is_charged_twice() {
    let ledger = Arc::new(Ledgerish::default());
    let g = gateway(&ledger, None, KEY_A, None).await;
    assert_eq!(g.call(false).await, (StatusCode::OK, false));
    ledger.settled(1).await;
    as_the_previous_image_stored_it(&ledger, None);
    assert_eq!(g.call(false).await, (StatusCode::OK, false));
    ledger.settled(2).await;
    assert_eq!(ledger.charges(), 2, "the documented precondition");
    assert_every_claim_keyed(&ledger.claims()[1..]);
    g.shutdown().await;
}

// child_directed no longer selects a form: both audiences derive the same
// keyed claim, so a retry across a flip is an ordinary same-form replay.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_app_claims_in_the_keyed_form_and_a_flip_changes_nothing() {
    for child_first in [false, true] {
        let ledger = Arc::new(Ledgerish::default());
        let forms = Arc::new(Forms::default());
        let g = gateway(&ledger, Some(&forms), KEY_A, None).await;
        assert_eq!(g.call(child_first).await, (StatusCode::OK, false));
        ledger.settled(1).await;
        assert_eq!(g.call(!child_first).await, (StatusCode::OK, true));
        assert_eq!(ledger.charges(), 1, "child_first={child_first}");
        let claims = ledger.claims();
        assert_every_claim_keyed(&claims);
        assert_eq!(claims[0].key, claims[1].key);
        assert_eq!(claims[0].fingerprint, claims[1].fingerprint);
        assert_ne!(claims[0].fingerprint, plain_fingerprint(&call_body()));
        assert_eq!(g.forms_metric("same").await, "1");
        assert_eq!(g.forms_metric("straddle").await, "0");
        assert_redis_holds_no_key_text(&forms);
        g.shutdown().await;
    }
}

// The key rotates from A to B with A kept as previous: a retry of a call
// claimed under A, by either audience, finds A's record and replays that
// call. Once A is dropped, the documented fallback: a new call.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retry_across_a_key_rotation_replays_while_the_previous_key_is_kept() {
    for child in [false, true] {
        let ledger = Arc::new(Ledgerish::default());
        let forms = Arc::new(Forms::default());
        let before = gateway(&ledger, Some(&forms), KEY_A, None).await;
        assert_eq!(before.call(child).await, (StatusCode::OK, false));
        ledger.settled(1).await;
        let first = ledger.inserted();
        before.shutdown().await;

        let rotated = gateway(&ledger, Some(&forms), KEY_B, Some(KEY_A)).await;
        assert_eq!(
            rotated.call(child).await,
            (StatusCode::OK, true),
            "replayed"
        );
        assert_eq!(ledger.charges(), 1, "child={child}: charged once");
        let retry = ledger.claims().last().cloned().unwrap();
        assert_eq!(retry.call, first[0].call);
        assert_eq!(retry.fingerprint, first[0].fingerprint, "under key A");
        assert_ne!(retry.key, first[0].key, "the claim carries key B's form");
        assert_eq!(ledger.inserted().len(), 1);
        assert_eq!(rotated.forms_metric("straddle").await, "1");
        rotated.shutdown().await;

        let retired = gateway(&ledger, Some(&forms), KEY_B, None).await;
        assert_eq!(retired.call(child).await, (StatusCode::OK, false));
        assert_eq!(retired.forms_metric("miss").await, "1");
        ledger.settled(2).await;
        assert_eq!(ledger.charges(), 2, "without key A the retry is a new call");
        assert_every_claim_keyed(&ledger.claims());
        retired.shutdown().await;
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
    as_the_previous_image_stored_it(&ledger, Some(&forms));
    forms.down.store(true, Ordering::SeqCst);
    assert_eq!(g.call(false).await, (StatusCode::OK, false));
    ledger.settled(2).await;
    assert_eq!(ledger.charges(), 2, "the documented degraded case");
    assert_eq!(g.forms_metric("unavailable").await, "1");
    assert_eq!(g.forms_metric("write_failed").await, "1");
    assert_every_claim_keyed(&ledger.claims()[1..]);
    g.shutdown().await;
}

// A record naming a key this gateway does not hold is not trusted: the
// canonical form, counted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_record_naming_an_unknown_key_falls_back_and_is_counted() {
    let ledger = Arc::new(Ledgerish::default());
    let forms = Arc::new(Forms::default());
    let g = gateway(&ledger, Some(&forms), KEY_A, None).await;
    assert_eq!(g.call(false).await, (StatusCode::OK, false));
    ledger.settled(1).await;
    forms.rewrite(|value| {
        let call = value.rsplit(':').next().unwrap();
        format!("v1:keyed:0000000000000000:{call}")
    });
    // The canonical form is this call's own: its key row replays it.
    assert_eq!(g.call(false).await, (StatusCode::OK, true));
    assert_eq!(g.forms_metric("unknown_record").await, "1");
    assert_eq!(ledger.charges(), 1);
    g.shutdown().await;
}

// A keyed record whose call the ledger does not hold — in practice a
// reservation whose request has not claimed yet, or never did: the claim by
// that id inserts the call under it, keyed. Counted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_keyed_record_naming_a_call_the_ledger_lacks_is_claimed_under_that_id() {
    let ledger = Arc::new(Ledgerish::default());
    let forms = Arc::new(Forms::default());
    let g = gateway(&ledger, Some(&forms), KEY_A, Some(KEY_B)).await;
    assert_eq!(g.call(false).await, (StatusCode::OK, false));
    ledger.settled(1).await;
    ledger.0.lock().unwrap().keys.clear();
    let lost = Uuid::now_v7();
    let kid_b = ClaimKey::new(&KEY_B).unwrap().id().to_owned();
    forms.rewrite(|_| format!("v1:keyed:{kid_b}:{lost}"));
    assert_eq!(g.call(false).await, (StatusCode::OK, false));
    assert_eq!(g.forms_metric("orphaned").await, "1");
    let last = ledger.claims().last().cloned().unwrap();
    assert_eq!((last.call, last.status), (lost, "claimed"));
    assert_every_claim_keyed(&[last]);
    g.shutdown().await;
}

// A plain record whose call the ledger does not hold (the previous image
// writes one only after its claim inserted, so this means the call was
// lost): confirmed by a read first, and never claimed by that id — which
// would store the unkeyed fingerprint on a new row. The canonical, keyed
// form instead. Counted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_plain_record_naming_a_lost_call_never_inserts_an_unkeyed_fingerprint() {
    let ledger = Arc::new(Ledgerish::default());
    let forms = Arc::new(Forms::default());
    let g = gateway(&ledger, Some(&forms), KEY_A, None).await;
    assert_eq!(g.call(false).await, (StatusCode::OK, false));
    ledger.settled(1).await;
    as_the_previous_image_stored_it(&ledger, Some(&forms));
    let lost = Uuid::now_v7();
    forms.rewrite(|value| {
        let (form, _) = value.rsplit_once(':').unwrap();
        format!("{form}:{lost}")
    });
    assert_eq!(g.call(false).await, (StatusCode::OK, false));
    assert_eq!(g.forms_metric("orphaned").await, "1");
    let last = ledger.claims().last().cloned().unwrap();
    assert_ne!(last.call, lost);
    assert_eq!(last.status, "claimed");
    assert_ne!(last.fingerprint, plain_fingerprint(&call_body()));
    assert_every_claim_keyed(&[last]);
    g.shutdown().await;
}

// tuzi#2670: the ledger's key row lives 24 h, so a plain-form call retried
// keyed in the last minutes of that window must still find its record and
// replay. With the old 23 h 50 m TTL this retry, at 23 h 55 m, found nothing
// and was charged.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_plain_form_call_in_the_last_minutes_of_its_key_window_replays() {
    let age = LEDGER_KEY_LIFETIME - Duration::from_secs(5 * 60);
    let clock = Clock::default();
    let (charges, g) = plain_then_keyed_at(age, Forms::on(&clock)).await;
    assert_eq!(charges, 1, "charged once");
    assert_eq!(g.forms_metric("straddle").await, "1");
    g.shutdown().await;
}

// The negative control for the test above: the same retry against records
// that live 23 h 50 m — the TTL this replaced — is charged twice and counted
// only as a miss. So the clock above really expires records and key rows,
// and the replay there is the TTL's doing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_records_shorter_lived_than_the_key_the_last_minutes_are_charged_twice() {
    let age = LEDGER_KEY_LIFETIME - Duration::from_secs(5 * 60);
    let clock = Clock::default();
    let forms = Forms {
        ttl_override: Some(Duration::from_secs(23 * 3600 + 50 * 60)),
        ..Forms::on(&clock)
    };
    let (charges, g) = plain_then_keyed_at(age, forms).await;
    assert_eq!(charges, 2, "the bug");
    assert_eq!(
        g.forms_metric("miss").await,
        "2",
        "the first call's and the retry's"
    );
    assert_eq!(g.forms_metric("straddle").await, "0");
    g.shutdown().await;
}

// The record outlives the ledger key row it describes. At the instant the
// key row dies the record is still live; a keyed retry of a plain-form call
// after that, in the margin, replays the recorded call (call rows live 90
// days) rather than charging; once the record expires too, a retry is the
// new call the contract promises after 24 hours.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_record_outlives_the_ledger_key_and_then_expires() {
    assert!(RECORD_TTL > LEDGER_KEY_LIFETIME, "{RECORD_TTL:?}");
    let clock = Clock::default();
    let ledger = Arc::new(Ledgerish::on(&clock));
    let forms = Arc::new(Forms::on(&clock));
    let g = gateway(&ledger, Some(&forms), KEY_A, None).await;
    assert_eq!(g.call(false).await, (StatusCode::OK, false));
    ledger.settled(1).await;
    as_the_previous_image_stored_it(&ledger, Some(&forms));

    clock.set(LEDGER_KEY_LIFETIME);
    assert_eq!(forms.live().len(), 1, "live when the key row expires");
    let margin = RECORD_TTL - LEDGER_KEY_LIFETIME;
    clock.set(LEDGER_KEY_LIFETIME + margin / 2);
    assert_eq!(g.call(false).await, (StatusCode::OK, true), "replayed");
    assert_eq!(ledger.charges(), 1);
    assert_eq!(ledger.inserted().len(), 1, "nothing newly stored");

    clock.set(RECORD_TTL);
    assert!(forms.live().is_empty(), "expired at its TTL");
    assert_eq!(g.call(false).await, (StatusCode::OK, false), "a new call");
    ledger.settled(2).await;
    assert_eq!(ledger.charges(), 2);
    assert_eq!(
        g.forms_metric("miss").await,
        "2",
        "the first call's and this one's"
    );
    assert_eq!(g.forms_metric("straddle").await, "1");
    g.shutdown().await;
}

/// Two same-key requests, sent at once to `a` and `b` (which may be one
/// gateway), as the apps `child_a` / `child_b`; both reach the form store
/// together when `forms` holds a race barrier. Their `(status, replayed)`.
async fn race(a: &Gateway, b: &Gateway, child_a: bool, child_b: bool) -> [(StatusCode, bool); 2] {
    let (x, y) = tokio::join!(a.call(child_a), b.call(child_b));
    [x, y]
}

/// Exactly one of the pair was admitted as a new call: one fresh `200`,
/// and the other a replay or `409` (the call is still running).
fn admitted_once(outcomes: [(StatusCode, bool); 2]) {
    let fresh = outcomes
        .iter()
        .filter(|o| **o == (StatusCode::OK, false))
        .count();
    assert_eq!(fresh, 1, "{outcomes:?}");
    assert!(
        outcomes.iter().all(|o| *o == (StatusCode::OK, false)
            || *o == (StatusCode::OK, true)
            || o.0 == StatusCode::CONFLICT),
        "{outcomes:?}"
    );
}

/// One outcome's count, summed over `gateways`.
async fn total(gateways: &[&Gateway], outcome: &str) -> u32 {
    let mut sum = 0;
    for g in gateways {
        sum += g.forms_metric(outcome).await.parse::<u32>().unwrap();
    }
    sum
}

/// The `Idempotency-Key` HMAC a claim carries under `secret`, computed
/// here independently (pinned in `meter`'s unit tests).
fn keyed_key(secret: [u8; 32]) -> String {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &secret);
    let mut ctx = ring::hmac::Context::with_key(&key);
    ctx.update(b"f2z-ai idempotency-key v1\0");
    ctx.update(RAW_KEY.as_bytes());
    ctx.sign()
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The `(key HMAC, call)` of the request that reserved the live record:
/// it claims the recorded call under the server key the record names.
fn reserver(forms: &Forms) -> Option<(String, Uuid)> {
    let value = forms.live().into_iter().next()?;
    let record = f2z_ai::idempotency::Record::parse(&value)?;
    let f2z_ai::idempotency::Form::Keyed(kid) = record.form else {
        return None;
    };
    let secret = [KEY_A, KEY_B]
        .into_iter()
        .find(|k| ClaimKey::new(k).unwrap().id() == kid)?;
    Some((keyed_key(secret), record.call))
}

fn claim_of(op: &Operation) -> Option<(&str, Uuid)> {
    match op {
        Operation::Claim {
            key: Some(key),
            call,
            ..
        } => Some((key.as_str(), *call)),
        _ => None,
    }
}

// Cross-form admission is atomic (zuu#1225). Two pods either side of step 2
// of a rotation — one with current key A, one with current key B, each
// holding the other as previous — derive different forms for the same key.
// Sent at once, both reach Redis before either has claimed; the reservation
// lets exactly one through and the other names its call. Both ledger orders
// are forced: the reserver's claim first (the other is refused as pending or
// replayed), and the other's first (it inserts the reserved call, counted
// `orphaned`; the reserver is then refused). One call, one charge, each way.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_requests_in_two_forms_are_admitted_and_charged_once() {
    for reserver_first in [true, false, true, false] {
        let ledger = Arc::new(Ledgerish::default());
        let forms = Arc::new(Forms::racing(false));
        let f = Arc::clone(&forms);
        let slow: Slow = Arc::new(move |op| {
            let (Some((key, _)), Some((reserver_key, _))) = (claim_of(op), reserver(&f)) else {
                return false;
            };
            (key == reserver_key) == !reserver_first
        });
        ledger.0.lock().unwrap().slow = Some(slow);
        let a = gateway(&ledger, Some(&forms), KEY_A, Some(KEY_B)).await;
        let b = gateway(&ledger, Some(&forms), KEY_B, Some(KEY_A)).await;
        admitted_once(race(&a, &b, false, false).await);
        ledger.settled(1).await;
        let order = format!("reserver_first={reserver_first}");
        assert_eq!(ledger.inserted().len(), 1, "{order}: one call");
        assert_eq!(ledger.charges(), 1, "{order}: one charge");
        assert_every_claim_keyed(&ledger.claims());
        assert_eq!(total(&[&a, &b], "straddle").await, 1, "{order}");
        assert_eq!(
            total(&[&a, &b], "orphaned").await,
            u32::from(!reserver_first),
            "{order}"
        );
        a.shutdown().await;
        b.shutdown().await;
    }
}

// A reservation whose claim never landed (the ledger failed it) names a call
// that does not exist. Whichever form retries next claims that very id, and
// every later retry, in either form, finds that one call: one charge.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reservation_whose_claim_failed_becomes_one_call_in_either_form() {
    let ledger = Arc::new(Ledgerish::default());
    let forms = Arc::new(Forms::default());
    let a = gateway(&ledger, Some(&forms), KEY_A, Some(KEY_B)).await;
    let b = gateway(&ledger, Some(&forms), KEY_B, Some(KEY_A)).await;
    ledger.0.lock().unwrap().fail_claims = 2;
    assert_eq!(a.call(false).await.0, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(ledger.inserted().len(), 0);
    let (_, reserved) = reserver(&forms).unwrap();

    assert_eq!(b.call(false).await, (StatusCode::OK, false));
    ledger.settled(1).await;
    assert_eq!(ledger.inserted()[0].call, reserved, "the reserved id");
    assert_eq!(a.call(false).await, (StatusCode::OK, true), "replayed");
    assert_eq!(b.call(false).await, (StatusCode::OK, true), "replayed");
    assert_eq!(ledger.inserted().len(), 1);
    assert_eq!(ledger.charges(), 1, "one charge");
    a.shutdown().await;
    b.shutdown().await;
}

// Two same-form requests at once on a pod holding keys A and B; the one that
// did not reserve reaches the ledger first. It claims the reserved call id —
// not a fresh one — so the record under every key name still names the call
// that exists, and a retry on a pod whose current key is B replays it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_same_form_race_then_a_retry_in_the_other_form_is_one_call() {
    let ledger = Arc::new(Ledgerish::default());
    let forms = Arc::new(Forms::racing(false));
    let f = Arc::clone(&forms);
    let slowed = Arc::new(AtomicBool::new(false));
    let once = Arc::clone(&slowed);
    // Hold back the first claim of the reserved call: the reserver's.
    let slow: Slow = Arc::new(move |op| {
        let (Some((_, call)), Some((_, reserved))) = (claim_of(op), reserver(&f)) else {
            return false;
        };
        call == reserved && !once.swap(true, Ordering::SeqCst)
    });
    ledger.0.lock().unwrap().slow = Some(slow);
    let a = gateway(&ledger, Some(&forms), KEY_A, Some(KEY_B)).await;
    admitted_once(race(&a, &a, false, false).await);
    ledger.settled(1).await;
    assert!(slowed.load(Ordering::SeqCst));
    *forms.race.lock().unwrap() = None;
    ledger.0.lock().unwrap().slow = None;

    let b = gateway(&ledger, Some(&forms), KEY_B, Some(KEY_A)).await;
    assert_eq!(b.call(false).await, (StatusCode::OK, true), "replayed");
    assert_eq!(ledger.inserted().len(), 1, "one call");
    assert_eq!(ledger.charges(), 1, "one charge");
    a.shutdown().await;
    b.shutdown().await;
}

// The negative control: the same race against a form store whose
// reservation is a read and then a write — the lookup-before-claim,
// record-after-claim of the image before zuu#1225 — admits both, and both
// are charged. So the single admission above is the atomic reservation's
// doing.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn without_an_atomic_reservation_a_two_form_race_is_charged_twice() {
    let ledger = Arc::new(Ledgerish::default());
    let forms = Arc::new(Forms::racing(true));
    let a = gateway(&ledger, Some(&forms), KEY_A, Some(KEY_B)).await;
    let b = gateway(&ledger, Some(&forms), KEY_B, Some(KEY_A)).await;
    assert_eq!(
        race(&a, &b, false, false).await,
        [(StatusCode::OK, false), (StatusCode::OK, false)]
    );
    ledger.settled(2).await;
    assert_eq!(ledger.inserted().len(), 2);
    assert_eq!(ledger.charges(), 2, "the bug");
    a.shutdown().await;
    b.shutdown().await;
}

// The developer-flip window (tuzi#2683's runbook residual risk): before
// zuu#1225 a same-key request from a token issued before an app's
// `child_directed` flip and one issued after derived different forms, and
// sent at once could both be charged. Both audiences now derive one form,
// so the ledger's key row alone admits one call — even with a non-atomic
// form store. The window no longer exists.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_requests_across_a_child_directed_flip_are_admitted_once() {
    let ledger = Arc::new(Ledgerish::default());
    let forms = Arc::new(Forms::racing(true));
    let g = gateway(&ledger, Some(&forms), KEY_A, None).await;
    admitted_once(race(&g, &g, false, true).await);
    ledger.settled(1).await;
    assert_eq!(ledger.inserted().len(), 1, "one call");
    assert_eq!(ledger.charges(), 1, "one charge");
    assert_every_claim_keyed(&ledger.claims());
    g.shutdown().await;
}

// zuu#1226 review, B1. A reservation whose claim failed is claimed later by
// a retry that inserts the call under the recorded id. The record must then
// live a full `RECORD_TTL` from that insert, not from the reservation:
// otherwise, across a rotation, a retry after the reservation's record
// expired but inside the inserted key row's 24 h derives the other key's
// form, finds no record, and is charged a second time.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_late_insert_under_a_recorded_id_keeps_its_record_for_a_full_ttl() {
    let clock = Clock::default();
    let ledger = Arc::new(Ledgerish::on(&clock));
    let forms = Arc::new(Forms::on(&clock));
    let a = gateway(&ledger, Some(&forms), KEY_A, Some(KEY_B)).await;
    ledger.0.lock().unwrap().fail_claims = 2;
    assert_eq!(a.call(false).await.0, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(ledger.inserted().len(), 0);

    clock.set(Duration::from_secs(3600));
    assert_eq!(a.call(false).await, (StatusCode::OK, false));
    ledger.settled(1).await;
    a.shutdown().await;

    // Swapped: current B, previous A. 24 h 15 m after the reservation, 23 h
    // 15 m after the insert: the key row (under A) lives, and so must the
    // record that maps B's form onto it.
    let b = gateway(&ledger, Some(&forms), KEY_B, Some(KEY_A)).await;
    clock.set(LEDGER_KEY_LIFETIME + Duration::from_secs(15 * 60));
    assert_eq!(b.call(false).await, (StatusCode::OK, true), "replayed");
    assert_eq!(ledger.inserted().len(), 1, "one call");
    assert_eq!(ledger.charges(), 1, "one charge");
    b.shutdown().await;
}

// zuu#1226 review, B2. A retry that names a recorded call (its own form, or
// another) and whose claim then fails did not create that call and never
// held for it: it must not hand the call to the settler, whose no-hold
// completion would release another request's live call and make the key
// replay this request's error for 24 h.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retry_whose_claim_fails_never_finalizes_the_call_it_named() {
    for rotated in [false, true] {
        let ledger = Arc::new(Ledgerish::default());
        let forms = Arc::new(Forms::default());
        let first = gateway(&ledger, Some(&forms), KEY_A, Some(KEY_B)).await;
        assert_eq!(first.call(false).await, (StatusCode::OK, false));
        ledger.settled(1).await;
        let call = ledger.inserted()[0].call;
        let completes = |ledger: &Ledgerish| {
            ledger
                .0
                .lock()
                .unwrap()
                .completes
                .iter()
                .filter(|(c, _)| *c == call)
                .count()
        };
        let before = completes(&ledger);

        // The same form (a recorded id), or the other key's (a straddle).
        let retry = if rotated {
            gateway(&ledger, Some(&forms), KEY_B, Some(KEY_A)).await
        } else {
            first
        };
        ledger.0.lock().unwrap().fail_claims = 2;
        assert_eq!(retry.call(false).await.0, StatusCode::SERVICE_UNAVAILABLE);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(completes(&ledger), before, "rotated={rotated}");
        assert_eq!(ledger.charges(), 1);
        retry.shutdown().await;
    }
}

/// The no-hold `Complete`s the ledger received for `call`: what a request
/// that never held sends from its settlement guard, and what releases a call
/// that is between its claim and its hold.
fn no_hold_completes_of(ledger: &Ledgerish, call: Uuid) -> usize {
    ledger
        .0
        .lock()
        .unwrap()
        .completes
        .iter()
        .filter(|(c, no_hold)| *c == call && *no_hold)
        .count()
}

// zuu#1226 review round 2, B3 (1). The reserver's fresh id is published in
// Redis the moment it reserves, so it is no longer this request's alone. Its
// claim fails; a retry then claims that id and inserts the call. The failed
// reserver must hold no settlement authority over it: the only `Complete`
// the call ever sees is its winner's own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reserver_whose_claim_fails_never_finalizes_the_call_another_inserts() {
    let ledger = Arc::new(Ledgerish::default());
    let forms = Arc::new(Forms::default());
    let g = gateway(&ledger, Some(&forms), KEY_A, None).await;
    ledger.0.lock().unwrap().fail_claims = 2;
    assert_eq!(g.call(false).await.0, StatusCode::SERVICE_UNAVAILABLE);
    let (_, reserved) = reserver(&forms).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;

    assert_eq!(g.call(false).await, (StatusCode::OK, false));
    ledger.settled(1).await;
    assert_eq!(ledger.inserted()[0].call, reserved);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        no_hold_completes_of(&ledger, reserved),
        0,
        "none from the reserver"
    );
    assert_eq!(ledger.charges(), 1);
    g.shutdown().await;
}

// zuu#1226 review round 2, B3 (2). A claim of a recorded call that is still
// in flight when the request's start deadline passes is dropped, not
// failed: no error branch runs. It must still leave nothing that could
// finalize the named call.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_claim_cancelled_mid_flight_finalizes_nothing() {
    let ledger = Arc::new(Ledgerish::default());
    let forms = Arc::new(Forms::default());
    let g = gateway_with(
        &ledger,
        Some(&forms),
        KEY_A,
        None,
        &[("F2Z_AI_REQUEST_TIMEOUT_SECS", "1")],
    )
    .await;
    assert_eq!(g.call(false).await, (StatusCode::OK, false));
    ledger.settled(1).await;
    let call = ledger.inserted()[0].call;
    assert_eq!(no_hold_completes_of(&ledger, call), 0);
    {
        let mut book = ledger.0.lock().unwrap();
        book.slow = Some(Arc::new(|op| matches!(op, Operation::Claim { .. })));
        book.slow_for = Some(Duration::from_secs(3));
    }
    let (status, _) = g.call(false).await;
    assert_ne!(status, StatusCode::OK, "the start deadline passed");
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert_eq!(no_hold_completes_of(&ledger, call), 0, "nothing finalized");
    assert_eq!(ledger.charges(), 1);
    g.shutdown().await;
}

// zuu#1226 review round 2, N6: B1's renewal on the straddle path. A
// reservation under key A fails its claim; a pod on key B straddles and
// inserts the call (its key row under B). 24 h 15 m after the reservation a
// pod back on key A must still find the record, or its retry derives A's
// form, finds no key row under A, and is charged twice.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_late_straddle_insert_keeps_its_record_for_a_full_ttl() {
    let clock = Clock::default();
    let ledger = Arc::new(Ledgerish::on(&clock));
    let forms = Arc::new(Forms::on(&clock));
    let a = gateway(&ledger, Some(&forms), KEY_A, Some(KEY_B)).await;
    ledger.0.lock().unwrap().fail_claims = 2;
    assert_eq!(a.call(false).await.0, StatusCode::SERVICE_UNAVAILABLE);

    clock.set(Duration::from_secs(3600));
    let b = gateway(&ledger, Some(&forms), KEY_B, Some(KEY_A)).await;
    assert_eq!(b.call(false).await, (StatusCode::OK, false));
    ledger.settled(1).await;
    assert_eq!(b.forms_metric("straddle").await, "1");
    b.shutdown().await;

    clock.set(LEDGER_KEY_LIFETIME + Duration::from_secs(15 * 60));
    assert_eq!(a.call(false).await, (StatusCode::OK, true), "replayed");
    assert_eq!(ledger.inserted().len(), 1, "one call");
    assert_eq!(ledger.charges(), 1, "one charge");
    a.shutdown().await;
}
