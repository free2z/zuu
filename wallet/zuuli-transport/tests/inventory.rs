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

#[test]
fn shipping_webview_creation_cannot_skip_the_native_navigation_and_popup_boundary() {
    let host = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("zuuli/src-tauri");
    let lib = fs::read_to_string(host.join("src/lib.rs")).unwrap();
    assert!(lib.contains(".plugin(navigation::plugin())"));
    assert!(lib.contains("navigation::create_main(app.handle())?"));
    let navigation = fs::read_to_string(host.join("src/navigation.rs")).unwrap();
    assert!(navigation.contains(".on_navigation(allowed)"));
    assert!(navigation.contains(".on_new_window(deny_new_window)"));
    assert!(navigation.contains("protect(WebviewWindowBuilder::from_config(app, config)?)"));
    assert!(navigation.contains("NetworkProxySettings::new(Some(\"http://127.0.0.1:0\"), bypass)"));
    assert!(
        navigation.find("data.set_network_proxy_settings").unwrap()
            < navigation.find("view.load_uri").unwrap()
    );
    let mut sources = vec![];
    rust_sources(&host.join("src"), &mut sources);
    for (file, source) in sources {
        // Unit mock builders do not create a real engine. Every production
        // constructor stays in the guarded module; examples are fixtures only.
        let production = source.split("#[cfg(test)]").next().unwrap();
        if !file.ends_with("/navigation.rs") {
            for constructor in [
                "WebviewWindowBuilder::",
                "WebviewBuilder::",
                ".with_webview(",
            ] {
                assert!(
                    !production.contains(constructor),
                    "new WebView construction needs an explicit boundary: {file}"
                );
            }
        }
    }
    for capability in ["default", "mobile"] {
        let permissions =
            fs::read_to_string(host.join(format!("capabilities/{capability}.json"))).unwrap();
        for deny in [
            "core:window:deny-create",
            "core:webview:deny-create-webview",
            "core:webview:deny-create-webview-window",
        ] {
            assert!(permissions.contains(deny));
        }
    }
}
