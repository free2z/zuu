# @free2z/sdk

Pre-release TypeScript client for Free2Z sign-in, 2Z balances, purchases, and
micro-metered AI. This package is **not yet published**. Registry names and
commands below describe the intended release, not an available installation.
Production integration also requires a registered public OAuth client, enabled
service endpoints, and the native plugin for Tauri. See the
[SDK integration guide](https://github.com/free2z/zuu/blob/main/docs/free2z/sdk/INTEGRATION.md).

## Application API

After publication, the intended installation is `npm install @free2z/sdk`.
Use Node 22+ for tooling and a browser/WebView with Fetch, Web Crypto,
ReadableStream, BigInt, and structuredClone support.

```ts
import { Client, NativeTransport } from '@free2z/sdk';
import { nativeBridge } from '@free2z/tauri-plugin-f2z-api';

const client = new Client(new NativeTransport(nativeBridge));
await client.signIn();
const balance = await client.balance();
console.log(balance.available_milli_2z.toString());
```

The native plugin package is also pending publication. Its Rust builder owns
client ID, allowed issuer/API endpoints, scopes, callback registration, and OS
credential persistence. Webview JavaScript receives no tokens. The structural
`NativeBridge` interface also permits a mock adapter; importing this package
does not import Tauri or read global Tauri internals.

For a browser app:

```ts
import { Client, FetchTransport } from '@free2z/sdk';
const client = new Client(new FetchTransport({
  clientId: 'YOUR_REGISTERED_PUBLIC_CLIENT_ID',
  redirectUri: 'https://your-app.example/oauth/callback',
  purchaseReturnUri: 'https://your-app.example/purchase-return',
  openExternal: async url => { window.location.assign(url); },
}));
// Call from a user gesture so the popup can open.
await client.signIn();
```

The registered callback page calls `completeBrowserSignIn()` from this package.
Serve it on the opener's origin, or explicitly pass the expected opener origin.
The popup and opener must retain their browser relationship; a policy that
severs `window.opener` needs a custom `BrowserAuthSession`. The callback contains
an authorization code, never tokens. FetchTransport owns tokens **in memory**;
reload requires sign-in. It uses authorization-code PKCE, state, nonce,
issuer/audience/signature checks, and a single shared refresh operation.
Never use FetchTransport inside a privileged Tauri webview: use NativeTransport.

The default scopes are `openid profile offline_access balance:read
purchase:create ai:invoke`. Inspect `session().grantedScopes`. A web app may
configure fewer scopes; native scopes belong to its Rust builder.

## Amounts, operations, and receipts

All integer protocol amounts and counters are `bigint`, including milli-2Z
balances. One 2Z is 1,000 milli-2Z. Format from integer arithmetic; never pass
amounts through `Number`, `parseFloat`, or ordinary `JSON.parse`. Store amounts
as decimal strings when persisting application state. The browser wire parser
preserves integer lexemes; the native adapter decodes canonical decimal DTOs.
Tool-schema JSON cannot carry unsafe integers across native IPC and rejects them.

Generate and **persist** `operationId` and `idempotencyKey` before invoking chat.
The SDK does not create a replacement key or retry a new billable operation.

```ts
const operationId = crypto.randomUUID();
const idempotencyKey = crypto.randomUUID();
// Persist both keys, selected model and request in your operation journal here.
const stream = await client.chat({
  model: 'MODEL_ID_FROM_CATALOG',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Explain fractions.' }] }],
  max_output_tokens: 256n,
}, { operationId, idempotencyKey });
for await (const event of stream) {
  if (event.type === 'delta') console.log(event.text);
  if (event.type === 'done' || event.type === 'error') console.log(event.charge);
}
```

Add `max_output_tokens_strict: true` when a length-truncated answer is useless
to you: the gateway then refuses (`insufficient_balance`, `cap_exceeded`, …)
before any hold or charge instead of lowering `max_output_tokens` to what the
user can afford. Pre-check with `estimate()` on the same request, flag included:
it answers exactly as the strict call would, without a hold or charge. See `docs/free2z/sdk/INTEGRATION.md`.

For a JSON reply, set `response_format: { type: "json_schema", json_schema: {
name, schema, strict: true } }` (or `{ type: "json_object" }`) and parse the
reply text yourself. The SDK checks the gateway's limits before sending; a
model without `capabilities.structured_output` refuses the call before any
hold or charge (`invalid_request`, `reason: "response_format_unsupported"`).

Only one `next()` may be outstanding. `cancel()`, breaking iteration, or an
AbortSignal stops delivery; none proves that generation or charging stopped.
Persist `stream.callId` when available. A broken response carries the original
key and known call ID in `SdkError`. Reconcile using `call()`/`waitForCall()` or
resubmit the **same request and key** when the call ID is unknown. A completed
idempotent replay yields a `replay` event containing the call record.

`charge.state === 'pending'` means the final amount is unknown; never display it
as zero. `charged` includes a receipt ID and charged whole-2Z amount; optional
collection/shortfall fields are milli-2Z. `released` means a confirmed zero
charge. Polling can return pending at its deadline; inspect the returned state.
Unknown server settlement states remain pending.

For purchases, persist a separate key, call
`createPurchase({rail: 'card', quantity2z: 100n}, {idempotencyKey})`, then
`openCheckout(intent.id)` and `waitForPurchase(intent.id)`. Native checkout URLs
stay native. Zcash intents expose payment instructions in `rail_data`.
Register the purchase-return URI too; it should restore the persisted intent ID
and begin polling. If it shares the OAuth callback route, distinguish
`purchase_id` returns from OAuth code callbacks before calling
`completeBrowserSignIn`. A browser return is **not** proof of payment. `paid` still needs polling until
`credited`; refresh the balance after returning to the app. A poll deadline can
return the last `paid`/`pending` intent. Refund/dispute statuses are preserved.

## Cancellation and errors

`SdkError` exposes safe codes and structured context, never raw token, keychain,
or provider diagnostics. Inspect `stepUp` for fresh-authentication requirements;
then use `signIn({maxAge, acrValues})`. There is no automatic sign-in popup in an
API call. `retryAfterSeconds` is bounded to 24 hours for scheduling.

Native `signIn` rejects an AbortSignal before invoking IPC: cancel through the
system authentication UI or sign out. Native sign-out invalidates delivery and
cancels the native auth session. Browser sign-in supports AbortSignal and
revokes a newly issued grant if cancellation wins before installation.

Browser refresh recovery uses the same predecessor token, at most three
attempts, a 30-second first-attempt ceiling, and a 55-second total budget.
Configured request timeouts can be shorter. Cancelling an API wait does not
cancel rotation. Exhausting recovery clears local credentials and requires
sign-in; a revocation attempt is best effort. One FetchTransport owns one
in-memory session; do not share it between unrelated browser users.

Browser responses are bounded (8 MiB JSON, 256 KiB SSE event, 1 MiB delivered
chunk). SSE is pull-driven, with a 45-second pending-read idle timeout by
default. Fetch/browser networking may buffer internally. This is not an
unbounded push-event queue. Model catalogue caching honors ETag and max-age
(up to one hour) and is scoped to the current login generation.

## Contributor verification

From `ts/free2z/sdk`: `npm ci`, `npm test`, `npm run test:package`.
The latter installs the locally built tarball into a temporary isolated consumer
and checks public imports/types. It is a packaging test, not a supported released
installation. Tests use a signed mock issuer and fake transports; they do not
establish production availability or make real purchases.

Application types are handwritten normalized types (`bigint` and `Charge`),
not generated Rust wire aliases. Protocol conformance and native guest type
compatibility are release gates; publication and live end-to-end validation are
tracked separately from these mock tests.

`await client.grant()` returns the current authenticated account/app's original
consented cap and period, scopes, server revocation stamps, `enforced`, and
snapshot time. Integers are `bigint`; `spend_cap_2z === null` means uncapped.
Require explicit enforcement and check identity, period and limit against the
user's authorization. Neither a small estimate remainder nor grant generation
proves a total budget: cap changes need not increment that generation. Re-read
before relying on the policy; this snapshot does not freeze future consent.
See [the grant contract](../../../docs/free2z/sdk/spec/grant.md). Older native
bridges without the command return `unsupported_operation` instead of guessing.
