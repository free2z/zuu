//! Private acceptance consumer of the public Rust adapter; no SQL implementation.
use async_trait::async_trait;
use f2z_ai::ledger::{recover, Failure, Identity, Ledger, Operation, Postgres};
use secrecy::SecretString;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use uuid::Uuid;

struct LoseFirstReply<'a> {
    inner: &'a Postgres,
    first: AtomicBool,
}
#[async_trait]
impl Ledger for LoseFirstReply<'_> {
    async fn execute(&self, op: &Operation) -> Result<Value, Failure> {
        let result = self.inner.execute(op).await?;
        // Commit really happened; discard only its response, then retry the same op.
        if self.first.swap(false, Ordering::SeqCst) {
            Err(Failure)
        } else {
            Ok(result)
        }
    }
}
async fn run(ledger: &Postgres, op: Operation) -> Value {
    ledger
        .execute(&op)
        .await
        .expect("actual PostgreSQL adapter call")
}
fn uuid(value: &Value) -> Uuid {
    value.as_str().unwrap().parse().unwrap()
}
fn claim(identity: Identity, call: Uuid) -> Operation {
    Operation::Claim {
        identity,
        call,
        key: Some(call.to_string()),
        fingerprint: "a".repeat(64),
        request: json!({"model":"review-model","requested_model":"review-model",
            "provider":"review-provider","catalog_version":99999,"metadata":{"lesson":"quadratics"}}),
    }
}
fn hold(identity: Identity, call: Uuid) -> Operation {
    Operation::Hold {
        identity,
        call,
        amount_milli: 10_000,
        model: "review-model".into(),
        rate_card: 99999,
        catalog: "99999".into(),
        consented_markup: 0,
        provider: "review-provider".into(),
    }
}
#[tokio::main]
async fn main() {
    let fixture: Value =
        serde_json::from_str(&std::env::var("F2Z_PG_PROBE_CASE").unwrap()).unwrap();
    let identity: Identity = serde_json::from_value(fixture["identity"].clone()).unwrap();
    let foreign: Identity = serde_json::from_value(fixture["foreign"].clone()).unwrap();
    let call = uuid(&fixture["call"]);
    let other = uuid(&fixture["other_call"]);
    let dsn = SecretString::from(std::env::var("F2Z_PG_PROBE_DSN").unwrap());
    let ledger = Postgres::connect_loopback_test(&dsn, 2)
        .await
        .expect("restricted gateway connection");
    let context = run(&ledger, Operation::Context(identity)).await;
    assert_eq!(context["status"], "ok");
    assert_eq!(context["available_milli_2z"], 100_000);
    assert_eq!(
        run(&ledger, claim(identity, call)).await["status"],
        "claimed"
    );
    let held = run(&ledger, hold(identity, call)).await;
    assert_eq!(held["status"], "held");
    let hold_id = uuid(&held["hold_id"]);
    let repeated = run(&ledger, hold(identity, call)).await;
    assert_eq!(repeated["status"], "replayed");
    assert_eq!(repeated["hold_id"], held["hold_id"]);
    assert_eq!(
        run(
            &ledger,
            Operation::Read {
                identity: foreign,
                call
            }
        )
        .await["status"],
        "not_found"
    );
    assert_eq!(
        run(&ledger, claim(foreign, call)).await["status"],
        "conflict"
    );
    let mut stale = identity;
    stale.grant_generation -= 1;
    assert_eq!(run(&ledger, claim(stale, other)).await["status"], "revoked");
    // Private harness revokes the admitted grant only after the hold committed.
    println!("REVOKE_NOW");
    std::io::Write::flush(&mut std::io::stdout()).unwrap();
    let mut resume = String::new();
    std::io::stdin().read_line(&mut resume).unwrap();
    assert_eq!(resume.trim(), "revoked");
    let current = Identity {
        grant_generation: identity.grant_generation + 1,
        ..identity
    };
    // the application contract: the admitted identity still recovers its own pending call after
    // the bump (no new work, no new hold); only admission is refused.
    let recovered = run(&ledger, claim(identity, call)).await;
    assert_eq!(recovered["status"], "pending");
    assert_eq!(recovered["context"]["status"], "revoked");
    assert_eq!(
        run(&ledger, claim(identity, other)).await["status"],
        "revoked"
    );
    let completed = run(
        &ledger,
        Operation::Complete {
            identity,
            call,
            no_hold: false,
            completion: json!({"model":"review-model","provider":"review-provider",
            "finish_reason":"stop","usage_source":"provider","partial":false,
            "usage":{"input_tokens":100,"output_tokens":20},"error":null}),
        },
    )
    .await;
    assert_eq!(completed["status"], "recorded");
    // Recover a lost hold response through the captured-identity completion
    // envelope, without reauthorizing claim/hold under the revoked generation.
    let recovered_hold = uuid(&completed["record"]["attempts"][0]["hold_id"]);
    assert_eq!(recovered_hold, hold_id);
    let lossy = LoseFirstReply {
        inner: &ledger,
        first: AtomicBool::new(true),
    };
    let settled = recover(
        &lossy,
        &Operation::Settle {
            hold: recovered_hold,
            cost_nusd: 10_000_000,
            usage: json!({"input_tokens":100,"output_tokens":20}),
        },
    )
    .await
    .unwrap();
    assert_eq!(settled["status"], "settled");
    assert_eq!(settled["priced"], 2_000);
    assert_eq!(settled["charged"], 2_000);
    assert_eq!(settled["shortfall"], 0);
    assert!(settled["transfer_id"].as_i64().is_some());
    let released_after = run(
        &ledger,
        Operation::Release {
            hold: hold_id,
            usage: json!({}),
        },
    )
    .await;
    assert_eq!(released_after["status"], "settled");
    let record = run(
        &ledger,
        Operation::Read {
            identity: current,
            call,
        },
    )
    .await;
    assert_eq!(record["status"], "found");
    assert_eq!(record["record"]["status"], "settled");
    assert_eq!(record["record"]["settlement"]["collected_milli_2z"], 2_000);
    assert_eq!(
        record["record"]["settlement"]["transfer_id"],
        settled["transfer_id"]
    );
    assert_eq!(
        run(&ledger, claim(current, call)).await["status"],
        "replayed"
    );
    assert_eq!(
        run(&ledger, claim(current, other)).await["status"],
        "claimed"
    );
    // The superseded credential never sees work admitted under the later
    // generation, by id or by read; the caller re-authenticates instead.
    assert_eq!(run(&ledger, claim(identity, other)).await["status"], "revoked");
    assert_eq!(
        run(
            &ledger,
            Operation::Read {
                identity,
                call: other,
            }
        )
        .await["status"],
        "revoked"
    );
    let second = run(&ledger, hold(current, other)).await;
    let second_id = uuid(&second["hold_id"]);
    println!("EXPIRE_NOW {second_id}");
    std::io::Write::flush(&mut std::io::stdout()).unwrap();
    resume.clear();
    std::io::stdin().read_line(&mut resume).unwrap();
    assert_eq!(resume.trim(), "expired");
    let terminal = run(
        &ledger,
        Operation::Complete {
            identity: current,
            call: other,
            no_hold: false,
            completion: json!({"model":"review-model","provider":"review-provider",
            "finish_reason":"stop","usage_source":"provider","partial":false,
            "usage":{},"error":null}),
        },
    )
    .await;
    assert_eq!(terminal["record"]["status"], "released");
    let late = run(
        &ledger,
        Operation::Settle {
            hold: second_id,
            cost_nusd: 10_000_000,
            usage: json!({}),
        },
    )
    .await;
    assert_eq!(late["status"], "not_open");
    assert_eq!(late["state"], "expired");
    assert_eq!(late["charged"], 0);
    println!("PASS actual restricted adapter: claim/hold/settle/read, committed lost reply, revoked completion recovery, scope, terminal winners");
}
