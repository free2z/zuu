//! ZUULI's process-wide outbound policy. Sibling apps default to direct mode.
//! The fixed loopback SOCKS service is independently managed; its identity and
//! bootstrap percentage cannot be established by a SOCKS handshake.
use hyper_util::rt::TokioIo;
use serde::Serialize;
use std::{
    io,
    net::Shutdown,
    pin::Pin,
    sync::{Arc, Mutex, OnceLock, Weak},
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpStream,
    sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock},
};
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};

fn refused() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "transport policy refused or expired",
    )
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub suspended: bool,
    pub epoch: u64,
    pub state: &'static str,
}
struct Inner {
    status: Status,
    sockets: Vec<Weak<std::net::TcpStream>>,
}
pub struct Policy {
    barrier: Arc<RwLock<()>>,
    inner: Mutex<Inner>,
    proxy: std::net::SocketAddr,
}
impl Default for Policy {
    fn default() -> Self {
        Self::new("127.0.0.1:9050".parse().unwrap())
    }
}
impl Policy {
    /// Explicit endpoint only for controlled fixtures. Shipping uses Default.
    pub fn new(proxy: std::net::SocketAddr) -> Self {
        assert!(proxy.ip().is_loopback());
        Self {
            barrier: Arc::new(RwLock::new(())),
            inner: Mutex::new(Inner {
                status: Status {
                    enabled: false,
                    suspended: false,
                    epoch: 0,
                    state: "direct",
                },
                sockets: vec![],
            }),
            proxy,
        }
    }
    pub fn status(&self) -> Status {
        self.inner.lock().unwrap().status.clone()
    }
    /// Closes every registered socket synchronously, including pending reads.
    /// A connector still creating a socket holds the barrier: transition waits
    /// for it, then revokes it again before publishing the new mode.
    pub fn suspend(&self) -> u64 {
        let mut inner = self.inner.lock().unwrap();
        inner.status.suspended = true;
        inner.status.state = "suspended";
        inner.status.epoch += 1;
        Self::close(&mut inner);
        inner.status.epoch
    }
    fn close(inner: &mut Inner) {
        for socket in inner.sockets.drain(..).filter_map(|s| s.upgrade()) {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
    pub async fn transition(&self) -> OwnedRwLockWriteGuard<()> {
        self.barrier.clone().write_owned().await
    }
    /// Caller must hold the write guard through any unsupported-client teardown.
    pub fn set(&self, _guard: &OwnedRwLockWriteGuard<()>, enabled: bool, suspended: bool) {
        let mut inner = self.inner.lock().unwrap();
        Self::replace(&mut inner, enabled, suspended);
    }
    fn replace(inner: &mut Inner, enabled: bool, suspended: bool) {
        Self::close(inner);
        inner.status = Status {
            enabled,
            suspended,
            epoch: inner.status.epoch + 1,
            state: if suspended {
                "suspended"
            } else if enabled {
                "waiting"
            } else {
                "direct"
            },
        };
    }
    /// A background/network event during a transition must not be overwritten
    /// by a delayed successful opt-in or reconnect acknowledgement.
    pub fn finish_transition(
        &self,
        _guard: &OwnedRwLockWriteGuard<()>,
        enabled: bool,
        expected: u64,
    ) -> io::Result<Status> {
        let mut inner = self.inner.lock().unwrap();
        if inner.status.epoch != expected {
            return Err(refused());
        }
        Self::replace(&mut inner, enabled, false);
        Ok(inner.status.clone())
    }
    pub async fn direct(&self) -> io::Result<OwnedRwLockReadGuard<()>> {
        let guard = self.barrier.clone().read_owned().await;
        let s = self.status();
        if s.enabled || s.suspended {
            return Err(refused());
        }
        Ok(guard)
    }
    pub fn direct_now(&self) -> io::Result<OwnedRwLockReadGuard<()>> {
        let guard = self
            .barrier
            .clone()
            .try_read_owned()
            .map_err(|_| refused())?;
        let s = self.status();
        if s.enabled || s.suspended {
            return Err(refused());
        }
        Ok(guard)
    }
    fn valid(&self, epoch: u64) -> io::Result<()> {
        let s = self.status();
        if s.epoch != epoch || s.suspended {
            Err(refused())
        } else {
            Ok(())
        }
    }
    async fn connect(self: &Arc<Self>, host: &str, port: u16, epoch: u64) -> io::Result<Stream> {
        let guard = self.barrier.clone().read_owned().await;
        self.valid(epoch)?;
        let tor = self.status().enabled;
        // OS DNS jobs cannot be cancelled. Keep their lease INSIDE the
        // blocking job so cancellation/timeout cannot release a transition
        // while a detached resolver is still emitting clearnet DNS packets.
        let (_guard, addresses) = if tor {
            (guard, vec![])
        } else {
            let host = host.to_owned();
            let (guard, addresses) = tokio::task::spawn_blocking(move || {
                use std::net::ToSocketAddrs;
                let addresses = (host.as_str(), port)
                    .to_socket_addrs()
                    .map(|a| a.collect::<Vec<_>>());
                (guard, addresses)
            })
            .await
            .map_err(io::Error::other)?;
            (guard, addresses?)
        };
        self.valid(epoch)?;
        let result = tokio::time::timeout(Duration::from_secs(30), async {
            if tor {
                // Tuple string target encodes SOCKS5 DOMAIN, never ToSocketAddrs.
                tokio_socks::tcp::Socks5Stream::connect(self.proxy, (host, port))
                    .await
                    .map(|s| s.into_inner())
                    .map_err(io::Error::other)
            } else {
                TcpStream::connect(addresses.as_slice()).await
            }
        })
        .await
        .unwrap_or_else(|_| Err(io::Error::new(io::ErrorKind::TimedOut, "transport timeout")));
        let socket = match result {
            Ok(s) => s,
            Err(e) => {
                let mut inner = self.inner.lock().unwrap();
                if inner.status.epoch == epoch && tor {
                    inner.status.state = "degraded";
                }
                return Err(e);
            }
        };
        let socket = socket.into_std()?;
        let shutdown = Arc::new(socket.try_clone()?);
        let mut inner = self.inner.lock().unwrap();
        if inner.status.epoch != epoch || inner.status.suspended {
            let _ = socket.shutdown(Shutdown::Both);
            return Err(refused());
        }
        inner.sockets.retain(|s| s.strong_count() > 0);
        inner.sockets.push(Arc::downgrade(&shutdown));
        if tor {
            inner.status.state = "proxyConnected";
        }
        Ok(Stream {
            socket: TcpStream::from_std(socket)?,
            _shutdown: shutdown,
            policy: self.clone(),
            epoch,
        })
    }
    /// Production lightwalletd connector, including tonic reconnects. The
    /// closure captures the original epoch; reconnect never adopts a new mode.
    pub async fn channel(
        self: &Arc<Self>,
        url: &str,
    ) -> Result<Channel, Box<dyn std::error::Error + Send + Sync>> {
        self.channel_at_epoch(url, self.status().epoch).await
    }
    pub async fn channel_at_epoch(
        self: &Arc<Self>,
        url: &str,
        epoch: u64,
    ) -> Result<Channel, Box<dyn std::error::Error + Send + Sync>> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        self.valid(epoch)?;
        let mut endpoint = Endpoint::from_shared(url.to_owned())?
            .connect_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(60))
            .http2_keep_alive_interval(Duration::from_secs(30))
            .keep_alive_timeout(Duration::from_secs(20))
            .keep_alive_while_idle(false);
        if endpoint.uri().scheme_str() == Some("https") {
            endpoint = endpoint.tls_config(ClientTlsConfig::new().with_webpki_roots())?;
        }
        let policy = self.clone();
        let result = endpoint
            .connect_with_connector(tower::service_fn(move |uri: http::Uri| {
                let policy = policy.clone();
                async move {
                    let host = uri.host().ok_or_else(refused)?;
                    let port = uri
                        .port_u16()
                        .unwrap_or(if uri.scheme_str() == Some("https") {
                            443
                        } else {
                            80
                        });
                    policy.connect(host, port, epoch).await.map(TokioIo::new)
                }
            }))
            .await;
        if result.is_err() {
            let mut inner = self.inner.lock().unwrap();
            if inner.status.epoch == epoch && inner.status.enabled {
                inner.status.state = "degraded";
            }
        }
        Ok(result?)
    }
}
static GLOBAL: OnceLock<Arc<Policy>> = OnceLock::new();
pub fn global() -> &'static Arc<Policy> {
    GLOBAL.get_or_init(|| Arc::new(Policy::default()))
}
struct Stream {
    socket: TcpStream,
    _shutdown: Arc<std::net::TcpStream>,
    policy: Arc<Policy>,
    epoch: u64,
}
impl AsyncRead for Stream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        // Hold the state lock through the nonblocking syscall, so a mode
        // acknowledgement cannot race an old connection's read/write.
        let policy = self.policy.clone();
        let inner = policy.inner.lock().unwrap();
        if inner.status.epoch != self.epoch || inner.status.suspended {
            return Poll::Ready(Err(refused()));
        }
        Pin::new(&mut self.socket).poll_read(cx, buf)
    }
}
impl AsyncWrite for Stream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let policy = self.policy.clone();
        let inner = policy.inner.lock().unwrap();
        if inner.status.epoch != self.epoch || inner.status.suspended {
            return Poll::Ready(Err(refused()));
        }
        Pin::new(&mut self.socket).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_shutdown(cx)
    }
}

/// Blocking directory work must keep a lease even if its awaiting async
/// workflow is cancelled. Refuse immediately if a transition has queued.
pub async fn spawn_blocking_direct<F, T>(work: F) -> io::Result<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let lease = global().direct_now()?;
    tokio::task::spawn_blocking(move || {
        let _lease = lease;
        work()
    })
    .await
    .map_err(io::Error::other)
}
