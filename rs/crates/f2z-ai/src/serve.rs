//! The accept loop: hyper HTTP/1.1 with a timer, and a close that is bounded.
//!
//! `axum::serve` is not used because it configures no timer — so a client
//! that sends half a request line holds its connection and task forever — and
//! because its graceful shutdown waits on connections without a bound, while a
//! drain here must end on a deadline whatever a client is doing. So:
//!
//! * `header_read_timeout` bounds how long a request head may take;
//! * every connection runs in a [`JoinSet`] this loop owns, so shutdown can
//!   first ask each connection to finish gracefully and then, after a grace,
//!   **drop** the rest — a client that stopped reading is never polled
//!   again, so its connection would otherwise outlive the drain. (Calls do
//!   not depend on this: a call's upstream read and settlement run on its own
//!   task, not inside the response body — see [`crate::call`].)

use std::convert::Infallible;
use std::time::Duration;

use axum::Router;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinSet;
use tower::ServiceExt as _;

/// Serve `router` on `listener` until `stop` becomes true, then close:
/// graceful for `grace`, then forced.
pub async fn serve(
    listener: TcpListener,
    router: Router,
    header_read_timeout: Duration,
    mut stop: watch::Receiver<bool>,
    grace: Duration,
) {
    let (closing_tx, closing_rx) = watch::channel(false);
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let stream = match accepted {
                    Ok((stream, _peer)) => stream,
                    Err(error) => {
                        // EMFILE and friends: back off rather than spin. The
                        // peer address is deliberately not logged.
                        tracing::warn!(%error, "accept failed");
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        continue;
                    }
                };
                let _ = stream.set_nodelay(true);
                let service = TowerToHyperService::new(
                    router
                        .clone()
                        .map_request(|request: hyper::Request<Incoming>| {
                            request.map(axum::body::Body::new)
                        })
                        .map_err(|never: Infallible| match never {}),
                );
                let mut closing = closing_rx.clone();
                connections.spawn(async move {
                    let mut builder = http1::Builder::new();
                    builder
                        .timer(TokioTimer::new())
                        .header_read_timeout(header_read_timeout);
                    let connection = builder.serve_connection(TokioIo::new(stream), service);
                    let mut connection = std::pin::pin!(connection);
                    tokio::select! {
                        _ = connection.as_mut() => return,
                        () = crate::shutdown::raised(&mut closing) => {}
                    }
                    connection.as_mut().graceful_shutdown();
                    let _ = connection.await;
                });
                // Reap finished connections so the set does not grow with
                // every connection this process has ever served.
                while connections.try_join_next().is_some() {}
            }
            () = crate::shutdown::raised(&mut stop) => break,
        }
    }
    drop(listener);
    closing_tx.send_replace(true);
    let drained = tokio::time::timeout(grace, async {
        while connections.join_next().await.is_some() {}
    })
    .await;
    if drained.is_err() {
        tracing::warn!(
            remaining = connections.len(),
            "connections still open after the close grace; dropping them"
        );
        connections.shutdown().await;
    }
}
