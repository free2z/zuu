# `f2z-ai` — the free2z AI gateway

The service behind `https://ai.free2z.cash`
([`docs/free2z/ai-gateway`](../../../docs/free2z/ai-gateway/README.md), the contract in
[`docs/free2z/sdk/spec`](../../../docs/free2z/sdk/spec/chat-api.md), epic
[#1047](https://github.com/free2z/zuu/issues/1047)). **AGPL-3.0-only**, never
published to crates.io, native only.

The binary wires authenticated SDK routes to a verified signed catalogue,
PostgreSQL ledger functions, and the existing provider adapters. This is a
**metered preview**, tracked by [#1078](https://github.com/free2z/zuu/issues/1078),
not a deployment or live acceptance result. The [SDK integration guide](../../../docs/free2z/sdk/INTEGRATION.md)
remains the application entry point.

Supported: authenticated `/v1/models` (private, caller-markup-aware ETag),
`/v1/chat/estimate`, streamed and nonstreamed text and function-tool `/v1/chat`, and account/app-scoped
`/v1/calls/{id}`. A new durable claim and confirmed hold precede provider I/O.
Identical completed-key retries return the receipt as JSON with
`X-F2Z-Replayed: true`; pending/conflicting keys never start another provider call.
Disconnects stop delivery while the detached owner finishes settlement.
Only confirmed ledger amounts appear in terminal events; after ten seconds of
uncertainty the stream says `pending`, and the detached settler retries through
its bounded lifetime. Captured admission epochs allow completion after revocation.

Function tools and tool-result history require `capabilities.tools` in the
signed model catalogue. Missing capability metadata conservatively disables
tools; model names never imply support. The gateway relays calls but never runs
a client tool. Tool definitions, arguments and results enter the input hold.
`tool_choice` and `parallel_tool_calls` are passed through by the Chat
Completions adapter (OpenAI, xAI) and refused elsewhere; a tool's `strict: true`
needs `capabilities.strict_tools` (absent: provider `openai` only — xAI does
not document it). Streamed Chat Completions calls relay each argument fragment
as a `tool_call_delta` before the complete `tool_call`. Refusals carry
`reason: "tools_unsupported"` and happen before any hold
([docs/free2z/sdk/TOOLS.md](../../../docs/free2z/sdk/TOOLS.md)).

Structured output (`response_format`: `json_schema` or `json_object`) is passed
through by the Chat Completions adapter, to a model whose signed
`capabilities.structured_output` is `true` — or, while the catalogue does not
carry that member, whose provider is `openai`. The Anthropic Messages adapter
translates it into a forced single tool whose `input_schema` is the schema and
unwraps the tool's input back into the reply's text (`finish_reason: stop`),
for a model whose catalogue entry declares `structured_output: true`; it
refuses a `response_format` beside `tools`. Any Anthropic request that sends
tools also reserves `TOOL_USE_OVERHEAD_TOKENS` of input for Anthropic's
tool-use system prompt, which the request bytes do not show (hold only). Everything else is refused with
`400 invalid_request` (`reason: "response_format_unsupported"`) before any hold
or provider I/O; the gateway never drops the constraint. The schema enters the
input hold like a tool definition; the pricing formula is unchanged.

Reasoning effort (`reasoning_effort`: `minimal`/`low`/`medium`/`high`) is sent
by the Chat Completions adapter as `reasoning_effort` (OpenAI and xAI) and by
the Responses adapter as `reasoning.effort`, only to a model whose signed
`capabilities.reasoning_effort` is `true` and, where the catalogue lists
`controls.effort_levels`, only at a listed level. Anthropic Messages refuses
it (its `thinking` takes a budget, not an effort). Everything else is refused
with `400 invalid_request` (`reason: "reasoning_effort_unsupported"`) before
any hold or provider I/O. The hold is unchanged: reasoning is output, and the
hold reserves the whole output cap — which on OpenAI bounds reasoning and on
xAI does not (`max_completion_tokens` there counts visible tokens only).

OpenAI-shaped tool controls (`tool_choice`, `parallel_tool_calls`) are
translated by the Anthropic Messages adapter (`required` → `any`, a named
function → `tool`, `none` → `none`, `parallel_tool_calls: false` →
`disable_parallel_tool_use`) and refused up front by the others
(`reason: "tools_unsupported"`, `field` naming the control) until their
translation lands. Recorded Anthropic payloads and their expected results are
in `tests/fixtures/anthropic/` (`tests/anthropic_conformance.rs`).

Nonstreaming delivery aggregates the same event pipeline. Before provider I/O it
reserves 64 times its event-byte limit from the shared upload memory pool; the
reservation follows the serialized HTTP body until delivery drops it. The limit
is the smaller of `delivery_buffer_bytes` and 1 MiB (256 KiB by default).
Exhaustion before starting is `503`; overflow or interrupted delivery is `502`
with a pending charge and a call ID for receipt reconciliation. Provider reading
and settlement continue after delivery ends.

Limitations: model fallback and images are unsupported. Input reservation runs
the provider's own tokenizer (`o200k_base` / `cl100k_base`, vendored by
`tiktoken-rs`) over messages, tool definitions and the `response_format` schema
with measured framing for OpenAI models (`src/estimate.rs`; the recorded corpus
in `tests/estimate.rs` holds it never below, and within 15 % of, what the provider
billed), and a conservative UTF-8 byte bound for every other provider. Final
charges use provider-reported usage and signed prices. **Missing provider usage
on an accepted request settles on the metering.md §5.4 estimate** — the hold's
input estimate plus the produced output tokenized (× 1.1), never above the hold,
recorded as `usage_source: "estimated"`; a request the provider refused releases
the hold. Reasoning tokens a lost usage frame would have carried are not
estimated and are the platform's loss. Full contract work remains in #1078. These
local tests do not establish production deployment, authenticated paid-call,
load, or drain acceptance.

## Backend configuration

```toml
catalog_url = "https://free2z.cash/api/ai/catalog/v1"
catalog_keys_file = "/run/config/catalog-trusted-keys.json"
ledger_url_file = "/run/secrets/gateway-ledger-url"
ledger_max_connections = 4
# ledger_features_meta = false   # see "Request features" below
# Configure authentication and at least one provider as described below.
```

**Request features.** Every `POST /v1/chat` and `/v1/chat/estimate` `response`
log line carries a content-free description of what the request asked for:
`response_format` (`json_schema`/`json_object`, absent when none),
`response_format_strict`, `response_format_schema_bytes`, `tools` and
`fallback` (counts), `max_output_tokens_strict`, `stream`, and `call_id` once
one is known. Never a schema body, a prompt, a tool definition — nor the
schema's client-chosen *name*, which like `metadata` never reaches a log line
(`src/features.rs`). With `ledger_features_meta = true`
(`F2Z_AI_LEDGER_FEATURES_META=true`) the same object is stored on the ledger
call claim as `features` and returned on `GET /v1/calls/{id}` — with the schema
name `null`, for every app (zuu#1225). It is **off by default**: a ledger without tuzi migration
`ledger.0006_call_features` refuses the unknown key and would fail every paid
call, so the flag is flipped only after that migration is live.

The trust file is a JSON object mapping key IDs to 64-character lower-case
Ed25519 public-key hex strings. Trust never comes from the catalogue endpoint.
The envelope is `{"catalog": {...}, "signature": {"key_id": "...",
"signature_hex": "..."}}`; duplicate members, bad signatures, expired catalogues,
redirects, and bodies above 1 MiB are refused. Fetch timeout is five seconds.
A failed refresh retains only the previous verified, unexpired copy.

The ledger URL comes only from the secret file or `F2Z_AI_LEDGER_URL`.
Production connections require certificate and hostname verification; configure
trusted roots in the PostgreSQL URL as needed. Plaintext exists only through an
explicit literal-loopback integration-test constructor, never deployment config.
The per-process pool defaults to four connections and accepts 1–20; operators
must budget the **sum across replicas** within reserved database connections.
Acquisition is bounded to one second. Each function uses a short transaction
with local lock timeout 2 s, statement timeout 5 s, and overall client bound 7 s.
Prepared statement caching is disabled for transaction poolers. No transaction
crosses provider I/O. Startup validates all used signatures under a deadline.

The ABI comprises `ledger.gateway_context`, `call_claim`, `call_complete`,
`call_read`, `hold`, `extend`, `settle`, and `release`; this crate contains no
ledger schema/DDL or deployment credentials. Holds take milli-2Z; settlement
accepts provider nano-USD, never a caller-selected fixed charge. Holds expire
after 300 seconds and live streams extend every 60 seconds. Ambiguous commits
retry identical IDs and intent. Finalization records completion with captured
identity, recovering a lost hold response from its attempt snapshot; it never
reauthorizes or creates another hold. Confirmed terminal winners remain final,
including expired holds whose late provider expense is recorded without charging
the user. Durable expiry reconciliation must run independently of the gateway.

Without backend configuration the diagnostic skeleton remains closed and unready.
Setting any backend key requires complete configuration and a configured provider.
`Deps::skeleton` and trait injection remain test seams, not billable service modes.

## The privacy baseline (every app, zuu#1225)

One baseline for every call, whatever the app's audience. The token's
`child_directed` claim (`docs/free2z/sdk/CHILD-DIRECTED.md`) is an audience
classification only: it is still verified, and it selects nothing here.

- **No caller text in a call record.** `metadata` is refused on `/v1/chat`
  and `/v1/chat/estimate` (`400 invalid_request`, `field: "metadata"`,
  `reason: "privacy_baseline"`; `chat::validate_retained`) and recorded as
  `{}`, the shape the ledger requires. A model id the catalogue does not
  hold — fallbacks included — is refused (`404 model_not_found`) before the
  claim would record it. The `response_format` schema name is recorded as
  `null`.
- **Keyed fingerprints and retry keys.** The request fingerprint and the
  `Idempotency-Key` reach the ledger only as HMAC-SHA256 under a server
  secret (`meter::ClaimKey`, 64 hex characters — the shapes
  `ledger.call_claim` checks), so neither a short, guessable prompt nor the
  caller's key text can be confirmed from the record.
- **One provider standard.** A metered gateway holds keys only for
  `chat::PRIVACY_PROVIDERS` — the providers it sends an explicit
  `store: false` to (OpenAI, both adapters). A configuration naming any
  other provider is refused at load, so no caller, and no fallback, has a
  weaker route. Every app is shown the same `/v1/models`.

```toml
child_directed_key_file = "/run/secrets/child-directed-key"   # or F2Z_AI_CHILD_DIRECTED_KEY
# child_directed_key_previous_file = "/run/secrets/child-directed-key-previous"
#   # or F2Z_AI_CHILD_DIRECTED_KEY_PREVIOUS; only during a rotation
```

At least 32 bytes, never inline. The names are kept from when only
child-directed apps were keyed; renaming an `F2Z_AI_*` variable is its own
two-release change (an older image refuses an unknown one). **A metered
gateway does not start without the key** (`Config::metered`,
`config::Config::validate`): a rollout that lost it is a failed rollout —
the new pod exits, and with tuzi's `maxUnavailable: 0` the old pods keep
serving — never a gateway that serves and fails every call, and never one
that falls back to the raw form. The diagnostic skeleton claims nothing and
needs no key.

**Retries across a change of form (`src/idempotency.rs`, tuzi#2639).** Every
claim is now keyed under the current key, but two other forms are still in
the ledger for a while: the **plain** form (the unkeyed SHA-256 and the key
as sent) that the image before zuu#1225 stored for every app not flagged
child-directed, and a call claimed under a key since rotated away. A same-key
retry of either derives the current form. **Before** a keyed request claims,
the gateway atomically reserves a form record in the shared Redis — one Lua
script that checks the record key under every server key it holds and, only
if none is held, sets them all (`FormStore::reserve`):
`<ns>:ai:idem:<sub>:<app>:<hmac>` → `v1:keyed:<key id>:<call>`, naming the
call id it is about to claim (the previous image wrote `v1:plain:<call>`
**after** its plain-form claims, whenever the key was configured), for
24 h 10 m (`idempotency::RECORD_TTL`): the ledger key's
24 h (`ledger::IDEMPOTENCY_KEY_LIFETIME`, which restates `ledger.call_claim`'s
`now() + interval '24 hours'` in tuzi
`py/dj/apps/ledger/migrations/_call_recovery.py`) plus a 10-minute margin for
skew between Postgres's and Redis's clocks. A record must outlive its key row:
a straddling retry that finds the key row but no record is charged twice and
counted only as `miss` (tuzi#2670). Outliving it is harmless — a straddling
retry in the margin names the recorded call, which the ledger keeps 90 days,
and is replayed rather than charged; a same-form retry after 24 h is a new call
as the contract says.
The `<hmac>` is an HMAC of the `Idempotency-Key` under the current key,
derived identically by both images (pinned by
`claim_key_derivations_match_the_deployed_image`), so the key text never
reaches Redis. A keyed request reads the record (under the current key, then
the previous one). If one is held and names a form this request does not
derive, the claim names the **recorded call id** with the fingerprint in that
call's form, and `ledger.call_claim` resolves the existing call by id —
replayed, pending, or a conflict — inserting nothing.

**Cross-form admission is atomic.** Because the reservation precedes the
claim and is one step, two concurrent same-key requests that derive
different forms — pods either side of a rotation, or of this image's rollout
when this image's pod goes first — cannot both miss: one reserves, the other
names its call, and the ledger admits one call
(`concurrent_requests_in_two_forms_are_admitted_and_charged_once`; the
read-then-write negative control is charged twice). Same-form requests are
decided by the ledger's own key row. Since `child_directed` no longer selects
a form, the developer-flip window (tokens from either side of a flip racing
in different forms, tuzi#2683) no longer exists
(`concurrent_requests_across_a_child_directed_flip_are_admitted_once`). One
race remains, once: during this image's own rollout, a previous-image pod
looks up the record before its plain-form claim and writes its own only
after it; a same-key request on a new pod between that lookup and that write
finds nothing and is a second call. The previous image cannot be changed;
the window is that pod's lookup-claim-write span, only while both images
serve. Same-form requests whose reserving request never claimed (its
claim failed or has not landed) claim the **recorded** call id, never a
fresh one, and a request whose claim resolved to another call re-points
the record under every key name — so the record names agree and name the
call that exists
(`a_reservation_whose_claim_failed_becomes_one_call_in_either_form`,
`a_same_form_race_then_a_retry_in_the_other_form_is_one_call`). The key the claim carries is always the keyed
form: a retry never sends the key text, even when it replays a plain-form
call. The key id is 16 hex characters of an HMAC of a fixed label under the
key (`ClaimKey::id`).

**Deploy order (exactly-once across the transition).** The previous image
writes a `v1:plain` record only while it holds the key, so a plain-form call
it claimed before the key was live has no record, and a keyed retry of it on
this image is a new, paid call — silently, as a `miss`
(`without_a_form_record_a_plain_form_call_retried_keyed_is_charged_twice`).
So **deploy this image only once the key has been live on the previous image
for at least 24 h 10 m**: every plain-form key row still live then was
claimed with a record. A plain-form call that carried `metadata` cannot be
replayed by a retry here, which may not send `metadata`: it is refused
(`400`), or, without it, its fingerprint differs and the ledger answers `409
idempotency_conflict` — never a charge. Anything that loses a record
falls back to the canonical form, so a straddling retry can again be charged
twice. Counted in `f2z_ai_idempotency_forms_total{outcome}` — alert on any
increase of these three: Redis unavailable (`unavailable`), a record write
that failed (`write_failed`), a record naming a key no longer configured
(`unknown_record`). `orphaned` is no longer one of them: it counts a record
naming a call the ledger did not hold, which with reservations is the benign
half of a cross-form race or a reservation whose claim failed — one call
either way; a plain record naming a lost call is confirmed by a read and
claimed in the keyed form, never under its id, so no new row holds an
unkeyed fingerprint. (tuzi's `ai-idempotency-form-degraded` alert still
matches `orphaned`; drop it there.) Not distinguishable from a first request (`miss`), so accepted
as residual risk: a record evicted or lost to a Redis restart or flush, and a
crash between the claim and the record write.

**Rollback.** An image older than this one starts with the key env present
(every image since zuu#1216 reads it) and, sharing the Redis records, replays
the keyed calls this image claimed. It also resumes storing ordinary apps'
raw keys, unkeyed fingerprints, `metadata` and schema names: a privacy
regression to roll back to, not a billing one. The same holds after the
plain-form path is deleted (zuu#1225 step 3, at least 24 h 10 m after this
image is live): rolling back past **this** image is a raw-form regression for
every ordinary app, so roll back no further than this image.

The records carry a TTL, so a `volatile-*` eviction policy would drop them
first and an `allkeys-*` one could; the shared Redis must run with no
`maxmemory` limit or `noeviction`. Without a limit Redis grows until its
container's memory limit OOM-kills it, which loses every record at once (with
the limits' state), so size that limit for this keyspace. A record measured
313 bytes on the platform's Redis 8.10.1 image (`INFO memory`, 100 000
records with TTLs), so the bound is keyed calls per 24 h 10 m × 313 B:
1 M keyed calls a day leaves ≈ 1.007 M records live, ≈ 315 MB (301 MiB), 29 %
of the redis container's 1 GiB limit (`k8s/free2z/redis.yaml` in tuzi).
Records alone would fill that 1 GiB at ≈ 3.43 M live records, ≈ 3.4 M keyed
calls a day (≈ 39 a second, sustained) — less in practice, since the limits'
and revocation keys and Redis's own baseline share it. Raise the limit before
keyed traffic approaches that.

**Rotation.** Two deploys, so no pod in a rolling update lacks the other
pod's key: first add the new key B as `child_directed_key_previous` (current
A, previous B), then swap (current B, previous A) and keep that for at least
24 h 10 m (`RECORD_TTL`), then drop the previous key. While both are set, a keyed retry of a call claimed under the old key
replays it. A retry after the previous key is dropped is a new call. The
previous key must differ from the current one and needs it.
`F2Z_AI_CHILD_DIRECTED_KEY_PREVIOUS` is an `F2Z_AI_*` variable that an image
older than zuu#1222 refuses to start on: set it only once an image
with this support is the rollback target too.

## Authentication and limits (`src/auth`)

chat-api.md §2.2 steps 1–2, against the IdP of tuzi #2238
(`dj.apps.oidc`), in this order:

| Check | Refusal |
|---|---|
| `Authorization: Bearer`; `alg` exactly `ES256` (so `none`, `HS*` keyed with the public key and every other algorithm are refused before a key is looked up); `typ` `at+jwt`; no `crit`; signature by `kid` against the issuer's JWKS (P-256 keys only — the RS256 ID-token keys in the same set are dropped) | `401 invalid_token`, `reason` `missing` / `malformed` / `signature` |
| `iss` exact; `aud` an array containing `f2z-ai`; `exp` + 30 s; `iat` / `nbf` − 30 s | `401 invalid_token`, `issuer` / `audience` / `expired` |
| The JWKS has never loaded (issuer unreachable since start) | `503 unavailable`, `token_keys` — not a `401` that would sign users out for an outage |
| `aep` / `agen` against Redis (`<ns>:aep:<sub>`, `<ns>:agen:<client_id>:<sub>`, plain decimals, as `epoch_publish` writes them); on a miss or a Redis failure, the internal epoch endpoint (`GET …/internal/epoch/<sub>/`, shared-secret bearer): a `client_id` absent from its `agen` is revoked, `404` is revoked, `503` / timeout / anything else is unknown | `401 token_revoked`, `account_epoch` / `grant_generation`; unknown → `503 unavailable`, `revocation_check`. **Never allow on unknown** |
| `scope` contains `ai:invoke` | `403 insufficient_scope`, `details.scope` |
| 4 open calls per user: a local count, and a Redis sorted-set lease | `429 concurrency_limit`, `details.limit`, `Retry-After` |
| Per (app, user), plus an optional aggregate app limit: a local GCRA, and Redis token buckets (one Lua script, Redis's clock) | `429 rate_limited`, `Retry-After`, `X-F2Z-RateLimit-{Limit,Remaining,Reset}` |

**The lease lives on the call's admission slot**, which is dropped only
after the settler has returned for the call and its delivery has ended — so a
drained call, a disconnected one whose upstream is still being read, and one
whose task panicked all count until they are settled. While held, its Redis
member is renewed every `concurrency_lease_secs / 3` (and re-added if Redis
lost it, e.g. an eviction); the renewer task releases it
when the lease drops. It expires after `concurrency_lease_secs` only if a pod
dies holding it.

**If Redis is down** (every call is bounded by `redis_timeout_ms`, then it is
skipped for 1 s), new shared admission fails closed with retryable
`503 unavailable` (`details.reason: shared_admission`). An ambiguous successful
script reply is also refused and its lease is cleaned up. Revocation separately
goes to the authoritative epoch endpoint (at most 64 calls in flight per pod;
beyond that, `503`), never to allowing. This preserves shared limits at the cost
of refusing new calls during an admission-store outage. Already admitted calls
continue settling; lease renewal resumes when Redis returns.

The metered executable requires Redis. Library/test integrations may explicitly
omit it for local-only diagnostics; that mode promises no cross-pod limits.

There is **no default aggregate application request bucket**: adding users to
one OAuth client does not consume a fixed shared 6,000/min allowance. Operators
may enable `rate_app_per_minute` and `rate_app_burst` together as a measured
service admission policy. This is not a shared application spending cap. Each
user's prepaid balance and consent remain independently enforced by the ledger.
Per-user rate/concurrency limits, socket/upload/decode budgets and the pod's
admission capacity still apply. Size replicas, aggregate database pools, Redis
throughput and provider quotas together; an optional app bucket does not replace
those service bounds. Defaults alone establish no million-user capacity claim;
load evidence must cover the chosen fleet and actual provider limits.

The JWKS comes from `auth_jwks_uri` or the issuer's discovery document, is
warmed at start-up, refreshed in the background after an hour, and refetched
on an unknown `kid` at most once per `auth_jwks_refetch_secs` (60). One fetch
runs at a time (5 s at most); at most 64 callers wait for it, and none wait
while the last fetch failed. A `200` key set is authoritative — a withdrawn key
stops verifying at once — and a cached set is not used more than 24 h after its
fetch. An unknown `kid` while the issuer is unreachable is `503`, not `401`.

## The provider adapters (`src/provider`)

One [`Provider`](src/provider/mod.rs) trait, selected by the catalogue
model's `api_style`:

| `api_style` | Adapter | Usage rule it gets right |
|---|---|---|
| `openai_responses` | `provider::openai_responses` | three terminal events (`response.completed`, **`response.incomplete`**, `response.failed`) all carry usage; `input_tokens` includes cached, `output_tokens` includes reasoning |
| `anthropic_messages` | `provider::anthropic` | `message_delta` usage is **cumulative**: each count from the **last** delta that carries it, falling back to `message_start`; reported only once a delta carried `output_tokens`; the 5 m / 1 h cache-write split is carried in the outcome |
| `openai_chat` | `provider::openai_chat` | `stream_options.include_usage` always sent; xAI's `completion_tokens` **excludes** reasoning — `total_tokens` decides the reading when it can, the provider's configured convention when it cannot |

`ProviderBackend::start` does no I/O: the provider request goes out on the
call's first read, so `start` cannot outlive the call task's deadline and a
provider failure arrives inside the stream (chat-api.md §2.2 step 7). The
upstream yields `delta`, complete `tool_call`s and — only when the provider
reported it — `usage`; the settler gets a `ProviderOutcome` in
`CallRecord::outcome` with the finish reason, the failure and its phase, and
the usage **or `UsageReport::Missing`** (never a zero usage). No `meta`,
`done` or `error` event and no hold: those are the metering layer's.

| Rule | Where |
|---|---|
| Deadlines: connect 5 s, the model's `ttfb_timeout_ms` to the first body byte, the model's `idle_timeout_ms` (default 60 s) between chunks, 300 s from admission. All absolute and kept on the upstream, because the call task drops `next()` futures every 250 ms | `provider/upstream.rs` |
| Retry **only before the provider can have accepted the request** — a refused connection or a non-2xx status; never after a 2xx head, a head timeout or a transport error after the write (the provider bills those) — ≤ 2 retries per call with jittered backoff (`retry-after` honoured up to 2 s), a per-provider budget (10 % of primary attempts, burst 20) and a per-provider circuit breaker (5 consecutive failures, 429s not counted → open 10 s → one probe, which closes it at its 2xx head) | `provider/resilience.rs` |
| Status → code: 401/403/402 `internal`; 400/404/413/422 `provider_error`, not retried; 408/504 `provider_timeout` and 502 `provider_error`, not re-sent (an intermediary may have forwarded the request); 429/409/500/503/other 5xx/529 `provider_error`, retried; connect `unavailable`; open breaker `unavailable` (`provider_circuit_open`) | `provider/mod.rs` |
| Header allowlist (`authorization`, `x-api-key`, `anthropic-version`, `content-type`, `accept`), no redirects, no environment proxy, `https://` base URLs only (loopback `http://` for the mock), keys as `SecretString` exposed only into a sensitive header value | `provider/client.rs`, `config.rs` |

Provider accounts are configured as `[providers.<name>]` (see
`src/config.rs`); a key comes from `F2Z_AI_PROVIDER_<NAME>_API_KEY` or
`api_key_file`, never inline.

## Running it

```bash
cd rs
cargo run -p f2z-ai -- check                 # print the effective config, secrets redacted
cargo run -p f2z-ai -- serve                 # public 127.0.0.1:8080, admin 127.0.0.1:9090
curl -s localhost:9090/readyz                # not ready: no verified, unexpired catalogue
```

It is **not** in the image pipeline yet (`rs/Dockerfile`'s `BIN` list and
`.github/workflows/f2z-images.yml`); that is a separate item of #1047.

## Configuration

A TOML file (`--config FILE` or `F2Z_AI_CONFIG`), then `F2Z_AI_<KEY>`
environment overrides, which win. An unknown key or an unknown `F2Z_AI_*`
variable is a startup error.

| Key | Default | |
|---|---|---|
| `listen` | `127.0.0.1:8080` | Public: `/v1/*` only |
| `admin_listen` | `127.0.0.1:9090` | `/healthz`, `/readyz`, `/metrics`. In a pod, bind the pod IP (a kubelet probe does not come from loopback) and keep it out of the public Service |
| `max_concurrent_calls` | `10000` | Gateway-wide; beyond it `503 unavailable` + `Retry-After` |
| `retry_after_secs` | `1` | On overload and draining `503`s |
| `drain_timeout_secs` | `300` | How long open streams get after `SIGTERM` |
| `abort_grace_secs` | `5` | After the abort, before connections are dropped |
| `settle_grace_secs` | `10` | For the settler to finish at shutdown |
| `request_timeout_secs` | `310` | Admission → the call started (owned by the call task, which then settles it `NotStarted`); `500 internal`. The tower timeout is a backstop 5 s later |
| `body_read_timeout_secs` | `30` | `400 invalid_request`, `reason: timeout` |
| `header_read_timeout_secs` | `10` | The connection is closed |
| `max_body_bytes` | `4194304` | Without image parts; `413 payload_too_large` |
| `max_body_bytes_with_images` | `20971520` | With image parts; the hard cap on what is read |
| `max_upload_buffer_bytes` | `268435456` | Request and decode-memory budget, gateway-wide; a body initially reserves its `Content-Length` (the image cap if it has none), then reserves decoded-memory headroom before parsing. Without it the bound would be `max_concurrent_calls` × 20 MiB ≈ 195 GiB |
| `catalog_poll_secs` | `30` | |
| `catalog_version_regression_bound_secs` | `420` | A lower catalogue version installs if its `issued_at` is within this of the newest installed (tuzi's `VERSION_REGRESSION_BOUND_SECONDS`); beyond it, a replay, counted by `f2z_ai_catalog_replays_total` (zuu#1067) |
| `delivery_buffer_bytes` | `262144` | Undelivered event bytes per stream before `delivery_aborted` |
| `delivery_stall_secs` | `30` | Frames waiting and none delivered for this long → `delivery_aborted` |
| `stream_keepalive_secs` | `15` | Upstream silence after which a streamed call sends a `: ping` comment (chat-api.md §3), from the headers to the terminal event; 1..=30, because the TypeScript SDK drops a stream after 45 s without a byte (the Rust SDK after 90 s; zuu#1163) |
| `log_level` | `info` | This crate only; dependencies are capped at `warn` |
| `otlp_endpoint` | *(unset: off)* | `http://collector:4318`; spans go to `/v1/traces`. `https://` is refused: no TLS in this exporter build |
| `otlp_authorization_file` | *(unset)* | Or `F2Z_AI_OTLP_AUTHORIZATION`. Never inline in the file |
| `auth_issuer` | `https://free2z.cash` | `iss`, exact. `https://` (loopback `http://` for a test issuer) |
| `auth_audience` | `f2z-ai` | Must be in `aud` |
| `auth_jwks_uri` | *(from discovery)* | |
| `auth_jwks_refetch_secs` | `60` | Least time between refetches on an unknown `kid` |
| `auth_epoch_endpoint` | *(unset: auth off, every call `503`)* | `http://web…/api/oauth/internal/epoch/` — ends in `/` |
| `auth_epoch_token_file` | *(unset)* | Or `F2Z_AI_AUTH_EPOCH_TOKEN`: the IdP's `OIDC_INTERNAL_API_TOKEN`. Required with the endpoint |
| `auth_epoch_timeout_ms` | `1000` | |
| `redis_url_file` | *(unset: no Redis)* | Or `F2Z_AI_REDIS_URL`. A single (non-Cluster) Redis — the admit script is multi-key |
| `redis_namespace` | `free2z` | The IdP's `OIDC_EPOCH_REDIS_NAMESPACE` (its DBNAME) — **must match**, or every lookup misses and goes to the endpoint |
| `redis_timeout_ms` | `250` | Per Redis call |
| `rate_user_per_minute` / `rate_user_burst` | `60` / `20` | Per (app, user) |
| `rate_app_per_minute` / `rate_app_burst` | `0` / `0` | Optional aggregate app bucket; both zero disables, both positive enables |
| `concurrency_per_user` | `4` | |
| `concurrency_lease_secs` | `360` | At least `request_timeout_secs` |

**The drain bound** is `drain_timeout_secs + 2 × abort_grace_secs +
settle_grace_secs + 8` — **328 s** with the defaults. The phases, each
bounded: the drain window; `abort_grace` for aborted calls to unwind;
`abort_grace` + 1 s to close connections; `settle_grace` for the settler;
≤ 1 s each for the catalogue poller and the admin listener; ≤ 5 s to flush
OpenTelemetry.

**`terminationGracePeriodSeconds` ≥ drain bound + preStop + margin.** A
`preStop` hook runs *inside* the grace period, before `SIGTERM` is sent, so
it counts against the same budget: with a 15 s `preStop` sleep (for the load
balancer to deregister the pod) and a small margin, set **≥ 345 s**.
Otherwise the kubelet's `SIGKILL` can arrive before the drain has handed
every call to the settler.

A second `SIGTERM` or Ctrl-C during the drain exits immediately (exit 130),
for a terminal; calls still open then are left to the ledger's hold expiry
(metering.md §5.6).

## A call: the upstream read and the delivery, kept apart

chat-api.md §2.4 / ADR 0001: **client backpressure never reaches the
provider.** A started call runs on its own task, which reads the upstream to
its end at provider speed and pushes each event into the call's delivery
buffer; the HTTP body only pops from that buffer. The buffer filling, or
`delivery_stall_secs` with frames waiting and none taken, ends **delivery**:
what is buffered is replaced by one best-effort `error` event
(`code: "delivery_aborted"`, `settlement: "pending"`) and the body ends. A
client that disconnects ends delivery the same way. In every case the
upstream is still read to its usage frame, and the call is settled on it —
and counts against the concurrency limit until that settle has returned
**and** delivery has ended. The stall rule keeps running after the upstream
ends; an aborted response is the last on its connection (it closes once
the abort frame is flushed, so it is never reused), and one stall period
after an abort the connection is dropped outright, so a client that never
reads cannot hold a socket or a buffer past its slot. While the upstream is
silent the task queues a `: ping` comment every `stream_keepalive_secs` — but
only into an empty buffer, so a ping is never behind undelivered data and
cannot keep a client that is not reading data alive; non-streamed calls get
none. Request bodies are read
into one contiguous buffer, so a body sent in one-byte chunks costs its
payload and not a descriptor per chunk, and a body's share of the upload
budget is held until the backend's `start` has consumed the request — or,
for an upstream that keeps the request's bytes to send them
(`Upstream::keep_upload_reservation`; the provider adapters do, until the
provider's 2xx head), until it lets them go.

Before authentication `max_pre_auth_uploads_per_peer` (default 16, range
1–65,536; environment `F2Z_AI_MAX_PRE_AUTH_UPLOADS_PER_PEER`) bounds pending
`/v1/chat` checks per transport peer IP. The socket peer is authoritative; `Forwarded` and
`X-Forwarded-For` cannot change this key. A reverse proxy therefore shares its
peer allowance across its clients; trusted forwarded-address attribution would
require a separate explicit trust configuration. Size this allowance for the
peak new-request rate arriving through each ingress times the worst expected
JWKS/Redis/epoch-check latency, with headroom for other users. For example,
100 new calls/second through one peer at a one-second authentication latency
requires more than 100 pending checks; the default 16 is too small there.
The global connection and admitted-call limits still cap total work when this
peer allowance is raised. The 10,000-stream capacity
requires ramping admission as checks complete; it does not promise a simultaneous
10,000-request authentication burst from one IP or one ingress. After authentication, at most
two uploads per verified user may read/decode bodies concurrently, independently
of their running AI calls. These limits refuse with `503 unavailable` and a
one-second `Retry-After`; entries disappear when their last request exits.

The first nonempty body byte must arrive within two seconds, including chunked
uploads; empty data frames do not reset this deadline. The overall configured
body timeout still applies. Before serde builds owned data, an allocation-free
scan caps nesting at 32 and conservative structural tokens at 16,384, ignoring
quoted/escaped delimiters. Excess complexity returns `400 invalid_request`
with reason `json_complexity`. Decode reserves an additional three times the
wire bytes plus 512 bytes per structural token for strings, temporary copies,
and collection overhead; this reservation follows the request through backend
retention. Small custom upload budgets may therefore admit raw bytes but refuse
their decoded representation with `503`; allow space for both when sizing it.


Settlement ownership starts **before** the backend's `start` runs: a call
whose `start` fails, times out or is cancelled by a drain still reaches the
settler, as `NotStarted`. **The settler is the single owner of releasing a
hold**: a backend never releases a hold it took in `start` (that would be a
double release); it leaves it for the settler.

The deadline for `start` is the request's own (`request_timeout`, counted
from admission), enforced only by the call's task — the tower timeout is a
backstop 5 s later. So the path that tells the client "the call did not
start" (`500`) is the same path that settles it as `NotStarted`; a client is
never told `500` for a call that then started and was charged.

A call whose task **panics** is settled as `Panicked` (and counted in
`f2z_ai_calls_settled_total{upstream="panicked"}`, with an error log) — a
bug, kept distinct from an operational `Drained`.

## The drain, precisely

On `SIGTERM`:

1. `/readyz` turns `503`; every new request gets `503 unavailable`,
   `details.reason: "draining"`, `Retry-After`, `Connection: close`. The
   listener keeps accepting, so a client the load balancer has not yet
   re-routed gets a retryable answer instead of a refused connection.
2. Up to `drain_timeout_secs`, calls in flight keep reading their upstream to
   its usage frame, keep delivering, and are settled.
3. Anything still open is aborted: its upstream read stops, its body fails
   at the next poll — the client sees a truncated response, never one that
   looks complete — and it reaches the settler as `Drained`.
4. The listener closes; connections get `abort_grace_secs` to finish, then are
   dropped.
5. The settler gets `settle_grace_secs` to finish its queue; exit `0`.

Every call that reached the backend is handed to the settler exactly once,
with how its upstream ended (`NotStarted`, `Finished`, `Drained`,
`Panicked`), where
delivery stood (`None`, `Open`, `Delivered`, `ClientGone`, `BufferFull`,
`Stalled`, `Cut`) and the usage the
upstream reported — from a detached task, never on the request's future
(ADR 0001).

## Tests

`cargo test -p f2z-ai`. The integration tests run the gateway on ephemeral
loopback ports and drive it with hyper's client over real sockets:

| File | Proves |
|---|---|
| `tests/drain.rs` | a hanging catalogue fetch cannot hold shutdown; an open call keeps reading and delivering through the drain and is settled with its usage; new work is refused; readiness flips; a call past the window is cut, its provider request dropped, and settled `Drained`; a client hang-up ends delivery only and the upstream is read to its usage |
| `tests/delivery.rs` | a client that does not read never throttles the upstream; a full buffer and a stall each end delivery with `delivery_aborted` / `settlement: "pending"` while the call is read to its usage and settled; a stall after the upstream ended is still caught, and the connection dropped; a disconnected call counts against the limit until its settle returns |
| `tests/sigterm.rs` | the same, with a real `SIGTERM` sent to the test process |
| `tests/concurrency.rs` | the limit is `503` + `Retry-After` and counts calls until settled, not heads; probes are never refused; the request timeout, and a call whose start timed out still reaching the settler as `NotStarted` |
| `tests/limits.rs` | 4 MiB / 20 MiB at their defaults, a declared oversize refused before the body, chunked bodies cut at the limit, the gateway-wide upload budget, the body-read timeout, strict decoding, readiness on the catalogue |
| `tests/redaction.rs` | a canary in every client-controlled field never reaches a log line at `trace` or an error body |
| `tests/otel.rs` | spans reach an OTLP collector with the configured `authorization`, and carry no prompt |
| `tests/adapter_usage.rs` | every adapter × every `Ending` × usage present / omitted × reasoning, caching, Anthropic cumulative server-tool usage, an empty answer: the parsed usage **equals** the testkit's `Scenario::expected_usage`, a missing report is `Missing`, and the client's `usage` event agrees |
| `tests/adapter_faults.rs` | every `Fault`: transient statuses retried before content and reported after; `retry-after`; refusals not retried; disconnects and error events retried before content, never after; first-byte, idle and hard-limit deadlines; a refused connection; the breaker opening and probing; the retry budget across calls |
| `tests/adapter_requests.rs` | each adapter's translation of the unified request; only allowlisted headers on the wire (a raw socket reads the request head); `start`'s refusals before any I/O |
| `tests/auth.rs` | against a fake issuer (discovery, JWKS, internal epoch endpoint over HTTP) and an in-memory store with fault injection: a valid token reaches the backend; missing / malformed; `none`, `HS256` keyed with the public point and with the JWK, a forged `ES256`, `RS256`/`ES384` headers genuinely signed by the issuer's key; wrong `aud`, `iss`, expired, future `iat`, the 30 s leeway; no `ai:invoke`; unknown-`kid` refetch rate limit and a rotation; stale `aep`/`agen` in Redis; a Redis miss → the endpoint's every answer (live, absent grant, stale, `404`, `503`, `500`, hang); Redis down + endpoint `503` → `503`, never allow; a wrong internal secret; the rate limit and its headers; the shared bucket across two gateways; the lease counting a disconnected call until settled; a panicking call releasing its lease. With `F2Z_AI_TEST_REDIS_URL` set, the Lua script and the whole gate against a real Redis (skipped, and says so, without) |
| `tests/adapter_gateway.rs` | the adapters behind `/v1/chat`: the settler receives the provider's usage (or `Missing`) and the outcome; a pre-content failure is a stream, not an HTTP error; the idle deadline fires under the call task's 250 ms ticks |

### Connection resource limits

`max_connections` (default 10240) bounds public sockets before HTTP headers are
parsed, including idle keep-alive connections. Excess sockets are closed
immediately rather than allocating waiting tasks. `max_admin_connections`
(default 32) is an independent reservation that public traffic cannot consume.
Set both below the process file-descriptor limit, with additional headroom for
outbound provider/Redis connections and files; these budgets do not raise the
operating system limit or protect against descriptor use by other components.

Every socket write, final flush and shutdown has an inactivity deadline of
`delivery_stall_secs` (default 30). A client that stops reading cannot retain a
connection task indefinitely after the response body ends. Progress resets the
deadline; response-stream delivery and settlement keep their existing limits.

The public connection default (10,240) leaves 240 sockets beyond the default
10,000 concurrent calls for admission responses and idle connections. Effective
call capacity cannot exceed the lower of `max_connections` and
`max_concurrent_calls`; reduce either consciously when overriding defaults.
Provision descriptor limits above both listener budgets plus upstream sockets,
Redis, logs, and other files. Before HTTP parsing, refusals are counted by
`f2z_ai_connections_rejected_total{listener="public"|"admin"}` and active sockets
by `f2z_ai_connections_active` with the same two labels; no per-refusal logs.

### Restricting models during pricing verification

Set `allowed_models = ["gpt-4o"]` in gateway TOML (or
`F2Z_AI_ALLOWED_MODELS='["gpt-4o"]'`) to expose only model IDs whose provider
usage and prices have been verified for this deployment. Omit the setting to
retain the full configured-provider catalogue; `[]` allows no new calls.
This is a model availability policy, independent of users' balance and optional
app budgets. It does not alter another service's model selection.

The policy filters `/v1/models` and refuses excluded estimates and new calls
with `model_disabled`. A refused new call has a terminal, zero-charge record;
retrying its same key recovers that result. Existing calls and receipts remain
recoverable even after their model is removed from the allowlist. Apply the same
policy to every serving replica before advertising a restricted rollout.

An initial text deployment can start with verified GPT-4o pricing. Additional
models need correct cache-write and context-tier billing before being enabled;
a provider's model-list response alone does not prove billing compatibility.
Applications should use `/v1/models` rather than assuming every signed-catalogue
entry is available on their gateway.
