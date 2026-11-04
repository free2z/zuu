//! Explicit integration harness: Python supplies its isolated PostgreSQL case.
//! This tests the real journal/FIFO/exec boundary, not node or cryptographic proof.
use anyhow::{Result, ensure};
use serde::Deserialize;
use std::path::PathBuf;
use zcash_paymentd::{
    Event,
    chain::ObservedBlock,
    config::{Config, Consumer},
    delivery::{Automation, ExecAutomation},
    journal::{Journal, StateLock},
    now,
};

#[derive(Deserialize)]
struct Case {
    events: Vec<Event>,
    argv: Vec<String>,
    completed: PathBuf,
    #[serde(default)]
    observation_reorg: bool,
}

#[tokio::test]
#[ignore = "requires an explicitly supplied isolated PostgreSQL integration case"]
async fn serial_native_financial_capture() -> Result<()> {
    let path = std::env::var("PAYMENTD_NATIVE_BRIDGE_CASE")?;
    let case: Case = serde_json::from_slice(&std::fs::read(path)?)?;
    ensure!(
        case.events.len() == if case.observation_reorg { 1 } else { 2 },
        "bounded FIFO fixture required"
    );
    ensure!(case.events[0].kind == "payment.confirmed");
    ensure!(
        case.observation_reorg
            || matches!(
                case.events[1].kind.as_str(),
                "payment.observed" | "payment.confirmed"
            )
    );
    let dir = tempfile::TempDir::new()?;
    let hook = Consumer {
        id: "native-capture".into(),
        argv: case.argv,
        timeout_seconds: 20,
        observe_unconfirmed: true,
    };
    let c = Config {
        network: "main".into(),
        rpc_url: "http://127.0.0.1:8232".into(),
        rpc_cookie_file: None,
        ufvk_file: dir.path().join("unused-view-only-fixture"),
        state_dir: dir.path().join("state"),
        birthday_height: case.events[0].block_height,
        automation_start_height: case.events[0].block_height,
        confirmations: 3,
        poll_seconds: 1,
        max_tip_age_seconds: 900,
        max_tip_lag_blocks: 10,
        max_tip_future_seconds: 7200,
        consumers: vec![hook.clone()],
    };
    let _lock = StateLock::acquire(&c.state_dir)?;
    // No wallet scanning is claimed here. Real crypto/proof fixtures are separate.
    let mut observing = c.clone();
    observing.consumers.clear();
    let mut journal = Journal::open(&observing, "controlled-receiving-fixture")?;
    let mut previous = "fixture-parent".to_owned();
    for (index, event) in case.events.iter().enumerate() {
        let block = ObservedBlock {
            height: event.block_height,
            hash: event.block_hash.clone(),
            previous_hash: previous,
            payments: vec![event.payment.clone()],
        };
        if index == 0 || event.kind == "payment.confirmed" {
            journal.append(&block)?;
        } else {
            journal.observe(&block)?;
        }
        if case.observation_reorg {
            journal.rollback_one()?;
            journal.append(&block)?;
        }
        previous = event.block_hash.clone();
    }
    drop(journal);
    let handoff = Journal::enqueue_missing(
        &_lock,
        &c,
        "controlled-receiving-fixture",
        10_000,
        50_000,
        std::time::Duration::from_secs(20),
    )?;
    ensure!(handoff["inserted_deliveries"] == 2);
    let journal = Journal::open(&c, "controlled-receiving-fixture")?;
    ensure!(journal.status(&c)?["missing_deliveries"] == 0);
    journal.scanner_health(
        Some(case.events.last().unwrap().block_height),
        true,
        true,
        Some(now() + 60),
    )?;
    let automation = ExecAutomation(hook);
    for index in 0..2 {
        ensure!(journal.ready(&c)?, "delivery evidence expired");
        let next = journal.next("native-capture", now())?.expect("queued fact");
        if case.observation_reorg {
            ensure!(next.event.payment == case.events[0].payment);
            ensure!(
                next.event.kind
                    == if index == 0 {
                        "payment.revoked"
                    } else {
                        "payment.confirmed"
                    }
            );
            ensure!(next.event.revision == index + 1);
        } else {
            ensure!(next.event.payment == case.events[index as usize].payment);
            ensure!(next.event.kind == case.events[index as usize].kind);
        }
        automation.handle(&next.event).await?;
        journal.acknowledge("native-capture", &next.event.event_id)?;
    }
    ensure!(journal.next("native-capture", now())?.is_none());
    std::fs::write(
        case.completed,
        b"two real native FIFO deliveries acknowledged\n",
    )?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires an explicitly supplied isolated PostgreSQL integration case"]
async fn native_financial_timeout() -> Result<()> {
    let path = std::env::var("PAYMENTD_NATIVE_BRIDGE_CASE")?;
    let case: Case = serde_json::from_slice(&std::fs::read(path)?)?;
    ensure!(case.events.len() == 1);
    let automation = ExecAutomation(Consumer {
        id: "native-timeout-settle".into(),
        argv: case.argv,
        timeout_seconds: 5,
        observe_unconfirmed: false,
    });
    ensure!(
        automation.handle(&case.events[0]).await.is_err(),
        "blocked financial hook must time out"
    );
    std::fs::write(case.completed, b"native financial group terminated\n")?;
    Ok(())
}
