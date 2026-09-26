# The chat API — `ai.free2z.cash/v1`

**Status:** v1 contract · **Part of:** [f2z-sdk v1](../README.md) ·
**Refs:** [#1047](https://github.com/free2z/zuu/issues/1047),
[#1048](https://github.com/free2z/zuu/issues/1048),
[#1049](https://github.com/free2z/zuu/issues/1049) (`f2z-ai-proto`, the
types)

The gateway exposes **one** chat API across several providers. A client
never chooses a provider's native format, never sends a provider key, and
never sees a provider's own error shape. The wire types in this document are
the source for `f2z-ai-proto`; the OpenAPI document generated from that crate
(D3) is the field-level reference and MUST agree with this text.

## 1. Common rules

| Item | Rule |
|---|---|
| Base URL | `https://ai.free2z.cash/v1` |
| Authentication | `Authorization: Bearer <access_token>` — an access token from [oidc.md](./oidc.md) whose `aud` contains `f2z-ai` and whose `scope` contains `ai:invoke`. Nothing else is accepted |
| Content type | Requests are `application/json`, UTF-8. Responses are `application/json` or `text/event-stream` |
| Request body limit | 4 MiB for a request without image parts; 20 MiB with. Larger is `413 payload_too_large` |
| Errors | Every non-2xx response is the envelope in [errors.md](./errors.md) |
| Ids | `call_id` is a UUIDv7 assigned by the gateway and returned in the `X-F2Z-Call-Id` response header on every `/v1/chat` response, streamed or not, including errors after a call was created |
| Idempotency | `Idempotency-Key` header, 1–128 ASCII characters, scoped to (app, user). Recommended on every `/v1/chat` (§2.5) |
| Rate limits | Per (app, user): a token bucket on requests and a concurrency limit of **4 open streams per user**. Exceeding either is `429` with `Retry-After` (§7) |
| Timeouts | Connect and first-byte limits are per model and published in `/v1/models`; a stream that produces nothing for **60 s** ends with `error stream_timeout`; no call runs longer than **300 s** |

## 2. `POST /v1/chat`

### 2.1 Request

```json
{
  "model": "gpt-5-mini",
  "messages": [
    { "role": "system", "content": "You are a patient maths tutor." },
    { "role": "user", "content": [
        { "type": "text", "text": "What is wrong with my working?" },
        { "type": "image", "image": { "media_type": "image/png", "data": "iVBORw0KGgo..." } }
    ] },
    { "role": "assistant", "content": "Let me look at line 3." },
    { "role": "tool", "tool_call_id": "call_9a1", "content": "{\"answer\": 42}" }
  ],
  "tools": [
    { "type": "function",
      "function": {
        "name": "lookup_formula",
        "description": "Find a formula by name",
        "parameters": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] }
      } }
  ],
  "tool_choice": "auto",
  "max_output_tokens": 800,
  "temperature": 0.3,
  "stream": true,
  "fallback": ["gpt-5-nano"],
  "metadata": { "lesson": "quadratics-3" }
}
```

| Field | Type | Rules |
|---|---|---|
| `model` | string | An `id` from `/v1/models`. Unknown or disabled → `404 model_not_found` |
| `messages` | array | At least one. Roles: `system` (at most one, first), `user`, `assistant`, `tool`. `content` is a string or an array of parts |
| `messages[].content[]` | part | `{"type":"text","text":…}` or `{"type":"image","image":{"media_type":…,"data":<base64>}}`. Image `media_type` ∈ `image/png`, `image/jpeg`, `image/webp`, `image/gif`; at most 20 images per request. **URLs are not accepted**: the gateway never fetches a client-supplied URL. Image parts on a model without `capabilities.vision` → `400 invalid_request` |
| `messages[].tool_calls` | array | On an `assistant` message: the tool calls the assistant previously made, each `{id, name, arguments}` with `arguments` a JSON string |
| `messages[].tool_call_id` | string | Required on a `tool` message |
| `tools` | array | Function tools only. The gateway **never executes a tool**: it relays the model's call to the client and the client's result back on the next request. Provider-hosted tools (web search, code execution, file search) are not available on this endpoint in v1 ([ADR 0003](../../ai-gateway/adr/0003-unified-api-before-passthrough.md)) |
| `tool_choice` | string \| object | `auto` (default when `tools` present), `none`, `required`, or `{"type":"function","function":{"name":…}}` |
| `max_output_tokens` | integer | 1 … the model's `max_output_tokens`. Default: the model's `default_output_tokens`. The gateway may **clamp** it lower for affordability (§2.2); the effective value is reported in `meta` |
| `temperature` | number | 0 … 2. Omitted → the provider default. Models that do not support it ignore it |
| `stream` | boolean | Default `true`. `false` returns one JSON document (§4) |
| `fallback` | array of model ids | Opt-in. If the *first* model fails **before any byte reached the client** with a provider-side error, the gateway retries once on the next id, re-holding at that model's price. Never after output began. The model actually used is in `meta` |
| `metadata` | object | Up to 16 string keys, each key ≤ 64 and value ≤ 256 characters. Stored with the call record and returned by `GET /v1/calls/{id}`; never sent to a provider |

Anything not listed is rejected with `400 invalid_request` naming the field;
the gateway does not pass unknown fields through.

### 2.2 What happens before the first byte

In order. Each step's failure is an error response *before* any stream
begins, so a client that has received `meta` knows every check passed.

1. **Token.** Signature, `iss`, `aud`, `exp`, `scope`, `aep`, `agen`
   ([oidc.md](./oidc.md) §6). Failure → `401`. Revocation state unknown →
   `503 revocation_check_unavailable`.
2. **Rate limits and concurrency.** → `429`.
3. **Catalogue.** The model exists, is enabled, and the app may use it. →
   `404 model_not_found` / `403 model_not_allowed`.
4. **Input estimate.** The gateway tokenises the input (exactly for models
   whose tokeniser it has; with a per-model safety factor otherwise) and
   refuses input that cannot fit the context window with at least one output
   token: `400 context_too_long`.
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
   `503 provider_unavailable` or `504 provider_timeout`. Nothing was charged.

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

- if the original is still streaming, the replay is refused with
  `409 idempotency_conflict` (`details.call_id` names it) — two consumers of
  one stream is not a thing the gateway does;
- if the original finished, the replay answers `200` with the non-streamed
  document of §4 for that call, regardless of `stream`, and charges nothing;
- if the body differs from the original, `409 idempotency_conflict`.

Without a key, every request is a new call. SDKs generate a key per logical
call so that a retried request after a network failure never double-charges.

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
```

- Exactly one `meta`, always first.
- Zero or more `delta` and `tool_call`, in the order the model produced them.
- At most one `usage`, and if present it comes after the last `delta` /
  `tool_call` and before the terminal event.
- Exactly one terminal event, `done` or `error`, after which the gateway
  closes the connection. A stream that ends without a terminal event was
  cut by the network; the client treats it as `error stream_interrupted`
  locally and consults `GET /v1/calls/{id}` for the outcome.

Clients MUST ignore event names they do not know (future events are added as
new names, never as new shapes of existing ones) and MUST ignore unknown
fields in known events.

### 3.2 `meta`

Sent as soon as the hold exists and the provider request has started. It is
the receipt that the call is now billable.

```
event: meta
id: 1
data: {"call_id":"019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c","model":"gpt-5-mini","requested_model":"gpt-5-mini","provider":"openai","hold_m2z":2000,"max_output_tokens":800,"input_tokens_estimate":1200,"created_at":"2026-09-26T21:04:11Z"}
```

| Field | Meaning |
|---|---|
| `call_id` | The call. Same as the `X-F2Z-Call-Id` header |
| `model` | The model actually serving the call (differs from `requested_model` only after `fallback`) |
| `provider` | `openai`, `anthropic`, `xai`, … informational |
| `hold_m2z` | The 2Z reserved for this call — the **most** it can charge, except in the write-off case of [metering.md](./metering.md) §5.5 |
| `max_output_tokens` | The effective output cap after clamping (§2.2 step 5). A client SHOULD show the user when this is lower than asked |
| `input_tokens_estimate` | What the hold was computed from |

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
data: {"id":"call_9a1","name":"lookup_formula","arguments":"{\"name\":\"quadratic\"}","index":0}
```

| Field | Meaning |
|---|---|
| `id` | The provider's call id; echo it as `tool_call_id` on the `tool` message of the next request |
| `name` | One of the request's `tools[].function.name` |
| `arguments` | A JSON **string** (the model's output, verbatim). The gateway validates that it parses as JSON, not that it matches `parameters` |
| `index` | 0-based position among this response's tool calls |

A response with tool calls normally ends with `done.finish_reason =
"tool_calls"`. The client executes the tools, appends an `assistant` message
carrying `tool_calls` and one `tool` message per result, and makes a **new**
`/v1/chat` call — which is a new hold and a new charge.

### 3.5 `usage`

The provider-reported usage, once known — normally just before `done`.

```
event: usage
id: 5
data: {"input_tokens":1187,"cached_input_tokens":0,"cache_write_tokens":0,"output_tokens":342,"reasoning_tokens":0,"images":1,"tool_calls":1,"source":"provider"}
```

| Field | Meaning |
|---|---|
| `input_tokens` | Uncached input tokens billed |
| `cached_input_tokens` | Input served from the provider's prompt cache (cheaper) |
| `cache_write_tokens` | Input written to the provider's cache (sometimes dearer) |
| `output_tokens` | Output tokens **including** reasoning |
| `reasoning_tokens` | The part of `output_tokens` that was reasoning; informational |
| `images` | Input images billed per image, where the model prices them so |
| `tool_calls` | Tool calls billed per call, where the catalogue prices them |
| `source` | `provider` — the numbers are the provider's; or `estimated` — the provider reported none and the gateway estimated from streamed text ([metering.md](./metering.md) §5.4) |

### 3.6 `done`

The terminal event of a successful call. The charge is final when this
event is sent: settlement happened before it, not after.

```
event: done
id: 6
data: {"call_id":"019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c","finish_reason":"stop","charged_m2z":1000,"hold_m2z":7000,"released_m2z":6000,"balance_hint_m2z":41500,"cap_remaining_m2z":199000,"usage_source":"provider"}
```

| Field | Meaning |
|---|---|
| `finish_reason` | `stop`, `length` (hit `max_output_tokens` — check `meta` for whether that was clamped), `tool_calls`, `content_filter` |
| `charged_m2z` | The final charge: a whole 2Z, so a multiple of `1000` |
| `hold_m2z`, `released_m2z` | What was reserved and what was given back. `charged + released = hold` except in the write-off case |
| `balance_hint_m2z` | The user's available balance after this settlement, **as of settlement**. A hint: other calls may have moved it. `GET /api/sdk/v1/balance` is authoritative |
| `cap_remaining_m2z` | Remaining spend under the grant's cap for the current period; `null` when the grant has no cap |
| `usage_source` | As in `usage` |

### 3.7 `error`

The terminal event of a failed call. It appears **only after `meta`** — an
error before the stream exists is an HTTP error response.

```
event: error
id: 4
data: {"code":"provider_error","message":"The provider closed the stream before completion.","retryable":true,"charged_m2z":1000,"partial":true}
```

| Field | Meaning |
|---|---|
| `code` | From [errors.md](./errors.md) §4. In a stream: `provider_error`, `provider_timeout`, `stream_timeout`, `content_filter`, `internal` |
| `message` | For a log, not for the user; SDKs map `code` to user-facing copy |
| `retryable` | Whether the same request may be sent again. A retry is a new call with a new charge |
| `charged_m2z` | What this failed call still cost. `0` when the provider failed before producing anything; otherwise the price of what was produced ([metering.md](./metering.md) §5.2) |
| `partial` | `true` when the client received at least one `delta` or `tool_call` before the error |

### 3.8 A complete stream

The example the rest of this document set refers to: 1,187 input tokens,
342 output tokens, on a model priced (after margin) at 375,000 m2Z per
million input tokens and 1,500,000 m2Z per million output tokens. The hold
was computed for 800 output tokens; the settled charge is 1 2Z.

```
event: meta
id: 1
data: {"call_id":"019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c","model":"gpt-5-mini","requested_model":"gpt-5-mini","provider":"openai","hold_m2z":2000,"max_output_tokens":800,"input_tokens_estimate":1200,"created_at":"2026-09-26T21:04:11Z"}

event: delta
id: 2
data: {"text":"Line 3 divides both sides by "}

: ping

event: delta
id: 3
data: {"text":"x, which is zero when x = 0."}

event: usage
id: 4
data: {"input_tokens":1187,"cached_input_tokens":0,"cache_write_tokens":0,"output_tokens":342,"reasoning_tokens":0,"images":0,"tool_calls":0,"source":"provider"}

event: done
id: 5
data: {"call_id":"019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c","finish_reason":"stop","charged_m2z":1000,"hold_m2z":2000,"released_m2z":1000,"balance_hint_m2z":41500,"cap_remaining_m2z":199000,"usage_source":"provider"}

```

## 4. Non-streamed response

With `"stream": false` the same call returns one document after completion.
Its fields are the union of the events, so a client that handles both modes
maps them to one type:

```json
{
  "call_id": "019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c",
  "model": "gpt-5-mini",
  "requested_model": "gpt-5-mini",
  "provider": "openai",
  "message": {
    "role": "assistant",
    "content": "Line 3 divides both sides by x, which is zero when x = 0.",
    "tool_calls": []
  },
  "finish_reason": "stop",
  "usage": { "input_tokens": 1187, "cached_input_tokens": 0, "cache_write_tokens": 0,
             "output_tokens": 342, "reasoning_tokens": 0, "images": 0, "tool_calls": 0,
             "source": "provider" },
  "hold_m2z": 2000,
  "charged_m2z": 1000,
  "released_m2z": 1000,
  "balance_hint_m2z": 41500,
  "cap_remaining_m2z": 199000,
  "created_at": "2026-09-26T21:04:11Z",
  "settled_at": "2026-09-26T21:04:14Z"
}
```

A provider failure after output began in non-streamed mode is `502` with
the error envelope, whose `details` carry `call_id`, `charged_m2z` and the
partial `message` — the client is charged for what was produced exactly as
in a stream, and this is why streaming is the default.

## 5. `GET /v1/models`

The catalogue as the calling app's users will pay for it. Prices **include**
the platform margin and the calling app's markup; a client shows them
without arithmetic. Requires `ai:invoke`.

```json
{
  "catalogue_version": "2026-09-26.3",
  "includes_markup_bps": 2000,
  "models": [
    {
      "id": "gpt-5-mini",
      "provider": "openai",
      "display_name": "GPT-5 mini",
      "enabled": true,
      "context_window": 400000,
      "max_output_tokens": 128000,
      "default_output_tokens": 4096,
      "capabilities": { "vision": true, "tools": true, "reasoning": true, "temperature": true },
      "prices": {
        "input_m2z_per_mtok": 375000,
        "cached_input_m2z_per_mtok": 37500,
        "cache_write_m2z_per_mtok": null,
        "output_m2z_per_mtok": 1500000,
        "image_m2z_each": null,
        "tool_call_m2z_each": null
      },
      "min_charge_m2z": 1000,
      "first_byte_timeout_s": 30
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `catalogue_version` | Changes whenever any price changes. A `meta` event does not carry it; `GET /v1/calls/{id}` does |
| `includes_markup_bps` | The calling app's markup, already inside every price below. `0` for an app without markup |
| `prices.*_m2z_per_mtok` | Milli-2Z per **million** tokens (`mtok`). `null` means the model has no such price (no cache, no per-image price — images are then billed as tokens) |
| `image_m2z_each`, `tool_call_m2z_each` | Per-unit prices where the provider bills per unit |
| `min_charge_m2z` | The floor for a call on this model, a multiple of `1000`. v1 default `1000` |
| `first_byte_timeout_s` | How long the gateway waits for the provider's first byte before `504 provider_timeout` |

Responses carry `ETag`; `If-None-Match` → `304`. Clients SHOULD cache for
the `Cache-Control: max-age` given (60 s).

## 6. `POST /v1/chat/estimate`

The same request body as `/v1/chat` (`stream` ignored). Runs steps 1–5 of
§2.2 and stops: **no hold, no charge, no provider call.** Requires
`ai:invoke`.

```json
{
  "model": "gpt-5-mini",
  "input_tokens_estimate": 1200,
  "max_output_tokens_requested": 800,
  "max_output_tokens_effective": 800,
  "hold_m2z": 2000,
  "min_charge_m2z": 1000,
  "affordable": true,
  "available_m2z": 42500,
  "cap_remaining_m2z": 200000,
  "catalogue_version": "2026-09-26.3"
}
```

`hold_m2z` is what `/v1/chat` would reserve *now*; `affordable: false`
comes with the `reason` (`insufficient_balance` or `cap_exceeded`) that
`/v1/chat` would answer with, and `max_output_tokens_effective` is `0`.
An estimate is not a quotation: the price is the catalogue's at call time.

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
  "hold_m2z": 2000,
  "charged_m2z": 1000,
  "released_m2z": 1000,
  "shortfall_m2z": 0,
  "catalogue_version": "2026-09-26.3",
  "markup_bps": 2000,
  "metadata": { "lesson": "quadratics-3" },
  "error": null,
  "created_at": "2026-09-26T21:04:11Z",
  "settled_at": "2026-09-26T21:04:14Z"
}
```

`status` ∈ `streaming` (hold exists, call in progress), `settled`
(charged; `charged_m2z` ≥ `min_charge_m2z`), `released` (nothing charged —
the provider failed before output), `settled_partial` (an error or
cancellation after output; charged for what was produced). Records are
readable for 90 days. Prompts and completions are **not** in the record.

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

`code` is `rate_limited` (requests per minute) or `concurrency_exceeded`
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
