//! Direct provider adapters. Credential brokers write short-lived credentials to private
//! files; this process never holds an APNs signing key or Google service-account key.
use f2z_notify_proto::{Envelope, Provider};
use serde_json::json;
use std::{future::Future, path::PathBuf, pin::Pin};
/// No provider response body, message id or token is returned or logged.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Accepted,
    Stale,
    Failed,
}
/// Fixture seam uses the same dispatch/rotation/revocation callers as production.
pub trait Delivery: Send + Sync {
    fn configured(&self, provider: Provider) -> bool;
    fn deliver<'a>(
        &'a self,
        provider: Provider,
        token: &'a str,
        envelope: Envelope,
    ) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;
}
/// Provider routing is deployment configuration, never request input.
pub struct Providers {
    client: reqwest::Client,
    apns_credential: Option<PathBuf>,
    fcm_credential: Option<PathBuf>,
    #[cfg(test)]
    fixture: Option<String>,
    sandbox: bool,
    topic: String,
    project: String,
}
fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
}
impl Providers {
    pub fn new(
        apns: Option<PathBuf>,
        fcm: Option<PathBuf>,
        sandbox: bool,
        topic: String,
        project: String,
    ) -> Result<Self, &'static str> {
        if (apns.is_some() && !identifier(&topic)) || (fcm.is_some() && !identifier(&project)) {
            return Err("configuration");
        }
        let client = reqwest::Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(2))
            .timeout(std::time::Duration::from_secs(4))
            .build()
            .map_err(|_| "configuration")?;
        Ok(Self {
            client,
            #[cfg(test)]
            fixture: None,
            apns_credential: apns,
            fcm_credential: fcm,
            sandbox,
            topic,
            project,
        })
    }
    async fn credential(path: &std::path::Path) -> Option<String> {
        // Bounded read, no path or error formatting. Private credential broker owns rotation.
        use std::io::Read;
        let file = std::fs::File::open(path).ok()?;
        let mut bytes = zeroize::Zeroizing::new(Vec::new());
        file.take(8193).read_to_end(&mut bytes).ok()?;
        if bytes.len() > 8192 {
            return None;
        }
        let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        let expires = value.get("expires")?.as_u64()?;
        let bearer = value.get("bearer")?.as_str()?;
        let now = crate::now();
        if expires <= now.saturating_add(5)
            || expires > now.saturating_add(3600)
            || bearer.len() > 4096
            || bearer.is_empty()
            || !bearer
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._~+/=".contains(&b))
        {
            return None;
        }
        Some(bearer.to_owned())
    }
    /// Pure request construction is also used by the controlled HTTP provider fixture.
    pub fn payload(
        &self,
        provider: Provider,
        token: &str,
        envelope: Envelope,
    ) -> serde_json::Value {
        match provider {
            Provider::Apns => json!({"aps":{"content-available":1},"wake":envelope}),
            // Normal-priority data: no claim of guaranteed dead-app wake or a visible alert.
            Provider::Fcm => {
                json!({"message":{"token":token,"data":envelope,"android":{"priority":"normal","ttl":"60s","collapse_key":"wake"}}})
            }
        }
    }
    fn route(&self, provider: Provider, token: &str) -> String {
        #[cfg(test)]
        if let Some(origin) = &self.fixture {
            return match provider {
                Provider::Apns => format!("{origin}/3/device/{token}"),
                Provider::Fcm => format!("{origin}/v1/projects/{}/messages:send", self.project),
            };
        }
        match provider {
            Provider::Apns => format!(
                "https://{}/3/device/{token}",
                if self.sandbox {
                    "api.sandbox.push.apple.com"
                } else {
                    "api.push.apple.com"
                }
            ),
            Provider::Fcm => format!(
                "https://fcm.googleapis.com/v1/projects/{}/messages:send",
                self.project
            ),
        }
    }
}
impl Delivery for Providers {
    fn configured(&self, p: Provider) -> bool {
        match p {
            Provider::Apns => self.apns_credential.is_some(),
            Provider::Fcm => self.fcm_credential.is_some(),
        }
    }
    fn deliver<'a>(
        &'a self,
        provider: Provider,
        token: &'a str,
        envelope: Envelope,
    ) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>> {
        Box::pin(async move {
            if !f2z_notify_proto::token(provider, token) {
                return Outcome::Failed;
            }
            let path = match provider {
                Provider::Apns => self.apns_credential.as_ref(),
                Provider::Fcm => self.fcm_credential.as_ref(),
            };
            let Some(path) = path else {
                return Outcome::Failed;
            };
            let Some(bearer) = Self::credential(path).await else {
                return Outcome::Failed;
            };
            let expires = envelope.expires.clone();
            let mut request = self
                .client
                .post(self.route(provider, token))
                .bearer_auth(bearer)
                .json(&self.payload(provider, token, envelope));
            if provider == Provider::Apns {
                request = request
                    .version(reqwest::Version::HTTP_2)
                    .header("apns-topic", &self.topic)
                    .header("apns-push-type", "background")
                    .header("apns-priority", "5")
                    .header("apns-expiration", expires)
                    .header("apns-collapse-id", "wake");
            }
            #[cfg(test)]
            if self.fixture.is_some() {
                request = request.version(reqwest::Version::HTTP_11);
            }
            match request.send().await {
                Ok(r) if r.status().is_success() => Outcome::Accepted,
                Ok(r) if provider == Provider::Apns && r.status().as_u16() == 410 => Outcome::Stale,
                // FCM UNREGISTERED uses 404. Project is fixed and validated in deployment acceptance.
                Ok(r) if provider == Provider::Fcm && r.status().as_u16() == 404 => Outcome::Stale,
                _ => Outcome::Failed,
            }
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        extract::{Request, State},
        routing::post,
    };
    use std::sync::Arc;
    #[tokio::test]
    async fn actual_adapters_send_only_the_fixed_envelope_and_correct_provider_headers() {
        type Capture =
            Arc<tokio::sync::Mutex<Vec<(String, axum::http::HeaderMap, serde_json::Value)>>>;
        async fn capture(State(c): State<Capture>, r: Request) -> axum::http::StatusCode {
            let path = r.uri().path().to_owned();
            let headers = r.headers().clone();
            let body = axum::body::to_bytes(r.into_body(), 8192).await.unwrap();
            c.lock()
                .await
                .push((path, headers, serde_json::from_slice(&body).unwrap()));
            axum::http::StatusCode::OK
        }
        let captured: Capture = Default::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/{*path}", post(capture))
                    .with_state(captured.clone()),
            )
            .into_future(),
        );
        let path =
            std::env::temp_dir().join(format!("zuu384-provider-{}.json", std::process::id()));
        std::fs::write(
            &path,
            json!({"bearer":"fixture-only","expires":crate::now()+300}).to_string(),
        )
        .unwrap();
        let mut p = Providers::new(
            Some(path.clone()),
            Some(path.clone()),
            true,
            "cash.free2z.zuuli".into(),
            "fixture-project".into(),
        )
        .unwrap();
        p.client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .unwrap();
        p.fixture = Some(format!("http://{addr}"));
        let e = Envelope {
            queue: "b".repeat(64),
            generation: "1".into(),
            sequence: "1".into(),
            expires: (crate::now() + 60).to_string(),
            signature: "f".repeat(128),
        };
        assert!(p.deliver(Provider::Apns, &"e".repeat(64), e.clone()).await == Outcome::Accepted);
        assert!(
            p.deliver(Provider::Fcm, &"fcm-fixture-token".repeat(2), e.clone())
                .await
                == Outcome::Accepted
        );
        let c = captured.lock().await;
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].0, format!("/3/device/{}", "e".repeat(64)));
        assert_eq!(c[0].1["apns-push-type"], "background");
        assert_eq!(c[0].1["apns-priority"], "5");
        assert_eq!(c[0].1["apns-topic"], "cash.free2z.zuuli");
        assert_eq!(c[0].2, json!({"aps":{"content-available":1},"wake":e}));
        assert_eq!(c[1].0, "/v1/projects/fixture-project/messages:send");
        assert_eq!(c[1].2["message"]["data"], serde_json::to_value(e).unwrap());
        assert_eq!(
            c[1].2["message"]["android"],
            json!({"priority":"normal","ttl":"60s","collapse_key":"wake"})
        );
        assert!(
            !c[1].2["message"]
                .as_object()
                .unwrap()
                .contains_key("notification")
        );
        for (_, headers, body) in c.iter() {
            assert_eq!(headers["authorization"], "Bearer fixture-only");
            assert!(!headers.contains_key("cookie"));
            for forbidden in [
                "amount",
                "walletAddress",
                "creatorId",
                "memo",
                "sender",
                "viewingKey",
            ] {
                assert!(!body.to_string().contains(forbidden));
            }
        }
        drop(c);
        task.abort();
        let _ = task.await;
        std::fs::remove_file(path).unwrap();
    }
}
