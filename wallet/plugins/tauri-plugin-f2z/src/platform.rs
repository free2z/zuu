//! System browser adapters. Neither authorization URLs nor callback URLs cross IPC.
use crate::wire::{NativeError, Result};
use f2z_sdk::{Client, SignInOptions};

#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileRedirects {
    /// Claimed HTTPS URI registered with Free2Z and associated with this app.
    pub https: Option<String>,
    /// Reverse-domain private scheme URI registered for older OS versions.
    pub private_scheme: Option<String>,
}

#[cfg(not(mobile))]
pub struct Platform;
#[cfg(not(mobile))]
struct DesktopSession(f2z_sdk::oauth::LoopbackSession<fn(&str) -> std::result::Result<(), String>>);
#[cfg(not(mobile))]
impl f2z_sdk::oauth::AuthSession for DesktopSession {
    fn redirect_uri(&self) -> &str {
        self.0.redirect_uri()
    }
    fn authorize<'a>(
        &'a self,
        request: &'a f2z_sdk::oauth::AuthorizationRequest,
    ) -> f2z_sdk::oauth::BoxFuture<'a, std::result::Result<String, f2z_sdk::Error>> {
        Box::pin(async move {
            // OS launch helpers can wait. Never run them on a runtime thread.
            Platform
                .open(request.url.clone())
                .await
                .map_err(|_| f2z_sdk::Error::Browser("browser unavailable".into()))?;
            self.0.authorize(request).await
        })
    }
}
#[cfg(not(mobile))]
impl Platform {
    pub async fn sign_in(&self, client: &Client, options: SignInOptions) -> Result<()> {
        let noop: fn(&str) -> std::result::Result<(), String> = |_| Ok(());
        let session = DesktopSession(
            f2z_sdk::oauth::LoopbackSession::bind(noop)
                .await
                .map_err(NativeError::from)?,
        );
        client
            .sign_in(&session, options)
            .await
            .map_err(NativeError::from)?;
        Ok(())
    }
    pub async fn open(&self, url: String) -> Result<()> {
        tauri::async_runtime::spawn_blocking(move || open::that(url))
            .await
            .map_err(|_| NativeError::new("browser_error"))?
            .map_err(|_| NativeError::new("browser_error"))
    }
}

#[cfg(mobile)]
mod mobile {
    use super::*;
    use f2z_sdk::oauth::{AuthSession, AuthorizationRequest, BoxFuture};
    use serde::{Deserialize, Serialize};
    use tauri::{Runtime, plugin::PluginHandle};

    pub struct MobilePlatform<R: Runtime> {
        pub handle: PluginHandle<R>,
        pub redirects: MobileRedirects,
    }
    #[derive(Deserialize)]
    struct Redirect {
        uri: String,
    }
    #[derive(Deserialize)]
    struct Callback {
        url: String,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Authorize {
        attempt_id: String,
        url: String,
        redirect_uri: String,
        timeout_ms: u64,
    }
    struct Session<R: Runtime> {
        handle: PluginHandle<R>,
        uri: String,
    }
    struct Cancel<R: Runtime>(PluginHandle<R>, String);
    impl<R: Runtime> Drop for Cancel<R> {
        fn drop(&mut self) {
            let handle = self.0.clone();
            let attempt_id = self.1.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let _ = handle.run_mobile_plugin::<serde_json::Value>(
                    "cancelAuth",
                    serde_json::json!({"attemptId":attempt_id}),
                );
            });
        }
    }
    impl<R: Runtime> AuthSession for Session<R> {
        fn redirect_uri(&self) -> &str {
            &self.uri
        }
        fn authorize<'a>(
            &'a self,
            request: &'a AuthorizationRequest,
        ) -> BoxFuture<'a, std::result::Result<String, f2z_sdk::Error>> {
            Box::pin(async move {
                static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
                let attempt_id = NEXT
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                    .to_string();
                let _cancel = Cancel(self.handle.clone(), attempt_id.clone());
                let handle = self.handle.clone();
                let args = Authorize {
                    attempt_id,
                    url: request.url.clone(),
                    redirect_uri: self.uri.clone(),
                    timeout_ms: 300_000,
                };
                let callback = tauri::async_runtime::spawn_blocking(move || {
                    handle.run_mobile_plugin::<Callback>("authorize", args)
                })
                .await
                .map_err(|_| f2z_sdk::Error::Browser("native session unavailable".into()))?
                .map_err(|_| f2z_sdk::Error::Browser("native session ended".into()))?;
                Ok(callback.url)
            })
        }
    }
    impl<R: Runtime> MobilePlatform<R> {
        pub async fn sign_in(&self, client: &Client, options: SignInOptions) -> Result<()> {
            let handle = self.handle.clone();
            let redirects = self.redirects.clone();
            let redirect = tauri::async_runtime::spawn_blocking(move || {
                handle.run_mobile_plugin::<Redirect>("redirect", redirects)
            })
            .await
            .map_err(|_| NativeError::new("browser_error"))?
            .map_err(|_| NativeError::new("configuration_error"))?;
            let session = Session {
                handle: self.handle.clone(),
                uri: redirect.uri,
            };
            client
                .sign_in(&session, options)
                .await
                .map_err(NativeError::from)?;
            Ok(())
        }
        pub async fn open(&self, url: String) -> Result<()> {
            let handle = self.handle.clone();
            tauri::async_runtime::spawn_blocking(move || {
                handle.run_mobile_plugin::<serde_json::Value>(
                    "openBrowser",
                    serde_json::json!({"url":url}),
                )
            })
            .await
            .map_err(|_| NativeError::new("browser_error"))?
            .map_err(|_| NativeError::new("browser_error"))?;
            Ok(())
        }
    }
}
#[cfg(mobile)]
pub use mobile::MobilePlatform;
