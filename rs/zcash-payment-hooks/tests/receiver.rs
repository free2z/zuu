//! Cryptographic coverage tests use independent keys, internal change, and mixed-account UAs.
use std::{
    fs,
    io::Write,
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    process::{Command, Stdio},
};
use tempfile::TempDir;
use zcash_address::unified::{Encoding, Fvk, Receiver};
use zcash_keys::{
    address::{Address, UnifiedAddress},
    keys::{UnifiedFullViewingKey, UnifiedSpendingKey},
};
use zcash_paymentd::{
    config::Config,
    receiver::{MAX_ADDRESS_BYTES, read_address, verify_address},
};
use zcash_protocol::consensus::{MAIN_NETWORK, NetworkType, TEST_NETWORK};
use zip32::{AccountId, Scope};

fn key(seed: u8) -> UnifiedFullViewingKey {
    UnifiedSpendingKey::from_seed(&MAIN_NETWORK, &[seed; 32], AccountId::ZERO)
        .unwrap()
        .to_unified_full_viewing_key()
}
fn config(dir: &TempDir) -> Config {
    Config {
        network: "main".into(),
        rpc_url: "http://127.0.0.1:8232".into(),
        rpc_cookie_file: None,
        ufvk_file: dir.path().join("key"),
        state_dir: dir.path().join("never-create-state"),
        birthday_height: 3_500_000,
        automation_start_height: 3_500_000,
        confirmations: 3,
        poll_seconds: 15,
        max_tip_age_seconds: 900,
        max_tip_lag_blocks: 10,
        max_tip_future_seconds: 7200,
        consumers: vec![],
    }
}
fn ua(k: &UnifiedFullViewingKey, scope: Scope) -> String {
    let sapling = match scope {
        Scope::External => k.sapling().unwrap().find_address(123u32.into()).unwrap().1,
        Scope::Internal => k.sapling().unwrap().change_address().1,
    };
    UnifiedAddress::from_receivers(
        Some(k.orchard().unwrap().address_at(987u32, scope)),
        Some(sapling),
        None,
    )
    .unwrap()
    .encode(&MAIN_NETWORK)
}

#[test]
fn diversified_external_receivers_match_all_three_pools_and_wrong_key_matches_none() {
    let dir = TempDir::new().unwrap();
    let c = config(&dir);
    let a = key(41);
    let b = key(42);
    let address = ua(&a, Scope::External);
    let proof = verify_address(&c, &a.encode(&MAIN_NETWORK), &address).unwrap();
    assert!(proof.fully_covered);
    assert_eq!(proof.network, "main");
    assert_eq!(proof.schema_version, 1);
    assert_eq!(
        proof
            .shielded_receivers
            .iter()
            .map(|p| p.pool)
            .collect::<Vec<_>>(),
        ["sapling", "orchard", "ironwood"]
    );
    assert!(proof.shielded_receivers.iter().all(|p| p.key_match));
    assert_eq!(
        proof.shielded_receivers[1].receiver_sha256,
        proof.shielded_receivers[2].receiver_sha256
    );
    let wrong = verify_address(&c, &b.encode(&MAIN_NETWORK), &address).unwrap();
    assert!(!wrong.fully_covered);
    assert!(wrong.shielded_receivers.iter().all(|p| !p.key_match));
    assert!(!c.state_dir.exists());
}

#[test]
fn internal_change_is_never_external_purchase_coverage() {
    let dir = TempDir::new().unwrap();
    let c = config(&dir);
    let k = key(43);
    let proof = verify_address(&c, &k.encode(&MAIN_NETWORK), &ua(&k, Scope::Internal)).unwrap();
    assert!(!proof.fully_covered);
    assert_eq!(proof.shielded_receivers.len(), 3);
    assert!(proof.shielded_receivers.iter().all(|r| !r.key_match));
}

#[test]
fn mixed_account_ua_and_missing_key_components_cannot_claim_complete_coverage() {
    let dir = TempDir::new().unwrap();
    let c = config(&dir);
    let a = key(44);
    let b = key(45);
    let address = UnifiedAddress::from_receivers(
        Some(a.orchard().unwrap().address_at(0u32, Scope::External)),
        Some(b.sapling().unwrap().default_address().1),
        None,
    )
    .unwrap()
    .encode(&MAIN_NETWORK);
    let proof = verify_address(&c, &a.encode(&MAIN_NETWORK), &address).unwrap();
    assert!(!proof.fully_covered);
    assert!(!proof.shielded_receivers[0].key_match);
    assert!(proof.shielded_receivers[1].key_match && proof.shielded_receivers[2].key_match);
    let sapling_only = zcash_address::unified::Ufvk::try_from_items(vec![Fvk::Sapling(
        a.sapling().unwrap().to_bytes(),
    )])
    .unwrap()
    .encode(&NetworkType::Main);
    let proof = verify_address(&c, &sapling_only, &ua(&a, Scope::External)).unwrap();
    assert!(!proof.fully_covered);
    assert!(proof.shielded_receivers[0].key_match);
    assert!(!proof.shielded_receivers[1].key_match && !proof.shielded_receivers[2].key_match);
    let orchard_only = zcash_address::unified::Ufvk::try_from_items(vec![Fvk::Orchard(
        a.orchard().unwrap().to_bytes(),
    )])
    .unwrap()
    .encode(&NetworkType::Main);
    let proof = verify_address(&c, &orchard_only, &ua(&a, Scope::External)).unwrap();
    assert!(!proof.fully_covered);
    assert!(!proof.shielded_receivers[0].key_match);
    assert!(proof.shielded_receivers[1].key_match && proof.shielded_receivers[2].key_match);
}

#[test]
fn standalone_sapling_works_but_unknown_receivers_and_transparent_only_fail_closed() {
    let dir = TempDir::new().unwrap();
    let c = config(&dir);
    let k = key(46);
    let encoded = k.encode(&MAIN_NETWORK);
    let sapling = k.sapling().unwrap().default_address().1;
    let address = Address::Sapling(sapling).encode(&MAIN_NETWORK);
    let proof = verify_address(&c, &encoded, &address).unwrap();
    assert!(proof.fully_covered);
    assert_eq!(proof.shielded_receivers.len(), 1);
    let unknown = zcash_address::unified::Address::try_from_items(vec![
        Receiver::Sapling(sapling.to_bytes()),
        Receiver::Unknown {
            typecode: 0xfffe,
            data: vec![7; 43],
        },
    ])
    .unwrap()
    .encode(&NetworkType::Main);
    let proof = verify_address(&c, &encoded, &unknown).unwrap();
    assert!(!proof.fully_covered);
    assert_eq!(proof.unknown_receiver_count, 1);
    assert!(proof.shielded_receivers[0].key_match);
    for address in [
        Address::Transparent(transparent::address::TransparentAddress::PublicKeyHash(
            [1; 20],
        )),
        Address::Tex([2; 20]),
    ] {
        let proof = verify_address(&c, &encoded, &address.encode(&MAIN_NETWORK)).unwrap();
        assert!(!proof.fully_covered);
        assert!(proof.transparent_present);
        assert!(proof.shielded_receivers.is_empty());
    }
    let mixed = UnifiedAddress::from_receivers(
        None,
        Some(sapling),
        Some(transparent::address::TransparentAddress::PublicKeyHash(
            [3; 20],
        )),
    )
    .unwrap()
    .encode(&MAIN_NETWORK);
    let proof = verify_address(&c, &encoded, &mixed).unwrap();
    assert!(proof.fully_covered && proof.transparent_present); // Only shielded choices are covered.
}

#[test]
fn wrong_network_invalid_checksum_key_and_bounded_input_are_rejected_without_values() {
    let dir = TempDir::new().unwrap();
    let mut c = config(&dir);
    let k = key(47);
    let address = ua(&k, Scope::External);
    let encoded = k.encode(&MAIN_NETWORK);
    let test_address = Address::decode(&MAIN_NETWORK, &address)
        .unwrap()
        .encode(&TEST_NETWORK);
    assert!(verify_address(&c, &encoded, &test_address).is_err());
    c.network = "test".into();
    assert!(verify_address(&c, &encoded, &address).is_err());
    c.network = "main".into();
    let mut broken = address.clone().into_bytes();
    let i = broken.len() - 1;
    broken[i] = if broken[i] == b'q' { b'p' } else { b'q' };
    assert!(verify_address(&c, &encoded, std::str::from_utf8(&broken).unwrap()).is_err());
    let err = verify_address(&c, "private-invalid-key", &address)
        .unwrap_err()
        .to_string();
    assert!(!err.contains("private-invalid-key") && !err.contains(&address));
    assert_eq!(
        read_address(format!(" \n{address}\n").as_bytes()).unwrap(),
        address
    );
    for input in [
        vec![],
        vec![b'a'; MAX_ADDRESS_BYTES + 1],
        vec![0xff],
        b"address1\naddress2".to_vec(),
    ] {
        assert!(read_address(input.as_slice()).is_err());
    }
    assert!(verify_address(&c, &encoded, &"q".repeat(MAX_ADDRESS_BYTES + 1)).is_err());
}

fn cli(c: &Config, dir: &TempDir, key_text: &str, address: &[u8]) -> std::process::Output {
    fs::write(&c.ufvk_file, key_text).unwrap();
    fs::set_permissions(&c.ufvk_file, fs::Permissions::from_mode(0o600)).unwrap();
    let config_path = dir.path().join("profile.toml");
    fs::write(&config_path,format!("network = {:?}\nrpc_url = {:?}\nufvk_file = {:?}\nstate_dir = {:?}\nbirthday_height = {}\nautomation_start_height = {}\nconfirmations = 3\npoll_seconds = 15\nmax_tip_age_seconds = 900\nmax_tip_lag_blocks = 10\nmax_tip_future_seconds = 7200\n",c.network,c.rpc_url,c.ufvk_file.to_str().unwrap(),c.state_dir.to_str().unwrap(),c.birthday_height,c.automation_start_height)).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_zcash-paymentd"))
        .args(["--config", config_path.to_str().unwrap(), "verify-address"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(address).unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn actual_cli_is_offline_has_strict_hashed_contract_and_never_creates_state() {
    let dir = TempDir::new().unwrap();
    let mut c = config(&dir);
    let k = key(48);
    let address = ua(&k, Scope::External);
    let encoded = k.encode(&MAIN_NETWORK);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    c.rpc_url = format!("http://{}", listener.local_addr().unwrap());
    let out = cli(&c, &dir, &encoded, address.as_bytes());
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(out.stderr.is_empty());
    assert!(!c.state_dir.exists());
    assert!(listener.accept().is_err());
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let mut keys = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(
        keys,
        [
            "address_sha256",
            "fully_covered",
            "network",
            "schema_version",
            "shielded_receivers",
            "transparent_present",
            "ufvk_sha256",
            "unknown_receiver_count"
        ]
    );
    assert_eq!(value["fully_covered"], true);
    assert_eq!(value["unknown_receiver_count"], 0);
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(!text.contains(&encoded) && !text.contains(&address));
    fs::create_dir(&c.state_dir).unwrap();
    let journal = c.state_dir.join("journal.sqlite");
    fs::write(&journal, b"must never open or migrate").unwrap();
    let out = cli(&c, &dir, &encoded, address.as_bytes());
    assert!(out.status.success());
    assert_eq!(fs::read(journal).unwrap(), b"must never open or migrate");
    assert_eq!(fs::read_dir(&c.state_dir).unwrap().count(), 1);
}

#[test]
fn actual_cli_redacts_failures_and_rejects_nonprivate_key() {
    let dir = TempDir::new().unwrap();
    let c = config(&dir);
    let k = key(49);
    let address = ua(&k, Scope::External);
    let encoded = k.encode(&MAIN_NETWORK);
    for (key_text, input) in [
        ("private-invalid-key", address.as_bytes()),
        (encoded.as_str(), b"private-invalid-address".as_slice()),
        (
            encoded.as_str(),
            vec![b'X'; MAX_ADDRESS_BYTES + 1].as_slice(),
        ),
    ] {
        let out = cli(&c, &dir, key_text, input);
        assert!(!out.status.success());
        assert!(out.stdout.is_empty());
        let err = String::from_utf8(out.stderr).unwrap();
        assert!(
            !err.contains(key_text)
                && !err.contains("private-invalid-address")
                && !err.contains(&address)
        );
        assert!(!c.state_dir.exists());
    }
    cli(&c, &dir, &encoded, address.as_bytes());
    fs::set_permissions(&c.ufvk_file, fs::Permissions::from_mode(0o644)).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_zcash-paymentd"))
        .args([
            "--config",
            dir.path().join("profile.toml").to_str().unwrap(),
            "verify-address",
        ])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    assert!(!c.state_dir.exists());
}
