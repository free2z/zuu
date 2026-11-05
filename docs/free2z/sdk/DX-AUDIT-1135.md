# Free2Z SDK first-app DX reconciliation (#1135)

Owner: Free2Z SDK. Audited base: `7296378e1738c96c940f8228d92c26b35d2f166c`.
Scope: [#1135](https://github.com/free2z/zuu/issues/1135). This reconciliation
records the audited source, implemented first-app improvements, and reproducible
remaining gaps. It satisfies the issue's audit reconciliation and first-app
evidence acceptance; it does not implement every feature in the original wishlist.
Evidence uses source and local fake services; no registry publication, real
sign-in, provider call or payment is certified.

Paths below are repository-relative. The owned [open follow-up checklist](#open-follow-up-checklist)
is the durable destination for unfinished features, independent of whether #1135
is closed. Existing focused issues retain their scope and ownership. The table
records implementation and test destinations for every remaining gap.

| # | Finding / disposition after reconciliation | Source and test evidence; leaf destination |
|---|---|---|
| 1 | Resolved: native refusal details | [#1136](https://github.com/free2z/zuu/pull/1136); `wallet/plugins/tauri-plugin-f2z/src/wire.rs::api_details`, `refusal_details_reach_javascript_documented_members_only`; `ts/free2z/sdk/test/dx.test.mjs` native refusal details and purchase pack tests. New `examples/native_dto.rs` executes the shipping codec against local HTTP refusal data. |
| 2 | Resolved: Rust constructors and example | [#1136](https://github.com/free2z/zuu/pull/1136), schema-order follow-up [#1166](https://github.com/free2z/zuu/pull/1166); `rs/crates/f2z-ai-proto/src/chat.rs::ChatRequest::new`, `rs/crates/f2z-sdk/examples/first_app.rs`. Run/build example, not just inspect prose. |
| 3 | Resolved: strict preflight | [#1136](https://github.com/free2z/zuu/pull/1136); TS `src/client.ts::preflight`, `test/dx.test.mjs`; Rust `src/ai/mod.rs::preflight`, `tests/ai.rs::preflight_maps_strict_refusals_to_the_recovery_to_offer`. New TS first-app test asserts 402/403 amounts and no chat dispatch on refusal. |
| 4 | Resolved: quickstart | [#1136](https://github.com/free2z/zuu/pull/1136); `QUICKSTART.md`, Rust `examples/first_app.rs`. TS public-package flow and strict packed-consumer checks cover the sequence; UI hooks/journal in the prose remain app-owned. |
| 5 | Partial: coordinated versions resolved; handshake still absent | [#1180](https://github.com/free2z/zuu/pull/1180), [#1224](https://github.com/free2z/zuu/pull/1224), [#1230](https://github.com/free2z/zuu/pull/1230); `RELEASES.md`, `SOURCE-PREVIEW.md`, five package manifests (SDK/plugin/guest 0.4.0; proto 0.3.0). No `bridgeInfo` in guest, `command_registry.rs`, or `NativeBridge`. Open follow-up #5: additive command/permission/DTO + old-plugin rejection tests in plugin `tests/guest.test.mjs` and SDK `test/native.test.mjs`; shipped-response compatibility also belongs to [#1181](https://github.com/free2z/zuu/issues/1181). Tag alignment is guidance, not a runtime handshake. |
| 6 | Resolved: typed codes including unknown fallback | [#1136](https://github.com/free2z/zuu/pull/1136); TS `src/error.ts::SdkErrorCode`; `test/dx.test.mjs` unknown and invalid-code handling. |
| 7 | Resolved: content-free developer hints | [#1136](https://github.com/free2z/zuu/pull/1136); TS `src/error.ts::errorHint`, `test/dx.test.mjs`. Hints are not UI text or permission to auto-retry. Billing wording remains [#1307](https://github.com/free2z/zuu/issues/1307). |
| 8 | Resolved: refusal retry classification | [#1136](https://github.com/free2z/zuu/pull/1136); TS `src/http.ts::retryableRefusal`, `test/dx.test.mjs`; Rust `ApiError::retryable`. Existing `tests/ai.rs::a_charged_failure_is_never_retried` and TS EOF tests cover unsafe outcomes. |
| 9 | Partial: distinct native sign-in codes shipped; general aliases remain | [#1138](https://github.com/free2z/zuu/pull/1138) owns native sign-in under [#1128](https://github.com/free2z/zuu/issues/1128); `NativeSignInErrorCode`, plugin `NativeError::from`. `src/native-transport.ts::nativeError` still preserves `transport_error`/`protocol_error`/`configuration_error`; `QUICKSTART.md` lists aliases. Open follow-up #9 destination: that mapper plus `test/native.test.mjs`/polling tests; retain legacy fallback and cancellation distinctions, coordinate sign-in owner. General error normalization remains open. |
| 10 | Resolved for original wire inventory | [#1134](https://github.com/free2z/zuu/pull/1134), [#1137](https://github.com/free2z/zuu/pull/1137), [#1136](https://github.com/free2z/zuu/pull/1136); TS `src/types.ts`, `src/decode.ts`, `test/fetch.test.mjs` typed models/estimate tests and packed-consumer type assertions. New unified fields stay with [#1161](https://github.com/free2z/zuu/issues/1161). |
| 11 | Open: Rust purchase code enum | `rs/crates/f2z-sdk/src/error.rs::ApiError::error_code` explicitly documents `Unknown` for account purchase codes; raw `code` remains usable. Open follow-up destination: `rs/crates/f2z-ai-proto/src/error.rs` and `tests/spec_conformance.rs` §6 inventory/status/retry tests. Coordinate deprecated API scope with [#1209](https://github.com/free2z/zuu/issues/1209) / [#1307](https://github.com/free2z/zuu/issues/1307); Purchase policy remains unchanged. |
| 12 | Implemented: TS sign-in hints | `src/types.ts::SignInOptions`, `NativeBridge`, `NativeTransport.signIn`, web `src/oauth.ts` now forward `loginHint`/`uiLocales`. `test/first-app.test.mjs` checks exact query encoding and native options; packed consumer compiles the options; Rust `examples/native_dto.rs` checks the actual shipping DTO-to-core mapping. These are suggestions, never identity/authorization proof. No new bridge command or dependency. |
| 13 | Partial: ToolCall typed; Rust prices and rail_data remain open | ToolCall shipped [#1142](https://github.com/free2z/zuu/pull/1142), `src/types.ts::ToolCall`, `test/native.test.mjs`/`test/fetch.test.mjs` tool controls/fragments. Rust `src/ai/record.rs::ModelInfo.prices` is still `Map<String, Value>`; TS `Purchase.rail_data` still opaque. Open follow-up: typed read-only price projection + decoding tests in `tests/ai.rs`; pricing classes stay [#1292](https://github.com/free2z/zuu/issues/1292)/[#1059](https://github.com/free2z/zuu/issues/1059). Legacy rail instructions belong with #1209/#1307, not the first-app flow. |
| 14 | Open: web operationId required | `src/types.ts::ChatOptions` still requires `operationId`, `FetchTransport.chat` validates it. Open follow-up destination: explicitly document cross-transport operation identity in SDK README + packed-consumer assertion, or design an additive web-only API; do not silently generate billing keys. New first-app fixture supplies both IDs. |
| 15 | Resolved: exact display | [#1136](https://github.com/free2z/zuu/pull/1136); TS `src/format.ts`, `test/dx.test.mjs` including u64; Rust amount `display_2z` unit tests and running first-app example. |
| 16 | Open: reusable consumer test kit | Package exports only `.`; Rust test fakes live in `tests/support`, not packaged (`Cargo.toml include`). [#1053](https://github.com/free2z/zuu/issues/1053) delivered gateway/provider testkit, not an app SDK testkit. Open follow-up #16 destination: `@free2z/sdk/testing` export with actor-aware decimal DTO fixtures + packed-consumer tests, Rust opt-in fake module/package contract. The local regression does not provide a published testkit. |
| 17 | Implemented: registration walkthrough | `INTEGRATION.md` now links `/developers/apps`, public app type, redirects, scopes, optional suggested budget and client_id; backed by `ts/svelte/free2z/src/routes/developers/apps/+page.svelte` (shipped [#1256](https://github.com/free2z/zuu/pull/1256)). Registration documentation; no claim a deployment registration was exercised. |
| 18 | Partial: account-switch docs/identity resolved; reusable journal remains open | [#1136](https://github.com/free2z/zuu/pull/1136), [#1219](https://github.com/free2z/zuu/pull/1219); `QUICKSTART.md` §6; TS `test/fetch.test.mjs` account switch during refresh and old-generation chat, Rust `tests/ai.rs::a_retry_never_runs_under_another_session`. Open follow-up: subject/app/generation/timestamp-scoped journal interface + switch/expiry isolation regressions. The example journal is app-owned memory, not persistence tooling. |
| 19 | Resolved: collection helper exists | [#1142](https://github.com/free2z/zuu/pull/1142); public `src/index.ts` exports `collectChat`, `src/tools.ts::collectChat` returns `ToolRound` with text and terminal/error/charge; transport failures throw. `test/fetch.test.mjs` / `test/native.test.mjs` runTools and partial charged failure tests exercise it. It collects a stream; it does not introduce a second billable request. |
| 20 | Implemented: task-oriented integration | Moved dated installation/status material into `SOURCE-PREVIEW.md` as a historical snapshot; `INTEGRATION.md` leads with first-app, registration and native contracts. Integration documentation. Historical 404 results are dated evidence, not a fresh registry check. |
| 21 | Open with privacy constraint: SSE message typing | `src/types.ts::ChatEvent` error arm still has no explicit `message?: string` (only ObjectData's Json index); `src/decode.ts::event` spreads web fields. Native `wire.rs::event` deliberately removes message. Open follow-up destination: optional web-only developer message type + decoder validation in `test/protocol.test.mjs`, preserving omission on native and content-free SdkError. Do not start forwarding raw native error text to close a typing gap. |

## Open follow-up checklist

Owner: **Free2Z SDK maintainers**, coordinating with the focused workstreams
linked below. Every unchecked item is **OPEN**. Closing the audit issue does not
close these features; implementation and its focused regression are required
before checking an item off. Table row numbers preserve the original finding IDs.

- [ ] **#5 — Native compatibility handshake.** Add an additive guest/plugin
  command, permission and DTO plus `NativeBridge` negotiation. Test missing/old
  plugins in `wallet/plugins/tauri-plugin-f2z/tests/guest.test.mjs` and
  `ts/free2z/sdk/test/native.test.mjs`. Coordinate shipped-response compatibility
  with [#1181](https://github.com/free2z/zuu/issues/1181).
- [ ] **#9 — General native error aliases.** Normalize in
  `ts/free2z/sdk/src/native-transport.ts::nativeError` and cover mapping and
  polling in `test/native.test.mjs`. Preserve legacy fallbacks and cancellation
  distinctions; native sign-in ownership stays with
  [#1128](https://github.com/free2z/zuu/issues/1128) (merged #1138).
- [ ] **#11 — Rust purchase error enums.** Extend
  `rs/crates/f2z-ai-proto/src/error.rs` and `tests/spec_conformance.rs` for the
  §6 inventory, statuses and retryability. Coordinate legacy API scope with
  [#1209](https://github.com/free2z/zuu/issues/1209) and
  [#1307](https://github.com/free2z/zuu/issues/1307).
- [ ] **#13 — Typed Rust model prices.** Add a read-only projection in
  `rs/crates/f2z-sdk/src/ai/record.rs` and decoding regressions in `tests/ai.rs`.
  Pricing-class semantics remain with
  [#1292](https://github.com/free2z/zuu/issues/1292) and
  [#1059](https://github.com/free2z/zuu/issues/1059).
- [ ] **#13 — Legacy purchase rail DTOs.** Specify the supported read-only
  `Purchase.rail_data` projection in `ts/free2z/sdk/src/types.ts` and validate it
  in `src/decode.ts` with transport tests. Defer the supported legacy surface
  decision to #1209/#1307; do not introduce a new in-app purchase flow.
- [ ] **#14 — Web operation identity contract.** Document cross-transport
  `operationId` in `ts/free2z/sdk/README.md` with a packed-consumer assertion in
  `scripts/test-package.mjs`, or design an additive web-only API. Retain explicit
  caller-owned billing keys; current first-app examples supply both IDs.
- [ ] **#16 — Reusable app SDK testkit.** Add an `@free2z/sdk/testing` export
  with actor-aware decimal fixtures and packed-consumer tests, plus an opt-in
  Rust fake module/package contract. `tests/support` and the gateway testkit
  from [#1053](https://github.com/free2z/zuu/issues/1053) do not fulfill this.
- [ ] **#18 — Account-scoped recovery journal.** Define subject/app/generation/
  timestamp ownership and expiry in a reusable SDK helper. Add switch and
  24-hour expiry isolation regressions to TS `test/native.test.mjs` /
  `test/fetch.test.mjs` and Rust `tests/ai.rs`; preserve the account-switch
  contracts shipped in [#1219](https://github.com/free2z/zuu/pull/1219).
- [ ] **#21 — SSE error message typing.** Add optional web-only developer
  message typing in `ts/free2z/sdk/src/types.ts`, validate it in `src/decode.ts`
  and test in `test/protocol.test.mjs`. Keep raw messages out of native IPC and
  keep `SdkError` content-free.

Other workstreams retain ownership: [#1128](https://github.com/free2z/zuu/issues/1128)
and #1148–#1162 for provider compatibility, [#1132](https://github.com/free2z/zuu/issues/1132)
for schema order (merged #1143, corrected example #1166),
[#1047](https://github.com/free2z/zuu/issues/1047)/[#1078](https://github.com/free2z/zuu/issues/1078)
for live metering, #1292/#1059 for price classes, #1209/#1307 for purchase policy.

## Reproduction and limits

`ts/free2z/sdk/test/first-app.test.mjs` follows QUICKSTART/INTEGRATION using
only public package exports. Both FetchTransport (mock fetch + verified fake
issuer JWT) and NativeTransport (decimal DTO mock) exercise memory-only sign-in,
grant enforcement, u64 balance, model capability selection, strict preflight,
402/403 recovery, structured chat, cancellation, broken delivery with explicit
same-key/body/account recovery, receipt and sign-out. Refusals assert no chat;
recovery asserts exact request/key reuse and no automatic new-key attempt.
`test:package` repeats this against the installed tarball and strictly compiles
the public consumer. No tokens go to browser storage.

Rust `examples/first_app.rs` executes the documented successful flow and all
preflight branches against local fakes. `tests/ai.rs` separately covers
cancellation, charged failure, lost-answer same-key recovery, pending settlement
and session ownership. `examples/native_dto.rs` compiles the **shipping**
plugin `wire.rs` and exercises sign-in hints, grant, balance, models, estimate, stream, receipt and lossless/content-free refusal
DTOs without linking an OS runtime. It intentionally runs as an example, not
the plugin's embedded test module: that module requires the plugin's
`serde_json/preserve_order` feature, which the SDK must not acquire merely to
run a DTO probe. This verifies shared codec behavior, not an OS build, platform
browser or keychain. TS mocks alone do not prove native compatibility.

Run from `ts/free2z/sdk`: `npm ci --ignore-scripts --no-audit --no-fund`,
`npm test`, `npm run test:package`, `npm run typecheck`, `npm run format:check`.
Run from `rs`: `cargo +1.97.1 test --locked -p f2z-sdk`,
`cargo +1.97.1 run --locked -p f2z-sdk --example first_app`,
`cargo +1.97.1 run --locked -p f2z-sdk --example native_dto`,
`cargo +1.97.1 build --locked -p f2z-sdk --examples`,
`cargo +1.97.1 fmt -p f2z-sdk -- --check`,
`cargo +1.97.1 clippy --locked -p f2z-sdk --all-targets -- -D warnings`.

Verification executed on Linux with Rust 1.97.1 and the SDK CI's Node 22.23.4
(npm 10.9.9), 2026-11-04:

| Command (directories as above) | Result |
|---|---|
| `npm ci --ignore-scripts --no-audit --no-fund` | Installed 3 pinned dependencies; manifests/lockfile unchanged |
| `npm test` | 86 passed, zero failed |
| `npm run test:package` | Packed/installed tarball imported; strict public consumer compiled; both first-app transport tests passed |
| `npm run typecheck` / `npm run format:check` | Passed |
| `node scripts/check-project-namespaces.mjs` (repository root, new files staged) | 5,422 tracked paths passed |
| `node scripts/check-markdown-links.mjs` (repository root) | 1,381 relative links and 563 heading anchors passed across 267 documents; external URLs not fetched |
| `git diff --check` / `git diff --cached --check` | Passed |
| `cargo +1.97.1 test --locked -p f2z-sdk` | 139 unit/integration tests + 9 doctests passed |
| `cargo +1.97.1 run --locked -p f2z-sdk --example first_app` | Successful structured JSON, 402/403/too-large recovery, final receipt and revocation |
| `cargo +1.97.1 run --locked -p f2z-sdk --example native_dto` | Shipping codec hints, grant/balance/models/estimate/stream/receipt/refusal assertions passed |
| `cargo +1.97.1 build --locked -p f2z-sdk --examples` | Passed |
| `cargo +1.97.1 fmt -p f2z-sdk -- --check` | Passed |
| `cargo +1.97.1 clippy --locked -p f2z-sdk --all-targets -- -D warnings` | Passed |

No Rust dependency/feature changes. No full repository suite, OS builds, CI
runs, registry publication or real environment dogfood were performed. Local
fake HTTP listeners exit with the example/test processes. Task-created build
output is removed after verification; review may require a cold rebuild.
