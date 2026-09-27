//! A small load harness: ramped connects, N concurrent streams, a report.
//!
//! ```text
//! cargo run --release -p f2z-ai-testkit --example load_mock_provider -- \
//!     --streams 2000 --ramp 200 --tokens 64 --tps 50 --style chat
//! ```
//!
//! With no `--url` it starts a [`MockProvider`] in-process and drives it; with
//! `--url http://gateway:port` it drives that instead (point the gateway's
//! provider base URL at a mock), so the same run measures the gateway and the
//! in-process run is the baseline that tells the two apart. This is the
//! skeleton the 10k-concurrent-stream test of epic #1047 grows from.
//!
//! Options (all optional): `--streams N` (default 200), `--ramp R` new
//! connections per second (default 100), `--tokens T` output tokens per
//! stream (64), `--tps S` tokens per second per stream (50), `--ttfb-ms M`
//! (150), `--style chat|responses|anthropic` (chat), `--url URL`.
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
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok(a)
}

/// The marker a complete stream of `style` contains.
fn complete_marker(style: ProviderStyle) -> &'static str {
    match style {
        ProviderStyle::ChatCompletions => "data: [DONE]\n\n",
        ProviderStyle::OpenAiResponses => "event: response.completed\n",
        ProviderStyle::AnthropicMessages => "event: message_stop\n",
    }
}

struct Sample {
    ok: bool,
    ttfb: Duration,
    total: Duration,
}

async fn one(client: reqwest::Client, url: String, body: String, style: ProviderStyle) -> Sample {
    let t0 = Instant::now();
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
    let mut got = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(c)) => {
                ttfb.get_or_insert_with(|| t0.elapsed());
                got.extend_from_slice(&c);
            }
            Ok(None) => break,
            Err(_) => return fail(t0),
        }
    }
    let ok = String::from_utf8_lossy(&got).contains(complete_marker(style));
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
        .build()?;

    let started = Instant::now();
    let gap = Duration::from_secs(1) / args.ramp;
    let mut tasks = Vec::with_capacity(args.streams);
    for i in 0..args.streams {
        let due = started + gap * u32::try_from(i).unwrap_or(u32::MAX);
        tokio::time::sleep_until(due.into()).await;
        tasks.push(tokio::spawn(one(
            client.clone(),
            url.clone(),
            body.clone(),
            args.style,
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
    println!("wall          {wall:.2?} (ramp {} connects/s)", args.ramp);
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
    if ok != args.streams {
        return Err(format!("{} of {} streams failed", args.streams - ok, args.streams).into());
    }
    Ok(())
}
