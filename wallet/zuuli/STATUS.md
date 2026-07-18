# ZUULI — build status

**ZUULI by 2Z Inc** — a Zcash-native desktop app (Tauri v2 + React 18 + TS +
Vite + Tailwind + shadcn/ui). Built as the flagship atop the shared Zcash engine
(`../plugins/tauri-plugin-zcash`, aka the "zuuallet guts") and the free2z API
(`tuzi/f2z.yaml`).

This file is an honest accounting of what is **real & working**, what is
**scaffolded behind a real interface**, and what needs **backend/infra** to go
fully live.

## Verified working (built, typechecks, runs, exercised in-browser)

Full app: `tsc --noEmit` clean, `vite build` green. Every screen runs in
**mock mode** (`npm run dev` in a browser) with realistic data, and the flows
below were click-tested end-to-end:

- **Login with Zcash** — challenge → sign (wallet) → verify → session, with a
  live animated stepper. No password, no email. Lands you logged in.
- **AI Studio** — multi-provider model picker (Anthropic / OpenAI / xAI / Kimi /
  on-our-hardware Llama), markdown chat, and **live 2Z metering**: each answer is
  charged (cost-plus, rounded up) and the balance decrements in real time.
- **Livestreams + PPV** — discovery grid, Go-Live dialog, and the marquee flow:
  join a PPV stream → confirm the 2Z price → balance debited → connected room
  (meeting details, participants, live chat).
- **Wallet** — shielded balance, sync bar, unified-address QR + copy, send
  (live address validation → fee-confirm → execute), receive, history,
  create/restore onboarding with seed-phrase backup.
- **2Z economy** — buy packs (card via Stripe **and** pay-with-ZEC from the
  in-app wallet), send/tip creators, transaction activity.
- **Articles** — feed, reader with tip-the-author, and a live-preview markdown
  composer.

## Real production integration (no mocks by default)

ZUULI is **real-first**: `src/lib/api/free2z.ts` talks to the live free2z API at
**`free2z.cash`** and maps the real response shapes into stable internal types.
Verified against production: articles (zpage), livestreams (dyte), AI models,
creators all render live data. Mocks only exist behind `VITE_MOCK=1` for offline
screenshots.

Transport (`src/lib/api/http.ts`) solves the CORS problem — the free2z backend
whitelists only a few web origins, not the Tauri webview:
- **`tauri dev` / `npm run dev`:** a Vite proxy (`/api`, `/uploadz` → free2z.cash)
  keeps requests same-origin, so the browser/webview never hits CORS. **This is
  what makes the running app show real data today.**
- **Packaged `tauri build`:** routes through `@tauri-apps/plugin-http` (native
  Rust requests, not subject to browser CORS) against the absolute host.
  *(Rust registration of tauri-plugin-http for the packaged build is the one
  remaining transport wiring — dev is fully working.)*

Auth is Knox: classic login uses HTTP Basic against `/api/token/login/`; the
token rides in `Authorization: Token <key>`; `/api/auth/user/` supplies the 2Z
balance (`tuzis`).

## Login with Zcash — real, server-verifiable scheme (being implemented)

The identity is the account's **transparent P2PKH t-address**. The wallet signs
the server's challenge using the standard **Zcash Signed Message** convention
(same as zcashd `signmessage`): magic-prefixed double-SHA256, recoverable
secp256k1 sig, base64. The backend verifies with **zcashd `verifymessage`** — no
new crypto deps, leverages the node the platform already runs. (This replaces the
earlier symmetric HMAC, which could not be verified server-side — the reason
login failed.) ZIP-304 (shielded, UFVK-verifiable) is a future upgrade.

- Wallet plugin `sign_challenge` → `{ address, challenge, signature, pubkey }`.
- Backend `POST /api/auth/zcash/challenge/` + `/api/auth/zcash/login/` in
  `apps/zauth` (verify → get-or-create Creator → Knox token → `did:zcash:<addr>`).
  Deploy to prod to go live.

## Still to wire (interfaces in place)

1. **tauri-plugin-http** Rust registration for the *packaged* build (dev works
   via the Vite proxy).
2. **Full multi-model AI metering** — `/api/openai/prompt` charges a flat 1 2Z
   and ignores model choice; per-token metering runs over the
   `/api/ai/conversations/.../promptresponses/` websocket. Wire it or add a
   synchronous metered endpoint (we control the backend).
3. **Stripe checkout URL** — backend must return `session.url` (one-line add, in
   the backend PR) for the buy-with-card redirect.
4. **Pay-with-ZEC top-ups** — settle a shielded spend → credit 2Zs.
5. **Dyte Web SDK** — `live.start/join` already return real `{meeting_id,
   auth_token}`; drop the SDK into the "connected" room stage for video.
6. **Web-app parity** — the same zcash-login backs `zuu/ts/react/free2z`.

## Known mock-mode artifacts (not bugs)

- A hard browser reload re-bootstraps the mock session, resetting the 2Z balance
  to the fixture value. In-app navigation preserves state; the real backend
  persists.
- Onboarding (create/restore) only renders against an uninitialized wallet, so
  it appears on a fresh desktop wallet, not in browser mock mode.

## Run it

```bash
cd wallet/zuuli
npm install
npm run dev          # browser, mock mode — explore everything
npm run tauri dev    # real desktop wallet + real API
npm run build        # tsc && vite build (green)
```
