//! Desktop OAuth transport for social login (X / Google / GitHub) — the
//! RFC 8252 "loopback redirect" pattern. This module is ZUULI-specific (not
//! part of the shared `tauri-plugin-zcash` crate) and owns exactly one thing:
//! a local, single-use `127.0.0.1` HTTP listener that captures the
//! authorization-code redirect from the system browser.
//!
//! Everything else — asking the free2z backend which providers are
//! configured, building `authorize_url`, opening the system browser, and
//! POSTing the captured `{code, state}` back — is orchestrated by the
//! frontend (`src/lib/oauth/transport.ts` / `src/lib/api/free2z.ts`). This
//! keeps the Rust side dumb and small: bind loopback-only, accept ONE
//! request, reply with a static page, and shut down.
//!
//! Two commands, not one, because the frontend needs the bound PORT before it
//! can ask the backend to build `authorize_url` (its `redirect_uri` bakes the
//! port in), but must not block on that call — the actual wait for the
//! provider's redirect only starts after the system browser has been opened:
//!
//!   1. [`oauth_loopback_start`] binds `127.0.0.1:0`, mints a random one-time
//!      path nonce, and returns `{ port, redirect_path }` immediately.
//!   2. [`oauth_loopback_wait`] blocks (up to a 5-minute timeout) for the ONE
//!      inbound `GET /<nonce>?code=...&state=...`, replies with a minimal
//!      "you can close this tab" page, and returns `{ code, state }`.
//!
//! The listener is bound to loopback only, serves exactly one request, and is
//! dropped immediately after — nothing keeps listening once the round trip is
//! done.

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;
use tiny_http::{Header, Response, Server};

/// Holds the bound-but-not-yet-consumed loopback listener between the two
/// commands below. `Default` gives us `None` with no `Server` required.
#[derive(Default)]
pub struct OauthLoopbackState(Mutex<Option<(Server, String)>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopbackStart {
    port: u16,
    redirect_path: String,
}

#[derive(Serialize)]
pub struct LoopbackResult {
    code: String,
    state: String,
}

const SUCCESS_HTML: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>ZUULI</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0b0b12;color:#eee;display:flex;height:100vh;align-items:center;justify-content:center;text-align:center">
<div><h2>You can close this tab</h2><p style="color:#999">Finishing sign-in in ZUULI…</p></div>
</body></html>"#;

const INCOMPLETE_HTML: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>ZUULI</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0b0b12;color:#eee;display:flex;height:100vh;align-items:center;justify-content:center;text-align:center">
<div><h2>Sign-in didn't complete</h2><p style="color:#999">Return to ZUULI and try again.</p></div>
</body></html>"#;

/// A zero-dependency source of randomness for the one-time path nonce.
/// `std::collections::hash_map::RandomState` seeds its SipHash keys from the
/// OS RNG (the same entropy `HashMap` relies on to resist hash-flooding), so
/// hashing a counter with a fresh `RandomState` yields OS-derived bits without
/// pulling in a `rand` crate. The nonce only needs to resist another local
/// process guessing the path during the few-minute window the listener is
/// open — not survive a cryptographic attacker — so this is a good fit.
fn random_hex(bytes: usize) -> String {
    let mut out = String::with_capacity(bytes * 2);
    let mut counter: u64 = 0;
    while out.len() < bytes * 2 {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(counter);
        hasher.write_u64(Instant::now().elapsed().as_nanos() as u64);
        out.push_str(&format!("{:016x}", hasher.finish()));
        counter = counter.wrapping_add(1);
    }
    out.truncate(bytes * 2);
    out
}

/// Percent-decode a query-string value (`application/x-www-form-urlencoded`
/// style: `+` is a space). Hand-rolled to avoid a dependency for something
/// this small; OAuth `code`/`state` values are short opaque tokens.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(byte) = u8::from_str_radix(
                    std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                    16,
                ) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parse the query string off a raw request target (`/<nonce>?a=b&c=d`).
fn parse_query(target: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Some((_, q)) = target.split_once('?') {
        for pair in q.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                map.insert(percent_decode(k), percent_decode(v));
            } else if !pair.is_empty() {
                map.insert(percent_decode(pair), String::new());
            }
        }
    }
    map
}

fn html_response(body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let header = Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
        .expect("static header is valid ASCII");
    Response::from_string(body).with_header(header)
}

/// Bind an ephemeral loopback listener and return its port + a random
/// one-time path nonce the caller must include in `redirect_uri`.
#[tauri::command]
pub async fn oauth_loopback_start(
    state: State<'_, OauthLoopbackState>,
) -> Result<LoopbackStart, String> {
    let nonce = random_hex(16);
    let server = tauri::async_runtime::spawn_blocking(|| {
        // 127.0.0.1 only (never 0.0.0.0) — this must not be reachable off the
        // machine. Port 0 asks the OS for any free ephemeral port.
        Server::http("127.0.0.1:0").map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    let port = match server.server_addr().to_ip() {
        Some(addr) => addr.port(),
        None => return Err("loopback listener bound to a non-IP address".to_string()),
    };

    let mut guard = state
        .0
        .lock()
        .map_err(|_| "oauth loopback state lock poisoned".to_string())?;
    *guard = Some((server, nonce.clone()));

    Ok(LoopbackStart {
        port,
        redirect_path: nonce,
    })
}

/// Wait (up to 5 minutes) for the single provider redirect to
/// `http://127.0.0.1:<port>/<redirect_path>?code=...&state=...`, reply with a
/// static "you can close this tab" page, and return the captured values. The
/// listener is consumed and dropped (closed) by this call either way.
#[tauri::command]
pub async fn oauth_loopback_wait(
    state: State<'_, OauthLoopbackState>,
) -> Result<LoopbackResult, String> {
    let (server, nonce) = state
        .0
        .lock()
        .map_err(|_| "oauth loopback state lock poisoned".to_string())?
        .take()
        .ok_or_else(|| {
            "no loopback listener is active — call oauth_loopback_start first".to_string()
        })?;

    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(5 * 60);
        let expected_prefix = format!("/{nonce}");
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("timed out waiting for the OAuth redirect".to_string());
            }
            let request = match server.recv_timeout(remaining) {
                Ok(Some(req)) => req,
                Ok(None) => continue, // recv_timeout's own tick elapsed; recheck our deadline
                Err(e) => return Err(format!("loopback listener error: {e}")),
            };

            let target = request.url().to_string();
            if !target.starts_with(&expected_prefix) {
                // Not our nonce path (stray probe, favicon request, etc.) —
                // answer politely and keep waiting for the real redirect.
                let _ = request.respond(Response::from_string("Not found").with_status_code(
                    tiny_http::StatusCode(404),
                ));
                continue;
            }

            let params = parse_query(&target);
            let code = params.get("code").cloned();
            let oauth_state = params.get("state").cloned();
            let _ = request.respond(html_response(if code.is_some() && oauth_state.is_some() {
                SUCCESS_HTML
            } else {
                INCOMPLETE_HTML
            }));

            return match (code, oauth_state) {
                (Some(code), Some(state)) => Ok(LoopbackResult { code, state }),
                _ => Err("the provider redirect was missing `code` or `state`".to_string()),
            };
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
