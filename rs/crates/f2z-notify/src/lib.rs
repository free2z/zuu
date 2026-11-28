//! Bounded anonymous wake service. No disk, account database, telemetry or payload logging.
pub mod provider;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    routing::post,
};
use ed25519_dalek::{Signer, SigningKey};
use f2z_notify_proto::*;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Arc};
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, Semaphore};
use zeroize::Zeroizing;

const MAX_QUEUES: usize = 1024;
const MAX_INVITES: usize = 1024;
type Hash = [u8; 32];
fn hash(s: &str) -> Hash {
    Sha256::digest(s.as_bytes()).into()
}
struct Mailbox {
    manage: Hash,
    send: Hash,
    provider: Provider,
    token: Zeroizing<String>,
    generation: u64,
    sequence: u64,
    expires: u64,
    next_send: u64,
    pending: Option<(u64, u64)>,
}
struct Inner {
    invitations: Vec<Hash>,
    queues: HashMap<String, Mailbox>,
    budget_at: u64,
    budget: u32,
}
/// Single process by design: restarting revokes all registrations. No cross-process stale worker.
pub struct Service {
    inner: Mutex<Inner>,
    admission: Semaphore,
    signing: SigningKey,
    provider: Arc<dyn provider::Delivery>,
}
/// Only category codes cross HTTP. Never display provider or parse errors.
#[derive(Debug, PartialEq)]
pub enum Error {
    Invalid,
    Denied,
    Busy,
    Unconfigured,
}
impl axum::response::IntoResponse for Error {
    fn into_response(self) -> axum::response::Response {
        let (status, text) = match self {
            Self::Invalid => (StatusCode::BAD_REQUEST, "invalid"),
            Self::Denied => (StatusCode::FORBIDDEN, "denied"),
            Self::Busy => (StatusCode::TOO_MANY_REQUESTS, "busy"),
            Self::Unconfigured => (StatusCode::SERVICE_UNAVAILABLE, "unconfigured"),
        };
        (status, text).into_response()
    }
}
impl Service {
    /// Private one-use invitations, delivered out of band to an owned acceptance target.
    pub fn new(
        invitations: Vec<String>,
        signing: SigningKey,
        provider: Arc<dyn provider::Delivery>,
    ) -> Result<Arc<Self>, Error> {
        if invitations.is_empty()
            || invitations.len() > MAX_INVITES
            || invitations.iter().any(|s| !capability(s))
        {
            return Err(Error::Invalid);
        }
        let mut hashes: Vec<_> = invitations.iter().map(|s| hash(s)).collect();
        hashes.sort();
        hashes.dedup();
        if hashes.len() != invitations.len() {
            return Err(Error::Invalid);
        }
        Ok(Arc::new(Self {
            inner: Mutex::new(Inner {
                invitations: hashes,
                queues: HashMap::new(),
                budget_at: 0,
                budget: 0,
            }),
            admission: Semaphore::new(16),
            signing,
            provider,
        }))
    }
    /// Testable clock input. HTTP uses only the server clock.
    pub async fn register(&self, r: Register, now: u64) -> Result<(), Error> {
        let _permit = self.admission.try_acquire().map_err(|_| Error::Busy)?;
        if ![&r.invitation, &r.queue, &r.manage, &r.send]
            .iter()
            .all(|s| capability(s))
            || r.manage == r.send
            || r.manage == r.queue
            || r.send == r.queue
            || !token(r.provider, &r.token)
            || r.expires <= now
            || r.expires > now.saturating_add(LEASE)
        {
            return Err(Error::Invalid);
        }
        if !self.provider.configured(r.provider) {
            return Err(Error::Unconfigured);
        }
        let mut i = self.inner.lock().await;
        cleanup(&mut i, now);
        // Bootstrap is idempotent only for the identical provider/token/capabilities.
        if let Some(m) = i.queues.get(&r.queue) {
            return if bool::from(m.manage.ct_eq(&hash(&r.manage)))
                && bool::from(m.send.ct_eq(&hash(&r.send)))
                && m.provider == r.provider
                && **m.token == r.token
                && m.expires == r.expires
            {
                Ok(())
            } else {
                Err(Error::Denied)
            };
        }
        let h = hash(&r.invitation);
        let pos = i
            .invitations
            .iter()
            .position(|v| bool::from(v.ct_eq(&h)))
            .ok_or(Error::Denied)?;
        if i.queues.len() >= MAX_QUEUES {
            return Err(Error::Busy);
        }
        // Reject duplicate tokens: one physical token cannot multiply the send budget.
        if i.queues.values().any(|m| **m.token == r.token) {
            return Err(Error::Denied);
        }
        i.invitations.swap_remove(pos);
        i.queues.insert(
            r.queue,
            Mailbox {
                manage: hash(&r.manage),
                send: hash(&r.send),
                provider: r.provider,
                token: Zeroizing::new(r.token),
                generation: 1,
                sequence: 0,
                expires: r.expires,
                next_send: 0,
                pending: None,
            },
        );
        Ok(())
    }
    pub async fn rotate(&self, r: Rotate, now: u64) -> Result<(), Error> {
        let _permit = self.admission.try_acquire().map_err(|_| Error::Busy)?;
        if !capability(&r.queue) || !capability(&r.manage) {
            return Err(Error::Invalid);
        }
        let mut i = self.inner.lock().await;
        cleanup(&mut i, now);
        if i.queues
            .iter()
            .any(|(q, m)| q != &r.queue && **m.token == r.token)
        {
            return Err(Error::Denied);
        }
        let m = i.queues.get_mut(&r.queue).ok_or(Error::Denied)?;
        if !bool::from(m.manage.ct_eq(&hash(&r.manage))) {
            return Err(Error::Denied);
        }
        if !token(m.provider, &r.token) {
            return Err(Error::Invalid);
        }
        if r.generation == m.generation && **m.token == r.token {
            return Ok(());
        }
        if r.generation <= m.generation {
            return Err(Error::Denied);
        }
        m.token = Zeroizing::new(r.token);
        m.generation = r.generation;
        m.pending = None;
        // Rotation never extends the lease or resets abuse/replay fences.
        Ok(())
    }
    pub async fn revoke(&self, r: Revoke) -> Result<(), Error> {
        let _permit = self.admission.try_acquire().map_err(|_| Error::Busy)?;
        if !capability(&r.queue) || !capability(&r.manage) {
            return Err(Error::Invalid);
        }
        let mut i = self.inner.lock().await;
        if let Some(m) = i.queues.get(&r.queue)
            && !bool::from(m.manage.ct_eq(&hash(&r.manage)))
        {
            return Err(Error::Denied);
        }
        i.queues.remove(&r.queue);
        Ok(())
    }
    pub async fn wake(&self, r: Wake, now: u64) -> Result<(), Error> {
        let _permit = self.admission.try_acquire().map_err(|_| Error::Busy)?;
        if !capability(&r.queue) || !capability(&r.send) {
            return Err(Error::Invalid);
        }
        let mut i = self.inner.lock().await;
        cleanup(&mut i, now);
        if now >= i.budget_at {
            i.budget_at = now.saturating_add(60);
            i.budget = 0;
        }
        if i.budget >= 60 {
            return Err(Error::Busy);
        }
        let m = i.queues.get_mut(&r.queue).ok_or(Error::Denied)?;
        if !bool::from(m.send.ct_eq(&hash(&r.send))) {
            return Err(Error::Denied);
        }
        if r.sequence <= m.sequence {
            return Err(Error::Denied);
        }
        if now < m.next_send || m.pending.is_some() {
            return Err(Error::Busy);
        }
        m.sequence = r.sequence;
        m.next_send = now.saturating_add(60);
        m.pending = Some((r.sequence, now.saturating_add(WAKE_TTL)));
        i.budget += 1;
        Ok(())
    }
    /// At-most-once dispatch. The lock spans the bounded external call: revocation/rotation
    /// waits for an already started send, then guarantees no later send uses that token.
    /// No retry of ambiguous provider failures, no detached tasks holding old tokens.
    pub async fn dispatch(&self, now: u64) {
        let mut i = self.inner.lock().await;
        cleanup(&mut i, now);
        if let Some((q, m)) = i.queues.iter_mut().find(|(_, m)| m.pending.is_some())
            && let Some((seq, expires)) = m.pending.take()
        {
            if expires < now {
                return;
            }
            let mut envelope = Envelope {
                queue: q.clone(),
                generation: m.generation.to_string(),
                sequence: seq.to_string(),
                expires: expires.to_string(),
                signature: String::new(),
            };
            envelope.signature =
                hex::encode(self.signing.sign(envelope.message().as_bytes()).to_bytes());
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                self.provider.deliver(m.provider, &m.token, envelope),
            )
            .await;
            if matches!(result, Ok(provider::Outcome::Stale)) {
                m.expires = 0;
            }
        }
        cleanup(&mut i, now);
    }
}
fn cleanup(i: &mut Inner, now: u64) {
    i.queues.retain(|_, m| m.expires > now);
    for m in i.queues.values_mut() {
        if m.pending.is_some_and(|(_, e)| e < now) {
            m.pending = None;
        }
    }
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
async fn register(
    State(s): State<Arc<Service>>,
    Json(r): Json<Register>,
) -> Result<StatusCode, Error> {
    s.register(r, now()).await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn rotate(State(s): State<Arc<Service>>, Json(r): Json<Rotate>) -> Result<StatusCode, Error> {
    s.rotate(r, now()).await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn revoke(State(s): State<Arc<Service>>, Json(r): Json<Revoke>) -> Result<StatusCode, Error> {
    s.revoke(r).await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn wake(State(s): State<Arc<Service>>, Json(r): Json<Wake>) -> Result<StatusCode, Error> {
    s.wake(r, now()).await?;
    Ok(StatusCode::NO_CONTENT)
}
/// Anonymous API: reject account Authorization/Cookie headers, queries and all non-JSON requests.
pub fn router(service: Arc<Service>) -> Router {
    Router::new()
        .route("/notify/v1/register", post(register))
        .route("/notify/v1/rotate", post(rotate))
        .route("/notify/v1/revoke", post(revoke))
        .route("/notify/v1/wake", post(wake))
        .layer(DefaultBodyLimit::max(8192))
        .layer(axum::middleware::from_fn(
            |request: axum::extract::Request, next: axum::middleware::Next| async move {
                if request.headers().contains_key("authorization")
                    || request.headers().contains_key("cookie")
                    || request.uri().query().is_some()
                {
                    return axum::response::IntoResponse::into_response(Error::Invalid);
                }
                // No echo of input in framework deserialization errors.
                let response = next.run(request).await;
                if response.status().is_client_error() {
                    return axum::response::IntoResponse::into_response((
                        response.status(),
                        "invalid",
                    ));
                }
                response
            },
        ))
        .with_state(service)
}
