//! Private acceptance consumer of the public Rust adapter; no SQL implementation.
use async_trait::async_trait;
use f2z_ai::ledger::{Failure, Identity, Ledger, Operation, Postgres, recover};
use secrecy::SecretString;
use serde_json::{Value, json};
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
    hold_attempt(identity, call, 1)
}
fn hold_attempt(identity: Identity, call: Uuid, attempt: i32) -> Operation {
    let (model, rate_card, amount_milli) = match attempt {
        1 => ("review-model", 99999, 10_000),
        2 => ("review-model-fallback", 100000, 15_000),
        _ => panic!("unexpected fixture attempt"),
    };
    Operation::Hold {
        identity,
        call,
        attempt,
        amount_milli,
        model: model.into(),
        rate_card,
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
    // The first release commits but its response is lost. Its identical
    // retry must not complete the call or reserve anything. Read the actual
    // envelope before hold 2, including its latest released usage winner.
    let lossy_release = LoseFirstReply {
        inner: &ledger,
        first: AtomicBool::new(true),
    };
    let release = Operation::Release {
        hold: hold_id,
        usage: json!({}),
    };
    assert_eq!(
        recover(&lossy_release, &release).await.unwrap()["status"],
        "released"
    );
    let switching = run(&ledger, Operation::Read { identity, call }).await;
    assert_eq!(switching["record"]["status"], "streaming");
    assert!(switching["record"]["completion"].is_null());
    assert_eq!(switching["record"]["settlement"]["outcome"], "released");
    assert_eq!(uuid(&switching["record"]["settlement"]["hold_id"]), hold_id);
    assert_eq!(
        run(&ledger, Operation::Context(identity)).await["available_milli_2z"],
        100_000
    );
    let winner = run(&ledger, hold_attempt(identity, call, 2)).await;
    assert_eq!(winner["status"], "held");
    assert_eq!(winner["amount"], 15_000);
    let winner_id = uuid(&winner["hold_id"]);
    assert_ne!(
        winner_id, hold_id,
        "attempt 2 needs its own hold key and identity"
    );
    let repeated_winner = run(&ledger, hold_attempt(identity, call, 2)).await;
    assert_eq!(repeated_winner["status"], "replayed");
    assert_eq!(uuid(&repeated_winner["hold_id"]), winner_id);
    let pending = run(&ledger, Operation::Read { identity, call }).await;
    assert_eq!(pending["record"]["status"], "streaming");
    // The last usage is still attempt 1's release; the live hold, rather
    // than that usage row, keeps the whole call nonterminal.
    assert_eq!(pending["record"]["settlement"]["outcome"], "released");
    let attempts = pending["record"]["attempts"].as_array().unwrap();
    assert_eq!(attempts.len(), 2);
    for (n, id, model, amount, card) in [
        (1, hold_id, "review-model", 10_000, 99999),
        (2, winner_id, "review-model-fallback", 15_000, 100000),
    ] {
        let attempt = attempts.iter().find(|a| a["attempt"] == n).unwrap();
        assert_eq!(uuid(&attempt["hold_id"]), id);
        assert_eq!(attempt["model"], model);
        assert_eq!(attempt["hold_milli_2z"], amount);
        assert_eq!(
            attempt["rate_card_id"],
            fixture[if card == 99999 {
                "primary_card"
            } else {
                "fallback_card"
            }]
        );
    }
    // Private harness revokes the admitted grant only after both holds and
    // the switching release committed.
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
            completion: json!({"model":"review-model-fallback","provider":"review-provider",
            "finish_reason":"stop","usage_source":"provider","partial":false,
            "usage":{"input_tokens":100,"output_tokens":20},"error":null}),
        },
    )
    .await;
    assert_eq!(completed["status"], "recorded");
    // Recover a lost hold response through the captured-identity completion
    // envelope, without reauthorizing claim/hold under the revoked generation.
    let attempts = completed["record"]["attempts"].as_array().unwrap();
    assert_eq!(attempts.len(), 2);
    let recovered_hold = uuid(&attempts.iter().find(|a| a["attempt"] == 2).unwrap()["hold_id"]);
    assert_eq!(recovered_hold, winner_id);
    assert_ne!(recovered_hold, hold_id);
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
            hold: winner_id,
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
    assert_eq!(
        record["record"]["request"]["requested_model"],
        "review-model"
    );
    assert_eq!(
        record["record"]["completion"]["model"],
        "review-model-fallback"
    );
    assert_eq!(
        record["record"]["settlement"]["model"],
        "review-model-fallback"
    );
    assert_eq!(uuid(&record["record"]["settlement"]["hold_id"]), winner_id);
    assert_eq!(record["record"]["attempts"].as_array().unwrap().len(), 2);
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
    assert_eq!(
        run(&ledger, claim(identity, other)).await["status"],
        "revoked"
    );
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
    println!(
        "PASS actual restricted adapter: two-attempt fallback, idempotent holds, lost release/settle replies, durable snapshots, revoked completion recovery, scope, terminal winners"
    );
}
