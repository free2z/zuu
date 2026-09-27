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
use std::future::Future as _;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::Router;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpListener;
use tokio::sync::{Semaphore, watch};
use tokio::task::JoinSet;
use tower::ServiceExt as _;

/// Control over the connection a request arrived on. Inserted into every
/// request's extensions.
///
/// It exists for an aborted delivery ([`crate::call`]): the connection must
/// not be reused for another request after it (chat-api.md §2.4 "then
/// closes the connection"), and a client that is not reading at all must not
/// hold its socket for as long as it likes — a response body nobody polls
/// cannot end the connection by itself.
#[derive(Clone, Debug)]
pub struct ConnectionKill(watch::Sender<u8>, Arc<AtomicBool>);

const CLOSE_AFTER_RESPONSE: u8 = 1;
const KILL: u8 = 2;

impl ConnectionKill {
    pub(crate) fn write_stalled(&self) -> bool {
        self.1.load(Ordering::Relaxed)
    }

    /// Serve no further request on this connection: finish the current
    /// response, then close.
    pub fn close_after_response(&self) {
        self.0.send_if_modified(|v| {
            let changed = *v < CLOSE_AFTER_RESPONSE;
            *v = (*v).max(CLOSE_AFTER_RESPONSE);
            changed
        });
    }

    /// Drop the connection now, mid-response if need be.
    pub fn kill(&self) {
        self.0.send_replace(KILL);
    }
}

async fn reaches(control: &mut watch::Receiver<u8>, level: u8) {
    let _ = control.wait_for(|v| *v >= level).await;
}

/// Per-listener resource limits. Public and admin listeners use separate budgets.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Live sockets, counted before any connection task or HTTP parsing.
    pub connections: usize,
    /// Deadline for a complete request head.
    pub header_read: Duration,
    /// Maximum time a write or final flush may make no progress.
    pub write_stall: Duration,
}

/// Serve `router` on `listener` until `stop` becomes true, then close:
/// graceful for `grace`, then forced.
pub async fn serve(
    listener: TcpListener,
    router: Router,
    limits: Limits,
    metrics: Option<(Arc<crate::metrics::Metrics>, crate::metrics::Listener)>,
    mut stop: watch::Receiver<bool>,
    grace: Duration,
) {
    let (closing_tx, closing_rx) = watch::channel(false);
    let mut connections = JoinSet::new();
    let permits = Arc::new(Semaphore::new(
        limits.connections.min(Semaphore::MAX_PERMITS),
    ));
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
                // Refuse immediately: never queue tasks waiting for capacity.
                let Ok(permit) = Arc::clone(&permits).try_acquire_owned() else {
                    if let Some((metrics, listener)) = &metrics { metrics.connection_rejected(*listener); }
                    drop(stream);
                    continue;
                };
                let active = metrics.as_ref().map(|(metrics, listener)| metrics.connection_opened(*listener));
                let _ = stream.set_nodelay(true);
                let (kill_tx, control) = watch::channel(0u8);
                let kill = ConnectionKill(kill_tx, Arc::new(AtomicBool::new(false)));
                let socket_kill = kill.clone();
                let service = TowerToHyperService::new(
                    router
                        .clone()
                        .map_request(move |request: hyper::Request<Incoming>| {
                            let mut request = request.map(axum::body::Body::new);
                            request.extensions_mut().insert(kill.clone());
                            request
                        })
                        .map_err(|never: Infallible| match never {}),
                );
                let mut closing = closing_rx.clone();
                connections.spawn(async move {
                    let _permit = permit;
                    let _active = active;
                    let mut builder = http1::Builder::new();
                    builder
                        .timer(TokioTimer::new())
                        .header_read_timeout(limits.header_read);
                    let connection = builder.serve_connection(TokioIo::new(WriteDeadline::new(stream, limits.write_stall, Some(socket_kill))), service);
                    let mut connection = std::pin::pin!(connection);
                    let mut kill_rx = control.clone();
                    let mut close_rx = control;
                    let mut graceful = false;
                    loop {
                        tokio::select! {
                            _ = connection.as_mut() => return,
                            () = reaches(&mut kill_rx, KILL) => return,
                            () = reaches(&mut close_rx, CLOSE_AFTER_RESPONSE), if !graceful => {
                                graceful = true;
                                connection.as_mut().graceful_shutdown();
                            }
                            () = crate::shutdown::raised(&mut closing), if !graceful => {
                                graceful = true;
                                connection.as_mut().graceful_shutdown();
                            }
                        }
                    }
                });
                // Reap finished connections so the set does not grow with
                // every connection this process has ever served.
                while connections.try_join_next().is_some() {}
            }
            _ = connections.join_next(), if !connections.is_empty() => {},
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

/// A write inactivity deadline, including the final flush after the response
/// body ended. Reads never reset it; pending writes must register the timer's
/// waker even when the socket itself will never wake again.
struct WriteDeadline<T> {
    inner: T,
    stall: Duration,
    timer: Option<Pin<Box<tokio::time::Sleep>>>,
    kill: Option<ConnectionKill>,
}

impl<T> WriteDeadline<T> {
    fn new(inner: T, stall: Duration, kill: Option<ConnectionKill>) -> Self {
        Self {
            inner,
            stall,
            timer: None,
            kill,
        }
    }

    fn finish<R>(
        &mut self,
        cx: &mut Context<'_>,
        result: Poll<io::Result<R>>,
    ) -> Poll<io::Result<R>> {
        if result.is_ready() {
            self.timer = None;
            return result;
        }
        let timer = self
            .timer
            .get_or_insert_with(|| Box::pin(tokio::time::sleep(self.stall)));
        if timer.as_mut().poll(cx).is_ready() {
            if let Some(kill) = &self.kill {
                kill.1.store(true, Ordering::Relaxed);
            }
            Poll::Ready(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "client socket write stalled",
            )))
        } else {
            Poll::Pending
        }
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for WriteDeadline<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for WriteDeadline<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.inner).poll_write(cx, buf);
        self.finish(cx, result)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let result = Pin::new(&mut self.inner).poll_flush(cx);
        self.finish(cx, result)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let result = Pin::new(&mut self.inner).poll_shutdown(cx);
        self.finish(cx, result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt as _;

    struct FlushStall;
    impl AsyncWrite for FlushStall {
        fn poll_write(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            bytes: &[u8],
        ) -> Poll<io::Result<usize>> {
            Poll::Ready(Ok(bytes.len()))
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Pending
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Pending
        }
    }

    #[tokio::test]
    async fn stalled_final_flush_has_a_deadline_without_socket_wakeups() {
        let mut io = WriteDeadline::new(FlushStall, Duration::from_millis(20), None);
        io.write_all(b"last response bytes").await.unwrap();
        let failure = tokio::time::timeout(Duration::from_secs(1), io.flush())
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(failure.kind(), io::ErrorKind::TimedOut);
    }

    #[tokio::test]
    async fn blocked_write_and_shutdown_have_deadlines() {
        let (writer, _reader) = tokio::io::duplex(1);
        let mut io = WriteDeadline::new(writer, Duration::from_millis(20), None);
        let failure = tokio::time::timeout(Duration::from_secs(1), io.write_all(b"ab"))
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(failure.kind(), io::ErrorKind::TimedOut);
        let mut io = WriteDeadline::new(FlushStall, Duration::from_millis(20), None);
        let failure = tokio::time::timeout(Duration::from_secs(1), io.shutdown())
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(failure.kind(), io::ErrorKind::TimedOut);
    }
}
