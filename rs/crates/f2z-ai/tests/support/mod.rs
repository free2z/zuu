//! Shared harness for the gateway's integration tests: a real gateway on
//! ephemeral loopback ports, driven over real sockets by hyper's client.
//!
//! The workspace's panic lints are relaxed here, as in every integration test
//! under `rs/`: a failed assertion *is* a panic, and these files never run in
//! the service.

#![allow(
    dead_code,
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::convert::Infallible;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, Response, StatusCode, header};
use bytes::Bytes;
use f2z_ai::ApiFailure;
use f2z_ai::admission::CallHandle;
use f2z_ai::auth::{Admitted, Gatekeeper, Principal};
use f2z_ai::call::Upstream;
use f2z_ai::catalog::{self, CatalogSource, VerifiedCatalog};
use f2z_ai::chat::ChatBackend;
use f2z_ai::config::Config;
use f2z_ai::settle::{CallRecord, Settler};
use f2z_ai::{Deps, Gateway};
use f2z_ai_proto::Event;
use f2z_ai_proto::catalog::Catalog;
use f2z_ai_proto::chat::{ChatRequest, Usage, UsageSource};
use f2z_ai_proto::event::{Delta, UsageEvent};
use http_body::Frame;
use http_body_util::BodyExt as _;
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

/// A config on ephemeral loopback ports, with `overrides` applied as
/// `F2Z_AI_*` environment variables — the same path production uses.
pub fn config(overrides: &[(&str, &str)]) -> Config {
    let mut env: Vec<(String, String)> = vec![
        ("F2Z_AI_LISTEN".into(), "127.0.0.1:0".into()),
        ("F2Z_AI_ADMIN_LISTEN".into(), "127.0.0.1:0".into()),
        ("F2Z_AI_CATALOG_POLL_SECS".into(), "3600".into()),
    ];
    env.extend(
        overrides
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned())),
    );
    Config::load(None, env).unwrap()
}

/// The `f2z-ai-proto` fixture catalogue, re-dated to be valid for an hour.
pub fn fresh_catalog() -> VerifiedCatalog {
    let text = include_str!("../../../f2z-ai-proto/fixtures/catalog/catalog.json");
    let mut c: Catalog = serde_json::from_str(text).unwrap();
    let now = catalog::now_unix();
    c.issued_at = now - 60;
    c.expires_at = now + 3600;
    VerifiedCatalog::from_verified(c).unwrap()
}

pub fn fixed_catalog() -> Arc<dyn CatalogSource> {
    Arc::new(catalog::Fixed(fresh_catalog()))
}

/// Records every call handed to the settler.
#[derive(Clone, Default)]
pub struct RecordingSettler(pub Arc<Mutex<Vec<CallRecord>>>);

impl RecordingSettler {
    pub fn records(&self) -> Vec<CallRecord> {
        self.0.lock().unwrap().clone()
    }
}

#[async_trait]
impl Settler for RecordingSettler {
    async fn settle(&self, record: CallRecord) {
        self.0.lock().unwrap().push(record);
    }
}

/// A response body fed by a channel: frames arrive when the test sends them,
/// and the body ends when the test drops the sender.
pub struct ChannelBody(pub mpsc::Receiver<Bytes>);

impl http_body::Body for ChannelBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        self.0.poll_recv(cx).map(|o| o.map(|b| Ok(Frame::data(b))))
    }
}

/// An upstream fed by a channel: events arrive when the test sends them, and
/// the upstream ends when the test drops the sender.
pub struct ChannelUpstream(pub mpsc::Receiver<Event>);

#[async_trait]
impl Upstream for ChannelUpstream {
    async fn next(&mut self) -> Option<Event> {
        self.0.recv().await
    }
}

/// A backend whose every call's upstream the test drives: each call's
/// sender arrives on the receiver [`ControlledBackend::new`] returns.
pub struct ControlledBackend {
    streams: mpsc::UnboundedSender<mpsc::Sender<Event>>,
}

impl ControlledBackend {
    pub fn new() -> (Arc<Self>, mpsc::UnboundedReceiver<mpsc::Sender<Event>>) {
        let (streams, rx) = mpsc::unbounded_channel();
        (Arc::new(Self { streams }), rx)
    }
}

#[async_trait]
impl ChatBackend for ControlledBackend {
    async fn start(
        &self,
        _request: ChatRequest,
        _catalog: Arc<VerifiedCatalog>,
        _call: &CallHandle,
    ) -> Result<Box<dyn Upstream>, ApiFailure> {
        let (tx, rx) = mpsc::channel(16);
        self.streams.send(tx).unwrap();
        Ok(Box::new(ChannelUpstream(rx)))
    }
}

/// A backend that never starts.
pub struct StallingBackend;

#[async_trait]
impl ChatBackend for StallingBackend {
    async fn start(
        &self,
        _request: ChatRequest,
        _catalog: Arc<VerifiedCatalog>,
        _call: &CallHandle,
    ) -> Result<Box<dyn Upstream>, ApiFailure> {
        std::future::pending().await
    }
}

pub fn delta(text: &str) -> Event {
    Event::Delta(Delta {
        text: text.to_owned(),
    })
}

pub fn usage(output_tokens: u64) -> Event {
    Event::Usage(UsageEvent {
        usage: Usage {
            input_tokens: 10,
            output_tokens,
            ..Usage::default()
        },
        source: UsageSource::Provider,
    })
}

pub fn sse(event: &Event) -> String {
    event.to_sse().unwrap()
}

pub fn deps(
    catalog: Arc<dyn CatalogSource>,
    backend: Arc<dyn ChatBackend>,
    settler: RecordingSettler,
) -> Deps {
    Deps {
        gate: open_gate(),
        catalog,
        backend,
        settler: Arc::new(settler),
    }
}

/// A gatekeeper that admits every request as one fixed user, with no lease:
/// for the tests of everything *behind* authentication. `tests/auth.rs`
/// drives the real [`f2z_ai::auth::Gate`].
pub struct OpenGate;

#[async_trait]
impl Gatekeeper for OpenGate {
    async fn admit(&self, _headers: &axum::http::HeaderMap) -> Result<Admitted, ApiFailure> {
        Ok(Admitted {
            principal: Principal {
                sub: "00000000-0000-4000-8000-000000000000".into(),
                client_id: "app_test".into(),
                app_id: "22222222-2222-4222-8222-222222222222".into(),
                scope: "ai:invoke".into(),
                aep: 1,
                agen: 1,
                exp: u64::MAX,
                jti: "test".into(),
            },
            lease: None,
        })
    }
}

pub fn open_gate() -> Arc<dyn Gatekeeper> {
    Arc::new(OpenGate)
}

/// A started gateway and its addresses.
pub struct Running {
    pub public: SocketAddr,
    pub admin: SocketAddr,
    pub gateway: Gateway,
}

pub async fn start(config: &Config, deps: Deps) -> Running {
    let gateway = Gateway::bind(config, deps).await.unwrap();
    Running {
        public: gateway.public_addr(),
        admin: gateway.admin_addr(),
        gateway,
    }
}

/// One request on a fresh connection.
pub async fn send(addr: SocketAddr, request: Request<Body>) -> Response<Incoming> {
    let stream = TcpStream::connect(addr).await.unwrap();
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    sender.send_request(request).await.unwrap()
}

pub async fn get(addr: SocketAddr, path: &str) -> (StatusCode, String) {
    let request = Request::get(path)
        .header(header::HOST, "gateway")
        .body(Body::empty())
        .unwrap();
    let response = send(addr, request).await;
    let status = response.status();
    (status, text(response).await)
}

pub fn chat_request(body: impl Into<Body>) -> Request<Body> {
    Request::post("/v1/chat")
        .header(header::HOST, "gateway")
        .header(header::CONTENT_TYPE, "application/json")
        .body(body.into())
        .unwrap()
}

pub async fn post_chat(addr: SocketAddr, body: &Value) -> Response<Incoming> {
    send(addr, chat_request(body.to_string())).await
}

pub async fn text(response: Response<Incoming>) -> String {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// A decoded error envelope.
pub async fn error_of(response: Response<Incoming>) -> Value {
    let body = text(response).await;
    let value: Value = serde_json::from_str(&body).unwrap_or_else(|_| panic!("not JSON: {body}"));
    value["error"].clone()
}

pub fn valid_chat(text: &str) -> Value {
    json!({
        "model": "example-large",
        "messages": [{"role": "user", "content": [{"type": "text", "text": text}]}],
    })
}

/// Poll until `/readyz` answers `want`.
pub async fn wait_readyz(admin: SocketAddr, want: StatusCode) {
    for _ in 0..200 {
        if get(admin, "/readyz").await.0 == want {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("/readyz never answered {want}");
}

/// The next data frame of a streamed body, or `Err` if the body failed.
pub async fn next_frame(body: &mut Incoming) -> Result<Option<Bytes>, hyper::Error> {
    loop {
        match body.frame().await {
            None => return Ok(None),
            Some(Err(e)) => return Err(e),
            Some(Ok(frame)) => {
                if let Ok(data) = frame.into_data() {
                    return Ok(Some(data));
                }
            }
        }
    }
}

/// A raw request over TCP, for what a well-behaved client cannot express. The
/// response is read until the server closes or `wait` passes.
pub async fn raw(addr: SocketAddr, bytes: &[u8], wait: Duration) -> String {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(bytes).await.unwrap();
    let mut out = Vec::new();
    let _ = tokio::time::timeout(wait, stream.read_to_end(&mut out)).await;
    String::from_utf8_lossy(&out).into_owned()
}

/// Poll `/metrics` until `series` reads `want`.
pub async fn wait_metric(admin: SocketAddr, series: &str, want: &str) {
    let mut last = String::new();
    for _ in 0..500 {
        last = metric(admin, series).await;
        if last == want {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("{series} stayed {last}, wanted {want}");
}

/// Poll until the settler has seen `n` calls.
pub async fn wait_records(settler: &RecordingSettler, n: usize) -> Vec<CallRecord> {
    for _ in 0..500 {
        let records = settler.records();
        if records.len() >= n {
            return records;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("settler saw {:?}", settler.records());
}

/// A `/metrics` sample's value.
pub async fn metric(admin: SocketAddr, series: &str) -> String {
    let (_, body) = get(admin, "/metrics").await;
    body.lines()
        .find_map(|line| line.strip_prefix(series).map(|v| v.trim().to_owned()))
        .unwrap_or_else(|| panic!("no series {series} in:\n{body}"))
}
