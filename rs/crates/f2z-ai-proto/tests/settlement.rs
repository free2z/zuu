//! The settlement states on `done`, `error` and the non-streamed response,
//! pinned as literal wire text, and the per-state rules `check()` enforces.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_ai_proto::amount::{Milli2z, Whole2z};
use f2z_ai_proto::balance::Balance;
use f2z_ai_proto::chat::{ChatRequest, ChatResponse, EstimateResponse, FinishReason, UsageSource};
use f2z_ai_proto::error::FailedCall;
use f2z_ai_proto::error::{ApiError, ErrorBody, ErrorCode};
use f2z_ai_proto::event::{Done, ErrorEvent, Event, Meta};
use f2z_ai_proto::settlement::{NotFinal, Outcome, Settlement, SettlementError};

fn frame(event: &Event) -> String {
    event.to_sse().unwrap()
}

fn round_trip(event: &Event, expected_frame: &str) {
    assert_eq!(frame(event), expected_frame);
    let data = expected_frame
        .strip_prefix(&format!("event: {}\ndata: ", event.name()))
        .unwrap()
        .strip_suffix("\n\n")
        .unwrap();
    assert_eq!(&Event::from_sse(event.name(), data).unwrap(), event);
}

fn full_settled_done() -> Done {
    Done {
        balance_hint_milli_2z: Some(Milli2z::new(41_500)),
        hold_2z: Some(Whole2z::new(2)),
        released_2z: Some(Whole2z::new(1)),
        collected_milli_2z: Some(Milli2z::new(1_000)),
        shortfall_milli_2z: Some(Milli2z::new(0)),
        cap_remaining_milli_2z: Some(Some(Milli2z::new(199_000))),
        ..Done::settled(Whole2z::new(1), "rcpt_1", FinishReason::Stop)
    }
}

// ---- done ---------------------------------------------------------------

#[test]
fn a_settled_done_is_the_spec_frame() {
    let done = full_settled_done();
    done.check().unwrap();
    round_trip(
        &Event::Done(done),
        "event: done\ndata: {\"charged_2z\":1,\"receipt_id\":\"rcpt_1\",\"finish_reason\":\"stop\",\"balance_hint_milli_2z\":41500,\"settlement\":\"settled\",\"hold_2z\":2,\"released_2z\":1,\"collected_milli_2z\":1000,\"shortfall_milli_2z\":0,\"cap_remaining_milli_2z\":199000,\"usage_source\":\"provider\"}\n\n",
    );
}

#[test]
fn a_pending_done_carries_only_the_hold() {
    let done = Done::pending(Whole2z::new(2), FinishReason::Stop);
    done.check().unwrap();
    round_trip(
        &Event::Done(done),
        "event: done\ndata: {\"finish_reason\":\"stop\",\"settlement\":\"pending\",\"hold_2z\":2,\"usage_source\":\"provider\"}\n\n",
    );
}

#[test]
fn a_pending_done_from_the_gateway_decodes() {
    // The shape the spec says an SDK on the old crate could not decode.
    let Event::Done(done) = Event::from_sse(
        "done",
        r#"{"finish_reason":"stop","settlement":"pending","hold_2z":2}"#,
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(done.settlement, Settlement::Pending);
    assert!(!done.settlement.is_final());
    assert_eq!(done.charged_2z, None);
    assert_eq!(done.receipt_id, None);
    done.check().unwrap();
}

#[test]
fn a_released_done_charges_nothing() {
    let done = Done::released(Whole2z::new(2), FinishReason::Cancelled);
    done.check().unwrap();
    round_trip(
        &Event::Done(done),
        "event: done\ndata: {\"charged_2z\":0,\"finish_reason\":\"cancelled\",\"settlement\":\"released\",\"hold_2z\":2,\"released_2z\":2,\"usage_source\":\"provider\"}\n\n",
    );
    // And with the 2Z fields absent, as the non-streamed form allows.
    let Event::Done(bare) = Event::from_sse(
        "done",
        r#"{"finish_reason":"stop","settlement":"released"}"#,
    )
    .unwrap() else {
        panic!()
    };
    bare.check().unwrap();
}

#[test]
fn an_absent_settlement_means_settled() {
    let Event::Done(done) = Event::from_sse(
        "done",
        r#"{"charged_2z":1,"receipt_id":"r","finish_reason":"stop"}"#,
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(done.settlement, Settlement::Settled);
    done.check().unwrap();
}

#[test]
fn an_unknown_settlement_decodes_and_is_not_final() {
    let Event::Done(done) = Event::from_sse(
        "done",
        r#"{"finish_reason":"stop","settlement":"reconciling"}"#,
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(done.settlement, Settlement::Unknown);
    assert!(!done.settlement.is_final());
    assert_eq!(done.check(), Err(SettlementError::UnknownSettlement));
}

#[test]
fn null_cap_remaining_is_uncapped_not_absent() {
    let Event::Done(done) = Event::from_sse(
        "done",
        r#"{"charged_2z":1,"receipt_id":"r","finish_reason":"stop","cap_remaining_milli_2z":null}"#,
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(done.cap_remaining_milli_2z, Some(None));
    assert!(
        done.data_json_contains(r#""cap_remaining_milli_2z":null"#),
        "null survives re-encoding"
    );
    let Event::Done(absent) = Event::from_sse(
        "done",
        r#"{"charged_2z":1,"receipt_id":"r","finish_reason":"stop"}"#,
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(absent.cap_remaining_milli_2z, None);
}

trait DataJson {
    fn data_json_contains(&self, needle: &str) -> bool;
}

impl DataJson for Done {
    fn data_json_contains(&self, needle: &str) -> bool {
        Event::Done(self.clone())
            .data_json()
            .unwrap()
            .contains(needle)
    }
}

#[test]
fn the_done_rules_are_enforced() {
    let ok = full_settled_done();
    let cases: Vec<(Done, SettlementError)> = vec![
        (
            Done {
                charged_2z: None,
                ..ok.clone()
            },
            SettlementError::Missing("charged_2z"),
        ),
        (
            Done {
                receipt_id: None,
                ..ok.clone()
            },
            SettlementError::Missing("receipt_id"),
        ),
        (
            Done {
                receipt_id: Some(String::new()),
                ..ok.clone()
            },
            SettlementError::Missing("receipt_id"),
        ),
        (
            Done {
                charged_2z: Some(Whole2z::new(0)),
                ..ok.clone()
            },
            SettlementError::ZeroCharge,
        ),
        (
            Done {
                collected_milli_2z: Some(Milli2z::new(999)),
                ..ok.clone()
            },
            SettlementError::CollectedMismatch,
        ),
        (
            Done {
                shortfall_milli_2z: None,
                ..ok.clone()
            },
            SettlementError::Missing("shortfall_milli_2z"),
        ),
        (
            Done {
                released_2z: Some(Whole2z::new(2)),
                ..ok.clone()
            },
            SettlementError::ReleasedMismatch,
        ),
        (
            // Pending, but the charge is reported.
            Done {
                settlement: Settlement::Pending,
                ..ok.clone()
            },
            SettlementError::Unexpected("charged_2z"),
        ),
        (
            Done {
                balance_hint_milli_2z: Some(Milli2z::new(1)),
                ..Done::pending(Whole2z::new(2), FinishReason::Stop)
            },
            SettlementError::Unexpected("balance_hint_milli_2z"),
        ),
        (
            Done {
                cap_remaining_milli_2z: Some(None),
                ..Done::pending(Whole2z::new(2), FinishReason::Stop)
            },
            SettlementError::Unexpected("cap_remaining_milli_2z"),
        ),
        (
            Done {
                receipt_id: Some("r".into()),
                ..Done::released(Whole2z::new(2), FinishReason::Stop)
            },
            SettlementError::Unexpected("receipt_id"),
        ),
        (
            Done {
                charged_2z: Some(Whole2z::new(1)),
                ..Done::released(Whole2z::new(2), FinishReason::Stop)
            },
            SettlementError::Unexpected("charged_2z"),
        ),
        (
            Done {
                released_2z: Some(Whole2z::new(1)),
                ..Done::released(Whole2z::new(2), FinishReason::Stop)
            },
            SettlementError::ReleasedMismatch,
        ),
    ];
    for (done, want) in cases {
        assert_eq!(done.check(), Err(want), "{done:?}");
    }
}

#[test]
fn the_write_off_example_checks() {
    // metering.md §6.7: hold 2, priced 3, 2.4 taken, 0.6 written off.
    let done = Done {
        hold_2z: Some(Whole2z::new(2)),
        released_2z: Some(Whole2z::new(0)),
        collected_milli_2z: Some(Milli2z::new(2_400)),
        shortfall_milli_2z: Some(Milli2z::new(600)),
        ..Done::settled(Whole2z::new(3), "r", FinishReason::Stop)
    };
    done.check().unwrap();
    assert_eq!(
        done.outcome(),
        Outcome::Charged {
            charged_2z: Whole2z::new(3),
            receipt_id: "r",
            collected_milli_2z: Some(Milli2z::new(2_400)),
            shortfall_milli_2z: Some(Milli2z::new(600)),
        }
    );
}

#[test]
fn a_shortfall_inside_the_hold_is_refused() {
    // The hold was already reserved: a write-off is only ever of the part
    // above it. Priced 100 on a hold of 100 with 40 written off would be the
    // gateway under-collecting its own reservation.
    let inside = Done {
        hold_2z: Some(Whole2z::new(100)),
        released_2z: Some(Whole2z::new(0)),
        collected_milli_2z: Some(Milli2z::new(60_000)),
        shortfall_milli_2z: Some(Milli2z::new(40_000)),
        ..Done::settled(Whole2z::new(100), "r", FinishReason::Stop)
    };
    assert_eq!(inside.check(), Err(SettlementError::ShortfallWithinHold));
    assert!(!inside.outcome().is_final());
    // The boundary: priced 3 on a hold of 2, exactly the 1 above it written off.
    let boundary = Done {
        hold_2z: Some(Whole2z::new(2)),
        released_2z: Some(Whole2z::new(0)),
        collected_milli_2z: Some(Milli2z::new(2_000)),
        shortfall_milli_2z: Some(Milli2z::new(1_000)),
        ..Done::settled(Whole2z::new(3), "r", FinishReason::Stop)
    };
    boundary.check().unwrap();
    let one_over = Done {
        collected_milli_2z: Some(Milli2z::new(1_999)),
        shortfall_milli_2z: Some(Milli2z::new(1_001)),
        ..boundary
    };
    assert_eq!(one_over.check(), Err(SettlementError::ShortfallWithinHold));
}

// ---- error --------------------------------------------------------------

#[test]
fn an_error_after_output_is_settled_for_what_was_produced() {
    let e = ErrorEvent {
        code: ErrorCode::ProviderError,
        message: "closed early".into(),
        settlement: Settlement::Settled,
        charged_2z: Some(Whole2z::new(1)),
        receipt_id: Some("rcpt_1".into()),
        collected_milli_2z: Some(Milli2z::new(1_000)),
        shortfall_milli_2z: Some(Milli2z::new(0)),
        partial: true,
    };
    e.check().unwrap();
    round_trip(
        &Event::Error(e),
        "event: error\ndata: {\"code\":\"provider_error\",\"message\":\"closed early\",\"settlement\":\"settled\",\"charged_2z\":1,\"receipt_id\":\"rcpt_1\",\"collected_milli_2z\":1000,\"shortfall_milli_2z\":0,\"partial\":true}\n\n",
    );
}

#[test]
fn delivery_aborted_is_pending() {
    let e = ErrorEvent {
        settlement: Settlement::Pending,
        charged_2z: None,
        partial: true,
        ..ErrorEvent::uncharged(ErrorCode::DeliveryAborted, "buffer full")
    };
    e.check().unwrap();
    assert!(!e.code.retryable());
    assert_eq!(e.code.http_status(), None);
    round_trip(
        &Event::Error(e.clone()),
        "event: error\ndata: {\"code\":\"delivery_aborted\",\"message\":\"buffer full\",\"settlement\":\"pending\",\"partial\":true}\n\n",
    );
    let settled = ErrorEvent {
        settlement: Settlement::Settled,
        charged_2z: Some(Whole2z::new(1)),
        receipt_id: Some("r".into()),
        ..e
    };
    assert_eq!(
        settled.check(),
        Err(SettlementError::DeliveryAbortedNotPending)
    );
}

#[test]
fn a_lone_error_before_meta_charged_nothing() {
    let e = ErrorEvent::uncharged(ErrorCode::ProviderTimeout, "no first byte");
    e.check().unwrap();
    assert_eq!(e.charged_2z, Some(Whole2z::ZERO));
    // Zero charged means no receipt.
    let with_receipt = ErrorEvent {
        receipt_id: Some("r".into()),
        ..e.clone()
    };
    assert_eq!(
        with_receipt.check(),
        Err(SettlementError::Unexpected("receipt_id"))
    );
    // Settled requires the charge be stated.
    let silent = ErrorEvent {
        charged_2z: None,
        ..e
    };
    assert_eq!(silent.check(), Err(SettlementError::Missing("charged_2z")));
}

#[test]
fn an_error_whose_hold_expired_is_released() {
    let Event::Error(e) = Event::from_sse(
        "error",
        r#"{"code":"internal","message":"x","settlement":"released","charged_2z":0,"partial":true}"#,
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(e.settlement, Settlement::Released);
    e.check().unwrap();
}

#[test]
fn an_old_style_error_event_still_decodes() {
    let Event::Error(e) = Event::from_sse("error", r#"{"code":"new_code"}"#).unwrap() else {
        panic!()
    };
    assert_eq!(e.code, ErrorCode::Unknown);
    assert_eq!(e.settlement, Settlement::Settled);
    assert!(!e.partial);
}

// ---- the HTTP envelope ----------------------------------------------------

#[test]
fn the_envelope_carries_details() {
    let body: ErrorBody = serde_json::from_str(
        r#"{"error":{"code":"account_in_debt","message":"owes","details":{"debt_milli_2z":1500,"future":1}}}"#,
    )
    .unwrap();
    assert_eq!(body.error.code, ErrorCode::AccountInDebt);
    let details = body.error.details.as_ref().unwrap();
    assert_eq!(details["debt_milli_2z"], 1500);
    let bare = ApiError {
        code: ErrorCode::TooManyHolds,
        message: "17th".into(),
        details: None,
    };
    assert_eq!(
        serde_json::to_string(&bare).unwrap(),
        r#"{"code":"too_many_holds","message":"17th"}"#
    );
}

// ---- the non-streamed response -----------------------------------------

const RESPONSE_HEAD: &str = r#""call_id":"c","model":"m","message":{"content":[{"type":"text","text":"hi"}]},"finish_reason":"stop","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_tokens":0,"output_tokens":1,"reasoning_tokens":0,"images":0,"tool_calls":0},"usage_source":"provider""#;

#[test]
fn a_response_in_every_settlement_state() {
    for (tail, state) in [
        (
            r#","charged_2z":1,"receipt_id":"r","settlement":"settled","hold_2z":2,"released_2z":1,"collected_milli_2z":1000,"shortfall_milli_2z":0,"cap_remaining_milli_2z":null,"settled_at":"2026-09-26T21:04:14Z""#,
            Settlement::Settled,
        ),
        (
            r#","settlement":"pending","hold_2z":2"#,
            Settlement::Pending,
        ),
        (
            r#","charged_2z":0,"settlement":"released","hold_2z":2,"released_2z":2"#,
            Settlement::Released,
        ),
    ] {
        let json = format!("{{{RESPONSE_HEAD}{tail}}}");
        let resp: ChatResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(resp.settlement, state);
        resp.check().unwrap();
        assert_eq!(serde_json::to_string(&resp).unwrap(), json, "{state}");
    }
    // A pending response that claims a settlement time is refused.
    let json = format!(
        r#"{{{RESPONSE_HEAD},"settlement":"pending","settled_at":"2026-09-26T21:04:14Z"}}"#
    );
    let resp: ChatResponse = serde_json::from_str(&json).unwrap();
    assert_eq!(resp.check(), Err(SettlementError::Unexpected("settled_at")));
    assert_eq!(resp.usage_source, UsageSource::Provider);
}

// ---- meta, estimate, balance, fallback ------------------------------------

#[test]
fn meta_carries_the_informational_fields() {
    let meta = Meta {
        requested_model: Some("big".into()),
        provider: Some("p".into()),
        max_output_tokens: Some(800),
        input_tokens_estimate: Some(1_200),
        created_at: Some("2026-09-26T21:04:11Z".into()),
        ..Meta::new("c", "small", Whole2z::new(2))
    };
    round_trip(
        &Event::Meta(meta),
        "event: meta\ndata: {\"call_id\":\"c\",\"model\":\"small\",\"hold_2z\":2,\"requested_model\":\"big\",\"provider\":\"p\",\"max_output_tokens\":800,\"input_tokens_estimate\":1200,\"created_at\":\"2026-09-26T21:04:11Z\"}\n\n",
    );
}

#[test]
fn an_estimate_round_trips_with_and_without_a_cap() {
    for json in [
        r#"{"model":"m","input_tokens":1200,"max_output_tokens":800,"hold_2z":2,"min_charge_2z":1,"available_milli_2z":42500,"cap_remaining_milli_2z":200000,"catalog_version":7}"#,
        r#"{"model":"m","input_tokens":1200,"max_output_tokens":800,"hold_2z":2,"min_charge_2z":1,"available_milli_2z":42500,"cap_remaining_milli_2z":null,"catalog_version":7}"#,
        r#"{"model":"m","input_tokens":1,"max_output_tokens":1,"hold_2z":1}"#,
    ] {
        let e: EstimateResponse = serde_json::from_str(json).unwrap();
        assert_eq!(serde_json::to_string(&e).unwrap(), json);
    }
}

#[test]
fn a_balance_carries_its_debt() {
    let json = r#"{"available_milli_2z":0,"held_milli_2z":0,"balance_milli_2z":0,"debt_milli_2z":1500,"as_of":"2026-09-26T21:04:14Z"}"#;
    let b: Balance = serde_json::from_str(json).unwrap();
    assert!(b.in_debt());
    assert_eq!(b.debt_milli_2z, Milli2z::new(1_500));
    assert_eq!(serde_json::to_string(&b).unwrap(), json);
}

#[test]
fn fallback_tries_each_model_once_in_order() {
    let req: ChatRequest =
        serde_json::from_str(r#"{"model":"a","messages":[],"fallback":["b","a","c","b"]}"#)
            .unwrap();
    assert_eq!(req.attempts().collect::<Vec<_>>(), ["a", "b", "c"]);
    let none: ChatRequest = serde_json::from_str(r#"{"model":"a","messages":[]}"#).unwrap();
    assert_eq!(none.attempts().collect::<Vec<_>>(), ["a"]);
    // What fallback may recover from, and what it may not.
    for code in [
        ErrorCode::ProviderError,
        ErrorCode::ProviderTimeout,
        ErrorCode::Unavailable,
    ] {
        assert!(code.falls_back(), "{code}");
    }
    for code in [
        ErrorCode::InsufficientBalance,
        ErrorCode::CapExceeded,
        ErrorCode::TokenRevoked,
        ErrorCode::Internal,
        ErrorCode::DeliveryAborted,
    ] {
        assert!(!code.falls_back(), "{code}");
    }
}

// ---- consumer outcome ---------------------------------------------------

#[test]
fn a_bare_done_is_not_final_for_a_consumer() {
    // Decodes (tolerant), defaults to settled — but is not a free call.
    let Event::Done(done) = Event::from_sse("done", r#"{"finish_reason":"stop"}"#).unwrap() else {
        panic!()
    };
    assert_eq!(done.settlement, Settlement::Settled);
    assert!(done.settlement.is_final(), "the raw field says final…");
    let outcome = done.outcome();
    assert!(!outcome.is_final(), "…the outcome does not");
    assert_eq!(
        outcome,
        Outcome::NotFinal(NotFinal::Invalid(SettlementError::Missing("charged_2z")))
    );
    assert_eq!(outcome.charged_2z(), None);
}

#[test]
fn outcomes_for_each_state() {
    assert_eq!(
        Done::pending(Whole2z::new(2), FinishReason::Stop).outcome(),
        Outcome::NotFinal(NotFinal::Pending)
    );
    let released_done = Done::released(Whole2z::new(2), FinishReason::Stop);
    let released = released_done.outcome();
    assert_eq!(released, Outcome::NothingCharged);
    assert_eq!(released.charged_2z(), Some(Whole2z::ZERO));
    let unknown = Done {
        settlement: Settlement::Unknown,
        ..Done::pending(Whole2z::new(2), FinishReason::Stop)
    };
    assert_eq!(unknown.outcome(), Outcome::NotFinal(NotFinal::Unknown));
    assert_eq!(unknown.check(), Err(SettlementError::UnknownSettlement));
    assert_eq!(
        ErrorEvent::uncharged(ErrorCode::ProviderError, "x").outcome(),
        Outcome::NothingCharged
    );
}

#[test]
fn a_partial_settled_failure_charges_at_least_one() {
    let e = ErrorEvent {
        partial: true,
        ..ErrorEvent::uncharged(ErrorCode::ProviderError, "cut")
    };
    assert_eq!(e.check(), Err(SettlementError::PartialZeroCharge));
    assert!(!e.outcome().is_final());
    // Released with partial output is fine: the hold expired, nothing charged.
    let released = ErrorEvent {
        settlement: Settlement::Released,
        ..e
    };
    released.check().unwrap();
}

// ---- retry decisions ----------------------------------------------------

#[test]
fn a_charged_or_partial_failure_is_never_retried() {
    let uncharged = ErrorEvent::uncharged(ErrorCode::ProviderError, "x");
    assert!(uncharged.retryable());
    let charged = ErrorEvent {
        charged_2z: Some(Whole2z::new(1)),
        receipt_id: Some("r".into()),
        partial: true,
        ..uncharged.clone()
    };
    assert!(
        ErrorCode::ProviderError.retryable(),
        "the code alone says yes"
    );
    assert!(!charged.retryable(), "the call was charged");
    let pending = ErrorEvent {
        settlement: Settlement::Pending,
        charged_2z: None,
        ..uncharged.clone()
    };
    assert!(!pending.retryable(), "not final");
    let not_retryable = ErrorEvent::uncharged(ErrorCode::CapExceeded, "x");
    assert!(!not_retryable.retryable());
}

#[test]
fn a_charged_502_has_a_typed_settlement_and_is_not_retried() {
    // chat-api.md §4: a non-streamed failure after output began.
    let body: ErrorBody = serde_json::from_str(
        r#"{"error":{"code":"provider_error","message":"cut","details":{
            "call_id":"c","settlement":"settled","charged_2z":1,"receipt_id":"r",
            "collected_milli_2z":1000,"shortfall_milli_2z":0,"partial":true,
            "message":{"content":[{"type":"text","text":"half"}]}}}}"#,
    )
    .unwrap();
    let call: FailedCall = body.error.failed_call().unwrap().unwrap();
    call.check().unwrap();
    assert_eq!(call.call_id.as_deref(), Some("c"));
    assert_eq!(call.message.as_ref().unwrap().text(), "half");
    assert_eq!(call.outcome().charged_2z(), Some(Whole2z::new(1)));
    assert!(!body.error.retryable());

    // Before any output: no settlement in details, the code decides.
    let early: ErrorBody = serde_json::from_str(
        r#"{"error":{"code":"provider_timeout","message":"t","details":{"phase":"first_byte"}}}"#,
    )
    .unwrap();
    assert!(early.error.failed_call().is_none());
    assert!(early.error.retryable());

    // Settlement members that do not decode refuse the retry.
    let garbled: ErrorBody = serde_json::from_str(
        r#"{"error":{"code":"provider_error","message":"x","details":{"charged_2z":"one"}}}"#,
    )
    .unwrap();
    assert!(matches!(garbled.error.failed_call(), Some(Err(_))));
    assert!(!garbled.error.retryable());

    // Evidence the call ran, but no settlement: reconcile, don't retry.
    let ran: ErrorBody = serde_json::from_str(
        r#"{"error":{"code":"internal","message":"x","details":{"call_id":"c"}}}"#,
    )
    .unwrap();
    assert!(ran.error.failed_call().is_none());
    assert!(!ran.error.retryable());

    // Any details member outside the documented pre-call set refuses.
    let novel: ErrorBody = serde_json::from_str(
        r#"{"error":{"code":"unavailable","message":"x","details":{"reason":"draining","attempt_id":"a"}}}"#,
    )
    .unwrap();
    assert!(!novel.error.retryable());
    let documented: ErrorBody = serde_json::from_str(
        r#"{"error":{"code":"unavailable","message":"x","details":{"reason":"draining"}}}"#,
    )
    .unwrap();
    assert!(documented.error.retryable());
    let bare: ErrorBody =
        serde_json::from_str(r#"{"error":{"code":"rate_limited","message":"x"}}"#).unwrap();
    assert!(bare.error.retryable());

    // A partial message implies partial, whatever the flag says.
    let hidden: ErrorBody = serde_json::from_str(
        r#"{"error":{"code":"provider_error","message":"x","details":{
            "settlement":"settled","charged_2z":0,"partial":false,
            "message":{"content":[{"type":"text","text":"half"}]}}}}"#,
    )
    .unwrap();
    let call = hidden.error.failed_call().unwrap().unwrap();
    assert!(call.partial_output());
    assert_eq!(call.check(), Err(SettlementError::PartialZeroCharge));
    assert!(!hidden.error.retryable());

    // Pending in a 502: not final, not retried.
    let pending: ErrorBody = serde_json::from_str(
        r#"{"error":{"code":"internal","message":"x","details":{"settlement":"pending","partial":true}}}"#,
    )
    .unwrap();
    assert!(!pending.error.retryable());
}
