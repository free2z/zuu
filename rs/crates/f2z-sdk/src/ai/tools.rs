//! Function tools: the types, a fragment assembler for live display, and a
//! helper that runs the tool-call round trip (zuu#1128).
//!
//! The gateway never runs a tool. The model asks for one (a `tool_call`
//! event, `finish_reason: "tool_calls"`); the app runs it and sends the
//! result back as a `tool` message in a **new** call. [`Ai::run_tools`] does
//! that loop. Every round is its own paid call with its own receipt.

use std::collections::BTreeMap;
use std::future::Future;

use f2z_ai_proto::ChatRequest;
use f2z_ai_proto::chat::{ContentPart, FinishReason, Message, Role};
pub use f2z_ai_proto::chat::{Tool, ToolCall, ToolChoice};
pub use f2z_ai_proto::event::ToolCallDelta;

use super::{Ai, ChatOptions, Completion};
use crate::error::{Error, SignedOutReason};

/// A function tool: `parameters` is the JSON Schema of the arguments object.
/// Pass an [`f2z_ai_proto::OrderedJson`] parsed from the schema's text to
/// keep its member order; a `serde_json::Value` (e.g. `json!`) also works,
/// but its members are already sorted by name.
#[must_use]
pub fn function_tool(
    name: impl Into<String>,
    description: impl Into<String>,
    parameters: impl Into<f2z_ai_proto::OrderedJson>,
) -> Tool {
    Tool {
        name: name.into(),
        description: Some(description.into()),
        parameters: parameters.into(),
        strict: None,
    }
}

/// The `tool` message answering `call` with `content` (usually JSON text).
#[must_use]
pub fn tool_result(call: &ToolCall, content: impl Into<String>) -> Message {
    Message {
        role: Role::Tool,
        content: vec![ContentPart::Text {
            text: content.into(),
        }],
        tool_calls: vec![],
        tool_call_id: Some(call.id.clone()),
    }
}

impl Completion {
    /// The reply as an `assistant` message for the next request's history:
    /// its text (if any) and its tool calls.
    #[must_use]
    pub fn assistant_message(&self) -> Message {
        Message {
            role: Role::Assistant,
            content: if self.text.is_empty() {
                vec![]
            } else {
                vec![ContentPart::Text {
                    text: self.text.clone(),
                }]
            },
            tool_calls: self.tool_calls.clone(),
            tool_call_id: None,
        }
    }
}

/// A tool call still arriving, assembled from `tool_call_delta` fragments.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PartialToolCall {
    /// The call's id, once a fragment carried it.
    pub id: Option<String>,
    /// The function name, once a fragment carried it.
    pub name: Option<String>,
    /// The argument text so far — usually not yet valid JSON.
    pub arguments: String,
}

/// Assembles `tool_call_delta` fragments by `index`, for showing a call
/// taking shape ("checking your answer…"). Display only: run a tool from
/// the complete `tool_call` event, never from a partial call.
#[derive(Clone, Debug, Default)]
pub struct ToolCallAssembler {
    calls: BTreeMap<u32, PartialToolCall>,
}

impl ToolCallAssembler {
    /// Add one fragment; returns the call it belongs to, so far.
    pub fn push(&mut self, fragment: &ToolCallDelta) -> &PartialToolCall {
        let call = self.calls.entry(fragment.index).or_default();
        if let Some(id) = &fragment.id {
            call.id = Some(id.clone());
        }
        if let Some(name) = &fragment.name {
            call.name = Some(name.clone());
        }
        call.arguments.push_str(&fragment.arguments);
        call
    }

    /// Every call seen so far, by index.
    pub fn calls(&self) -> impl Iterator<Item = (u32, &PartialToolCall)> {
        self.calls.iter().map(|(i, c)| (*i, c))
    }
}

/// What [`Ai::run_tools`] did — including when a later round failed, so
/// the earlier rounds' receipts and the tool results already produced are
/// never lost.
#[non_exhaustive]
#[derive(Debug)]
pub struct ToolRun {
    /// Every call that completed, in order — each one paid for separately;
    /// read each one's `charge`.
    pub rounds: Vec<Completion>,
    /// The conversation so far: the request's messages, then each completed
    /// round's assistant turn and the results of the tools that ran.
    pub messages: Vec<Message>,
    /// The `Idempotency-Key` of each round attempted, in order (one more
    /// than `rounds` when the last attempt failed): the key of a failed
    /// round recovers its outcome without a new paid call.
    pub keys: Vec<String>,
    /// Why the run stopped early: the round after the last in `rounds`
    /// failed with this, and was not retried. Resume from `messages` with a
    /// new call; do not re-run tools whose results are already there.
    pub error: Option<Error>,
}

impl ToolRun {
    /// The last call's completion.
    #[must_use]
    pub fn last(&self) -> Option<&Completion> {
        self.rounds.last()
    }

    /// Whether the model finished without asking for another tool. `false`
    /// means tool calls are still pending in [`ToolRun::last`] and were
    /// **not** run: `max_rounds` ran out, or the turn was cut off
    /// (`finish_reason` `length`, `content_filter`, …), so its calls'
    /// arguments may be truncated.
    #[must_use]
    pub fn finished(&self) -> bool {
        self.error.is_none() && self.rounds.last().is_some_and(|c| c.tool_calls.is_empty())
    }
}

/// Whether a turn that stopped for `reason` produced calls that may run:
/// only one that finished normally. On `length` (the output cap, possibly
/// lowered for affordability) the last call's arguments can be cut off.
/// `stop` is accepted beside `tool_calls` because a forced `tool_choice`
/// can end a complete call turn with `stop`.
fn runs_tools(reason: FinishReason) -> bool {
    matches!(reason, FinishReason::ToolCalls | FinishReason::Stop)
}

/// The most rounds one [`Ai::run_tools`] run may make: every round is a
/// separate paid call, so a model that keeps asking for tools can cost at
/// most this many calls. A `max_rounds` of `0` or above it is refused
/// ([`Error::Config`] in [`ToolRun::error`]) before any call.
pub const MAX_TOOL_ROUNDS: u32 = 32;

/// The request for round `round` (from 0): a forcing `tool_choice` applies
/// to the first round only.
fn next_round(request: &mut ChatRequest, round: u32) {
    if round > 0
        && matches!(
            request.tool_choice,
            Some(ToolChoice::Required | ToolChoice::Function { .. })
        )
    {
        request.tool_choice = Some(ToolChoice::Auto);
    }
}

impl Ai {
    /// The tool-call round trip: call the model; while it asks for tools,
    /// run each with `handler`, append its result as a `tool` message, and
    /// call again — at most `max_rounds` calls in all (`1..=`
    /// [`MAX_TOOL_ROUNDS`]; anything else is refused before any call).
    ///
    /// * Every round is a separate paid call ([`Ai::complete`]) with a fresh
    ///   `Idempotency-Key`; [`ToolRun::rounds`] carries each charge.
    /// * `handler` gets each complete call and returns the result text the
    ///   model will read (usually JSON). Report a tool's own failure *in*
    ///   that text (`{"error": "…"}`) so the model can respond to it.
    /// * Calls run only from a turn that finished normally (`tool_calls` or
    ///   `stop`); a turn cut off at `length` (or filtered) ends the run with
    ///   its calls unrun ([`ToolRun::finished`] is `false`).
    /// * A forcing `tool_choice` (`required`, or a named function) applies
    ///   to the **first** round only; later rounds send `auto`, or a forced
    ///   choice would make the model call a tool every round until
    ///   `max_rounds`.
    ///
    /// The session is checked before each tool runs, but `handler` is your
    /// code: a sign-in can land between that check and the tool's own work,
    /// so a tool that acts on account data should bind to the user it was
    /// started for rather than read "the current user".
    ///
    /// The run is bound to the session it started in: if the user signs out
    /// or switches account, it stops (`Error::SignedOut`) before the next
    /// tool runs or the next call is sent — never sending one user's history,
    /// or charging, as another.
    ///
    /// Each round is sent without automatic new-key retries (its
    /// `max_retries` is forced to `0`), so [`ToolRun::keys`] is exactly the
    /// key each round's call carried; a retryable refusal comes back as
    /// [`ToolRun::error`] for the app to retry.
    ///
    /// A failure never discards what came before it: the run is returned
    /// with [`ToolRun::error`] set, the completed rounds and their charges,
    /// the history including every tool result already produced, and each
    /// round's key ([`Ai::run_tools_with`] lets you choose and persist them
    /// first). Dropping the future stops the loop, including between tools.
    pub async fn run_tools<F, Fut>(
        &self,
        request: ChatRequest,
        max_rounds: u32,
        handler: F,
    ) -> ToolRun
    where
        F: FnMut(ToolCall) -> Fut,
        Fut: Future<Output = String>,
    {
        self.run_tools_with(request, max_rounds, |_| ChatOptions::default(), handler)
            .await
    }

    /// [`Ai::run_tools`] with each round's [`ChatOptions`] from `options`
    /// (called with the round, from 0) — to choose, and persist before the
    /// call, each round's `Idempotency-Key`. Give every round its own key: a
    /// reused key replays that round's receipt instead of calling again.
    pub async fn run_tools_with<O, F, Fut>(
        &self,
        mut request: ChatRequest,
        max_rounds: u32,
        mut options: O,
        mut handler: F,
    ) -> ToolRun
    where
        O: FnMut(u32) -> ChatOptions,
        F: FnMut(ToolCall) -> Fut,
        Fut: Future<Output = String>,
    {
        let mut rounds = Vec::new();
        let mut keys = Vec::new();
        if max_rounds == 0 || max_rounds > MAX_TOOL_ROUNDS {
            return ToolRun {
                rounds,
                messages: request.messages,
                keys,
                error: Some(Error::Config(format!(
                    "max_rounds must be 1..={MAX_TOOL_ROUNDS}"
                ))),
            };
        }
        let session = match self.client.session_generation().await {
            Ok(generation) => generation,
            Err(error) => {
                return ToolRun {
                    rounds,
                    messages: request.messages,
                    keys,
                    error: Some(error),
                };
            }
        };
        // Whether the user is still the one the run started with.
        let same_user = || async {
            match self.client.session_generation().await {
                Ok(now) if now == session => Ok(()),
                Ok(_) => Err(Error::SignedOut(SignedOutReason::SessionChanged)),
                Err(error) => Err(error),
            }
        };
        for round in 0..max_rounds {
            next_round(&mut request, round);
            let mut chosen = options(round);
            chosen.max_retries = 0;
            chosen.session = Some(session);
            let completion = match chosen.idempotency_key.clone() {
                Some(key) => Ok(key),
                None => crate::random::uuid_v4(),
            };
            let completion = match completion {
                Ok(key) => {
                    keys.push(key.clone());
                    chosen.idempotency_key = Some(key);
                    match self.chat_with(request.clone(), chosen).await {
                        Ok(stream) => stream.collect().await,
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error),
            };
            let completion = match completion {
                Ok(completion) => completion,
                Err(error) => {
                    return ToolRun {
                        rounds,
                        messages: request.messages,
                        keys,
                        error: Some(error),
                    };
                }
            };
            request.messages.push(completion.assistant_message());
            let calls = completion.tool_calls.clone();
            let runnable = runs_tools(completion.done.finish_reason);
            rounds.push(completion);
            if calls.is_empty() || !runnable || round.saturating_add(1) == max_rounds {
                break;
            }
            for call in calls {
                if let Err(error) = same_user().await {
                    return ToolRun {
                        rounds,
                        messages: request.messages,
                        keys,
                        error: Some(error),
                    };
                }
                let output = handler(call.clone()).await;
                request.messages.push(tool_result(&call, output));
            }
        }
        ToolRun {
            rounds,
            messages: request.messages,
            keys,
            error: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragments_assemble_by_index_and_a_result_answers_its_call() {
        let mut assembler = ToolCallAssembler::default();
        for fragment in [
            ToolCallDelta {
                index: 0,
                id: Some("call_q1".into()),
                name: Some("check_answer".into()),
                arguments: String::new(),
            },
            ToolCallDelta {
                index: 1,
                id: Some("call_q2".into()),
                name: Some("check_answer".into()),
                arguments: "{}".into(),
            },
            ToolCallDelta {
                index: 0,
                id: None,
                name: None,
                arguments: "{\"answer\":".into(),
            },
            ToolCallDelta {
                index: 0,
                id: None,
                name: None,
                arguments: "\"4\"}".into(),
            },
        ] {
            assembler.push(&fragment);
        }
        let calls: Vec<_> = assembler.calls().collect();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].1.arguments, "{\"answer\":\"4\"}");
        assert_eq!(calls[0].1.id.as_deref(), Some("call_q1"));
        assert_eq!(calls[1].1.arguments, "{}");

        let call = ToolCall {
            id: "call_q1".into(),
            name: "check_answer".into(),
            arguments: "{\"answer\":\"4\"}".into(),
        };
        let json = serde_json::to_value(tool_result(&call, "{\"correct\":true}")).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"role": "tool", "tool_call_id": "call_q1",
                "content": [{"type": "text", "text": "{\"correct\":true}"}]})
        );
    }

    #[test]
    fn only_a_turn_that_finished_normally_runs_its_calls() {
        assert!(runs_tools(FinishReason::ToolCalls));
        assert!(runs_tools(FinishReason::Stop));
        for cut in [
            FinishReason::Length,
            FinishReason::ContentFilter,
            FinishReason::Cancelled,
            FinishReason::Unknown,
        ] {
            assert!(!runs_tools(cut), "{cut:?}");
        }
    }

    #[test]
    fn a_forced_choice_applies_to_the_first_round_only() {
        let mut request: ChatRequest = serde_json::from_value(serde_json::json!({
            "model": "m", "messages": [],
            "tools": [{"name": "check_answer", "parameters": {"type": "object"}}],
            "tool_choice": {"type": "function", "function": {"name": "check_answer"}}
        }))
        .unwrap();
        next_round(&mut request, 0);
        assert!(matches!(
            request.tool_choice,
            Some(ToolChoice::Function { .. })
        ));
        next_round(&mut request, 1);
        assert_eq!(request.tool_choice, Some(ToolChoice::Auto));
        request.tool_choice = Some(ToolChoice::None);
        next_round(&mut request, 2);
        assert_eq!(request.tool_choice, Some(ToolChoice::None));
    }
}
