# The Free2Z AI API — gap analysis and two-layer design

**Status:** proposal, 2026-10-05 · **Refs:** [#1128](https://github.com/free2z/zuu/issues/1128)
(wishlist), [#1135](https://github.com/free2z/zuu/issues/1135) (DX audit),
[#1047](https://github.com/free2z/zuu/issues/1047) (epic) ·
**Contract today:** [`spec/chat-api.md`](./spec/chat-api.md),
[`spec/metering.md`](./spec/metering.md), [`spec/errors.md`](./spec/errors.md),
[ADR 0003](../ai-gateway/adr/0003-unified-api-before-passthrough.md)

The owner's goal: *a fully-fledged AI API that empowers app developers to
make powerful interfaces as if they were using OpenAI, Anthropic or xAI
directly, while we maintain the abstraction across all backends.*

This document is in four parts: what we have (§1), a feature-by-feature gap
analysis against OpenAI Chat Completions, OpenAI Responses, Anthropic
Messages and xAI (§2), the design of a two-layer API — drop-in compatibility
encodings plus Free2Z-native extensions over one metered core, with a signed
capability matrix and cross-provider conformance fixtures (§3) — and the
build order as a list of independently buildable slices (§4). Nothing here
needs a new credential, permission or owner approval: the live catalogue is
OpenAI `gpt-4o`, the Anthropic and xAI keys are not provisioned in
production, and every cross-provider claim below is proven by fixtures, not
by a live call.

## 0. Summary

**Thesis.** ADR 0003 was right: one priceable, metered core. What developers
are missing is not a passthrough but **the shape they already know**. The
design keeps exactly one request plan, one hold, one settlement and one event
pipeline, and adds *encodings* of it — `/v1/chat/completions`,
`/v1/responses`, `/v1/messages` — that the official SDKs, the Vercel AI SDK
and LangChain speak by changing `baseURL` and the bearer. Free2Z-specific
value (estimates, strict budgets, receipts, caps, features) rides as
extension members and `X-F2Z-*` headers that those SDKs tolerate.

**Top gaps by developer impact** (detail in §2, ranking in §2.22):

1. **No drop-in surface.** Every integration today is a port to a bespoke
   schema and SSE grammar; `openai`, `@anthropic-ai/sdk`, `ai`, `langchain`
   cannot be pointed at us. (§3.1)
2. **Sampling controls are refused**, and LangChain/LlamaIndex send
   `temperature` by default — a compat endpoint without §2.7 breaks the
   ecosystem on its first request.
3. **Reasoning is billed but invisible and uncontrollable**: no effort,
   budget, summaries, or thinking-block round-trip (Anthropic needs it for
   tool loops). (§2.5)
4. **Tool calling is landing but only for Chat Completions models** (#1142,
   #1140 merged); hosted tools (web search) are not modelled even though
   `tool_call_nusd` already prices them. (§2.2)
5. **Capabilities are four booleans**; a developer cannot ask "which effort
   levels, which media types, how many tools" and a declared capability has
   no executable proof. (§2.19, §3.3)
6. **Multimodal is not metered at all**: image parts are specified but the
   metered gateway refuses them (no image term in the hold); no PDFs. (§2.4)
7. Prompt caching is reported but not controllable; Anthropic cache-write
   TTLs are mis-priced (#1059). (§2.6)
8. Non-chat modalities (embeddings, image generation, TTS/STT, moderation,
   batch) do not exist; most need a priced dimension the catalogue cannot
   express yet, and the 1 2Z minimum charge makes sub-cent calls unsellable.
   (§2.10–§2.14, §3.5.6)

**Build order:** conformance harness and sampling first, then the Chat
Completions encoding (the slice with the most developer impact), then
reasoning, Messages and Responses encodings, caching, multimodal, the
capability matrix projection, extensions, embeddings. §4 has the
dependency map and the parallel waves.

## 1. Ground truth

### 1.1 What exists on `origin/main` (6fe737c2)

| Surface | Today |
|---|---|
| Routes | `POST /v1/chat`, `POST /v1/chat/estimate`, `GET /v1/models`, `GET /v1/calls/{id}` (gateway `server.rs`); admin `/healthz`, `/readyz`, `/metrics` |
| Request (`f2z-ai-proto::ChatRequest`, `deny_unknown_fields`) | `model`, `messages[]` (`system`/`user`/`assistant`/`tool`; parts `text`, `image` base64), `tools[]` (`name`, `description`, `parameters`), `max_output_tokens`, `max_output_tokens_strict`, `stream`, `metadata`, `fallback[]`, `response_format` (`json_schema` / `json_object`, #1129). **Specified and typed but refused by the metered gateway today:** `image` parts and a non-empty `fallback` — `meter::plan` answers `400 invalid_request` ("this gateway release supports text input and a single model"), and finalisation supports one attempt. Both are gaps below (§2.4, §2.23), not features |
| Events | `meta`, `delta` (text only), `tool_call` (complete), `usage`, `done`, `error`; `: ping` every 15 s; no `Last-Event-ID` |
| Usage | `input_tokens`, `cached_input_tokens`, `cache_write_tokens`, `output_tokens` (incl. reasoning), `reasoning_tokens`, `images`, `tool_calls` (server-side only, #1066) |
| Adapters | `openai_responses`, `openai_chat` (OpenAI + xAI), `anthropic_messages`; usage normalisation per provider; retries only before a 2xx head; circuit breaker; header allowlist; no URL fetch |
| Catalogue (signed, Ed25519, schema 1; opt-in schema 2 long-context tiers) | per model: `id`, `provider`, `provider_model_id`, `api_style`, `capabilities{vision,tools,reasoning,structured_output}` (tri-state `structured_output`), `prices` (6 dimensions, **`deny_unknown_fields`**), `min_charge_2z ≥ 1`, `safety_factor_bps`, `context_window`, `max_output_tokens`, `ttfb_timeout_ms`, `idle_timeout_ms`, `enabled` |
| Metering | hold = worst case at the dearest input rate for `out_cap`; 300 s hold TTL, extend every 60 s and on each `tool_call`; settle from provider usage in nano-USD; charge rounded up once to a whole 2Z, splits in milli-2Z; shortfall written off, never debt |
| Errors | 26 codes (`ErrorCode::ALL`), envelope `{"error":{code,message,details}}`; stream `error` event with settlement fields |
| Headers | `Idempotency-Key` (24 h, per app+user), `X-F2Z-Call-Id`, `X-F2Z-Replayed`, `X-F2Z-RateLimit-{Limit,Remaining,Reset}`, `Retry-After`, `ETag`/`Cache-Control` on `/v1/models` |
| Limits | 4 MiB body (20 MiB with images), 20 images, `metadata` 16 keys, schema 32 KiB, 4 open streams per user, 16 open holds, 300 s per call |
| SDKs | `f2z-sdk` (Rust), `@free2z/sdk` (TS; fetch + Tauri transports), guest-js, `tauri-plugin-f2z`; typed models/capabilities (#1137), preflight (#1136 in flight) |
| Observability | per-call content-free `features` record (zuu #1141, tuzi #2482): `response_format`, `…_strict`, `…_schema_name`, `…_schema_bytes`, `tools`, `max_output_tokens_strict`, `stream`, `fallback` |

### 1.2 In flight — designed around, not duplicated

| Work | What it lands | This design assumes |
|---|---|---|
| [#1142](https://github.com/free2z/zuu/pull/1142) `feat/ai-tools-openai` | `tool_choice`, `parallel_tool_calls`, `Tool.strict`, **`tool_call_delta` event**, `check_tools` limits (128 tools, 32 KiB params), `capabilities.strict_tools`, `TOOLS.md`, `tests/fixtures/tool_calling/*` + `tool_conformance.rs` | the unified tool wire is OpenAI-shaped; the fixture format in §3.4 extends this one |
| [#1140](https://github.com/free2z/zuu/pull/1140) Anthropic tools + structured output (**merged** 4527e8fa) | `tool_choice` → `auto/any/tool/none`, `disable_parallel_tool_use`, `response_format` as a forced tool, Anthropic fixtures | Anthropic structured output is the forced-tool mode, declared in the catalogue |
| [#1143](https://github.com/free2z/zuu/pull/1143) (#1132) | `OrderedJson` for schemas; fingerprints unchanged | compat encodings decode schemas into `OrderedJson` too |
| [#1138](https://github.com/free2z/zuu/pull/1138) (**merged**), [#1136](https://github.com/free2z/zuu/pull/1136) | sign-in codes; DX (preflight, typed errors, quickstart) | out of scope here |
| tuzi #2482 + zuu #1141 | per-call `features` | new features extend the record (§3.2.4) |
| **Catalogue as the single source of model truth** (orchestrator, 2026-10-05, in progress by another agent) | provider model discovery with the existing keys; rate card v3 with audited prices and a long-context cap; catalogue = discovered ∩ priced ∩ enabled, **signed with capabilities**; the gateway admits exactly the signed catalogue (no static allow-list), with an emergency override | **every capability claim in this document is a signed catalogue member read by the gateway, never a name-based or hard-coded rule.** §3.3 defines *which* members and what the gateway and SDKs do with them; it does not define discovery, pricing or admission, which are that work's |

### 1.3 Provider reality

Production serves OpenAI `gpt-4o` through the Chat Completions adapter. The
Anthropic and xAI adapters exist and are tested against loopback fixtures;
their keys are not provisioned. So every "works across backends" statement
is a **conformance** statement — a fixture per (feature × `api_style`),
documented-shape synthetic streams, no live call in CI — and the day a key
is provisioned the catalogue (not code) opens the model.

## 2. Gap analysis

Legend for the "cross-backend" column: **translate** = the gateway maps the
unified field to each provider's form; **gate** = the signed catalogue
declares support and the gateway refuses, typed and before any hold, where
it is absent; **refuse** = not expressible on that backend, always a `400`
naming the field and `details.reason`. Nothing is ever silently dropped
(chat-api.md §2.1).

### 2.1 Streaming events

| | OpenAI Chat Completions | OpenAI Responses | Anthropic Messages | xAI |
|---|---|---|---|---|
| Text | `choices[].delta.content` | `response.output_text.delta` | `content_block_delta` `text_delta` | as OpenAI CC |
| Tool-call argument deltas | `delta.tool_calls[{index,id,function{name,arguments}}]` | `response.function_call_arguments.delta/.done`, `output_item.added/done` | `content_block_start` (`tool_use`) + `input_json_delta` + `content_block_stop` | whole call in one chunk |
| Reasoning | `reasoning_content` is not standard (o-series emit none) | `response.reasoning_summary_text.delta`, `reasoning` items with `encrypted_content` | `thinking_delta`, `signature_delta` | `reasoning_content` deltas (grok-3-mini) |
| Usage | final chunk with `stream_options.include_usage` | on `response.completed/incomplete/failed` | `message_start` + cumulative `message_delta.usage` | as CC, `completion_tokens` excludes reasoning |
| Lifecycle | `[DONE]` sentinel | `response.created … completed`, typed events, `sequence_number` | `message_start … message_stop`, `ping`, `error` | `[DONE]` |
| Citations / annotations | `annotations` (search models) | `output_text.annotation.added` | `citations_delta` | `citations` |

**We have:** `meta`, `delta`(text), `tool_call` (complete), `usage` (once),
`done`/`error` with settlement; `tool_call_delta` in #1142. **Gap:** no
reasoning deltas, no reasoning/thinking output part, no annotations, no
content-part boundaries (a client cannot tell where a text part ended and
a tool call began except by event order). **Design:** keep the grammar
additive — new event *names* (`reasoning_delta`, `part_start`/`part_stop`,
`annotation`), never new shapes — per chat-api.md §3.1; the compat encoders
(§3.1) render each provider's native grammar from these. `usage` stays
once-per-stream; the encoders synthesise the provider-native placement.

### 2.2 Tools

| Feature | OpenAI CC | Responses | Anthropic | xAI | We have / gap |
|---|---|---|---|---|---|
| Function tools, results back | ✓ | ✓ (`function_call` / `function_call_output` items) | ✓ (`tool_use`/`tool_result` blocks) | ✓ | have |
| `tool_choice` auto/none/required/named | ✓ | ✓ | `auto/none/any/tool` | ✓ | #1142 (CC), #1140 (Anthropic); **Responses refuses in #1142** → §4 S8 |
| `parallel_tool_calls` | ✓ | ✓ | `disable_parallel_tool_use` | ✓ | #1142/#1140 |
| `strict` schemas | ✓ | ✓ | `strict` on tool (2026) | undocumented → refused | #1142: catalogue `strict_tools` |
| Hosted: web search | `web_search_options` on search models | `web_search` tool | `web_search_20250305` | `search_parameters` / agentic `web_search`, `x_search` | **gap**; §3.1.6 — priceable today with `tool_call_nusd` (one hosted tool type per model) |
| Hosted: code interpreter / execution | — | `code_interpreter` (per container session) | `code_execution` (per session hour) | `code_execution` | **gap**; per-session prices need a price dimension → deferred (§3.5.6) |
| Hosted: file search / files | — | `file_search` (per call + storage) | Files API + `document` | — | **refuse**: needs a store the platform does not run |
| MCP / computer use | — | `mcp`, `computer_use_preview` | MCP connector, `computer` | — | **refuse**: remote-tool fan-out is unpriced and unbounded |
| Tool-call limits | — | `max_tool_calls` | `max_uses` (web search) | — | `tool_budget` in the hold (metering.md §3) — expose as `max_tool_calls` in S-hosted |

Unified expression: OpenAI's `tools[].type` discriminator. `function` is
the client-executed kind we have; `web_search` is a hosted kind the gateway
*relays to the provider* and bills per invocation (`usage.tool_calls`,
`tool_call_nusd`). Everything else is refused with `reason:
"hosted_tool_unsupported"` and `field: "tools[i].type"`.

### 2.3 Structured output

OpenAI CC `response_format` (native strict), Responses `text.format`,
Anthropic forced tool (#1140) or structured-outputs beta, xAI native.
**We have:** `response_format` on CC (#1129) and Anthropic (#1140);
Responses refuses. **Gap:** Responses `text.format` translation; a
`refusal` output (OpenAI emits `refusal` deltas on strict schemas, we emit
them as text); no `response_format.json_schema.schema` dialect check
(OpenAI's strict subset: `additionalProperties:false`, all properties
required, no `$ref` to external, depth ≤ 5, ≤ 5000 properties). **Design:**
a `refusal` output part (`OutputPart::Refusal{text}`, event `delta.kind:
"refusal"` — see §2.1 on additive deltas), and a gateway-side dialect check
that fails *before* the hold with `reason: "schema_unsupported"` and the
JSON pointer of the offending keyword, per `api_style`. Billing unchanged.

### 2.4 Multimodal input

| Input | OpenAI CC | Responses | Anthropic | xAI | We have / gap |
|---|---|---|---|---|---|
| Image (base64) | `image_url` data URL, `detail` | `input_image` | `image` `base64` | as CC | **wire only**: the `image` part (4 media types, 20/request) is specified, decoded and sent by the adapters, but `meter::plan` refuses it because the hold has no image term; no `detail` |
| Image (URL) | ✓ | ✓ | ✓ | ✓ | **refuse by design** (no URL fetch); compat decodes only `data:` URLs → `reason: "url_fetch_unsupported"` |
| PDF / document | `file` with `file_data` (base64) | `input_file` | `document` (base64 PDF, text) | — | **gap**; priced as tokens (text + page images) by both providers |
| Audio in | `input_audio` (gpt-4o-audio, per audio token) | ✓ | — | — | **gap**; needs an audio token price dimension → deferred |
| Video | — | — | — | — (Grok vision = images) | n/a |

**Hold bound:** images on token-billed providers (`openai`, `anthropic`,
tuzi `TOKEN_BILLED_IMAGE_PROVIDERS`) enter `input_tokens`, and today the
plan has no term for them, which is why it refuses the part. §3.5.3 gives
the hold a real bound per input kind — the provider's documented sizing
formula applied to the image's actual dimensions, and a byte bound for
documents — with the formula's parameters and ceilings signed per model
(`controls.image_tokenizer`, `limits.image_tokens_max`,
`limits.pdf_pages_max`, `limits.document_bytes_max`), never a gateway
constant. A model without `capabilities.pdf_input` refuses the part before
any hold.

### 2.5 Reasoning controls

| | OpenAI CC | Responses | Anthropic | xAI |
|---|---|---|---|---|
| Effort | `reasoning_effort` (`minimal/low/medium/high`) | `reasoning.effort` | — (`thinking` budget) | `reasoning_effort` `low/high` (grok-3-mini only) |
| Budget | — | — | `thinking.budget_tokens` (≥ 1024, < `max_tokens`) | — |
| Summaries / visible thinking | — | `reasoning.summary: auto/concise/detailed` | `thinking` blocks, streamed | `reasoning_content` streamed |
| Round-trip in history | — | `reasoning` items (`encrypted_content` with `store:false` + `include`) | `thinking` blocks with `signature` **required** in multi-turn tool use | not required |

**We have:** `reasoning_tokens` in usage, `capabilities.reasoning`,
`idle_timeout_ms`. **Gap:** everything else. **Design (S3):** one unified
`reasoning` object — `{"effort": "low|medium|high", "budget_tokens": n,
"summary": "auto|none"}` — gated by signed `capabilities.reasoning_effort`,
`reasoning_budget`, `reasoning_summary`. Translation: effort → OpenAI/xAI
natively; effort → an Anthropic budget by a declared table in the catalogue
(`controls.effort_budgets`), never a gateway constant; budget → Anthropic
natively, refused elsewhere. Output: a `reasoning` output part and
`reasoning_delta` events; opaque provider state (`signature`,
`encrypted_content`) carried as `provider_state` on the part, accepted back
on an `assistant` turn and forwarded **only to the same provider** (a
provider switch via `fallback` drops it and the `features` record counts
`reasoning_history_dropped`). **Billing:** reasoning is inside
`output_tokens`; `budget_tokens` must be `< out_cap` after clamping or the
request is refused with the clamping bound's code and `reason:
"reasoning_budget"` — the gateway never silently lowers a budget.

### 2.6 Prompt caching

OpenAI/xAI: automatic, ≥ 1024-token prefixes, `prompt_cache_key` hint,
`cached_tokens` in usage. Anthropic: explicit `cache_control` breakpoints
(≤ 4), 5 m or 1 h TTL, writes billed at 1.25× / 2× input, reads 0.1×.
**We have:** usage reporting for both, one `cache_write_nusd_per_mtok`
(#1059: 5 m and 1 h differ). **Gap:** no `cache_control` on parts/tools/
system; no `prompt_cache_key`. **Design (S4):** `cache_control: {"ttl":
"5m"|"1h"}` on a content part, a tool or the system message, gated by
`capabilities.prompt_cache_control`; `prompt_cache_key` string gated by
`capabilities.prompt_cache_key`. Hold: the dearest input rate already covers
a write (metering.md §4); with a `1h` breakpoint the dearest rate is the 1 h
write rate — a catalogue price dimension (schema bump, §3.5.6), until which
`ttl: "1h"` is refused on every model (`reason: "cache_ttl_unpriced"`).

### 2.7 Sampling parameters

| Param | OpenAI CC | Responses | Anthropic | xAI | Design |
|---|---|---|---|---|---|
| `temperature` | 0–2 | ✓ | 0–1 | ✓ | translate; Anthropic range clamp is a **refusal** above 1 (`reason: "range"`) not a clamp |
| `top_p` | ✓ | ✓ | ✓ (not with temperature on new models) | ✓ | translate; Anthropic both-set → refuse |
| `top_k` | — | — | ✓ | — | gate `capabilities.top_k` |
| `stop` | ≤ 4 strings | — (text only) | `stop_sequences` | ✓ | translate; Responses refuse |
| `seed` | ✓ (best effort) | — | — | ✓ | gate `capabilities.seed` |
| `logprobs`/`top_logprobs` | ✓ | `include: ["message.output_text.logprobs"]` | — | ✓ | gate `capabilities.logprobs`; new `delta.logprobs` member |
| `n` | ✓ | — | — | ✓ | **refuse `n > 1` in v1** (`reason: "n_unsupported"`): it multiplies the hold and the event grammar has one choice |
| `frequency_penalty`, `presence_penalty`, `logit_bias` | ✓ | — | — | ✓ | gate `capabilities.penalties`; `logit_bias` refuse (tokeniser-specific) |
| `max_tokens` (legacy) | deprecated alias | `max_output_tokens` | `max_tokens` required | ✓ | compat alias → `max_output_tokens` |

**We have:** nothing; refused. **Gap:** total. This is the first slice
(S1): it is small, every adapter honours the core four, and the compat
endpoints are unusable without it (LangChain's `ChatOpenAI` sends
`temperature`; Vercel AI SDK forwards whatever the app sets).

### 2.8 System / developer roles

OpenAI: `system` or `developer` (o-series and GPT-5 want `developer`);
Responses: `instructions`. Anthropic: top-level `system` (string or blocks
with `cache_control`). xAI: `system`. **We have:** at most one `system`
message, first. **Gap:** `developer` alias; several system messages
(LangChain prepends; Anthropic accepts multiple blocks). **Design (S2):**
accept `developer` as a synonym (emitted as `developer` where the catalogue
says `controls.system_role: "developer"`, else `system`); allow more than
one `system`/`developer` message anywhere before the first `user` turn,
concatenated in order with a blank line for providers that take one.

### 2.9 Conversation state

Responses: `previous_response_id`, `conversation`, `store` (default true).
Anthropic: stateless. **We have:** stateless; the gateway retains no
completions (chat-api.md §7). **Design:** stateless everywhere. The
Responses encoding forces `store: false`; `previous_response_id`,
`conversation` and `store: true` are refused with `reason: "stateless"` and
a message pointing at `input` history. Revisit only with a consented
retention product; the legacy tuzi `/api/ai/conversations/` is not that.

### 2.10 Embeddings

OpenAI `/v1/embeddings` (per input token, no output), xAI none (as of this
writing), Anthropic none (Voyage). **We have:** nothing. **Design (S13):**
new `api_style: "openai_embeddings"` served at `/v1/embeddings` in the
OpenAI shape; priced with the **existing** `input_nusd_per_mtok` and a zero
output price, so no catalogue schema bump; hold = `input_est × input rate`;
settle from `usage.prompt_tokens`. **Blocker to flag:** `min_charge_2z ≥ 1`
makes a 100-token embedding cost 1 2Z ($0.01) for $0.000002 of cost; batched
`input[]` amortises it, but sub-cent metering needs a milli-2Z minimum
charge — a ledger and catalogue contract change for the owner to decide,
not a slice here.

### 2.11 Moderation

OpenAI `/v1/moderations` is free; Anthropic/xAI have none. A free call
cannot go through a hold with `min_charge_2z ≥ 1`, and an unmetered
endpoint has no admission story beyond rate limits. **Design:** not a
slice; the same minimum-charge decision as §2.10 unlocks it.

### 2.12 Image generation

OpenAI `gpt-image-1` per image by size/quality (plus input tokens),
xAI `grok-2-image` per image, Anthropic none. **Design:** needs an output
image price dimension (per size/quality tier) → catalogue schema bump
(§3.5.6); until then not buildable. The endpoint shape is OpenAI's
`/v1/images/generations` with `n × price` held.

### 2.13 TTS / STT

OpenAI per character (TTS) and per minute (STT), `gpt-4o-transcribe` per
audio token; xAI none; Anthropic none. **Design:** per-character and
per-second price dimensions → same schema bump. Not buildable yet.

### 2.14 Batch

OpenAI Batch and Anthropic Message Batches: 50 % off, results within 24 h.
**Design:** incompatible with the hold model (300 s TTL, extended by a
live gateway). It needs a deferred-settlement ledger primitive (a
reservation that outlives the gateway process and settles on a callback).
Not a slice; recorded so that nobody models it as a long stream.

### 2.15 Usage and cost reporting

Providers report tokens; nobody reports money. **We have:** the strongest
story in the comparison — `usage` normalised across providers, `done` with
`charged_2z`, `receipt_id`, `hold_2z`, `released_2z`,
`collected_milli_2z`, `shortfall_milli_2z`, `cap_remaining_milli_2z`,
`balance_hint_milli_2z`; `GET /v1/calls/{id}` for 90 days. **Gap:** no
list endpoint (`GET /v1/calls?since=`), no per-call provider-cost
transparency (by design: the user pays 2Z), `cap_remaining_milli_2z` only
populated on the estimate (#1133). **Design:** the `f2z` extension object
(§3.2) carries the same fields on every compat surface; a list endpoint is
a ledger function (tuzi) and a later slice.

### 2.16 Idempotency

OpenAI/Anthropic: `Idempotency-Key` honoured (Anthropic documents it;
Stainless-generated SDKs attach one on POST retries). **We have:** a
stricter, better-specified contract (chat-api.md §2.5): 24 h, body
fingerprint, `409` while running, record replay when terminal. **Gap:** a
replay returns a *record*, which no official SDK can parse as a completion.
**Design (§3.1.5):** on a compat surface a terminal replay is
`410 completion_not_retained` with the record in `details` — honest, not
retried by Stainless SDKs (they retry 408/409/429/5xx), and the receipt is
one `GET` away. Native keeps `200` + record.

### 2.17 Error taxonomy

OpenAI: `{"error":{"message","type","param","code"}}` with `type ∈
invalid_request_error | authentication_error | permission_error |
not_found_error | rate_limit_error | server_error | insufficient_quota`.
Anthropic: `{"type":"error","error":{"type","message"}}` with
`invalid_request_error | authentication_error | permission_error |
not_found_error | request_too_large | rate_limit_error | api_error |
overloaded_error`. **We have:** `{"error":{code,message,details}}` — the
same outer key as OpenAI. **Design:** a **superset envelope** (§3.1.4):
every compat error carries our `code`/`details` *and* the provider-shaped
`type`/`param` (and Anthropic's outer `type: "error"` on `/v1/messages`), so
official SDKs raise their typed exceptions and our SDKs decode unchanged.

### 2.18 Rate limits and headers

OpenAI: `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`,
`x-request-id`, `retry-after`. Anthropic: `anthropic-ratelimit-{requests,
tokens,input-tokens,output-tokens}-{limit,remaining,reset}`, `request-id`,
`retry-after`. **We have:** `X-F2Z-RateLimit-*` (requests only),
`X-F2Z-Call-Id`, `Retry-After`. **Design:** emit the provider-shaped
request-rate headers as aliases on the compat surfaces, `x-request-id` and
`request-id` = `X-F2Z-Call-Id` (the SDKs expose it as `_request_id`), and
`anthropic-ratelimit-*`; token-rate headers are omitted (we rate-limit
requests and 2Z, not tokens) — omitting is tolerated, lying is not.

### 2.19 Model discovery and capabilities

OpenAI `GET /v1/models` (`{object:"list", data:[{id, object, created,
owned_by}]}`) says nothing about capabilities; Anthropic `GET /v1/models`
(`{data:[{type, id, display_name, created_at}], has_more, first_id,
last_id}`) likewise. **We have:** the only catalogue in the comparison with
prices and capabilities — four booleans. **Gap:** enumerations and limits
(which efforts, media types, how many tools, hosted tools), an executable
proof per declared capability, and the list shapes the official SDKs parse.
**Design (§3.3):** `/v1/models` becomes a superset of all three shapes with
a typed, signed `capabilities` + `controls` + `limits` matrix, projected from
the signed catalogue that the in-flight discovery work produces.

### 2.20 Token counting

Anthropic `POST /v1/messages/count_tokens`; OpenAI none (tiktoken
client-side). **We have:** `/v1/chat/estimate` (safety-factored, priced).
**Design:** `count_tokens` on the Messages encoding maps to the estimate and
answers `{input_tokens, f2z:{…}}`.

### 2.21 Timeouts, cancellation, metadata, user ids

All three providers accept `metadata`/`user` (abuse attribution). **We
have:** `metadata` (16 keys, never sent upstream), cancel = close the
connection, per-model TTFB/idle, 300 s hard limit. **Design:** compat
`metadata` → ours; OpenAI `user` / Anthropic `metadata.user_id` → stored
under `metadata.user` (never sent upstream — the platform knows the user;
sending an app's id to the provider adds nothing and leaks).
`safety_identifier`, `service_tier`, `prompt_cache_key` (OpenAI) are
accepted where the catalogue says so, else refused.

### 2.22 Ranking by developer impact

| # | Gap | Who it blocks today | Slice |
|---|---|---|---|
| 1 | No OpenAI-compatible endpoint | every existing OpenAI/Vercel/LangChain app | S6 |
| 2 | Sampling refused | the same, on request one | S1 |
| 3 | Reasoning controls and visibility | tutor/agent apps on o-series, Claude, Grok | S3 |
| 4 | Tools on Responses; hosted web search | agent apps | S8, S-hosted |
| 5 | Anthropic-compatible endpoint | Claude-first apps, LangChain `ChatAnthropic` | S7 |
| 6 | Capability matrix with proof | SDK authors, app model pickers | S9 |
| 7 | PDF input, image `detail`, token bounds | document apps (¡AHA! activity specs from PDFs) | S5 |
| 8 | `cache_control`, 1 h writes | long-system-prompt apps | S4 |
| 9 | Extensions on compat (strict budget, estimate, caps, receipts) | every compat user who wants Free2Z's guarantees | S11 |
| 10 | Embeddings | RAG apps | S13 |
| 11 | `fallback` refused by the metered path | apps that want outage resilience the spec promises | S12 |

### 2.23 Fallback

chat-api.md §2.1 and metering.md §5.7 specify ordered `fallback` with one
hold per attempt and `meta.requested_model`; `ChatRequest::attempts()` and
`ErrorCode::falls_back()` exist. **The metered gateway refuses any non-empty
`fallback` (`meter::plan`) and its finalisation records one attempt.** No
provider has an equivalent (it is a Free2Z feature), so the only gap is
ours: S12 implements the lifecycle the spec already has — release the
failed attempt's hold, take the next at the next model's price, each model
once, never after `meta`, never after a disconnect — and only then do the
compat carriers of §3.2 expose it.

## 3. Design

### 3.0 Principles — ADR 0003, extended

The compatibility layer is **not a passthrough**. Each compat endpoint is an
*encoding* of the unified request: its body is decoded strictly into the
same `ChatRequest` (plus the additions of §2), goes through the same
`meter::plan` (capability gates, estimate, clamp, hold), the same adapter,
and the same event pipeline; the only new code is a decoder in front and a
renderer behind. Consequences, all inherited from the ADR:

- **Priceable before it is made.** A compat body cannot contain anything the
  unified request cannot, so the hold formula is unchanged.
- **Allowlisted per field.** Unknown or unsupported members are `400` with
  the provider-shaped envelope, never forwarded.
- **One metering, one record.** `features.api` names the encoding; receipts
  and `GET /v1/calls/{id}` are identical.
- **Tolerant out.** Compat responses are the provider's documented shape
  **plus** `f2z` members; our SDKs never need the compat surfaces.

This is recorded as **ADR 0005 — compatibility encodings of the unified
API** (slice S6 adds the file next to ADR 0003).

### 3.1 Layer A — drop-in compatibility encodings

| Encoding | Route | Mirrors | Auth | Who it unlocks |
|---|---|---|---|---|
| Chat Completions | `POST /v1/chat/completions` | OpenAI Chat Completions (2026-10 shape) | `Authorization: Bearer <access token>` | `openai` (py/node), Vercel `@ai-sdk/openai` + `openai-compatible`, `@langchain/openai`, LlamaIndex, every "OpenAI-compatible" client |
| Responses | `POST /v1/responses` | OpenAI Responses (stateless subset) | same | `openai` Responses clients, Vercel `@ai-sdk/openai` responses mode, Agents SDK (function tools only) |
| Messages | `POST /v1/messages`, `POST /v1/messages/count_tokens` | Anthropic Messages | `x-api-key: <access token>` **or** Bearer; `anthropic-version` accepted | `@anthropic-ai/sdk`, `anthropic` (py), Vercel `@ai-sdk/anthropic`, `@langchain/anthropic` |
| Models | `GET /v1/models`, `GET /v1/models/{id}` | OpenAI list + Anthropic list + ours (§3.3) | either | `client.models.list()` in every SDK |

**Tokens.** The bearer is the OIDC access token (`aud` `f2z-ai`, scope
`ai:invoke`) — short-lived. The official SDKs take a static key, so the
SDK-side piece is a **token source**: `@free2z/sdk` exports
`client.compatFetch()` (a `fetch` that injects and refreshes the token;
`openai`, `@anthropic-ai/sdk`, Vercel AI SDK and LangChain all accept a
custom `fetch`) and, for Python, an `httpx.Auth`. No new credential type
exists; a long-lived API key is a product decision outside this document.

**CORS.** Browser use of the official SDKs needs the gateway (or the
ingress) to answer preflight for `Authorization`, `x-api-key`,
`anthropic-version`, `Idempotency-Key`, `X-F2Z-*`, and to expose
`X-F2Z-*`, `x-request-id`, `request-id`. S6 verifies where preflight is
answered today and adds the allowlist.

#### 3.1.1 Decoding — the field matrix

Every compat member is one of: **mapped** (to a unified field), **accepted
and ignored** (documented, harmless telemetry such as `x-stainless-*`
headers, `OpenAI-Organization`, `OpenAI-Project`), **refused** (`400`,
`param` = the JSON pointer, `code` from our taxonomy, `details.reason`).
There is no fourth state.

| OpenAI CC member | Unified |
|---|---|
| `model`, `messages` (string content, parts `text`, `image_url` with `data:` URL + `detail`, `file`), roles `system/developer/user/assistant/tool`, `tool_calls`, `tool_call_id`, `name` (dropped into `metadata.name_*`? **no — refused**: no unified equivalent) | `ChatRequest` (S2 for `developer`, S5 for `file`/`detail`) |
| `tools[]` (`type: function` → ours; others → refuse unless S-hosted), `tool_choice`, `parallel_tool_calls`, `functions`/`function_call` (legacy → refuse with pointer to `tools`) | #1142 |
| `response_format` | ours (same shape) |
| `max_completion_tokens`, `max_tokens` | `max_output_tokens` (both present and different → refuse) |
| `temperature`, `top_p`, `stop`, `seed`, `logprobs`, `top_logprobs`, `n`, `frequency_penalty`, `presence_penalty`, `logit_bias` | S1 (`n` must be 1; `logit_bias` refused) |
| `reasoning_effort` | S3 |
| `stream`, `stream_options` | `stream`; usage is always included |
| `metadata`, `user`, `safety_identifier`, `prompt_cache_key`, `service_tier`, `store` | `metadata` (+`user`), S4 `prompt_cache_key`; `service_tier` and `store:true` refused (`stateless`) |
| `modalities`, `audio`, `prediction`, `web_search_options` | refused (`modality_unsupported`, `hosted_tool_unsupported`) until priced |
| `f2z` | §3.2 |

| Responses member | Unified |
|---|---|
| `model`, `instructions`, `input` (string or items: `message` with `input_text`/`input_image`/`input_file`, `function_call`, `function_call_output`, `reasoning`) | messages (S2 for `instructions` → system; S3 `reasoning` items → reasoning part with `provider_state`) |
| `tools[]` `function` (flat shape) / hosted types; `tool_choice`; `parallel_tool_calls`; `max_tool_calls` | #1142 shape; hosted per S-hosted; `max_tool_calls` → tool budget cap |
| `text.format` (`json_schema`/`json_object`/`text`), `text.verbosity` | `response_format`; `verbosity` gated |
| `max_output_tokens`, `temperature`, `top_p`, `truncation` (`disabled` only) | ours / S1 |
| `reasoning.effort`, `reasoning.summary`, `include: ["reasoning.encrypted_content"]` | S3 |
| `stream`, `metadata`, `user`, `safety_identifier`, `prompt_cache_key` | as CC |
| `store`, `previous_response_id`, `conversation`, `background`, `service_tier` | refused (`stateless` / `unsupported`) |

| Messages member | Unified |
|---|---|
| `model`, `max_tokens` (required → `max_output_tokens`), `system` (string or blocks), `messages[]` with blocks `text`, `image` (`base64` only; `url` refused), `document` (S5), `tool_use`, `tool_result` (content string or blocks), `thinking`/`redacted_thinking` (S3) | ours |
| `tools[]` (`input_schema` → `parameters`, `strict`), `tool_choice` (`auto/any/tool/none`, `disable_parallel_tool_use`) | #1140's inverse mapping |
| `temperature`, `top_p`, `top_k`, `stop_sequences` | S1 |
| `thinking` (`enabled` + `budget_tokens`, `disabled`) | S3 |
| `cache_control` on blocks/tools/system | S4 |
| `metadata.user_id` | `metadata.user` |
| `stream` | `stream` |
| `output_format` / structured outputs beta, `container`, `mcp_servers`, `betas` | refused per field (`anthropic-beta` header: known-inert values accepted and recorded, unknown refused) |

Compat decoders produce the **same `ChatRequest`** the native route would,
so the idempotency fingerprint, the `features` record and every limit
(`check_tools`, `ResponseFormat::check`, body size) apply unchanged. One
addition: the fingerprint includes the encoding name, so the same logical
call sent through two encodings is two calls, never a cross-shape replay.

#### 3.1.2 Rendering — streams

The renderer consumes the unified events and emits the provider's grammar.
Pinned by fixtures (§3.4), including the official SDKs' parsers.

| Unified | Chat Completions | Responses | Messages |
|---|---|---|---|
| `meta` | first chunk: `{id: call_id, object: "chat.completion.chunk", created, model, choices: [{index: 0, delta: {role: "assistant", content: ""}}], f2z: {…}}` | `response.created` + `response.in_progress` with `response.f2z` | `message_start` with `message.usage` (input estimate, `f2z` inside `message`) |
| `delta` (text) | `delta.content` | `response.output_text.delta` (+ `output_item.added`/`content_part.added` on the first) | `content_block_start`(text) + `content_block_delta` `text_delta` |
| `delta` (`kind: refusal`) | `delta.refusal` | `response.refusal.delta` | text block (Anthropic has no refusal part) |
| `reasoning_delta` (S3) | `delta.reasoning_content` (xAI-style; OpenAI clients ignore) | `response.reasoning_summary_text.delta` | `thinking_delta` (+ `signature_delta` from `provider_state`) |
| `tool_call_delta` (#1142) | `delta.tool_calls[{index, id, type: "function", function: {name, arguments}}]` | `output_item.added`(function_call) + `function_call_arguments.delta` | `content_block_start`(tool_use) + `input_json_delta` |
| `tool_call` (complete) | nothing new (the deltas were authoritative-enough; a client that only reads complete calls sees the same text) — the renderer emits a delta per call when no fragments were streamed | `function_call_arguments.done` + `output_item.done` | `content_block_stop` |
| `usage` | last chunk `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`) | on `response.completed` | `message_delta.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) |
| `done` | last chunk `finish_reason`, `f2z` with settlement; then `data: [DONE]` | `response.completed` (or `response.incomplete` for `length`) with `response.f2z` | `message_delta` (`stop_reason`, `f2z`) + `message_stop` |
| `error` before the HTTP response (steps 1–6) | HTTP status with the superset envelope | same | same |
| `error` inside the stream (step 7 onwards, before or after `meta`) | a chunk `{"error": {…superset…}}` then close — `openai-python`/`openai-node` raise `APIError` on an `error` member in a chunk and **do not retry** (retries are decided on the HTTP status) | `response.failed` with `response.error` + `f2z` | `event: error` with the Anthropic error shape + `f2z` |

**Headers at the hold, exactly as the native route.** A streamed compat
call sends `200` and its headers when the hold exists (chat-api.md §2.2),
`: ping` comments flow every 15 s while the provider is contacted (the
Stainless SSE decoders skip comment lines), and every failure from step 7
on — including one the provider may already have accepted and billed —
arrives as an in-stream error chunk, which the official SDKs surface as an
error and never retry at the HTTP level. That matters: the gateway itself
never re-sends a request after the provider could have accepted it
(`provider/upstream.rs`), and a compat design that turned those failures
into `5xx` statuses would hand that retry to an SDK that retries `5xx`
by default — a second paid upstream request. For the same reason the
compat quickstart tells developers to keep the SDK's default `stream: true`
where they can. **Non-streamed** compat calls have the native route's
exposure (chat-api.md §4: a failure after acceptance is a `502` carrying
`f2z.settlement`): the guard is the `Idempotency-Key` — a retry carrying the
same key meets the running or terminal record (§3.1.5) and starts no
provider call. Whether a given official SDK attaches a key on its automatic
retries is **observed by the conformance job (§3.4 rule 4), not assumed**;
for an SDK that does not, the quickstart sets `maxRetries: 0` for
non-streamed calls and the renderer adds `Retry-After` only to the
retryable pre-acceptance statuses (`429`, `503`), never to a `502` whose
provider attempt was accepted.

**xAI through the Chat Completions encoding** is the native shape with one
difference the renderer preserves: `completion_tokens` excludes reasoning
when the serving provider is `xai` (the catalogue says, the adapter already
knows), so a client that computes cost from the provider's convention gets
the provider's convention.

#### 3.1.3 Finish reasons

| Unified | CC `finish_reason` | Responses `status` / `incomplete_details.reason` | Messages `stop_reason` |
|---|---|---|---|
| `stop` | `stop` | `completed` | `end_turn` (`stop_sequence` + `stop_sequence` when a `stop` matched, S1) |
| `length` | `length` | `incomplete` / `max_output_tokens` | `max_tokens` |
| `tool_calls` | `tool_calls` | `completed` (function_call items present) | `tool_use` |
| `content_filter` | `content_filter` | `incomplete` / `content_filter` | `refusal` |
| `cancelled` | not rendered (the client is gone); the record says `cancelled` | — | — |

#### 3.1.4 Errors — the superset envelope

```json
{ "error": { "code": "insufficient_balance", "message": "…", "details": { "available_milli_2z": 500, "required_2z": 2 },
             "type": "insufficient_quota", "param": null } }
```

On `/v1/messages` the outer object also carries `"type": "error"` and
`error.type` uses Anthropic's set. The mapping is a pure function of our
code (and `details.field` → `param`):

| Our code (status) | OpenAI `type` | Anthropic `type` |
|---|---|---|
| `invalid_request`, `context_length_exceeded` (400) | `invalid_request_error` (`code: "context_length_exceeded"` kept) | `invalid_request_error` |
| `invalid_token`, `token_revoked`, `insufficient_user_authentication` (401) | `authentication_error` | `authentication_error` |
| `insufficient_balance` (402) | `insufficient_quota` | `permission_error` (Anthropic has no 402; the status stays 402) |
| `insufficient_scope`, `app_disabled`, `account_frozen`, `account_in_debt`, `cap_exceeded`, `model_disabled` (403) | `permission_error` | `permission_error` |
| `model_not_found`, `call_not_found` (404) | `not_found_error` | `not_found_error` |
| `idempotency_conflict`, `too_many_holds` (409) | `invalid_request_error` | `invalid_request_error` |
| `completion_not_retained` (410, compat only) | `invalid_request_error` | `invalid_request_error` |
| `payload_too_large` (413) | `invalid_request_error` | `request_too_large` |
| `rate_limited`, `concurrency_limit` (429) | `rate_limit_error` | `rate_limit_error` |
| `provider_error` (502), `internal` (500), `provider_timeout` (504) | `server_error` | `api_error` |
| `unavailable`, `catalog_unavailable` (503) | `server_error` | `overloaded_error` |

`ErrorCode` gains `completion_not_retained`; `errors.md` §3 gains the row
and the `spec_conformance` test the status.

#### 3.1.5 Idempotency on compat surfaces

Same key, same body, same encoding (§3.1.1): while the original runs →
`409 idempotency_conflict` (Stainless SDKs retry twice, then surface it with
`details.call_id`); terminal → `410 completion_not_retained` with the call
record in `details` (not retried; the receipt is in `details.receipt_id`,
and `GET /v1/calls/{id}` has the rest). A different body → `409`. Without a
key, a new call — and the compat quickstart tells developers to set
`idempotencyKey` per logical call exactly as the native SDKs do.

#### 3.1.6 Hosted tools (S-hosted) — web search first

Unified: `tools: [{"type": "web_search", "max_uses": 3}]` beside function
tools. Gate: signed `capabilities.hosted_tools` lists the types a model may
run; the price is `tool_call_nusd` per invocation (`usage.tool_calls`
counts them, #1066), which today prices **one** hosted tool type per model
— the signer refuses a model declaring two types at different prices until
the schema bump of §3.5.6 adds a per-type table. Translation: Responses
`web_search`, Anthropic `web_search_20250305` (`max_uses`), xAI
`search_parameters` / agentic `web_search`; **Chat Completions on OpenAI
refuses** (only search-preview models have it, and they are a different
catalogue row). Events: a `server_tool` event (`{type, status, input?}`,
content-free beyond the query the model wrote) and `annotation` events for
citations; the compat renderers emit the provider's own citation shapes.
Hold: `tool_budget = min(max_uses, catalogue limits.hosted_tool_calls_max)`
in the existing extend formula — **and** the search *content* the provider
injects into the context, which is billed as input tokens (OpenAI bills
non-preview search content at a fixed 8,000 input tokens per call on
`gpt-4.1-mini`-class models; Anthropic bills the fetched results as
ordinary input): `input_est += tool_budget × limits.hosted_search_content_tokens`,
a signed per-model number. A model declaring `hosted_web_search` without
that limit is not callable with the tool. Code execution, file search, MCP
and computer use stay refused (§2.2).

### 3.2 Layer B — Free2Z-native extensions that official SDKs tolerate

Two equivalent carriers; **both present and different → `400`
(`reason: "extension_conflict"`)**:

- a top-level **`f2z` object** in any compat request body (the OpenAI and
  Anthropic SDKs serialise extra body members; Python `extra_body`, TS
  pass-through), and
- **`X-F2Z-*` request headers** for clients that cannot add body members
  (Vercel AI SDK forwards only known fields; `defaultHeaders` works
  everywhere).

| Extension | Body `f2z.…` | Header | Native field | Semantics |
|---|---|---|---|---|
| Strict budget | `max_output_tokens_strict: true` | `X-F2Z-Max-Output-Tokens-Strict: true` | exists | refuse instead of clamp (chat-api.md §2.1) |
| Per-call cap (new) | `max_charge_2z: 5` | `X-F2Z-Max-Charge-2z: 5` | `max_charge_2z` (S11) | a **ceiling on collection, not only on the hold**: `out_cap` is clamped to what the ceiling affords (with strict, refused: `403 cap_exceeded`, `reason: "max_charge_2z"`), the ceiling is persisted on the hold (`hold(… max_collect_milli_2z)`, S11's tuzi half), `extend` may not raise the reservation past it, and `settle` collects at most the ceiling — a charge above it is `shortfall_milli_2z`, written off like metering.md §5.5, never taken from the user. Without the ledger half the field is refused, not accepted as a hint |
| Fallback | `fallback: ["m2"]` | `X-F2Z-Fallback: m2,m3` | spec'd; refused by the metered path today (§2.23) | ordered; renderers hide the switch except in `f2z.model`. **Requires S12**; until it lands the compat carriers refuse it exactly as the native field is refused |
| Estimate (dry run) | `estimate: true` | `X-F2Z-Estimate: true` | `/v1/chat/estimate` | answers `200` with the native `EstimateResponse` (not a completion) — the compat endpoint *is* the estimate endpoint with this flag; errors exactly as the call would |
| Metadata | OpenAI/Responses native `metadata`; Messages `f2z.metadata` | — | exists | 16 keys |
| Receipts | — | — | `GET /v1/calls/{id}` | the response-side `f2z` object (below) carries the settlement |

**Response-side `f2z` object** (on the terminal chunk/event and on every
non-streamed compat response; the same fields as `done` / `ChatResponse`):

```json
"f2z": { "call_id": "…", "model": "gpt-4o", "requested_model": "gpt-4o", "provider": "openai",
         "hold_2z": 2, "max_output_tokens": 800, "settlement": "settled", "charged_2z": 1,
         "receipt_id": "rcpt_…", "released_2z": 1, "collected_milli_2z": 1000, "shortfall_milli_2z": 0,
         "cap_remaining_milli_2z": 199000, "balance_hint_milli_2z": 41500, "usage_source": "provider",
         "catalog_version": 7, "features": { "api": "chat_completions", "…": "…" } }
```

Headers on every compat response: `X-F2Z-Call-Id` (= `x-request-id` =
`request-id`), `X-F2Z-Hold-2z`, `X-F2Z-Catalog-Version`, `X-F2Z-Replayed`,
`X-F2Z-RateLimit-*` plus the provider-shaped aliases (§2.18). Settlement
never goes in a header: for a stream it is not known when headers are sent,
and one rule for both modes is better than two.

**`features` (§1.1) grows per slice** — `api` (`native | chat_completions |
responses | messages`), `sampling` (which were set), `reasoning_effort`,
`reasoning_budget`, `images`, `documents`, `cache_breakpoints`,
`hosted_tools`, `reasoning_history_dropped`. The tuzi validator requires
exactly today's eight members; S11's tuzi half versions the object (`v`)
and makes new members additive so that a feature slice does not need a
ledger migration each time.

### 3.3 Layer C — the signed capability matrix in `/v1/models`

The signed catalogue is the **single source of model truth** (§1.2). This
section defines the members the gateway reads and projects and what each
one gates; emitting them is the in-flight signer/discovery work's, and the
gateway reads a member it does not find as *unsupported* (never inferred
from a model name, never a gateway constant).

```json
{
  "object": "list", "has_more": false, "first_id": "gpt-4o", "last_id": "gpt-4o",
  "catalog_version": 7, "includes_markup_bps": 0,
  "data": [ { "…": "the same objects as models[]" } ],
  "models": [ {
    "id": "gpt-4o", "object": "model", "type": "model", "owned_by": "openai", "provider": "openai",
    "created": 1759622400, "created_at": "2026-10-05T00:00:00Z", "display_name": "GPT-4o",
    "context_window": 128000, "max_output_tokens": 16384, "min_charge_2z": 1, "ttfb_timeout_ms": 30000,
    "capabilities": {
      "vision": true, "tools": true, "strict_tools": true, "parallel_tools": true, "structured_output": true,
      "json_object": true, "reasoning": false, "reasoning_effort": false, "reasoning_budget": false,
      "reasoning_summary": false, "pdf_input": true, "audio_input": false, "prompt_cache_control": false,
      "prompt_cache_key": true, "seed": true, "logprobs": true, "top_k": false, "penalties": true,
      "developer_role": false, "hosted_web_search": false
    },
    "controls": {
      "tool_choice": ["auto", "none", "required", "named"], "effort_levels": [], "effort_budgets": {},
      "image_media_types": ["image/png", "image/jpeg", "image/webp", "image/gif"], "image_detail": ["auto", "low", "high"],
      "system_role": "system", "structured_output_mode": "native", "hosted_tools": [],
      "image_tokenizer": { "kind": "openai_tiles", "base_tokens": 85, "tile_tokens": 170, "low_detail_tokens": 85 }
    },
    "limits": {
      "tools_max": 128, "tool_schema_bytes_max": 32768, "response_schema_bytes_max": 32768,
      "images_max": 20, "image_tokens_max": 1445, "documents_max": 5, "pdf_pages_max": 100,
      "document_bytes_max": 33554432, "pdf_page_image_tokens": 1445,
      "stop_sequences_max": 4, "cache_breakpoints_max": 0, "hosted_tool_calls_max": 0, "hosted_search_content_tokens": 0, "temperature_max": 2
    },
    "encodings": ["native", "chat_completions", "responses", "messages"],
    "prices": { "input_milli_2z_per_mtok": 300000, "…": "…" }
  } ]
}
```

- **`capabilities`** stays a flat object of booleans (the signer's v1 rule:
  every member a bool; absent = `false`; `structured_output` keeps its
  tri-state reading until the signer emits it everywhere). Adding a boolean
  is additive on both sides.
- **`controls`** (enumerations) and **`limits`** (integers) are new signed
  per-model members. `CatalogModel` tolerates unknown members today, so an
  older gateway ignores them and a newer one reads them; `prices` keeps its
  `deny_unknown_fields` strictness because a price is money.
- **`encodings`** is computed by the gateway from `api_style` +
  capabilities, not signed: every chat model gets all four.
- **The matrix is executable.** `tests/capability_matrix.rs` enumerates
  (capability × `api_style`) and fails when a capability the gateway can
  gate on has no fixture proving either the translation or the typed
  refusal for that style — the test that closes the "silently ignored" class
  for good. A separate test asserts that `GET /v1/models` never publishes a
  capability the fixture corpus does not cover.
- **Verifiability.** The projection is derived from the signed document;
  `catalog_version` ties it to the raw signed envelope at
  `https://free2z.cash/api/ai/catalog/v1`, which an auditor can verify with
  the published key. A `GET /v1/catalog` passthrough of that envelope is a
  one-line addition if developers ask.

### 3.4 Cross-provider conformance fixtures

Extends #1142's `tests/fixtures/tool_calling/*.json` into one corpus,
`rs/crates/f2z-ai/tests/fixtures/conformance/<feature>/<name>.json`:

```json
{
  "name": "reasoning_effort_low_streamed", "feature": "reasoning", "source": "docs.anthropic.com … (synthetic, documented shape)",
  "api_style": "anthropic_messages", "provider": "anthropic",
  "catalog_model": { "capabilities": { "reasoning": true, "reasoning_effort": true }, "controls": { "effort_budgets": { "low": 1024 } } },
  "request": { "…unified ChatRequest…" },
  "expect": {
    "refusal": null,
    "provider_request": { "…exact members the provider must receive…" },
    "provider_stream": "event: message_start\ndata: {…}\n\n…",
    "events": [ { "type": "meta" }, { "type": "reasoning_delta", "text": "…" }, "…" ],
    "finish_reason": "stop", "usage": { "…" }, "hold_extends": 0,
    "encodings": {
      "chat_completions": { "chunks": [ "…" ], "response": { "…" } },
      "responses": { "events": [ "…" ] },
      "messages": { "events": [ "…" ], "response": { "…" } }
    }
  }
}
```

Rules:

1. **No live provider in CI, ever.** `source` names the documentation the
   shape came from; a `recorded: true` fixture may be added by someone with
   a key, scrubbed of ids and content.
2. **One runner, every axis.** `conformance.rs` runs each fixture through
   the real adapter against the loopback `f2z-ai-testkit` mock, stream on
   and off, and through each encoding's decoder + renderer; a fixture may
   declare `expect.refusal` instead of a stream (the typed `400` before any
   hold, asserted in `metered.rs` too).
3. **Negative controls are part of the corpus**: a mutation list per
   feature (drop the field, change the value) that the comparator must
   catch, run in CI, so a renderer that silently drops `tool_choice` is a
   red test rather than a review finding.
4. **Official SDKs are a conformance target.** A node job
   (`ts/free2z/sdk-compat-conformance/`) pins `openai`,
   `@anthropic-ai/sdk`, `ai` + `@ai-sdk/openai` + `@ai-sdk/anthropic`,
   `@langchain/openai` + `@langchain/anthropic`, points them at the mock
   gateway serving the corpus, and asserts text, tool calls, structured
   output, usage, the `f2z` object, error classes, `_request_id`, and the
   retry/idempotency behaviour each SDK actually has (what Stainless sends
   on retry is *observed* here, not assumed).
5. **The matrix test (§3.3)** reads the corpus and the capability list and
   fails on a hole.

### 3.5 Billing implications — hold, stream, settle, in milli-2Z

Nothing changes in the formula of metering.md §2–§4; each feature adds a
term to the worst case or a gate. Amounts: holds in whole 2Z, splits and
balances in milli-2Z, provider cost in nano-USD.

#### 3.5.1 Streaming through a compat encoding

Identical: hold at the dearest input rate for `out_cap`, extend every 60 s
and on each `tool_call`, settle from provider usage. The renderer buffers
nothing beyond the native 256 KiB delivery buffer; `delivery_aborted` maps
to the encoding's error shape with `settlement: pending` in `f2z`. Headers
go out at the hold (§3.1.2), so the hold is taken at step 6 and extended on
schedule exactly as for a native stream.

#### 3.5.2 Tool-call deltas, hosted tools

Fragments are not billed (the charge is provider usage); `observed_tool_calls`
still re-bases the extend target at each complete `tool_call`. Hosted
invocations are billed at `tool_call_nusd` each: `hold += min(max_uses,
limits.hosted_tool_calls_max) × tool_call_nusd`; settlement uses the
provider's count (`usage.tool_calls`, source `provider`). A provider that
does not report a count is `UsageReport::Missing` for that dimension —
released and written off, never guessed, as for tokens.

#### 3.5.3 Multimodal and cached tokens

- **Images** on token-billed providers: the gateway reads the width and
  height from the image header (PNG, JPEG, WebP, GIF — a few bytes; an
  image whose dimensions it cannot read is refused, `reason:
  "image_unreadable"`, never estimated) and applies the provider's
  **documented sizing formula**, selected by the signed
  `controls.image_tokenizer`, an object whose **parameters are signed**,
  not a bare name — the same algorithm has very different constants per
  model (`gpt-4o`: 85 base + 170 per tile; `gpt-4o-mini`: 2,833 base +
  5,667 per tile; a name alone would under-reserve 33× on the mini):
  `{"kind": "openai_tiles", "base_tokens": 85, "tile_tokens": 170,
  "low_detail_tokens": 85}` (fit within 2048², shortest side to 768,
  `base + tile × ⌈w/512⌉ × ⌈h/512⌉`; the worst case over all aspect ratios
  is a 2048×768 image, 8 tiles — **1,445** tokens on `gpt-4o`),
  `{"kind": "anthropic_area", "pixels_per_token": 750}` (after the 1568 px
  long-side resize, ≤ ~1,600), `{"kind": "patches", …}` for patch-based
  models (GPT-4.1-mini/nano, o-series), `{"kind": "xai_tiles", …}` (per
  docs.x.ai). An unknown `kind` or a missing parameter makes the model
  refuse image parts. `limits.image_tokens_max`
  is the signed ceiling the formula's result may not exceed (a formula
  drift is a refusal, not an under-reservation). Per-image-priced providers
  keep `image_nusd × images`. The formula parameters and ceilings are
  signed; the gateway holds the arithmetic and its fixtures.
- **PDFs**: a page count is **not** a bound — Anthropic's 1,500–3,000
  tokens per page is typical text usage, and each page is additionally
  sent as an image. The bound the hold uses is one that holds by
  construction: every BPE token encodes at least one byte, so the UTF-8
  size of the document's text is an upper bound on its text tokens. The
  gateway parses the PDF with a bounded reader (refuses above
  `limits.document_bytes_max` compressed and 8× that inflated, above
  `limits.pdf_pages_max` pages, or anything it cannot parse —
  `reason: "document_unreadable"`), inflates its content streams, and
  reserves `text_bytes + pages × page_image_tokens` where
  `page_image_tokens` is the image formula above at the provider's page
  render size (signed as `limits.pdf_page_image_tokens`). Where the provider
  offers a free count (Anthropic `count_tokens`), the gateway may use it in
  place of the byte bound when it answers within 5 s — **as an estimate,
  not an exact bound**: Anthropic documents it as one, so the model's
  `safety_factor_bps` is applied to it exactly as to the gateway's own
  tokeniser-less estimates (metering.md §4), and the context-window
  admission check uses the factored value. It falls back to the byte
  bound, never to a guess. The over-reservation of a byte bound
  (≈ 3–4× for English prose) is released at settlement; it is the price of
  a hold that is actually a hold.
- **Cached reads** settle at `cached_input_nusd_per_mtok` (already); the
  hold stays at the dearest input rate (metering.md §4), so caching only
  ever lowers the charge below the hold.
- **Cache writes**: 5 m writes at today's `cache_write_nusd_per_mtok`; a
  `1h` breakpoint is refused until the price table carries both rates
  (#1059; §3.5.6), because holding at an unpriced rate is exactly the
  under-charge the catalogue's strictness exists to prevent.
- **Audio input** is unpriceable until a per-audio-token rate exists; refused.

#### 3.5.4 Reasoning

`budget_tokens < out_cap` after clamping, else refused with the clamping
bound's code and `reason: "reasoning_budget"`. `effort` changes no bound.
Anthropic's `thinking` requires `max_tokens > budget_tokens`; the adapter
sends `out_cap` as `max_tokens`, so the invariant holds by construction.
Reasoning history (`provider_state`) is input the provider reads: it enters
the input reservation by its serialized size like a tool definition.

#### 3.5.5 Sampling, `n`, logprobs

No cost change. `n > 1` is refused in v1; when it ships the hold is
`price(input_est, n × out_cap)` and the record carries `n` settled
completions under one receipt.

#### 3.5.6 What needs a catalogue schema bump (price dimensions)

`prices` denies unknown members by design. These dimensions do not exist and
are therefore **refused**, not estimated, until a schema-3 price table lands
— coordinated with the in-flight rate card v3, not filed as a slice here:
`cache_write_1h_nusd_per_mtok` (#1059), `audio_input_nusd_per_mtok`,
`audio_output_nusd_per_mtok`, per-hosted-tool-type prices (`hosted_tools:
{web_search: {nusd_per_call}, code_interpreter: {nusd_per_session}}`),
output images by size/quality, TTS per character, STT per second, batch
tiers. Each is one ledger `rate_card` column, one proto member under a new
schema number, one signer member, one hold term.

#### 3.5.7 The minimum charge

`min_charge_2z ≥ 1` is a contract (catalogue refuses zero) and makes every
call cost at least $0.01. Embeddings, moderation and short tool-only turns
sit below that. A milli-2Z minimum (`min_charge_milli_2z`) is a ledger
rounding change (metering.md §2.2 rounds *once*, to whole 2Z) and a
product decision; this document flags it and builds nothing on it.

### 3.6 Non-goals, recorded

Passthrough of provider-native bodies (ADR 0003 stands), server-side tool
execution, URL fetching, conversation storage, batch, provider-cost
transparency, token-rate limits, an API-key credential type.

## 4. Build order — slices

Each slice is one zuu issue with acceptance criteria and the fixtures it
must add; the issue numbers are in the §4.3 table. **Nothing here starts
until #1142 and #1143 merge** (#1140 has): every slice that touches
`ChatRequest` or an adapter `body()` would conflict with them.

### 4.1 Slices

| Slice | Scope (files) | Depends on |
|---|---|---|
| **S10a** Conformance corpus + runner | `rs/crates/f2z-ai/tests/fixtures/conformance/`, `tests/conformance.rs`, testkit `RecordedRequest`; migrates #1142/#1140 fixtures into the corpus; negative-control list | #1142, #1140 merged |
| **S1** Sampling (`temperature`, `top_p`, `top_k`, `stop`, `seed`, `logprobs`, penalties; `n` refused) | proto `chat.rs` (`Sampling`), three adapters, `meter::plan` gates, catalogue bools (proto reader; signer emits), SDKs (builders + types), `chat-api.md` | #1143 |
| **S2** `developer` role, several system messages, Responses `instructions` semantics | proto `Role`, adapters' system assembly, spec | S1 (same functions) |
| **S6** `/v1/chat/completions` encoding + superset errors + headers + `f2z` object + `X-F2Z-*` headers + `/v1/models` list superset + CORS + ADR 0005 + `COMPAT.md` + `@free2z/sdk` `compatFetch` | new `rs/crates/f2z-ai/src/compat/{mod,openai_chat}.rs`, `server.rs` routes, proto `ErrorCode::CompletionNotRetained`, `errors.md`, TS SDK `compat.ts` | S1, S10a (fixtures land in the corpus) |
| **S3** Reasoning controls + reasoning parts/deltas + provider-state round-trip | proto (`reasoning`, `OutputPart::Reasoning`, `reasoning_delta`), adapters, catalogue (`reasoning_effort/_budget/_summary`, `controls.effort_budgets`), SDKs, spec | S2 |
| **S7** `/v1/messages` + `count_tokens` + Anthropic envelope + `x-api-key` | new `compat/anthropic_messages.rs`; shares S6's compat infrastructure | S6, S3 (thinking blocks) |
| **S8** `/v1/responses` (stateless subset; `text.format`; `reasoning`; refusals for state/hosted) + Responses adapter tool controls (the refusal #1142 leaves) | new `compat/openai_responses.rs`; `provider/openai_responses.rs` tool_choice/parallel/strict | S6, S3 |
| **S4** Prompt caching (`cache_control`, `prompt_cache_key`), 1 h refusal, cache usage in every encoding | proto parts, Anthropic adapter, OpenAI adapters, catalogue bools, spec | S3 |
| **S5** Multimodal: **images admitted by the metered path** (dimension read + signed sizing formula in the hold), `image.detail`, `document` (PDF) part with the byte bound, data-URL decoding in compat | proto `ContentPart::Document`, `meter` estimate, adapters, catalogue `controls`/`limits`, spec | S4 |
| **S12** Fallback lifecycle: one hold per attempt, release-and-retake before `meta`, `meta.requested_model`, finalisation of the attempt that answered | `meter.rs` (`plan` admits `fallback`), `call.rs` attempts, `settle.rs`, `metered.rs` fixtures | S1 (same `plan` function); independent of the compat work |
| **S9** Capability matrix projection + executable matrix test + `controls`/`limits` reader | proto `catalog.rs` (`controls`, `limits`), gateway `/v1/models` projection, `tests/capability_matrix.rs`, TS/Rust SDK types | S1–S5 define the members; signer emission is the in-flight catalogue work |
| **S-hosted** Hosted web search | proto `Tool::WebSearch`, `server_tool`/`annotation` events, Responses/Anthropic/xAI adapters, hold term, spec, fixtures | S8, S9 |
| **S11** Extensions: `max_charge_2z` as a collection ceiling (ledger half in tuzi: `hold`/`extend`/`settle` honour `max_collect_milli_2z`), `X-F2Z-Estimate` on compat, `features` v2 (tuzi validator versioning as its tuzi half); the `fallback` carrier only once S12 has landed | proto, `meter`, compat decoders, `call.rs` features; tuzi ledger functions | S6; S12 for the fallback carrier |
| **S10b** Official-SDK conformance job | `ts/free2z/sdk-compat-conformance/`, `rs.yml` or a new workflow | S6, S7, S8 |
| **S16** SDK parity + docs: builders for sampling/reasoning/documents/caching in `f2z-sdk` and `@free2z/sdk`, guest-js/plugin wire, `COMPAT.md` quickstarts (openai-node, openai-python, anthropic, Vercel AI SDK, LangChain) | SDKs, docs | each feature slice (lands per slice or as a sweep) |
| **S13** `/v1/embeddings` | new `api_style`, new route, hold with zero output, OpenAI shape | S6 infra; owner note on min charge |

### 4.2 Waves — what runs in parallel without conflicts

- **Wave 0 (now, after #1142/#1143 merge):** S10a (new test files
  only) ∥ S1 (proto + adapters) ∥ S6's *scaffold* (new `compat/` module,
  routes, envelope, headers, CORS, ADR, `compatFetch`) — S6 maps sampling
  fields through S1's `Sampling` type, so it rebases on S1 before merge;
  the tuzi `features` versioning half of S11 (tuzi repo, no overlap).
- **Wave 1:** S2 → S3 serial (same adapter functions); S6 finishes against
  S1+S10a. S9's proto reader (`controls`/`limits`, new structs, tolerant)
  can run here: it adds members, touches no adapter.
- **Wave 2:** S7 ∥ S8 (each a new `compat/*.rs`; both need S3 for
  reasoning blocks); S4 after S3 (adapters).
- **Wave 3:** S5 (adapters + meter) → S12 (meter `plan` + call/settle;
  serial with S5 on `meter.rs`) ∥ S11 (meter + decoders; coordinate
  `meter.rs` with S5 — S11 touches the plan's budget, S5 the estimate) ∥
  S10b (new job) ∥ S16 sweep.
- **Wave 4:** S-hosted, S13, S9's matrix test (needs the corpus complete
  for S1–S5).

Rule of thumb: two slices may run concurrently when their write sets are
disjoint files; slices that both edit `provider/{openai_chat,openai_responses,
anthropic}.rs` or `meter.rs` are serialised in the order above.

### 4.3 Issues

| Slice | Issue |
|---|---|
| S10a | [#1147](https://github.com/free2z/zuu/issues/1147) |
| S1 | [#1148](https://github.com/free2z/zuu/issues/1148) |
| S2 | [#1149](https://github.com/free2z/zuu/issues/1149) |
| S6 | [#1150](https://github.com/free2z/zuu/issues/1150) |
| S3 | [#1151](https://github.com/free2z/zuu/issues/1151) |
| S7 | [#1152](https://github.com/free2z/zuu/issues/1152) |
| S8 | [#1153](https://github.com/free2z/zuu/issues/1153) |
| S4 | [#1154](https://github.com/free2z/zuu/issues/1154) |
| S5 | [#1155](https://github.com/free2z/zuu/issues/1155) |
| S12 | [#1156](https://github.com/free2z/zuu/issues/1156) |
| S9 | [#1157](https://github.com/free2z/zuu/issues/1157) |
| S-hosted | [#1158](https://github.com/free2z/zuu/issues/1158) |
| S11 | [#1159](https://github.com/free2z/zuu/issues/1159) |
| S10b | [#1160](https://github.com/free2z/zuu/issues/1160) |
| S16 | [#1161](https://github.com/free2z/zuu/issues/1161) |
| S13 | [#1162](https://github.com/free2z/zuu/issues/1162) |

Deferred, not filed (need a contract decision or the schema-3 price table
coordinated with rate card v3): 1 h cache writes (#1059), audio in/out,
image generation, TTS/STT, code execution, batch, moderation, a milli-2Z
minimum charge, `n > 1`, a call-list endpoint.
