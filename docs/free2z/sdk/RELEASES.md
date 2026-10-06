# Free2Z SDK releases

One coordinated version across the packages an app links. Each release is a Git
tag `sdk-v<version>` on `main`; pin by that tag or by the commit it names.
**Nothing here is published to crates.io or npm** — registry publication is a
separate, owner-authorized step ([RELEASING.md](./RELEASING.md#publication-sequence)).

| Package | Path | Registry name |
|---|---|---|
| Rust core | `rs/crates/f2z-sdk` | `f2z-sdk` |
| Wire contract (versioned with the core) | `rs/crates/f2z-ai-proto` | `f2z-ai-proto` |
| Native Tauri 2 plugin | `wallet/plugins/tauri-plugin-f2z` | `tauri-plugin-f2z` |
| Plugin guest bindings (guest-js) | `wallet/plugins/tauri-plugin-f2z` (sources in `guest-js/`) | `@free2z/tauri-plugin-f2z-api` |
| TypeScript facade | `ts/free2z/sdk` | `@free2z/sdk` |

Per-package detail lives in each package's `CHANGELOG.md`.

## sdk-v0.2.0 — 2026-10-06

The first tagged, stable SDK release, cut for the ¡AHA! app's initial release.
`0.1.0` was never tagged or published: it was the version every source preview
carried. This release covers everything since the last pinned preview,
[`534d2a58`](https://github.com/free2z/zuu/commit/534d2a58c5baa6fa67ccd8a0d5ab1e18adb5b860)
(#1106).

### Pinning

```toml
# src-tauri/Cargo.toml — the plugin already links the matching core
tauri-plugin-f2z = { git = "https://github.com/free2z/zuu", tag = "sdk-v0.2.0" }
# or, for a non-Tauri Rust app
f2z-sdk = { git = "https://github.com/free2z/zuu", tag = "sdk-v0.2.0" }
```

Build the two npm packages from the same tag (`npm pack` in
`wallet/plugins/tauri-plugin-f2z` and `ts/free2z/sdk`) as
[SOURCE-PREVIEW.md](./SOURCE-PREVIEW.md#versions-and-installation) describes:
they produce `free2z-tauri-plugin-f2z-api-0.2.0.tgz` and `free2z-sdk-0.2.0.tgz`.
`@free2z/sdk` 0.2.0 declares `@free2z/tauri-plugin-f2z-api@^0.2.0` as its
(optional) peer, so a 0.1.0 guest-js tarball no longer satisfies it.

### Gateway compatibility

| Gateway (`f2z-ai`, zuu source) | SDK 0.2.0 |
|---|---|
| older than `d26c9397` | Not supported. A request that sets a field newer than that gateway (`tool_choice`, `parallel_tool_calls`, `Tool.strict`, …) is refused with `400 invalid_request`, and no `tool_call_delta` is ever streamed |
| **`d26c9397` (#1142) — minimum.** The image tuzi pins on `main` today: `ghcr.io/free2z/f2z-ai@sha256:5b1cb4c6dd84998f23d74c5c346a6dc8dc053284c5632d573d528c758a98dcbf` (tuzi `k8s/f2z-ai/deployment.yaml`, tuzi#2499) | Everything except `reasoning_effort`. A request that sets it is refused by that gateway's `deny_unknown_fields` with `400 invalid_request`, before any hold or charge. `capabilities.reasoning_effort` is absent from its `/v1/models`, which the SDKs read as `false` |
| `b8e0c814` (#1170) and later | Adds `reasoning_effort`, on models whose **signed** catalogue entry declares `capabilities.reasoning_effort` (tuzi#2502) |
| `6c397db3` (#1171) — recommended; the commit this release is cut from | Adds the tokenizer input estimate and estimate-based settlement of interrupted calls. Gateway-side only: no SDK API change. proposed in tuzi#2507 (open) |

Unknown response members, events and catalogue capabilities pass through or are
ignored, so a newer gateway never breaks this SDK.

### Breaking changes

- **Rust — `OrderedJson` (#1143).** `Tool::parameters` and
  `JsonSchemaFormat::schema` are `f2z_ai_proto::OrderedJson`, not
  `serde_json::Value`. `serde_json::json!(…).into()` still compiles but is
  **already sorted** (no `preserve_order`), so the provider sees the keys
  alphabetically and OpenAI emits structured output in that order. Parse the
  schema text instead: `r#"{…}"#.parse::<OrderedJson>()?`.
- **Rust — exhaustive structs gained fields.** `ChatRequest`
  (`max_output_tokens_strict`, `response_format`, `tool_choice`,
  `parallel_tool_calls`, `reasoning_effort`) and `Tool` (`strict`), so a
  struct literal from the preview no longer compiles. Start from
  `ChatRequest::new(model, messages)` (plus the `with_*` builders) and assign
  the remaining public fields on the value; that keeps compiling as the
  contract grows. For tools, `ai::tools::function_tool` builds a `Tool`.
- **Rust — more exhaustive types grew.** `grant::Grant` gained
  `enforcement_reason` (#1123) — `Client::grant()` returns it, so a test fake's
  `Grant { … }` literal must name it — and `CatalogModel` gained
  `capabilities` / `controls` (#1114, #1170). `KNOWN_EVENTS` is `[&str; 7]`.
- **Rust — `LoopbackSession`** reports an opener failure as
  `Error::BrowserUnavailable`, not `Error::Browser` (#1138).
- **Tauri plugin — `serde_json/preserve_order`** is now enabled by the plugin
  and Cargo unifies it into the host app (#1143): every `serde_json::Map` in
  the app keeps insertion order instead of sorting.
- **Native sign-in rejections** end in `user_cancelled`,
  `browser_unavailable` or `timeout` where they used to be `browser_error`
  (still the fallback) (#1138). Code that matched only `browser_error` to
  detect a dismissed sheet must add `user_cancelled`.
- **TypeScript — errors (#1136).** `SdkError.code` is typed `SdkErrorCode`;
  `message` now ends with a developer hint; `retryable` follows `errors.md`
  (also `internal`, `provider_error`, `provider_timeout`, `too_many_holds`, and
  never when `details` show the call may have run). `NativeTransport` keeps the
  refusal `details`, amounts as `bigint`.
- **TypeScript — typed catalogue (#1137).** A non-boolean value for a known
  `capabilities` member is now `invalid_response` (unknown members still pass
  through); prices and limits decode as `bigint`.
- **TypeScript — `ChatEvent` gained `tool_call_delta`** (#1142): an exhaustive
  `switch` with a `never` check must handle it.

### What's in it

- **Typed estimate, models and capabilities** (#1134, #1137): the estimate's
  budget fields (`available_milli_2z`, `cap_remaining_milli_2z`,
  `min_charge_2z`, `catalog_version`) and the model catalogue
  (`capabilities.{vision,tools,reasoning,structured_output,strict_tools,reasoning_effort}`,
  prices, limits) are typed in Rust, TypeScript and guest-js.
- **DX** (#1136): `preflight()` (`ready` / `needs_top_up` / `needs_budget` /
  `too_large`), typed `SdkErrorCode` with developer hints, refusal `details`
  across the native bridge, `formatMilli2z` / `Milli2z::display_2z()`, and the
  CI-compiled quickstart (`examples/first_app.rs`).
- **Sign-in codes** (#1138): `user_cancelled`, `browser_unavailable`,
  `timeout`, `browser_error` (Rust `Error::UserCancelled` /
  `Error::BrowserUnavailable`; iOS and Android dismissal detected).
- **`response_format` and per-call features** (#1129, #1139, #1141): opt-in
  structured output (`json_schema` / `json_object`), checked locally against
  the gateway's limits; forwarding is pinned end to end (stream, non-stream,
  estimate hand-off); the gateway records requested features per call.
- **Anthropic tools and structured output** (#1140): `tool_choice`,
  `parallel_tool_calls` and `response_format` translated for Anthropic models.
- **Tool calling** (#1140, #1142): `tool_choice` and `parallel_tool_calls`
  (#1140), `Tool.strict`, the streamed `tool_call_delta` event with assemblers
  (`ToolCallAssembler` / `ToolCallAccumulator`), and `run_tools` / `runTools`
  with a hard ceiling of **32 rounds** (`MAX_TOOL_ROUNDS`); a charged failed
  round is never lost from the accounting.
- **Schema key order** (#1143): tool `parameters` and `response_format`
  schemas reach the provider in the order written (`OrderedJson`; the plugin
  enables `preserve_order`).
- **SSE keep-alives** (#1165): the gateway emits `: ping` comments on idle
  streams; both SDKs are tested to ignore them.
- **`reasoning_effort`** (#1170): `minimal` / `low` / `medium` / `high`,
  opt-in, gated by the signed `capabilities.reasoning_effort` and narrowed by
  `controls.effort_levels`; any other value is refused locally.
- **Tokenizer estimates and interrupted settlement** (#1171): the gateway
  estimates OpenAI input with the real tokenizer (for a recorded ¡AHA! request
  with a 28 KB strict schema, the old byte bound reserved 46,321 input tokens
  where the provider billed 7,346) and settles a call the provider accepted
  but never reported usage for on the estimate (`usage_source: estimated`),
  never releasing an accepted call. The SDK contract's `error` event docs now
  say a provider that accepted and then failed settles what it is owed.
- Also since the preview: `max_output_tokens_strict` (#1122/#1124), an optional
  sign-in spend-cap hint (#1125), grant `enforcement_reason` (#1123), signed
  catalogue v2 context pricing (#1121) and signed tool capabilities (#1114).
