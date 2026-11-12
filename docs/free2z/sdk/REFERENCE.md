# TypeScript API reference (D3)

The public package is `@free2z/sdk`. This reference describes current source;
[RELEASES.md](./RELEASES.md) identifies tagged support. `TauriTransport` is an
**unreleased** alias of `NativeTransport`, with the same constructor and class
identity. Use `NativeTransport` with the 0.4.0 tag. The API is handwritten and
normalized; emitted `dist/index.d.ts` declarations in the package are the exact
TypeScript signatures. Wire specs remain the endpoint authority.

| Public API | Result / contract |
|---|---|
| `new Client(new FetchTransport(config))` | Browser OAuth/HTTP; `FetchConfig` requires public `clientId` and exact registered `redirectUri`. Production defaults are the Free2Z issuer/account/gateway. `openExternal` is needed for account/billing exits. Tokens remain in memory |
| `new Client(new NativeTransport(nativeBridge))` | Tauri 2.5+ via `@free2z/tauri-plugin-f2z-api`; native configuration owns endpoints, client ID, scopes, callback and storage. Importing the facade does not load Tauri |
| `session()` | `Session`: signed-in state, stable `subject`, granted scopes, persistence, generation, optional display profile. No credentials |
| `signIn(options?)` | `Session`; explicit user action. `prompt: "login"` switches accounts. Native sign-in rejects `signal`; browser sign-in accepts it. `ephemeral` is native-only. Spend-cap hints suggest consent, never prove it |
| `signOut()` | `{revoked, generation}`; forgets local credentials even if server revocation is unconfirmed |
| `balance(signal?)` | Authoritative available, held, total and debt **milli-2Z**, plus `as_of`; all amounts `bigint` |
| `grant(signal?)` | Original consented cap/period, identity, scopes and explicit `enforced`. Generation does not version cap policy. Check the authoritative snapshot before relying on a budget |
| `models(signal?)` | `Models`; choose catalogue IDs. Missing capability is unsupported; prices/limits/version are `bigint`. Cache is login-generation-scoped |
| `estimate(request, signal?)` | `Estimate`; a snapshot, no hold/charge, no authorization or guaranteed price |
| `preflight(strictRequest, signal?)` | `ready`, `needs_top_up`, `needs_budget`, `too_large`. Requires both `max_output_tokens` and `max_output_tokens_strict: true`. Other errors throw |
| `chat(request, options)` | `ChatStream` (async iterator); caller supplies and saves `operationId` + `idempotencyKey` **before** sending. Optional `sessionGeneration` binds credential selection. No automatic replacement key |
| `stream.next()` / `stream.cancel()` | One outstanding read. `meta`, `delta`, `tool_call_delta`, `tool_call`, `usage`, `done`, `error`, or local `replay`. Cancel/break/abort stops delivery; billing may continue |
| `call(id, signal?)` / `waitForCall(id, pollOptions?)` | `CallRecord`, no answer text. Poll timeout returns the last snapshot, possibly pending; `timeoutMs: 0` reads once |
| `billingUrl()` / `openBilling()` | Account billing at `/buy-2z?client_id=…` (Zcash first, card second). Explicit build opt-in. No return URL; re-read balance on foreground |
| `manageAccountUrl()` / `openManageAccount()` | Purchase-free `/account/apps?client_id=…`; user-owned budget/access. The store-build account exit |
| `deleteAccountUrl()` / `openDeleteAccount()` | `/account/delete`; opens the system browser natively |
| `reportCall(id, reason, detail?, signal?)` | `CallReport`; preset `incorrect`, `inappropriate`, `unsafe`, `other`. Omit detail for child-directed apps |
| `formatMilli2z(amount)` | Exact fixed three-decimal display string: `41500n` → `"41.500"` |

`ChatRequest` uses a catalogue `model`, typed `messages`, optional `bigint`
`max_output_tokens`, structured output/tools/sampling as declared by the model.
See [chat-api.md](./spec/chat-api.md) for supported request fields and wire
semantics; [TOOLS.md](./TOOLS.md) covers the public tool helpers. No model-name
heuristics or unmerged compatibility/fallback behavior is promised here.

`Charge` is discriminated by `state`: `pending` (unknown), `released`
(confirmed zero), or `charged` (`charged2z`, `receiptId`, optional
`collectedMilli2z` / `shortfallMilli2z`). Never infer finality from an amount's
presence or from stream completion. A failed answer may be charged. All unit
and count integers decode losslessly as `bigint`; native IPC uses decimal
strings before JavaScript sees them. `Number(bigint)` is not a safe money path.

`SdkError` carries a stable/open-ended `code`, optional HTTP `status`,
`retryAfterSeconds`, `details`, `stepUp`, `idempotencyKey`, `callId`, and
`record`. Unknown codes remain representable. Inspect fields, never parse
`message`. `retryable` is scheduling information, never permission to create a
new billable key. A known call ID uses read-only receipt recovery; an unknown
ID may need explicit same-account, identical-body, same-key replay **within**
the 24-hour window. See [security/operations](./SECURITY.md).

## Legacy purchase compatibility and removal

Apps use billing, never present their own purchase. The deprecated
`createPurchase`, `purchase`, `waitForPurchase`, `openCheckout`,
`PurchaseRequest` and `FetchConfig.purchaseReturnUri` remain in 0.4.x.
They require explicit `purchase:create`; it is absent from `DEFAULT_SCOPES`.
Card intents remain supported for existing clients. A Zcash intent is refused
with `rail_unavailable` and `details.billing_url`; use the configured
`openBilling()` path rather than automatically opening a server-provided URL.
The endpoint does not create an app-facing Zcash invoice.

`waitForPurchase()` returns a last snapshot at its deadline: only `credited`
proves credit. Current source keeps polling unknown/reversible statuses until
resolution or deadline; tagged 0.4.0 stops on anything except
`created`/`pending`/`paid`. Do not treat a returned snapshot as payment success.

**Removal target: SDK 1.0.0**, a future breaking release, not a 0.4.x patch.
Before removal, migrate documented consumers to the billing exit, announce
replacement/required-scope changes in every affected package changelog and the
coordinated release entry, and retain legacy endpoint support for already
shipped clients. Removing wrappers does not authorize deleting server endpoints
or breaking old clients. No removal or publication happens in this change.
