//! Bounded nonstreaming delivery over the same detached call pipeline.
//!
//! A reservation precedes provider I/O and follows the serialized response
//! until the HTTP body is dropped. Dropping delivery never cancels billing.

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use f2z_ai_proto::chat::{AssistantMessage, ChatResponse, OutputPart};
use f2z_ai_proto::event::{ErrorEvent, Meta, UsageEvent};
use f2z_ai_proto::{ErrorCode, Event};
use http_body::Frame;
use http_body_util::BodyExt as _;
use serde_json::{Value, json};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::call::DeliveryBody;
use crate::error::ApiFailure;

/// Maximum cumulative event bytes, further restricted by the delivery limit.
const MAX_BYTES: usize = 1024 * 1024;
/// Covers decoded nodes/strings, growing collections, and serialization copies.
const MEMORY_FACTOR: usize = 64;

pub(crate) struct Reservation {
    permit: OwnedSemaphorePermit,
    limit: usize,
}

impl Reservation {
    pub(crate) fn acquire(
        budget: &Arc<Semaphore>,
        delivery_limit: usize,
    ) -> Result<Self, ApiFailure> {
        let limit = delivery_limit.min(MAX_BYTES);
        let bytes =
            u32::try_from(limit.saturating_mul(MEMORY_FACTOR)).map_err(|_| unavailable())?;
        let permit = Arc::clone(budget)
            .try_acquire_many_owned(bytes)
            .map_err(|_| unavailable())?;
        Ok(Self { permit, limit })
    }
}

fn unavailable() -> ApiFailure {
    ApiFailure::new(
        ErrorCode::Unavailable,
        "nonstreaming response memory budget is full",
    )
    .detail("reason", "response_budget")
    .retry_after(1)
}

#[derive(Default)]
struct Aggregate {
    meta: Option<Meta>,
    usage: Option<UsageEvent>,
    message: AssistantMessage,
    terminal: Option<Event>,
}

impl Aggregate {
    fn push(&mut self, event: Event) -> Result<(), ()> {
        if self.terminal.is_some() {
            return Err(());
        }
        match event {
            Event::Meta(meta) if self.meta.is_none() && self.usage.is_none() => {
                self.meta = Some(meta)
            }
            Event::Delta(delta) if self.meta.is_some() && self.usage.is_none() => {
                if let Some(OutputPart::Text { text }) = self.message.content.last_mut() {
                    text.push_str(&delta.text);
                } else {
                    self.message
                        .content
                        .push(OutputPart::Text { text: delta.text });
                }
            }
            Event::ToolCall(tool) if self.meta.is_some() && self.usage.is_none() => {
                self.message.tool_calls.push(tool)
            }
            Event::Usage(usage) if self.meta.is_some() && self.usage.is_none() => {
                self.usage = Some(usage)
            }
            Event::Done(done) if self.meta.is_some() && self.usage.is_some() => {
                done.check().map_err(|_| ())?;
                self.terminal = Some(Event::Done(done));
            }
            Event::Error(error) => {
                error.check().map_err(|_| ())?;
                self.terminal = Some(Event::Error(error));
            }
            _ => return Err(()),
        }
        Ok(())
    }

    fn output_seen(&self) -> bool {
        !self.message.content.is_empty() || !self.message.tool_calls.is_empty()
    }

    fn failure(&self, reason: &str, message: &str, call_id: Option<&str>) -> (StatusCode, Value) {
        // Delivery failed while the detached provider/settler may still run.
        // Neither a missing terminal nor a local size limit proves a zero charge.
        let error = ErrorEvent {
            code: ErrorCode::Internal,
            message: message.into(),
            settlement: f2z_ai_proto::Settlement::Pending,
            charged_2z: None,
            receipt_id: None,
            collected_milli_2z: None,
            shortfall_milli_2z: None,
            partial: self.output_seen(),
        };
        let (_, mut value) = self.error_response(&error, call_id);
        if let Some(details) = value
            .get_mut("error")
            .and_then(|e| e.get_mut("details"))
            .and_then(Value::as_object_mut)
        {
            details.insert("reason".into(), reason.into());
        }
        (StatusCode::BAD_GATEWAY, value)
    }

    fn error_response(&self, error: &ErrorEvent, call_id: Option<&str>) -> (StatusCode, Value) {
        let code = if error.code == ErrorCode::DeliveryAborted {
            ErrorCode::Internal
        } else {
            error.code
        };
        let mut details = serde_json::to_value(error).unwrap_or(Value::Null);
        if let Some(object) = details.as_object_mut() {
            if let Some(id) = self.meta.as_ref().map(|m| m.call_id.as_str()).or(call_id) {
                object.insert("call_id".into(), id.into());
            }
            object.insert("message".into(), json!(self.message));
            if error.code == ErrorCode::DeliveryAborted {
                object.insert("code".into(), json!(code));
                object.insert("reason".into(), "delivery_interrupted".into());
            }
        }
        let status =
            if self.output_seen() || error.partial || error.code == ErrorCode::DeliveryAborted {
                StatusCode::BAD_GATEWAY
            } else {
                error
                    .code
                    .http_status()
                    .and_then(|s| StatusCode::from_u16(s).ok())
                    .unwrap_or(StatusCode::BAD_GATEWAY)
            };
        (
            status,
            json!({"error": {"code": code, "message": error.message, "details": details}}),
        )
    }

    fn finish(&self, call_id: Option<&str>) -> (StatusCode, Value) {
        if let Some(Event::Error(error)) = &self.terminal {
            return self.error_response(error, call_id);
        }
        let completed = (|| {
            let meta = self.meta.as_ref()?;
            let usage = self.usage.as_ref()?;
            let Event::Done(done) = self.terminal.as_ref()? else {
                return None;
            };
            let mut value = serde_json::to_value(meta).ok()?;
            let object = value.as_object_mut()?;
            object.extend(serde_json::to_value(done).ok()?.as_object()?.clone());
            object.insert("message".into(), json!(self.message));
            object.insert("usage".into(), json!(usage.usage));
            // The terminal is authoritative about the usage that was billed.
            let response: ChatResponse = serde_json::from_value(value).ok()?;
            response.check().ok()?;
            serde_json::to_value(response).ok()
        })();
        completed.map_or_else(
            || {
                self.failure(
                    "delivery_interrupted",
                    "call ended without a valid completion",
                    call_id,
                )
            },
            |value| (StatusCode::OK, value),
        )
    }
}

// DeliveryBody emits exactly one Event::to_sse frame per body frame. This is
// an internal typed boundary, not a parser for arbitrary provider SSE chunks.
fn event(frame: &[u8]) -> Result<Event, ()> {
    let text = std::str::from_utf8(frame).map_err(|_| ())?;
    let (name, data) = text
        .strip_prefix("event: ")
        .ok_or(())?
        .split_once("\ndata: ")
        .ok_or(())?;
    Event::from_sse(name, data.strip_suffix("\n\n").ok_or(())?).map_err(|_| ())
}

pub(crate) async fn collect(
    mut body: DeliveryBody,
    reservation: Reservation,
    deadline: tokio::time::Instant,
) -> Response {
    let call_id = body.call_id.clone();
    let mut aggregate = Aggregate::default();
    let mut used = 0usize;
    let mut failure_reason = None;
    loop {
        let frame = tokio::select! {
            frame = body.frame() => frame,
            () = tokio::time::sleep_until(deadline) => { failure_reason = Some("delivery_interrupted"); break; }
        };
        let Some(frame) = frame else {
            break;
        };
        let Ok(frame) = frame else {
            failure_reason = Some("delivery_interrupted");
            break;
        };
        let Ok(bytes) = frame.into_data() else {
            failure_reason = Some("delivery_interrupted");
            break;
        };
        used = used.saturating_add(bytes.len());
        if used > reservation.limit {
            failure_reason = Some("response_limit");
            break;
        }
        if event(&bytes)
            .and_then(|event| aggregate.push(event))
            .is_err()
        {
            failure_reason = Some("delivery_interrupted");
            break;
        }
    }
    // Dropping the delivery body discards its queue, never its upstream task.
    drop(body);
    let (status, value) = if let Some(reason) = failure_reason {
        aggregate.failure(
            reason,
            "nonstreaming delivery ended; reconcile the call receipt",
            call_id.as_deref(),
        )
    } else {
        aggregate.finish(call_id.as_deref())
    };
    let mut response = (status, axum::Json(value)).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Some(id) = call_id.and_then(|id| HeaderValue::from_str(&id).ok()) {
        headers.insert("x-f2z-call-id", id);
    }
    let (parts, body) = response.into_parts();
    Response::from_parts(
        parts,
        Body::new(ReservedBody {
            body,
            _permit: reservation.permit,
        }),
    )
}

struct ReservedBody {
    body: Body,
    _permit: OwnedSemaphorePermit,
}

impl http_body::Body for ReservedBody {
    type Data = Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        Pin::new(&mut self.body).poll_frame(cx)
    }
    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }
    fn size_hint(&self) -> http_body::SizeHint {
        self.body.size_hint()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use f2z_ai_proto::Whole2z;
    use f2z_ai_proto::chat::{FinishReason, Usage, UsageSource};
    use f2z_ai_proto::event::{Delta, Done};

    fn begun() -> Aggregate {
        let mut a = Aggregate::default();
        a.push(Event::Meta(Meta::new("c", "m", Whole2z::new(2))))
            .unwrap();
        a.push(Event::Delta(Delta {
            text: "paid text".into(),
        }))
        .unwrap();
        a
    }

    #[test]
    fn missing_or_invalid_terminal_never_claims_success_or_zero_charge() {
        let mut a = begun();
        let (status, value) = a.finish(None);
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(value["error"]["details"]["settlement"], "pending");
        assert!(value["error"]["details"].get("charged_2z").is_none());
        a.push(Event::Usage(UsageEvent {
            usage: Usage::default(),
            source: UsageSource::Provider,
        }))
        .unwrap();
        let mut invalid = Done::pending(Whole2z::new(2), FinishReason::Stop);
        invalid.charged_2z = Some(Whole2z::ZERO);
        assert!(a.push(Event::Done(invalid)).is_err());
        a.push(Event::Done(Done::released(
            Whole2z::new(2),
            FinishReason::Stop,
        )))
        .unwrap();
        assert_eq!(a.finish(None).0, StatusCode::OK);
        assert!(
            a.push(Event::Delta(Delta {
                text: "late".into()
            }))
            .is_err()
        );
    }

    #[test]
    fn interruption_is_never_retryable_with_a_new_key_even_before_output() {
        for aggregate in [Aggregate::default(), begun()] {
            let (status, value) =
                aggregate.failure("delivery_interrupted", "interrupted", Some("c"));
            assert_eq!(status, StatusCode::BAD_GATEWAY);
            let error: f2z_ai_proto::error::ApiError =
                serde_json::from_value(value["error"].clone()).unwrap();
            assert!(error.code.retryable()); // exercise the transient Internal code
            assert!(!error.retryable()); // settlement dominates that code
            let failed = error.failed_call().unwrap().unwrap();
            failed.check().unwrap();
            assert_eq!(failed.call_id.as_deref(), Some("c"));
            assert_eq!(failed.settlement, f2z_ai_proto::Settlement::Pending);
            assert_eq!(failed.charged_2z, None);
        }
    }

    #[test]
    fn delivery_abort_maps_to_http_internal_and_preserves_pending() {
        let mut a = begun();
        a.push(Event::Error(ErrorEvent {
            code: ErrorCode::DeliveryAborted,
            message: "delivery ended".into(),
            settlement: f2z_ai_proto::Settlement::Pending,
            charged_2z: None,
            receipt_id: None,
            collected_milli_2z: None,
            shortfall_milli_2z: None,
            partial: true,
        }))
        .unwrap();
        let (status, value) = a.finish(None);
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(value["error"]["code"], "internal");
        assert_eq!(value["error"]["details"]["reason"], "delivery_interrupted");
        assert_eq!(value["error"]["details"]["call_id"], "c");
        assert!(value["error"]["details"].get("charged_2z").is_none());
    }

    #[test]
    fn tool_arguments_remain_exact_text_in_the_response_union() {
        let mut a = begun();
        let arguments = "{invalid JSON is still provider output";
        a.push(Event::ToolCall(f2z_ai_proto::chat::ToolCall {
            id: "t".into(),
            name: "lookup".into(),
            arguments: arguments.into(),
        }))
        .unwrap();
        a.push(Event::Usage(UsageEvent {
            usage: Usage::default(),
            source: UsageSource::Provider,
        }))
        .unwrap();
        a.push(Event::Done(Done::settled(
            Whole2z::new(1),
            "receipt",
            FinishReason::ToolCalls,
        )))
        .unwrap();
        let (status, value) = a.finish(None);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["message"]["tool_calls"][0]["arguments"], arguments);
    }

    #[tokio::test]
    async fn response_memory_reservation_is_bounded_and_follows_body_lifetime() {
        let bytes = 1024 * MEMORY_FACTOR;
        let budget = Arc::new(Semaphore::new(bytes));
        let reservation = Reservation::acquire(&budget, 1024).unwrap();
        assert_eq!(budget.available_permits(), 0);
        assert_eq!(
            Reservation::acquire(&budget, 1024).err().unwrap().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        let body = ReservedBody {
            body: Body::from("answer"),
            _permit: reservation.permit,
        };
        assert_eq!(budget.available_permits(), 0);
        drop(body);
        assert_eq!(budget.available_permits(), bytes);
    }
}
