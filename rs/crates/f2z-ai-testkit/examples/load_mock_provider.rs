//! A small load harness: ramped connects, N concurrent streams, a report.
//!
//! ```text
//! cargo run --release -p f2z-ai-testkit --example load_mock_provider -- \
//!     --streams 2000 --ramp 500 --tokens 1000 --tps 50 --min-concurrency 1500
//! ```
//!
//! **Concurrency is reached only if streams outlast the ramp.** A stream
//! lasts about `ttfb + tokens / tps`; `--streams N` at `--ramp R` connects/s
//! holds at most `R × stream length` open at once. The report prints the
//! peak actually reached, and `--min-concurrency C` fails the run when it
//! falls short, so a run cannot pass as "N concurrent" without being so.
//!
//! With no `--url` it starts a [`MockProvider`] in-process and drives it; with
//! `--url http://host:port` it drives an **out-of-process provider-shaped**
//! target instead — typically a mock on another host, so the driver and the
//! target do not compete for one CPU. It speaks the provider routes
//! (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`), **not** the
//! gateway's `/v1/chat`: driving the gateway needs its request shape,
//! authentication and `done` event, and is a mode to add once `f2z-ai`
//! exists. This is the skeleton the 10k-concurrent-stream test of epic #1047
//! grows from.
//!
//! Options (all optional): `--streams N` (default 200), `--ramp R` new
//! connections per second (default 100), `--tokens T` output tokens per
//! stream (64), `--tps S` tokens per second per stream (50), `--ttfb-ms M`
//! (150), `--style chat|responses|anthropic` (chat), `--url URL`,
//! `--min-concurrency C` (0, i.e. not enforced),
//! `--timeout-s S` per-stream deadline (120; a stream past it is a failure,
//! so one stalled connection cannot hold back the report).
//!
//! **Ramp the connects.** A burst of thousands of simultaneous connects
//! overflows the kernel's accept queue: the mock listens with a backlog of
//! 4 096, but macOS caps every backlog at `kern.ipc.somaxconn` (128 by
//! default) and Linux at `net.core.somaxconn`. Overflowed connects are
//! retried by the client's TCP stack with seconds of backoff and show up here
//! as enormous TTFBs, which is the host, not the code under test.
//!
//! **Run heavy loads from another host**, or read
//! [`MockProvider::backpressured_writes`] with a tolerance: on a
//! CPU-saturated machine the reader falls behind because it is starved, not
//! because it applies backpressure.

// A load-test driver's arithmetic is over counters and durations it owns;
// the workspace's panic-free lints exist for the relay's parser.
#![allow(clippy::arithmetic_side_effects, clippy::indexing_slicing)]

use core::time::Duration;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use f2z_ai_testkit::mock::{MockProvider, ProviderStyle, Scenario};
use serde_json::json;

struct Args {
    streams: usize,
    ramp: u32,
    tokens: u64,
    tps: u32,
    ttfb_ms: u64,
    style: ProviderStyle,
    url: Option<String>,
    timeout_s: u64,
    min_concurrency: usize,
}

fn parse() -> Result<Args, String> {
    let mut a = Args {
        streams: 200,
        ramp: 100,
        tokens: 64,
        tps: 50,
        ttfb_ms: 150,
        style: ProviderStyle::ChatCompletions,
        url: None,
        timeout_s: 120,
        min_concurrency: 0,
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let v = it.next().ok_or_else(|| format!("{flag} needs a value"))?;
        let num = |v: &str| v.parse::<u64>().map_err(|e| format!("{flag}: {e}"));
        match flag.as_str() {
            "--streams" => a.streams = usize::try_from(num(&v)?).map_err(|e| e.to_string())?,
            "--ramp" => a.ramp = u32::try_from(num(&v)?).map_err(|e| e.to_string())?.max(1),
            "--tokens" => a.tokens = num(&v)?,
            "--tps" => a.tps = u32::try_from(num(&v)?).map_err(|e| e.to_string())?,
            "--ttfb-ms" => a.ttfb_ms = num(&v)?,
            "--style" => {
                a.style = match v.as_str() {
                    "chat" => ProviderStyle::ChatCompletions,
                    "responses" => ProviderStyle::OpenAiResponses,
                    "anthropic" => ProviderStyle::AnthropicMessages,
                    other => return Err(format!("unknown --style {other}")),
                }
            }
            "--url" => a.url = Some(v),
            "--timeout-s" => a.timeout_s = num(&v)?.max(1),
            "--min-concurrency" => {
                a.min_concurrency = usize::try_from(num(&v)?).map_err(|e| e.to_string())?
            }
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok(a)
}

/// What the last frame of a complete stream of `style` starts with.
fn terminal_prefix(style: ProviderStyle) -> &'static [u8] {
    match style {
        ProviderStyle::ChatCompletions => b"data: [DONE]\n\n",
        ProviderStyle::OpenAiResponses => b"event: response.completed\ndata: {",
        ProviderStyle::AnthropicMessages => b"event: message_stop\ndata: {",
    }
}

/// Bounded-memory completion check: remembers only the first bytes of the
/// current and last complete SSE frame and the last three bytes seen, so a
/// long stream costs a few hundred bytes however long it is.
#[derive(Default)]
struct Completion {
    current: Vec<u8>,
    last_frame: Vec<u8>,
    tail: [u8; 3],
    at_boundary: bool,
    closed_json: bool,
}

impl Completion {
    const PREFIX: usize = 64;

    fn feed(&mut self, bytes: &[u8]) {
        // `\r` is dropped, so CRLF-framed SSE (valid per the spec) completes
        // exactly as LF-framed SSE does.
        for &b in bytes.iter().filter(|b| **b != b'\r') {
            if self.current.len() < Self::PREFIX {
                self.current.push(b);
            }
            self.tail = [self.tail[1], self.tail[2], b];
            self.at_boundary = self.tail[1] == b'\n' && b == b'\n';
            if self.at_boundary {
                self.closed_json = self.tail[0] == b'}';
                self.last_frame = std::mem::take(&mut self.current);
                // A following '\n' must not count as another boundary.
                self.tail = [0, 0, 0];
            }
        }
    }

    /// The body ended exactly on a frame boundary, the last frame is the
    /// style's terminal event, and (for JSON payloads) that frame's data
    /// closed its object.
    fn complete(&self, style: ProviderStyle) -> bool {
        let prefix = terminal_prefix(style);
        let json_closed = style == ProviderStyle::ChatCompletions || self.closed_json;
        self.at_boundary && self.last_frame.starts_with(prefix) && json_closed
    }
}

struct Sample {
    ok: bool,
    ttfb: Duration,
    total: Duration,
}

/// In-flight streams, and the most seen at once.
#[derive(Default)]
struct Gauge {
    now: AtomicUsize,
    peak: AtomicUsize,
}

/// Holds one slot of the gauge for the life of a stream.
struct InFlight(Arc<Gauge>);

impl InFlight {
    fn new(g: &Arc<Gauge>) -> Self {
        let n = g.now.fetch_add(1, Ordering::Relaxed) + 1;
        g.peak.fetch_max(n, Ordering::Relaxed);
        Self(Arc::clone(g))
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.now.fetch_sub(1, Ordering::Relaxed);
    }
}

async fn one(
    client: reqwest::Client,
    url: String,
    body: String,
    style: ProviderStyle,
    gauge: Arc<Gauge>,
) -> Sample {
    let t0 = Instant::now();
    // Counted as concurrent only once body bytes flow: a request queued
    // before its headers, or waiting for them, is not a stream in progress.
    let mut slot = None;
    let fail = |t0: Instant| Sample {
        ok: false,
        ttfb: t0.elapsed(),
        total: t0.elapsed(),
    };
    let Ok(mut resp) = client
        .post(url)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
    else {
        return fail(t0);
    };
    if !resp.status().is_success() {
        return fail(t0);
    }
    let mut ttfb = None;
    let mut done = Completion::default();
    loop {
        match resp.chunk().await {
            Ok(Some(c)) => {
                ttfb.get_or_insert_with(|| t0.elapsed());
                slot.get_or_insert_with(|| InFlight::new(&gauge));
                done.feed(&c);
            }
            Ok(None) => break,
            Err(_) => return fail(t0),
        }
    }
    let ok = done.complete(style);
    Sample {
        ok,
        ttfb: ttfb.unwrap_or_else(|| t0.elapsed()),
        total: t0.elapsed(),
    }
}

fn pct(sorted: &[Duration], p: usize) -> Duration {
    if sorted.is_empty() {
        return Duration::ZERO;
    }
    sorted[(sorted.len() - 1) * p / 100]
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse()?;
    let mock = match args.url {
        Some(_) => None,
        None => Some(Arc::new(
            MockProvider::start(
                Scenario::default()
                    .with_output_tokens(args.tokens)
                    .with_tokens_per_sec(args.tps)
                    .with_ttfb(Duration::from_millis(args.ttfb_ms)),
            )
            .await?,
        )),
    };
    let base = match (&args.url, &mock) {
        (Some(u), _) => u.trim_end_matches('/').to_owned(),
        (None, Some(m)) => m.base_url(),
        (None, None) => return Err("no target".into()),
    };
    let url = format!("{base}{}", args.style.path());
    let body = json!({
        "model": "load-test", "stream": true, "max_tokens": args.tokens,
        "stream_options": {"include_usage": true},
        "messages": [{"role": "user", "content": "hello"}],
        "input": "hello",
    })
    .to_string();
    // One connection per stream, as distinct gateway clients would have.
    let client = reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .timeout(Duration::from_secs(args.timeout_s))
        .build()?;

    let started = Instant::now();
    let gap = Duration::from_secs(1) / args.ramp;
    let gauge = Arc::new(Gauge::default());
    let mut tasks = Vec::with_capacity(args.streams);
    for i in 0..args.streams {
        let due = started + gap * u32::try_from(i).unwrap_or(u32::MAX);
        tokio::time::sleep_until(due.into()).await;
        tasks.push(tokio::spawn(one(
            client.clone(),
            url.clone(),
            body.clone(),
            args.style,
            Arc::clone(&gauge),
        )));
    }
    let mut samples = Vec::with_capacity(tasks.len());
    for t in tasks {
        if let Ok(s) = t.await {
            samples.push(s);
        }
    }
    let wall = started.elapsed();

    let ok = samples.iter().filter(|s| s.ok).count();
    let mut ttfb: Vec<Duration> = samples.iter().filter(|s| s.ok).map(|s| s.ttfb).collect();
    let mut total: Vec<Duration> = samples.iter().filter(|s| s.ok).map(|s| s.total).collect();
    ttfb.sort_unstable();
    total.sort_unstable();
    println!("target        {url}");
    println!(
        "streams       {} started, {ok} complete, {} failed",
        args.streams,
        args.streams - ok
    );
    let peak = gauge.peak.load(Ordering::Relaxed);
    println!("wall          {wall:.2?} (ramp {} connects/s)", args.ramp);
    println!("concurrency   peak {peak} streams receiving body bytes at once");
    for (name, v) in [("ttfb", &ttfb), ("stream", &total)] {
        println!(
            "{name:<13} p50 {:>9.1?}  p90 {:>9.1?}  p99 {:>9.1?}  max {:>9.1?}",
            pct(v, 50),
            pct(v, 90),
            pct(v, 99),
            v.last().copied().unwrap_or_default()
        );
    }
    if let Some(m) = &mock {
        println!(
            "mock          {} requests, {} backpressured writes",
            m.request_count(),
            m.backpressured_writes()
        );
    }
    if peak < args.min_concurrency {
        return Err(format!(
            "peak concurrency {peak} < --min-concurrency {}: raise --ramp or lengthen streams",
            args.min_concurrency
        )
        .into());
    }
    if ok != args.streams {
        return Err(format!("{} of {} streams failed", args.streams - ok, args.streams).into());
    }
    Ok(())
}
