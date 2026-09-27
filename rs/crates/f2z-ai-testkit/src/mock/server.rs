//! The loopback HTTP server that plays a [`Plan`] with real pauses.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use serde_json::Value;
use tokio::net::{TcpListener, TcpSocket};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::render::{Plan, RenderContext, plan};
use super::{ProviderStyle, Scenario};

/// Request header naming a scenario registered with
/// [`MockProvider::insert_scenario`]. Without it the default scenario is used,
/// so one server can serve a mixed workload (a load test) or several tests at
/// once without them racing on [`MockProvider::set_scenario`].
pub const SCENARIO_HEADER: &str = "x-f2z-mock-scenario";

/// How many requests [`MockProvider::recorded_requests`] keeps. Bounded so a
/// long load run cannot grow without limit; [`MockProvider::request_count`]
/// counts every request.
const RECORD_LIMIT: usize = 1_024;

/// Bodies larger than this are recorded by length only, so a long-context
/// load run cannot turn the request log into the thing that runs out of
/// memory: at most `RECORD_LIMIT × RECORD_BODY_LIMIT` = 64 MiB of bodies.
const RECORD_BODY_LIMIT: usize = 64 * 1024;

/// The listen backlog requested; the kernel may cap it lower.
const LISTEN_BACKLOG: u32 = 4_096;

/// How long a due write must wait on a full body buffer before it counts as
/// the reader applying backpressure ([`MockProvider::backpressured_writes`]).
const BACKPRESSURE_THRESHOLD: core::time::Duration = core::time::Duration::from_millis(25);

/// Pause between the last byte of a [`super::Fault::DisconnectAtByte`]
/// stream and the abort, so the prefix is flushed to the socket.
const ABORT_FLUSH_GRACE: core::time::Duration = core::time::Duration::from_millis(50);

/// One request the mock received.
#[derive(Clone, Debug, PartialEq)]
pub struct RecordedRequest {
    /// Which route it arrived on.
    pub style: ProviderStyle,
    /// The value of [`SCENARIO_HEADER`], if sent.
    pub scenario: Option<String>,
    /// The parsed JSON body; `Value::Null` if it did not parse or was over
    /// 64 KiB (recorded by length only).
    pub body: Value,
    /// The body's length in bytes.
    pub body_len: usize,
}

struct Shared {
    default: RwLock<Scenario>,
    named: RwLock<HashMap<String, Scenario>>,
    seq: AtomicU64,
    backpressured: AtomicU64,
    active: AtomicU64,
    log: Mutex<VecDeque<RecordedRequest>>,
}

/// A running mock provider on `127.0.0.1:<ephemeral>`.
///
/// Dropping it without [`MockProvider::shutdown`] aborts the accept loop;
/// streams already in flight run to their end.
pub struct MockProvider {
    addr: SocketAddr,
    shared: Arc<Shared>,
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl MockProvider {
    /// Bind a loopback port and serve `default` to every request that does not
    /// name another scenario.
    ///
    /// # Errors
    ///
    /// The bind failed.
    pub async fn start(default: Scenario) -> io::Result<Self> {
        // A deep accept queue: a load test opens thousands of connections,
        // and the default backlog would refuse most of a burst. The kernel
        // still caps it (macOS `kern.ipc.somaxconn`, 128 by default; Linux
        // `net.core.somaxconn`), so a load test must also ramp its connects.
        let socket = TcpSocket::new_v4()?;
        socket.bind(SocketAddr::from(([127, 0, 0, 1], 0)))?;
        let listener: TcpListener = socket.listen(LISTEN_BACKLOG)?;
        let addr = listener.local_addr()?;
        let shared = Arc::new(Shared {
            default: RwLock::new(default),
            named: RwLock::new(HashMap::new()),
            seq: AtomicU64::new(0),
            backpressured: AtomicU64::new(0),
            active: AtomicU64::new(0),
            log: Mutex::new(VecDeque::new()),
        });
        let app = Router::new()
            .route(
                ProviderStyle::OpenAiResponses.path(),
                post(|s: State<Arc<Shared>>, h: HeaderMap, b: Bytes| {
                    handle(ProviderStyle::OpenAiResponses, s, h, b)
                }),
            )
            .route(
                ProviderStyle::ChatCompletions.path(),
                post(|s: State<Arc<Shared>>, h: HeaderMap, b: Bytes| {
                    handle(ProviderStyle::ChatCompletions, s, h, b)
                }),
            )
            .route(
                ProviderStyle::AnthropicMessages.path(),
                post(|s: State<Arc<Shared>>, h: HeaderMap, b: Bytes| {
                    handle(ProviderStyle::AnthropicMessages, s, h, b)
                }),
            )
            .with_state(Arc::clone(&shared));
        let (stop, stopped) = oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await;
        });
        Ok(Self {
            addr,
            shared,
            stop: Some(stop),
            task: Some(task),
        })
    }

    /// The bound address.
    #[must_use]
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// `http://127.0.0.1:<port>` — the provider base URL to configure; routes
    /// are appended to it (see the module table).
    #[must_use]
    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Replace the default scenario for subsequent requests.
    pub fn set_scenario(&self, scenario: Scenario) {
        *self
            .shared
            .default
            .write()
            .unwrap_or_else(PoisonError::into_inner) = scenario;
    }

    /// Register a scenario that a request selects with [`SCENARIO_HEADER`].
    pub fn insert_scenario(&self, name: impl Into<String>, scenario: Scenario) {
        self.shared
            .named
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(name.into(), scenario);
    }

    /// Every request received so far, including refused ones.
    #[must_use]
    pub fn request_count(&self) -> u64 {
        self.shared.seq.load(Ordering::Relaxed)
    }

    /// Streams whose producer is still running. It drops as each stream
    /// finishes or its client goes away (including mid-stall), so a test can
    /// assert that nothing outlives its client.
    #[must_use]
    pub fn active_streams(&self) -> u64 {
        self.shared.active.load(Ordering::Relaxed)
    }

    /// How many writes of a **paced** stream (one with
    /// [`Scenario::tokens_per_sec`]) found the reader not keeping up: the
    /// write was due but the response body's buffer stayed full for at least
    /// 25 ms, so the mock fell behind its own schedule. `0` after a run means
    /// every paced stream was read at provider speed. Unpaced streams are
    /// never counted — they have no provider speed.
    ///
    /// This is the probe for the gateway's drain rule (chat-api.md: upstream
    /// is read at provider speed regardless of client backpressure). A slow
    /// *client* of a correct gateway never shows up here; a gateway that
    /// forwards its client's backpressure upstream does — once its socket and
    /// this mock's small body buffer (8 frames) are full, so give the probe a
    /// stream long enough to fill them, and a client that stops reading.
    ///
    /// **Unreliable on a CPU-saturated host.** A reader starved of CPU falls
    /// behind without applying any backpressure of its own, and is counted
    /// all the same. Run a heavy load from a separate host, or compare against
    /// a tolerance measured on an idle run, never against a hard `0`.
    #[must_use]
    pub fn backpressured_writes(&self) -> u64 {
        self.shared.backpressured.load(Ordering::Relaxed)
    }

    /// The most recent requests (at most 1 024), oldest first.
    #[must_use]
    pub fn recorded_requests(&self) -> Vec<RecordedRequest> {
        self.shared
            .log
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .cloned()
            .collect()
    }

    /// Stop accepting connections and wait for in-flight streams to finish.
    pub async fn shutdown(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for MockProvider {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn handle(
    style: ProviderStyle,
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let request_seq = shared.seq.fetch_add(1, Ordering::Relaxed);
    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let name = headers
        .get(SCENARIO_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    {
        let mut log = shared.log.lock().unwrap_or_else(PoisonError::into_inner);
        if log.len() >= RECORD_LIMIT {
            log.pop_front();
        }
        log.push_back(RecordedRequest {
            style,
            scenario: name.clone(),
            body: if body.len() <= RECORD_BODY_LIMIT {
                parsed.clone()
            } else {
                Value::Null
            },
            body_len: body.len(),
        });
    }

    let scenario = match &name {
        None => Some(
            shared
                .default
                .read()
                .unwrap_or_else(PoisonError::into_inner)
                .clone(),
        ),
        Some(n) => shared
            .named
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(n)
            .cloned(),
    };
    let Some(scenario) = scenario else {
        return bad_request("unknown mock scenario named in x-f2z-mock-scenario");
    };
    if parsed.get("stream").and_then(Value::as_bool) != Some(true) {
        return bad_request("the mock provider serves streaming requests only (\"stream\": true)");
    }
    let include_usage = parsed
        .pointer("/stream_options/include_usage")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let model = scenario
        .model
        .clone()
        .or_else(|| {
            parsed
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "mock-model".to_owned());
    let ctx = RenderContext {
        model,
        include_usage,
        request_seq,
    };
    let plan = plan(style, &scenario, &ctx);

    if !scenario.ttfb.is_zero() {
        tokio::time::sleep(scenario.ttfb).await;
    }

    match plan {
        Plan::Status {
            status,
            retry_after,
            body,
        } => {
            let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            let mut resp = (code, body).into_response();
            let h = resp.headers_mut();
            h.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            if let Some(secs) = retry_after {
                h.insert(header::RETRY_AFTER, HeaderValue::from(secs));
            }
            resp
        }
        Plan::Stream(stream) => {
            let (tx, rx) = mpsc::channel::<Result<Bytes, io::Error>>(8);
            let probe = Arc::clone(&shared);
            // Unpaced, the mock is always faster than its reader; only a paced
            // stream has a provider speed to fall behind.
            let paced = scenario.tokens_per_sec.is_some();
            probe.active.fetch_add(1, Ordering::Relaxed);
            tokio::spawn(async move {
                let _active = ActiveGuard(Arc::clone(&probe));
                // Pace against an absolute schedule, not by sleeping each
                // delay: timers are millisecond-coarse, so per-step sleeps
                // would run a 5 000 tokens/s stream at under 1 000. Behind
                // schedule, frames go out back to back until it catches up.
                let mut due = tokio::time::Instant::now();
                // Frames are generated one at a time as they are written.
                let mut steps = stream.steps();
                for step in steps.by_ref() {
                    if !step.delay.is_zero() {
                        due = due.checked_add(step.delay).unwrap_or(due);
                        // A client that goes away mid-pause ends the stream
                        // now, not when a long stall would have expired.
                        tokio::select! {
                            () = tokio::time::sleep_until(due) => {}
                            () = tx.closed() => return,
                        }
                    }
                    let item = Ok(Bytes::from(step.bytes));
                    let item = match tx.try_send(item) {
                        Ok(()) => continue,
                        // The client went away; stop generating, as a real
                        // provider does when its request is aborted.
                        Err(mpsc::error::TrySendError::Closed(_)) => return,
                        Err(mpsc::error::TrySendError::Full(item)) => item,
                    };
                    // A full buffer alone is not backpressure: catching up
                    // after a coarse timer tick fills it for microseconds. A
                    // reader that holds it full for a while is — counted
                    // while still blocked, since a reader that never resumes
                    // would otherwise never be counted at all.
                    let permit =
                        match tokio::time::timeout(BACKPRESSURE_THRESHOLD, tx.reserve()).await {
                            Ok(Ok(permit)) => permit,
                            Ok(Err(_)) => return,
                            Err(_) => {
                                if paced {
                                    probe.backpressured.fetch_add(1, Ordering::Relaxed);
                                }
                                match tx.reserve().await {
                                    Ok(permit) => permit,
                                    Err(_) => return,
                                }
                            }
                        };
                    permit.send(item);
                }
                if steps.aborted() {
                    // Let hyper take every frame, then let the body go idle
                    // so it flushes them: an error on the very next poll
                    // tears the connection down with bytes still buffered,
                    // and the client would see fewer than `byte`. Exact only
                    // while the reader keeps up — under backpressure hyper
                    // may still hold part of the prefix when the error lands
                    // (see `Fault::DisconnectAtByte`).
                    while tx.capacity() < tx.max_capacity() {
                        if tx.is_closed() {
                            return;
                        }
                        tokio::time::sleep(core::time::Duration::from_millis(1)).await;
                    }
                    tokio::time::sleep(ABORT_FLUSH_GRACE).await;
                    let _ = tx
                        .send(Err(io::Error::new(
                            io::ErrorKind::ConnectionAborted,
                            "mock provider: injected disconnect",
                        )))
                        .await;
                }
            });
            let stream = futures_util::stream::unfold(rx, |mut rx| async move {
                rx.recv().await.map(|item| (item, rx))
            });
            let mut resp = Response::new(Body::from_stream(stream));
            let h = resp.headers_mut();
            h.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/event-stream; charset=utf-8"),
            );
            h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
            resp
        }
    }
}

/// Decrements the active-stream gauge however the producer exits.
struct ActiveGuard(Arc<Shared>);

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::Relaxed);
    }
}

fn bad_request(message: &'static str) -> Response {
    let body = serde_json::json!({"error": {"message": message, "type": "invalid_request_error"}});
    let mut resp = (StatusCode::BAD_REQUEST, body.to_string()).into_response();
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    resp
}
