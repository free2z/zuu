//! What the content surface's native HTTP client may actually reach.
//!
//! #918 exists because every earlier green measurement was taken where the bug
//! could not appear. vitest, Playwright and `npm run build` all run with
//! `isTauri() === false` or `import.meta.env.DEV === true` — exactly the branch
//! that does NOT take the native path — and `cargo check` compiles a backend
//! nobody asked whether the frontend's commands exist in it.
//!
//! So this test does not read the JSON and agree with it. It builds a real
//! Tauri app from this crate's REAL `tauri.conf.json` and REAL
//! `capabilities/*.json` — `generate_context!()` embeds the resolved ACL — puts
//! `tauri-plugin-http` in it exactly as `lib.rs` does, and drives
//! `plugin:http|fetch` over the IPC path a webview uses. The verdict comes from
//! the plugin's own scope evaluation, not from this file's opinion of it.
//!
//! `fetch` builds the request and hands back a resource id WITHOUT performing
//! any network I/O (the future is only polled by `fetch_send`), so an allowed
//! origin is provable offline and in CI: reaching a resource id means the ACL
//! admitted the command and the URL scope admitted the origin.

use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{WebviewWindow, WebviewWindowBuilder};

/// The real app: real config, real capabilities, and the same plugin set
/// `free2z_lib::run` registers.
fn main_window() -> WebviewWindow<MockRuntime> {
    policy_window(false)
}

fn policy_window(android: bool) -> WebviewWindow<MockRuntime> {
    let app = mock_builder()
        .plugin(free2z_lib::purchase_bridge::restrict(
            tauri_plugin_http::init(),
            android,
        ))
        .build(tauri::generate_context!())
        .expect("the free2z app builds from its own tauri.conf.json");
    // "main" is the label both capability files scope themselves to.
    WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("the main webview")
}

/// The packaged webview's own origin, which is what the ACL calls "local".
/// Tauri serves the app from a custom protocol everywhere except Windows and
/// Android, where the same thing is spelled `http://tauri.localhost`.
#[cfg(any(windows, target_os = "android"))]
const WEBVIEW_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(any(windows, target_os = "android")))]
const WEBVIEW_ORIGIN: &str = "tauri://localhost";

fn fetch(window: &WebviewWindow<MockRuntime>, url: &str) -> Result<(), String> {
    fetch_request(window, url, "GET", Some(0))
}

fn fetch_request(
    window: &WebviewWindow<MockRuntime>,
    url: &str,
    method: &str,
    redirects: Option<usize>,
) -> Result<(), String> {
    let request = InvokeRequest {
        cmd: "plugin:http|fetch".into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        // The webview's own origin. The capability is scoped to `local` URLs,
        // and this is what "local" means — but that is NOT what keeps a remote
        // frame out: #367 is precisely the defect where Wry reports the
        // top-level (local) URL for a subframe's IPC. So the reach of this
        // command has to be decided by URL scope, not by caller.
        url: WEBVIEW_ORIGIN.parse().unwrap(),
        body: InvokeBody::Json(serde_json::json!({
            "clientConfig": {
                "method": method,
                "url": url,
                "headers": [["accept", "application/json"]],
                "data": null,
                "maxRedirections": redirects,
            }
        })),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    tauri::test::get_ipc_response(window, request)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Every origin the frontend actually talks to over the native client:
/// `src/lib/api/http.ts` (the whole API surface) and
/// `src/components/common/RemoteMedia.tsx` (first-party image downloads).
#[test]
fn the_free2z_api_and_media_hosts_are_reachable() {
    let window = main_window();
    for url in [
        "https://free2z.cash/api/articles/",
        "https://free2z.cash/api/token/login/",
        "https://free2z.cash/uploadz/public/cover.webp",
        "https://stage.free2z.cash/api/articles/",
        "https://new.free2z.cash/api/auth/social/providers/",
        "https://free2z.com/api/articles/",
        "https://www.free2z.com/uploadz/public/cover.webp",
    ] {
        assert_eq!(
            fetch(&window, url),
            Ok(()),
            "the packaged capability must admit {url}; without it every API \
             request and every first-party image in a packaged build fails"
        );
    }
}

/// The scope is the boundary, so the refusals are asserted rather than merely
/// omitted. A content surface's HTTP client that can reach anything is the
/// thing #918 refused to ship, and each of these is a way it could.
#[test]
fn everything_else_is_refused() {
    let window = main_window();
    for (url, why) in [
        ("https://example.com/", "an unrelated origin"),
        (
            "https://api.realtime.cloudflare.com/v2/internals/participant-details",
            "the RealtimeKit SDK talks from the webview, not through this client",
        ),
        (
            "http://free2z.cash/api/articles/",
            "plaintext http, even to our own host",
        ),
        (
            "http://127.0.0.1:8080/",
            "loopback — no local service is reachable",
        ),
        ("http://localhost:1425/", "the dev server"),
        (
            "https://free2z.cash.evil.example/api/",
            "a suffix-confusion host",
        ),
        (
            "https://evil.example/free2z.cash/api/",
            "our host inside someone's path",
        ),
        ("https://free2z.cash@evil.example/", "our host as userinfo"),
        (
            "https://metadata.google.internal/",
            "a cloud metadata endpoint",
        ),
    ] {
        let result = fetch(&window, url);
        assert!(
            result.is_err(),
            "free2z's HTTP client must not reach {url} ({why}), got {result:?}"
        );
    }
}

/// The permission identifier alone decides nothing. `http:default` is
/// `allow-fetch` with an EMPTY allow list, and an empty allow list denies every
/// http/https URL — which is why the capability files carry an explicit scope
/// and why `surface-capability-authority.mjs` refuses the bare string form.
#[test]
fn the_scope_is_actually_consulted() {
    let window = main_window();
    // Negative control for the test above: if the scope were being ignored and
    // `fetch` were simply always succeeding, this would pass too.
    assert!(fetch(&window, "https://example.com/").is_err());
    assert_eq!(fetch(&window, "https://free2z.cash/api/articles/"), Ok(()));
}

/// Actual production plugin wrapper + real plugin IPC + real embedded ACL.
/// Forced Android policy on the host is a compiled seam test, NOT device proof.
#[test]
fn android_purchase_bridges_fail_closed_without_losing_receipts() {
    let window = policy_window(true);
    for path in [
        "/api/stripe/create-checkout-session/",
        "/api/pricing/quote/?tuzis=100",
        "/api/zpage/x/variants/fr/translate/quote/",
        "/api/economy/usage-purchase-quote/",
        "/api/tuzis/donate-idempotent/alice",
        "/api/e2ee/chat-requests/price/",
        "/api/%73tripe/create-checkout-session/",
    ] {
        let result = fetch(&window, &format!("https://free2z.cash{path}"));
        assert!(
            result
                .unwrap_err()
                .contains(free2z_lib::purchase_policy::ANDROID_NOTICE),
            "{path}"
        );
    }
    for path in [
        "/api/stripe/transactions/",
        "/api/tuzis/subscription-status/alice",
        "/api/tuzis/my-subscriptions",
        "/api/articles/",
    ] {
        assert_eq!(
            fetch(&window, &format!("https://free2z.cash{path}")),
            Ok(()),
            "{path}"
        );
    }
}

#[test]
fn android_direct_ipc_writes_and_redirect_bypasses_are_refused() {
    let window = policy_window(true);
    for path in [
        "/api/tuzis/subscribe/alice",
        "/api/tuzis/subscribe-confirmed/alice",
        "/api/openai/prompt",
        "/api/ai/conversations/x/promptresponses/",
        "/api/comments/x/vote/",
        "/api/comments/zpage/x/",
        "/api/comments/x/replies/",
        "/api/dyte/alice/ppv",
        "/api/e2ee/chat-requests/alice/",
        "/api/ai/prompt/",
        "/api/openai/image",
        "/api/zpage/fund/",
        "/api/zpage/x/vote/",
        "/api/storytime/x/image",
        "/api/sdk/v1/purchases",
        "/api/sdk/v1/grant",
        "/v1/chat",
        "/v1/chat/estimate",
        "/api/mcp",
        "/api/economy/usage-purchases/",
        "/api//tuzis/subscribe/alice",
    ] {
        for method in ["POST", "PATCH", "PUT"] {
            let result = fetch_request(
                &window,
                &format!("https://free2z.cash{path}"),
                method,
                Some(0),
            );
            assert!(
                result
                    .unwrap_err()
                    .contains(free2z_lib::purchase_policy::ANDROID_NOTICE),
                "{path} {method}"
            );
        }
    }
    assert!(fetch_request(
        &window,
        "https://free2z.cash/api/zpage/x/translations/",
        "POST",
        Some(0)
    )
    .is_err());
    for redirects in [None, Some(1), Some(10)] {
        assert!(fetch_request(
            &window,
            "https://free2z.cash/api/articles/",
            "GET",
            redirects
        )
        .is_err());
    }
    for (path, method) in [
        ("/api/stripe/native-return/claim/", "POST"),
        ("/api/stripe/native-return/status/", "POST"),
        ("/api/tuzis/subscribe/alice", "DELETE"),
        ("/api/tuzis/subscribe-recovery/1", "POST"),
        ("/api/sdk/v1/purchases/receipt-id", "GET"),
        ("/v1/calls/receipt-id", "GET"),
        ("/api/zpage/x/translations/", "GET"),
        ("/api/zpage/", "POST"),
        ("/api/tuzis/subscription-status/%C3%A9lodie", "GET"),
        ("/api/dyte/alice/subscribers-only", "POST"),
        ("/api/dyte/alice/broadcast", "POST"),
    ] {
        assert_eq!(
            fetch_request(
                &window,
                &format!("https://free2z.cash{path}"),
                method,
                Some(0)
            ),
            Ok(())
        );
    }
    // Other platforms keep existing plugin behavior.
    let web = policy_window(false);
    assert_eq!(
        fetch_request(
            &web,
            "https://free2z.cash/api/tuzis/subscribe/alice",
            "POST",
            None
        ),
        Ok(())
    );
}

#[test]
fn android_direct_opener_cannot_launch_checkout_or_web_billing() {
    let app = mock_builder()
        .plugin(free2z_lib::purchase_bridge::restrict(
            tauri_plugin_opener::init(),
            true,
        ))
        .build(tauri::generate_context!())
        .unwrap();
    let window = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    for url in [
        "https://checkout.stripe.com/c/pay/stale",
        "https://free2z.cash/billing",
        "https://stage.free2z.cash/login?next=/billing",
        "https://free2z.com/buy",
        "https://free2z.cash/api/stripe/create-checkout-session/",
    ] {
        let request = InvokeRequest {
            cmd: "plugin:opener|open_url".into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: WEBVIEW_ORIGIN.parse().unwrap(),
            body: InvokeBody::Json(serde_json::json!({ "url": url })),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        };
        let error = tauri::test::get_ipc_response(&window, request).unwrap_err();
        assert!(
            error
                .to_string()
                .contains(free2z_lib::purchase_policy::ANDROID_NOTICE),
            "{url}: {error}"
        );
    }
    assert!(!free2z_lib::purchase_policy::blocked_external(
        "https",
        "free2z.com",
        "/bridge/zuuli/"
    ));
    assert!(!free2z_lib::purchase_policy::blocked_external(
        "https",
        "free2z.com",
        "/bridge/e2e2z/chat/"
    ));
}

#[test]
fn android_remote_webview_navigation_cannot_replace_the_purchase_policy() {
    use tauri::plugin::Plugin;
    let window = policy_window(true);
    let webview = window.as_ref().clone();
    let mut plugin = free2z_lib::purchase_bridge::restrict(tauri_plugin_http::init(), true);
    for url in [
        "https://free2z.cash/billing",
        "https://checkout.stripe.com/c/pay",
        "https://example.com/",
    ] {
        assert!(!plugin.on_navigation(&webview, &url.parse().unwrap()));
    }
    assert!(plugin.on_navigation(&webview, &WEBVIEW_ORIGIN.parse().unwrap()));
}
