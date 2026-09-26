# The chat API — `ai.free2z.cash/v1`

**Status:** v1 contract · **Part of:** [f2z-sdk v1](../README.md) ·
**Refs:** [#1047](https://github.com/free2z/zuu/issues/1047),
[#1048](https://github.com/free2z/zuu/issues/1048),
[#1049](https://github.com/free2z/zuu/issues/1049) (`f2z-ai-proto`, the
types)

The gateway exposes **one** chat API across several providers. A client
never chooses a provider's native format, never sends a provider key, and
never sees a provider's own error shape. The wire types in this document
are those of `f2z-ai-proto` (`chat`, `event`, `error`); the OpenAPI
document generated from that crate (D3) is the field-level reference and
MUST agree with this text. Two rules from the crate hold everywhere:
**requests are strict** — an unknown field is `400 invalid_request`, never
ignored — and **responses and events are tolerant** — a client MUST ignore
fields and event names it does not know, so the gateway can add to them
without breaking a deployed SDK. Where this document shows a response
field the crate does not yet define, it is such an addition.

## 1. Common rules

| Item | Rule |
|---|---|
| Base URL | `https://ai.free2z.cash/v1` |
| Authentication | `Authorization: Bearer <access_token>` — an access token from [oidc.md](./oidc.md) whose `aud` contains `f2z-ai` and whose `scope` contains `ai:invoke`. Nothing else is accepted |
| Content type | Requests are `application/json`, UTF-8. Responses are `application/json` or `text/event-stream` |
| Request body limit | 4 MiB for a request without image parts; 20 MiB with. Larger is `413 payload_too_large` |
| Errors | Every non-2xx response is the envelope in [errors.md](./errors.md); whether a code is retryable, and which status it arrives with, are properties of the code (`f2z-ai-proto::ErrorCode`) |
| Ids | `call_id` is a UUIDv7 assigned by the gateway and returned in the `X-F2Z-Call-Id` response header on every `/v1/chat` response, streamed or not, including errors after a call was created |
| Idempotency | `Idempotency-Key` header, 1–128 ASCII characters, scoped to (app, user). Recommended on every `/v1/chat` (§2.5) |
| Rate limits | Per (app, user): a token bucket on requests and a concurrency limit of **4 open streams per user**. Exceeding either is `429` with `Retry-After` (§7) |
| Timeouts | Connect and first-byte limits are per model and published in `/v1/models`; a stream that produces nothing for **60 s** ends with `error provider_timeout`; no call runs longer than **300 s** |

## 2. `POST /v1/chat`

### 2.1 Request

```json
{
  "model": "gpt-5-mini",
  "messages": [
    { "role": "system", "content": [ { "type": "text", "text": "You are a patient maths tutor." } ] },
    { "role": "user", "content": [
        { "type": "text", "text": "What is wrong with my working?" },
        { "type": "image", "media_type": "image/png", "data": "iVBORw0KGgo..." }
    ] },
    { "role": "assistant", "content": [ { "type": "text", "text": "Let me look at line 3." } ] },
    { "role": "tool", "tool_call_id": "call_9a1", "content": [ { "type": "text", "text": "{\"answer\": 42}" } ] }
  ],
  "tools": [
    { "name": "lookup_formula",
      "description": "Find a formula by name",
      "parameters": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] } }
  ],
  "max_output_tokens": 800,
  "stream": true,
  "fallback": ["gpt-5-nano"],
  "metadata": { "lesson": "quadratics-3" }
}
```

| Field | Type | Rules |
|---|---|---|
| `model` | string | An `id` from `/v1/models`. Unknown → `404 model_not_found`; present but not callable → `403 model_disabled` |
| `messages` | array | At least one. Roles: `system` (at most one, first), `user`, `assistant`, `tool`. `content` is **always an array of parts** — there is no string shorthand, so a message has one shape |
| `messages[].content[]` | part | `{"type":"text","text":…}` or `{"type":"image","media_type":…,"data":<standard base64>}`. Image `media_type` ∈ `image/png`, `image/jpeg`, `image/webp`, `image/gif`; at most 20 images per request. **URLs are not accepted**: there is no URL part type, because the gateway never fetches a client-supplied URL. Image parts on a model without `capabilities.vision` → `400 invalid_request` |
| `messages[].tool_calls` | array | On an `assistant` message: the tool calls the assistant previously made, each `{id, name, arguments}` with `arguments` a JSON string |
| `messages[].tool_call_id` | string | Required on a `tool` message |
| `tools` | array | Function tools, each `{name, description?, parameters}` with `parameters` a JSON Schema object. The gateway **never executes a tool**: it relays the model's call to the client and the client's result back on the next request. Provider-hosted tools (web search, code execution, file search) are not available on this endpoint in v1 ([ADR 0003](../../ai-gateway/adr/0003-unified-api-before-passthrough.md)) |
| `max_output_tokens` | integer | 1 … the model's `max_output_tokens`, which is also the default when omitted. It bounds **total** generated tokens, reasoning included. The gateway may **clamp** it lower for affordability (§2.2) and never raises it; the effective value is reported in `meta` |
| `stream` | boolean | Default `true`. `false` returns one JSON document (§4) |
| `fallback` | array of model ids | Opt-in. If the *first* model fails with a provider-side error **before the gateway has committed to it** — that is, before its first content event, which is also when `meta` is sent (§3.2) — the gateway retries once on the next id, re-holding at that model's price. Never after `meta`. The model actually used is in `meta` |
| `metadata` | object | Up to 16 string keys, each key ≤ 64 and value ≤ 256 characters. Stored with the call record and returned by `GET /v1/calls/{id}`; never sent to a provider |

Anything not listed is rejected with `400 invalid_request` naming the field;
the gateway does not pass unknown fields through. **Not in v1**, and
therefore refused rather than ignored: `temperature` and other sampling
controls, `tool_choice`, response-format modes, audio and file parts.
Each arrives, if it does, as a priced, documented addition.

### 2.2 What happens before the first byte

In order. Each step's failure is an error response *before* any stream
begins, so a client that has received `meta` knows every check passed.

1. **Token.** Signature, `iss`, `aud`, `exp`, `aep`, `agen`
   ([oidc.md](./oidc.md) §6). Failure → `401 invalid_token` /
   `401 token_revoked`. A valid token without `ai:invoke` →
   `403 insufficient_scope`. Revocation state unknown → `503 unavailable`.
2. **Rate limits and concurrency.** → `429`.
3. **Catalogue.** The model exists, is enabled, and the app may use it. →
   `404 model_not_found` / `403 model_disabled`.
4. **Input estimate.** The gateway tokenises the input (exactly for models
   whose tokeniser it has; with a per-model safety factor otherwise) and
   refuses input that cannot fit the context window with at least one output
   token: `400 context_length_exceeded`.
5. **Output clamp.** `out_cap = min(max_output_tokens, context_window −
   input_estimate, affordable)`, where `affordable` is the largest output
   length whose worst-case price fits the user's available balance *and* the
   grant's remaining cap ([metering.md](./metering.md) §4). If even the
   model's minimum charge is unaffordable → `402 insufficient_balance` or
   `403 cap_exceeded`.
6. **Hold.** The ledger reserves the worst-case price for `out_cap`. The
   ledger's own answer decides: `402`, `403 cap_exceeded`,
   `403 account_frozen`, `409 too_many_holds`.
7. **Provider request.** A provider error here, on the primary and any
   `fallback`, releases the hold and answers `502 provider_error`,
   `503 unavailable` or `504 provider_timeout`. Nothing was charged.

The HTTP response headers (§2.3) are sent as soon as the hold exists —
step 6 — so that the client's connection is established and `: ping`
comments can flow while the provider is contacted. **The commitment
point is `meta`**, sent when the provider's first content event arrives
(or its completion, for an empty answer). Until `meta`, a provider failure
is handled as step 7: `fallback` may switch models, and because no `meta`
has been sent the switch is invisible except through `meta.requested_model`.
A provider failure that cannot be recovered before `meta` is delivered as
an `error` event (§3.7) with `charged_2z: 0` — the stream has already
begun at the HTTP level, so an HTTP status can no longer carry it.

### 2.3 Streamed response

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-store
X-F2Z-Call-Id: 019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c
```

followed by the events of §3.

### 2.4 Cancellation

The client cancels by **closing the connection** (an `AbortSignal` in the
TypeScript SDK; dropping the cancel handle in Rust). The gateway drops the
upstream request immediately, then settles the call for what was produced
([metering.md](./metering.md) §5.3). There is no cancel endpoint: a closed
connection is unambiguous and cannot be forged. `GET /v1/calls/{id}` shows
the final state.

### 2.5 Idempotency

A request that carries `Idempotency-Key` is replayed safely: a second
`POST /v1/chat` with the same key from the same (app, user) within **24
hours** returns the *same* call — the same `call_id`, and:

- if the original is still streaming or settling, the replay is refused
  with `409 idempotency_conflict` (`details.call_id` names it) — two
  consumers of one stream is not a thing the gateway does;
- if the original finished — in `done` **or** `error` — the replay answers
  `200` with the **call record** of §7 (`replayed: true`), regardless of
  `stream`, and charges nothing. The record has no message content: the
  gateway does not retain completions (§7), so idempotency protects the
  charge, not the delivery. A client that lost the stream re-asks with a
  new key, and that is a new call;
- if the body differs from the original, `409 idempotency_conflict`.

Without a key, every request is a new call. SDKs generate a key per logical
call so that a retried request after a network failure never double-charges.
The two uses are distinct and an SDK keeps them so: **re-sending with the
same key** is receipt recovery — "did my call happen, and what did it
cost?" — and can never do new work; **retrying a failed call** that the
user wants attempted again is a new key. In particular a call that failed
before `meta` with a retryable code is recorded as failed, and re-sending
its key returns that record forever; the SDK's retry uses a fresh key.

## 3. The SSE event grammar

The stream is [Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html):
UTF-8, each event a block of `event:`, `id:` and `data:` lines terminated by a
blank line. `data` is always one JSON object on one line. `id` is the
event's sequence number, from `1`, for logging; the gateway does not support
`Last-Event-ID` resumption in v1 — a dropped connection is a cancellation
(§2.4). Comment lines (`: ping`) are sent every **15 seconds** while
waiting on the provider and MUST be ignored.

### 3.1 Grammar

```
stream   := meta (delta | tool_call)* usage? (done | error)
          | error
```

- Exactly one `meta`, always first — except that a stream whose provider
  attempt (and any `fallback`) failed before the gateway could commit
  consists of a single `error` event with `charged_2z: 0` (§2.2). That
  lone `error` may carry any code the pre-stream steps can produce —
  `provider_error`, `provider_timeout`, `unavailable`, `internal`, and,
  when a `fallback` hold could not be taken, `insufficient_balance`,
  `cap_exceeded` or `token_revoked` — because the HTTP status is already
  `200` by then.
- Zero or more `delta` and `tool_call`, in the order the model produced them.
- At most one `usage`, and if present it comes after the last `delta` /
  `tool_call` and before the terminal event.
- Exactly one terminal event, `done` or `error`, after which the gateway
  closes the connection. A stream that ends without a terminal event was
  cut by the network; the client treats it as `error stream_interrupted`
  locally and consults `GET /v1/calls/{id}` for the outcome.

Clients MUST ignore event names they do not know (future events are added as
new names, never as new shapes of existing ones), MUST ignore unknown
fields in known events, and MUST tolerate an unknown value of an
enumerated field such as `source`, `finish_reason` or `code` by treating
it as "unknown" rather than failing the stream. A client parsing SSE by
hand MUST strip one trailing CR from an `event:` name before matching it,
so that a `\r\n`-framed stream still names its events; `f2z-ai-proto`'s
parser does this. The same tolerance applies to the IPC form of the events
(`{"type": …}`): an unknown `type` is skipped.

### 3.2 `meta`

Sent when the gateway **commits** to a model: on the provider's first
content event (§2.2). Before it, only `: ping` comments flow. It is the
receipt that the call is now billable on the model it names, and after it
no `fallback` can occur.

```
event: meta
id: 1
data: {"call_id":"019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c","model":"gpt-5-mini","requested_model":"gpt-5-mini","provider":"openai","hold_2z":2,"max_output_tokens":800,"input_tokens_estimate":1200,"created_at":"2026-09-26T21:04:11Z"}
```

| Field | Meaning |
|---|---|
| `call_id` | The call. Same as the `X-F2Z-Call-Id` header |
| `model` | The model actually serving the call (differs from `requested_model` only after `fallback`) |
| `hold_2z` | The 2Z reserved for this call — the **most** it can charge, except in the write-off case of [metering.md](./metering.md) §5.5 |
| `requested_model`, `provider` | Informational: what was asked for, and `openai`, `anthropic`, `xai`, … |
| `max_output_tokens` | The effective output cap after clamping (§2.2 step 5). A client SHOULD show the user when this is lower than asked |
| `input_tokens_estimate` | What the hold was computed from |

`call_id`, `model` and `hold_2z` are the crate's `Meta`; the rest are
tolerated additions.

### 3.3 `delta`

A piece of the assistant's text.

```
event: delta
id: 2
data: {"text":"Line 3 divides both sides by "}
```

```
event: delta
id: 3
data: {"text":"x, which is zero when x = 0."}
```

Concatenating every `delta.text` in order yields the assistant message.
Deltas may split anywhere, including inside a multi-byte character's
grapheme cluster but never inside a UTF-8 code point. Reasoning tokens are
billed ([metering.md](./metering.md) §2) but **not streamed** in v1; the
field set of `delta` will grow (`kind`) rather than change if that changes.

### 3.4 `tool_call`

One **complete** tool call. The gateway buffers a provider's argument
fragments and emits the call once its arguments are complete JSON, so a
client never parses partial JSON.

```
event: tool_call
id: 4
data: {"id":"call_9a1","name":"lookup_formula","arguments":"{\"name\":\"quadratic\"}"}
```

| Field | Meaning |
|---|---|
| `id` | The provider's call id; echo it as `tool_call_id` on the `tool` message of the next request |
| `name` | One of the request's `tools[].name` |
| `arguments` | A JSON **string** (the model's output, verbatim, complete). The gateway waits for the provider to finish the arguments before emitting the event; it does not validate them against `parameters`, and a model can produce text that is not valid JSON — the client parses and decides |

Tool calls arrive in the order the model produced them; a client that
needs a position counts.

A response with tool calls normally ends with `done.finish_reason =
"tool_calls"`. The client executes the tools, appends an `assistant` message
carrying `tool_calls` and one `tool` message per result, and makes a **new**
`/v1/chat` call — which is a new hold and a new charge.

### 3.5 `usage`

The provider-reported usage, once known — normally just before `done`.

```
event: usage
id: 5
data: {"usage":{"input_tokens":1187,"cached_input_tokens":0,"cache_write_tokens":0,"output_tokens":342,"reasoning_tokens":0,"images":1,"tool_calls":1},"source":"provider"}
```

| Field | Meaning |
|---|---|
| `usage.input_tokens` | Uncached input tokens billed. The three input buckets are **disjoint** |
| `usage.cached_input_tokens` | Input served from the provider's prompt cache (cheaper) |
| `usage.cache_write_tokens` | Input written to the provider's cache (sometimes dearer) |
| `usage.output_tokens` | Output tokens **including** reasoning |
| `usage.reasoning_tokens` | The part of `output_tokens` that was reasoning; informational, never priced a second time |
| `usage.images` | Input images billed per image, where the model prices them so |
| `usage.tool_calls` | Tool calls billed per call, where the catalogue prices them |
| `source` | `provider` — the numbers are the provider's; or `estimated` — the provider reported none and the gateway estimated from streamed text ([metering.md](./metering.md) §5.4) |

A missing `usage` field reads as `0`.

### 3.6 `done`

The terminal event of a successful call. The charge is final when this
event is sent with `settlement: "settled"`: settlement happened before it,
not after.

```
event: done
id: 6
data: {"charged_2z":1,"receipt_id":"rcpt_019a2f1d-2b0e-7c4a-9f11-6d0e2a8b3c44","finish_reason":"stop","balance_hint_milli_2z":41500,"settlement":"settled","hold_2z":2,"released_2z":1,"collected_milli_2z":1000,"shortfall_milli_2z":0,"cap_remaining_milli_2z":199000,"usage_source":"provider"}
```

| Field | Meaning |
|---|---|
| `charged_2z` | The final charge, in whole 2Z |
| `receipt_id` | The ledger's id for this settlement — what a statement line points at. Distinct from `call_id`; absent while `settlement` is `pending` |
| `finish_reason` | `stop`, `length` (hit `max_output_tokens` — check `meta` for whether that was clamped), `tool_calls`, `content_filter`, `cancelled` |
| `balance_hint_milli_2z` | The user's **available** balance after this settlement, as of settlement. A hint: other calls may have moved it. `GET /api/sdk/v1/balance` is authoritative |
| `settlement` | `settled` (the default when absent), or `pending` when the ledger had not confirmed the charge within 10 s of the provider finishing ([metering.md](./metering.md) §5.11). When `pending`, every money field except `hold_2z` is **absent**, and the client reads `GET /v1/calls/{id}` until `status` leaves `settling` |
| `hold_2z`, `released_2z` | What was reserved and what was given back. `charged + released = hold` except in the write-off case |
| `collected_milli_2z`, `shortfall_milli_2z` | What was actually taken, and what could not be ([metering.md](./metering.md) §5.5). `collected = charged × 1000 − shortfall`; a receipt shows `collected` when `shortfall` is non-zero |
| `cap_remaining_milli_2z` | Remaining spend under the grant's cap for the current period; `null` when the grant has no cap |
| `usage_source` | As in `usage` |

The first four are the crate's `Done`; the rest are tolerated additions.

### 3.7 `error`

The terminal event of a failed call. An error before the HTTP response
began (§2.2 steps 1–6) is an HTTP error response; from the moment the
headers are sent, every failure is this event.

```
event: error
id: 4
data: {"code":"provider_error","message":"The provider closed the stream before completion.","settlement":"settled","charged_2z":1,"receipt_id":"rcpt_019a2f1d-2b0e-7c4a-9f11-6d0e2a8b3c44","collected_milli_2z":1000,"shortfall_milli_2z":0,"partial":true}
```

| Field | Meaning |
|---|---|
| `code` | From [errors.md](./errors.md). After `meta`: `provider_error`, `provider_timeout`, `internal`. Before `meta`: any pre-stream code (§3.1). Whether a retry can succeed is a property of the code, not a field |
| `message` | For a log, not for the user; SDKs map `code` to user-facing copy. Never contains prompt or completion text |
| `settlement` | As in `done`: `settled` (default) or `pending`. An error after output is settled for what was produced, and the ledger can be unreachable then too |
| `charged_2z`, `receipt_id`, `collected_milli_2z`, `shortfall_milli_2z` | What this failed call still cost, as in `done`. `charged_2z: 0` and no `receipt_id` when the provider failed before producing anything ([metering.md](./metering.md) §5.2); absent when `settlement` is `pending` |
| `partial` | `true` when the client received at least one `delta` or `tool_call` before the error |

`code` and `message` are the crate's `ApiError`; the rest are tolerated
additions.

### 3.8 A complete stream

The example the rest of this document set refers to: 1,187 input tokens,
342 output tokens, on a model priced (after margin) at 375,000 m2Z per
million input tokens and 1,500,000 m2Z per million output tokens. The hold
was computed for 800 output tokens; the settled charge is 1 2Z.

```
event: meta
id: 1
data: {"call_id":"019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c","model":"gpt-5-mini","requested_model":"gpt-5-mini","provider":"openai","hold_2z":2,"max_output_tokens":800,"input_tokens_estimate":1200,"created_at":"2026-09-26T21:04:11Z"}

event: delta
id: 2
data: {"text":"Line 3 divides both sides by "}

: ping

event: delta
id: 3
data: {"text":"x, which is zero when x = 0."}

event: usage
id: 4
data: {"usage":{"input_tokens":1187,"cached_input_tokens":0,"cache_write_tokens":0,"output_tokens":342,"reasoning_tokens":0,"images":0,"tool_calls":0},"source":"provider"}

event: done
id: 5
data: {"charged_2z":1,"receipt_id":"rcpt_019a2f1d-2b0e-7c4a-9f11-6d0e2a8b3c44","finish_reason":"stop","balance_hint_milli_2z":41500,"settlement":"settled","hold_2z":2,"released_2z":1,"collected_milli_2z":1000,"shortfall_milli_2z":0,"cap_remaining_milli_2z":199000,"usage_source":"provider"}

```

Over an IPC channel (the Tauri plugin), the same events travel as tagged
JSON objects — `{"type":"delta","text":"…"}` — with identical payloads;
the `type` is the SSE event name.

## 4. Non-streamed response

With `"stream": false` the same call returns one document after completion.
Its fields are the union of the events, so a client that handles both modes
maps them to one type:

```json
{
  "call_id": "019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c",
  "model": "gpt-5-mini",
  "message": {
    "content": [ { "type": "text", "text": "Line 3 divides both sides by x, which is zero when x = 0." } ],
    "tool_calls": []
  },
  "finish_reason": "stop",
  "usage": { "input_tokens": 1187, "cached_input_tokens": 0, "cache_write_tokens": 0,
             "output_tokens": 342, "reasoning_tokens": 0, "images": 0, "tool_calls": 0 },
  "usage_source": "provider",
  "charged_2z": 1,
  "receipt_id": "rcpt_019a2f1d-2b0e-7c4a-9f11-6d0e2a8b3c44",
  "balance_hint_milli_2z": 41500,
  "requested_model": "gpt-5-mini",
  "provider": "openai",
  "settlement": "settled",
  "hold_2z": 2,
  "released_2z": 1,
  "collected_milli_2z": 1000,
  "shortfall_milli_2z": 0,
  "cap_remaining_milli_2z": 199000,
  "created_at": "2026-09-26T21:04:11Z",
  "settled_at": "2026-09-26T21:04:14Z"
}
```

`message.content` is an array of output parts (text in v1; a part type a
client does not know is skipped, and dropped when the reply is sent back
as history). The first nine fields are the crate's `ChatResponse`; the
rest are tolerated additions.

A failure **after output began** in non-streamed mode is an HTTP **`502`**
whatever the stream-level code would have been — `provider_error`,
`provider_timeout`, `internal` — with that code preserved in the
envelope's `code`, and `details` carrying `call_id`, `charged_2z`,
`receipt_id`, `partial: true` and the partial `message`. The client is
charged for what was produced exactly as in a stream, and this is why
streaming is the default. A content-filter stop is never a failure in
this mode: it is `200` with `finish_reason: "content_filter"`. A
`settlement: "pending"` outcome is `200` with the money fields absent, as
in `done`.

## 5. `GET /v1/models`

The catalogue as the calling app's users will pay for it. Prices **include**
the platform margin and the calling app's markup; a client shows them
without arithmetic. Requires `ai:invoke`.

```json
{
  "catalog_version": 7,
  "includes_markup_bps": 0,
  "models": [
    {
      "id": "gpt-5-mini",
      "provider": "openai",
      "display_name": "GPT-5 mini",
      "context_window": 400000,
      "max_output_tokens": 128000,
      "capabilities": { "vision": true, "tools": true, "reasoning": true },
      "prices": {
        "input_milli_2z_per_mtok": 375000,
        "cached_input_milli_2z_per_mtok": 37500,
        "cache_write_milli_2z_per_mtok": 0,
        "output_milli_2z_per_mtok": 1500000,
        "image_milli_2z": 0,
        "tool_call_milli_2z": 0
      },
      "min_charge_2z": 1,
      "ttfb_timeout_ms": 30000
    }
  ]
}
```

This is the **public projection** of the signed catalogue the gateway
runs on ([`docs/ai-gateway`](../../ai-gateway/README.md#the-catalogue-contract)):
the same models, with provider prices replaced by marked-up 2Z rates, and
only callable models listed. The catalogue's internal fields (provider
model ids, API styles, safety factors) are not projected.

| Field | Meaning |
|---|---|
| `catalog_version` | The signed catalogue's `version`: an integer that only increases. A `meta` event does not carry it; `GET /v1/calls/{id}` does |
| `includes_markup_bps` | The markup the calling user consented to for this app, already inside every price below. `0` for an app without markup |
| `prices.*_milli_2z_per_mtok` | Milli-2Z per **million** tokens (`mtok`), rounded **up** to an integer from the exact rate ([metering.md](./metering.md) §2.4) — a client's own estimate is never below the ledger's charge. `0` means the model has no such price (no cache pricing; no per-image price, so images are billed as tokens) |
| `image_milli_2z`, `tool_call_milli_2z` | Per-unit prices where the provider bills per unit; `0` otherwise |
| `min_charge_2z` | The floor for a call on this model, in whole 2Z. Never below `1`: the catalogue refuses a model priced at zero minimum |
| `ttfb_timeout_ms` | How long the gateway waits for the provider's first byte before `504 provider_timeout` |
| `capabilities` | A projection field, not in the signed catalogue's v1 schema: derived by the gateway from the model's API style and provider until the catalogue carries it |

Responses carry `ETag`; `If-None-Match` → `304`. Clients SHOULD cache for
the `Cache-Control: max-age` given (60 s).

## 6. `POST /v1/chat/estimate`

The same request body as `/v1/chat` (`stream` ignored). Runs steps 1–5 of
§2.2 and stops: **no hold, no charge, no provider call.** Requires
`ai:invoke`.

```json
{
  "model": "gpt-5-mini",
  "input_tokens": 1200,
  "max_output_tokens": 800,
  "hold_2z": 2,
  "min_charge_2z": 1,
  "available_milli_2z": 42500,
  "cap_remaining_milli_2z": 200000,
  "catalog_version": 7
}
```

`model`, `input_tokens` (safety factor applied), `max_output_tokens` (the
cap the call would run with, after clamping) and `hold_2z` (what
`/v1/chat` would reserve *now*) are the crate's `EstimateResponse`; the
rest are tolerated additions. Every step fails **exactly as `/v1/chat`
would** — `401`, `403 insufficient_scope`, `429`, `404`,
`400 context_length_exceeded`, and for an unaffordable request
`402 insufficient_balance` or `403 cap_exceeded` with the same `details`
(`available_milli_2z`, `required_2z`, `cap_remaining_milli_2z`, …) — so an
app that handles `/v1/chat`'s errors handles the estimate's with the same
code, and can show "you need N more 2Z" from `details`. An estimate is not
a quotation: the price is the catalogue's at call time.

## 7. `GET /v1/calls/{id}`

The record of one call, for receipts and for recovering from a lost
connection. Only the user who made the call, through the app that made it,
can read it. Requires `ai:invoke`.

```json
{
  "call_id": "019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c",
  "status": "settled",
  "model": "gpt-5-mini",
  "requested_model": "gpt-5-mini",
  "provider": "openai",
  "finish_reason": "stop",
  "usage": { "input_tokens": 1187, "cached_input_tokens": 0, "cache_write_tokens": 0,
             "output_tokens": 342, "reasoning_tokens": 0, "images": 0, "tool_calls": 0,
             "source": "provider" },
  "hold_2z": 2,
  "charged_2z": 1,
  "receipt_id": "rcpt_019a2f1d-2b0e-7c4a-9f11-6d0e2a8b3c44",
  "collected_milli_2z": 1000,
  "released_2z": 1,
  "shortfall_milli_2z": 0,
  "catalog_version": 7,
  "markup_bps": 0,
  "metadata": { "lesson": "quadratics-3" },
  "error": null,
  "replayed": false,
  "created_at": "2026-09-26T21:04:11Z",
  "settled_at": "2026-09-26T21:04:14Z"
}
```

`status` ∈ `streaming` (hold exists, call in progress), `settling`
(provider finished, ledger not yet confirmed — [metering.md](./metering.md)
§5.11), `settled` (charged; `charged_2z` ≥ `min_charge_2z`), `released`
(nothing charged — the provider failed before output, or the hold expired
unsettled), `settled_partial` (an error or cancellation after output;
charged for what was produced). `error` is `null` or `{code, message}` for
a call that ended in an `error` event. `collected_milli_2z` is what was
actually taken (`charged_2z × 1000 − shortfall_milli_2z`). `replayed` is
`true` when the record was returned by an idempotent replay (§2.5).
Records are readable for 90 days. Prompts and completions are **not** in
the record. The gateway keeps no copy of either except under a grant whose
user consented to debug capture ([oidc.md](./oidc.md) §5), and that copy
is never served by this endpoint.

`404 call_not_found` for an id that does not exist or belongs to another
(user, app).

## 8. Rate-limit and concurrency responses

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 2
X-F2Z-RateLimit-Limit: 60
X-F2Z-RateLimit-Remaining: 0
X-F2Z-RateLimit-Reset: 1790000302
```

`code` is `rate_limited` (requests per minute) or `concurrency_limit`
(a fifth simultaneous stream). Both are retryable after `Retry-After`. A
request refused here created no call and no hold.

## 9. What is deliberately not here

- **Provider passthrough** (`/v1/native/…`): later, allowlisted, and priced
  only for what the catalogue prices ([ADR 0003](../../ai-gateway/adr/0003-unified-api-before-passthrough.md)).
- **Server-side tools**, **file uploads**, **embeddings**, **audio**,
  **image generation**: not in v1. Each arrives as a new endpoint with its
  own price fields, not as a mode of `/v1/chat`.
- **Streaming resumption** (`Last-Event-ID`): not in v1.
- **Batch or async calls**: not in v1.
