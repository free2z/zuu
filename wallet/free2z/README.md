# free2z — the content surface

`cash.free2z.free2z`. One of the three apps ZUULI is being split into (#904),
scaffolded by #906. **Phase 1 of the extraction has landed: Articles, the
Markdown/media pipeline, Creator profiles and a login that keeps password and
linked accounts now live here** — in a browser and under `vite dev`. Read the
next section before you try to package it.

| App | Role | Privileged plugins |
| --- | --- | --- |
| `cash.free2z.zuuli` | wallet authority | `zcash` |
| **`cash.free2z.free2z`** | **content — articles, live, AI, creator, search** | **none** |
| `cash.free2z.e2e2z` | messaging | `f2zmsg` |

## Not yet wired natively

**This app runs in the browser and under `vite dev`. It is NOT functional as a
packaged Tauri app.** The frontend was ported complete, including three code
paths that branch on `isTauri() && !DEV` — and the Rust side those paths call
into was never written here. Nothing in CI can see this: vitest, Playwright and
`npm run build` all execute where `isTauri()` is `false` or `import.meta.env.DEV`
is `true`, which is exactly the condition under which none of these branches is
taken, and `cargo check` compiles a backend that is not asked whether the
frontend expects commands from it.

So `bundle.active` is `false` in `src-tauri/tauri.conf.json`. That is
deliberate: `tauri build` should not be able to emit an installer for a binary
whose network layer is dead. Flipping it back is part of the fix, not a
prerequisite for it. Tracking issue: **#918**.

The three gaps, precisely:

1. **HTTP is unwired.** `package.json` depends on `@tauri-apps/plugin-http`, but
   `src-tauri/` was never touched to match: `src-tauri/Cargo.toml` does not list
   `tauri-plugin-http`, `src-tauri/src/lib.rs` does not call
   `.plugin(tauri_plugin_http::init())`, and neither capability file grants an
   `http:*` permission. Both `src/lib/api/http.ts:129-132` and
   `src/components/common/RemoteMedia.tsx:50-51` switch to the native client
   when `isTauri() && !DEV`, so in a packaged build **every** API request and
   every first-party image download would invoke `plugin:http|fetch`, a command
   that does not exist in this binary.

   Note that this is not a one-line capability addition.
   `wallet/zuuli/scripts/surface-capability-authority.mjs:56-61` holds
   `REVIEWED_NAMESPACES = {core, deep-link, opener, f2zmsg}`, and `http` is not
   in it — adding `http:default` fails the required `gate`. By design: what a
   content surface's HTTP client may reach is a scope decision somebody has to
   review, not a default anyone can grant in passing.

2. **The OAuth commands are unwired.** `src/lib/oauth/transport.ts` invokes ten
   `oauth_*` commands (`oauth_callback_transport`, `oauth_loopback_start` /
   `_wait` / `_cancel`, `oauth_mobile_arm` / `_claim` / `_cancel` / `_pending` /
   `_resume` / `_finish`) that exist only in
   `wallet/zuuli/src-tauri/src/oauth.rs`. This app's `src-tauri/src/lib.rs` has
   no `invoke_handler` at all. `nativeTransport()` rethrows rather than falling
   back to the web flow, and `src/App.tsx:58` calls `recoverMobileOAuth()`
   unconditionally on mount behind a `.catch` that fires
   `toast.error("Couldn't finish sign-in")` (`src/App.tsx:82`) — so a packaged
   build shows a sign-in error toast on **every launch**, before the user has
   done anything.

3. **The deep-link scheme belongs to the wallet.**
   `src/lib/oauth/protocol.ts:3` uses `cash.free2z.zuuli://oauth/callback` and
   `src/lib/checkout/native-return.ts:3` uses
   `cash.free2z.zuuli://checkout/return` (with the matching guard at
   `src/lib/checkout/native-return.ts:72`). Those are **ZUULI's** URIs. This
   app's own manifest registers only `cash.free2z.free2z://bridge/return`
   (`src-tauri/tauri.conf.json`, `plugins.deep-link`). On a device with both
   apps installed, an OAuth authorization code or a Stripe checkout return
   initiated by the content app would be delivered by the OS to the **wallet
   authority** app — the cross-app URI collision this entire split exists to
   prevent.

Fixing all three is a separate reviewed PR (#918). Do not patch one of them in
isolation and re-enable the bundle.

## What has moved, and what has not

Moved: `features/articles/**`, `features/creator/**`, the Markdown stack
(`Markdown`, `Mermaid` + its worker, `RemoteMedia`, `ImagePrivacySetting`,
`lib/markdown/`, `lib/media/`), the `lib/api` surface those read, `store/session`,
the shared `components/ui` set, the i18n kernel, and a shell built for this app.

Not yet moved: `features/live` (Cloudflare RealtimeKit and its CSP hosts),
`features/ai`, `features/search`, and `features/wallet/funding`. `/fund` is a
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
   here to hand a tip to, so `@/lib/bridge/creator-tip.ts` validates and records
   the intent — the same bounds ZUULI applies, so a creator without a usable
   address still fails at the renderer — and the reader is told where the tip is
   actually signed. **No deep link was invented.** Custom-scheme links are not an
   authenticated channel; #911 shipped the versioned protocol and deliberately
   shipped no transport, because #461 is a hard prerequisite.

   It is not `createIntentSession` from `@free2z/wallet-shared` yet, and the
   file says why at length: #911's `ExecutePayment` family refuses
   `amountZatoshis <= 0`, and no tip dialog — ZUULI's included — collects a ZEC
   amount, because the amount and memo belong on the wallet's own review screen.
   This file holds the pre-request destination half only. It declares none of
   the five single-implementation names `project-boundary.mjs` reserves, mints
   no `free2z/intent/v1/` label, and re-implements no encoder, version gate or
   response matcher.
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
`tauri-plugin-f2zmsg`, and `src-tauri/capabilities/*.json` contain no `zcash:*`
and no `f2zmsg:*` entry. That is deliberate and load-bearing: Wry injects
Tauri's bridge scripts into *every* frame and its Android IPC reports the
top-level URL rather than the requesting frame (#367), so a remote subframe in
this process resolves as the trusted main window. The only durable answer is
that there is no privileged command in this process for it to reach.

Three things enforce it, all inside the required `gate`:

* `wallet/zuuli/scripts/surface-capability-authority.mjs` — the contract test.
  It enumerates every capability file off the filesystem (so a new one cannot
  escape by being added), rejects any `zcash:*`/`f2zmsg:*` identifier including
  one hidden in a scoped object entry, and rejects linking either plugin.
* `wallet/zuuli/scripts/project-boundary.mjs` — no import may cross between
  wallet applications in either direction, and it now also builds this project's
  real production Rollup graph inside the constrained audit sandbox.
* `rust_fmt` / `rust_clippy` / `rust_deny` — crate discovery, not a list, so
  `src-tauri` is gated from its first commit.

## The CSP, and what is still closed

```
default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' https:;
frame-src 'none'; connect-src 'self' https://free2z.cash https://*.free2z.cash
https://free2z.com https://*.free2z.com; style-src 'self' 'unsafe-inline';
script-src 'self'
```

`img-src`/`media-src` opened to `https:` because `RemoteMedia` now renders
creator images, audio and video here — every one of them behind one-item
destination consent, which is what `tests/remote-media-consent.pw.ts` proves.

`frame-src` is still `'none'`, on purpose. `Markdown` keeps ZUULI's
`isTauri()` branch: a packaged build opens a YouTube/Vimeo embed in the OS
browser instead of framing it. Flipping that branch is the reviewed change this
app exists to make — and it is a *product* change with its own test surface, not
a side effect of moving a file. `frame-src` opens with it, not before. Likewise
RealtimeKit's `connect-src`/`media-src` hosts (#816/#818) arrive with
`features/live`.

Relaxing this stays *only* a CSP change: it must never be accompanied by a
capability or a plugin.

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
cargo check --locked --all-targets --manifest-path src-tauri/Cargo.toml
```

`npm run dev` serves on 1425 (zuuallet owns 1421, ZUULI 1423) and proxies
`/api` and `/uploadz` to `stage.free2z.cash`; `VITE_MOCK=1` runs the whole app
against fixtures, which is what Playwright does.

CI: `.github/workflows/wallet-surfaces.yml` (advisory build coverage) plus the
required `gate` in `.github/workflows/zuuli.yml`, whose change detector selects
`wallet/free2z/*`.

The app icon is a placeholder. Branded assets come with the remaining surfaces.
