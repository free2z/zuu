use anyhow::Result;
use rusqlite::{Connection, params};
use std::{os::unix::fs::PermissionsExt, time::Duration};
use tempfile::TempDir;
use zcash_paymentd::{
    Payment,
    chain::ObservedBlock,
    config::{Config, Consumer},
    journal::{Journal, StateLock},
};

fn config(dir: &TempDir) -> Config {
    Config {
        network: "main".into(),
        rpc_url: "http://127.0.0.1:8232".into(),
        rpc_cookie_file: None,
        ufvk_file: dir.path().join("key"),
        state_dir: dir.path().join("state"),
        birthday_height: 3_500_000,
        automation_start_height: 3_500_001,
        confirmations: 3,
        poll_seconds: 1,
        max_tip_age_seconds: 900,
        max_tip_lag_blocks: 10,
        max_tip_future_seconds: 7200,
        consumers: vec![],
    }
}
fn financial(c: &mut Config) {
    c.consumers = [true, false]
        .into_iter()
        .map(|capture| Consumer {
            id: if capture { "capture" } else { "settle" }.into(),
            observe_unconfirmed: capture,
            argv: vec!["/usr/bin/true".into()],
            timeout_seconds: 1,
        })
        .collect();
}
fn payment(index: usize) -> Payment {
    Payment {
        id: format!("main:tx:ironwood:{index}"),
        txid: "tx".into(),
        pool: "ironwood".into(),
        output_index: index,
        value_zatoshis: 90_000,
        memo_hex: hex::encode([0xf6; 512]),
        recipient_hex: hex::encode([0; 43]),
    }
}
fn block(height: u32, hash: &str, previous: &str, indexes: &[usize]) -> ObservedBlock {
    ObservedBlock {
        height,
        hash: hash.into(),
        previous_hash: previous.into(),
        payments: indexes.iter().copied().map(payment).collect(),
    }
}
fn prime(c: &Config, lock: &StateLock) -> Result<serde_json::Value> {
    Journal::enqueue_missing(lock, c, "key", 10000, 50000, Duration::from_secs(2))
}
fn snapshot(c: &Config) -> Result<Vec<String>> {
    let db = Connection::open(c.state_dir.join("journal.sqlite"))?;
    let mut all = Vec::new();
    for table in [
        "meta",
        "blocks",
        "receipts",
        "events",
        "consumers",
        "subscriptions",
        "deliveries",
    ] {
        let mut q = db.prepare(&format!("SELECT * FROM {table} ORDER BY 1,2"))?;
        let n = q.column_count();
        let rows = q
            .query_map([], |r| {
                let values = (0..n)
                    .map(|i| format!("{:?}", r.get_ref(i).unwrap()))
                    .collect::<Vec<_>>();
                Ok(format!("{table}:{values:?}"))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        all.extend(rows);
    }
    Ok(all)
}
#[test]
fn observation_to_financial_queues_is_explicit_atomic_and_idempotent() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", &[9]))?;
    j.observe(&block(c.automation_start_height, "b", "a", &[0, 1]))?;
    j.reconcile_confirmations(c.automation_start_height)?;
    drop(j);
    financial(&mut c);
    let j = Journal::inspect(&c)?;
    assert!(j.next("capture", i64::MAX)?.is_none());
    assert_eq!(j.status(&c)?["missing_deliveries"], 6);
    drop(j);
    let before = snapshot(&c)?;
    let proof = prime(&c, &_lock)?;
    assert_eq!(proof["inserted_deliveries"], 6);
    assert_eq!(proof["inserted_subscriptions"], 4);
    assert_eq!(proof["missing_deliveries_after"], 0);
    assert_eq!(proof["boundary_sequence"], 4);
    assert_eq!(
        Journal::inspect(&c)?.status(&c)?["inventory_bytes"],
        proof["inventory_bytes"]
    );
    assert_eq!(
        Journal::inspect(&c)?.status(&c)?["inventory_byte_limit"],
        67_108_864
    );
    let j = Journal::open(&c, "key")?;
    for (id, expected) in [
        (
            "capture",
            vec![
                "payment.observed",
                "payment.observed",
                "payment.confirmed",
                "payment.confirmed",
            ],
        ),
        ("settle", vec!["payment.confirmed", "payment.confirmed"]),
    ] {
        for kind in expected {
            let d = j.next(id, i64::MAX)?.unwrap();
            assert_eq!(d.event.kind, kind);
            j.acknowledge(id, &d.event.event_id)?;
        }
        assert!(j.next(id, i64::MAX)?.is_none());
    }
    assert_eq!(j.status(&c)?["missing_deliveries"], 0);
    drop(j);
    let done = snapshot(&c)?;
    let retry = prime(&c, &_lock)?;
    assert_eq!(retry["inserted_deliveries"], 0);
    assert_eq!(retry["existing_acked"], 6);
    assert_eq!(retry["inventory_sha256"], proof["inventory_sha256"]);
    assert_eq!(snapshot(&c)?, done);
    for row in before.iter().filter(|r| {
        r.starts_with("events:") || r.starts_with("receipts:") || r.starts_with("blocks:")
    }) {
        assert!(done.contains(row));
    }
    Ok(())
}
#[test]
fn unconfirmed_depth_loss_reorg_and_remine_never_backfill_superseded_positive_work() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", &[]))?;
    j.observe(&block(c.automation_start_height, "b", "a", &[0]))?;
    drop(j);
    financial(&mut c);
    prime(&c, &_lock)?;
    let mut j = Journal::open(&c, "key")?;
    assert!(j.next("settle", i64::MAX)?.is_none());
    let observed = j.next("capture", i64::MAX)?.unwrap();
    j.acknowledge("capture", &observed.event.event_id)?;
    j.reconcile_confirmations(c.automation_start_height)?;
    let confirmed = j.next("settle", i64::MAX)?.unwrap();
    j.acknowledge("settle", &confirmed.event.event_id)?;
    j.reconcile_confirmations(c.birthday_height)?;
    drop(j);
    let p = prime(&c, &_lock)?;
    assert_eq!(p["inserted_deliveries"], 0);
    let mut j = Journal::open(&c, "key")?;
    assert_eq!(
        j.next("settle", i64::MAX)?.unwrap().event.kind,
        "payment.revoked"
    );
    j.rollback_one()?;
    j.append(&block(c.automation_start_height, "c", "a", &[0]))?;
    drop(j);
    prime(&c, &_lock)?;
    let j = Journal::inspect(&c)?;
    assert_eq!(j.status(&c)?["missing_deliveries"], 0);
    let events = j.events(0, 100)?;
    assert_eq!(events.last().unwrap().revision, 3);
    let db = Connection::open(c.state_dir.join("journal.sqlite"))?;
    assert_eq!(db.query_row::<i64,_,_>("SELECT count(*) FROM deliveries WHERE consumer='settle' AND event_id LIKE '%:observed'",[],|r|r.get(0))?,0);
    Ok(())
}
#[test]
fn absent_subscriptions_do_not_hide_current_confirmed_or_revocation_entitlement() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", &[]))?;
    j.observe(&block(c.automation_start_height, "b", "a", &[0]))?;
    j.rollback_one()?;
    drop(j);
    financial(&mut c);
    let p = prime(&c, &_lock)?;
    assert_eq!(p["inserted_deliveries"], 1);
    let j = Journal::inspect(&c)?;
    assert!(j.next("settle", i64::MAX)?.is_none());
    assert_eq!(
        j.next("capture", i64::MAX)?.unwrap().event.kind,
        "payment.revoked"
    );
    Ok(())
}
#[test]
fn all_caps_identity_policy_corruption_and_deadlines_leave_every_row_unchanged() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", &[]))?;
    j.append(&block(c.automation_start_height, "b", "a", &[0, 1]))?;
    drop(j);
    financial(&mut c);
    let before = snapshot(&c)?;
    for (r, e, t) in [
        (1, 50_000, Duration::from_secs(1)),
        (10_000, 1, Duration::from_secs(1)),
        (10_000, 50_000, Duration::from_nanos(1)),
        (0, 1, Duration::from_secs(1)),
        (10_001, 1, Duration::from_secs(1)),
    ] {
        assert!(Journal::enqueue_missing(&_lock, &c, "key", r, e, t).is_err());
        assert_eq!(snapshot(&c)?, before);
    }
    assert!(
        Journal::enqueue_missing(&_lock, &c, "wrong", 10_000, 50_000, Duration::from_secs(1))
            .is_err()
    );
    assert_eq!(snapshot(&c)?, before);
    prime(&c, &_lock)?;
    c.consumers[0].observe_unconfirmed = false;
    let before = snapshot(&c)?;
    assert!(prime(&c, &_lock).is_err());
    assert_eq!(snapshot(&c)?, before);
    c.consumers[0].observe_unconfirmed = true;
    let db = Connection::open(c.state_dir.join("journal.sqlite"))?;
    db.execute(
        "UPDATE events SET body='invalid-private-body' WHERE seq=1",
        [],
    )?;
    let before = snapshot(&c)?;
    assert!(prime(&c, &_lock).is_err());
    assert_eq!(snapshot(&c)?, before);
    let invalid = Journal::inspect(&c)?.status(&c)?;
    assert_eq!(invalid["delivery_inventory_verified"], false);
    assert!(invalid["missing_deliveries"].is_null());
    Ok(())
}
#[test]
fn preexisting_acks_pending_attempts_errors_and_inactive_consumers_survive_handoff() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    financial(&mut c);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", &[]))?;
    j.append(&block(c.automation_start_height, "b", "a", &[0, 1]))?;
    let capture = j.next("capture", i64::MAX)?.unwrap();
    j.failed("capture", &capture, "exact private error")?;
    let settle = j.next("settle", i64::MAX)?.unwrap();
    j.acknowledge("settle", &settle.event.event_id)?;
    c.consumers.clear();
    drop(j);
    drop(Journal::open(&c, "key")?);
    financial(&mut c);
    let before = snapshot(&c)?;
    let p = prime(&c, &_lock)?;
    assert_eq!(p["inserted_deliveries"], 0);
    assert_eq!(p["existing_acked"], 1);
    assert_eq!(p["existing_pending"], 3);
    let after = snapshot(&c)?;
    assert_eq!(
        before
            .iter()
            .filter(|r| r.starts_with("deliveries:"))
            .collect::<Vec<_>>(),
        after
            .iter()
            .filter(|r| r.starts_with("deliveries:"))
            .collect::<Vec<_>>()
    );
    let j = Journal::inspect(&c)?;
    assert_eq!(j.next("capture", i64::MAX)?.unwrap().attempts, 1);
    Ok(())
}
#[test]
fn failure_halfway_through_insert_rolls_back_registration_and_every_queue_row() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", &[]))?;
    j.append(&block(c.automation_start_height, "b", "a", &[0, 1]))?;
    drop(j);
    financial(&mut c);
    let db = Connection::open(c.state_dir.join("journal.sqlite"))?;
    db.execute_batch("CREATE TRIGGER fail_second BEFORE INSERT ON deliveries WHEN (SELECT count(*) FROM deliveries)=1 BEGIN SELECT RAISE(ABORT,'fixture insertion failure'); END;")?;
    let before = snapshot(&c)?;
    assert!(prime(&c, &_lock).is_err());
    assert_eq!(snapshot(&c)?, before);
    db.execute_batch("DROP TRIGGER fail_second;")?;
    assert_eq!(prime(&c, &_lock)?["inserted_deliveries"], 4);
    assert_eq!(prime(&c, &_lock)?["inserted_deliveries"], 0);
    Ok(())
}
#[test]
fn explicit_cli_is_offline_sanitized_and_refuses_a_running_writer() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", &[]))?;
    j.append(&block(c.automation_start_height, "b", "a", &[0]))?;
    drop(j);
    financial(&mut c);
    std::fs::write(&c.ufvk_file, "key")?;
    std::fs::set_permissions(&c.ufvk_file, std::fs::Permissions::from_mode(0o600))?;
    let file = dir.path().join("config.toml");
    std::fs::write(
        &file,
        format!(
            "network='main'\nrpc_url='http://127.0.0.1:1'\nufvk_file={:?}\nstate_dir={:?}\nbirthday_height={}\nautomation_start_height={}\nconfirmations=3\npoll_seconds=1\nmax_tip_age_seconds=900\nmax_tip_lag_blocks=10\nmax_tip_future_seconds=7200\n[[consumers]]\nid='capture'\nargv=['/nonexistent-hook']\ntimeout_seconds=1\nobserve_unconfirmed=true\n[[consumers]]\nid='settle'\nargv=['/nonexistent-hook']\ntimeout_seconds=1\n",
            c.ufvk_file, c.state_dir, c.birthday_height, c.automation_start_height
        ),
    )?;
    let run = || {
        std::process::Command::new(env!("CARGO_BIN_EXE_zcash-paymentd"))
            .args(["--config", file.to_str().unwrap(), "enqueue-missing"])
            .output()
    };
    let result = run()?;
    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
    assert!(!String::from_utf8_lossy(&result.stderr).contains("ironwood"));
    drop(lock);
    let result = run()?;
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let p: serde_json::Value = serde_json::from_slice(&result.stdout)?;
    assert_eq!(p["inserted_deliveries"], 2);
    assert!(!String::from_utf8_lossy(&result.stdout).contains("main:tx"));
    let db = Connection::open(c.state_dir.join("journal.sqlite"))?;
    db.execute(
        "DELETE FROM deliveries WHERE consumer=?1",
        params!["settle"],
    )?;
    assert_eq!(Journal::inspect(&c)?.status(&c)?["missing_deliveries"], 1);
    Ok(())
}

#[test]
fn missing_entitled_revoke_survives_remine_and_never_resets_an_old_ack() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    financial(&mut c);
    let lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", &[]))?;
    j.append(&block(c.automation_start_height, "b", "a", &[0]))?;
    for consumer in ["capture", "settle"] {
        let d = j.next(consumer, i64::MAX)?.unwrap();
        j.acknowledge(consumer, &d.event.event_id)?;
    }
    j.rollback_one()?;
    j.append(&block(c.automation_start_height, "c", "a", &[0]))?;
    drop(j);
    let db = Connection::open(c.state_dir.join("journal.sqlite"))?;
    db.execute("DELETE FROM deliveries WHERE event_id LIKE '%:revoked'", [])?;
    db.execute("DELETE FROM subscriptions", [])?;
    let j = Journal::inspect(&c)?;
    assert_eq!(j.status(&c)?["missing_deliveries"], 2);
    drop(j);
    let proof = prime(&c, &lock)?;
    assert_eq!(proof["inserted_deliveries"], 2);
    assert_eq!(proof["inserted_subscriptions"], 2);
    let j = Journal::open(&c, "key")?;
    for consumer in ["capture", "settle"] {
        let revoke = j.next(consumer, i64::MAX)?.unwrap();
        assert_eq!(revoke.event.kind, "payment.revoked");
        j.acknowledge(consumer, &revoke.event.event_id)?;
        let next = j.next(consumer, i64::MAX)?.unwrap();
        assert_eq!(next.event.revision, 2);
        assert_eq!(next.event.kind, "payment.confirmed");
    }
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM deliveries WHERE acked=1 AND event_id LIKE '%:1:confirmed'",
            [],
            |r| r.get(0)
        )?,
        2
    );
    Ok(())
}

#[test]
fn empty_journal_policy_drift_and_wrong_profile_lock_fail_without_registration() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    financial(&mut c);
    let lock = StateLock::acquire(&c.state_dir)?;
    drop(Journal::open(&c, "key")?);
    let before = snapshot(&c)?;
    c.consumers[0].observe_unconfirmed = false;
    assert!(prime(&c, &lock).is_err());
    assert_eq!(snapshot(&c)?, before);
    c.consumers[0].observe_unconfirmed = true;
    let other = TempDir::new()?;
    let other_config = config(&other);
    let other_lock = StateLock::acquire(&other_config.state_dir)?;
    assert!(prime(&c, &other_lock).is_err());
    assert_eq!(snapshot(&c)?, before);
    assert_eq!(prime(&c, &lock)?["inserted_deliveries"], 0);
    Ok(())
}

#[test]
fn observation_only_confirm_revoke_remine_preserves_legacy_issuance_review_lineage() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", &[]))?;
    j.append(&block(c.automation_start_height, "b", "a", &[0]))?;
    j.rollback_one()?;
    j.append(&block(c.automation_start_height, "c", "a", &[0]))?;
    drop(j);
    financial(&mut c);
    assert_eq!(Journal::inspect(&c)?.status(&c)?["missing_deliveries"], 4);
    let proof = prime(&c, &lock)?;
    assert_eq!(proof["inserted_deliveries"], 4);
    let j = Journal::open(&c, "key")?;
    for consumer in ["capture", "settle"] {
        let revoke = j.next(consumer, i64::MAX)?.unwrap();
        assert_eq!(revoke.event.kind, "payment.revoked");
        assert_eq!(revoke.event.revision, 1);
        j.acknowledge(consumer, &revoke.event.event_id)?;
        let remine = j.next(consumer, i64::MAX)?.unwrap();
        assert_eq!(remine.event.kind, "payment.confirmed");
        assert_eq!(remine.event.revision, 2);
        j.acknowledge(consumer, &remine.event.event_id)?;
    }
    assert_eq!(prime(&c, &lock)?["inserted_deliveries"], 0);
    Ok(())
}

#[test]
fn retained_inventory_over_cap_keeps_health_diagnostics_but_never_reports_missing_zero()
-> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", &[]))?;
    let indexes = (0..10_001).collect::<Vec<_>>();
    j.append(&block(c.automation_start_height, "b", "a", &indexes))?;
    j.scanner_health(
        Some(c.automation_start_height),
        true,
        true,
        Some(zcash_paymentd::now() + 60),
    )?;
    drop(j);
    financial(&mut c);
    let reader = Journal::inspect(&c)?;
    let before = snapshot(&c)?;
    let status = reader.status(&c)?;
    assert_eq!(status["delivery_inventory_verified"], false);
    assert!(status["missing_deliveries"].is_null());
    assert!(
        status["delivery_inventory_error"]
            .as_str()
            .unwrap()
            .contains("unavailable")
    );
    assert_eq!(status["pending_deliveries"], 0);
    assert_eq!(status["failed_deliveries"], 0);
    assert_eq!(status["active_receipts"], 10_001);
    assert_eq!(status["inventory_receipt_count"], 10_001);
    assert_eq!(status["inventory_event_count"], 10_001);
    assert_eq!(status["inventory_receipt_limit"], 10_000);
    assert_eq!(status["inventory_event_limit"], 50_000);
    assert_eq!(status["cursor"][0], c.automation_start_height);
    assert_eq!(status["scanner"]["ok"], true);
    assert_eq!(snapshot(&c)?, before);
    Ok(())
}

#[test]
fn above_floor_revocation_survives_remine_and_removal_below_floor() -> Result<()> {
    for remove in [false, true] {
        let dir = TempDir::new()?;
        let mut c = config(&dir);
        let lock = StateLock::acquire(&c.state_dir)?;
        let mut j = Journal::open(&c, "key")?;
        j.append(&block(c.birthday_height, "a", "parent", &[]))?;
        j.append(&block(c.automation_start_height, "b", "a", &[0]))?;
        j.rollback_one()?;
        j.rollback_one()?;
        assert_eq!(j.append(&block(c.birthday_height, "c", "parent", &[0]))?, 0);
        if remove {
            j.rollback_one()?;
        }
        drop(j);
        financial(&mut c);
        let before = snapshot(&c)?;
        assert_eq!(Journal::inspect(&c)?.status(&c)?["missing_deliveries"], 2);
        let preview =
            Journal::handoff_revocations(&lock, &c, "key", 10000, 50000, Duration::from_secs(2))?;
        assert_eq!(preview["eligible_unacked_revocations"], 1);
        assert_eq!(preview["revocations"][0]["revision"], 1);
        assert_eq!(snapshot(&c)?, before);
        let proof = prime(&c, &lock)?;
        assert_eq!(proof["inserted_deliveries"], 2);
        assert_eq!(proof["inventory_sha256"], preview["inventory_sha256"]);
        let j = Journal::open(&c, "key")?;
        for consumer in ["capture", "settle"] {
            let event = j.next(consumer, i64::MAX)?.unwrap().event;
            assert_eq!(event.kind, "payment.revoked");
            assert_eq!(event.revision, 1);
            j.acknowledge(consumer, &event.event_id)?;
            assert!(j.next(consumer, i64::MAX)?.is_none());
        }
        assert_eq!(Journal::inspect(&c)?.events(0, 100)?.len(), 2);
        assert_eq!(prime(&c, &lock)?["inserted_deliveries"], 0);
    }
    Ok(())
}

#[test]
fn private_revocation_preview_includes_pending_on_retry_and_never_resets_acks() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", &[]))?;
    j.append(&block(c.automation_start_height, "b", "a", &[0]))?;
    j.rollback_one()?;
    j.append(&block(c.automation_start_height, "c", "a", &[0]))?;
    drop(j);
    financial(&mut c);
    let before = snapshot(&c)?;
    let preview =
        || Journal::handoff_revocations(&lock, &c, "key", 10000, 50000, Duration::from_secs(2));
    let first = preview()?;
    assert_eq!(first["eligible_unacked_revocations"], 1);
    assert_eq!(first["existing_pending"], 0);
    assert_eq!(snapshot(&c)?, before);
    assert!(!first.to_string().contains("memo"));
    assert!(!first.to_string().contains("value_zatoshis"));
    prime(&c, &lock)?;
    let primed = snapshot(&c)?;
    let retry = preview()?;
    assert_eq!(retry["eligible_unacked_revocations"], 1);
    assert_eq!(retry["existing_pending"], 4);
    assert_eq!(retry["inventory_sha256"], first["inventory_sha256"]);
    assert_eq!(snapshot(&c)?, primed);
    let j = Journal::open(&c, "key")?;
    let event = retry["revocations"][0]["event_id"].as_str().unwrap();
    j.acknowledge("capture", event)?;
    assert_eq!(preview()?["eligible_unacked_revocations"], 1);
    j.acknowledge("settle", event)?;
    assert_eq!(preview()?["eligible_unacked_revocations"], 0);
    assert_eq!(prime(&c, &lock)?["inserted_deliveries"], 0);
    Ok(())
}

#[test]
fn private_preview_cap_refuses_without_any_queue_or_registration_change() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", &[]))?;
    let indexes = (0..1001).collect::<Vec<_>>();
    j.append(&block(c.automation_start_height, "b", "a", &indexes))?;
    j.rollback_one()?;
    drop(j);
    financial(&mut c);
    let before = snapshot(&c)?;
    assert!(
        Journal::handoff_revocations(&lock, &c, "key", 10000, 50000, Duration::from_secs(2))
            .is_err()
    );
    assert_eq!(snapshot(&c)?, before);
    assert_eq!(
        Journal::inspect(&c)?.status(&c)?["missing_deliveries"],
        2002
    );
    Ok(())
}

#[test]
fn corrupt_event_with_below_floor_receipt_keeps_diagnostics_and_unknown_derived_counts()
-> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", &[9]))?;
    j.append(&block(c.automation_start_height, "b", "a", &[0]))?;
    j.scanner_health(
        Some(c.automation_start_height),
        true,
        true,
        Some(zcash_paymentd::now() + 60),
    )?;
    drop(j);
    financial(&mut c);
    let db = Connection::open(c.state_dir.join("journal.sqlite"))?;
    db.execute(
        "UPDATE events SET body='malformed private memo payload'",
        [],
    )?;
    let before = snapshot(&c)?;
    let status = Journal::inspect(&c)?.status(&c)?;
    assert_eq!(status["delivery_inventory_verified"], false);
    assert!(status["missing_deliveries"].is_null());
    assert!(status["inventory_receipt_count"].is_null());
    assert!(status["inventory_bytes"].is_null());
    assert_eq!(status["inventory_event_count"], 1);
    assert_eq!(status["cursor"][0], c.automation_start_height);
    assert_eq!(status["active_receipts"], 2);
    assert_eq!(status["pending_deliveries"], 0);
    assert_eq!(status["scanner"]["ok"], true);
    assert!(!status.to_string().contains("private memo"));
    assert!(prime(&c, &lock).is_err());
    assert_eq!(snapshot(&c)?, before);
    Ok(())
}
