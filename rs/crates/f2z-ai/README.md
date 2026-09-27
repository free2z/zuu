# `f2z-ai` — the free2z AI gateway (skeleton)

The service behind `https://ai.free2z.cash`
([`docs/ai-gateway`](../../../docs/ai-gateway/README.md), the contract in
[`docs/sdk/spec`](../../../docs/sdk/spec/chat-api.md), epic
[#1047](https://github.com/free2z/zuu/issues/1047)). **AGPL-3.0-only**, never
published to crates.io, native only.

This is the Wave 1 skeleton ([#1054](https://github.com/free2z/zuu/issues/1054)):
it calls no provider, verifies no token and moves no 2Z. It settles, and
tests, the parts of the gateway an operator or a client can observe before
those exist.

| Behaviour | Where |
|---|---|
| `POST /v1/chat` — body limits, strict decode with `f2z-ai-proto`, the spec's structural rules, then `501 not_implemented` | `src/chat.rs` |
| `/healthz` (liveness, constant) and `/readyz` (200 only with a verified, unexpired catalogue and not draining) on a separate admin listener | `src/server.rs`, `src/catalog.rs` |
| `/metrics`: request counts, `f2z_ai_active_streams`, the overhead histogram, rejections, settlements, readiness | `src/metrics.rs` |
| Structured JSON logs that never carry a prompt or completion; OpenTelemetry over OTLP/HTTP, off unless configured | `src/telemetry.rs` |
| Concurrent call limit → `503` + `Retry-After`, a call counted from admission **until its settle returns and its delivery has ended** (a disconnected call still counts) | `src/admission.rs`, `src/settle.rs`, `src/call.rs` |
| A gateway-wide budget for request bodies being read (256 MiB): a body reserves its declared length before it is read, or `503` + `Retry-After` | `src/chat.rs` |
| The upstream read at provider speed on a detached task; delivery through a bounded per-stream buffer (256 KiB) — full, or 30 s without progress, ends **delivery only** with `delivery_aborted` / `settlement: "pending"` | `src/call.rs` |
| Request, body-read and header-read timeouts | `src/server.rs`, `src/chat.rs`, `src/serve.rs` |
| Graceful drain on `SIGTERM` with a settler hook | `src/server.rs`, `src/settle.rs` |

## What is stubbed, and where the real thing plugs in

| Seam | This build | Replaced by |
|---|---|---|
| `catalog::CatalogSource` | `Unconfigured` — never yields a catalogue, so a deployed skeleton reports **not ready** and `/v1/chat` answers `503 catalog_unavailable` | fetch + `f2z_ai_proto::catalog::verify_catalog` against configured trusted keys |
| `chat::ChatBackend` → `call::Upstream` | `NotImplemented` — `501 not_implemented` | the provider adapters (OpenAI Responses, Anthropic Messages, xAI): `start` authenticates, holds and sends; the `Upstream` yields unified `f2z_ai_proto::Event`s |
| `settle::Settler` | `LogSettler` — logs the disposition | the ledger's `settle` / `release` (metering.md §3) |

`not_implemented` (`501`) and `not_found` (`404`, an unknown path) are
**not** `f2z_ai_proto::ErrorCode`s and are not part of the contract; a client
decodes them as `ErrorCode::Unknown`. Both go when the prose spec
([#1048](https://github.com/free2z/zuu/issues/1048)) is reconciled.

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
| `request_timeout_secs` | `310` | Request → response head; `500 internal` |
| `body_read_timeout_secs` | `30` | `400 invalid_request`, `reason: timeout` |
| `header_read_timeout_secs` | `10` | The connection is closed |
| `max_body_bytes` | `4194304` | Without image parts; `413 payload_too_large` |
| `max_body_bytes_with_images` | `20971520` | With image parts; the hard cap on what is read |
| `max_upload_buffer_bytes` | `268435456` | Request bodies being read at once, gateway-wide; a body reserves its `Content-Length` (the image cap if it has none). Without it the bound would be `max_concurrent_calls` × 20 MiB ≈ 195 GiB |
| `catalog_poll_secs` | `30` | |
| `delivery_buffer_bytes` | `262144` | Undelivered event bytes per stream before `delivery_aborted` |
| `delivery_stall_secs` | `30` | Frames waiting and none delivered for this long → `delivery_aborted` |
| `log_level` | `info` | This crate only; dependencies are capped at `warn` |
| `otlp_endpoint` | *(unset: off)* | `http://collector:4318`; spans go to `/v1/traces`. `https://` is refused: no TLS in this exporter build |
| `otlp_authorization_file` | *(unset)* | Or `F2Z_AI_OTLP_AUTHORIZATION`. Never inline in the file |

**`terminationGracePeriodSeconds` must exceed `drain_timeout_secs +
abort_grace_secs + settle_grace_secs`** (315 s with the defaults), or the
kubelet's `SIGKILL` arrives before the drain has handed every call to the
settler.

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
reads cannot hold a socket or a buffer past its slot. Request bodies are read
into one contiguous buffer, so a body sent in one-byte chunks costs its
payload and not a descriptor per chunk, and a body's share of the upload
budget is held until the backend's `start` has consumed the request.

Settlement ownership starts **before** the backend's `start` runs: a call
whose `start` fails, times out or is cancelled by a drain still reaches the
settler, as `NotStarted`, so a hold taken inside `start` can always be
released.
(`delivery_aborted` is not yet an `f2z_ai_proto::ErrorCode`; zuu#1052.)

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
with how its upstream ended (`NotStarted`, `Finished`, `Drained`), where
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
