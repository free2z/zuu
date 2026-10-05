//! The RFC 8252 §7.3 loopback redirect: a one-request HTTP listener on
//! `127.0.0.1:<random>` that receives the browser coming back.
//!
//! Deliberately tiny. It reads one request head, answers it with a short
//! page, and hands the request target to the caller; it never serves
//! anything else. A request for any other path (a browser's `/favicon.ico`)
//! is answered `404` and the listener keeps waiting.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::{AuthSession, AuthorizationRequest, BoxFuture, UrlOpener};
use crate::error::Error;

/// The largest request head read from the browser.
const MAX_HEAD: usize = 16 * 1024;
/// How long one connection may take to send its request head.
const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// A bound loopback listener for one path.
#[derive(Debug)]
pub(crate) struct Listener {
    listener: TcpListener,
    port: u16,
    path: String,
}

impl Listener {
    /// Bind `127.0.0.1:0` for `path` (which starts with `/` and carries no
    /// query or fragment).
    pub(crate) async fn bind(path: &str) -> Result<Self, Error> {
        if !path.starts_with('/') || path.contains(['?', '#', ' ']) {
            return Err(Error::Config(format!(
                "loopback path {path:?} must start with '/' and carry no query"
            )));
        }
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| Error::Browser(format!("cannot bind the loopback listener: {e}")))?;
        let port = listener
            .local_addr()
            .map_err(|e| Error::Browser(format!("loopback listener address: {e}")))?
            .port();
        Ok(Self {
            listener,
            port,
            path: path.to_owned(),
        })
    }

    /// `http://127.0.0.1:<port><path>`.
    pub(crate) fn uri(&self) -> String {
        format!("http://127.0.0.1:{}{}", self.port, self.path)
    }

    /// Wait for a `GET` of this listener's path; answer it with `page` and
    /// return the full URL the browser requested.
    pub(crate) async fn next_callback(&self, page: &str) -> Result<String, Error> {
        loop {
            let (stream, _) = self
                .listener
                .accept()
                .await
                .map_err(|e| Error::Browser(format!("loopback accept: {e}")))?;
            if let Some(target) = self.serve(stream, page).await {
                return Ok(format!("http://127.0.0.1:{}{}", self.port, target));
            }
        }
    }

    /// Serve one connection; the request target if it was our callback.
    async fn serve(&self, mut stream: TcpStream, page: &str) -> Option<String> {
        let head = match tokio::time::timeout(READ_TIMEOUT, read_head(&mut stream)).await {
            Ok(Some(head)) => head,
            _ => return None,
        };
        let line = head.lines().next().unwrap_or("");
        let mut parts = line.split(' ');
        let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        let path = target.split('?').next().unwrap_or("");
        if method != "GET" || path != self.path {
            let _ = write_response(&mut stream, "404 Not Found", "Not found.").await;
            return None;
        }
        let _ = write_response(&mut stream, "200 OK", page).await;
        Some(target.to_owned())
    }
}

async fn read_head(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(chunk.get(..n)?);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.windows(2).any(|w| w == b"\n\n") {
            return String::from_utf8(buf).ok();
        }
        if buf.len() > MAX_HEAD {
            return None;
        }
    }
}

async fn write_response(stream: &mut TcpStream, status: &str, text: &str) -> std::io::Result<()> {
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>Free2Z</title>\
         <body style=\"font-family:system-ui,sans-serif;margin:3em\"><p>{text}</p></body>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n\
         Connection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

/// The desktop [`AuthSession`]: a loopback redirect on `127.0.0.1:<random>`
/// and a system browser opened through the caller's [`UrlOpener`].
///
/// Register `http://127.0.0.1:0/callback` (or your path) for the app: the
/// IdP ignores the port of a loopback redirect (RFC 8252 §7.3). `localhost`
/// is not accepted by the IdP, and this session never uses it.
///
/// ```no_run
/// # async fn run(client: f2z_sdk::Client) -> Result<(), f2z_sdk::Error> {
/// use f2z_sdk::oauth::LoopbackSession;
///
/// // Any `Fn(&str) -> Result<(), String>` opens the system browser; the
/// // Tauri plugin passes its opener.
/// let opener = |url: &str| -> Result<(), String> {
///     println!("open {url}");
///     Ok(())
/// };
/// let session = LoopbackSession::bind(opener).await?;
/// let signed_in = client.sign_in(&session, Default::default()).await?;
/// println!("signed in as {:?}", signed_in.subject);
/// # Ok(()) }
/// ```
pub struct LoopbackSession<O> {
    listener: Listener,
    redirect_uri: String,
    opener: O,
}

impl<O: UrlOpener> LoopbackSession<O> {
    /// Bind a listener for `/callback`.
    ///
    /// # Errors
    ///
    /// [`Error::Browser`] if no loopback port can be bound.
    pub async fn bind(opener: O) -> Result<Self, Error> {
        Self::bind_with_path(opener, "/callback").await
    }

    /// Bind a listener for `path` — the path of the registered loopback
    /// redirect URI.
    ///
    /// # Errors
    ///
    /// [`Error::Config`] for a path that does not start with `/`;
    /// [`Error::Browser`] if no loopback port can be bound.
    pub async fn bind_with_path(opener: O, path: &str) -> Result<Self, Error> {
        let listener = Listener::bind(path).await?;
        let redirect_uri = listener.uri();
        Ok(Self {
            listener,
            redirect_uri,
            opener,
        })
    }
}

impl<O> std::fmt::Debug for LoopbackSession<O> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoopbackSession")
            .field("redirect_uri", &self.redirect_uri)
            .finish_non_exhaustive()
    }
}

impl<O: UrlOpener> AuthSession for LoopbackSession<O> {
    fn redirect_uri(&self) -> &str {
        &self.redirect_uri
    }

    fn authorize<'a>(
        &'a self,
        request: &'a AuthorizationRequest,
    ) -> BoxFuture<'a, Result<String, Error>> {
        Box::pin(async move {
            self.opener
                .open(&request.url)
                .map_err(Error::BrowserUnavailable)?;
            self.listener
                .next_callback(
                    "Signed in to Free2Z. You can close this window and return to the app.",
                )
                .await
        })
    }
}
