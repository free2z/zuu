//! A restriction on existing plugins, not a new command or wallet authority.
use crate::purchase_policy::{blocked_external, blocked_request, ANDROID_NOTICE};
use tauri::{
    ipc::{Invoke, InvokeBody},
    plugin::Plugin,
    AppHandle, RunEvent, Runtime, Url, Webview, Window,
};

pub struct Restricted<R: Runtime, P: Plugin<R>> {
    inner: P,
    android: bool,
    runtime: std::marker::PhantomData<fn() -> R>,
}

pub fn restrict<R: Runtime, P: Plugin<R>>(inner: P, android: bool) -> Restricted<R, P> {
    Restricted {
        inner,
        android,
        runtime: std::marker::PhantomData,
    }
}

impl<R: Runtime, P: Plugin<R>> Plugin<R> for Restricted<R, P> {
    fn name(&self) -> &'static str {
        self.inner.name()
    }
    fn initialize(
        &mut self,
        app: &AppHandle<R>,
        config: serde_json::Value,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.inner.initialize(app, config)
    }
    fn initialization_script(&self) -> Option<String> {
        self.inner
            .initialization_script_2()
            .map(|script| script.script)
    }
    fn window_created(&mut self, window: Window<R>) {
        self.inner.window_created(window);
    }
    fn webview_created(&mut self, webview: Webview<R>) {
        self.inner.webview_created(webview);
    }
    fn on_navigation(&mut self, webview: &Webview<R>, url: &Url) -> bool {
        // All remote documents stay outside the Android app WebView. No web
        // billing/login page can replace the packaged purchase policy.
        let local = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
            || (cfg!(debug_assertions) && url.host_str() == Some("127.0.0.1"));
        (!self.android || local) && self.inner.on_navigation(webview, url)
    }
    fn on_page_load(
        &mut self,
        webview: &Webview<R>,
        payload: &tauri::webview::PageLoadPayload<'_>,
    ) {
        self.inner.on_page_load(webview, payload);
    }
    fn on_event(&mut self, app: &AppHandle<R>, event: &RunEvent) {
        self.inner.on_event(app, event);
    }
    fn extend_api(&mut self, invoke: Invoke<R>) -> bool {
        if self.android {
            let body = match invoke.message.payload() {
                InvokeBody::Json(body) => Some(body),
                _ => None,
            };
            let blocked = match (self.name(), invoke.message.command()) {
                ("http", "fetch") => {
                    let config = body.and_then(|body| body.get("clientConfig"));
                    let url = config
                        .and_then(|c| c.get("url"))
                        .and_then(|u| u.as_str())
                        .and_then(|u| Url::parse(u).ok());
                    let method = config
                        .and_then(|c| c.get("method"))
                        .and_then(|m| m.as_str());
                    match (url, method) {
                        (Some(url), Some(method)) => {
                            blocked_request(url.path(), method)
                            // Do not let an otherwise safe API read redirect
                            // into a denied purchase endpoint. No proxy or
                            // caller-supplied dangerous client settings either.
                            || config.and_then(|c| c.get("maxRedirections")).and_then(|v| v.as_u64()) != Some(0)
                            || config.is_some_and(|c| !c["proxy"].is_null() || !c["danger"].is_null())
                        }
                        _ => true,
                    }
                }
                ("opener", "open_url") => {
                    match body
                        .and_then(|b| b.get("url"))
                        .and_then(|v| v.as_str())
                        .and_then(|u| Url::parse(u).ok())
                    {
                        Some(url) => {
                            blocked_external(url.scheme(), url.host_str().unwrap_or(""), url.path())
                        }
                        None => true,
                    }
                }
                _ => false,
            };
            if blocked {
                invoke.resolver.reject(ANDROID_NOTICE);
                return true;
            }
        }
        self.inner.extend_api(invoke)
    }
}
