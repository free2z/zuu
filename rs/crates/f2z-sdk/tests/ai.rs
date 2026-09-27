//! The `/v1/chat` SSE client against the fake gateway: the consumer rules of
//! `docs/sdk/spec/chat-api.md` §3 and `errors.md` §7.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod support;

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use f2z_sdk::ai::{CallStatus, Charge, ChatOptions};
use f2z_sdk::proto::event::Event;
use f2z_sdk::proto::settlement::NotFinal;
use f2z_sdk::proto::{ErrorCode, Whole2z};
use f2z_sdk::{Client, Error, MemoryStore, SignInOptions};
use support::{Fake, ScriptedBrowser, chat_request};

async fn signed_in(fake: &Fake) -> Client {
    let client = Client::new(fake.config(), Arc::new(MemoryStore::new())).unwrap();
    client
        .sign_in(
            &ScriptedBrowser::new("com.example.tutor:/oauth/callback"),
            SignInOptions::default(),
        )
        .await
        .unwrap();
    client
}

fn fast() -> ChatOptions {
    ChatOptions::default().with_retry_base_delay(Duration::from_millis(10))
}

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

fn keys_for(fake: &Fake, model: &str) -> Vec<String> {
    fake.chat_calls()
        .into_iter()
        .filter(|(m, _)| m == model)
        .map(|(_, k)| k)
        .collect()
}

#[tokio::test]
async fn a_settled_stream_skips_pings_and_unknown_events_and_reads_the_outcome() {
    for model in ["settled", "crlf"] {
        let fake = Fake::start().await;
        let ai = signed_in(&fake).await.ai();
        let mut stream = ai.chat(chat_request(model)).await.unwrap();
        let key = stream.idempotency_key().to_owned();
        let (events, err) = drain(&mut stream).await;
        assert!(err.is_none(), "{model}: {err:?}");
        assert_eq!(
            names(&events),
            ["meta", "delta", "delta", "usage", "done"],
            "{model}"
        );
        let Event::Done(done) = &events[4] else {
            panic!()
        };
        match Charge::from(done.outcome()) {
            Charge::Charged {
                charged_2z,
                receipt_id,
                ..
            } => {
                assert_eq!(charged_2z, Whole2z::new(1));
                assert_eq!(receipt_id, "rcpt_1");
            }
            other => panic!("{other:?}"),
        }
        assert!(stream.call_id().is_some());
        assert_eq!(keys_for(&fake, model), [key], "one call, one key");
        // After the terminal event the stream is over.
        assert!(stream.next().await.unwrap().is_none());
    }
}

#[tokio::test]
async fn collect_concatenates_the_deltas() {
    let fake = Fake::start().await;
    let done = signed_in(&fake)
        .await
        .ai()
        .complete(chat_request("settled"))
        .await
        .unwrap();
    assert_eq!(
        done.text,
        "Line 3 divides both sides by x, which is zero when x = 0."
    );
    assert_eq!(done.charge.charged_2z(), Some(Whole2z::new(1)));
    assert_eq!(done.usage.unwrap().usage.output_tokens, 342);
}

#[tokio::test]
async fn pending_and_released_outcomes_are_never_read_as_a_charge() {
    let fake = Fake::start().await;
    let ai = signed_in(&fake).await.ai();

    let pending = ai.complete(chat_request("pending")).await.unwrap();
    assert_eq!(pending.charge, Charge::NotFinal(NotFinal::Pending));
    assert_eq!(pending.charge.charged_2z(), None);
    // The record is the place to learn the final number.
    let record = ai
        .wait_for_call(pending.call_id.as_deref().unwrap(), Duration::ZERO)
        .await
        .unwrap();
    assert_eq!(record.status, CallStatus::Settling);
    assert!(!record.charge().is_final());

    let released = ai.complete(chat_request("released")).await.unwrap();
    assert_eq!(released.charge, Charge::NothingCharged);
}

/// A lone `error` before `meta`, uncharged: retried as a NEW call with a NEW
/// key, invisibly to the consumer.
#[tokio::test]
async fn an_uncharged_error_before_meta_is_retried_with_a_new_key() {
    let fake = Fake::start().await;
    let ai = signed_in(&fake).await.ai();
    let mut stream = ai
        .chat_with(chat_request("error-before-meta"), fast())
        .await
        .unwrap();
    let (events, err) = drain(&mut stream).await;
    assert!(err.is_none(), "{err:?}");
    assert_eq!(names(&events), ["meta", "delta", "delta", "usage", "done"]);
    let keys = keys_for(&fake, "error-before-meta");
    assert_eq!(keys.len(), 2);
    assert_ne!(keys[0], keys[1], "a retry is a new call, with a new key");
}

#[tokio::test]
async fn retries_are_bounded_and_then_the_error_is_delivered() {
    let fake = Fake::start().await;
    fake.fail_first.store(100, Ordering::SeqCst);
    let ai = signed_in(&fake).await.ai();
    let err = ai
        .chat_with(
            chat_request("error-before-meta"),
            fast().with_max_retries(2),
        )
        .await
        .unwrap()
        .collect()
        .await
        .unwrap_err();
    let Error::ChatFailed(failure) = err else {
        panic!("{err:?}")
    };
    assert_eq!(failure.error.code, ErrorCode::ProviderError);
    assert_eq!(failure.charge, Charge::NothingCharged);
    assert_eq!(keys_for(&fake, "error-before-meta").len(), 3);
    let unique: HashSet<_> = keys_for(&fake, "error-before-meta").into_iter().collect();
    assert_eq!(unique.len(), 3);
}

/// Negative control: a failure after output that was charged is NEVER
/// retried — a retry would be a second charged call.
#[tokio::test]
async fn a_charged_failure_is_never_retried() {
    let fake = Fake::start().await;
    let ai = signed_in(&fake).await.ai();
    let mut stream = ai
        .chat_with(chat_request("charged-failure"), fast().with_max_retries(5))
        .await
        .unwrap();
    let (events, err) = drain(&mut stream).await;
    assert!(err.is_none());
    assert_eq!(names(&events), ["meta", "delta", "error"]);
    let Event::Error(e) = &events[2] else {
        panic!()
    };
    assert!(e.code.retryable(), "the code alone would say retry");
    assert!(!e.retryable(), "the charged, partial call says never");
    assert_eq!(
        Charge::from(e.outcome()).charged_2z(),
        Some(Whole2z::new(1))
    );
    assert_eq!(
        keys_for(&fake, "charged-failure").len(),
        1,
        "exactly one call"
    );

    let err = ai
        .complete(chat_request("charged-failure"))
        .await
        .unwrap_err();
    let Error::ChatFailed(f) = err else { panic!() };
    assert!(!f.retryable());
    assert_eq!(f.partial_text, "partial ");
    assert!(matches!(f.charge, Charge::Charged { .. }));
    assert_eq!(keys_for(&fake, "charged-failure").len(), 2);
}

#[tokio::test]
async fn delivery_aborted_is_pending_and_not_retried() {
    let fake = Fake::start().await;
    let ai = signed_in(&fake).await.ai();
    let mut stream = ai
        .chat_with(chat_request("delivery-aborted"), fast())
        .await
        .unwrap();
    let (events, _) = drain(&mut stream).await;
    let Event::Error(e) = events.last().unwrap() else {
        panic!()
    };
    assert_eq!(e.code, ErrorCode::DeliveryAborted);
    assert_eq!(
        Charge::from(e.outcome()),
        Charge::NotFinal(NotFinal::Pending)
    );
    assert!(!e.retryable());
    assert_eq!(keys_for(&fake, "delivery-aborted").len(), 1);
}

/// A connection that closes without a terminal event is the SDK-local
/// `stream_interrupted`, not retried; the record tells the outcome.
#[tokio::test]
async fn a_disconnect_without_a_terminal_event_is_stream_interrupted() {
    let fake = Fake::start().await;
    let ai = signed_in(&fake).await.ai();
    let mut stream = ai
        .chat_with(chat_request("disconnect"), fast())
        .await
        .unwrap();
    let (events, err) = drain(&mut stream).await;
    assert_eq!(names(&events), ["meta", "delta"]);
    let Some(Error::StreamInterrupted {
        call_id: Some(call_id),
    }) = err
    else {
        panic!("{err:?}")
    };
    assert_eq!(keys_for(&fake, "disconnect").len(), 1, "never retried");
    let record = ai.call(&call_id).await.unwrap();
    assert_eq!(record.status, CallStatus::Streaming);
    assert!(!record.charge().is_final());
    assert!(stream.next().await.unwrap().is_none());
}

#[tokio::test]
async fn a_cancel_handle_closes_the_connection() {
    let fake = Fake::start().await;
    let ai = signed_in(&fake).await.ai();
    let mut stream = ai.chat(chat_request("hang")).await.unwrap();
    assert!(matches!(stream.next().await.unwrap(), Some(Event::Meta(_))));
    let handle = stream.cancel_handle();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        handle.cancel();
    });
    assert!(matches!(stream.next().await, Err(Error::Cancelled)));
    assert!(stream.next().await.unwrap().is_none());
    for _ in 0..100 {
        if fake.hang_disconnected.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the gateway never saw the disconnect");
}

#[tokio::test]
async fn dropping_the_stream_closes_the_connection() {
    let fake = Fake::start().await;
    let ai = signed_in(&fake).await.ai();
    let mut stream = ai.chat(chat_request("hang")).await.unwrap();
    assert!(matches!(stream.next().await.unwrap(), Some(Event::Meta(_))));
    drop(stream);
    for _ in 0..100 {
        if fake.hang_disconnected.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the gateway never saw the disconnect");
}

#[tokio::test]
async fn a_retryable_refusal_before_the_stream_is_retried_with_a_new_key() {
    let fake = Fake::start().await;
    let ai = signed_in(&fake).await.ai();
    let done = ai
        .chat_with(chat_request("rate-limited-once"), fast())
        .await
        .unwrap()
        .collect()
        .await
        .unwrap();
    assert!(done.charge.is_final());
    let keys = keys_for(&fake, "rate-limited-once");
    assert_eq!(keys.len(), 2);
    assert_ne!(keys[0], keys[1]);
}

#[tokio::test]
async fn a_balance_refusal_is_not_retried() {
    let fake = Fake::start().await;
    let ai = signed_in(&fake).await.ai();
    let err = ai
        .chat_with(chat_request("insufficient"), fast().with_max_retries(5))
        .await
        .unwrap_err();
    let api = err.api().unwrap();
    assert_eq!(
        (api.status, api.error_code()),
        (402, ErrorCode::InsufficientBalance)
    );
    assert_eq!(api.detail_u64("available_milli_2z"), Some(400));
    assert_eq!(keys_for(&fake, "insufficient").len(), 1);
}

/// Re-sending a finished call's key is receipt recovery: the record comes
/// back (`application/json` even though a stream was asked for), and nothing
/// new runs.
#[tokio::test]
async fn resending_a_key_recovers_the_receipt_and_does_no_new_work() {
    let fake = Fake::start().await;
    let ai = signed_in(&fake).await.ai();
    let first = ai
        .chat_with(
            chat_request("settled"),
            fast().with_idempotency_key("k-receipt"),
        )
        .await
        .unwrap()
        .collect()
        .await
        .unwrap();
    let err = ai
        .chat_with(
            chat_request("settled"),
            fast().with_idempotency_key("k-receipt"),
        )
        .await
        .unwrap_err();
    let Error::Replayed(record) = err else {
        panic!("{err:?}")
    };
    assert!(record.replayed);
    assert_eq!(Some(record.call_id.clone()), first.call_id);
    assert_eq!(record.charge().charged_2z(), Some(Whole2z::new(1)));
    assert_eq!(keys_for(&fake, "settled").len(), 1, "no second call");
}

#[tokio::test]
async fn an_expired_access_token_on_chat_is_refreshed_once() {
    let fake = Fake::start().await;
    let ai = signed_in(&fake).await.ai();
    fake.expire_access_tokens();
    ai.complete(chat_request("settled")).await.unwrap();
    assert_eq!(fake.refresh_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn models_and_estimate() {
    let fake = Fake::start().await;
    let ai = signed_in(&fake).await.ai();
    let models = ai.models().await.unwrap();
    assert_eq!(models.catalog_version, 7);
    assert_eq!(models.models[0].id, "settled");
    // Revalidated with If-None-Match; the 304 answers from the cache.
    assert_eq!(ai.models().await.unwrap(), models);
    let estimate = ai.estimate(&chat_request("settled")).await.unwrap();
    assert_eq!(estimate.hold_2z, Whole2z::new(2));
    assert_eq!(estimate.cap_remaining_milli_2z, Some(None), "null = no cap");
}

/// A Stop pressed during a retry's backoff must not start the retry: the
/// gateway would bill a call begun after the user cancelled.
#[tokio::test]
async fn cancelling_during_a_retry_backoff_starts_no_new_call() {
    let fake = Fake::start().await;
    let ai = signed_in(&fake).await.ai();
    let mut stream = ai
        .chat_with(
            chat_request("error-before-meta"),
            ChatOptions::default().with_retry_base_delay(Duration::from_millis(500)),
        )
        .await
        .unwrap();
    let handle = stream.cancel_handle();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        handle.cancel();
    });
    assert!(matches!(stream.next().await, Err(Error::Cancelled)));
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(
        keys_for(&fake, "error-before-meta").len(),
        1,
        "no retry sent"
    );
}

/// A retry never continues under a different session: if someone else
/// signs in on this client while a call is backing off, the retry stops
/// rather than spending as them.
#[tokio::test]
async fn a_retry_never_runs_under_another_session() {
    let fake = Fake::start().await;
    let client = signed_in(&fake).await;
    let mut stream = client
        .ai()
        .chat_with(
            chat_request("error-before-meta"),
            ChatOptions::default().with_retry_base_delay(Duration::from_millis(400)),
        )
        .await
        .unwrap();
    let other = client.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        other
            .sign_in(
                &ScriptedBrowser::new("com.example.tutor:/oauth/callback"),
                SignInOptions::default(),
            )
            .await
            .unwrap();
    });
    assert!(matches!(
        stream.next().await,
        Err(Error::SignedOut(f2z_sdk::SignedOutReason::SessionChanged))
    ));
    assert_eq!(keys_for(&fake, "error-before-meta").len(), 1);
}

#[tokio::test]
async fn a_refusal_whose_body_stalls_does_not_hang() {
    let fake = Fake::start().await;
    let client = Client::new(
        fake.config()
            .with_request_timeout(Duration::from_millis(300)),
        Arc::new(MemoryStore::new()),
    )
    .unwrap();
    client
        .sign_in(
            &ScriptedBrowser::new("com.example.tutor:/oauth/callback"),
            SignInOptions::default(),
        )
        .await
        .unwrap();
    let started = std::time::Instant::now();
    let err = tokio::time::timeout(
        Duration::from_secs(5),
        client.ai().chat_with(chat_request("stall-503"), fast()),
    )
    .await
    .expect("chat() hung on a stalled body")
    .unwrap_err();
    // Headers arrived, so the call may exist: the key is handed back.
    assert!(
        matches!(err, Error::Unconfirmed { ref cause, .. } if cause.is_timeout()),
        "{err:?}"
    );
    assert!(started.elapsed() < Duration::from_secs(3));
}

/// A call whose answer is lost is re-sent with the SAME key, which recovers
/// the receipt of the call that ran rather than running a second one.
#[tokio::test]
async fn a_lost_answer_is_recovered_by_a_same_key_resend() {
    let fake = Fake::start().await;
    let client = Client::new(
        fake.config()
            .with_request_timeout(Duration::from_millis(200)),
        Arc::new(MemoryStore::new()),
    )
    .unwrap();
    client
        .sign_in(
            &ScriptedBrowser::new("com.example.tutor:/oauth/callback"),
            SignInOptions::default(),
        )
        .await
        .unwrap();
    let err = client
        .ai()
        .chat_with(chat_request("slow-headers"), fast())
        .await
        .unwrap_err();
    let Error::Replayed(record) = err else {
        panic!("{err:?}")
    };
    assert_eq!(record.charge().charged_2z(), Some(Whole2z::new(1)));
    assert_eq!(
        keys_for(&fake, "slow-headers").len(),
        1,
        "never charged twice"
    );
}

/// When every re-send goes unanswered, the error carries the key, and
/// re-sending with it later recovers the receipt instead of paying twice.
#[tokio::test]
async fn an_unanswered_call_reports_its_key_for_recovery() {
    let fake = Fake::start().await;
    let client = Client::new(
        fake.config()
            .with_request_timeout(Duration::from_millis(200)),
        Arc::new(MemoryStore::new()),
    )
    .unwrap();
    client
        .sign_in(
            &ScriptedBrowser::new("com.example.tutor:/oauth/callback"),
            SignInOptions::default(),
        )
        .await
        .unwrap();
    let err = client
        .ai()
        .chat_with(
            chat_request("slow-headers"),
            fast().with_transport_retries(0),
        )
        .await
        .unwrap_err();
    let Error::Unconfirmed {
        idempotency_key, ..
    } = err
    else {
        panic!("{err:?}")
    };
    assert_eq!(
        keys_for(&fake, "slow-headers"),
        std::slice::from_ref(&idempotency_key)
    );
    let err = client
        .ai()
        .chat_with(
            chat_request("slow-headers"),
            fast().with_idempotency_key(idempotency_key),
        )
        .await
        .unwrap_err();
    let Error::Replayed(record) = err else {
        panic!("{err:?}")
    };
    assert_eq!(record.charge().charged_2z(), Some(Whole2z::new(1)));
    assert_eq!(
        keys_for(&fake, "slow-headers").len(),
        1,
        "never charged twice"
    );
}

#[tokio::test]
async fn broken_chat_replay_body_keeps_the_recovery_key() {
    let fake = Fake::start().await;
    let client = signed_in(&fake).await;
    let options = fast().with_idempotency_key("body-recovery");
    let mut first = client
        .ai()
        .chat_with(chat_request("settled"), options.clone())
        .await
        .unwrap();
    while first.next().await.unwrap().is_some() {}
    fake.broken_chat_replay.store(true, Ordering::SeqCst);
    let err = client
        .ai()
        .chat_with(chat_request("settled"), options.clone())
        .await
        .unwrap_err();
    assert!(
        matches!(err, Error::Unconfirmed { idempotency_key, .. } if idempotency_key == "body-recovery")
    );
    fake.broken_chat_replay.store(false, Ordering::SeqCst);
    assert!(matches!(
        client
            .ai()
            .chat_with(chat_request("settled"), options)
            .await,
        Err(Error::Replayed(_))
    ));
    assert_eq!(keys_for(&fake, "settled").len(), 1);
}

#[tokio::test]
async fn cancelling_a_new_key_retry_during_refresh_sends_no_new_call() {
    let fake = Fake::start().await;
    let client = signed_in(&fake).await;
    let mut stream = client
        .ai()
        .chat_with(chat_request("error-before-meta"), fast())
        .await
        .unwrap();
    let cancel = stream.cancel_handle();
    // Retry sends its first attempt with an expired token, then blocks on
    // the internal 401 refresh. Stop must prevent the post-refresh send.
    fake.expire_access_tokens();
    *fake.refresh_body_delay.lock().unwrap() = Duration::from_millis(300);
    let next = tokio::spawn(async move { stream.next().await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while fake.refresh_calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    cancel.cancel();
    assert!(matches!(next.await.unwrap(), Err(Error::Cancelled)));
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(
        keys_for(&fake, "error-before-meta").len(),
        1,
        "Stop started a billable retry"
    );
    client.balance().await.unwrap();
}
