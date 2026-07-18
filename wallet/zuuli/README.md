<div align="center">

# ZUULI

**by 2Z Inc**

*Your Z. Your keys. Your universe.*

A Zcash-native desktop app: a cutting-edge wallet fused with the free2z
platform — AI, livestreaming, articles, and a credit economy — all metered in
**2Zs**, all shielded by default.

</div>

---

## What ZUULI does

- 🔑 **Login with Zcash** — your key is your identity. No password, no email, no
  KYC, no third party. Sign a challenge (ZIP-304), your address becomes a W3C
  DID. Associate an existing free2z account if you have one.
- 🪙 **A real Zcash wallet, right here** — create/restore, sync, send, receive,
  history. Powered by `librustzcash` via `tauri-plugin-zcash` (the same engine
  as the `zuuallet` reference wallet).
- 🤖 **AI from every provider, anonymously** — OpenAI, Anthropic, xAI, Kimi, and
  open-source models on our hardware. You go through the free2z API, so the
  provider never sees *you*. Priced cost-plus, rounded up to whole 2Zs.
- 📡 **Livestreaming** — start a broadcast, subscriber-only, PPV, or private
  stream. Discover what's live. Join a PPV stream by spending 2Zs.
- ✍️ **Articles** — read a feed, or author your own with a live markdown editor.
- 💸 **The 2Z economy** — buy 2Zs with a card *or* with ZEC from your in-app
  wallet. Donate 2Zs or ZEC to creators without ever leaving the app.

## The 2Z (Tuzi)

`1 Tuzi = 1 US cent`. Everything metered — an AI prompt, a PPV seat — is charged
at our upstream cost plus a thin margin, **rounded up** to the nearest 2Z. If a
prompt costs us `$0.0323478`, you pay `4 2Z`.

## Run it

```bash
npm install
npm run dev          # browser, mock mode — the whole app, no backend needed
npm run tauri dev    # the real desktop app with a live Zcash wallet
```

In a plain browser ZUULI runs in **mock mode** with realistic data so you can
explore every screen. Inside the Tauri shell it drives the real wallet engine
and the real free2z API.

## How it's built

React 18 · TypeScript · Vite · Tailwind · shadcn/ui · Tauri v2 · Zustand.
See [CLAUDE.md](./CLAUDE.md) for architecture and the shared `src/lib/` contract.

Part of [the ZUU](../../README.md) — the Zcash User Universe.
