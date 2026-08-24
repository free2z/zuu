//! The public listener: accept, upgrade, hand over (§2.1, §2.3, §13.1 layer 1).
//!
//! # §2.3 is enforced at bind, not warned about
//!
//! > *A relay **MUST refuse to bind a non-loopback address without TLS.** This
//! > is a startup check, not a warning: the process exits.*
//!
//! [`crate::config::Config::check`] is where that decision is made, so it is
//! reachable from `--check-config` without opening a socket. This module is
//! where it is *acted on*: [`bind`] refuses the same case again, because a
//! listener that could be constructed by a caller who skipped the check is a
//! listener that will eventually be constructed that way.
//!
//! The override is published, not private: `--insecure-listen` makes the
//! capability document say `transport_security: none` and
//! `channel_binding_mode: none`, and [`crate::caps`] derives both from the same
//! question the listener asks, so they cannot disagree.
//!
//! # What the upgrade checks
//!
//! §2.1 makes two things mandatory and this enforces both: the path
//! `/relay/v1`, and the `free2z-relay.v1` subprotocol **echoed back**. A relay
//! that does not echo it is one the client must refuse, so a relay that forgets
//! to is a relay nobody can talk to — which is a bug worth failing loudly rather
//! than a nicety.

use std::net::SocketAddr;
use std::sync::Arc;

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::handshake::server::{
    ErrorResponse, Request as HandshakeRequest, Response as HandshakeResponse,
};
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};

use crate::abuse::Refusal;
use crate::config::is_loopback;
use crate::engine::Relay;
use crate::metrics::Metrics;
use crate::transport::{RELAY_PATH, SUBPROTOCOL, Transport, wrap};

const HEADER_SUBPROTOCOL: &str = "sec-websocket-protocol";

/// Why a listener could not be created.
#[derive(Debug)]
pub enum ListenError {
    /// §2.3: a non-loopback bind without TLS and without the override.
    InsecureBind,
    /// The socket could not be bound.
    Io(std::io::Error),
}

impl std::fmt::Display for ListenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InsecureBind => f.write_str(
                "refusing to bind a non-loopback address without TLS (WIRE.md §2.3); \
                 configure listen.tls_cert and listen.tls_key, or pass --insecure-listen",
            ),
            Self::Io(error) => write!(f, "bind: {error}"),
        }
    }
}

impl std::error::Error for ListenError {}

/// Bind the protocol listener.
///
/// # Errors
///
/// [`ListenError::InsecureBind`] for §2.3's refused case, or
/// [`ListenError::Io`] if the socket cannot be bound.
pub async fn bind(
    addr: SocketAddr,
    tls: bool,
    insecure_override: bool,
) -> Result<TcpListener, ListenError> {
    if !tls && !is_loopback(&addr) && !insecure_override {
        return Err(ListenError::InsecureBind);
    }
    TcpListener::bind(addr).await.map_err(ListenError::Io)
}

/// Accept connections until `shutdown` flips.
pub async fn serve(
    relay: Arc<Relay>,
    listener: TcpListener,
    acceptor: Option<TlsAcceptor>,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        let accepted = tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            accepted = listener.accept() => accepted,
        };
        let Ok((stream, peer)) = accepted else {
            // A transient accept failure (a descriptor limit, a peer that reset
            // between the SYN and the accept) must not end the listener: the
            // relay would then be a process that is running and serving nobody.
            crate::log_warn!("accept failed");
            continue;
        };

        let metrics = Arc::clone(relay.metrics());
        let abuse = Arc::clone(relay.abuse());
        let source = abuse.key_for(&peer);
        // §13.1 layer 1, applied **before** any protocol is spoken. There is no
        // HELLO yet, so there is no frame to answer with; the socket closes.
        let permit = match abuse.accept(source, crate::now_ms()) {
            Ok(permit) => permit,
            Err(reason) => {
                Metrics::inc(&metrics.connections_refused);
                crate::log_debug!("connection refused", "reason" = refusal_code(reason));
                drop(stream);
                continue;
            }
        };
        Metrics::inc(&metrics.connections_accepted);
        Metrics::inc(&metrics.connections_open);

        let relay = Arc::clone(&relay);
        let acceptor = acceptor.clone();
        let shutdown = shutdown.clone();
        tokio::spawn(async move {
            let outcome = handshake(stream, acceptor.as_ref()).await;
            if let Some((transport, binding)) = outcome {
                crate::connection::drive(relay, transport, binding, source, shutdown).await;
            }
            Metrics::dec(&metrics.connections_open);
            // The permit is released here, whatever path the task took — a
            // failed TLS handshake, a refused upgrade, or a full session.
            drop(permit);
        });
    }
}

const fn refusal_code(reason: Refusal) -> u32 {
    match reason {
        Refusal::TooManyConnections => 1,
        Refusal::TooManyFromSource => 2,
        Refusal::ConnectingTooFast => 3,
        Refusal::Backpressure => 4,
    }
}

async fn handshake(
    stream: TcpStream,
    acceptor: Option<&TlsAcceptor>,
) -> Option<(Transport, f2z_codec::types::ChannelBinding)> {
    // Nagle costs a relay latency and buys it nothing: every frame is written
    // whole by the writer task.
    let _ = stream.set_nodelay(true);

    match acceptor {
        Some(acceptor) => {
            let tls = acceptor.accept(stream).await.ok()?;
            // §5.3: the exporter is taken from the completed handshake, before
            // the WebSocket upgrade consumes the stream.
            let binding = {
                let (_io, connection) = tls.get_ref();
                crate::tls::export(connection)
            };
            let socket = tokio_tungstenite::accept_hdr_async(tls, check_upgrade)
                .await
                .ok()?;
            Some((wrap(socket), binding))
        }
        None => {
            let socket = tokio_tungstenite::accept_hdr_async(stream, check_upgrade)
                .await
                .ok()?;
            // §5.3: "MUST use **32 zero bytes** in the transcript".
            Some((wrap(socket), f2z_codec::types::ChannelBinding::zero()))
        }
    }
}

/// §2.1's two mandatory properties of the upgrade.
///
/// The `Err` variant is `tungstenite`'s own `http::Response`, whose size is not
/// ours to change, and this runs once per accept rather than on a hot path.
#[allow(
    clippy::result_large_err,
    reason = "the error type is tungstenite's Callback contract, once per accept"
)]
fn check_upgrade(
    request: &HandshakeRequest,
    mut response: HandshakeResponse,
) -> Result<HandshakeResponse, ErrorResponse> {
    if request.uri().path() != RELAY_PATH {
        return Err(reject("the relay serves only /relay/v1 (WIRE.md §2.1)"));
    }
    let offered = request
        .headers()
        .get(HEADER_SUBPROTOCOL)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !offered
        .split(',')
        .map(str::trim)
        .any(|value| value == SUBPROTOCOL)
    {
        return Err(reject(
            "the subprotocol header is mandatory in both directions (WIRE.md §2.1)",
        ));
    }
    response
        .headers_mut()
        .insert(HEADER_SUBPROTOCOL, HeaderValue::from_static(SUBPROTOCOL));
    Ok(response)
}

fn reject(reason: &'static str) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some(reason.to_owned()));
    *response.status_mut() = StatusCode::BAD_REQUEST;
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_non_loopback_bind_without_tls_is_refused() {
        let addr: SocketAddr = "0.0.0.0:0".parse().unwrap();
        assert!(matches!(
            bind(addr, false, false).await,
            Err(ListenError::InsecureBind)
        ));
        // With TLS, or with the published override, §2.3 permits it.
        assert!(bind(addr, true, false).await.is_ok());
        assert!(bind(addr, false, true).await.is_ok());
    }

    #[tokio::test]
    async fn loopback_without_tls_needs_no_override() {
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        assert!(bind(addr, false, false).await.is_ok());
    }
}
