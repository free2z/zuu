# ZUULI — Agent instructions

**ZUULI, by 2Z Inc**, is the flagship Zcash-native app: a cutting-edge Zcash
wallet fused with the free2z platform — AI (multi-provider, metered in 2Zs),
livestreaming (broadcast / subscriber / PPV / private), articles, and a 2Z
credit economy — with **Login with Zcash** (no password, no email, no KYC).

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
npm run typecheck          # tsc --noEmit
npm run build              # tsc && vite build
npm run dev                # vite dev server on :1423 (browser = mock mode)
npm run tauri dev          # full desktop app (real wallet)
npm run tauri -- ios dev   # iOS simulator/device through Xcode
npm run tauri -- ios build # unsigned/signing-configured iOS archive as applicable
npm run tauri -- android dev
npm run tauri -- android build # Android APK/AAB
npm run release:verify         # cross-platform version/build/identity contract
```

The web dev server runs on **1423** so it never collides with zuuallet (1421).

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

`cash.free2z.zuuli` replaces the unreleased `com.2zinc.zuuli` identifier.
The Zcash plugin migrates reachable legacy application data before wallet state
initialization. It fails closed on two wallet identities while quarantining a
canonical tree that contains only state from the pre-migration build. Preserve
the atomic cutover and mobile sandbox constraints documented in
[`docs/app-data-identifier-migration.md`](docs/app-data-identifier-migration.md);
never merge two identity directories or add an insecure mobile import path.

## Stack

- React 18 + TypeScript 5 + Vite 6
- TailwindCSS 3 + shadcn/ui (Radix primitives + CVA), dark-first, violet primary
- react-router-dom 6 (routing), Zustand 5 (state)
- @tauri-apps/api 2 (IPC), Tauri v2 backend
- react-markdown (articles + AI), qrcode.react, sonner (toasts), lucide-react

## Two runtime modes — the key architectural idea

Every data path has a real implementation AND a mock fallback, chosen at
runtime by `src/lib/platform.ts`:

- **Tauri desktop/mobile** (`isTauri()`): the wallet bridge calls the real
  `tauri-plugin-zcash` commands (librustzcash); the API layer hits the real
  free2z backend.
- **Plain browser / `VITE_MOCK=1`**: realistic fixtures (`src/lib/api/mock-data.ts`,
  `src/lib/wallet/mock.ts`) so the whole UI runs, demos, and screenshots with
  no backend and no chain sync.

This is why `npm run dev` in a browser shows a fully working app.

## Architecture / conventions

- **The contract** lives in `src/lib/` and MUST stay stable — features depend on it:
  - `src/lib/api/free2z.ts` — the typed free2z surface: `{ auth, ai, articles, live, tuzi, discover, estimateTuzis }`. Distilled from `tuzi/f2z.yaml` (the OpenAPI spec). Types in `src/lib/api/types.ts`; HTTP + Knox-token auth in `src/lib/api/http.ts`.
  - `src/lib/wallet/bridge.ts` — the ONLY place that talks to the Zcash engine. Mirrors `tauri-plugin-zcash` commands 1:1. Never call `invoke()` from a component.
  - `src/lib/format.ts` — money/units. **1 Tuzi (2Z) = 1 US cent.** ZEC amounts are zatoshis. 2Z pricing is cost-plus, rounded up (`usdToTuzis`).
  - `src/store/session.ts` (auth + live 2Z balance), `src/store/wallet.ts` (wallet state).
- **Features** live in `src/features/<name>/` and are self-contained. Each exports
  `export default function <Name>Feature()` from its `index.tsx` and owns its own
  sub-routes. A feature imports ONLY from the contract, `@/components/ui/*`,
  `@/components/common/*`, and `@/hooks/*`. Features never edit shared files.
- Routing: `src/App.tsx` mounts `/login` full-screen (auth) and everything else
  inside `AppShell` (sidebar + topbar with the ZEC + 2Z balance chips).
- Path alias `@/` → `src/`.

## Adding a feature

1. Create `src/features/<name>/index.tsx` exporting `default function <Name>Feature()`.
2. Add a `<Route path="/<name>/*" element={<Feature/>}>` in `src/App.tsx`.
3. Add a nav entry in `src/components/layout/Sidebar.tsx` if it should appear.

## Design rules

- Dark-first. Semantic tokens only: `bg-background`, `bg-card`, `text-muted-foreground`,
  `border-border`, `bg-primary`/`text-primary` (violet), plus `#f4b728` for ZEC and
  `#f43f5e` for LIVE. Radius `rounded-xl`.
- `tabular-nums` for all money. `min-tap` (44px) on icon buttons. `aria-label` on
  interactive elements. No emojis in UI chrome. Entrances via `animate-slide-up`.
- Toasts via `import { toast } from "sonner"`. Loading via `<Skeleton>`. Empty via `<EmptyState>`.

## Backend follow-ups (see repo STATUS / the free2z backend)

- `plugin:zcash|sign_challenge` powers Login with Zcash on desktop (ZIP-304).
- Real endpoints for Zcash login (`/api/auth/zcash/login/`) and pay-with-ZEC
  top-ups live in the free2z backend (`tuzi/py`). The client contract already
  targets them; mock mode stands in until they ship.

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
