//! Opt-in tests of the actual shipping PostgreSQL adapter against a synthetic ABI.
//! This is not evidence for private Django settlement or restricted-role grants.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
use f2z_ai::ledger::{Identity, Ledger, Operation, Postgres};
use secrecy::SecretString;
use serde_json::json;
use sqlx_core::{raw_sql::raw_sql, row::Row};
use sqlx_postgres::{PgConnectOptions, PgPool, PgPoolOptions};
use std::{net::IpAddr, sync::Arc, time::Duration};
use uuid::Uuid;

const FUNCTIONS: [(&str, &str); 8] = [
    ("context", "gateway_context(uuid,uuid,integer,integer)"),
    (
        "claim",
        "call_claim(uuid,uuid,integer,integer,uuid,text,text,jsonb)",
    ),
    ("read", "call_read(uuid,uuid,integer,integer,uuid)"),
    (
        "complete",
        "call_complete(uuid,uuid,integer,integer,uuid,jsonb,boolean)",
    ),
    (
        "hold",
        "hold(uuid,uuid,bigint,text,text,integer,integer,integer,integer,text,bigint,text,integer,jsonb)",
    ),
    ("extend", "extend(uuid,bigint,integer,integer,integer)"),
    ("settle", "settle(uuid,bigint,jsonb)"),
    ("release", "release(uuid,jsonb)"),
];

async fn install_function(pool: &PgPool, phase: &str, signature: &str) {
    // Only the fixed public signature inventory above is interpolated.
    raw_sql(&format!("CREATE FUNCTION ledger.{signature} RETURNS jsonb LANGUAGE sql AS $$ SELECT ledger.fixture_record('{phase}') $$"))
        .execute(pool).await.unwrap();
}

fn operations() -> Vec<Operation> {
    let identity = Identity {
        subject: Uuid::nil(),
        app: Uuid::nil(),
        account_epoch: 0,
        grant_generation: 0,
    };
    let call = Uuid::nil();
    vec![
        Operation::Context(identity),
        Operation::Claim {
            identity,
            call,
            key: Some("original:key".into()),
            fingerprint: "original:fingerprint".into(),
            request: json!({"request":"original"}),
        },
        Operation::Read { identity, call },
        Operation::Complete {
            identity,
            call,
            completion: json!({"completion":"original"}),
            no_hold: false,
        },
        Operation::Hold {
            identity,
            call,
            amount_milli: 1000,
            model: "original:model".into(),
            rate_card: 1,
            catalog: "original:catalog".into(),
            consented_markup: 0,
            provider: "original:provider".into(),
        },
        Operation::Extend {
            identity,
            hold: call,
            amount_milli: Some(2000),
        },
        Operation::Settle {
            hold: call,
            cost_nusd: 1000,
            usage: json!({"usage":"original"}),
        },
        Operation::Release {
            hold: call,
            usage: json!({"usage":"original"}),
        },
    ]
}

async fn audit(pool: &PgPool) -> Vec<(String, i64)> {
    sqlx_core::query::query("SELECT phase,xid FROM ledger.fixture_audit ORDER BY id")
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|r| (r.try_get("phase").unwrap(), r.try_get("xid").unwrap()))
        .collect()
}

#[tokio::test]
#[ignore = "requires explicit disposable loopback F2Z_AI_POLICY_FIXTURE_URL"]
async fn actual_adapter_pins_every_operation_and_fails_closed() {
    let url = std::env::var("F2Z_AI_POLICY_FIXTURE_URL")
        .expect("explicit disposable fixture URL required");
    let options: PgConnectOptions = url.parse().unwrap();
    assert!(
        options
            .get_host()
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
    );
    assert!(
        options
            .get_database()
            .is_some_and(|name| name.starts_with("f2z_ai_policy_fixture_"))
    );
    let secret: SecretString = url.into();
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .unwrap();
    // CREATE SCHEMA fails if a ledger already exists. Never overwrite its data.
    raw_sql(include_str!("fixtures/ledger_policy.sql"))
        .execute(&pool)
        .await
        .unwrap();
    for (phase, signature) in FUNCTIONS {
        install_function(&pool, phase, signature).await;
    }

    // Negative control: our fixture refuses a direct operation without prepare.
    assert!(
        sqlx_core::query::query("SELECT ledger.gateway_context(NULL,NULL,0,0)")
            .execute(&pool)
            .await
            .is_err()
    );
    for version in [0_i32, 1] {
        sqlx_core::query::query("UPDATE ledger.fixture_policy SET version=$1")
            .bind(version)
            .execute(&pool)
            .await
            .unwrap();
        raw_sql("TRUNCATE ledger.fixture_audit")
            .execute(&pool)
            .await
            .unwrap();
        let adapter = Postgres::connect_loopback_test(&secret, 2).await.unwrap();
        for ((phase, _), operation) in FUNCTIONS.iter().zip(operations()) {
            assert_eq!(
                adapter.execute(&operation).await.unwrap(),
                json!({"operation":phase})
            );
        }
        let rows = audit(&pool).await;
        assert_eq!(rows.len(), 17);
        assert_eq!(rows[0].0, "prepare"); // Startup, before any operation.
        for (pair, (phase, _)) in rows[1..].chunks_exact(2).zip(FUNCTIONS) {
            assert_eq!(
                (&pair[0].0, &pair[1].0),
                (&"prepare".to_owned(), &phase.to_owned())
            );
            assert_eq!(pair[0].1, pair[1].1); // Same transaction, before operation.
            assert_ne!(pair[0].1, rows[0].1); // Startup tag cannot authorize a call.
        }
    }

    let adapter = Arc::new(Postgres::connect_loopback_test(&secret, 2).await.unwrap());
    // Already-connected adapters must re-check each operation, not a cached epoch.
    for version in [Some(2_i32), None] {
        sqlx_core::query::query("UPDATE ledger.fixture_policy SET version=$1")
            .bind(version)
            .execute(&pool)
            .await
            .unwrap();
        let before = audit(&pool).await;
        for operation in operations() {
            assert!(adapter.execute(&operation).await.is_err());
        }
        assert!(Postgres::connect_loopback_test(&secret, 2).await.is_err());
        assert_eq!(audit(&pool).await, before); // Failed preparation rolls back.
    }
    raw_sql("UPDATE ledger.fixture_policy SET version=1,fenced=true")
        .execute(&pool)
        .await
        .unwrap();
    let before = audit(&pool).await;
    for operation in operations() {
        assert!(adapter.execute(&operation).await.is_err());
    }
    assert!(Postgres::connect_loopback_test(&secret, 2).await.is_err());
    assert_eq!(audit(&pool).await, before);
    raw_sql("UPDATE ledger.fixture_policy SET fenced=false")
        .execute(&pool)
        .await
        .unwrap();

    // An exclusive cutover lock refuses every operation before metadata locks.
    let mut cutover = pool.begin().await.unwrap();
    sqlx_core::query::query("SELECT id FROM ledger.fixture_policy WHERE id=1 FOR UPDATE")
        .execute(&mut *cutover)
        .await
        .unwrap();
    for operation in operations() {
        assert!(adapter.execute(&operation).await.is_err());
    }
    assert!(Postgres::connect_loopback_test(&secret, 2).await.is_err());
    cutover.rollback().await.unwrap();
    assert_eq!(audit(&pool).await, before);

    // Block operation metadata after preparation. Its shared policy lock must
    // remain held until the operation commits, preventing an intervening cutover.
    let mut blocker = pool.begin().await.unwrap();
    sqlx_core::query::query("SELECT id FROM ledger.fixture_operation_lock WHERE id=1 FOR UPDATE")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let running_adapter = Arc::clone(&adapter);
    let running = tokio::spawn(async move {
        running_adapter
            .execute(&Operation::Context(operations_identity()))
            .await
    });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    loop {
        let row = sqlx_core::query::query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT ledger.gateway_context%') AS waiting")
            .fetch_one(&pool).await.unwrap();
        if row.try_get::<bool, _>("waiting").unwrap() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "operation did not reach metadata barrier"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(
        sqlx_core::query::query(
            "SELECT id FROM ledger.fixture_policy WHERE id=1 FOR UPDATE NOWAIT"
        )
        .execute(&pool)
        .await
        .is_err()
    );
    blocker.rollback().await.unwrap();
    assert_eq!(
        running.await.unwrap().unwrap(),
        json!({"operation":"context"})
    );

    // Exact signature and return type are readiness requirements. A missing
    // non-policy function must also reject startup, even if prepare succeeds.
    for (phase, signature) in FUNCTIONS {
        raw_sql(&format!("DROP FUNCTION ledger.{signature}"))
            .execute(&pool)
            .await
            .unwrap();
        assert!(Postgres::connect_loopback_test(&secret, 2).await.is_err());
        install_function(&pool, phase, signature).await;
    }
    raw_sql("DROP FUNCTION ledger.prepare_economic_policy(integer,integer)")
        .execute(&pool)
        .await
        .unwrap();
    assert!(Postgres::connect_loopback_test(&secret, 2).await.is_err());
    for operation in operations() {
        assert!(adapter.execute(&operation).await.is_err());
    }
    raw_sql("CREATE FUNCTION ledger.prepare_economic_policy(integer,integer) RETURNS bigint LANGUAGE sql AS 'SELECT 1::bigint'").execute(&pool).await.unwrap();
    assert!(Postgres::connect_loopback_test(&secret, 2).await.is_err());
    for operation in operations() {
        assert!(adapter.execute(&operation).await.is_err());
    }
    raw_sql("DROP SCHEMA ledger CASCADE")
        .execute(&pool)
        .await
        .unwrap();
}

fn operations_identity() -> Identity {
    Identity {
        subject: Uuid::nil(),
        app: Uuid::nil(),
        account_epoch: 0,
        grant_generation: 0,
    }
}
