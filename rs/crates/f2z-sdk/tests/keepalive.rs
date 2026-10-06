//! zuu#1163: the gateway's `: ping` keep-alive comments (chat-api.md §3)
//! reset the SSE client's idle watchdog and never surface as events — and
//! without them, a model that is silent for longer than the watchdog before
//! `meta` loses its client while the call is still charged. Against the fake
//! gateway, on a paused clock: the silences are 50 s of virtual time.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod support;

use std::sync::Arc;
use std::time::Duration;

use f2z_sdk::proto::event::Event;
use f2z_sdk::{Client, Error, MemoryStore, SignInOptions};
use support::{Fake, ScriptedBrowser, chat_request};

fn names(events: &[Event]) -> Vec<&'static str> {
    events.iter().map(Event::name).collect()
}

async fn drain(stream: &mut f2z_sdk::ai::ChatStream) -> (Vec<Event>, Option<Error>) {
    let mut events = Vec::new();
    loop {
        match stream.next().await {
            Ok(Some(e)) => events.push(e),
            Ok(None) => return (events, None),
            Err(e) => return (events, Some(e)),
        }
    }
}

fn calls_for(fake: &Fake, model: &str) -> usize {
    fake.chat_calls().iter().filter(|(m, _)| m == model).count()
}

/// Drive a paused clock by hand: 50 ms of virtual time per ~0.5 ms of real
/// time. Tokio's auto-advance jumps the clock whenever the runtime idles —
/// including while the kernel is still delivering a loopback write — so it
/// would fire the very timeouts under test spuriously. This task is always
/// runnable, so the clock moves only here.
fn drive_clock() -> tokio::task::JoinHandle<()> {
    tokio::spawn(async {
        loop {
            std::thread::sleep(Duration::from_micros(500));
            tokio::time::advance(Duration::from_millis(50)).await;
        }
    })
}

/// A client with the TypeScript SDK's 45 s idle watchdog.
async fn watchdog_45s(fake: &Fake) -> Client {
    let config = fake
        .config()
        .with_stream_idle_timeout(Duration::from_secs(45));
    let client = Client::new(config, Arc::new(MemoryStore::new())).unwrap();
    client
        .sign_in(
            &ScriptedBrowser::new("com.example.tutor:/oauth/callback"),
            SignInOptions::default(),
        )
        .await
        .unwrap();
    client
}

// A model silent for 50 s before `meta`: the pings reset the watchdog and
// never surface as events.
#[tokio::test(start_paused = true)]
async fn pings_keep_a_stream_alive_through_a_silence_longer_than_the_idle_limit() {
    let clock = drive_clock();
    let fake = Fake::start().await;
    let ai = watchdog_45s(&fake).await.ai();
    let started = tokio::time::Instant::now();
    let mut stream = ai.chat(chat_request("thinking")).await.unwrap();
    let (events, err) = drain(&mut stream).await;
    assert!(err.is_none(), "{err:?}");
    assert!(started.elapsed() >= Duration::from_secs(50));
    assert_eq!(names(&events), ["meta", "delta", "delta", "usage", "done"]);
    assert_eq!(calls_for(&fake, "thinking"), 1);
    clock.abort();
}

// The negative control: the same silence without pings is a dead connection
// to the SDK — while the call it abandoned was still charged.
#[tokio::test(start_paused = true)]
async fn without_pings_the_same_silence_drops_the_stream() {
    let clock = drive_clock();
    let fake = Fake::start().await;
    let ai = watchdog_45s(&fake).await.ai();
    let started = tokio::time::Instant::now();
    let mut stream = ai.chat(chat_request("thinking-silent")).await.unwrap();
    let (events, err) = drain(&mut stream).await;
    assert!(events.is_empty(), "{events:?}");
    let Some(Error::StreamInterrupted {
        call_id: Some(call_id),
    }) = err
    else {
        panic!("{err:?}")
    };
    let waited = started.elapsed();
    assert!(
        waited >= Duration::from_secs(45) && waited < Duration::from_secs(50),
        "{waited:?}"
    );
    assert_eq!(calls_for(&fake, "thinking-silent"), 1, "never retried");
    assert!(ai.call(&call_id).await.unwrap().charge().is_final());
    clock.abort();
}
