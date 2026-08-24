//! The loopback-only operational listener: `/healthz` and `/metrics`.
//!
//! # Why this is a second parser and the `.well-known` document is not
//!
//! [`crate::caps`] declines to serve §11.2's HTTP copy on the public port,
//! because §2.2's argument — *"a second transport is a second parser and a
//! second fuzz target … The relay is an unauthenticated network listener that
//! anyone on the internet may speak to before any signature is checked"* — is
//! about the **unauthenticated** surface.
//!
//! This listener is bound to loopback and refuses to be anything else
//! ([`crate::config::Config::check`]). Its reachable population is processes on
//! the same host, which is not the population §2.2 is about. The parser is also
//! deliberately the smallest thing that can answer: it reads a bounded prefix,
//! takes the first line, matches the method and path as whole strings, and
//! interprets **no headers at all**. There is no chunked encoding, no
//! `Content-Length`, no keep-alive, no request body.
//!
//! # `/healthz` says nothing
//!
//! Constant, cheap, and carrying **no numbers**. Reporting queue depth or
//! connection counts here would put an aggregate on an endpoint whose whole
//! purpose is to be polled every few seconds by something that keeps history —
//! and a load balancer's health-check log is not a place anyone reviews for
//! metadata. It also touches no storage: a health check that queried the disk
//! would fail during exactly the backpressure it is meant to survive, and would
//! take the relay out of rotation at the moment `READ` and `ACK` are the things
//! keeping it alive.
//!
//! # `/metrics` has no labels
//!
//! See [`crate::metrics`]. No per-queue series, no per-IP series, no exceptions.
//!
//! # The health-only surface, and why it is allowed off loopback
//!
//! Kubernetes made the loopback rule above unsatisfiable for a *probe*: the
//! kubelet dials the POD IP for an `httpGet`, and a Google Cloud load balancer
//! health-checks the pod IP directly when the Service is backed by a NEG. A
//! loopback listener is unreachable to both by construction, the image is
//! distroless (no shell, no `wget`, no `curl`), and a `healthz` subcommand —
//! which is what `f2z-kt` and `f2z-witness` use — answers the kubelet and does
//! **nothing** for the load balancer. The result was a workload that could not
//! be deployed: `Ready` in `kubectl get pod` and 502 at the hostname.
//!
//! So there is a second, narrower surface: [`Scope::HealthOnly`], which may
//! bind any address and serves **`/healthz` alone**. `/metrics` on it is a 404,
//! not a 200 — the thing the loopback rule protects is the metrics endpoint,
//! and that protection is unchanged. What is exposed instead is a constant
//! three-byte body that is already asserted to contain no digit
//! ([`HEALTHZ_BODY`]), on a listener whose parser interprets no headers. The
//! relay's existence at that address is not a secret; its queue depth is.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Semaphore, watch};

use crate::config::is_loopback;
use crate::engine::Relay;

/// The most of a request this listener will read.
///
/// A request line plus whatever headers arrived in the same segment. Nothing
/// past the first line is interpreted, so this is a bound on the read rather
/// than a protocol limit.
const MAX_REQUEST: usize = 2048;

/// How long one request may take, from accept to written response.
///
/// A bound on BYTES is not a bound on TIME: a client that connects and sends
/// nothing holds a task and a descriptor for as long as it likes, and
/// [`Scope::HealthOnly`] is reachable from the whole cluster rather than from
/// loopback. Two seconds is chosen to be SHORTER than the probe's own
/// `timeoutSeconds` (3-5s in the manifests): the server should give up before
/// the client does, so a stuck peer is the server's descriptor to reclaim
/// rather than the probe's deadline to miss.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);

/// How many requests this listener will have in flight at once.
///
/// The whole population is a kubelet and a load-balancer health checker, which
/// together produce a handful of requests per ten seconds; anything above this
/// is not a scraper. A refused connection is closed immediately, before any
/// read, so the cost of a flood is an accept and a close rather than a task, a
/// buffer and a descriptor held for the timeout above.
///
/// This is deliberately NOT §13.1 layer 1's connection guard: that one lives on
/// the protocol listener and can refuse under backpressure, which is exactly
/// why the health check must not be answered there — a probe that fails during
/// a traffic spike restarts the only replica.
///
/// **BE PRECISE ABOUT WHAT THIS BUYS.** It bounds RESOURCES — descriptors,
/// tasks, buffers — so a peer that opens connections and never speaks cannot
/// grow this process without limit, and the listener recovers within
/// [`REQUEST_TIMEOUT`] once the flood stops. It does **not** guarantee
/// AVAILABILITY: a determined flood from inside the cluster can still occupy
/// the permits and make a probe time out, and no in-process number fixes that
/// — an attacker who can do this can also fill the accept backlog. The answer
/// to a hostile pod on the cluster network is a NetworkPolicy on this port, not
/// a bigger constant here.
const MAX_CONCURRENT: usize = 16;

/// The health check's body. Constant, and it is meant to be.
const HEALTHZ_BODY: &str = "ok\n";

/// Why the admin listener could not start.
#[derive(Debug)]
pub enum AdminError {
    /// The address is not loopback. `/metrics` off-host is a metadata leak, so
    /// this is refused rather than warned about.
    NotLoopback,
    /// The socket could not be bound.
    Io(std::io::Error),
}

impl std::fmt::Display for AdminError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotLoopback => f.write_str(
                "the admin listener serves /healthz and /metrics and must be loopback-only",
            ),
            Self::Io(error) => write!(f, "admin bind: {error}"),
        }
    }
}

impl std::error::Error for AdminError {}

/// What an operational listener exposes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// `/healthz` and `/metrics`. Loopback only — see [`bind`].
    Operator,
    /// `/healthz` and nothing else. May bind any address — see [`bind_health`].
    HealthOnly,
}

/// Bind the operator listener: `/healthz` and `/metrics`, loopback only.
///
/// # Errors
///
/// [`AdminError::NotLoopback`] for a non-loopback address, or
/// [`AdminError::Io`] if the socket cannot be bound.
pub async fn bind(addr: std::net::SocketAddr) -> Result<TcpListener, AdminError> {
    if !is_loopback(&addr) {
        return Err(AdminError::NotLoopback);
    }
    TcpListener::bind(addr).await.map_err(AdminError::Io)
}

/// Bind the health-only listener. **No loopback check**, deliberately.
///
/// This is the one surface that may answer off-host, and the reason it may is
/// that it answers a constant. See the module documentation.
///
/// # Errors
///
/// [`AdminError::Io`] if the socket cannot be bound.
pub async fn bind_health(addr: std::net::SocketAddr) -> Result<TcpListener, AdminError> {
    TcpListener::bind(addr).await.map_err(AdminError::Io)
}

/// Serve until `shutdown` flips.
pub async fn serve(
    relay: Arc<Relay>,
    listener: TcpListener,
    scope: Scope,
    mut shutdown: watch::Receiver<bool>,
) {
    let permits = Arc::new(Semaphore::new(MAX_CONCURRENT));
    loop {
        let accepted = tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            accepted = listener.accept() => accepted,
        };
        let Ok((stream, _peer)) = accepted else {
            continue;
        };
        // `try_acquire`, not `acquire`: waiting here would move the queue from
        // the semaphore to the accept backlog and hold the connection open,
        // which is the thing being bounded. Over the limit, close.
        let Ok(permit) = Arc::clone(&permits).try_acquire_owned() else {
            drop(stream);
            continue;
        };
        let relay = Arc::clone(&relay);
        tokio::spawn(async move {
            // The timeout wraps the whole exchange, so a peer that connects and
            // never sends cannot hold the permit either.
            let _ = tokio::time::timeout(REQUEST_TIMEOUT, answer(relay, scope, stream)).await;
            drop(permit);
        });
    }
}

async fn answer(relay: Arc<Relay>, scope: Scope, mut stream: TcpStream) -> std::io::Result<()> {
    let mut buffer = [0u8; MAX_REQUEST];
    let read = stream.read(&mut buffer).await?;
    let request = buffer.get(..read).unwrap_or_default();
    let response = route(&relay, scope, request);
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await?;
    // No keep-alive. One request per connection is all an operator's scraper
    // needs, and it is one fewer state machine on a listener whose whole appeal
    // is that it barely has one.
    stream.shutdown().await
}

/// The whole of the routing. Split out so it is testable without a socket.
fn route(relay: &Arc<Relay>, scope: Scope, request: &[u8]) -> String {
    let Some(line) = first_line(request) else {
        return response(400, "text/plain; charset=utf-8", "bad request\n");
    };
    let mut parts = line.split(' ');
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    // The query string is ignored rather than parsed: neither endpoint takes a
    // parameter, and a parser for parameters that do not exist is a parser.
    let path = target.split('?').next().unwrap_or_default();

    match (method, path) {
        ("GET" | "HEAD", "/healthz") => {
            // Constant and cheap: no store query, no counter read, no lock.
            response(200, "text/plain; charset=utf-8", HEALTHZ_BODY)
        }
        // `/metrics` exists on the operator surface only. On the health-only
        // surface it is a 404 rather than a 403: a 403 would confirm the
        // endpoint is there and merely refused, which is one bit more than a
        // listener whose whole claim is that it says nothing.
        ("GET" | "HEAD", "/metrics") if scope == Scope::Operator => response(
            200,
            "text/plain; version=0.0.4; charset=utf-8",
            &relay.metrics().render(),
        ),
        ("GET" | "HEAD", _) => response(404, "text/plain; charset=utf-8", "not found\n"),
        _ => response(405, "text/plain; charset=utf-8", "method not allowed\n"),
    }
}

fn first_line(request: &[u8]) -> Option<&str> {
    // Only ASCII, only the first line, and a hard bound already applied by the
    // caller's buffer. A request line that is not UTF-8 is not one this
    // listener has any reason to understand.
    let text = core::str::from_utf8(request).ok()?;
    let line = text.split("\r\n").next().unwrap_or_default();
    if line.is_empty() { None } else { Some(line) }
}

fn response(status: u16, content_type: &str, body: &str) -> String {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Method Not Allowed",
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         Cache-Control: no-store\r\n\
         \r\n\
         {body}",
        body.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_non_loopback_admin_bind_is_refused() {
        let addr: std::net::SocketAddr = "0.0.0.0:0".parse().unwrap();
        assert!(matches!(bind(addr).await, Err(AdminError::NotLoopback)));
    }

    #[tokio::test]
    async fn the_health_only_listener_may_bind_off_loopback() {
        // The whole point: the kubelet and the GCE load balancer both dial the
        // pod IP, so this surface has to be bindable there.
        let addr: std::net::SocketAddr = "0.0.0.0:0".parse().unwrap();
        assert!(bind_health(addr).await.is_ok());
    }

    #[test]
    fn healthz_is_constant_and_carries_no_numbers() {
        // The body is a fixed string with no digit in it. A health check that
        // reported queue depth or connection counts would be the metadata the
        // protocol refuses, arriving on the endpoint that is polled most often.
        assert!(
            !HEALTHZ_BODY
                .chars()
                .any(|character| character.is_ascii_digit())
        );
        assert_eq!(HEALTHZ_BODY, "ok\n");
    }
}
