//! The gateway: two listeners, the layer stack, the background tasks, and the
//! drain.
//!
//! # Listeners
//!
//! | Listener | Routes | Admission |
//! |---|---|---|
//! | `listen` (public) | `POST /v1/chat`; anything else is `404` | yes |
//! | `admin_listen` | `GET /healthz`, `/readyz`, `/metrics` | **no call admission** — an independent connection budget keeps probes out of the public queue |
//!
//! Aggregate metrics are not public, so `/metrics` is on the admin listener,
//! which the deployment does not route through the public Service.
//!
//! # The public layer stack, outermost first
//!
//! 1. **observe** — a span per request, one log line and one metrics sample
//!    per response head. Route label from a closed set; no path, no headers.
//! 2. **admission** ([`crate::admission`]) — draining → 503; full → 503 +
//!    `Retry-After`; otherwise the request holds a slot — a started call
//!    until its settle returns, anything else until its response body ends.
//! 3. **timeout** — a backstop at `request_timeout` + 5 s, `500 internal`. The
//!    real deadline for a call's start is the call task's own (from
//!    admission, `request_timeout`), so the task that gives up is the task
//!    that settles the call as `NotStarted`.
//! 4. the router.
//!
//! # The drain ([`Gateway::run_until`])
//!
//! On the signal: (1) readiness flips to 503 and every new request is refused
//! with `503 unavailable` / `reason: draining` — the listener keeps accepting,
//! so a client the load balancer has not yet re-routed gets a retryable answer
//! rather than a refused connection; (2) wait up to `drain_timeout` (300 s)
//! for every call in flight to be read to its end **and settled** — calls
//! keep reading their upstream at provider speed and delivering through the
//! window; (3) if the window closes first, abort the rest — each upstream
//! read stops, each streamed body fails at its next poll, so the client sees
//! a cut stream, not a complete one, and each call reaches the settler as
//! `Drained`; (4) stop accepting and close connections, gracefully for
//! `abort_grace`, then by dropping them; (5) give the settler `settle_grace`
//! to finish; (6) stop the admin listener. The exit is ordered so that every
//! started call has been handed to the settler before the settler is stopped.

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Body;
use axum::error_handling::HandleErrorLayer;
use axum::extract::State;
use axum::http::{HeaderValue, Request, Response, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use f2z_ai_proto::ErrorCode;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tower::{Layer, Service, ServiceBuilder};
use tracing::Instrument as _;

use crate::admission::{AdmissionLayer, InFlight};
use crate::auth::Gatekeeper;
use crate::catalog::{self, CatalogSource};
use crate::chat::{self, ChatBackend, ChatState};
use crate::config::Config;
use crate::error::ApiFailure;
use crate::metrics::{Gauges, Metrics, Route};
use crate::settle::{self, Settler};

/// How much later than `request_timeout` the tower timeout fires.
const TIMEOUT_BACKSTOP_MARGIN: Duration = Duration::from_secs(5);

/// The pluggable parts. Production: [`Deps::skeleton`].
#[derive(Clone)]
pub struct Deps {
    /// Authentication and limits in front of `/v1/chat`.
    pub gate: Arc<dyn Gatekeeper>,
    /// Where verified catalogues come from.
    pub catalog: Arc<dyn CatalogSource>,
    /// What answers a valid call.
    pub backend: Arc<dyn ChatBackend>,
    /// Where finished calls go.
    pub settler: Arc<dyn Settler>,
}

impl Deps {
    /// This build: no catalogue source, `501` backend, logging settler, and
    /// no token verification — every `/v1/chat` is `503` until
    /// [`Deps::gate`] is set (the binary does so from `[auth]` config).
    #[must_use]
    pub fn skeleton() -> Self {
        Self {
            gate: Arc::new(crate::auth::Unconfigured),
            catalog: Arc::new(catalog::Unconfigured),
            backend: Arc::new(chat::NotImplemented),
            settler: Arc::new(settle::LogSettler),
        }
    }
}

/// Why [`Gateway::run_until`] returned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stopped {
    /// The signal fired and the drain ran.
    Drained(DrainReport),
    /// A listener task ended on its own. Exit non-zero: a gateway that has
    /// silently stopped accepting must restart, not idle as "healthy".
    TaskEnded(&'static str),
}

/// What the drain did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DrainReport {
    /// Calls in flight when the drain began.
    pub in_flight_at_start: usize,
    /// Whether every call finished inside the window.
    pub completed_in_window: bool,
    /// Calls still in flight when the window closed, and so aborted.
    pub aborted: usize,
    /// Signal to return.
    pub elapsed: Duration,
}

/// State shared by the admin handlers.
#[derive(Clone)]
struct Shared {
    inflight: Arc<InFlight>,
    catalog: Arc<catalog::State>,
    metrics: Arc<Metrics>,
}

impl Shared {
    fn ready(&self) -> Result<(), &'static str> {
        if self.inflight.draining() {
            return Err("draining");
        }
        if self.catalog.current(catalog::now_unix()).is_none() {
            return Err("no verified, unexpired catalogue");
        }
        Ok(())
    }
}

/// A bound, running gateway.
pub struct Gateway {
    public_addr: SocketAddr,
    admin_addr: SocketAddr,
    shared: Shared,
    config: Config,
    stop_public: watch::Sender<bool>,
    stop_admin: watch::Sender<bool>,
    stop_background: watch::Sender<bool>,
    public_task: JoinHandle<()>,
    admin_task: JoinHandle<()>,
    settler_task: JoinHandle<()>,
    catalog_task: JoinHandle<()>,
}

impl std::fmt::Debug for Gateway {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Gateway")
            .field("public_addr", &self.public_addr)
            .field("admin_addr", &self.admin_addr)
            .finish_non_exhaustive()
    }
}

impl Gateway {
    /// Bind both listeners and start serving.
    ///
    /// # Errors
    ///
    /// A listener could not be bound.
    pub async fn bind(config: &Config, deps: Deps) -> std::io::Result<Self> {
        let public = TcpListener::bind(config.listen).await?;
        let admin = TcpListener::bind(config.admin_listen).await?;
        let public_addr = public.local_addr()?;
        let admin_addr = admin.local_addr()?;

        let metrics = Arc::new(Metrics::default());
        let (settle_tx, settle_rx) = mpsc::unbounded_channel();
        let inflight = Arc::new(InFlight::new(
            config.max_concurrent_calls,
            config.retry_after_secs,
            settle_tx,
            Arc::clone(&metrics),
        ));
        let catalog_state = Arc::new(catalog::State::new(
            config.catalog_version_regression_bound.as_secs(),
        ));
        let shared = Shared {
            inflight: Arc::clone(&inflight),
            catalog: Arc::clone(&catalog_state),
            metrics: Arc::clone(&metrics),
        };

        let (stop_background, background_rx) = watch::channel(false);
        let settler_task = tokio::spawn(settle::run(
            deps.settler,
            Arc::clone(&metrics),
            settle_rx,
            background_rx.clone(),
        ));
        let catalog_task = tokio::spawn(catalog::poll(
            deps.catalog,
            Arc::clone(&catalog_state),
            Arc::clone(&metrics),
            config.catalog_poll,
            background_rx,
        ));

        let chat_state = ChatState {
            gate: deps.gate,
            backend: deps.backend,
            catalog: catalog_state,
            max_body_bytes: config.max_body_bytes,
            max_body_bytes_with_images: config.max_body_bytes_with_images,
            body_read_timeout: config.body_read_timeout,
            start_timeout: config.request_timeout,
            upload_budget: Arc::new(tokio::sync::Semaphore::new(
                config
                    .max_upload_buffer_bytes
                    .min(tokio::sync::Semaphore::MAX_PERMITS),
            )),
            retry_after_secs: config.retry_after_secs,
            metrics: Some(Arc::clone(&metrics)),
            delivery_buffer_bytes: config.delivery_buffer_bytes,
            delivery_stall: config.delivery_stall,
        };
        let public_router = public_router(chat_state, config, &inflight, &metrics);
        let admin_router = admin_router(shared.clone());

        let (stop_public, public_rx) = watch::channel(false);
        let (stop_admin, admin_rx) = watch::channel(false);
        let public_task = tokio::spawn(crate::serve::serve(
            public,
            public_router,
            crate::serve::Limits {
                connections: config.max_connections,
                header_read: config.header_read_timeout,
                write_stall: config.delivery_stall,
            },
            Some((Arc::clone(&metrics), crate::metrics::Listener::Public)),
            public_rx,
            config.abort_grace,
        ));
        let admin_task = tokio::spawn(crate::serve::serve(
            admin,
            admin_router,
            crate::serve::Limits {
                connections: config.max_admin_connections,
                header_read: config.header_read_timeout,
                write_stall: config.delivery_stall,
            },
            Some((Arc::clone(&metrics), crate::metrics::Listener::Admin)),
            admin_rx,
            Duration::from_secs(1),
        ));

        tracing::info!(
            public = %public_addr,
            admin = %admin_addr,
            max_concurrent_calls = config.max_concurrent_calls,
            drain_timeout_secs = config.drain_timeout.as_secs(),
            otel = config.otlp_endpoint.is_some(),
            "f2z-ai listening"
        );
        Ok(Self {
            public_addr,
            admin_addr,
            shared,
            config: config.clone(),
            stop_public,
            stop_admin,
            stop_background,
            public_task,
            admin_task,
            settler_task,
            catalog_task,
        })
    }

    /// The public listener's address.
    #[must_use]
    pub const fn public_addr(&self) -> SocketAddr {
        self.public_addr
    }

    /// The admin listener's address.
    #[must_use]
    pub const fn admin_addr(&self) -> SocketAddr {
        self.admin_addr
    }

    /// Serve until `signal` fires (then drain) or a listener task ends.
    pub async fn run_until(mut self, signal: impl Future<Output = ()>) -> Stopped {
        let signal = std::pin::pin!(signal);
        let ended = tokio::select! {
            () = signal => None,
            _ = &mut self.public_task => Some("public listener"),
            _ = &mut self.admin_task => Some("admin listener"),
        };
        if let Some(name) = ended {
            tracing::error!(task = name, "a listener task ended while serving");
            self.stop_everything().await;
            return Stopped::TaskEnded(name);
        }
        Stopped::Drained(self.drain().await)
    }

    async fn drain(self) -> DrainReport {
        let started = Instant::now();
        let inflight = Arc::clone(&self.shared.inflight);
        inflight.start_draining();
        let in_flight_at_start = inflight.active();
        tracing::info!(
            in_flight = in_flight_at_start,
            window_secs = self.config.drain_timeout.as_secs(),
            "drain started: readiness is now 503 and new calls are refused"
        );

        let completed_in_window =
            tokio::time::timeout(self.config.drain_timeout, inflight.wait_idle())
                .await
                .is_ok();
        let mut aborted = 0;
        if !completed_in_window {
            aborted = inflight.active();
            tracing::warn!(
                aborted,
                "drain window closed with calls in flight; aborting them and handing them to \
                 the settler"
            );
            inflight.abort_all();
            let _ = tokio::time::timeout(self.config.abort_grace, inflight.wait_idle()).await;
        }

        // Stop accepting, close connections (graceful, then forced).
        self.stop_public.send_replace(true);
        let mut public_task = self.public_task;
        if tokio::time::timeout(
            self.config
                .abort_grace
                .saturating_add(Duration::from_secs(1)),
            &mut public_task,
        )
        .await
        .is_err()
        {
            public_task.abort();
        }

        // Every started call's settlement is now queued or done: finish them.
        self.stop_background.send_replace(true);
        let mut settler_task = self.settler_task;
        if tokio::time::timeout(self.config.settle_grace, &mut settler_task)
            .await
            .is_err()
        {
            tracing::error!("the settler did not finish within settle_grace");
            settler_task.abort();
        }
        let mut catalog_task = self.catalog_task;
        if tokio::time::timeout(Duration::from_secs(1), &mut catalog_task)
            .await
            .is_err()
        {
            catalog_task.abort();
        }

        self.stop_admin.send_replace(true);
        let _ = self.admin_task.await;

        let report = DrainReport {
            in_flight_at_start,
            completed_in_window,
            aborted,
            elapsed: started.elapsed(),
        };
        tracing::info!(
            in_flight_at_start,
            completed_in_window,
            aborted,
            elapsed_ms = u64::try_from(report.elapsed.as_millis()).unwrap_or(u64::MAX),
            "drain finished"
        );
        report
    }

    async fn stop_everything(self) {
        self.shared.inflight.start_draining();
        self.stop_public.send_replace(true);
        self.stop_admin.send_replace(true);
        self.stop_background.send_replace(true);
        self.public_task.abort();
        self.admin_task.abort();
        let _ = tokio::time::timeout(self.config.settle_grace, self.settler_task).await;
        self.catalog_task.abort();
    }
}

fn public_router(
    chat_state: ChatState,
    config: &Config,
    inflight: &Arc<InFlight>,
    metrics: &Arc<Metrics>,
) -> Router {
    let stack = ServiceBuilder::new()
        .layer(ObserveLayer {
            metrics: Arc::clone(metrics),
        })
        .layer(AdmissionLayer::new(Arc::clone(inflight)))
        .layer(HandleErrorLayer::new(|_: axum::BoxError| async {
            ApiFailure::new(
                ErrorCode::Internal,
                "the gateway did not produce a response within its request timeout",
            )
        }))
        // A backstop only, strictly later than the call task's own deadline
        // (`call::run`), which is what answers a slow start. If this fired
        // first, a client could get a `500` for a call that then started.
        .timeout(
            config
                .request_timeout
                .saturating_add(TIMEOUT_BACKSTOP_MARGIN),
        );
    Router::new()
        .route("/v1/chat", post(chat::handle))
        .fallback(not_found)
        .with_state(chat_state)
        .layer(stack)
}

async fn not_found() -> ApiFailure {
    ApiFailure::not_found()
}

fn admin_router(shared: Shared) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/metrics", get(metrics_handler))
        .with_state(shared)
}

/// Liveness: constant, cheap, no numbers. A draining gateway is still alive —
/// failing liveness during a drain would get it killed mid-stream.
async fn healthz() -> &'static str {
    "ok\n"
}

async fn readyz(State(shared): State<Shared>) -> Response<Body> {
    match shared.ready() {
        Ok(()) => (StatusCode::OK, "ready\n").into_response(),
        Err(reason) => (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("not ready: {reason}\n"),
        )
            .into_response(),
    }
}

async fn metrics_handler(State(shared): State<Shared>) -> Response<Body> {
    let text = shared.metrics.render(Gauges {
        active_streams: shared.inflight.active(),
        buffered_bytes: shared.inflight.buffered_bytes(),
        ready: shared.ready().is_ok(),
        draining: shared.inflight.draining(),
    });
    let mut response = text.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
    );
    response
}

/// The method as a label from a closed set. HTTP allows extension methods —
/// any token a client likes — so the raw method is client-controlled text and
/// never reaches a log line or a span.
fn method_label(method: &axum::http::Method) -> &'static str {
    use axum::http::Method;
    match *method {
        Method::GET => "GET",
        Method::POST => "POST",
        Method::HEAD => "HEAD",
        Method::PUT => "PUT",
        Method::DELETE => "DELETE",
        Method::OPTIONS => "OPTIONS",
        Method::PATCH => "PATCH",
        _ => "other",
    }
}

/// Span + log line + metrics sample per public request.
#[derive(Clone)]
struct ObserveLayer {
    metrics: Arc<Metrics>,
}

impl<S> Layer<S> for ObserveLayer {
    type Service = Observe<S>;

    fn layer(&self, inner: S) -> Self::Service {
        Observe {
            inner,
            metrics: Arc::clone(&self.metrics),
        }
    }
}

#[derive(Clone)]
struct Observe<S> {
    inner: S,
    metrics: Arc<Metrics>,
}

impl<S> Service<Request<Body>> for Observe<S>
where
    S: Service<Request<Body>, Response = Response<Body>> + Send + 'static,
    S::Future: Send + 'static,
    S::Error: Send + 'static,
{
    type Response = Response<Body>;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Response<Body>, S::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, request: Request<Body>) -> Self::Future {
        let route = Route::of(request.uri().path());
        let route_label = match route {
            Route::Chat => "chat",
            Route::Other => "other",
        };
        let span = tracing::info_span!(
            "request",
            route = route_label,
            method = method_label(request.method()),
            status = tracing::field::Empty,
        );
        let started = Instant::now();
        let metrics = Arc::clone(&self.metrics);
        let future = self.inner.call(request);
        Box::pin(
            async move {
                let response = future.await?;
                let status = response.status().as_u16();
                let elapsed = started.elapsed();
                metrics.record_request(route, status, elapsed);
                tracing::Span::current().record("status", status);
                tracing::info!(
                    route = route_label,
                    status,
                    elapsed_us = u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX),
                    "response"
                );
                Ok(response)
            }
            .instrument(span),
        )
    }
}
