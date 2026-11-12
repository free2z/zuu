//! A source inventory alarm, in addition to the native I/O behavior tests.
//! New outbound constructors need an explicit coverage decision, not an
//! assumption that installing a proxy affected a different network library.
use std::{fs, path::Path};
fn rust_sources(path: &Path, out: &mut Vec<(String, String)>) {
    for entry in fs::read_dir(path).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_sources(&path, out);
        } else if path.extension().is_some_and(|x| x == "rs") {
            out.push((
                path.to_string_lossy().into_owned(),
                fs::read_to_string(path).unwrap(),
            ));
        }
    }
}
#[test]
fn wallet_rpc_has_no_second_direct_connector_and_native_http_inventory_is_explicit() {
    let wallet = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut sources = vec![];
    rust_sources(&wallet.join("plugins/tauri-plugin-zcash/src"), &mut sources);
    for (path, source) in &sources {
        for bypass in [
            "CompactTxStreamerClient::connect(",
            "Channel::from_shared(",
            "Endpoint::from_shared(",
            "TcpStream::connect(",
            "reqwest::Client",
        ] {
            assert!(
                !source.contains(bypass),
                "unreviewed native wallet outbound constructor {bypass} in {path}"
            );
        }
    }
    let client =
        fs::read_to_string(wallet.join("plugins/tauri-plugin-zcash/src/wallet/client.rs")).unwrap();
    assert!(client.contains(".channel(url)"));
    assert!(client.contains(".channel_at_epoch(url, epoch)"));
    let host = wallet.join("zuuli/src-tauri");
    let lib = fs::read_to_string(host.join("src/lib.rs")).unwrap();
    assert!(!lib.contains(".plugin(tauri_plugin_http::init())"));
    for capability in ["default", "mobile"] {
        let source =
            fs::read_to_string(host.join(format!("capabilities/{capability}.json"))).unwrap();
        assert!(!source.contains("http:"));
        assert!(!source.contains("opener:"));
    }
    let config = fs::read_to_string(host.join("tauri.conf.json")).unwrap();
    assert!(config.contains("connect-src 'self';"));
    let http = fs::read_to_string(wallet.join("zuuli/src/lib/api/http.ts")).unwrap();
    assert!(http.contains("fetchImpl = nativeApiFetch"));
    assert!(
        !http.contains("plugin-http"),
        "API routing must not restore the ungated HTTP plugin"
    );
    let mut host_sources = vec![];
    rust_sources(&host.join("src"), &mut host_sources);
    let constructors: Vec<_> = host_sources
        .iter()
        .filter_map(|(path, source)| {
            let count = source.matches("reqwest::Client::builder()").count();
            (count > 0).then_some((path.rsplit('/').next().unwrap(), count))
        })
        .collect();
    assert_eq!(
        constructors.len(),
        2,
        "native HTTP inventory changed: {constructors:?}"
    );
    assert!(constructors.contains(&("network.rs", 1)));
    assert!(constructors.contains(&("directory_publish.rs", 2)));
    for (path, source) in host_sources {
        if source.contains("reqwest::Client::builder()") {
            assert_eq!(
                source.matches("reqwest::Client::builder()").count(),
                source.matches("DirectResolver").count()
                    - usize::from(path.ends_with("network.rs")) * 2,
                "each client must install the cancellation-safe direct DNS resolver: {path}"
            );
        }
    }
}
