# AI gateway conformance corpus

One corpus, one runner, every adapter (free2z/zuu#1147; design:
[`docs/free2z/sdk/ai-api-design.md`](../../../../../../docs/free2z/sdk/ai-api-design.md)
§3.4, slice S10a). Every later AI-API slice adds **fixtures here**, not
tests: a feature is supported when the corpus proves it on every
`api_style` that claims it, and refused (typed, before any hold) everywhere
else.

The runner is [`tests/conformance.rs`](../../conformance.rs); its machinery
(schema, comparators, mutation engine, harness) is
[`tests/conformance_support/mod.rs`](../../conformance_support/mod.rs).
Every rule below is enforced there — a fixture that breaks one fails CI with
the rule's name, it is never skipped.

## The rule: no live provider, ever

No test calls a real provider. Every `provider_stream` is either a synthetic
stream in the provider's **documented** shape, or a capture someone made with
a real key and **scrubbed** of ids and content (`"recorded": true`). `source`
names the documentation (or the capture) the shape came from, so a reviewer
can check it. CI has no provider keys and must never need one.

## Layout

```
conformance/
  <feature>/
    <name>.json        one fixture; `name` is the file stem, `feature` the directory
    mutations.json     the feature's negative controls (required, non-empty)
```

Features today: `text`, `structured_output`, `tool_calling`. A new
directory must be added to `FEATURES` in `conformance_support/mod.rs`, with
the signed capability a success fixture of it must declare; an unknown
directory, a stray file, or a feature without `mutations.json` is a failure.

## A fixture

```jsonc
{
  "name": "openai_chat_json_schema_strict",
  "feature": "structured_output",
  "source": "where the shape came from (documentation URL / section, or the capture)",
  "recorded": false,                       // optional; true only for a scrubbed real capture
  "api_style": "openai_chat",              // openai_chat | openai_responses | anthropic_messages
  "provider": "openai",                    // openai | xai | anthropic
  "catalog_model": {                       // the signed members the fixture assumes
    "capabilities": { "structured_output": true },
    "controls": { },                       // optional, ai-api-design §3.3 (read by no gateway yet)
    "limits": { }                          // optional, ditto
  },
  "request": { "model": "m-openai-chat", "messages": [ ], "response_format": { } },
  "expect": {
    "refusal": null,
    "provider_request": { "response_format": { }, "tools": null },
    "provider_stream": [ ],
    "events": [ { "type": "delta", "text": "…" } ],
    "finish_reason": "stop",
    "usage": { "input_tokens": 120, "output_tokens": 33 },
    "hold_extends": 0,
    "encodings": { }
  }
}
```

- **`request`** is the unified `/v1/chat` `ChatRequest`, member order as
  written (schemas keep it end to end, zuu#1132). It names its model; it must
  **not** set `stream` — the runner runs every fixture with `stream: true` and
  `stream: false`.
- **`catalog_model`** builds the fixture's own one-model catalogue
  (`request.model`, `provider`, `api_style`, these members, test prices).
  Nothing is inherited from another fixture.
- **`expect.provider_request`** — the exact members the provider must
  receive, compared against the **bytes** the mock received
  (`RecordedRequest::body_text`):
  - a listed member must be present with exactly that value; `null` means it
    must be **absent**;
  - **member order is compared inside JSON Schemas** (`parameters`,
    `input_schema`, `schema`, at any depth below them) and arrays are always
    order-sensitive; elsewhere an object is the gateway's own construction and
    only its members and values count;
  - any member the provider received that is **not** listed must be one of the
    style's transport/conversation members (`baseline_members`:
    `model`, `messages`/`input`/`system`, the output cap, `stream`,
    `stream_options`, `service_tier`, `store`). Anything else that reaches a
    provider body unlisted is red — a leaked member is a test failure, not a
    review finding;
  - `stream` is always `true` upstream.
- **`expect.provider_stream`** — what the mock replays, byte for byte
  (`f2z_ai_testkit::mock::Scenario::with_replay`). Either a string (the raw
  body) or an array of frames: a string item is `data: <it>`; an object is
  `data: <json>` for `openai_chat` and `event: <its type>` + `data: <json>`
  for the named-event styles. Absent = a **request-only** fixture: the mock
  renders its own stream, and the fixture must then not pin `events`,
  `finish_reason` or `usage` (they would assert the mock, not the gateway).
- **`expect.events`** — the content events the client receives, in order
  (`delta`, `tool_call`, and `tool_call_delta` once #1142 lands); the runner
  checks `meta` first, one `usage` just before `done`, `done` last, and no
  `error`. With `stream: false` the same expectation is folded into the
  reply: all text as one message, then the complete calls in order, and no
  `tool_call_delta`. Every tool call's `arguments` must parse as JSON.
- **`expect.usage`** — the listed members of the normalised usage, exactly
  (list `tool_calls: 0` to pin that a function call is never billed as a
  server tool).
- **`expect.hold_extends`** — the ledger's heartbeat extensions during the
  call. The runner also asserts exactly one hold and a settlement.
- **`expect.encodings`** — the compat-encoding slot (S6–S8: Chat Completions,
  Responses, Messages renderings). It must be `{}` until those land: data the
  runner cannot yet check would read as proof.
- **`expect.refusal`** — instead of everything above (which must then be
  absent): `{"status", "code", "details"}`, where `details` lists the members
  of `error.details` that must match exactly. The runner posts the request to
  `/v1/chat` (streamed and not) and `/v1/chat/estimate` and asserts the typed
  refusal with **no hold** and **no provider request**.

### The corpus cannot lie about gating

The capabilities a request exercises are derived from the request itself
(`tools`/`tool_choice`/`parallel_tool_calls` → `tools`, `tools[].strict:
true` → `strict_tools`, `response_format` → `structured_output`, an image
part → `vision`), plus the feature directory's own capability. A **success**
fixture whose `catalog_model.capabilities` does not carry every one of them
as `true` is refused by the runner. And for every one of them, the runner
re-runs the success fixture against a catalogue that sets it `false` and
requires the typed refusal before any hold or provider request — so a
success fixture also proves the gateway gates on the signed catalogue.

## Negative controls: `mutations.json`

```jsonc
{
  "feature": "structured_output",
  "mutations": [
    { "name": "drop strict", "target": "provider_request", "op": "remove",
      "path": "/response_format/json_schema/strict" },
    { "name": "flip strict", "target": "provider_request", "op": "replace",
      "path": "/response_format/json_schema/strict", "value": false,
      "fixtures": ["openai_chat_json_schema_strict"] }
  ]
}
```

Each mutation is applied to what the gateway **really** sent and produced
(stream mode) and the comparator must report it. `target` is
`provider_request`, `events`, `usage` or `finish_reason`; `op` is `remove`,
`replace` (`value`), `add` (`value`; the member must be absent) or `reverse`
(an array's items or an object's members). `path` is a JSON Pointer; `-1`
is an array's last item; `""` is the whole value. Without `fixtures` it
applies to every success fixture of the feature it can change; with
`fixtures`, each named one must be changed. A mutation that changes nothing
anywhere fails — a control that controls nothing is worse than none. CI runs
them all (`every_mutation_in_the_corpus_is_caught`), and
`the_corpus_controls_dropping_tool_choice_response_format_and_strict` keeps
the controls for a dropped `tool_choice`, `response_format` and `strict` from
being deleted.

## Adding a fixture

1. Pick the feature directory; name the file `<api_style or provider>_<what>.json`.
2. Write `source` first. If you cannot name the documentation or capture the
   stream follows, you do not have a fixture yet.
3. Declare every capability the request exercises in `catalog_model`.
4. List every member the provider must receive beyond the baseline, with
   `null` for each one that must stay out (the OpenAI members on an Anthropic
   body, `service_tier` on xAI).
5. Add or extend a mutation that drops/changes what your fixture is about,
   and check it is caught: `cargo test -p f2z-ai --test conformance`.

## Provenance

The `anthropic_*` stream and request fixtures were migrated from
`tests/fixtures/anthropic/{streams,requests}.json` and `*.sse` (#1140) with
the same assertions (stream bodies copied byte for byte); that runner,
`tests/anthropic_conformance.rs`, still runs alongside until its fixtures
are removed in a follow-up. #1142's `tests/fixtures/tool_calling/*` (Chat
Completions / xAI tool calling, `tool_call_delta`) migrate into
`tool_calling/` the same way once it merges.
