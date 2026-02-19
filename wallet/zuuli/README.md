# ZUULI

A privacy-first desktop wallet for Zcash, built with Tauri v2, React, and librustzcash.

## Quick start

### Prerequisites

- [Rust](https://rustup.rs/) 1.85.1+ (edition 2024)
- [Node.js](https://nodejs.org/) 18+
- [Tauri CLI](https://tauri.app/start/): `cargo install tauri-cli`
- Git submodules initialized: `git submodule update --init --recursive` (for `z/zcash/librustzcash`)

### Development

```bash
cd wallet/zuuli
npm install
npm run tauri dev
```

This starts both the Vite dev server (port 1421) and the Tauri backend.

### Production build

```bash
cd wallet/zuuli
npm run tauri build
```

## Architecture

### Frontend

- **React 18** — component-based UI
- **TypeScript 5** — strict types mirroring Rust models
- **TailwindCSS 3** — utility-first styling
- **Zustand v5** — single global store, no React context
- **Vite 6** — dev server and bundler

### Backend

- **Tauri v2** — desktop app framework (Rust process + webview)
- **tauri-plugin-zcash** — Rust plugin wrapping librustzcash (at `wallet/plugins/tauri-plugin-zcash/`)
- **librustzcash** — forked, path deps from `z/zcash/librustzcash`

### IPC

All backend communication goes through `@tauri-apps/api/core` `invoke()` calls to plugin commands. The TypeScript API wrapper lives at `src/lib/tauri.ts`.

## Directory structure

```
wallet/zuuli/
  src/
    App.tsx              — Root component, page router, global sync start
    main.tsx             — React entry point
    pages/
      Welcome.tsx        — Landing page (create or restore)
      CreateWallet.tsx   — New wallet flow (mnemonic generation)
      RestoreWallet.tsx  — Restore from seed phrase + birthday height
      Home.tsx           — Main dashboard (balance, address, recent txs)
      Send.tsx           — Send form (propose -> review -> execute)
      Receive.tsx        — Receive page (unified address + QR code)
      History.tsx        — Transaction history with pagination
      Settings.tsx       — Seed phrase backup, viewing key, lightwalletd URL
      WalletPicker.tsx   — Multi-wallet management (create, switch, rename, delete)
    components/
      NavBar.tsx         — Bottom nav (mobile) / sidebar nav (desktop)
      BalanceDisplay.tsx — Formatted ZEC balance with pending indicators
      AddressCard.tsx    — Unified address display with copy button
      SyncBar.tsx        — Sync progress bar (listens to zcash://sync-progress events)
      QrScanner.tsx      — Camera-based QR code scanner (ZIP-321 payment URIs)
      SeedPhraseGrid.tsx — Numbered grid display for BIP-39 seed phrases
    hooks/
      useWallet.ts       — Wallet status checking, initialization flow
      useSync.ts         — Sync start/stop, progress event listener
      useBalance.ts      — Balance polling, address fetching
    store/
      wallet.ts          — Zustand store (page, walletStatus, balance, syncStatus, transactions, etc.)
    lib/
      tauri.ts           — TypeScript wrappers for all 25 plugin commands
      format.ts          — Number formatting utilities (zatoshis -> ZEC display)
    types/
      index.ts           — TypeScript interfaces matching Rust serde models
  src-tauri/
    Cargo.toml           — Tauri backend dependencies
    tauri.conf.json      — Tauri config (window size, CSP, bundle settings)
    capabilities/        — Tauri v2 capability permissions
```

## Design system

- **Background**: zinc-900 (`#18181b`) / zinc-950 (`#09090b`)
- **Accent**: purple-500 (`#a855f7`)
- **Text**: zinc-100 primary, zinc-400 secondary
- **Touch targets**: `min-tap` class for 44px minimum touch area
- **Accessibility**: ARIA labels on all interactive elements, semantic HTML

## Key flows

### Create wallet

Welcome -> CreateWallet -> (generates mnemonic, fetches chain tip birthday) -> shows seed phrase -> Home

### Restore wallet

Welcome -> RestoreWallet -> (enter seed phrase + optional birthday height) -> Home

### Send

Home -> Send -> (enter address, amount, optional memo) -> Proposing (ZIP-317 fee calculation) -> Review (amount + fee) -> Executing (prove + sign + broadcast) -> Success (txid)

### Sync

Background sync starts automatically after wallet is active. Polls every 30s for new blocks. Progress emitted via `zcash://sync-progress` Tauri events, displayed in the SyncBar.

## Configuration

- **lightwalletd URL**: Default `https://zec.rocks:443`, configurable in Settings
- **CSP**: `default-src 'self'; connect-src 'self' https://*.zec.rocks; style-src 'self' 'unsafe-inline'`
- **Window**: 1200x800 default, 360x600 minimum
- **App identifier**: `com.free2z.zuuli`
