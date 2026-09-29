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
without breaking a deployed SDK. Every response field, enum value and
error code shown here is defined by the crate
([free2z/zuu#1052](https://github.com/free2z/zuu/issues/1052)); its test
suite decodes every example in this document. Fields beyond each type's
core are optional on decode, so a client never discards a stream over a
missing informational field; the per-`settlement` rules of §3.6–§3.7 are
checked by each terminal type's `check()`.

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
| Rate limits | Per (app, user): a token bucket on requests and a concurrency limit of **4 open streams per user**. A call counts as open from its hold until that hold is settled, released or expired — a call whose client has disconnected but whose upstream is still being read (§2.4) **still counts**, because it is still consuming provider capacity, and a call whose gateway died stops counting when its hold expires; the 16-open-hold limit bounds it too. Exceeding either is `429` with `Retry-After` (§8). No aggregate application request bucket is enabled by default; an operator may explicitly configure one as a service admission policy, independently of each user's spending consent. A configured shared admission store that cannot confirm a new call yields retryable `503 unavailable`, never extra per-pod capacity |
| Timeouts | The first-byte limit is per model and published in `/v1/models` (`ttfb_timeout_ms`); the provider connect timeout is a fixed 5 s; a stream that produces nothing for the model's idle limit — **60 s** unless the catalogue's `idle_timeout_ms` sets another (longer for models that reason without sending anything) — ends with `error provider_timeout`; no call runs longer than **300 s** |

## 2. `POST /v1/chat`

### 2.1 Request

```json
{
  "model": "example-model-small",
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
  "fallback": ["example-model-tiny"],
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
| `tools` | array | Function tools, each `{name, description?, parameters}` with `parameters` a JSON Schema object. Tools or tool-result history on a model without `capabilities.tools` → `400 invalid_request`. The gateway **never executes a tool**: it relays the model's call to the client and the client's result back on the next request. Provider-hosted tools (web search, code execution, file search) are not available on this endpoint in v1 ([ADR 0003](../../ai-gateway/adr/0003-unified-api-before-passthrough.md)) |
| `max_output_tokens` | integer | 1 … the model's `max_output_tokens`, which is also the default when omitted. It bounds **total** generated tokens, reasoning included. The gateway may **clamp** it lower for affordability (§2.2) and never raises it; the effective value is reported in `meta` |
| `max_output_tokens_strict` | boolean | Default `false` (and omitted). `true` makes `max_output_tokens` a requirement: wherever §2.2 would lower it — the model's ceiling, the context window, the balance or the grant's cap — the request is refused before any hold, charge or provider request (`400 invalid_request`, `400 context_length_exceeded`, `402 insufficient_balance`, `403 cap_exceeded`, each with `details.reason: "max_output_tokens_strict"`). Requires `max_output_tokens` (`400 invalid_request`, `reason: "required"`). For an app that discards a length-truncated answer ([INTEGRATION.md](../INTEGRATION.md)) |
| `stream` | boolean | Default `true`. `false` returns one JSON document (§4) |
| `fallback` | array of model ids | Opt-in, **ordered**: tried in order, at most once each. If the current model fails with a provider-side error **before the gateway has committed to it** — that is, before its first content event, which is also when `meta` is sent (§3.2) — the gateway releases that attempt's hold, takes a new hold at the next model's price, and tries it; a hold it cannot take ends the call with that code ([metering.md](./metering.md) §5.7). Never after `meta`. The model actually used is in `meta` |
| `metadata` | object | Up to 16 string keys, each key ≤ 64 and value ≤ 256 characters. Stored with the call record and returned by `GET /v1/calls/{id}`; never sent to a provider |

Anything not listed is rejected with `400 invalid_request` naming the field;
the gateway does not pass unknown fields through. **Not in v1**, and
therefore refused rather than ignored: `temperature` and other sampling
controls, `tool_choice`, response-format modes, audio and file parts.
Each arrives, if it does, as a priced, documented addition.

### 2.2 What happens before the first byte

In order. Steps 1–6 fail as HTTP error responses, before any stream
begins; step 7 fails inside the stream (below). A client that has
received `meta` knows every step passed.

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
5. **Output clamp.** The gateway reads the account (`inquire`,
   [metering.md](./metering.md) §3). An account in debt is refused first:
   `403 account_in_debt`, before any affordability arithmetic, so a user
   who owes 2Z never sees an ordinary "insufficient" message. Then
   `out_cap = min(max_output_tokens, context_window − input_estimate,
   affordable)`, where `affordable` is the largest output length whose
   worst-case price fits the user's available balance *and* the grant's
   remaining cap ([metering.md](./metering.md) §4). If even the model's
   minimum charge is unaffordable → `402 insufficient_balance` or
   `403 cap_exceeded`. With `max_output_tokens_strict`, there is no clamp:
   `out_cap` must equal `max_output_tokens`, or the request is refused here
   with the code of whichever bound was short (§2.1) and
   `details.reason: "max_output_tokens_strict"`.
6. **Hold.** The ledger reserves the worst-case price for `out_cap`. The
   ledger's own answer decides: `402`, `403 cap_exceeded`,
   `403 account_frozen`, `403 account_in_debt`, `409 too_many_holds`.
7. **Provider request.** A provider error here, on the primary and any
   `fallback`, releases the hold and ends the (already open) stream with
   a lone `error` event carrying `provider_error`, `unavailable` or
   `provider_timeout` and `charged_2z: 0`. Nothing was charged. In
   non-streamed mode the same failure is the HTTP `502`, `503` or `504`.

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
TypeScript SDK; dropping the cancel handle in Rust). Cancelling stops
**delivery**, not **generation**: once the gateway has sent the upstream
request it reads the provider to completion — bounded by the `out_cap`
already held and the 300 s hard limit — and settles on the usage the
provider reports, with `finish_reason: cancelled`
([metering.md](./metering.md) §5.3). The charge is therefore for the
whole generation up to `out_cap`, not for the part the client read; an
app that wants a cheap cancel sets a small `max_output_tokens`. A
disconnect before the upstream request was sent releases the hold and
charges nothing. Cancellation is a property of the **call**, not of one
attempt: after a disconnect no new provider attempt is started — if the
in-flight attempt fails before content, its hold is released and no
`fallback` model is tried, because there is nobody to deliver to.

**A slow client never slows the provider.** The gateway reads the
upstream at provider speed regardless of how fast the client reads, and
buffers undelivered events per stream, up to **256 KiB** of payload. A
client that is connected but reading slowly simply receives the buffer
as it drains. Two things end **delivery** early while the upstream read
and the settlement continue unchanged — the buffer filling, and **30 s
without any delivery progress** to a connected client — and both have
the **same** outcome: the gateway makes a best-effort attempt to send
`error` with `delivery_aborted` and
`settlement: "pending"`, then closes the connection. A client that
receives it knows the call is still running and billable; a client that
does not (the socket was too stalled even for that) sees a close without
a terminal event, treats it as `stream_interrupted`, and learns the same
thing from `GET /v1/calls/{id}`. In every case the call settles on the
provider's usage, and the record has the outcome once its `status` is
terminal. A drained call still counts toward the 4-stream limit until its
hold is settled, released or expired (§1) — one removal per counted
call, so a call that expires into `released` leaves the count too. There
is no cancel endpoint: a closed connection is
unambiguous and cannot be forged.

### 2.5 Idempotency

A request that carries `Idempotency-Key` is replayed safely: a second
`POST /v1/chat` with the same key from the same (app, user) within **24
hours** returns the *same* call — the same `call_id`, and:

- if the original's **call record** is not yet terminal (`status` is
  `streaming` or `settling` — which includes a call whose delivery ended
  with `delivery_aborted` or whose `done` said `settlement: "pending"`
  while the provider or the ledger is still at work), the replay is
  refused with `409 idempotency_conflict` (`details.call_id` names it) —
  two consumers of one stream is not a thing the gateway does, and the
  charge is not known yet;
- if the original's record is terminal (`settled`, `settled_partial`,
  `released`) — however its stream ended — the replay answers
  `200` with the **call record** of §7 (`replayed: true`) as
  `application/json`, **even when the request said `stream: true`** — an
  SDK branches on the response `Content-Type`, not on what it asked for —
  and charges nothing. The record has no message content: the gateway
  does not retain completions (§7), so idempotency protects the charge,
  not the delivery. A client that lost the stream re-asks with a new key,
  and that is a new call;
- if the body differs from the original, `409 idempotency_conflict`.

Without a key, every request is a new call. SDKs generate a key per logical
call so that a retried request after a network failure never double-charges.
The two uses are distinct and an SDK keeps them so: **re-sending with the
same key** is receipt recovery — "did my call happen, and what did it
cost?" — and can never do new work; **retrying a failed call** that the
user wants attempted again is a new key. In particular a call that failed
before `meta` with a retryable code is recorded as failed, and re-sending
its key returns that record for the whole 24-hour window (after which the
key is simply new); the SDK's retry uses a fresh key rather than waiting.

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
data: {"call_id":"019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c","model":"example-model-small","requested_model":"example-model-small","provider":"example-provider","hold_2z":2,"max_output_tokens":800,"input_tokens_estimate":1200,"created_at":"2026-09-26T21:04:11Z"}
```

| Field | Meaning |
|---|---|
| `call_id` | The call. Same as the `X-F2Z-Call-Id` header |
| `model` | The model actually serving the call (differs from `requested_model` only after `fallback`) |
| `hold_2z` | The 2Z reserved for this call: the ceiling on its charge, except in the write-off case of [metering.md](./metering.md) §5.5 and except that an extension for usage outside the initial estimate can raise it (`done.hold_2z` is the final value; [metering.md](./metering.md) §3) |
| `requested_model`, `provider` | Informational: what was asked for, and `openai`, `anthropic`, `xai`, … |
| `max_output_tokens` | The effective output cap after clamping (§2.2 step 5). A client SHOULD show the user when this is lower than asked |
| `input_tokens_estimate` | What the hold was computed from |

`call_id`, `model` and `hold_2z` are required in the crate's `Meta`; the
rest are optional on decode.

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
fragments and emits the call once the provider has finished producing
them, so a client never sees a fragment; whether the finished text is
valid JSON is the model's doing, not the gateway's promise.

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
| `charged_2z` | The final charge, in whole 2Z. **`settlement` means final**: once it is `settled` or `released`, this number never changes — nothing settles a call twice, and a settle that arrives after the hold expired charges nothing ([metering.md](./metering.md) §5.6) |
| `receipt_id` | The ledger's id for this settlement — what a statement line points at. Distinct from `call_id`; absent while `settlement` is `pending` and when nothing was charged |
| `finish_reason` | `stop`, `length` (hit `max_output_tokens` — check `meta` for whether that was clamped), `tool_calls`, `content_filter`, `cancelled` |
| `balance_hint_milli_2z` | The user's **available** balance after this settlement, as of settlement. A hint: other calls may have moved it. `GET /api/sdk/v1/balance` is authoritative |
| `settlement` | `settled` (the default when absent); `pending` when the ledger had not confirmed the charge within 10 s of the provider finishing ([metering.md](./metering.md) §5.11) — every 2Z field except `hold_2z` is then **absent** and the client reads `GET /v1/calls/{id}` until `status` is terminal (`settled`, `settled_partial` or `released`) — not merely until it leaves `settling`, because after a `delivery_aborted` the record can still be `streaming` while the provider finishes; or `released` when the settler found the hold already expired ([metering.md](./metering.md) §5.6) — `charged_2z` is `0` and no `receipt_id` exists. In the crate `charged_2z` and `receipt_id` are optional, and `Done::check()` enforces which state requires which |
| `hold_2z`, `released_2z` | The **final** reservation (it can exceed `meta.hold_2z` after an extension) and what was given back. `charged + released = hold` except in the write-off case |
| `collected_milli_2z`, `shortfall_milli_2z` | What was actually taken, and what could not be ([metering.md](./metering.md) §5.5). `collected = charged × 1000 − shortfall`; a receipt shows `collected` when `shortfall` is non-zero |
| `cap_remaining_milli_2z` | Remaining spend under the grant's cap **for the period the hold belongs to** ([metering.md](./metering.md) §4) — after a stream that crossed a period boundary this is the old period's remainder, which is what the settlement was bounded by; `null` when the grant has no cap |
| `usage_source` | The `source` of the `usage` event, repeated here (one value set — `provider` / `estimated` — two field names: `source` inside the `usage` event, `usage_source` beside a `usage` object everywhere else, as the crate spells them) |

All are the crate's `Done` (`Settlement` for `settlement`;
`cap_remaining_milli_2z` keeps absent and `null` apart).

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
| `code` | From [errors.md](./errors.md). After `meta`: `provider_error`, `provider_timeout`, `internal`, or `delivery_aborted` (the per-stream buffer filled — the call goes on upstream and settles; `settlement` is `pending` and the record has the outcome; not retryable, since retrying would be a second call). Before `meta`: any pre-stream code (§3.1). Whether a retry can succeed is a property of the code, not a field |
| `message` | For a log, not for the user; SDKs map `code` to user-facing copy. Never contains prompt or completion text |
| `settlement` | As in `done`, and **`settlement` means final**: `settled` (default) or `released` is the ledger's last word on this call, and only `pending` leaves anything to read from the record. `settled` with `charged_2z: 0` and no `receipt_id` is an **uncharged** call — the provider failed before producing anything ([metering.md](./metering.md) §5.2) — not a pending one. `released` is the settler finding the hold expired ([metering.md](./metering.md) §5.6): `charged_2z: 0`, a platform write-off. An error after output is settled for what was produced, and the ledger can be unreachable or the hold expired then too |
| `charged_2z`, `receipt_id`, `collected_milli_2z`, `shortfall_milli_2z` | What this failed call still cost, as in `done`. `charged_2z: 0` and no `receipt_id` when the provider failed before producing anything ([metering.md](./metering.md) §5.2); absent when `settlement` is `pending` |
| `partial` | `true` when the client received at least one `delta` or `tool_call` before the error |

The payload is the crate's `ErrorEvent`; `ErrorEvent::check()` also
enforces that `delivery_aborted` is `pending` and that a `partial` settled
failure charged at least 1 2Z. The HTTP envelope's
`{code, message, details}` is `ApiError`; the §4 `502`'s settlement
`details` decode as `ApiError::failed_call()`. A consumer reads each
payload's `outcome()` rather than `charged_2z`, and an SDK decides a retry
with `ErrorEvent::retryable()` / `ApiError::retryable()`, which refuse to
retry a charged, partial or not-yet-final failure.

### 3.8 A complete stream

The example the rest of this document set refers to: 1,187 input tokens,
342 output tokens, on a model priced (after the 20 % margin, no markup) at
300,000 m2Z per million input tokens and 1,200,000 m2Z per million output
tokens. The hold was computed for 800 output tokens; the settled charge is
1 2Z.

```
event: meta
id: 1
data: {"call_id":"019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c","model":"example-model-small","requested_model":"example-model-small","provider":"example-provider","hold_2z":2,"max_output_tokens":800,"input_tokens_estimate":1200,"created_at":"2026-09-26T21:04:11Z"}

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
  "model": "example-model-small",
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
  "requested_model": "example-model-small",
  "provider": "example-provider",
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
as history). All are the crate's `ChatResponse`, with the same
per-`settlement` rules as `done`.

A failure **after output began** in non-streamed mode is an HTTP **`502`**
whatever the stream-level code would have been — `provider_error`,
`provider_timeout`, `internal` — with that code preserved in the
envelope's `code`, and `details` carrying exactly the `error` event's
fields (§3.7): `call_id`, `settlement`, `charged_2z`, `receipt_id`,
`collected_milli_2z`, `shortfall_milli_2z`, `partial: true`, plus the
partial `message`. The client is charged for what was produced exactly as
in a stream, and this is why streaming is the default. A content-filter
stop is never a failure in this mode: it is `200` with
`finish_reason: "content_filter"`. On a **successful** completion,
`settlement: "pending"` or `"released"` is `200` with the 2Z fields
absent or zero, as in `done`; on a failure it stays inside the `502`'s
`details`.

The gateway bounds nonstreaming aggregation to the smaller of its configured
per-call delivery buffer and 1 MiB of cumulative event bytes (256 KiB by
default). It reserves aggregation and serialization memory before starting the
provider. If shared memory is unavailable, it refuses with `503 unavailable`
and `details.reason: "response_budget"` before creating a billable call. If
output exceeds the bound or delivery is interrupted, it returns `502` with
`internal`, `details.reason: "response_limit"` or `"delivery_interrupted"`,
any retained partial message, and `settlement: "pending"`;
it continues reading and settling the provider independently. A nonstreamed
response deadline also uses `delivery_interrupted`, before the outer HTTP
timeout can discard the call ID. The stream-only `delivery_aborted` event is
translated to this nonstreaming error. Reconcile using
the call ID or the original idempotency key. A completed identical-key replay
is always the JSON call receipt with `X-F2Z-Replayed: true`, including when the
original request selected nonstreaming.

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
      "id": "example-model-small",
      "provider": "example-provider",
      "display_name": "Example model (small)",
      "context_window": 400000,
      "max_output_tokens": 128000,
      "capabilities": { "vision": true, "tools": true, "reasoning": true },
      "prices": {
        "input_milli_2z_per_mtok": 300000,
        "cached_input_milli_2z_per_mtok": 30000,
        "cache_write_milli_2z_per_mtok": 0,
        "output_milli_2z_per_mtok": 1200000,
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
runs on ([`docs/free2z/ai-gateway`](../../ai-gateway/README.md#the-catalogue-contract)):
the same models, with provider prices replaced by marked-up 2Z rates, and
only callable models listed. The catalogue's internal fields (provider
model ids, API styles, safety factors) are not projected.

| Field | Meaning |
|---|---|
| `catalog_version` | The signed catalogue's `version`: an integer that only increases. A `meta` event does not carry it; `GET /v1/calls/{id}` does |
| `includes_markup_bps` | The markup a hold would apply right now for the calling grant — `min(consented, the app's effective markup)` ([metering.md](./metering.md) §2.2) — already inside every price below. `0` for an app without an approved markup |
| `prices.*_milli_2z_per_mtok` | Milli-2Z per **million** tokens (`mtok`), rounded **up** to an integer from the exact rate ([metering.md](./metering.md) §2.4) — a client's own estimate from these is within one 2Z of the ledger's charge, not a bound. `0` means the model has no such price (no cache pricing; no per-image price, so images are billed as tokens) |
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
  "model": "example-model-small",
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
`/v1/chat` would reserve *now*) are required in the crate's
`EstimateResponse`; the rest are optional on decode. Every step fails **exactly as `/v1/chat`
would** — `401`, `403 insufficient_scope`, `429`, `404`,
`400 context_length_exceeded`, and for an unaffordable request
`402 insufficient_balance` or `403 cap_exceeded` with the same `details`
(`available_milli_2z`, `required_2z`, `cap_remaining_milli_2z`, …) — so an
app that handles `/v1/chat`'s errors handles the estimate's with the same
code, and can show "you need N more 2Z" from `details`. An app that must not
run a shortened call compares the answer's `max_output_tokens` with the one it
asked for, and sends the call itself with `max_output_tokens_strict` so that a
balance change between the two cannot shorten it either. An estimate is not
a quotation: the price is the catalogue's at call time.

## 7. `GET /v1/calls/{id}`

The record of one call, for receipts and for recovering from a lost
connection. Only the user who made the call, through the app that made it,
can read it. Requires `ai:invoke`.

```json
{
  "call_id": "019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c",
  "status": "settled",
  "model": "example-model-small",
  "requested_model": "example-model-small",
  "provider": "example-provider",
  "finish_reason": "stop",
  "usage": { "input_tokens": 1187, "cached_input_tokens": 0, "cache_write_tokens": 0,
             "output_tokens": 342, "reasoning_tokens": 0, "images": 0, "tool_calls": 0 },
  "usage_source": "provider",
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
unsettled), `settled_partial` (an error after output; charged for what
was produced — a client disconnect is **not** this: the upstream is read
to completion and the call is `settled` with `finish_reason: cancelled`,
unless the provider then fails, which is `settled_partial` like any
error after output). `error` is `null`, or `{code, message}`
for a call that ended in an `error` event or whose hold expired unsettled
(then `unavailable`, written by the sweeper — [metering.md](./metering.md)
§5.6). `collected_milli_2z` is what was
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
