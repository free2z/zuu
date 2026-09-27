//! Native Free2Z SDK for trusted Tauri 2 application windows.
//!
//! Configure endpoints and client identity in Rust. Grant commands explicitly
//! in a local-only Tauri capability; the default permission grants nothing.
use std::sync::Arc;
use tauri::{Manager, Runtime, plugin::TauriPlugin};
mod commands;
mod engine;
mod platform;
mod store;
mod wire;
pub use f2z_sdk;
pub use platform::MobileRedirects;

include!("../command_registry.rs");
macro_rules! command_handler { ($($command:ident),* $(,)?) => { tauri::generate_handler![$(commands::$command),*] }; }
macro_rules! command_names { ($($command:ident),* $(,)?) => { &[$(stringify!($command)),*] }; }
/// Exact command/permission manifest, generated from one registry.
pub const COMMANDS: &[&str] = with_commands!(command_names);
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_f2z);

struct PluginState<R: Runtime> {
    engine: engine::Engine,
    #[cfg(not(mobile))]
    platform: platform::Platform,
    #[cfg(mobile)]
    platform: platform::MobilePlatform<R>,
    windows: Vec<String>,
    checkout_return: String,
    _runtime: std::marker::PhantomData<fn() -> R>,
}
/// Native configuration, never accepted through webview IPC.
pub struct Builder {
    config: f2z_sdk::Config,
    store: Option<Arc<dyn f2z_sdk::TokenStore>>,
    windows: Vec<String>,
    redirects: MobileRedirects,
    checkout_return: String,
}
impl Builder {
    /// Supply the public client registration and its registered checkout return URI.
    pub fn new(config: f2z_sdk::Config, checkout_return: impl Into<String>) -> Self {
        Self {
            config,
            store: None,
            windows: vec!["main".into()],
            redirects: MobileRedirects::default(),
            checkout_return: checkout_return.into(),
        }
    }
    /// Override OS storage explicitly, e.g. `MemoryStore` for an ephemeral session.
    pub fn token_store(mut self, store: Arc<dyn f2z_sdk::TokenStore>) -> Self {
        self.store = Some(store);
        self
    }
    /// Trusted, local-content window labels; Tauri capabilities must also grant access.
    pub fn windows(mut self, windows: impl IntoIterator<Item = String>) -> Self {
        self.windows = windows.into_iter().collect();
        self
    }
    /// Mobile associated HTTPS and reverse-domain fallback callback registration.
    pub fn mobile_redirects(mut self, redirects: MobileRedirects) -> Self {
        self.redirects = redirects;
        self
    }
    /// Install the plugin. Invalid configuration fails setup without printing secrets.
    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        tauri::plugin::Builder::new("f2z")
            .invoke_handler(with_commands!(command_handler))
            .setup(move |app, _api| {
                let return_url = url::Url::parse(&self.checkout_return)
                    .map_err(|_| "invalid checkout return URI")?;
                if return_url.scheme() != "https"
                    || return_url.host_str().is_none()
                    || !return_url.username().is_empty()
                    || return_url.password().is_some()
                    || return_url.query().is_some()
                    || return_url.fragment().is_some()
                {
                    return Err(
                        "checkout return URI must be registered HTTPS without query or credentials"
                            .into(),
                    );
                }
                let store = self.store.unwrap_or_else(|| {
                    Arc::new(store::PlatformStore::new(format!(
                        "{}.f2z-sdk",
                        app.config().identifier
                    )))
                });
                let client = f2z_sdk::Client::new(self.config, store)
                    .map_err(|_| "invalid Free2Z SDK configuration")?;
                #[cfg(not(mobile))]
                let platform = platform::Platform;
                #[cfg(target_os = "android")]
                let handle = _api.register_android_plugin("cash.free2z.sdk", "F2zPlugin")?;
                #[cfg(target_os = "ios")]
                let handle = _api.register_ios_plugin(init_plugin_f2z)?;
                #[cfg(mobile)]
                let platform = platform::MobilePlatform {
                    handle,
                    redirects: self.redirects,
                };
                let state = Arc::new(PluginState::<R> {
                    engine: engine::Engine::new(client),
                    platform,
                    windows: self.windows,
                    checkout_return: self.checkout_return,
                    _runtime: std::marker::PhantomData,
                });
                let weak = Arc::downgrade(&state);
                tauri::async_runtime::spawn(async move {
                    let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
                    loop {
                        interval.tick().await;
                        let Some(state) = weak.upgrade() else {
                            break;
                        };
                        let _ = state.engine.expire();
                    }
                });
                app.manage(state);
                Ok(())
            })
            .on_event(|app, event| {
                let Some(state) = app.try_state::<Arc<PluginState<R>>>() else {
                    return;
                };
                match event {
                    tauri::RunEvent::Exit => {
                        let _ = state.engine.invalidate();
                    }
                    tauri::RunEvent::WindowEvent {
                        label,
                        event: tauri::WindowEvent::Destroyed,
                        ..
                    } => {
                        let _ = state.engine.close_window(label);
                    }
                    _ => {}
                }
            })
            .build()
    }
}

#[cfg(all(test, not(mobile)))]
mod tests {
    use super::*;
    #[test]
    fn trusted_window_session_contains_metadata_only_and_other_windows_are_denied() {
        let app = tauri::test::mock_builder()
            .plugin(
                Builder::new(
                    f2z_sdk::Config::new("test-public-client"),
                    "https://app.example/return",
                )
                .token_store(Arc::new(f2z_sdk::MemoryStore::new()))
                .build(),
            )
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let other = tauri::WebviewWindowBuilder::new(&app, "untrusted", Default::default())
            .build()
            .unwrap();
        let state = app.state::<Arc<PluginState<tauri::test::MockRuntime>>>();
        let valid =
            tauri::async_runtime::block_on(commands::session(main.as_ref().clone(), state.clone()))
                .unwrap();
        assert_eq!(valid["signedIn"], false);
        assert_eq!(valid["persistence"], "memory_only");
        assert_eq!(valid.as_object().unwrap().len(), 5);
        let error =
            tauri::async_runtime::block_on(commands::session(other.as_ref().clone(), state))
                .unwrap_err();
        assert_eq!(error.code, "window_not_allowed");
    }
    #[test]
    fn command_registry_has_no_credential_or_arbitrary_network_escape() {
        assert_eq!(COMMANDS.len(), 15);
        for forbidden in [
            "token",
            "access_token",
            "refresh_token",
            "request",
            "authorize",
            "redirect",
            "cancelAuth",
            "openBrowser",
        ] {
            assert!(!COMMANDS.contains(&forbidden));
        }
        let permissions = include_str!("../permissions/default.toml");
        assert!(permissions.contains("permissions = []"));
    }
}
