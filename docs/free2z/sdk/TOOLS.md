# Tool calling (function calling)

The model can ask your app to run a function — grade an answer, look up a
formula, fetch the student's progress — and then continue with the result.
The request and stream shapes follow OpenAI's Chat Completions; the gateway
translates them for each provider. The wire contract is
[spec/chat-api.md](spec/chat-api.md) §2.1 and §3.4; this page is the how-to.

**The gateway never runs a tool.** It relays the model's call to you, you run
it, and you send the result back in a **new** call. Every round of that loop
is a separate paid call with its own hold, charge and receipt.

## Which models

`GET /v1/models` says, per model:

| `capabilities` | Means |
|---|---|
| `tools: true` | `tools`, tool history, `tool_choice` and `parallel_tool_calls` are accepted |
| `strict_tools: true` | a tool with `strict: true` is accepted |

| Provider (adapter) | `tools` | `tool_choice` | `parallel_tool_calls` | `strict` | Streamed fragments |
|---|---|---|---|---|---|
| OpenAI (Chat Completions) | when signed | yes | yes | yes | piece by piece |
| xAI (Chat Completions) | when signed | yes ([docs.x.ai](https://docs.x.ai/docs/guides/function-calling): `auto`, `required`, `none`, a named function) | yes | **no** — not documented by xAI, refused | one fragment per call (xAI sends each call whole) |
| Anthropic, OpenAI Responses | when signed | refused (adapter work in progress) | refused | refused | none (complete calls only) |

Whatever a model cannot honour is refused **before any hold, charge or
provider request**: `400 invalid_request`, `details.reason:
"tools_unsupported"`, `details.field` naming the feature (`tools`,
`tools[0].strict`, `tool_choice`, `parallel_tool_calls`). It is never sent
without the feature and billed anyway. The same idempotency key replays that
refusal.

## The request

```json
{
  "model": "gpt-4o",
  "messages": [
    {"role": "system", "content": [{"type": "text", "text": "You are a patient algebra tutor. Grade every answer with check_answer before you reply."}]},
    {"role": "user", "content": [{"type": "text", "text": "Q1: solve 2x + 3 = 11. My answer: x = 4"}]}
  ],
  "tools": [{
    "name": "check_answer",
    "description": "Grade a student's answer to one question.",
    "parameters": {
      "type": "object",
      "properties": {"question_id": {"type": "string"}, "answer": {"type": "string"}},
      "required": ["question_id", "answer"],
      "additionalProperties": false
    },
    "strict": true
  }],
  "tool_choice": {"type": "function", "function": {"name": "check_answer"}},
  "parallel_tool_calls": false
}
```

- A tool is **flat** — `{name, description?, parameters, strict?}` — not
  OpenAI's `{"type":"function","function":{…}}` wrapper; the gateway adds the
  wrapper. `tool_choice` *is* OpenAI's shape.
- Limits, checked by the gateway and by every SDK before sending: at most 128
  tools; names 1–64 of `A-Z a-z 0-9 _ -`, unique; `parameters` a JSON Schema
  object of at most 32 KiB; `tool_choice` and `parallel_tool_calls` only
  beside `tools`; a named `tool_choice` must name one of them.
- `strict: true` (OpenAI) makes the arguments match the schema exactly; OpenAI
  then wants `additionalProperties: false` and every property in `required`.
  OpenAI does not guarantee strict schemas on parallel calls: pair `strict`
  with `parallel_tool_calls: false` when that matters.
- Definitions are input the model reads on **every** round: they are in the
  hold and in the provider-reported usage you pay for. Keep them small.

## The reply

Streamed, a tool turn looks like this (the `tool_call_delta` frames are
optional to read):

```
event: meta
data: {"call_id":"…","model":"gpt-4o","hold_2z":2}

event: tool_call_delta
data: {"index":0,"id":"call_q1","name":"check_answer","arguments":""}

event: tool_call_delta
data: {"index":0,"arguments":"{\"question_id\":\"q1\","}

event: tool_call_delta
data: {"index":0,"arguments":"\"answer\":\"x = 4\"}"}

event: tool_call
data: {"id":"call_q1","name":"check_answer","arguments":"{\"question_id\":\"q1\",\"answer\":\"x = 4\"}"}

event: usage
data: {"usage":{"input_tokens":96,"output_tokens":21,…},"source":"provider"}

event: done
data: {"finish_reason":"tool_calls","charged_2z":1,…}
```

- **Run tools from `tool_call`**, never from fragments (which are best
  effort: a client that reads slowly may miss some). `tool_call_delta` is
  for showing progress ("Checking your answer…"); a stream that fails
  mid-call leaves fragments and no `tool_call`, and that call must not run.
- `arguments` is the model's text, verbatim. Parse it and validate it against
  your schema — even with `strict`, it is untrusted input to your function.
- `finish_reason: "tool_calls"` means the model is waiting for results. Run
  calls only from a turn that finished normally: one that ended at
  `"length"` (the output cap, which the gateway may lower for affordability)
  can carry a call whose `arguments` were cut off. The SDK helpers stop there
  with the calls unrun. Pair tool calls with a generous `max_output_tokens`,
  or `max_output_tokens_strict`.
- Not streamed (`"stream": false`), the calls are in `message.tool_calls`;
  there are no fragments.

## Sending the result back

Append the assistant turn (with its `tool_calls`) and one `tool` message per
call, then make a new call:

```json
{"role": "assistant", "content": [], "tool_calls": [{"id": "call_q1", "name": "check_answer", "arguments": "{\"question_id\":\"q1\",\"answer\":\"x = 4\"}"}]},
{"role": "tool", "tool_call_id": "call_q1", "content": [{"type": "text", "text": "{\"correct\":true,\"explanation\":\"2(4)+3 = 11\"}"}]}
```

If your function failed, say so **in** the result (`{"error":"question not
found"}`) so the model can respond to it. A forcing `tool_choice` should not
be repeated on the follow-up call, or the model must call a tool again.

## The tutor, end to end

Both SDKs carry the loop: call, run each requested tool, answer, call again,
up to a round limit. Each round's charge is reported separately.

### Rust (`f2z-sdk`)

```rust
use f2z_sdk::ai::tools::{function_tool, ToolCall};
use f2z_sdk::proto::ChatRequest;
use f2z_sdk::proto::chat::ToolChoice;

async fn tutor(client: &f2z_sdk::Client, mut request: ChatRequest) -> Result<(), f2z_sdk::Error> {
    let mut check = function_tool(
        "check_answer",
        "Grade a student's answer to one question.",
        serde_json::json!({
            "type": "object",
            "properties": {"question_id": {"type": "string"}, "answer": {"type": "string"}},
            "required": ["question_id", "answer"],
            "additionalProperties": false
        }),
    );
    check.strict = Some(true); // only where capabilities.strict_tools
    request.tools = vec![check];
    request.tool_choice = Some(ToolChoice::Function { name: "check_answer".into() });
    request.parallel_tool_calls = Some(false);

    let run = client
        .ai()
        .run_tools(request, 3, |call: ToolCall| async move {
            #[derive(serde::Deserialize)]
            struct Args { question_id: String, answer: String }
            match serde_json::from_str::<Args>(&call.arguments) {
                Ok(args) => grade(&args.question_id, &args.answer).to_string(),
                Err(_) => r#"{"error":"arguments did not match the schema"}"#.into(),
            }
        })
        .await;
    if let Some(error) = run.error {
        // run.rounds (paid), run.messages (with the tool results that ran)
        // and run.keys survive the failure: resume from them, never re-run.
        return Err(error);
    }
    if let Some(last) = run.last() {
        println!("{}", last.text); // "Correct! 2(4) + 3 = 11 …"
    }
    for round in &run.rounds {
        println!("{:?}", round.charge); // one charge per call
    }
    Ok(())
}
// `grade` is your own code, returning e.g. {"correct": true, "explanation": "…"}.
```

`run_tools` applies a forcing `tool_choice` to the first round only, gives
every round a fresh `Idempotency-Key` (`run_tools_with` lets you choose and
persist each round's key first), runs calls only from a turn that finished
normally, and stops after `max_rounds` with any still-pending calls **unrun**
(`run.finished() == false`). It never returns an `Err`: a failed round sets
`run.error` and keeps everything before it. The run is bound to the session it started in:
a sign-out or account switch stops it (`Error::SignedOut`) before the next
tool or call. Rounds are sent without automatic new-key retries, so
`run.keys` is exactly what each round carried. For live progress,
read the stream yourself with `Ai::chat` and feed each `Event::ToolCallDelta`
to `tools::ToolCallAssembler`.

### TypeScript (`@free2z/sdk`, web and Tauri)

```ts
import { runTools, ToolCallAccumulator, type ChatRequest } from "@free2z/sdk";

const request: ChatRequest = {
  model, // capabilities.tools (and strict_tools, for strict) in /v1/models
  messages,
  tools: [{
    name: "check_answer",
    description: "Grade a student's answer to one question.",
    parameters: {
      type: "object",
      properties: { question_id: { type: "string" }, answer: { type: "string" } },
      required: ["question_id", "answer"],
      additionalProperties: false,
    },
    strict: true,
  }],
  tool_choice: { type: "function", function: { name: "check_answer" } },
  parallel_tool_calls: false,
};

const run = await runTools(
  client,
  request,
  async (call) => {
    const args = JSON.parse(call.arguments); // validate before use
    return JSON.stringify(await grade(args.question_id, args.answer));
  },
  {
    maxRounds: 3,
    // Each round is a new billable operation: create AND persist its keys.
    operation: async (round) => journal.newChatOperation(round),
  },
);
show(run.rounds.at(-1)?.text);
for (const round of run.rounds) record(round.callId, round.charge);
```

The TS SDK never invents operation or idempotency keys, so `runTools` asks
you for each round's. A failure (a refused round, a handler that throws, or
the round's `signal` aborted between tools) does not throw: the run comes
back with `error` set and every completed round, tool result and operation
kept. A round that fails after producing output stays in `rounds` with `error` set
and its `charge`, so a charged failure is never lost from your accounting.
Each handler also receives a `ToolContext` (`sessionGeneration`, `subject`)
naming the session the run is bound to: a tool that acts on account data
should act as that session, because a sign-in can land between the SDK's
pre-handler session check and the tool's own work.
A sign-out or account switch stops it (`error.code` `"signed_out"`, or
`"session_changed"` from the native plugin) before the next tool or call:
every round is sent with `ChatOptions.sessionGeneration` pinned to the
session the run started in, which the transport — and, on Tauri, the native
registration itself — enforces. A cancel during the last tool of a round
stops the run before the next round. To show a call taking shape, iterate `client.chat(...)`
yourself and push each `tool_call_delta` event into a `ToolCallAccumulator`.

## Errors

| Status / code | `details` | Means |
|---|---|---|
| `400 invalid_request` | `reason: "tools_unsupported"`, `field` | The model or its adapter cannot honour that feature; nothing was held or sent |
| `400 invalid_request` | `field: "tools[i].name"` etc., `reason` a limit | A structural limit; the SDKs refuse it before sending |
| `400 invalid_request` | `field: "tool_choice"`, `reason: "unsupported"` / `"null"` | Not one of OpenAI's four shapes (e.g. Anthropic's `"any"`) |
| `provider_error` before any output | — | The provider refused the translated request (e.g. a schema its `strict` mode rejects); the hold is released and nothing is charged |
