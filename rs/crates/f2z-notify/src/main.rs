//! Private acceptance service. No default external listener or delivery credentials.
use ed25519_dalek::SigningKey;
use f2z_notify::{Service, provider::Providers, router};
use std::{path::PathBuf, sync::Arc};
fn read_secret(path: &str) -> Result<String, &'static str> {
    use std::io::Read;
    let mut result = String::new();
    std::fs::File::open(path)
        .map_err(|_| "configuration")?
        .take(70_000)
        .read_to_string(&mut result)
        .map_err(|_| "configuration")?;
    if result.len() >= 70_000 {
        return Err("configuration");
    }
    Ok(result.trim().to_owned())
}
// Consume the whole admission batch durably before listening. A restart must
// never resurrect an invitation that was already spent or revoked in memory.
fn consume_invitations(path: &str) -> Result<String, &'static str> {
    let result = read_secret(path)?;
    std::fs::remove_file(path).map_err(|_| "configuration")?;
    let parent = std::path::Path::new(path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "configuration")?;
    Ok(result)
}
#[tokio::main]
async fn main() -> Result<(), &'static str> {
    // Explicit acceptance-only activation; never configured in a public release manifest.
    if std::env::var("F2Z_NOTIFY_ACCEPTANCE").as_deref() != Ok("owned-devices-only") {
        return Err("unconfigured");
    }
    let seed = zeroize::Zeroizing::new(read_secret(
        &std::env::var("F2Z_NOTIFY_SIGNING_FILE").map_err(|_| "configuration")?,
    )?);
    let seed: [u8; 32] = hex::decode(seed.as_str())
        .map_err(|_| "configuration")?
        .try_into()
        .map_err(|_| "configuration")?;
    let invitations = zeroize::Zeroizing::new(consume_invitations(
        &std::env::var("F2Z_NOTIFY_INVITATIONS_FILE").map_err(|_| "configuration")?,
    )?);
    let providers = Providers::new(
        std::env::var_os("F2Z_NOTIFY_APNS_CREDENTIAL").map(PathBuf::from),
        std::env::var_os("F2Z_NOTIFY_FCM_CREDENTIAL").map(PathBuf::from),
        std::env::var("F2Z_NOTIFY_APNS_SANDBOX").as_deref() == Ok("1"),
        std::env::var("F2Z_NOTIFY_APNS_TOPIC").unwrap_or_default(),
        std::env::var("F2Z_NOTIFY_FCM_PROJECT").unwrap_or_default(),
    )?;
    let service = Service::new(
        invitations.lines().map(str::to_owned).collect(),
        SigningKey::from_bytes(&seed),
        Arc::new(providers),
    )
    .map_err(|_| "configuration")?;
    let worker = service.clone();
    let task = tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(100));
        loop {
            tick.tick().await;
            worker.dispatch(f2z_notify::now()).await;
        }
    });
    // TLS and ingress limits are a deployment requirement. No forwarded-IP trust.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8943")
        .await
        .map_err(|_| "listener")?;
    let result = axum::serve(listener, router(service))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await;
    task.abort();
    let _ = task.await;
    result.map_err(|_| "listener")
}

#[cfg(test)]
mod tests {
    #[test]
    fn restarting_cannot_reload_a_consumed_admission_batch() {
        let path = std::env::temp_dir().join(format!("zuu384-invites-{}", std::process::id()));
        std::fs::write(&path, "a".repeat(64)).unwrap();
        assert_eq!(
            super::consume_invitations(path.to_str().unwrap()).unwrap(),
            "a".repeat(64)
        );
        assert!(!path.exists());
        assert!(super::consume_invitations(path.to_str().unwrap()).is_err());
    }
}
