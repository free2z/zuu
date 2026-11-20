//! Network policy for the WebView itself, independent of Tor mode.
//! CSP connect-src does not govern top-level navigation. These callbacks run
//! before dispatch; remote links must use the separately gated native opener.
use tauri::{plugin::TauriPlugin, Manager, Runtime, WebviewWindowBuilder};
use url::Url;

fn allowed_origin(url: &Url, scheme: &str, host: &str, development: bool) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    (url.scheme() == scheme && url.host_str() == Some(host) && url.port().is_none())
        || (development
            && url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port() == Some(1423))
}

pub(crate) fn allowed(url: &Url) -> bool {
    // Exact origins used by this pinned Tauri runtime. HTTP aliases on Unix
    // would be real network hosts, so do not accept another platform's alias.
    let (scheme, host) = if cfg!(any(windows, target_os = "android")) {
        ("http", "tauri.localhost")
    } else {
        ("tauri", "localhost")
    };
    allowed_origin(url, scheme, host, cfg!(dev))
}

pub(crate) fn deny_new_window<R: Runtime>(
    _: Url,
    _: tauri::webview::NewWindowFeatures,
) -> tauri::webview::NewWindowResponse<R> {
    // Deny even about:blank/local popups, which could later retarget themselves.
    tauri::webview::NewWindowResponse::Deny
}

/// Applied before building the only production WebView, including its initial
/// navigation (before the plugin can look it up in the manager).
pub(crate) fn protect<R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'_, R, M>,
) -> WebviewWindowBuilder<'_, R, M> {
    builder
        .on_navigation(allowed)
        .on_new_window(deny_new_window)
}

/// A backstop for every attached WebView, not just links from the main page.
pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("zuuli-navigation")
        .on_navigation(|webview, url| webview.label() == "main" && allowed(url))
        .build()
}

pub(crate) fn create_main<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<(), Box<dyn std::error::Error>> {
    let windows = &app.config().app.windows;
    let config = windows.first().ok_or("missing main window")?;
    if windows.len() != 1
        || config.label != "main"
        || config.create
        || config.use_https_scheme
        || config.url != tauri::WebviewUrl::App("index.html".into())
    {
        return Err("ZUULI requires one locally loaded, manually guarded main WebView".into());
    }
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::{
            NetworkProxyMode, NetworkProxySettings, SettingsExt, WebViewExt, WebsiteDataManagerExt,
        };
        // A cancelled anchor can still cause speculative WebKit networking.
        // Start with an empty, denied document; configure the native engine
        // BEFORE loading any HTML/JS, not in a renderer initialization script.
        let mut bootstrap = config.clone();
        bootstrap.url = tauri::WebviewUrl::External(Url::parse("about:blank")?);
        let window = protect(WebviewWindowBuilder::from_config(app, &bootstrap)?).build()?;
        let packaged = Url::parse("tauri://localhost/")?;
        let target = if cfg!(dev) {
            app.config().build.dev_url.clone().unwrap_or(packaged)
        } else {
            packaged
        };
        if !allowed(&target) {
            return Err("unreviewed development origin".into());
        }
        window.with_webview(move |native| {
            let view = native.inner();
            let Some(settings) = view.settings() else {
                return;
            };
            settings.set_enable_dns_prefetching(false);
            let Some(data) = view.website_data_manager() else {
                return;
            };
            // WebKit may preconnect before navigation policy is delivered.
            // Refuse ALL WebView network transports at the native data layer.
            // Port zero cannot host a listener: this is a denial endpoint, not
            // a proxy service or Tor configuration. Never inherit OS proxies.
            let bypass: &[&str] = if cfg!(dev) { &["127.0.0.1:1423"] } else { &[] };
            let mut refusal = NetworkProxySettings::new(Some("http://127.0.0.1:0"), bypass);
            data.set_network_proxy_settings(NetworkProxyMode::Custom, Some(&mut refusal));
            view.load_uri(target.as_str());
        })?;
    }
    #[cfg(not(target_os = "linux"))]
    protect(WebviewWindowBuilder::from_config(app, config)?).build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_exact_packaged_origins_and_the_explicit_development_origin_are_admitted() {
        for (scheme, host) in [("tauri", "localhost"), ("http", "tauri.localhost")] {
            for suffix in ["/", "/wallet/send?amount=1#review", "/about"] {
                let local = Url::parse(&format!("{scheme}://{host}{suffix}")).unwrap();
                assert!(allowed_origin(&local, scheme, host, false));
            }
            for remote in [
                "https://free2z.cash/",
                "https://navigation.fixture.test/leak",
                "http://127.0.0.1:1423/",
                "http://localhost:1423/",
                "http://127.0.0.1:1424/",
                "http://tauri.localhost.evil/",
                "https://tauri.localhost/",
                "tauri://localhost.evil/",
                "tauri://localhost:80/",
                "tauri://user@localhost/",
                "http://user@tauri.localhost/",
                "tauri://localhost@evil/",
                "about:blank",
                "data:text/html,fixture",
                "javascript:location.assign('https://evil/')",
                "blob:tauri://localhost/id",
                "file:///tmp/fixture",
                "cash.free2z.zuuli://oauth/callback",
            ] {
                assert!(
                    !allowed_origin(&Url::parse(remote).unwrap(), scheme, host, false),
                    "{remote}"
                );
            }
            assert!(allowed_origin(
                &Url::parse("http://127.0.0.1:1423/wallet#route").unwrap(),
                scheme,
                host,
                true
            ));
            assert!(!allowed_origin(
                &Url::parse("http://localhost:1423/").unwrap(),
                scheme,
                host,
                true
            ));
            assert!(!allowed_origin(
                &Url::parse("http://127.0.0.1:14230/").unwrap(),
                scheme,
                host,
                true
            ));
            assert!(!allowed_origin(
                &Url::parse("https://127.0.0.1:1423/").unwrap(),
                scheme,
                host,
                true
            ));
        }
    }
    #[test]
    fn shipping_configuration_has_no_automatic_or_remote_webview() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = config["app"]["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0]["label"], "main");
        assert_eq!(windows[0]["create"], false);
        assert_eq!(windows[0]["url"], "index.html");
        assert_eq!(config["build"]["devUrl"], "http://127.0.0.1:1423");
    }
}
