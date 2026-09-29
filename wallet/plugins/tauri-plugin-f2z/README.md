# Free2Z for Tauri 2

Native sign-in, exact 2Z balances, card/Zcash purchase intents, and metered AI.
This package is the native transport for `@free2z/sdk`; it can also be used
through its small `nativeBridge` API. The Rust core owns all bearer credentials.
The webview receives session metadata, purchase instructions and AI output only.

This is a pre-release integration. Package publication and live provider/device
smoke testing are separate release steps; building this plugin does not register
an OAuth client, enable a purchase rail, or configure an app link.

## Native setup

Add the Rust crate and the JS package `@free2z/tauri-plugin-f2z-api` to your Tauri
2.5+ app. Use a registered **public** client ID, never a client secret:

```rust,ignore
use tauri_plugin_f2z::{Builder, MobileRedirects, f2z_sdk::Config};

let plugin = Builder::new(
    Config::new("YOUR_REGISTERED_PUBLIC_CLIENT_ID"),
    "https://tutor.example/purchase-return",
)
.mobile_redirects(MobileRedirects {
    https: Some("https://tutor.example/oauth/callback".into()),
    private_scheme: Some("com.example.tutor:/oauth/callback".into()),
})
.build();

tauri::Builder::default().plugin(plugin);
```

The Rust builder owns the client ID, scopes and endpoints. Do not forward webview
input into it. `Config` uses Free2Z production defaults; local test endpoints
also belong exclusively in Rust. Desktop sign-in opens the system browser and
binds an ephemeral loopback callback; register the SDK's loopback callback path
for the client. The checkout return above must be registered HTTPS, without a
query, fragment or user information. Its page is a navigation destination, never
proof that a purchase was credited.

The plugin defaults to the trusted window label `main`. `Builder::windows`
can explicitly select other labels. Grant only necessary commands in a Tauri
capability with **local content only**:

```json
{
  "identifier": "tutor-free2z",
  "windows": ["main"],
  "permissions": [
    "f2z:allow-session", "f2z:allow-sign-in", "f2z:allow-sign-out",
    "f2z:allow-balance", "f2z:allow-grant", "f2z:allow-models", "f2z:allow-estimate",
    "f2z:allow-create-purchase", "f2z:allow-purchase",
    "f2z:allow-wait-for-purchase", "f2z:allow-open-checkout",
    "f2z:allow-start-chat", "f2z:allow-next-chat", "f2z:allow-cancel-chat",
    "f2z:allow-call", "f2z:allow-wait-for-call"
  ]
}
```

`f2z:default` grants nothing. Never give these permissions to remote pages or a
window containing untrusted frames. Render generated text as text or sanitized
markup; tool calls and model output are untrusted app input. The plugin exposes
no arbitrary HTTP request, bearer-token getter, callback injection or endpoint
configuration command.

## Platform registration

- **macOS, Windows, Linux:** register a loopback redirect such as
  `http://127.0.0.1:0/callback` according to the SDK client registration
  contract (ephemeral port permitted). The browser never enters the webview.
- **iOS 17.4+:** the associated HTTPS redirect uses
  `ASWebAuthenticationSession.Callback.https`. Configure the app's Associated
  Domains entitlement and the site's Apple association file for the registered
  callback. For earlier iOS versions, register the reverse-domain private scheme
  in `CFBundleURLTypes` and with Free2Z. Keep the HTTPS and fallback registration
  consistent with `MobileRedirects`. The app must include both schemes if both
  generations of iOS are supported.
- **Android:** use a verified HTTPS app link with an `autoVerify` intent filter
  and matching `assetlinks.json`, plus the configured private-scheme intent
  filter as a fallback. The main activity must deliver new intents to Tauri
  (`singleTask`, as in its generated app). Android 12+ selects HTTPS only when
  the OS reports the domain verified; older versions use the private scheme.
  The authorization page opens in a Custom Tab. Returning without a callback
  cancels the attempt. Callback origin/path and the unique state must match;
  the Rust core also validates issuer, PKCE exchange and ID-token claims.

No mobile authorization URL, code, state, token or verifier is sent to JavaScript.
Native callbacks are single-attempt and expire; cancelling a stale attempt
cannot close a newer attempt. Android needs SDK 36 to compile and API 29+ to run;
the Swift package supports iOS 14+ with the private-scheme fallback.

## Token storage

Refresh credentials use macOS/iOS Keychain, Windows Credential Manager,
Android Keystore-backed encrypted storage or Linux Secret Service. Initialization
and access happen on the SDK's blocking storage worker. Locked/unavailable OS
storage reports `storage_unavailable`; it does not silently switch to plaintext
or ephemeral storage. Apps that deliberately need an ephemeral session can
supply `Builder::token_store(Arc::new(f2z_sdk::MemoryStore::new()))` and display
`session.persistence === 'memory_only'`. Access tokens remain in Rust memory.

## Guest API and recovery

```ts
import { nativeBridge as f2z } from '@free2z/tauri-plugin-f2z-api';

await f2z.signIn();
const balance = await f2z.balance();
const available = BigInt(balance.available_milli_2z);

const operation = {
  operationId: crypto.randomUUID(),
  idempotencyKey: crypto.randomUUID(),
};
// Persist operation and request in your app BEFORE invoking the native command.
const opened = await f2z.startChat({
  model: 'YOUR_ENABLED_CATALOGUE_MODEL',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Explain fractions' }] }],
  max_output_tokens: '512',
}, operation);
if (opened.replay) {
  // A receipt reconciliation; the original generated answer is not replayed.
  console.log(opened.replay.charge);
} else {
  for (;;) {
    const event = await f2z.nextChat(operation.operationId);
    if (event === null) break;
    // Store the meta call_id, append deltas, and interpret terminal charge.
  }
}
```

All unsigned integers in native response DTOs are canonical decimal strings,
including prices, balances, usage counts and nested purchase quantities. Never
convert money through `Number`. `max_output_tokens`, purchase `quantity2z` and
sign-in `maxAge` also use canonical strings. Tool parameters remain ordinary
JSON, not a special integer codec. Opaque tool-call arguments remain JSON text.

Persist purchase idempotency keys before `createPurchase` as well. Re-send the
same request/key after an ambiguous outcome; do not create a new key merely
because IPC or the network failed. The bridge disables core retries that would
create a new chat key; same-key transport retries remain safe. Structured errors
carry recovery keys/call IDs when known and omit raw transport/storage/provider
messages. `retryable` never means that an ambiguous billable call can safely be
replaced with a new one.

Use `openCheckout(purchaseId)` to open a server-supplied HTTPS card checkout in
the native browser; JavaScript receives no checkout URL. Zcash `rail_data`
includes address, ZIP-321 URI, exact zatoshi amount, rate, confirmation and
payment details for a QR/instructions UI. Validate any external wallet navigation
in the consuming app. `waitForPurchase` polls authoritative server state;
redirects are not receipts. Poll timeouts are bounded to five minutes.

Chat delivery permits eight registered operations, one outstanding reader per
operation and a 1 MiB request/event limit. There is no background IPC event queue.
An idle operation expires after two minutes (checked at least every 15 seconds).
Cancel/window-close/account-change stops native delivery and releases resources;
it does **not** imply server generation or billing stopped. Reconcile with
`call` / `waitForCall`, or re-send the saved key when no call ID arrived. A final
`charge.state` is `charged` or `released`; `pending` means keep reconciling.
Never display a provisional `charged_2z` as a receipt.

Native sign-in cancellation is handled by the system browser UI, its deadline,
or `signOut`; there is no guest `AbortSignal` sign-in contract. Merely abandoning
an IPC promise cannot undo a sign-in that already committed. Account commands
return `authentication_busy` throughout a transition. Closing the authenticating
window cancels it and clears any installation already underway before account
commands resume; this can also sign out the previous account. A stream adapter
that sends `cancelChat` before `startChat` has registered must repeat cancellation
when `startChat` resolves and discard its result.

Sign-in and sign-out invalidate existing operations. Commands also reject
results that finish under an old native session generation. Applications should
clear old account UI/drafts when session generation changes and discard any
already delivered promises from the previous UI generation.

## Verification and release

From this directory: `cargo test --locked --all-targets`, `npm ci`,
`npm run build`, `npm test`, and `npm pack --dry-run`.
From the repository root, `python3 scripts/check-f2z-sdk-mobile.py ios|android`
compiles the corresponding Rust target and real Swift/Kotlin adapter; Android
also runs callback rejection tests. Required wallet CI covers Linux/macOS/Windows
and both mobile adapters. These checks do not claim a live OS credential round
trip or real provider/browser sign-in: verify those on each shipping platform
with the consumer app's actual client registration before release.

Publish `f2z-ai-proto` and `f2z-sdk` first, then this Cargo crate and its matching JS package; keep
the Rust and guest versions aligned. No publication is performed by this build.

`nativeBridge.grant()` reads the current bearer-bound grant snapshot. It needs
`f2z:allow-grant` and `ai:invoke`. Its original `spend_cap_2z`, `account_epoch`
and `grant_generation` are decimal strings, and `enforced` must be checked
explicitly; the optional `enforcement_reason` only explains it. Server grant generation is not local session generation or a cap
version. See [the grant contract](../../../docs/free2z/sdk/spec/grant.md).
