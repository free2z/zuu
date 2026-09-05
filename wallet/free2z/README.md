# free2z — the content surface

`cash.free2z.free2z`. One of the three apps ZUULI is being split into (#904),
scaffolded by #906. **Phase 1 of the extraction has landed: Articles, the
Markdown/media pipeline, Creator profiles and a login that keeps password and
linked accounts now live here**, and since #918 the native layer under them is
wired: it runs packaged, not only in a browser and under `vite dev`.

| App | Role | Privileged plugins |
| --- | --- | --- |
| `cash.free2z.zuuli` | wallet authority | `zcash` |
| **`cash.free2z.free2z`** | **content — articles, live, AI, creator, search** | **none** |
| `cash.free2z.e2e2z` | messaging | `f2zmsg` |

## The native layer

**This app is functional as a packaged Tauri build.** `bundle.active` is `true`
again in `src-tauri/tauri.conf.json`, which #912 had set to `false` on purpose so
nobody could emit an installer for a binary with a dead network layer. #918 is
the work that earned the flag back. What follows is what it did, and — more
importantly — where the evidence for each claim comes from, because #918 exists
precisely because "green" was measured where the bug could not appear.

### 1. HTTP: a URL-scoped native client

`src-tauri/Cargo.toml` links `tauri-plugin-http`, `src-tauri/src/lib.rs` calls
`.plugin(tauri_plugin_http::init())`, and both capability files carry a **scoped**
`http:default`. Every API request (`src/lib/api/http.ts`) and every first-party
image download (`src/components/common/RemoteMedia.tsx`) takes that path in a
packaged build; in a browser and under `vite dev` they still use `window.fetch`
through the proxy, unchanged.

The scope admits four origins and nothing else:

| Origin | Why |
| --- | --- |
| `https://free2z.cash/*` | production API and `/uploadz` media |
| `https://*.free2z.cash/*` | `stage.` / `new.` / `test.`, the deployments this client is pointed at |
| `https://free2z.com/*` | the `.com` apex, which `connect-src` already admits |
| `https://*.free2z.com/*` | its subdomains, same reason |

Narrower than the app's `connect-src`: the three RealtimeKit origins are **not**
here, because the Live SDK talks from the webview with `window.fetch` and a
WebSocket, not through this client. `surface-capability-authority.mjs` refuses
any allowed origin the CSP does not already admit, so the native client can never
reach further than the document.

Two things are worth being exact about, because the issue text was not:

* `http:default` is **not** an unrestricted client. It is `allow-fetch` with an
  **empty** allow list, and `Scope::is_allowed` requires *some* allow entry to
  match — so a bare `http:default` denies every `http`/`https` URL. It is refused
  anyway: what is reviewable is *which origins this client may reach*, and the
  identifier alone says nothing about that.
* The scope is matched with **URLPattern**, not globs, so the hostname is a
  component match rather than a substring of the URL text.
  `https://evil.example/free2z.cash/api/` does not match `https://*.free2z.cash/*`.
  `tests/http_scope.rs` asserts that, along with userinfo confusion, suffix
  confusion, plaintext `http:`, loopback and a cloud metadata endpoint.

The client is also **stateless**: `tauri-plugin-http` is taken with
`default-features = false`, which drops `cookies` from its default set. The
default build installs a process-wide `reqwest` cookie jar shared by every
request the binary makes; that would make the native client an ambient-authority
one, and under #367 a hostile subframe could ride the jar against free2z.cash and
read the answer with no CORS in the way. free2z authenticates with a Knox token
in an `Authorization` header and needs no jar.

### 2. OAuth: the native transport was deleted, not ported

The ten `oauth_*` commands were **not** brought over, and this was the decision
with the most in it.

`oauth_loopback_wait`, `oauth_mobile_claim` and `oauth_mobile_resume` each
**return an authorization code — and, on mobile, the PKCE verifier minted for
it — to the renderer**. That pair is a sign-in credential: anything holding it
can finish the exchange and take the account. Registering them here would put
that credential behind an `invoke()` in the one process that renders third-party
markup, remote media and a livestream SDK, and #367 is the defect that makes
"which frame asked" undecidable — Wry injects the bridge into every frame and its
Android IPC reports the top-level URL, so a remote subframe resolves as the
trusted main window. A capability file cannot separate the two: it scopes by
window label, and there is one label.

So `src/lib/oauth/transport.ts` now has exactly one transport, the same-origin
web popup, and **no `invoke()` at all**. In a packaged shell
`oauthCallbackTransport()` returns `"unavailable"` — the document origin is
`tauri://localhost`, which is not a registered redirect URI at any provider —
and three things follow:

* `auth.socialProviders()` answers all-unconfigured **without asking the
  backend**, so the login screen shows its empty state instead of a button whose
  only outcome is an error toast.
* `captureOAuthCode()` refuses before opening a popup, for any caller that
  reaches the API directly.
* `recoverMobileOAuth()` resolves `null`. `App.tsx` still calls it on mount, and
  that is now correct: "nothing to finish". Before, it invoked
  `oauth_mobile_pending` into an empty handler, so a packaged build greeted every
  launch with `Couldn't finish sign-in` before the user touched anything.

Password sign-in and already-linked accounts are unaffected. Social sign-in in a
packaged build comes back as a wallet-authority bridge grant (#905), not as an
invoke handler here.

### 3. The deep-link scheme is this app's own

`src/lib/oauth/protocol.ts` and `src/lib/checkout/native-return.ts` named
**ZUULI's** URIs, ported verbatim. On a device carrying both apps, an OAuth code
or a Stripe checkout return initiated by the *content* app would have been
delivered by the OS to the *wallet-authority* app. Both now use
`cash.free2z.free2z://`, `parseCheckoutReturnUrl` **refuses** the wallet's
scheme, and `src-tauri/tauri.conf.json` registers three routes:

| Route | State |
| --- | --- |
| `cash.free2z.free2z://bridge/return` | scaffolded for the intent bridge (#911) |
| `cash.free2z.free2z://oauth/callback` | declared; nothing consumes it (there is no native OAuth transport) |
| `cash.free2z.free2z://checkout/return` | declared; nothing consumes it (`/fund` is a placeholder) |

`checkoutReturnMode()` returns `"web"` unconditionally, and the reason is a
backend one: `zuuli_mobile` is a **wire** value that makes free2z issue a return
URI in the *wallet's* scheme. There is no `free2z_*` return mode server-side yet,
so asking for a native return from here would post a payer's claim code to a
different application. That, and the funding port itself, is #904's remaining
work — not something this app can fix client-side.

### What now catches this class of bug

`wallet/zuuli/scripts/surface-capability-authority.mjs` runs inside the required
`gate` (via ZUULI's `npm test`) and now also compares the two halves of the
JS→native contract, off the files:

* every `@tauri-apps/plugin-*` in `package.json` has its crate in
  `src-tauri/Cargo.toml` **and** a `.plugin(...::init())` call in the builder;
* every `invoke("literal")` in production `src/` names a command this binary
  registers, or a `plugin:<x>|…` whose crate is linked;
* a surface that registers **no** command — free2z — may not hold an
  `invoke_handler` and may not so much as import `@tauri-apps/api/core`;
* every `cash.free2z.*://host/path` literal in the tree uses **this** app's
  scheme and names a route this app's manifest registers;
* an `http` grant must be a scoped object whose every origin the app's own
  `connect-src` already admits — a bare `http:default` fails.

Each rule has a negative-control case in
`surface-capability-authority.node-test.mjs`, and an empty source population is a
blindness failure rather than a pass.

### The evidence, and its limits

`src-tauri/tests/http_scope.rs` builds a real Tauri app from this crate's real
`tauri.conf.json` and real `capabilities/*.json` — `generate_context!()` embeds
the resolved ACL — registers `tauri-plugin-http` exactly as `lib.rs` does, and
drives `plugin:http|fetch` over the IPC path a webview uses. `fetch` builds the
request and returns a resource id **without** any network I/O, so this runs
offline and in CI. Both negative controls were watched to fail:

* replace the scoped capability with a bare `http:default` →
  `url not allowed on the configured scope: https://free2z.cash/api/articles/`
* drop `.plugin(tauri_plugin_http::init())` → `plugin http not found`, which is
  exactly what a packaged build did before #918.

**What is still not proven end to end:** no automated test drives the packaged
binary against the live `free2z.cash` over the network, and the multipart
`FormData` path (`/kyc`, #927) has never run through `@tauri-apps/plugin-http` at
all — every other surface sends JSON. Reading the plugin's `fetch`, a `FormData`
body is serialized by the browser `Request` and its generated
`content-type: multipart/form-data; boundary=…` is merged in because
`src/lib/api/http.ts` deliberately sets no `Content-Type` for one, so it *should*
work; that is a reading, not a measurement. Note also that the plugin drops
`Content-Length` as a forbidden header and re-derives it, and that `Authorization`
passes through untouched.

## What has moved, and what has not

Moved: `features/articles/**`, `features/creator/**`, `features/search/**`,
`features/ai/**`, `features/live/**`, the Markdown stack (`Markdown`, `Mermaid`
+ its worker, `RemoteMedia`, `ImagePrivacySetting`, `lib/markdown/`,
`lib/media/`), the `lib/api` surface those read, `store/session`, the shared
`components/ui` set, the i18n kernel, and a shell built for this app.

Search, AI and Live arrived in #904 phase 2. None of them needed a capability, a
command, or a plugin: `src-tauri/src/lib.rs` still registers no `invoke_handler`
at all. Live did need CSP work — see **The RealtimeKit CSP** below.

Not yet moved: `features/wallet/funding`. `/fund` is a
route here today that says where 2Z top-up lives, because
`wallet/zuuli/src/features/wallet/funding/` is not HTTP+Stripe only — its
`index.tsx`, `BalanceHero`, `SendTab` and `zec-top-up-demo` read `store/wallet`,
the one thing this shell must never do. Severing the ZEC top-up path from the
card checkout is its own reviewable change; funding belongs here after it.

Nothing has been deleted from ZUULI. Stripping the markdown/embed dependency
tree out of the wallet is #904's **phase 4**, and doing it before every content
surface has moved would leave ZUULI's own Search, AI and Live routes pointing at
components that no longer exist.

## The three couplings, and what happened to each

`tests/surface-separation.pw.ts` asserts all three against the running app.

1. **Creator ZEC tip.** `features/creator/index.tsx` importing
   `createCreatorTipRouteState` from `lib/wallet/creator-tip.ts` was the only
   import crossing from social into wallet. There is no `/wallet/send` route
   here to hand a tip to, so `@/lib/bridge/creator-tip.ts` is now the **caller
   half of the intent bridge** (#790, #905): the tip dialog collects a ZEC
   amount — the product gap that made `execute-payment` unbuildable, since
   `encodeExecutePaymentPayload` refuses a non-positive amount — and the module
   builds a real request through `createIntentSession` in
   `@free2z/wallet-shared`.

   Every destination bound ZUULI applies is still applied first, so a creator
   without a usable address still fails at the renderer. The module declares
   none of the five single-implementation names `project-boundary.mjs` reserves,
   mints no `free2z/intent/v1/` label, and re-implements no encoder, version
   gate or response matcher.

   **No deep link was invented.** `@/lib/bridge/intent-transport.ts` is one
   interface with one shipped implementation, and that implementation rejects
   with a typed error naming #461. Custom-scheme links are not an authenticated
   channel, so the request is built, validated — and not sent. A txid is
   rendered only from a response that decoded, correlated to that request, named
   this family, arrived inside its window, carried status 0 and held exactly 32
   bytes.

   What the payer is told is decided in one exhaustive map,
   `features/creator/tip-copy.ts`, organised around **what this app can prove**
   rather than around success and failure. Only three outcomes may say nothing
   was sent: no transport, a request that could not be built, and an explicit
   `INTENT_NOT_CONFIRMED` from the wallet. A lost answer or an
   `INTENT_UNAVAILABLE` — which covers `BroadcastStatus::Unknown`, where a
   transaction exists locally and may or may not have been broadcast — sends the
   payer to ZUULI to look instead of reassuring them.

   What the correlation proves is that the responder saw the request.
   `docs/intent-bridge/CALLER-AUTHENTICATION.md` §5 records what it does not:
   there is **no signature over responses**, so nothing in the bytes proves
   ZUULI wrote them. That is a property of the transport, which is #461.
2. **Login with Zcash.** Password and linked accounts work. The Zcash method is
   absent rather than stubbed behind a button that cannot work, and the login
   screen says so. Signing a login challenge is an attestation, not a spend —
   which is exactly why it looks like the easy first grant to bridge and is not:
   of the three grants in #904, `sign-challenge` is the **weakest** family for
   native confirmation, because a challenge is an opaque nonce that confirms
   nothing to the person approving it. It is deliberately not first.
3. **The shell.** `TopBar` has no ZEC chip, `AppShell` renders no
   `LegacyWalletNotice`, and `App` bootstraps a session and nothing else. There
   is no `store/wallet` on this surface and no `lib/wallet` directory at all.

## What makes this surface safe

Not its CSP. **Its dependency list.**

`src-tauri/Cargo.toml` links neither `tauri-plugin-zcash` nor
`tauri-plugin-f2zmsg`, `src-tauri/capabilities/*.json` contain no `zcash:*` and
no `f2zmsg:*` entry, and `src-tauri/src/lib.rs` registers **no `invoke_handler`
at all** — #918 added `tauri-plugin-http` and still did not add one, because the
`oauth_*` commands it would have carried hand a sign-in credential back to the
renderer. That is deliberate and load-bearing: Wry injects
Tauri's bridge scripts into *every* frame and its Android IPC reports the
top-level URL rather than the requesting frame (#367), so a remote subframe in
this process resolves as the trusted main window. The only durable answer is
that there is no privileged command in this process for it to reach.

Three things enforce it, all inside the required `gate`:

* `wallet/zuuli/scripts/surface-capability-authority.mjs` — the contract test.
  It enumerates every capability file off the filesystem (so a new one cannot
  escape by being added), rejects any `zcash:*`/`f2zmsg:*` identifier including
  one hidden in a scoped object entry, and rejects linking either plugin. Since
  #918 it also refuses an unscoped `http` grant, an `invoke_handler` or an
  `@tauri-apps/api/core` import on this surface, a JS plugin package with no
  crate behind it, and any `cash.free2z.*://` URI that is not this app's own —
  see **What now catches this class of bug** above.
* `wallet/zuuli/scripts/project-boundary.mjs` — no import may cross between
  wallet applications in either direction, and it now also builds this project's
  real production Rollup graph inside the constrained audit sandbox.
* `rust_fmt` / `rust_clippy` / `rust_deny` — crate discovery, not a list, so
  `src-tauri` is gated from its first commit.

## The CSP, and what is still closed

```
default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' https:;
frame-src 'none'; connect-src 'self' https://free2z.cash https://*.free2z.cash
https://free2z.com https://*.free2z.com https://api.realtime.cloudflare.com
https://rtk-assets.realtime.cloudflare.com
wss://socket-edge.realtime.cloudflare.com; style-src 'self' 'unsafe-inline';
script-src 'self'
```

`img-src`/`media-src` opened to `https:` because `RemoteMedia` now renders
creator images, audio and video here — every one of them behind one-item
destination consent, which is what `tests/remote-media-consent.pw.ts` proves.

`frame-src` is still `'none'`, on purpose. `Markdown` keeps ZUULI's
`isTauri()` branch: a packaged build opens a YouTube/Vimeo embed in the OS
browser instead of framing it. Flipping that branch is the reviewed change this
app exists to make — and it is a *product* change with its own test surface, not
a side effect of moving a file. `frame-src` opens with it, not before.

Relaxing this stays *only* a CSP change: it must never be accompanied by a
capability or a plugin.

## The RealtimeKit CSP

Live brings a large third-party runtime, and #816 is the proof that getting its
CSP wrong is not a theoretical risk: ZUULI's packaged policy blocked the SDK's
very first request and "Join Free" failed with `ERR0001` in founder QA. So the
three admitted origins are the ones this app can actually reach, each justified
in `tests/realtimekit-csp.pw.ts`, which loads the *real* packaged policy and the
*real* bundled SDK:

| Origin | Why |
| --- | --- |
| `https://api.realtime.cloudflare.com` | `RealtimeKitClient.init()`'s first call, `/v2/internals/participant-details`. The negative-control test removes it and reproduces `ERR0001` exactly. |
| `wss://socket-edge.realtime.cloudflare.com` | The meeting transport. `SocketService.getSocketEdgeDomain()` composes `socket-edge.${baseURI}`. |
| `https://rtk-assets.realtime.cloudflare.com` | `fetchEmojis()` in `@cloudflare/realtimekit-ui` loads the reactions catalog for `<RtkMeeting>`, with no `try`/`catch` around it. |

This is **narrower than ZUULI's list**, and the refusals are asserted, not just
omitted. `location` / `location-legacy` are a callstats **IP-address** lookup;
`da-collector` and `api-silos` are device analytics and OTel log shipping. All
four are best-effort inside a `try`/`catch` that only logs, and a content app
should not beacon a reader's IP to a third party to produce a call statistic —
the initialization test proves init reaches the server boundary with **zero**
CSP violations without them. `r2.cloudflarestorage.com` appears nowhere in the
installed dependency tree. `*.dyte.io` is dead: RealtimeKit 1.5.1 *throws*
"Dyte Base URIs are no longer supported" if the base URI contains `dyte.io`.

Three directives stay shut, and Live does not ask otherwise:

* `frame-src 'none'` — RealtimeKit renders the meeting as web components in the
  document. It uses no iframes, so the surface that renders untrusted remote
  content gains nothing by admitting them (#367).
* `script-src 'self'` — no `'wasm-unsafe-eval'`. ZUULI's came from #535
  (first-party Rust WASM); `grep -rl WebAssembly` over the three `@cloudflare`
  packages returns nothing.
* no `worker-src` — the only `new Worker("data:…")` in the SDK is inside
  `EncryptionManager`, a separate entry point this app never imports, so
  `worker-src` falls back to `default-src 'self'`.

`media-src` needed no change: video is attached via `srcObject` (a
`MediaStream`, which CSP does not govern), and every `createObjectURL` blob in
the SDK is an `<img>` source, already covered by `img-src … blob:`.

## The Vite configuration

#906 shipped this app with no `vite.config.*`, because a placeholder screen
needed none and `project-boundary.mjs` runs a real production Rollup build of
every project that ships one. That is no longer possible, and the reason is
mechanical rather than stylistic:

* `worker.format` defaults to `"iife"`, and the Mermaid worker dynamically
  imports `mermaid`. Rollup refuses to code-split an IIFE, so the build fails
  outright: *"Invalid value \"iife\" for option \"worker.format\""*.
* `mathjax-full` (via `rehype-mathjax`) reads its version through
  `eval('require')(...)` unless a global `PACKAGE_VERSION` is defined, which
  throws `require is not defined` the first time an article renders math.

So the config is load-bearing, the constrained audit builds this project for
real, and `.github/workflows/zuuli.yml`'s protected `frontend` job installs this
project's dependencies for exactly that reason — a change that also had to be
made to `scripts/check-github-actions-pins.mjs`, which byte-pins that job's step
list.

## Commands

```bash
npm ci
npm run typecheck && npm run typecheck:tests
npm test          # vitest + the UI-copy policy test + Playwright
npm run build
cargo build --locked --all-targets --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml   # incl. the real-ACL http scope test
npm run tauri -- build --bundles app              # the bundle is active again (#918)
node ../zuuli/scripts/surface-capability-authority.mjs
node --test ../zuuli/scripts/surface-capability-authority.node-test.mjs
```

`npm run dev` serves on 1425 (zuuallet owns 1421, ZUULI 1423) and proxies
`/api` and `/uploadz` to `stage.free2z.cash`; `VITE_MOCK=1` runs the whole app
against fixtures, which is what Playwright does.

CI: `.github/workflows/wallet-surfaces.yml` (advisory build coverage) plus the
required `gate` in `.github/workflows/zuuli.yml`, whose change detector selects
`wallet/free2z/*`.

The app icon is a placeholder. Branded assets come with the remaining surfaces.
