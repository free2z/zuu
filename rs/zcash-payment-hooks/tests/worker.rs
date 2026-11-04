use anyhow::Result;
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_paymentd::{
    Payment,
    chain::ObservedBlock,
    config::{Config, Consumer},
    journal::{Journal, StateLock},
    now,
};
use zcash_protocol::consensus::{BlockHeight, BranchId, MAIN_NETWORK};
use zip32::AccountId;

const HEIGHT: u32 = 3_500_000;

struct Daemon(Child);
impl Drop for Daemon {
    fn drop(&mut self) {
        // Only the child owned by this test, never a process-name pattern.
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct Node {
    url: String,
    stop: Arc<AtomicBool>,
    unavailable_blocks: Arc<AtomicUsize>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Drop for Node {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.worker.take().unwrap().join().unwrap();
    }
}
impl Node {
    fn replacement_body_unavailable() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let unavailable_blocks = Arc::new(AtomicUsize::new(0));
        let stopped = stop.clone();
        let failures = unavailable_blocks.clone();
        let worker = thread::spawn(move || {
            while !stopped.load(Ordering::SeqCst) {
                let mut stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(e) => panic!("{e}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                let header_end = loop {
                    let mut chunk = [0; 4096];
                    let n = stream.read(&mut chunk).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&chunk[..n]);
                    if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                };
                let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|n| n.trim().parse().unwrap())
                    })
                    .unwrap();
                while bytes.len() < header_end + length {
                    let mut chunk = [0; 4096];
                    let n = stream.read(&mut chunk).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&chunk[..n]);
                }
                let request: Value =
                    serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
                let (result, error) = match request["method"].as_str().unwrap() {
                    // Released Zakura schema: headers, with no Bitcoin IBD field.
                    "getblockchaininfo" => (
                        json!({"chain":"main","blocks":HEIGHT+1,"headers":HEIGHT+1,"estimatedheight":HEIGHT+1,"consensus":{"chaintip":format!("{:08x}",u32::from(BranchId::for_height(&MAIN_NETWORK,BlockHeight::from(HEIGHT+1))))}}),
                        Value::Null,
                    ),
                    "getblockhash" => (
                        json!(if request["params"][0] == HEIGHT {
                            "11".repeat(32)
                        } else {
                            "33".repeat(32)
                        }),
                        Value::Null,
                    ),
                    "getblockheader" => (
                        json!({"hash":"33".repeat(32),"height":HEIGHT+1,"time":now()}),
                        Value::Null,
                    ),
                    "getblock" => {
                        failures.fetch_add(1, Ordering::SeqCst);
                        (
                            Value::Null,
                            json!({"code":-1,"message":"replacement block body unavailable"}),
                        )
                    }
                    method => panic!("unexpected RPC {method}"),
                };
                let body = json!({"result":result,"error":error,"id":"paymentd"}).to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
            }
        });
        Self {
            url,
            stop,
            unavailable_blocks,
            worker: Some(worker),
        }
    }
}
fn payment(index: usize) -> Payment {
    Payment {
        id: format!("main:tx:orchard:{index}"),
        txid: "tx".into(),
        pool: "orchard".into(),
        output_index: index,
        value_zatoshis: 90_000,
        memo_hex: hex::encode([0xf6; 512]),
        recipient_hex: hex::encode([0; 43]),
    }
}
fn block(height: u32, hash: &str, previous_hash: &str, index: usize) -> ObservedBlock {
    ObservedBlock {
        height,
        hash: hash.into(),
        previous_hash: previous_hash.into(),
        payments: vec![payment(index)],
    }
}

#[test]
fn actual_worker_delivers_recorded_revoke_after_replacement_fetch_failure() -> Result<()> {
    let dir = TempDir::new()?;
    let node = Node::replacement_body_unavailable();
    let output = dir.path().join("hook-events");
    let ufvk = UnifiedSpendingKey::from_seed(&MAIN_NETWORK, &[1; 32], AccountId::ZERO)?
        .to_unified_full_viewing_key()
        .encode(&MAIN_NETWORK);
    let c = Config {
        network: "main".into(),
        rpc_url: node.url.clone(),
        rpc_cookie_file: None,
        ufvk_file: dir.path().join("ufvk"),
        state_dir: dir.path().join("state"),
        birthday_height: HEIGHT,
        automation_start_height: HEIGHT,
        confirmations: 1,
        poll_seconds: 1,
        max_tip_age_seconds: 900,
        max_tip_lag_blocks: 10,
        max_tip_future_seconds: 7200,
        consumers: vec![Consumer {
            id: "hook".into(),
            argv: vec![
                "/bin/sh".into(),
                "-c".into(),
                "/bin/cat >> \"$1\"".into(),
                "hook".into(),
                output.to_string_lossy().into_owned(),
            ],
            timeout_seconds: 2,
            observe_unconfirmed: false,
        }],
    };
    std::fs::write(&c.ufvk_file, &ufvk)?;
    std::fs::set_permissions(&c.ufvk_file, std::fs::Permissions::from_mode(0o600))?;
    let lock = StateLock::acquire(&c.state_dir)?;
    let mut journal = Journal::open(&c, &ufvk)?;
    journal.append(&block(HEIGHT, &"11".repeat(32), &"00".repeat(32), 0))?;
    let unrelated = journal.next("hook", i64::MAX)?.unwrap();
    journal.acknowledge("hook", &unrelated.event.event_id)?;
    journal.append(&block(HEIGHT + 1, &"22".repeat(32), &"11".repeat(32), 1))?;
    let credited = journal.next("hook", i64::MAX)?.unwrap();
    journal.acknowledge("hook", &credited.event.event_id)?;
    // Replay leaves an unrelated valid positive ahead of the future correction.
    journal.replay("hook", &unrelated.event.event_id)?;
    drop(journal);
    drop(lock);
    let config = dir.path().join("config.toml");
    std::fs::write(
        &config,
        toml::to_string(&json!({
            "network":c.network,"rpc_url":c.rpc_url,"ufvk_file":c.ufvk_file,"state_dir":c.state_dir,
            "birthday_height":HEIGHT,"automation_start_height":HEIGHT,"confirmations":1,"poll_seconds":1,
            "max_tip_age_seconds":900,"max_tip_lag_blocks":10,"max_tip_future_seconds":7200,
            "consumers":[{"id":"hook","argv":c.consumers[0].argv,"timeout_seconds":2}]
        }))?,
    )?;
    let mut daemon = Daemon(
        Command::new(env!("CARGO_BIN_EXE_zcash-paymentd"))
            .args(["--config", config.to_str().unwrap(), "run"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?,
    );
    let deadline = Instant::now() + Duration::from_secs(6);
    let event = loop {
        assert!(
            daemon.0.try_wait()?.is_none(),
            "daemon exited before correction delivery"
        );
        if let Ok(text) = std::fs::read_to_string(&output)
            && let Some(line) = text.lines().next()
        {
            break serde_json::from_str::<zcash_paymentd::Event>(line)?;
        }
        assert!(
            Instant::now() < deadline,
            "recorded revoke was withheld by scanner failure/positive head"
        );
        thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(event.kind, "payment.revoked");
    assert_eq!(event.payment.id, credited.event.payment.id);
    assert_eq!(
        event.event_id,
        format!(
            "{}:{}:revoked",
            credited.event.payment.id, credited.event.revision
        )
    );
    assert!(node.unavailable_blocks.load(Ordering::SeqCst) > 0);
    let reader = Journal::inspect(&c)?;
    assert!(
        !reader.ready(&c)?,
        "scanner must stay truthfully unavailable"
    );
    let pending = reader.next("hook", i64::MAX)?.unwrap();
    assert_eq!(
        pending.event, unrelated.event,
        "unrelated positive was neither executed nor falsely ACKed"
    );
    assert_eq!(pending.attempts, 0);
    assert!(std::fs::read_to_string(output)?.lines().all(|line| {
        serde_json::from_str::<zcash_paymentd::Event>(line)
            .unwrap()
            .kind
            == "payment.revoked"
    }));
    Ok(())
}
