use crate::Status;
use f2z_notify_proto::{Envelope, LEASE, Provider, Register, Revoke, Rotate, Wake};
use serde::{Deserialize, Serialize};
/// Native secure vault is ThisDeviceOnly Keychain / Android Keystore-encrypted no-backup file.
/// Tauri mobile commands are callable only by Rust, never granted to the WebView.
#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Lease {
    queue: String,
    manage: String,
    send: String,
    token: String,
    generation: u64,
    sent: u64,
    received: u64,
    expires: u64,
    disabled: bool,
    #[serde(default)]
    consent: String,
    #[serde(default)]
    registered: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Native {
    permission: String,
    enabled: bool,
    revision: String,
    token: String,
    lease: Option<String>,
    pending: Option<String>,
}
fn time() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
fn random() -> Result<String, &'static str> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| "unavailable")?;
    Ok(hex::encode(bytes))
}
fn config() -> Result<(reqwest::Url, [u8; 32], &'static str), &'static str> {
    if option_env!("F2Z_NOTIFY_ACCEPTANCE") != Some("owned-devices-only") {
        return Err("unconfigured");
    }
    let origin = reqwest::Url::parse(option_env!("F2Z_NOTIFY_ORIGIN").ok_or("unconfigured")?)
        .map_err(|_| "unconfigured")?;
    if origin.scheme() != "https"
        || origin.host_str().is_none()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
    {
        return Err("unconfigured");
    }
    let key = hex::decode(option_env!("F2Z_NOTIFY_PUBLIC_KEY").ok_or("unconfigured")?)
        .map_err(|_| "unconfigured")?
        .try_into()
        .map_err(|_| "unconfigured")?;
    let invitation = option_env!("F2Z_NOTIFY_INVITATION")
        .filter(|v| f2z_notify_proto::capability(v))
        .ok_or("unconfigured")?;
    Ok((origin, key, invitation))
}
#[cfg(any(target_os = "ios", target_os = "android"))]
pub fn configured() -> bool {
    config().is_ok()
}
pub trait Port: Send + Sync {
    fn invoke(
        &self,
        command: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, &'static str>;
    fn post<'a>(
        &'a self,
        origin: &'a reqwest::Url,
        route: &'a str,
        value: serde_json::Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), &'static str>> + Send + 'a>>;
}
fn native<P: Port, T: for<'de> Deserialize<'de>>(
    s: &P,
    command: &str,
    args: serde_json::Value,
) -> Result<T, &'static str> {
    serde_json::from_value(s.invoke(command, args)?).map_err(|_| "unavailable")
}
fn save<P: Port>(s: &P, lease: &Lease) -> Result<(), &'static str> {
    native::<P, serde_json::Value>(
        s,
        "save",
        serde_json::json!({"revision":lease.consent,"lease":serde_json::to_string(lease).map_err(|_|"unavailable")?}),
    )?;
    Ok(())
}
pub async fn http_post<T: Serialize>(
    origin: &reqwest::Url,
    route: &str,
    value: &T,
) -> Result<(), &'static str> {
    if !["register", "rotate", "revoke", "wake"].contains(&route) {
        return Err("unconfigured");
    }
    // Constructed fresh with no cookie jar, account middleware, redirects, proxy or URL arguments.
    let client = reqwest::Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|_| "unavailable")?;
    let response = client
        .post(
            origin
                .join(&format!("notify/v1/{route}"))
                .map_err(|_| "unconfigured")?,
        )
        .json(value)
        .send()
        .await
        .map_err(|_| "offline")?;
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        Ok(())
    } else if response.status() == reqwest::StatusCode::FORBIDDEN {
        Err("expired")
    } else {
        Err("unavailable")
    }
}
pub async fn run<P: Port>(s: &P, operation: &str) -> Result<Status, &'static str> {
    execute(s, operation, config()).await
}
pub async fn execute<P: Port>(
    s: &P,
    operation: &str,
    config: Result<(reqwest::Url, [u8; 32], &str), &'static str>,
) -> Result<Status, &'static str> {
    let output = |state: &str, wake| {
        Ok(Status {
            state: state.into(),
            wake,
        })
    };

    // Native stop is the durable decision: one atomic secure-record write sets
    // off, advances cancellation revision and tombstones the serialized lease.
    if operation == "disable" {
        native::<P, serde_json::Value>(s, "stop", serde_json::json!({}))?;
    }
    let mut n: Native = native(s, "snapshot", serde_json::json!({}))?;
    let mut lease: Option<Lease> = n
        .lease
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| "unavailable")?;
    // A lease is never consent. Legacy/interrupted off records fail closed too.
    if lease
        .as_ref()
        .is_some_and(|l| l.disabled || !n.enabled || l.consent != n.revision)
        || (operation == "disable" && lease.is_some())
    {
        if n.enabled || lease.as_ref().is_some_and(|l| !l.disabled) {
            native::<P, serde_json::Value>(s, "stop", serde_json::json!({}))?;
            n = native(s, "snapshot", serde_json::json!({}))?;
            lease = n
                .lease
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(|_| "unavailable")?;
        }
        if let Some(l) = lease {
            let revoked = if l.expires <= time() {
                true
            } else if let Ok((origin, _, _)) = config.as_ref() {
                s.post(
                    origin,
                    "revoke",
                    serde_json::to_value(Revoke {
                        queue: l.queue,
                        manage: l.manage,
                    })
                    .map_err(|_| "unavailable")?,
                )
                .await
                .is_ok()
            } else {
                false
            };
            if !revoked {
                return output("revocation-pending", false);
            }
            native::<P, serde_json::Value>(s, "clear", serde_json::json!({"revision":n.revision}))?;
        }
        return output("off", false);
    }
    if operation == "disable" {
        return output("off", false);
    }
    let Ok((origin, key, invitation)) = config else {
        return output("unconfigured", false);
    };
    if operation == "enable" && lease.is_none() {
        let revision = n
            .revision
            .parse::<u64>()
            .map_err(|_| "unavailable")?
            .checked_add(1)
            .filter(|v| *v <= 9_007_199_254_740_991)
            .ok_or("unavailable")?
            .to_string();
        let l = Lease {
            queue: random()?,
            manage: random()?,
            send: random()?,
            token: String::new(),
            generation: 1,
            sent: 0,
            received: 0,
            expires: time().saturating_add(LEASE),
            disabled: false,
            consent: revision.clone(),
            registered: false,
        };
        // Persist explicit consent and its absolute expiry BEFORE asking the OS.
        native::<P, serde_json::Value>(
            s,
            "begin",
            serde_json::json!({"revision":n.revision,"lease":serde_json::to_string(&l).map_err(|_|"unavailable")?}),
        )?;
        n = native(s, "start", serde_json::json!({"revision":revision}))?;
        lease = Some(l);
    }
    let Some(mut l) = lease else {
        return output("off", false);
    };
    if !n.enabled || n.revision != l.consent {
        return output("off", false);
    }
    if n.permission != "granted" || l.expires <= time() {
        native::<P, serde_json::Value>(s, "stop", serde_json::json!({}))?;
        // A subsequent reconciliation may revoke remotely; the durable off
        // decision already prevents callbacks, resume and stale saves.
        return output(
            if l.expires <= time() {
                "expired"
            } else {
                "denied"
            },
            false,
        );
    }
    if !l.registered && l.token.is_empty() {
        if n.token.is_empty() {
            native::<P, serde_json::Value>(s, "resume", serde_json::json!({"revision":l.consent}))?;
            return output("waiting-token", false);
        }
        l.token = n.token.clone();
        save(s, &l)?;
    }
    #[cfg(any(target_os = "ios", all(test, not(target_os = "android"))))]
    let provider = Provider::Apns;
    #[cfg(target_os = "android")]
    let provider = Provider::Fcm;
    if !l.registered {
        // Keep this original token immutable until bootstrap is acknowledged.
        // A lost response retries the identical registration even if a token
        // callback rotated meanwhile; only then may rotation advance.
        s.post(
            &origin,
            "register",
            serde_json::to_value(Register {
                invitation: invitation.into(),
                queue: l.queue.clone(),
                manage: l.manage.clone(),
                send: l.send.clone(),
                provider,
                token: l.token.clone(),
                expires: l.expires,
            })
            .map_err(|_| "unavailable")?,
        )
        .await?;
        l.registered = true;
        save(s, &l)?;
    }
    if !n.token.is_empty() && n.token != l.token {
        l.token = n.token;
        l.generation = l.generation.checked_add(1).ok_or("expired")?;
        save(s, &l)?;
    }
    if l.generation > 1 {
        s.post(
            &origin,
            "rotate",
            serde_json::to_value(Rotate {
                queue: l.queue.clone(),
                manage: l.manage.clone(),
                generation: l.generation,
                token: l.token.clone(),
            })
            .map_err(|_| "unavailable")?,
        )
        .await?;
    }
    if operation == "test_wake" {
        l.sent = l.sent.checked_add(1).ok_or("expired")?;
        save(s, &l)?;
        // One bounded request, never retry an ambiguous send or claim it reached the phone.
        s.post(
            &origin,
            "wake",
            serde_json::to_value(Wake {
                queue: l.queue.clone(),
                send: l.send.clone(),
                sequence: l.sent,
            })
            .map_err(|_| "unavailable")?,
        )
        .await?;
        return output("queued", false);
    }
    let mut wake = false;
    if let Some(pending) = n.pending {
        if let Ok(envelope) = serde_json::from_str::<Envelope>(&pending)
            && let Some(sequence) =
                envelope.verify(&key, &l.queue, l.generation, l.received, time())
        {
            l.received = sequence;
            save(s, &l)?;
            wake = true;
        }
        native::<P, serde_json::Value>(
            s,
            "consume",
            serde_json::json!({"pending":pending,"revision":l.consent}),
        )?;
    }
    output("enabled", wake)
}
#[cfg(test)]
#[path = "record.rs"]
mod record;
#[cfg(test)]
#[path = "engine_tests.rs"]
pub(crate) mod tests;
