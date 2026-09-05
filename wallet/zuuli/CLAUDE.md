# ZUULI — Agent instructions

**ZUULI, by 2Z Inc**, is the **wallet authority**: the app that holds the master
seed and the spending keys, signs Zcash-login challenges, executes intent-bridge
payments, and issues messaging `DeviceCredential`s. It renders **no** content we
do not control — #904 phase 4 deleted the article, creator, live, AI, search,
profile and KYC surfaces (they live in `../free2z`) and #904 phase 3 moved
messaging to `../e2e2z`. The reason is #367: on Android a remote subframe
resolves as the trusted main window, so the app holding the seed must render
nothing remote. Architecture depth lives in
[`../../docs/architecture.md`](../../docs/architecture.md).

Implemented UI or source wiring is not itself production evidence; the
per-surface status and release blockers live in [`STATUS.md`](STATUS.md).

It is distinct from **`../zuuallet`**, the whitelabel *reference* wallet. Both
apps share the Zcash engine in `../plugins/tauri-plugin-zcash` (the "guts").

> **IRON RULE (trunk workflow):** local `main` is read-only — it only ever
> fast-forwards from `origin/main`. Never commit or merge to local `main`; every
> change goes through a worktree branched off `origin/main` → PR → squash-merge
> on the remote. Full rule: [`../../AGENTS.md`](../../AGENTS.md) and
> [`../../docs/PARALLEL-AGENTS.md`](../../docs/PARALLEL-AGENTS.md).

## Build / check commands

```bash
cd wallet/zuuli
npm install
npm run typecheck          # production sources via tsconfig.build.json
npm run typecheck:tests    # production and test sources
npm run build              # WASM build + production typecheck + Vite + WASM verification
ZUULI_PW_PORT=1433 npm run test # use a distinct Playwright port in parallel worktrees (default: 1432)
VITE_MOCK=1 npm run dev    # browser fixtures on :1423 (UI/demo only)
npm run dev                # real staging API on :1423; no native wallet
npm run tauri dev          # native wallet + staging API by default
npm run tauri -- ios dev   # iOS simulator/device through Xcode
npm run tauri -- ios build # unsigned/signing-configured iOS archive as applicable
npm run tauri -- android dev
npm run tauri -- android build # Android APK/AAB
npm run release:verify         # cross-platform version/build/identity contract
node scripts/verify-ci-cache-policy.mjs # release-cache trust boundaries
npm run test:store-listing # offline listing contract and read-only audit tests
```

The web dev server runs on **1423** so it never collides with zuuallet (1421).

`wallet/zuuli` has **two independent test suites**: vitest (unit) and Playwright
(`tests/*.pw.ts`, `npm run test:e2e`), and CI's `zuuli / frontend` job requires
both — `npm run test` already chains them. **Vitest passing locally does not
mean CI is green.** #822 and #803 both passed `typecheck` + the full vitest
suite locally and then failed `zuuli / frontend` on `tests/*.pw.ts`, which
assert rendered copy, after rebasing across the i18n kernel (#797) that routes
UI copy through `t(MESSAGE_KEYS...)`. Any change touching user-visible copy,
navigation, or component structure — **especially a rebase across an i18n
change** — must run `npm run test:e2e` (or `npm run verify`, which chains
typecheck → vitest → `test:e2e`) before pushing.

The generated native projects are committed in `src-tauri/gen/apple` and
`src-tauri/gen/android`; do not rerun `tauri ios init` or `tauri android init`
casually because regeneration can overwrite intentional platform settings.
The canonical application identifier is `cash.free2z.zuuli`. The iOS deployment
target is 18.0; Android uses min API 29 and target/compile API 36. Keep
`package.json`, `src-tauri/Cargo.toml`, `tauri.conf.json`, and native package
versions aligned. Keep iOS privacy strings in `src-tauri/Info.ios.plist` as the
regeneration source of truth. Never commit signing certificates, provisioning
profiles, API keys, keystores, or local SDK paths.

Signed releases follow [`docs/releasing.md`](docs/releasing.md). PR packaging
never receives store credentials; upload jobs use the protected
`zuuli-app-stores` environment and require an immutable release tag and source
SHA.

Credential-free packaging may save the shared Rust dependency caches. Protected
release jobs are restore-only: never let a job that has materialized a signing
key, certificate, profile, or service-account document save a cache. Cached
paths are limited to Cargo dependency state under `src-tauri/target` and
`~/.cargo`; never add generated native build trees, packages, frontend output,
`node_modules`, release artifacts, or runner-temporary paths. The scheduled
packaging canary deliberately skips Rust caches to retain clean-build evidence.

`cash.free2z.zuuli` replaces the unreleased `com.2zinc.zuuli` identifier.
The Zcash plugin migrates reachable legacy application data before wallet state
initialization. It removes only a proven-empty canonical directory. When both
trees contain data it opens canonical state, preserves legacy state byte-for-byte,
and surfaces an explicit import-pending diagnostic; it never implicitly merges,
deletes, or quarantines either populated identity. Preserve the atomic cutover
and mobile sandbox constraints documented in
[`docs/app-data-identifier-migration.md`](docs/app-data-identifier-migration.md);
never merge two identity directories or add an insecure mobile import path.

## Stack

- React 18 + TypeScript 5 + Vite 6
- TailwindCSS 3 + shadcn/ui (Radix primitives + CVA), dark-first, violet primary
- react-router-dom 6 (routing), Zustand 5 (state)
- @tauri-apps/api 2 (IPC), Tauri v2 backend
- qrcode.react, sonner (toasts), lucide-react. **No Markdown, Mermaid,
  remark/rehype or RealtimeKit dependency** — they left with their surfaces in
  #904 phase 4, and `scripts/csp-policy.mjs` pins the CSP that assumes it.

## Runtime selection — two independent boundaries

The API and wallet contracts have real implementations plus fixture fallbacks,
but a plain browser is **not** itself the mock-mode switch:

- **`VITE_MOCK=1`:** normal API and wallet calls select fixtures from
  `src/lib/api/mock-data.ts` and `src/lib/wallet/mock.ts`. This is UI/demo
  evidence only, not a network-isolation guarantee: a native profile can retain
  one-shot OAuth recovery state from an earlier real run. Use a fresh plain
  browser profile plus network controls when an offline proof is required.
- **Without `VITE_MOCK=1`:** API calls are real. Development uses the Vite proxy
  and defaults to staging. Production builds default to `free2z.cash`; packaged
  Tauri uses the registered native HTTP plugin, while a non-Tauri browser build
  uses `window.fetch` and remains subject to browser-origin policy.
- **Tauri is required for a real wallet:** the wallet bridge invokes
  `tauri-plugin-zcash`. A plain browser without `VITE_MOCK=1` can exercise API
  surfaces, but it cannot exercise the wallet and is not a whole-app run.

Never describe a browser fixture, compile, package, upload, or store-listing
result as proof of a product operation.

## Architecture / conventions

- **The contract** lives in `src/lib/` and MUST stay stable — features depend on it:
  - `src/lib/api/free2z.ts` — the typed free2z surface: `{ auth, ai, articles, live, tuzi, discover, estimateTuzis }`. Distilled from `tuzi/f2z.yaml` (the OpenAPI spec). Types in `src/lib/api/types.ts`; HTTP + Knox-token auth in `src/lib/api/http.ts`. **Only `auth` and `tuzi` have callers here** after #904 phase 4; the rest is unreferenced and is kept as the shared contract rather than pruned in the same change.
  - `src/lib/wallet/bridge.ts` — the ONLY place that talks to the Zcash engine. Mirrors `tauri-plugin-zcash` commands 1:1. Never call `invoke()` from a component.
  - `src/lib/format.ts` — money/units. **1 Tuzi (2Z) = 1 US cent.** ZEC amounts are zatoshis. 2Z pricing is cost-plus, rounded up (`usdToTuzis`).
  - `src/store/session.ts` (auth + live 2Z balance), `src/store/wallet.ts` (wallet state).
- **Features** live in `src/features/<name>/` and are self-contained. Each exports
  `export default function <Name>Feature()` from its `index.tsx` and owns its own
  sub-routes. A feature imports ONLY from the contract, `@/components/ui/*`,
  `@/components/common/*`, and `@/hooks/*`. Features never edit shared files.
- Routing: `src/App.tsx` mounts `/login` full-screen (auth) and everything else
  inside `AppShell` (sidebar + topbar with the ZEC + 2Z balance chips). The
  mounted set is exactly `src/lib/routes.ts`: `/`, `/login`, `/about`,
  `/wallet/*` and the legacy `/buy` redirect. **A navigation entry must point at
  a route this app mounts** — `navigation.test.ts` pins the two together,
  because a stale link is a runtime NotFound that typecheck cannot see (#920).
- Path alias `@/` → `src/`.

## Adding a feature

1. Create `src/features/<name>/index.tsx` exporting `default function <Name>Feature()`.
2. Add a `<Route path="/<name>/*" element={<Feature/>}>` in `src/App.tsx`.
3. Add a nav entry in `src/components/layout/Sidebar.tsx` if it should appear.

## Design rules

- Dark-only, on a true neutral graphite ground. Semantic tokens only — never a
  raw palette step (`emerald-400`, `amber-500`) and never a hex literal:
  `bg-background`, `bg-card`, `text-muted-foreground`, `border-border`,
  `text-success`/`text-warning`/`text-info`, plus `zec` (Zcash gold), `live`
  and `tuzi`. Radius `rounded-xl`.
- Violet is **interaction only** — focus ring, the primary action, links
  (`text-link`). Never decoration. Surfaces separate with a 1px `border-border`
  hairline and one step of lift: no glow, no gradient text, no decorative blur.
- Type is IBM Plex Sans + IBM Plex Mono, bundled in `src/fonts.css` (the Tauri
  CSP has no `font-src`, so a CDN webfont silently falls back to system UI).
  Nothing readable goes below 12px, and every uppercase micro-label is the one
  `eyebrow` class.
- Money is the signature: amounts use `.numeral` (Plex Mono, tabular figures,
  tight tracking) and identifiers use `.mono-id` (slashed zero). Digits are
  `text-foreground`; the unit beside them carries the currency colour.
- `min-tap` (44px) on icon buttons. `aria-label` on interactive elements. No
  emojis in UI chrome. Entrances via `animate-slide-up` — a short 4px settle,
  and every animation is suppressed under `prefers-reduced-motion`.
- Toasts via `import { toast } from "sonner"`. Loading via `<Skeleton>`. Empty via
  `<EmptyState>`. Status notes via `<Callout>`.
- **UI copy never truncates.** Design the layout so the words fit — wrap, reflow,
  or shorten the string; never clip it. `truncate`/`text-ellipsis` are banned
  outright (`scripts/ui-copy-truncation.node-test.mjs` fails the build).
  **Opaque identifiers** (Zcash addresses, txids, DIDs, meeting IDs) are the one
  exception: shorten them in the **middle, tail-weighted**, with
  `truncateAddress()` (`src/lib/format.ts`) — and render the result with **no
  CSS clip on top**, because a second ellipsis eats the trailing checksum a
  human verifies (use
  `break-all`). **User-authored body content** (article excerpts, bios, system
  messages) may wrap and `line-clamp` — and the element must say so with
  `data-user-content`, which is also what exempts it from the audit in
  `tests/viewport.pw.ts`. This app authors all of its own copy now, so that
  exemption should have no consumers.

## The containment contract (#904 / #367) — do not weaken

- **No remote content.** No Markdown renderer, no `<img>` with a remote `src`,
  no `AvatarImage`, no iframe, no third-party SDK. `scripts/csp-policy.mjs` is
  the per-directive contract with a written justification for every source, and
  `--self-test` proves it rejects each widening. `tests/csp-policy.pw.ts` proves
  a browser enforces it, using the previous policy as the positive control.
- **No capability the app cannot use.** `src-tauri/capabilities/*.json` grants
  no `f2zmsg:*` permission (#916). The messaging plugin stays registered only
  because the enrollment trio in `src-tauri/src/messaging.rs` needs its engine,
  and those three cannot leave: enrollment is the one messaging operation that
  needs the seed. They are app-crate commands, so `generate_handler!` routes
  them with **no** capability ACL — that is written down at the call site, and
  #905 moves them behind the intent authority.

## Backend follow-ups (see repo STATUS / the free2z backend)

- `plugin:zcash|sign_challenge` powers the current transparent-address Zcash
  Signed Message login. Do not call it ZIP-304; that shielded design is a
  separate future upgrade.
- The client targets the Zcash login endpoints, but the production
  challenge/signature/session round trip still needs recorded native evidence.
- Production pricing/quote endpoints exist for ZEC top-ups; wallet spend,
  settlement, and 2Z credit do not. Track that boundary in #155.

## Social OAuth callbacks

- Desktop uses an ephemeral RFC 8252 `http://127.0.0.1` listener with a random
  path nonce. iOS/Android use exactly
  `cash.free2z.zuuli://oauth/callback` through `tauri-plugin-deep-link`.
- Never widen the mobile scheme/host/path, accept a callback without matching
  local + backend state, or weaken PKCE S256 for a mobile provider. GitHub is
  intentionally desktop/web-only until its provider path is PKCE-capable.
- Pending mobile state is crash-safe and bound to login-vs-associate plus the
  initiating Knox session digest. Every native claim/resume/cancel operation is
  also scoped to its random completion state; never reintroduce an unscoped
  cleanup that can delete a newer flow. See `docs/release/ZUULI-MOBILE-OAUTH.md`
  for signed-device verification and the claimed-HTTPS upgrade gate.
