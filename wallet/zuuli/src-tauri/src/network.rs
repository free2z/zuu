//! App-owned policy commands. No caller-selected proxy and no remote opt-in.
use tauri::{Manager, Runtime};
use tauri_plugin_f2zmsg::F2zMsgExt;
use tauri_plugin_opener::OpenerExt;
use zuuli_transport::Status;

fn preference<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "privacy storage unavailable")?
        .join("tor-mode"))
}
pub async fn initialize<R: Runtime>(app: &tauri::AppHandle<R>) {
    let enabled =
        match preference(app).and_then(|p| std::fs::read_to_string(p).map_err(|e| e.to_string())) {
            Ok(value) => value != "off",
            Err(_) => preference(app)
                .map(|p| !matches!(p.try_exists(), Ok(false)))
                .unwrap_or(true),
        };
    let guard = zuuli_transport::global().transition().await;
    zuuli_transport::global().set(&guard, enabled, false);
}
#[tauri::command]
pub fn tor_status() -> Status {
    zuuli_transport::global().status()
}
#[tauri::command]
pub async fn tor_set<R: Runtime>(
    app: tauri::AppHandle<R>,
    enabled: bool,
) -> Result<Status, String> {
    let policy = zuuli_transport::global();
    // Revocation starts immediately; no success/on status until drain + durable
    // preference + teardown complete. Failure leaves all transports suspended.
    let requested_epoch = policy.suspend();
    let guard = policy.transition().await;
    if let Ok(engine) = app.f2zmsg().engine_handle() {
        engine.disconnect_for_privacy().await;
    }
    let path = preference(&app)?;
    std::fs::create_dir_all(path.parent().ok_or("privacy storage unavailable")?)
        .map_err(|_| "privacy storage unavailable")?;
    // Write-before-ack, atomic same-directory rename. A failed write cannot
    // silently enable direct mode or claim the user's preference was saved.
    let tmp = path.with_extension("new");
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp).map_err(|_| "privacy storage unavailable")?;
        file.write_all(if enabled { b"on" } else { b"off" })
            .and_then(|_| file.sync_all())
            .map_err(|_| "privacy storage unavailable")?;
    }
    std::fs::rename(tmp, &path).map_err(|_| "privacy storage unavailable")?;
    #[cfg(unix)]
    std::fs::File::open(path.parent().ok_or("privacy storage unavailable")?)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "privacy storage unavailable")?;
    policy
        .finish_transition(&guard, enabled, requested_epoch)
        .map_err(|_| "Connection changed during transition; reconnect".to_owned())
}
#[tauri::command]
pub fn tor_suspend() {
    let status = zuuli_transport::global().status();
    if status.enabled || status.suspended {
        zuuli_transport::global().suspend();
    }
}

/// Replaces the HTTP plugin's unrestricted command path. An individual direct
/// request owns its lease until the entire response has been read and its
/// non-pooled client dropped. Transitions drain these leases before ack.
#[tauri::command]
pub async fn api_request(
    url: String,
    method: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<Vec<u8>>,
) -> Result<ApiResponse, String> {
    let _lease = zuuli_transport::global()
        .direct()
        .await
        .map_err(|_| "Free2Z API unavailable in Tor mode")?;
    let parsed = url::Url::parse(&url).map_err(|_| "invalid API URL")?;
    let host = parsed.host_str().unwrap_or_default();
    if parsed.scheme() != "https"
        || !(host == "free2z.cash" || host.ends_with(".free2z.cash"))
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
    {
        return Err("API origin refused".into());
    }
    let client = tauri_plugin_http::reqwest::Client::builder()
        .dns_resolver(std::sync::Arc::new(crate::network::DirectResolver))
        .no_proxy()
        .redirect(tauri_plugin_http::reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(0)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| "HTTP unavailable")?;
    let method = method
        .parse::<tauri_plugin_http::reqwest::Method>()
        .map_err(|_| "invalid method")?;
    let mut request = client.request(method, parsed);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request.send().await.map_err(|_| "API request failed")?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|_| "API response failed")?;
    Ok(ApiResponse { status, body })
}
#[derive(serde::Serialize)]
pub struct ApiResponse {
    status: u16,
    body: String,
}
#[tauri::command]
pub fn network_open<R: Runtime>(app: tauri::AppHandle<R>, url: String) -> Result<(), String> {
    let _lease = zuuli_transport::global()
        .direct_now()
        .map_err(|_| "External links unavailable in Tor mode")?;
    let parsed = url::Url::parse(&url).map_err(|_| "invalid external URL")?;
    if !matches!(parsed.scheme(), "https" | "mailto") {
        return Err("external scheme refused".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "external app unavailable".into())
}

/// Keep the policy lease in the OS resolver job itself. Reqwest timeouts or a
/// dropped request must not leave detached clearnet DNS running after Tor ack.
#[derive(Debug)]
pub struct DirectResolver;
impl tauri_plugin_http::reqwest::dns::Resolve for DirectResolver {
    fn resolve(
        &self,
        name: tauri_plugin_http::reqwest::dns::Name,
    ) -> tauri_plugin_http::reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let lease = zuuli_transport::global().direct_now()?;
            let addresses = tokio::task::spawn_blocking(move || {
                let _lease = lease;
                use std::net::ToSocketAddrs;
                (host.as_str(), 0)
                    .to_socket_addrs()
                    .map(|a| a.collect::<Vec<_>>())
            })
            .await??;
            Ok(Box::new(addresses.into_iter()) as tauri_plugin_http::reqwest::dns::Addrs)
        })
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    #[ignore = "explicit benign native acceptance read; requires owned Tor on 127.0.0.1:9050"]
    async fn shipping_wallet_rpc_reads_lightd_info_through_tor() {
        let policy = zuuli_transport::global();
        {
            let guard = policy.transition().await;
            policy.set(&guard, true, false);
        }
        let mut client =
            tauri_plugin_zcash::wallet::client::connect_to_lightwalletd("https://zec.rocks:443")
                .await
                .unwrap();
        let response = client
            .get_lightd_info(zcash_client_backend::proto::service::Empty {})
            .await
            .unwrap()
            .into_inner();
        assert!(response.block_height > 0);
        eprintln!("Shipping wallet connect_to_lightwalletd + GetLightdInfo succeeded through owned Tor on fixed 9050; no wallet loaded or funds moved");
        policy.suspend();
        assert!(
            client
                .get_lightd_info(zcash_client_backend::proto::service::Empty {})
                .await
                .is_err(),
            "existing shipping client must be unusable immediately after lifecycle suspension"
        );
        {
            let guard = policy.transition().await;
            policy.set(&guard, false, false);
        }
    }
}
