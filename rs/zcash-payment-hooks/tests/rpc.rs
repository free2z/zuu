use anyhow::Result;
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_paymentd::{
    chain::{Chain, Zakura},
    config::Config,
    now,
};
use zcash_protocol::consensus::{BlockHeight, BranchId, MAIN_NETWORK};
use zip32::AccountId;
const HEIGHT: u32 = 3_500_000;
fn config(dir: &TempDir, url: String) -> Config {
    Config {
        network: "main".into(),
        rpc_url: url,
        rpc_cookie_file: Some(dir.path().join("cookie")),
        ufvk_file: dir.path().join("ufvk"),
        state_dir: dir.path().join("state"),
        birthday_height: HEIGHT,
        automation_start_height: HEIGHT,
        confirmations: 3,
        poll_seconds: 1,
        max_tip_age_seconds: 900,
        max_tip_lag_blocks: 10,
        max_tip_future_seconds: 7200,
        consumers: vec![],
    }
}
fn private(path: &std::path::Path, s: &str) -> Result<()> {
    std::fs::write(path, s)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}
fn key() -> String {
    UnifiedSpendingKey::from_seed(&MAIN_NETWORK, &[1; 32], AccountId::ZERO)
        .unwrap()
        .to_unified_full_viewing_key()
        .encode(&MAIN_NETWORK)
}
fn info() -> Value {
    json!({"chain":"main","blocks":HEIGHT,"estimatedheight":HEIGHT,"initialblockdownload":false,"consensus":{"chaintip":format!("{:08x}",u32::from(BranchId::for_height(&MAIN_NETWORK,BlockHeight::from(HEIGHT))))}})
}
fn server(
    response: impl Fn(&Value) -> Value + Send + 'static,
    requests: usize,
) -> (String, Arc<Mutex<Vec<String>>>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let auth = Arc::new(Mutex::new(vec![]));
    let captured = auth.clone();
    let worker = thread::spawn(move || {
        for _ in 0..requests {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut stream = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            Instant::now() < deadline,
                            "expected RPC request did not arrive"
                        );
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = vec![];
            let header_end = loop {
                let mut chunk = [0; 1024];
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
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse().unwrap())
                })
                .unwrap();
            while bytes.len() < header_end + length {
                let mut chunk = [0; 4096];
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
            }
            captured.lock().unwrap().push(
                headers
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("authorization:"))
                    .unwrap_or("")
                    .to_owned(),
            );
            let request: Value =
                serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
            let body =
                json!({"result":response(&request),"error":null,"id":"paymentd"}).to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        }
    });
    (url, auth, worker)
}
fn response(request: &Value, info: Value, time: i64) -> Value {
    match request["method"].as_str().unwrap() {
        "getblockchaininfo" => info,
        "getblockhash" => json!("11".repeat(32)),
        "getblockheader" => json!({"hash":"11".repeat(32),"height":HEIGHT,"time":time}),
        m => panic!("unexpected {m}"),
    }
}
#[tokio::test]
async fn cookie_rotation_and_fresh_tip() -> Result<()> {
    let d = TempDir::new()?;
    let (url, auth, worker) = server(|r| response(r, info(), now()), 6);
    let c = config(&d, url);
    private(c.rpc_cookie_file.as_ref().unwrap(), "user:first")?;
    let chain = Zakura::new(&c, &key())?;
    assert_eq!(chain.tip().await?.height, HEIGHT);
    private(c.rpc_cookie_file.as_ref().unwrap(), "user:second")?;
    assert_eq!(chain.tip().await?.height, HEIGHT);
    worker.join().unwrap();
    let calls = auth.lock().unwrap();
    assert_ne!(calls[0], calls[3]);
    assert_eq!(calls[0], calls[2]);
    assert_eq!(calls[3], calls[5]);
    Ok(())
}
#[tokio::test]
async fn wrong_network_initial_download_lag_unknown_upgrade_and_stale_tip_fail_closed() -> Result<()>
{
    let mut cases = vec![];
    let mut v = info();
    v["chain"] = json!("test");
    cases.push((v, 1, now()));
    let mut v = info();
    v["initialblockdownload"] = json!(true);
    cases.push((v, 1, now()));
    let mut v = info();
    v["estimatedheight"] = json!(HEIGHT + 100);
    cases.push((v, 1, now()));
    let mut v = info();
    v["consensus"]["chaintip"] = json!("ffffffff");
    cases.push((v, 3, now()));
    cases.push((info(), 3, now() - 1000));
    for (value, count, time) in cases {
        let d = TempDir::new()?;
        let (url, _, worker) = server(move |r| response(r, value.clone(), time), count);
        let c = config(&d, url);
        private(c.rpc_cookie_file.as_ref().unwrap(), "user:pass")?;
        let chain = Zakura::new(&c, &key())?;
        assert!(chain.tip().await.is_err());
        worker.join().unwrap();
    }
    Ok(())
}

#[tokio::test]
async fn consensus_valid_future_tip_respects_explicit_clock_policy() -> Result<()> {
    for (ahead, valid) in [(600, true), (8000, false)] {
        let d = TempDir::new()?;
        let time = now() + ahead;
        let (url, _, worker) = server(move |r| response(r, info(), time), 3);
        let c = config(&d, url);
        private(c.rpc_cookie_file.as_ref().unwrap(), "user:pass")?;
        assert_eq!(Zakura::new(&c, &key())?.tip().await.is_ok(), valid);
        worker.join().unwrap();
    }
    Ok(())
}
