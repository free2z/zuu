# Use the real SDK from pinned public source

This is an interim **source preview**, not a published release. You can compile
and integrate the real SDK in a Tauri 2 app now. A successful build does not
prove that login, a payment rail or metered AI is ready for your registered
client. See [live prerequisites](#live-prerequisites) before enabling those UI
flows. The supported release installation will use crates.io/npm packages.

## Versions and installation

Use Rust 1.97.1, Node 22+ and your platform's Tauri 2 build prerequisites. The
following public revisions are independently reviewed previews:

| Component | Exact source revision | Tracking |
|---|---|---|
| Rust core, including `grant()` | `534d2a58c5baa6fa67ccd8a0d5ab1e18adb5b860` | [#1106](https://github.com/free2z/zuu/pull/1106) |
| Native plugin and its JavaScript bridge | `534d2a58c5baa6fa67ccd8a0d5ab1e18adb5b860` | [#1106](https://github.com/free2z/zuu/pull/1106) |
| TypeScript facade | `534d2a58c5baa6fa67ccd8a0d5ab1e18adb5b860` | [#1106](https://github.com/free2z/zuu/pull/1106) |

The plugin's revision already includes the merged core. Do not add a second
independent core client to the app. In `src-tauri/Cargo.toml`:

```toml
[dependencies]
tauri-plugin-f2z = { git = "https://github.com/free2z/zuu", rev = "534d2a58c5baa6fa67ccd8a0d5ab1e18adb5b860" }
```

Cargo also fetches this synthetic repository's upstream submodules when
resolving the Git dependency; a first download is larger than these SDK crates.
Commit the resulting application `Cargo.lock`. No private checkout is needed.

The npm packages are not published. Build exact tarballs from the public source;
`npm install` cannot select a monorepo subdirectory from a Git URL. In a separate
build directory, run:

```sh
mkdir free2z-sdk-preview-build
cd free2z-sdk-preview-build
SDK_BUILD="$PWD"
git clone --filter=blob:none --no-checkout https://github.com/free2z/zuu.git repository
git -C repository fetch origin 534d2a58c5baa6fa67ccd8a0d5ab1e18adb5b860
git -C repository worktree add --detach "$SDK_BUILD/native" 534d2a58c5baa6fa67ccd8a0d5ab1e18adb5b860
git -C repository fetch origin 534d2a58c5baa6fa67ccd8a0d5ab1e18adb5b860
git -C repository worktree add --detach "$SDK_BUILD/typescript" 534d2a58c5baa6fa67ccd8a0d5ab1e18adb5b860
mkdir artifacts
cd "$SDK_BUILD/native/wallet/plugins/tauri-plugin-f2z"
npm ci
npm pack --pack-destination "$SDK_BUILD/artifacts"
cd "$SDK_BUILD/typescript/ts/free2z/sdk"
npm ci
npm pack --pack-destination "$SDK_BUILD/artifacts"
```

Do not initialize submodules for these JavaScript builds. Copy both generated
`.tgz` files into your application's
`vendor/free2z/sdk/534d2a58c5baa6fa67ccd8a0d5ab1e18adb5b860/` directory,
then run from the app root:

```sh
npm install ./vendor/free2z/sdk/534d2a58c5baa6fa67ccd8a0d5ab1e18adb5b860/free2z-tauri-plugin-f2z-api-0.1.0.tgz ./vendor/free2z/sdk/534d2a58c5baa6fa67ccd8a0d5ab1e18adb5b860/free2z-sdk-0.1.0.tgz
```

Keep the tarballs, their exact source revisions and the application lockfile
with your build inputs. Preview upgrades may retain package version `0.1.0`;
put each new revision in a new directory and run `npm install` with those new
paths. Commit the resulting dependency paths and lockfile integrity values;
do not overwrite an older revision's tarballs or rely on the version alone. The native bridge also requires `@tauri-apps/api` 2.5+
within major version 2, normally already present in a Tauri app. Set the app's
TypeScript target to ES2022 or newer for `bigint`. The checked adapter uses
TypeScript 5.9 with `lib: ["ES2022", "DOM", "DOM.Iterable", "ESNext.Disposable"]`
(the last library covers current Tauri API declarations). Use the native bridge in a
Tauri webview, not `FetchTransport`, so credentials remain in Rust.

## Native host and capability

The plugin owns one core client, OS credential persistence, browser callbacks
and stream lifetimes. Configure endpoints and public client identity in Rust;
never accept them from a webview command. Add this helper to your Tauri host:

```rust
use tauri::{plugin::TauriPlugin, Runtime};
use tauri_plugin_f2z::{f2z_sdk::Config, Builder as Free2zBuilder};

// These values come from the app's public-client registration, in Rust.
// No client secret or webview-supplied endpoint is accepted.
pub fn free2z_plugin<R: Runtime>(
    public_client_id: &str,
    purchase_return_uri: &str,
) -> TauriPlugin<R> {
    Free2zBuilder::new(Config::new(public_client_id), purchase_return_uri)
        .windows(["main".to_owned()])
        .build()
}

// In the real app, continue this builder with its existing run/context setup.
pub fn with_free2z<R: Runtime>(
    app: tauri::Builder<R>,
    public_client_id: &str,
    purchase_return_uri: &str,
) -> tauri::Builder<R> {
    app.plugin(free2z_plugin(public_client_id, purchase_return_uri))
}
```

Apply `with_free2z` to your existing `tauri::Builder` before its `.run(...)`,
passing the registered public client ID and HTTPS purchase-return URL from
native configuration. Keep the application's existing generated context and
other plugins. The defaults target Free2Z services; placeholders are not a
registered client and do not enable live service access.

Create `src-tauri/capabilities/free2z.json` with the following local-only grant.
If your Tauri security configuration explicitly lists capability identifiers,
include `free2z-tutor` there. Keep existing application capabilities as needed.

```json
{
  "identifier": "free2z-tutor",
  "description": "Free2Z SDK access for the tutor's trusted local main window",
  "local": true,
  "windows": ["main"],
  "permissions": [
    "f2z:allow-session", "f2z:allow-sign-in", "f2z:allow-sign-out",
    "f2z:allow-balance", "f2z:allow-grant", "f2z:allow-models", "f2z:allow-estimate",
    "f2z:allow-create-purchase", "f2z:allow-purchase", "f2z:allow-open-checkout",
    "f2z:allow-start-chat", "f2z:allow-next-chat", "f2z:allow-cancel-chat",
    "f2z:allow-call"
  ]
}
```

These permissions match the native methods used by the TypeScript facade;
facade polling calls `purchase` and `call` repeatedly, so native wait commands
need not be granted. `f2z:default` grants nothing. The configured trusted window
label must match `main`; no remote pages or untrusted frames receive this grant.
Render model output as text or sanitized markup.

This helper is sufficient for the desktop callback profile: register
`http://127.0.0.1:<ephemeral-port>/callback` according to the public client
contract. Mobile sign-in additionally requires `Builder::mobile_redirects`,
registered HTTPS/private-scheme callbacks and OS app-link configuration. Follow
[the pinned plugin's platform registration instructions](https://github.com/free2z/zuu/blob/534d2a58c5baa6fa67ccd8a0d5ab1e18adb5b860/wallet/plugins/tauri-plugin-f2z/README.md#platform-registration)
for iOS and Android; desktop success does not establish mobile acceptance.

## Typed application adapter

This uses the actual packages above. Keep one client for the app lifetime.
The caller supplies a durable journal; write operation keys before the first
request and retain them after cancellation or an uncertain response.

```ts
import { Client, NativeTransport, type ChatRequest } from '@free2z/sdk';
import { nativeBridge } from '@free2z/tauri-plugin-f2z-api';

export const free2z = new Client(new NativeTransport(nativeBridge));
type Journal = { put(id: string, value: Record<string, unknown>): Promise<void> };

export async function signInFromUserGesture() {
  // Native sign-in does not accept AbortSignal. The system browser owns its UI.
  const session = await free2z.signIn();
  return { subject: session.subject, scopes: session.grantedScopes };
}

export async function readBalance() {
  const balance = await free2z.balance();
  return {
    availableMilli2z: balance.available_milli_2z.toString(),
    heldMilli2z: balance.held_milli_2z.toString(),
    debtMilli2z: balance.debt_milli_2z.toString(),
  };
}

export async function readGrantForUi() {
  const grant = await free2z.grant();
  return {
    subject: grant.sub,
    clientId: grant.client_id,
    originalLimit2z: grant.spend_cap_2z?.toString() ?? null,
    period: grant.cap_period,
    enforced: grant.enforced,
    asOf: grant.as_of,
  };
}

export async function buyCredits(journal: Journal) {
  const session = await free2z.session();
  const key = crypto.randomUUID();
  await journal.put(key, { kind: 'purchase', subject: session.subject,
    rail: 'card', quantity2z: '100', idempotencyKey: key });
  const intent = await free2z.createPurchase(
    { rail: 'card', quantity2z: 100n }, { idempotencyKey: key });
  await journal.put(key, { kind: 'purchase', subject: session.subject,
    intentId: intent.id, idempotencyKey: key });
  await free2z.openCheckout(intent.id); // Native system browser; no raw URL in JS.
  return free2z.waitForPurchase(intent.id, { timeoutMs: 120_000 });
}

export async function beginTutorReply(model: string, text: string, journal: Journal) {
  const session = await free2z.session();
  const operationId = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  const request: ChatRequest = {
    model, messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    max_output_tokens: 256n,
  };
  await journal.put(operationId, { kind: 'chat', subject: session.subject,
    operationId, idempotencyKey, model, text, maxOutputTokens: '256' });
  return free2z.chat(request, { operationId, idempotencyKey });
}
```

Select `model` from `await free2z.models()` and check `await free2z.estimate(...)`
before presenting a spending confirmation. Inspect the granted scopes and the
signed-in session before enabling a paid action. The snippets leave UI rendering
and durable journal storage to the app; journal writes must not be no-ops.

A purchase deadline can return `created`, `pending` or `paid`; only `credited`
proves credits arrived. Refresh `balance()` after crediting. A checkout browser
return does not prove payment. For Zcash, pass `rail: 'zcash'` and display the
returned `rail_data` instructions rather than calling `openCheckout`.

A chat returns a pull iterator: process one `for await` event at a time. Render
`delta.text` as text or sanitized markup. Persist `stream.callId` when known.
The Stop button calls `await stream.cancel()`; it stops delivery, not necessarily
generation or charging. A terminal `error` may still have a charge. Use the
terminal event's `charge.state`, or reconcile with `waitForCall(callId)`; `pending`
is not a final amount. If a response breaks before the call ID is known, retain
the original key and exact request for same-key recovery, not a new purchase or
chat key. Keep journals associated with the original subject across sign-out.

Balances are integer milli-2Z (`1 2Z = 1000 milli-2Z`); purchases and final call
charges use whole 2Z. Persist `bigint` as decimal strings and never round through
`Number`. `signOut()` returns a revocation result; clear account UI immediately
and surface unsuccessful remote revocation without exposing credentials.

## Live prerequisites

Before testing with real accounts, obtain all of the following:

- A registered public OAuth client and granted scopes `openid profile
  offline_access balance:read purchase:create ai:invoke`.
- Registered desktop loopback and mobile redirects, app-link association files
  and the purchase-return URL configured in the native host.
- Confirmation of authenticated balance and the intended payment rail for the
  app/platform, plus approved test accounts and payment limits.
- A deployed gateway with the SDK's catalogue, estimate, chat and call-record
  routes, and connected hold/settlement accounting. Local SDK tests do not
  establish that the live gateway implements these contracts.
- Desktop/iOS/Android device acceptance for browser callbacks, OS credential
  storage, purchase confirmation, cancellation and receipt/balance reconciliation.

Read-only observations on 2026-09-27 found public OIDC discovery reachable and
an anonymous SDK balance request rejected with `401 invalid_token`, as expected.
These observations establish endpoint reachability only, not a successful
registered-client login, purchase or metered call. Track acceptance in
[#1047](https://github.com/free2z/zuu/issues/1047). Until then, connect the real SDK
where the platform has confirmed readiness and keep unavailable flows behind
the app's mock adapter.

## User-owned budgets and recovery

The optional per-app budget is the user's authorization inside Free2Z, not a
budget the tutor or developer may raise. Developer defaults are suggestions for
new grants. A null limit means prepaid account balance without an extra app
budget; existing consent still governs. `grant()` reports original policy and
explicit enforcement, not remaining funds. Server epoch/generation values are
revocation stamps, not policy versions. Refresh grant and balance after the user
returns from account management; a previous proof does not freeze consent.

Handle `SdkError.code` (and terminal stream error codes) distinctly:

- `user_cancelled` from `signIn()`: the user dismissed the iOS sign-in sheet or
  the Android Custom Tab. Not an error; leave sign-in available without a
  failure message. `browser_unavailable` (nothing could be shown) and `timeout`
  (no callback in time; also how a desktop cancel arrives) are failures, and
  `browser_error` is the fallback for anything else — an older plugin reports
  every one of these as `browser_error`, so always handle it
  ([errors.md §5.1](./spec/errors.md#51-sign-in-that-ends-at-the-browser-sdk-local)).

- `insufficient_balance`: offer the SDK purchase flow above, or the Billing link
  on [Free2Z connected apps](https://free2z.cash/account/apps). Credit only after
  a purchase is authoritatively `credited`; opening checkout is not a top-up.
- `cap_exceeded`: explain that this app's user-authorized budget is exhausted.
  Direct the user to [manage the budget in Free2Z](https://free2z.cash/account/apps),
  or wait for its applicable period. Buying more account credits does not raise
  the app budget. Raising/removing it requires the user's action and may require
  recent authentication; do not silently reauthorize a larger amount.
- `account_in_debt`: show the debt separately and direct the user to account
  management. Do not represent held or newly purchased funds as spendable before
  re-reading the authoritative balance.
- `rate_limited`, `concurrency_limit`, or `unavailable`: explain temporary service
  capacity/availability and honor `Retry-After`. These do not request a top-up or
  a larger spending budget. Recover an uncertain operation with its existing key
  before considering a new billable request.

The SDK does not expose a generic webview-to-native URL opener. The app's trusted
host may open the fixed account-management URL in the system browser; do not pass
arbitrary model-output URLs to a privileged command. The signed-in account page
provides its correct Billing link. Never construct that route from an OAuth
subject, which is not a username.
