# free2z — the content surface

`cash.free2z.free2z`. One of the three apps ZUULI is being split into (#904),
scaffolded by #906. **Boilerplate only: no feature code has moved here yet.**

| App | Role | Privileged plugins |
| --- | --- | --- |
| `cash.free2z.zuuli` | wallet authority | `zcash` |
| **`cash.free2z.free2z`** | **content — articles, live, AI, creator, search** | **none** |
| `cash.free2z.e2e2z` | messaging | `f2zmsg` |

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
  wallet applications in either direction.
* `rust_fmt` / `rust_clippy` / `rust_deny` — crate discovery, not a list, so
  `src-tauri` is gated from its first commit.

## The CSP, and what will be relaxed

`src-tauri/tauri.conf.json` ships a **closed** policy today:

```
default-src 'self'; img-src 'self' data: blob:; media-src 'self';
frame-src 'none'; connect-src 'self' https://free2z.cash https://*.free2z.cash;
style-src 'self' 'unsafe-inline'; script-src 'self'
```

It starts closed because nothing here renders remote content yet. When the
content features move in, this is what has to open, and why:

* `frame-src` — article embeds. `'none'` works in ZUULI today precisely because
  the feature was given up; the whole point of this app is that it does not have
  to be.
* `connect-src` / `media-src` / `img-src` — the Cloudflare RealtimeKit
  livestream SDK (`api.realtime.cloudflare.com`, `*-silos`, `da-collector`,
  `location*`, `rtk-assets`, `wss://socket-edge`) plus `https:` images and
  media. #816/#818 are what happens when that list is one entry short: the
  packaged CSP blocked RealtimeKit's first request and Join Free broke.
* `script-src` — whatever the embed SDKs require.

Relaxing it is a reviewed change to this file, and it stays *only* a CSP change:
it must never be accompanied by a capability or a plugin. `e2e2z` and ZUULI keep
`frame-src 'none'`, and `surface-capability-authority.mjs` asserts that for
`e2e2z`.

## No `vite.config.ts`, on purpose

`vite build` runs on its defaults — `index.html` at the project root, `dist/`
out, esbuild reading `jsx: "react-jsx"` from `tsconfig.json`.

The reason is mechanical. `project-boundary.mjs` runs a real production Rollup
build of every project that ships a Vite config, inside a Node permission
sandbox whose read authority is this project, `wallet/shared` and
`wallet/zuuli/node_modules` — so it needs *this* project's `node_modules`. The
required `frontend` job that runs it installs zuuli's and zuuallet's, and its
step list is byte-pinned by `scripts/check-github-actions-pins.mjs`, so a third
`npm ci` cannot be added to it without editing a policy checker. Shipping no
config leaves nothing for a configuration audit to judge and keeps that gated
check honest. Every source file here is still parsed and still held to the
cross-application import rule. See the comment on `viteBuildsVerified` in
`wallet/zuuli/scripts/project-boundary.node-test.mjs`.

## Commands

```bash
npm ci
npm run typecheck && npm run typecheck:tests
npm test
npm run build
cargo check --locked --all-targets --manifest-path src-tauri/Cargo.toml
```

CI: `.github/workflows/wallet-surfaces.yml` (advisory build coverage) plus the
required `gate` in `.github/workflows/zuuli.yml`, whose change detector selects
`wallet/free2z/*`.

The app icon is a placeholder. Branded assets come with the surface extraction.
