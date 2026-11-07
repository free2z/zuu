use anyhow::Result;
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader},
    os::unix::fs::PermissionsExt,
    time::{Duration, Instant},
};
use tempfile::TempDir;
use zcash_paymentd::{
    Payment,
    chain::ObservedBlock,
    config::{Config, Consumer},
    journal::{Journal, StateLock},
};

fn measured_output(
    config: &std::path::Path,
    timeout: u64,
    output: Option<&std::path::Path>,
) -> Result<(bool, String, u64)> {
    let case = TempDir::new()?;
    let report = case.path().join("usage.json");
    let spec =
        serde_json::json!({"config":config,"timeout":timeout,"output":output,"report":report});
    // A fresh harness process isolates the measured daemon from this test
    // process's earlier fixture allocations (inherited fork high-water RSS).
    let wrapper = std::process::Command::new(std::env::current_exe()?)
        .args([
            "--exact",
            "measure_handoff_child",
            "--ignored",
            "--nocapture",
        ])
        .env("PAYMENTD_RSS_CASE", spec.to_string())
        .output()?;
    anyhow::ensure!(
        wrapper.status.success(),
        "RSS helper failed: {}",
        String::from_utf8_lossy(&wrapper.stderr)
    );
    let value: (bool, String, u64) = serde_json::from_slice(&std::fs::read(report)?)?;
    Ok(value)
}

#[test]
#[ignore = "internal RSS subprocess; requires an explicit isolated measurement case"]
fn measure_handoff_child() -> Result<()> {
    use std::{
        io::{Read, Seek},
        os::unix::process::ExitStatusExt,
    };
    let case: serde_json::Value = serde_json::from_str(&std::env::var("PAYMENTD_RSS_CASE")?)?;
    let mut stderr_file = tempfile::tempfile()?;
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_zcash-paymentd"));
    command
        .arg("--config")
        .arg(case["config"].as_str().unwrap())
        .args(["handoff-revocations-stream", "--timeout-seconds"])
        .arg(case["timeout"].as_u64().unwrap().to_string())
        .stderr(stderr_file.try_clone()?);
    if let Some(path) = case["output"].as_str() {
        command.stdout(std::fs::File::create(path)?);
    } else {
        command.stdout(std::process::Stdio::null());
    }
    let child = command.spawn()?;
    let mut status = 0;
    // wait4 fills both out-parameters for this exact owned child. No other
    // child reaper or fixture writer runs in this measurement process.
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    loop {
        let result = unsafe { libc::wait4(child.id() as libc::pid_t, &mut status, 0, &mut usage) };
        if result >= 0 {
            anyhow::ensure!(
                result == child.id() as libc::pid_t,
                "wait4 returned the wrong child"
            );
            break;
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error.into());
        }
    }
    let mut stderr = String::new();
    stderr_file.rewind()?;
    stderr_file.read_to_string(&mut stderr)?;
    let peak = u64::try_from(usage.ru_maxrss)?;
    anyhow::ensure!(peak > 0, "child RSS measurement unavailable");
    let peak_kib = if cfg!(target_os = "macos") {
        peak / 1024
    } else {
        peak
    };
    let result = (
        std::process::ExitStatus::from_raw(status).success(),
        stderr,
        peak_kib,
    );
    std::fs::write(
        case["report"].as_str().unwrap(),
        serde_json::to_vec(&result)?,
    )?;
    Ok(())
}

fn command_config(c: &Config, dir: &TempDir) -> Result<std::path::PathBuf> {
    std::fs::write(&c.ufvk_file, b"key")?;
    std::fs::set_permissions(&c.ufvk_file, std::fs::Permissions::from_mode(0o600))?;
    let value = serde_json::json!({
        "network":c.network,"rpc_url":c.rpc_url,"ufvk_file":c.ufvk_file,"state_dir":c.state_dir,
        "birthday_height":c.birthday_height,"automation_start_height":c.automation_start_height,
        "confirmations":c.confirmations,"poll_seconds":c.poll_seconds,
        "max_tip_age_seconds":c.max_tip_age_seconds,"max_tip_lag_blocks":c.max_tip_lag_blocks,
        "max_tip_future_seconds":c.max_tip_future_seconds,
        "consumers":c.consumers.iter().map(|consumer| serde_json::json!({"id":consumer.id,
            "argv":consumer.argv,"timeout_seconds":consumer.timeout_seconds,
            "observe_unconfirmed":consumer.observe_unconfirmed})).collect::<Vec<_>>()
    });
    let path = dir.path().join("paymentd.toml");
    std::fs::write(&path, toml::to_string(&value)?)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    Ok(path)
}

struct FailAtFooter(Vec<u8>);

#[test]
fn compiled_binary_reports_handoff_capabilities_without_reading_private_state() -> Result<()> {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_zcash-paymentd"))
        .args([
            "--config",
            "/nonexistent/handoff-capabilities.toml",
            "handoff-capabilities",
        ])
        .output()?;
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output.stdout)?,
        serde_json::json!({"schema":1,"stream_protocol":1,"enqueue_missing":true})
    );
    Ok(())
}

impl std::io::Write for FailAtFooter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes
            .windows(b"\"type\":\"footer\"".len())
            .any(|w| w == b"\"type\":\"footer\"")
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "fixture interruption",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

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
    Journal::enqueue_missing(lock, c, "key", Duration::from_secs(2))
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
    let after_handoff = Journal::inspect(&c)?.status(&c)?;
    assert_eq!(after_handoff["delivery_inventory_verified"], true);
    assert!(
        after_handoff["inventory_bytes"].as_u64().unwrap()
            > proof["inventory_bytes"].as_u64().unwrap()
    );
    assert_eq!(
        Journal::inspect(&c)?.status(&c)?["inventory_byte_limit"],
        4_i64 * 1024 * 1024 * 1024
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
    assert_ne!(retry["inventory_sha256"], proof["inventory_sha256"]);
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
fn identity_policy_corruption_and_deadlines_leave_every_row_unchanged() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let _lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", &[]))?;
    j.append(&block(c.automation_start_height, "b", "a", &[0, 1]))?;
    drop(j);
    financial(&mut c);
    let before = snapshot(&c)?;
    for timeout in [
        Duration::ZERO,
        Duration::from_nanos(1),
        Duration::from_secs(121),
    ] {
        assert!(Journal::enqueue_missing(&_lock, &c, "key", timeout).is_err());
        assert_eq!(snapshot(&c)?, before);
    }
    assert!(Journal::enqueue_missing(&_lock, &c, "wrong", Duration::from_secs(1)).is_err());
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
fn retained_inventory_above_old_cap_has_complete_health_coverage() -> Result<()> {
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
    assert_eq!(status["delivery_inventory_verified"], true);
    assert_eq!(status["missing_deliveries"], 20_002);
    assert!(status["delivery_inventory_error"].is_null());
    assert_eq!(status["pending_deliveries"], 0);
    assert_eq!(status["failed_deliveries"], 0);
    assert_eq!(status["active_receipts"], 10_001);
    assert_eq!(status["inventory_receipt_count"], 10_001);
    assert_eq!(status["inventory_event_count"], 10_001);
    assert!(status["inventory_receipt_limit"].is_null());
    assert!(status["inventory_event_limit"].is_null());
    assert_eq!(status["inventory_byte_limit"], 4_i64 * 1024 * 1024 * 1024);
    assert_eq!(status["cursor"][0], c.automation_start_height);
    assert_eq!(status["scanner"]["ok"], true);
    assert_eq!(snapshot(&c)?, before);
    Ok(())
}

#[test]
fn interrupted_stream_has_no_footer_and_restart_reproves_its_new_boundary() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", &[]))?;
    j.append(&block(c.automation_start_height, "b", "a", &[0]))?;
    drop(j);
    financial(&mut c);
    let before = snapshot(&c)?;
    let mut interrupted = FailAtFooter(Vec::new());
    assert!(
        Journal::handoff_revocations_stream(
            &lock,
            &c,
            "key",
            Duration::from_secs(2),
            &mut interrupted
        )
        .is_err()
    );
    let partial = String::from_utf8(interrupted.0).unwrap();
    assert!(partial.contains("\"type\":\"header\""));
    assert!(!partial.contains("\"type\":\"footer\""));
    assert_eq!(snapshot(&c)?, before);

    let mut complete = Vec::new();
    Journal::handoff_revocations_stream(&lock, &c, "key", Duration::from_secs(2), &mut complete)?;
    let first_header: serde_json::Value =
        serde_json::from_slice(complete.split(|b| *b == b'\n').next().unwrap())?;
    let first_boundary = first_header["proof"]["boundary_sequence"].as_u64().unwrap();
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.automation_start_height + 1, "c", "b", &[1]))?;
    drop(j);
    let mut restarted = Vec::new();
    Journal::handoff_revocations_stream(&lock, &c, "key", Duration::from_secs(2), &mut restarted)?;
    let restarted_header: serde_json::Value =
        serde_json::from_slice(restarted.split(|b| *b == b'\n').next().unwrap())?;
    assert!(
        restarted_header["proof"]["boundary_sequence"]
            .as_u64()
            .unwrap()
            > first_boundary
    );
    let restarted_lines = String::from_utf8(restarted).unwrap();
    let footer = restarted_lines.lines().last().unwrap();
    let footer: serde_json::Value = serde_json::from_str(footer)?;
    assert_eq!(
        footer["boundary_sequence"],
        restarted_header["proof"]["boundary_sequence"]
    );
    assert_eq!(
        footer["identity_sha256"],
        restarted_header["proof"]["identity_sha256"]
    );
    Ok(())
}

#[test]
fn streamed_handoff_covers_real_history_above_all_former_ceilings() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "birth", "parent", &[]))?;
    const RECEIPTS: usize = 13_000;
    const PER_BLOCK: usize = 1_000;
    for batch in 0..(RECEIPTS / PER_BLOCK) {
        let indexes = (batch * PER_BLOCK..(batch + 1) * PER_BLOCK).collect::<Vec<_>>();
        let previous = if batch == 0 {
            "birth".to_owned()
        } else {
            format!("block-{}", batch - 1)
        };
        let mut observed = block(
            c.automation_start_height + batch as u32,
            &format!("block-{batch}"),
            &previous,
            &indexes,
        );
        for payment in &mut observed.payments {
            payment.txid = format!("{:064x}", payment.output_index + 1);
            payment.id = format!("main:{}:ironwood:{}", payment.txid, payment.output_index);
        }
        j.append(&observed)?;
    }
    // Depth loss creates a second positive lifecycle and revocation for every
    // receipt; the subsequent canonical rollback adds the remine revocations.
    j.reconcile_confirmations(c.automation_start_height - 1)?;
    for _ in 0..(RECEIPTS / PER_BLOCK) {
        j.rollback_one()?;
    }
    drop(j);
    financial(&mut c);
    // Give both test consumers the observation entitlement so this long
    // history also stages more than 50,000 real delivery rows.
    c.consumers[1].observe_unconfirmed = true;

    let started = Instant::now();
    let status = Journal::inspect(&c)?.status(&c)?;
    assert_eq!(status["inventory_receipt_count"], RECEIPTS);
    assert_eq!(status["inventory_event_count"], 4 * RECEIPTS);
    assert!(status["inventory_bytes"].as_u64().unwrap() > 64 * 1024 * 1024);
    assert_eq!(status["delivery_inventory_verified"], true);
    assert!(status["missing_deliveries"].as_u64().unwrap() > 10_000);
    assert!(started.elapsed() < Duration::from_secs(30));

    let config_path = command_config(&c, &dir)?;
    let stream_path = dir.path().join("revocations.ndjson");
    drop(lock);
    let (success, stderr, peak_kib) = measured_output(&config_path, 120, Some(&stream_path))?;
    assert!(success, "compiled native stream CLI must succeed: {stderr}");
    assert!(
        peak_kib < 64 * 1024,
        "native stream peak RSS was {peak_kib} KiB"
    );
    let mut lines = BufReader::new(std::fs::File::open(&stream_path)?).lines();
    let header: serde_json::Value = serde_json::from_str(&lines.next().unwrap()?)?;
    assert_eq!(header["type"], "header");
    assert_eq!(header["protocol"], 1);
    assert_eq!(header["proof"]["receipt_count"], RECEIPTS);
    assert_eq!(header["proof"]["event_count"], 4 * RECEIPTS);
    let expected_count = header["revocation_count"].as_u64().unwrap();
    let mut count = 0_u64;
    let mut digest = Sha256::new();
    let mut footer_seen = false;
    for line in lines {
        let line = line?;
        let row: serde_json::Value = serde_json::from_str(&line)?;
        if row["type"] == "footer" {
            assert_eq!(count, expected_count);
            assert_eq!(row["revocation_count"], count);
            assert_eq!(
                row["revocation_sha256"],
                hex::encode(digest.clone().finalize())
            );
            assert_eq!(
                row["boundary_sequence"],
                header["proof"]["boundary_sequence"]
            );
            assert_eq!(row["inventory_sha256"], header["proof"]["inventory_sha256"]);
            assert_eq!(row["identity_sha256"], header["proof"]["identity_sha256"]);
            footer_seen = true;
            break;
        }
        assert_eq!(row["type"], "revocation");
        digest.update(line.as_bytes());
        digest.update(b"\n");
        count += 1;
    }
    assert!(footer_seen, "a complete stream must include its footer");
    assert!(count >= RECEIPTS as u64);
    let enqueued = std::process::Command::new(env!("CARGO_BIN_EXE_zcash-paymentd"))
        .arg("--config")
        .arg(&config_path)
        .arg("enqueue-missing")
        .arg("--timeout-seconds")
        .arg("120")
        .output()?;
    assert!(
        enqueued.status.success(),
        "compiled native stopped handoff CLI must succeed"
    );
    let handoff: serde_json::Value = serde_json::from_slice(&enqueued.stdout)?;
    assert!(handoff["inserted_deliveries"].as_u64().unwrap() > 50_000);
    assert!(handoff["inserted_subscriptions"].as_u64().unwrap() >= RECEIPTS as u64);
    assert_eq!(handoff["missing_deliveries_after"], 0);
    assert_eq!(
        handoff["inventory_sha256"],
        header["proof"]["inventory_sha256"]
    );
    let after_status = Journal::inspect(&c)?.status(&c)?;
    assert_eq!(after_status["delivery_inventory_verified"], true);
    assert_eq!(after_status["missing_deliveries"], 0);
    assert_eq!(after_status["inventory_event_count"], 4 * RECEIPTS);
    assert!(after_status["inventory_bytes"].as_u64().unwrap() > 64 * 1024 * 1024);
    assert!(started.elapsed() < Duration::from_secs(120));
    let db = Connection::open(c.state_dir.join("journal.sqlite"))?;
    assert_eq!(
        db.query_row("SELECT count(*) FROM events", [], |r| r.get::<_, i64>(0))?,
        4 * RECEIPTS as i64,
        "streaming remains read only"
    );
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
    assert_ne!(retry["inventory_sha256"], first["inventory_sha256"]);
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
fn private_preview_supports_more_than_one_thousand_revocations() -> Result<()> {
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
    let preview =
        Journal::handoff_revocations(&lock, &c, "key", 10000, 50000, Duration::from_secs(10))?;
    assert_eq!(preview["eligible_unacked_revocations"], 1001);
    assert_eq!(preview["revocations"].as_array().unwrap().len(), 1001);
    assert_eq!(snapshot(&c)?, before);
    assert_eq!(
        Journal::inspect(&c)?.status(&c)?["missing_deliveries"],
        2002
    );
    Ok(())
}

#[test]
fn oversized_legacy_preview_refuses_before_unbounded_collection_but_streams() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", &[]))?;
    let indexes = (0..4_000).collect::<Vec<_>>();
    j.append(&block(c.automation_start_height, "b", "a", &indexes))?;
    j.rollback_one()?;
    drop(j);
    financial(&mut c);
    let before = snapshot(&c)?;
    let error =
        Journal::handoff_revocations(&lock, &c, "key", 10_000, 50_000, Duration::from_secs(20))
            .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("private revocation byte cap exceeded")
    );
    assert_eq!(snapshot(&c)?, before);
    let stream_path = dir.path().join("complete-revocations.ndjson");
    let mut output = std::fs::File::create(&stream_path)?;
    Journal::handoff_revocations_stream(&lock, &c, "key", Duration::from_secs(30), &mut output)?;
    drop(output);
    assert!(std::fs::metadata(stream_path)?.len() > 512 * 1024);
    assert_eq!(snapshot(&c)?, before);
    Ok(())
}

#[test]
fn historical_long_consumer_ids_preserve_active_and_inactive_handoff_proofs() -> Result<()> {
    for id in ["a".repeat(129), "é".repeat(8_193)] {
        let dir = TempDir::new()?;
        let mut c = config(&dir);
        financial(&mut c);
        c.consumers[0].id = id.clone();
        c.validate()?;
        let lock = StateLock::acquire(&c.state_dir)?;
        let mut journal = Journal::open(&c, "key")?;
        journal.append(&block(c.birthday_height, "a", "parent", &[]))?;
        journal.append(&block(c.automation_start_height, "b", "a", &[0]))?;
        journal.rollback_one()?;
        drop(journal);
        let preview = Journal::handoff_revocations(&lock, &c, "key", 1, 1, Duration::from_secs(5))?;
        let applied = Journal::enqueue_missing(&lock, &c, "key", Duration::from_secs(5))?;
        assert_eq!(preview["inventory_sha256"], applied["inventory_sha256"]);
        // Removing the long consumer preserves its subscriptions and delivery
        // rows. Inactive metadata must continue to participate in full proof.
        c.consumers.remove(0);
        drop(Journal::open(&c, "key")?);
        let before = Journal::handoff_revocations(&lock, &c, "key", 1, 1, Duration::from_secs(5))?;
        let db = Connection::open(c.state_dir.join("journal.sqlite"))?;
        let renamed = format!(
            "{}{}",
            id.chars().take(id.chars().count() - 1).collect::<String>(),
            if id.is_ascii() { "z" } else { "è" }
        );
        db.execute(
            "UPDATE consumers SET id=?1 WHERE id=?2",
            params![renamed, id],
        )?;
        db.execute(
            "UPDATE subscriptions SET consumer=?1 WHERE consumer=?2",
            params![renamed, id],
        )?;
        db.execute(
            "UPDATE deliveries SET consumer=?1 WHERE consumer=?2",
            params![renamed, id],
        )?;
        drop(db);
        let after = Journal::handoff_revocations(&lock, &c, "key", 1, 1, Duration::from_secs(5))?;
        assert_ne!(
            before["inventory_sha256"], after["inventory_sha256"],
            "the final byte after several chunks is part of the proof"
        );
        assert_eq!(before["existing_deliveries"], after["existing_deliveries"]);
    }
    Ok(())
}

#[test]
fn oversized_handoff_values_are_refused_without_materializing_them() -> Result<()> {
    for (table, column, expected) in [
        ("events", "body", "oversized handoff event"),
        ("receipts", "payment", "oversized handoff receipt"),
    ] {
        let dir = TempDir::new()?;
        let mut c = config(&dir);
        financial(&mut c);
        let lock = StateLock::acquire(&c.state_dir)?;
        let mut j = Journal::open(&c, "key")?;
        j.append(&block(c.birthday_height, "a", "parent", &[]))?;
        j.append(&block(c.automation_start_height, "b", "a", &[0]))?;
        drop(j);
        let db = Connection::open(c.state_dir.join("journal.sqlite"))?;
        // Allocate only in the fixture writer. The separately measured reader
        // must reject the 128 MiB value using SQLite's byte-length metadata.
        db.execute(&format!("UPDATE {table} SET {column}=zeroblob(?1) WHERE rowid=(SELECT min(rowid) FROM {table})"), [128 * 1024 * 1024])?;
        drop(db);
        let error = Journal::handoff_revocations_stream(
            &lock,
            &c,
            "key",
            Duration::from_secs(5),
            &mut std::io::sink(),
        )
        .unwrap_err();
        assert!(error.to_string().contains(expected));
        let config_path = command_config(&c, &dir)?;
        drop(lock);
        let (success, stderr, peak) = measured_output(&config_path, 5, None)?;
        assert!(!success);
        assert!(
            stderr.contains("handoff stream unavailable"),
            "{table}: {stderr}"
        );
        assert!(peak < 64 * 1024, "{table} reader allocated {peak} KiB");
    }
    Ok(())
}

#[test]
fn compiled_stream_deadline_releases_lock_when_stdout_stops_draining() -> Result<()> {
    let dir = TempDir::new()?;
    let mut c = config(&dir);
    let lock = StateLock::acquire(&c.state_dir)?;
    let mut j = Journal::open(&c, "key")?;
    j.append(&block(c.birthday_height, "a", "parent", &[]))?;
    j.append(&block(
        c.automation_start_height,
        "b",
        "a",
        &(0..512).collect::<Vec<_>>(),
    ))?;
    j.rollback_one()?;
    drop(j);
    financial(&mut c);
    let config_path = command_config(&c, &dir)?;
    drop(lock);
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_zcash-paymentd"))
        .arg("--config")
        .arg(config_path)
        .args(["handoff-revocations-stream", "--timeout-seconds", "3"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    let stdout = child.stdout.take().unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut input = BufReader::new(stdout);
        let mut header = String::new();
        let result = input.read_line(&mut header);
        let _ = send.send((result, header, input));
    });
    let received = receive.recv_timeout(Duration::from_secs(6));
    if received.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    reader.join().unwrap();
    let (read, header, held_pipe) = received?;
    read?;
    assert!(header.contains("\"type\":\"header\""));
    // Holding the reader open without draining it blocks write_all after the
    // pipe fills. The CLI must terminate itself, not wait for the consumer.
    let until = Instant::now() + Duration::from_secs(6);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        if Instant::now() >= until {
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    if status.is_none() {
        child.kill()?;
        child.wait()?;
    }
    drop(held_pipe);
    assert_eq!(status.and_then(|value| value.code()), Some(124));
    let _released = StateLock::acquire(&c.state_dir)?;
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
