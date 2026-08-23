//! OAuth callback transports for ZUULI social login.
//!
//! Desktop uses RFC 8252 loopback on an ephemeral `127.0.0.1` port. iOS and
//! Android use the reverse-domain private-use redirect
//! `cash.free2z.zuuli://oauth/callback`. The mobile redirect is deliberately
//! exact: the OS registration, the Tauri deep-link configuration, this Rust
//! parser, the TypeScript authorization response validator, and free2z's
//! server-side allowlist all name the same scheme, host and path.
//!
//! On mobile the app owns the PKCE verifier; only its S256 challenge leaves the
//! sandbox. Providers return to a fixed free2z HTTPS relay, which consumes a
//! separate provider-facing state before redirecting to this private-use URI.
//! The local completion state is additionally bound to provider,
//! login-vs-associate mode, and the Knox session that initiated an association.
//! Pending state is crash-safe so a cold-start callback can finish, and
//! transitions to `received` before returning a code to the webview.

use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};
use tiny_http::{Header, Method, Response, Server, StatusCode};
use url::Url;

pub const MOBILE_REDIRECT_URI: &str = "cash.free2z.zuuli://oauth/callback";
const MOBILE_SCHEME: &str = "cash.free2z.zuuli";
const MOBILE_HOST: &str = "oauth";
const MOBILE_PATH: &str = "/callback";
const OAUTH_TTL: Duration = Duration::from_secs(10 * 60);
const LOOPBACK_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const LOOPBACK_CANCEL_POLL: Duration = Duration::from_millis(50);
const MAX_CALLBACK_URL_BYTES: usize = 8 * 1024;
const MAX_CODE_BYTES: usize = 4 * 1024;
const MAX_STATE_BYTES: usize = 512;
const PENDING_VERSION: u8 = 1;

enum LoopbackFlow {
    Ready {
        server: Server,
        nonce: String,
    },
    Waiting {
        server: Arc<Server>,
        nonce: String,
        cancelled: Arc<AtomicBool>,
    },
}

#[derive(Default)]
pub struct OauthLoopbackState(Arc<Mutex<Option<LoopbackFlow>>>);

/// Serializes every read/transition/write of the crash-safe mobile record.
#[derive(Default)]
pub struct OauthMobileState(Mutex<()>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopbackStart {
    port: u16,
    redirect_path: String,
}

#[derive(Serialize)]
pub struct OauthCapture {
    code: String,
    state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileArmArgs {
    provider: String,
    state: String,
    associate: bool,
    session_binding: String,
    code_verifier: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileClaimSessionArgs {
    session_binding: String,
    expected_state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileClaimArgs {
    callback_url: String,
    session_binding: String,
    expected_state: String,
}

#[derive(Deserialize)]
pub struct MobileFinishArgs {
    state: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingMobileOauth {
    version: u8,
    provider: String,
    state: String,
    redirect_uri: String,
    associate: bool,
    session_binding: String,
    code_verifier: String,
    created_at_unix_ms: u64,
    phase: PendingPhase,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum PendingPhase {
    Armed,
    Received { code: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobilePendingSummary {
    provider: String,
    associate: bool,
    phase: &'static str,
    state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileCapture {
    provider: String,
    associate: bool,
    code: String,
    state: String,
    redirect_uri: String,
    code_verifier: String,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum MobileClaimResult {
    Ignored,
    Captured { capture: MobileCapture },
    Rejected { message: String },
    Cancelled { message: String },
}

enum ParsedCallback {
    Code { code: String, state: String },
    Error { state: String },
}

enum PendingAction {
    Keep(MobileClaimResult),
    Save(MobileClaimResult),
    Remove(MobileClaimResult),
}

const SUCCESS_HTML: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>ZUULI</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0b0b12;color:#eee;display:flex;height:100vh;align-items:center;justify-content:center;text-align:center">
<div><h2>You can close this tab</h2><p style="color:#999">Finishing sign-in in ZUULI…</p></div>
</body></html>"#;

const INCOMPLETE_HTML: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>ZUULI</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0b0b12;color:#eee;display:flex;height:100vh;align-items:center;justify-content:center;text-align:center">
<div><h2>Sign-in didn't complete</h2><p style="color:#999">Return to ZUULI and try again.</p></div>
</body></html>"#;

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut random = vec![0_u8; bytes];
    getrandom::fill(&mut random).map_err(|e| format!("OS randomness unavailable: {e}"))?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn single_query(url: &Url, name: &str) -> Result<Option<String>, String> {
    let values = url
        .query_pairs()
        .filter(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
        .collect::<Vec<_>>();
    match values.as_slice() {
        [] => Ok(None),
        [value] => Ok(Some(value.clone())),
        _ => Err(format!("OAuth callback repeated `{name}`")),
    }
}

fn parse_callback(url: &Url) -> Result<ParsedCallback, String> {
    let state = single_query(url, "state")?
        .filter(|value| !value.is_empty() && value.len() <= MAX_STATE_BYTES)
        .ok_or_else(|| "OAuth callback is missing a valid `state`".to_string())?;
    let code = single_query(url, "code")?;
    let error = single_query(url, "error")?;
    if code.is_some() == error.is_some() {
        return Err("OAuth callback must contain exactly one of `code` or `error`".to_string());
    }
    if let Some(code) = code {
        if code.is_empty() || code.len() > MAX_CODE_BYTES {
            return Err("OAuth callback contains an invalid authorization code".to_string());
        }
        Ok(ParsedCallback::Code { code, state })
    } else {
        Ok(ParsedCallback::Error { state })
    }
}

fn html_response(body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let headers = [
        ("Content-Type", "text/html; charset=utf-8"),
        ("Cache-Control", "no-store"),
        (
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'",
        ),
        ("X-Content-Type-Options", "nosniff"),
    ];
    headers
        .into_iter()
        .fold(Response::from_string(body), |response, (name, value)| {
            response.with_header(
                Header::from_bytes(name.as_bytes(), value.as_bytes())
                    .expect("static OAuth response header is valid ASCII"),
            )
        })
}

fn valid_mobile_provider(provider: &str) -> bool {
    matches!(provider, "x" | "google")
}

fn valid_state(state: &str) -> bool {
    (16..=MAX_STATE_BYTES).contains(&state.len())
        && state
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && byte != b'"' && byte != b'\\')
}

fn valid_session_binding(binding: &str, associate: bool) -> bool {
    if !associate {
        return binding == "login:none";
    }
    binding
        .strip_prefix("associate:")
        .is_some_and(|digest| digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn valid_pkce_verifier(verifier: &str) -> bool {
    verifier.len() == 43
        && verifier
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn now_unix_ms() -> Result<u64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is before the Unix epoch".to_string())?
        .as_millis();
    u64::try_from(millis).map_err(|_| "system clock value is out of range".to_string())
}

fn is_expired(pending: &PendingMobileOauth, now_ms: u64) -> bool {
    now_ms.saturating_sub(pending.created_at_unix_ms)
        >= u64::try_from(OAUTH_TTL.as_millis()).expect("OAuth TTL fits u64")
}

fn pending_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("oauth").join("pending-v1.json"))
        .map_err(|e| format!("cannot resolve OAuth state directory: {e}"))
}

fn load_pending(path: &Path) -> Result<Option<PendingMobileOauth>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot read OAuth pending state: {error}")),
    };
    if file
        .metadata()
        .map_err(|e| format!("cannot inspect OAuth pending state: {e}"))?
        .len()
        > 16 * 1024
    {
        return Err("OAuth pending state is unexpectedly large".to_string());
    }
    let pending: PendingMobileOauth = serde_json::from_reader(BufReader::new(file))
        .map_err(|_| "OAuth pending state is corrupt".to_string())?;
    if pending.version != PENDING_VERSION
        || !valid_mobile_provider(&pending.provider)
        || !valid_state(&pending.state)
        || pending.redirect_uri != MOBILE_REDIRECT_URI
        || !valid_session_binding(&pending.session_binding, pending.associate)
        || !valid_pkce_verifier(&pending.code_verifier)
    {
        return Err("OAuth pending state failed validation".to_string());
    }
    Ok(Some(pending))
}

fn save_pending(path: &Path, pending: &PendingMobileOauth) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "OAuth pending state path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("cannot create OAuth state directory: {e}"))?;
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp)
        .map_err(|e| format!("cannot create OAuth pending state: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("cannot secure OAuth pending state: {e}"))?;
    }
    let mut writer = BufWriter::new(file);
    serde_json::to_writer(&mut writer, pending)
        .map_err(|e| format!("cannot encode OAuth pending state: {e}"))?;
    writer
        .flush()
        .map_err(|e| format!("cannot flush OAuth pending state: {e}"))?;
    writer
        .get_ref()
        .sync_all()
        .map_err(|e| format!("cannot persist OAuth pending state: {e}"))?;
    drop(writer);

    #[cfg(not(windows))]
    {
        // POSIX rename-over-existing is atomic. This is the crash-safety
        // guarantee for iOS, Android, macOS and Linux.
        if let Err(error) = fs::rename(&temp, path) {
            let _ = fs::remove_file(&temp);
            return Err(format!("cannot install OAuth pending state: {error}"));
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        // Windows rename cannot overwrite. The mobile commands are unreachable
        // there, but keep the persistence helper correct for its unit tests and
        // for any future transport reuse.
        let backup = path.with_extension("backup");
        let _ = fs::remove_file(&backup);
        let had_existing = path.exists();
        if had_existing {
            fs::rename(path, &backup)
                .map_err(|e| format!("cannot stage old OAuth pending state: {e}"))?;
        }
        if let Err(error) = fs::rename(&temp, path) {
            if had_existing {
                let _ = fs::rename(&backup, path);
            }
            let _ = fs::remove_file(&temp);
            return Err(format!("cannot install OAuth pending state: {error}"));
        }
        if had_existing {
            let _ = fs::remove_file(backup);
        }
        Ok(())
    }
}

fn remove_pending(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("cannot clear OAuth pending state: {error}")),
    }
}

fn pending_matches_state(pending: &PendingMobileOauth, expected_state: &str) -> bool {
    pending.state == expected_state
}

fn capture_from_pending(pending: &PendingMobileOauth, code: String) -> MobileCapture {
    MobileCapture {
        provider: pending.provider.clone(),
        associate: pending.associate,
        code,
        state: pending.state.clone(),
        redirect_uri: pending.redirect_uri.clone(),
        code_verifier: pending.code_verifier.clone(),
    }
}

fn validate_mobile_target(url: &Url) -> bool {
    url.scheme() == MOBILE_SCHEME
        && url.host_str() == Some(MOBILE_HOST)
        && url.path() == MOBILE_PATH
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

fn evaluate_mobile_claim(
    pending: &mut PendingMobileOauth,
    callback_url: &str,
    session_binding: &str,
) -> PendingAction {
    if pending.session_binding != session_binding {
        return PendingAction::Remove(MobileClaimResult::Rejected {
            message: "The account session changed while sign-in was open. Start again.".to_string(),
        });
    }
    if matches!(pending.phase, PendingPhase::Received { .. })
        || callback_url.len() > MAX_CALLBACK_URL_BYTES
    {
        return PendingAction::Keep(MobileClaimResult::Ignored);
    }
    let url = match Url::parse(callback_url) {
        Ok(url) if validate_mobile_target(&url) => url,
        _ => return PendingAction::Keep(MobileClaimResult::Ignored),
    };
    let parsed = match parse_callback(&url) {
        Ok(parsed) => parsed,
        Err(message) => {
            if single_query(&url, "state").ok().flatten().as_deref() == Some(&pending.state) {
                return PendingAction::Remove(MobileClaimResult::Rejected { message });
            }
            return PendingAction::Keep(MobileClaimResult::Ignored);
        }
    };
    let callback_state = match &parsed {
        ParsedCallback::Code { state, .. } | ParsedCallback::Error { state } => state,
    };
    if callback_state != &pending.state {
        return PendingAction::Keep(MobileClaimResult::Ignored);
    }
    match parsed {
        ParsedCallback::Error { .. } => PendingAction::Remove(MobileClaimResult::Cancelled {
            message: "Sign-in was cancelled.".to_string(),
        }),
        ParsedCallback::Code { code, .. } => {
            let capture = capture_from_pending(pending, code.clone());
            pending.phase = PendingPhase::Received { code };
            PendingAction::Save(MobileClaimResult::Captured { capture })
        }
    }
}

/// Desktop vs mobile selection without user-agent sniffing.
#[tauri::command]
pub fn oauth_callback_transport() -> &'static str {
    if cfg!(mobile) {
        "mobile"
    } else {
        "desktop"
    }
}

fn wait_for_loopback(
    server: &Server,
    nonce: &str,
    expected_state: &str,
    cancelled: &AtomicBool,
    timeout: Duration,
) -> Result<OauthCapture, String> {
    let deadline = Instant::now() + timeout;
    let expected_path = format!("/{nonce}");
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err("Sign-in was cancelled.".to_string());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("timed out waiting for the OAuth redirect".to_string());
        }
        let request = match server.recv_timeout(remaining.min(LOOPBACK_CANCEL_POLL)) {
            Ok(Some(request)) => request,
            Ok(None) => continue,
            Err(error) => return Err(format!("OAuth loopback listener error: {error}")),
        };
        if request.method() != &Method::Get {
            let _ = request.respond(
                Response::from_string("Method not allowed").with_status_code(StatusCode(405)),
            );
            continue;
        }
        let target = request.url();
        if target.len() > MAX_CALLBACK_URL_BYTES {
            let _ = request.respond(
                Response::from_string("Request too large").with_status_code(StatusCode(414)),
            );
            continue;
        }
        let url = match Url::parse(&format!("http://127.0.0.1{target}")) {
            Ok(url) if url.path() == expected_path && url.fragment().is_none() => url,
            _ => {
                let _ = request
                    .respond(Response::from_string("Not found").with_status_code(StatusCode(404)));
                continue;
            }
        };
        let parsed = match parse_callback(&url) {
            Ok(parsed) => parsed,
            Err(_) => {
                let _ = request.respond(html_response(INCOMPLETE_HTML));
                continue;
            }
        };
        match parsed {
            ParsedCallback::Code { code, state } if state == expected_state => {
                let _ = request.respond(html_response(SUCCESS_HTML));
                return Ok(OauthCapture { code, state });
            }
            ParsedCallback::Error { state } if state == expected_state => {
                let _ = request.respond(html_response(INCOMPLETE_HTML));
                return Err("Sign-in was cancelled.".to_string());
            }
            _ => {
                // A local process that did not know the backend-minted state
                // cannot consume the listener. Keep waiting.
                let _ = request.respond(html_response(INCOMPLETE_HTML));
            }
        }
    }
}

fn cancel_loopback(flow: &mut Option<LoopbackFlow>, redirect_path: &str) -> bool {
    match flow {
        Some(LoopbackFlow::Ready { nonce, .. }) if nonce == redirect_path => {
            flow.take();
            true
        }
        Some(LoopbackFlow::Waiting {
            server,
            nonce,
            cancelled,
        }) if nonce == redirect_path => {
            cancelled.store(true, Ordering::Release);
            server.unblock();
            true
        }
        _ => false,
    }
}

#[tauri::command]
pub async fn oauth_loopback_start(
    state: State<'_, OauthLoopbackState>,
) -> Result<LoopbackStart, String> {
    if cfg!(mobile) {
        return Err("desktop OAuth loopback is unavailable on mobile".to_string());
    }
    let nonce = random_hex(16)?;
    let server = tauri::async_runtime::spawn_blocking(|| {
        Server::http("127.0.0.1:0").map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let port = server
        .server_addr()
        .to_ip()
        .map(|addr| addr.port())
        .ok_or_else(|| "loopback listener bound to a non-IP address".to_string())?;
    let mut flow = state
        .0
        .lock()
        .map_err(|_| "OAuth loopback state lock poisoned".to_string())?;
    match flow.as_ref() {
        Some(LoopbackFlow::Waiting { cancelled, .. }) if cancelled.load(Ordering::Acquire) => {}
        Some(_) => return Err("an OAuth loopback listener is already active".to_string()),
        None => {}
    }
    *flow = Some(LoopbackFlow::Ready {
        server,
        nonce: nonce.clone(),
    });
    Ok(LoopbackStart {
        port,
        redirect_path: nonce,
    })
}

#[tauri::command]
pub async fn oauth_loopback_wait(
    state: State<'_, OauthLoopbackState>,
    expected_state: String,
    redirect_path: String,
) -> Result<OauthCapture, String> {
    if !valid_state(&expected_state)
        || redirect_path.len() != 32
        || !redirect_path.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("free2z returned an invalid OAuth state".to_string());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    let server = {
        let mut flow = state
            .0
            .lock()
            .map_err(|_| "OAuth loopback state lock poisoned".to_string())?;
        match flow.take() {
            Some(LoopbackFlow::Ready { server, nonce }) if nonce == redirect_path => {
                let server = Arc::new(server);
                *flow = Some(LoopbackFlow::Waiting {
                    server: Arc::clone(&server),
                    nonce,
                    cancelled: Arc::clone(&cancelled),
                });
                server
            }
            Some(other) => {
                *flow = Some(other);
                return Err("OAuth loopback listener does not match this flow".to_string());
            }
            None => return Err("no OAuth loopback listener is active".to_string()),
        }
    };
    let shared = Arc::clone(&state.0);
    let completed_path = redirect_path.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        wait_for_loopback(
            server.as_ref(),
            &redirect_path,
            &expected_state,
            &cancelled,
            LOOPBACK_TIMEOUT,
        )
    })
    .await;

    let mut flow = shared
        .lock()
        .map_err(|_| "OAuth loopback state lock poisoned".to_string())?;
    if matches!(
        flow.as_ref(),
        Some(LoopbackFlow::Waiting { nonce, .. }) if nonce == &completed_path
    ) {
        flow.take();
    }
    joined.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn oauth_loopback_cancel(
    state: State<'_, OauthLoopbackState>,
    redirect_path: String,
) -> Result<(), String> {
    let mut flow = state
        .0
        .lock()
        .map_err(|_| "OAuth loopback state lock poisoned".to_string())?;
    cancel_loopback(&mut flow, &redirect_path);
    Ok(())
}

#[tauri::command]
pub fn oauth_mobile_arm<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, OauthMobileState>,
    args: MobileArmArgs,
) -> Result<(), String> {
    if !cfg!(mobile) {
        return Err("mobile OAuth callback is unavailable on desktop".to_string());
    }
    if !valid_mobile_provider(&args.provider)
        || !valid_state(&args.state)
        || !valid_session_binding(&args.session_binding, args.associate)
        || !valid_pkce_verifier(&args.code_verifier)
    {
        return Err("invalid mobile OAuth pending state".to_string());
    }
    let _guard = state
        .0
        .lock()
        .map_err(|_| "OAuth mobile state lock poisoned".to_string())?;
    save_pending(
        &pending_path(&app)?,
        &PendingMobileOauth {
            version: PENDING_VERSION,
            provider: args.provider,
            state: args.state,
            redirect_uri: MOBILE_REDIRECT_URI.to_string(),
            associate: args.associate,
            session_binding: args.session_binding,
            code_verifier: args.code_verifier,
            created_at_unix_ms: now_unix_ms()?,
            phase: PendingPhase::Armed,
        },
    )
}

fn load_fresh_pending(path: &Path) -> Result<Option<PendingMobileOauth>, String> {
    match load_pending(path) {
        Ok(Some(pending)) if is_expired(&pending, now_unix_ms()?) => {
            remove_pending(path)?;
            Ok(None)
        }
        Ok(value) => Ok(value),
        Err(error) => {
            // Corrupt or invalid state is never recoverable and must not keep
            // surprising every app launch.
            let _ = remove_pending(path);
            Err(error)
        }
    }
}

#[tauri::command]
pub fn oauth_mobile_pending<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, OauthMobileState>,
) -> Result<Option<MobilePendingSummary>, String> {
    if !cfg!(mobile) {
        return Ok(None);
    }
    let _guard = state
        .0
        .lock()
        .map_err(|_| "OAuth mobile state lock poisoned".to_string())?;
    Ok(
        load_fresh_pending(&pending_path(&app)?)?.map(|pending| MobilePendingSummary {
            provider: pending.provider,
            associate: pending.associate,
            state: pending.state,
            phase: match pending.phase {
                PendingPhase::Armed => "armed",
                PendingPhase::Received { .. } => "received",
            },
        }),
    )
}

#[tauri::command]
pub fn oauth_mobile_claim<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, OauthMobileState>,
    args: MobileClaimArgs,
) -> Result<MobileClaimResult, String> {
    if !cfg!(mobile) {
        return Err("mobile OAuth callback is unavailable on desktop".to_string());
    }
    if !valid_state(&args.expected_state) {
        return Err("invalid expected mobile OAuth state".to_string());
    }
    let _guard = state
        .0
        .lock()
        .map_err(|_| "OAuth mobile state lock poisoned".to_string())?;
    let path = pending_path(&app)?;
    let Some(mut pending) = load_fresh_pending(&path)? else {
        return Ok(MobileClaimResult::Ignored);
    };
    if !pending_matches_state(&pending, &args.expected_state) {
        return Ok(MobileClaimResult::Ignored);
    }
    match evaluate_mobile_claim(&mut pending, &args.callback_url, &args.session_binding) {
        PendingAction::Keep(result) => Ok(result),
        PendingAction::Save(result) => {
            save_pending(&path, &pending)?;
            Ok(result)
        }
        PendingAction::Remove(result) => {
            remove_pending(&path)?;
            Ok(result)
        }
    }
}

#[tauri::command]
pub fn oauth_mobile_resume<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, OauthMobileState>,
    args: MobileClaimSessionArgs,
) -> Result<MobileClaimResult, String> {
    if !cfg!(mobile) {
        return Ok(MobileClaimResult::Ignored);
    }
    let _guard = state
        .0
        .lock()
        .map_err(|_| "OAuth mobile state lock poisoned".to_string())?;
    let path = pending_path(&app)?;
    let Some(pending) = load_fresh_pending(&path)? else {
        return Ok(MobileClaimResult::Ignored);
    };
    if !pending_matches_state(&pending, &args.expected_state) {
        return Ok(MobileClaimResult::Ignored);
    }
    if pending.session_binding != args.session_binding {
        remove_pending(&path)?;
        return Ok(MobileClaimResult::Rejected {
            message: "The account session changed while sign-in was open. Start again.".to_string(),
        });
    }
    match &pending.phase {
        PendingPhase::Armed => Ok(MobileClaimResult::Ignored),
        PendingPhase::Received { code } => Ok(MobileClaimResult::Captured {
            capture: capture_from_pending(&pending, code.clone()),
        }),
    }
}

#[tauri::command]
pub fn oauth_mobile_finish<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, OauthMobileState>,
    args: MobileFinishArgs,
) -> Result<(), String> {
    if !cfg!(mobile) {
        return Err("mobile OAuth callback is unavailable on desktop".to_string());
    }
    let _guard = state
        .0
        .lock()
        .map_err(|_| "OAuth mobile state lock poisoned".to_string())?;
    let path = pending_path(&app)?;
    if let Some(pending) = load_pending(&path)? {
        if pending.state != args.state || !matches!(pending.phase, PendingPhase::Received { .. }) {
            return Err("OAuth completion does not match the pending callback".to_string());
        }
    }
    remove_pending(&path)
}

#[tauri::command]
pub fn oauth_mobile_cancel<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, OauthMobileState>,
    args: MobileFinishArgs,
) -> Result<(), String> {
    if !cfg!(mobile) {
        return Err("mobile OAuth callback is unavailable on desktop".to_string());
    }
    let _guard = state
        .0
        .lock()
        .map_err(|_| "OAuth mobile state lock poisoned".to_string())?;
    let path = pending_path(&app)?;
    if load_pending(&path)?.is_some_and(|pending| pending_matches_state(&pending, &args.state)) {
        remove_pending(&path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_flight_loopback_wait_stops_promptly_when_cancelled() {
        let server = Arc::new(Server::http("127.0.0.1:0").unwrap());
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_server = Arc::clone(&server);
        let worker_cancelled = Arc::clone(&cancelled);
        let mut flow = Some(LoopbackFlow::Waiting {
            server,
            nonce: "0123456789abcdef0123456789abcdef".to_string(),
            cancelled,
        });
        let started = Instant::now();
        let worker = std::thread::spawn(move || {
            wait_for_loopback(
                worker_server.as_ref(),
                "0123456789abcdef0123456789abcdef",
                "abcdefghijklmnopqrstuvwxyz012345",
                &worker_cancelled,
                Duration::from_secs(5),
            )
        });

        std::thread::sleep(Duration::from_millis(20));
        assert!(cancel_loopback(
            &mut flow,
            "0123456789abcdef0123456789abcdef"
        ));
        let result = worker.join().unwrap();
        assert!(matches!(result, Err(message) if message.contains("cancelled")));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn loopback_cancel_is_scoped_to_the_exact_flow() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut flow = Some(LoopbackFlow::Waiting {
            server: Arc::new(Server::http("127.0.0.1:0").unwrap()),
            nonce: "current-flow".to_string(),
            cancelled: Arc::clone(&cancelled),
        });

        assert!(!cancel_loopback(&mut flow, "stale-flow"));
        assert!(!cancelled.load(Ordering::Acquire));
        assert!(cancel_loopback(&mut flow, "current-flow"));
        assert!(cancelled.load(Ordering::Acquire));

        let mut ready = Some(LoopbackFlow::Ready {
            server: Server::http("127.0.0.1:0").unwrap(),
            nonce: "new-flow".to_string(),
        });
        assert!(!cancel_loopback(&mut ready, "current-flow"));
        assert!(matches!(ready, Some(LoopbackFlow::Ready { .. })));
        assert!(cancel_loopback(&mut ready, "new-flow"));
        assert!(ready.is_none());
    }

    fn pending() -> PendingMobileOauth {
        PendingMobileOauth {
            version: PENDING_VERSION,
            provider: "google".to_string(),
            state: "abcdefghijklmnopqrstuvwxyz012345".to_string(),
            redirect_uri: MOBILE_REDIRECT_URI.to_string(),
            associate: false,
            session_binding: "login:none".to_string(),
            code_verifier: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG".to_string(),
            created_at_unix_ms: 1_000,
            phase: PendingPhase::Armed,
        }
    }

    #[test]
    fn mobile_target_is_exact() {
        assert!(validate_mobile_target(
            &Url::parse(MOBILE_REDIRECT_URI).unwrap()
        ));
        for bad in [
            "cash.free2z.zuuli://evil/callback",
            "cash.free2z.zuuli://oauth/callback/extra",
            "cash.free2z.zuuli://oauth:99/callback",
            "cash.free2z.zuuli://oauth/callback#code=x",
            "other://oauth/callback",
        ] {
            assert!(!validate_mobile_target(&Url::parse(bad).unwrap()), "{bad}");
        }
    }

    #[test]
    fn callback_requires_single_code_or_error_and_single_state() {
        let state = &pending().state;
        let good = Url::parse(&format!("{MOBILE_REDIRECT_URI}?code=abc&state={state}")).unwrap();
        assert!(matches!(
            parse_callback(&good),
            Ok(ParsedCallback::Code { .. })
        ));
        for bad in [
            format!("{MOBILE_REDIRECT_URI}?code=a&code=b&state={state}"),
            format!("{MOBILE_REDIRECT_URI}?code=a&state={state}&state={state}"),
            format!("{MOBILE_REDIRECT_URI}?code=a&error=denied&state={state}"),
            format!("{MOBILE_REDIRECT_URI}?state={state}"),
        ] {
            assert!(parse_callback(&Url::parse(&bad).unwrap()).is_err(), "{bad}");
        }
    }

    #[test]
    fn session_binding_is_mode_specific() {
        assert!(valid_session_binding("login:none", false));
        assert!(!valid_session_binding("login:none", true));
        assert!(valid_session_binding(
            &format!("associate:{}", "a".repeat(64)),
            true
        ));
        assert!(!valid_session_binding(
            &format!("associate:{}", "g".repeat(64)),
            true
        ));
    }

    #[test]
    fn mobile_provider_and_pending_generation_are_strict() {
        assert!(valid_mobile_provider("google"));
        assert!(valid_mobile_provider("x"));
        assert!(!valid_mobile_provider("github"));

        let value = pending();
        assert!(pending_matches_state(&value, &value.state));
        assert!(!pending_matches_state(
            &value,
            "new-flow-state-abcdefghijklmnopqrstuvwxyz",
        ));
    }

    #[test]
    fn expiry_is_bounded_to_backend_ttl() {
        let value = pending();
        assert!(!is_expired(&value, 600_999));
        assert!(is_expired(&value, 601_000));
    }

    #[test]
    fn pending_round_trip_preserves_received_transition() {
        let dir = std::env::temp_dir().join(format!("zuuli-oauth-test-{}", random_hex(8).unwrap()));
        let path = dir.join("pending.json");
        let mut value = pending();
        save_pending(&path, &value).unwrap();
        assert!(matches!(
            load_pending(&path).unwrap().unwrap().phase,
            PendingPhase::Armed
        ));
        value.phase = PendingPhase::Received {
            code: "one-shot-code".to_string(),
        };
        save_pending(&path, &value).unwrap();
        let loaded = load_pending(&path).unwrap().unwrap();
        assert!(
            matches!(loaded.phase, PendingPhase::Received { ref code } if code == "one-shot-code")
        );
        remove_pending(&path).unwrap();
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn mobile_claim_is_one_shot_and_session_bound() {
        let mut value = pending();
        let callback = format!("{MOBILE_REDIRECT_URI}?code=one-shot&state={}", value.state);
        assert!(matches!(
            evaluate_mobile_claim(&mut value, &callback, "login:none"),
            PendingAction::Save(MobileClaimResult::Captured { .. })
        ));
        assert!(matches!(value.phase, PendingPhase::Received { .. }));
        assert!(matches!(
            evaluate_mobile_claim(&mut value, &callback, "login:none"),
            PendingAction::Keep(MobileClaimResult::Ignored)
        ));

        let mut changed_session = pending();
        assert!(matches!(
            evaluate_mobile_claim(
                &mut changed_session,
                &callback,
                &format!("associate:{}", "a".repeat(64)),
            ),
            PendingAction::Remove(MobileClaimResult::Rejected { .. })
        ));
    }

    #[test]
    fn spoofed_state_is_ignored_but_matching_malformed_callback_fails_closed() {
        let mut value = pending();
        let spoof = format!("{MOBILE_REDIRECT_URI}?code=evil&state={}x", value.state);
        assert!(matches!(
            evaluate_mobile_claim(&mut value, &spoof, "login:none"),
            PendingAction::Keep(MobileClaimResult::Ignored)
        ));
        let malformed = format!("{MOBILE_REDIRECT_URI}?code=a&code=b&state={}", value.state);
        assert!(matches!(
            evaluate_mobile_claim(&mut value, &malformed, "login:none"),
            PendingAction::Remove(MobileClaimResult::Rejected { .. })
        ));
    }

    #[test]
    fn matching_provider_error_cancels_and_consumes() {
        let mut value = pending();
        let callback = format!(
            "{MOBILE_REDIRECT_URI}?error=access_denied&state={}",
            value.state
        );
        assert!(matches!(
            evaluate_mobile_claim(&mut value, &callback, "login:none"),
            PendingAction::Remove(MobileClaimResult::Cancelled { .. })
        ));
    }

    #[test]
    fn generated_config_names_only_canonical_mobile_redirects() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let mobile = &config["plugins"]["deep-link"]["mobile"];
        assert_eq!(mobile.as_array().unwrap().len(), 2);
        assert_eq!(mobile[0]["scheme"][0], MOBILE_SCHEME);
        assert_eq!(mobile[0]["host"], MOBILE_HOST);
        assert_eq!(mobile[0]["path"][0], MOBILE_PATH);
        assert_eq!(mobile[0]["appLink"], false);
        assert_eq!(mobile[1]["scheme"][0], MOBILE_SCHEME);
        assert_eq!(mobile[1]["host"], "checkout");
        assert_eq!(mobile[1]["path"][0], "/return");
        assert_eq!(mobile[1]["appLink"], false);
    }

    #[test]
    fn generated_android_manifest_registers_exact_mobile_redirect() {
        let manifest = include_str!("../gen/android/app/src/main/AndroidManifest.xml");
        assert_eq!(
            manifest
                .matches("android:scheme=\"cash.free2z.zuuli\"")
                .count(),
            2
        );
        assert_eq!(manifest.matches("android:host=\"oauth\"").count(), 1);
        assert_eq!(manifest.matches("android:path=\"/callback\"").count(), 1);
        assert_eq!(manifest.matches("android:host=\"checkout\"").count(), 1);
        assert_eq!(manifest.matches("android:path=\"/return\"").count(), 1);
        assert_eq!(
            manifest
                .matches("android.intent.category.BROWSABLE")
                .count(),
            2
        );
    }

    #[test]
    fn generated_ios_plist_registers_mobile_scheme() {
        let plist = include_str!("../gen/apple/zuuli_iOS/Info.plist");
        assert_eq!(plist.matches("<key>CFBundleURLTypes</key>").count(), 1);
        assert_eq!(
            plist.matches("<string>cash.free2z.zuuli</string>").count(),
            2
        );
    }
}
