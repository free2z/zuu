# Hello AI — a Free2Z SDK consumer

A small browser app and reusable Tauri frontend: sign in/out, show exact balance
and debt, select a catalogue model, preflight a strict paid request, stream text,
stop delivery, recover settlement and report output. It imports **packages**,
not repository source. No provider key, client secret or Free2Z password belongs
in this app.

**Pre-release:** `@free2z/sdk@0.4.0` and
`@free2z/tauri-plugin-f2z-api@0.4.0` are not available from the public npm
registry (read-only checks returned 404 on 2026-11-12). The commands below are
the consumer workflow **after publication**, not evidence that installation
works today. For a source preview, follow the public
[source installation guide](../../../../docs/free2z/sdk/SOURCE-PREVIEW.md)
and install both resulting tarballs here with `npm install <sdk.tgz> <guest.tgz>`.
The checked-in manifest intentionally has registry dependencies. There is no
fabricated registry lockfile; generate and commit your app's lockfile after
those versions are available, then use `npm ci`.

## Configure your browser app

1. Install Node 22+ and copy this directory into your own project.
2. Open [Your apps](https://free2z.cash/developers/apps), sign in and create
   **Native, mobile or browser app (public)**. Register an exact HTTPS callback
   you control, for example `https://your-app.example/callback.html`. Allow
   `openid profile offline_access balance:read ai:invoke`. Never request
   `purchase:create` for a new app. Set an appropriate default budget; the
   user's consent controls the actual grant.
3. Run `npm install`. Copy `.env.example` to `.env.local`, put your public
   `client_id` and the exact callback into it. There is no client secret.
   These values are bundled publicly. Web builds that may link to payment
   can set `VITE_F2Z_ALLOW_BILLING_LINK=true`.
4. Run `npm run build`, deploy **both** `dist/index.html` and
   `dist/callback.html` plus their assets to the registered HTTPS origin,
   and open the app. Serve assets normally with no token/callback logging.
   The callback and opener must share an origin and retain `window.opener`:
   do not apply `Cross-Origin-Opener-Policy: same-origin` to this flow.
   `npm run dev` serves `http://127.0.0.1:5173`; use that only if Free2Z has
   explicitly registered/enabled that exact development callback for your app.
   The SDK's loopback allowance does not bypass server registration or CORS.
5. Press **Sign in with Free2Z** from the app. Choose a model, then press
   **Send paid request**. This can spend real 2Z. The gateway re-checks the
   balance and consented budget even after a successful preflight.

Web tokens are memory-only. Reload requires sign-in; the recovery journal is
in `sessionStorage`, separated by client ID and account subject. It contains
**the original prompt**, model, timestamp, operation/key and known call ID, so
same-body recovery survives a reload within the tab. It is not an encrypted
vault, and closing the tab can lose recovery data. Choose deliberate retention
and encrypted native storage for a production audience. Never persist tokens.
A storage failure stops a new paid send. A new sign-in/account change clears
the visible answer and quarantines other accounts' journals. Async completions
also re-check the actual subject and generation: late cancellation or sign-out
cannot overwrite a newer session, and an external native account replacement
clears old data rather than publishing its balance under the old identity.
Use Refresh account to load the newly observed account's catalogue/balance.

A cancelled or broken call can still be charged. Press **Recover last receipt /
same-key call**: with a call ID it only reads the receipt; without one it
explicitly resubmits the identical body/key under the same account, within a
conservative 23-hour window. There is no automatic paid retry. Pending means
unknown, never zero. A finalized receipt permits another explicitly requested
send; generating again is a new billable call. Free2Z does not replay old answer
text. The app automatically re-reads the balance on foreground and finalization.

**Get 2Z on Free2Z** opens `/buy-2z?client_id=…`, where Zcash is first and card
second. There is no in-app checkout, price or Zcash invoice, and no return URL.
**Manage Free2Z account** remains a separate purchase-free page for budgets.

## Use the frontend in your Tauri 2.5+ app

This directory supplies the frontend, **not a new native host or mobile signing
project**. Configure your Tauri host using the public
[plugin setup and platform registration guide](../../../plugins/tauri-plugin-f2z/README.md).
Add the versioned Rust dependency `tauri-plugin-f2z = "0.4.0"` after registry
publication (or the documented coordinated source tag during preview).
Use the same registered public client ID in `.env.local` and the native builder:

```rust,ignore
use tauri_plugin_f2z::{Builder, f2z_sdk::Config};
let plugin = Builder::new(
    Config::new("YOUR_REGISTERED_PUBLIC_CLIENT_ID"),
    "https://your-app.example/return", // registered HTTPS; legacy builder input
).build();
// Add `plugin` to your host's tauri::Builder, using one long-lived native client.
```

For desktop register `http://127.0.0.1:0/callback` (the SDK selects the actual
port). For mobile register your own HTTPS/private-scheme callbacks, configure
`MobileRedirects`, and install your associated-domain/app-link files as the
plugin guide specifies. Never copy another app's scheme or identifier.

Run `npm run build:tauri`, point the host's `frontendDist` at this `dist`, and
use a local-content-only `main` window. Grant only the plugin's session,
sign-in/out, balance, grant, models, estimate, start/next/cancel-chat, call,
report-call, open-manage-account and open-delete-account permissions. This
frontend polls via `Client.waitForCall`, so no native `wait_for_call` permission
is needed. Grant no purchase commands, arbitrary HTTP, token getter, remote
capability, frame or callback-injection command. Use a CSP with
`frame-src 'none'`, `object-src 'none'`, local scripts and only Tauri IPC
connections. Display generated text via `textContent` as this frontend does.

A **direct-download desktop** host may opt in to `f2z:allow-open-billing` and
set `VITE_F2Z_ALLOW_BILLING_LINK=true`. For Google Play and iOS outside the US
storefront, keep it **false** and grant neither billing permission; show only
Manage. See [store compliance](../../../../docs/free2z/sdk/STORE-COMPLIANCE.md)
for Apple US-storefront eligibility. Native endpoints, scopes, callback setup
and OS credential storage belong in Rust. The frontend never falls back to
FetchTransport if native IPC fails. The web callback page is unused natively.

## Validation and limits

`npm test` exercises this controller's journal ordering, exact recovery request,
account fencing, cancellation, unavailable storage and expired keys. `npm run
build` and `npm run build:tauri` typecheck and bundle the two frontend modes.
No test makes a payment or claims to test browser CORS, a native credential
store, mobile links or a live provider.

Repository verification: install dependencies in `ts/free2z/sdk` and
`wallet/plugins/tauri-plugin-f2z`, then run `npm run test:example --prefix
ts/free2z/sdk`. It packs both public packages, copies this consumer into an
isolated temporary directory, installs the tarballs, runs the tests/builds,
and compiles the real guest API against the SDK bridge types. It removes the
temporary directory and starts no servers. This is a package compatibility
check, not a registry install or complete Tauri/device build.
