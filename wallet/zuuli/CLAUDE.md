# ZUULI — Agent instructions

## Build / check commands

```bash
cd wallet/zuuli

# Install dependencies
npm install

# TypeScript type check (no emit)
npx tsc --noEmit

# Dev mode (frontend + Tauri backend)
npm run tauri dev

# Production build
npm run tauri build
```

## Stack

- React 18 + ReactDOM 18
- TypeScript 5
- TailwindCSS 3
- Zustand 5 (state management)
- Vite 6 (bundler)
- qr-scanner 1.4 (camera QR code scanning)
- qrcode.react 4.2 (QR code rendering)
- @tauri-apps/api 2 (IPC with Rust backend)

## Conventions

- **All API calls** go through `src/lib/tauri.ts`. Never call `invoke()` directly from components.
- **TypeScript types** mirror Rust serde models in `src/types/index.ts`. Both use camelCase field names.
- **Pages** use `useWalletStore().setPage(...)` for navigation (no router library).
- **Page type** is a union: `"welcome" | "create" | "restore" | "home" | "send" | "receive" | "history" | "settings" | "wallet-picker"`.

## Adding a new page

1. Add the page name to the `Page` union type in `src/types/index.ts`.
2. Create the component in `src/pages/YourPage.tsx`.
3. Add a `case "your-page":` in the `renderPage()` switch in `src/App.tsx`.
4. Add a NavBar entry in `src/components/NavBar.tsx` if it should appear in navigation.
5. If it's a setup page (no nav), add it to the `showNav` exclusion list in `App.tsx`.

## Adding a new API call

1. Add the TypeScript function to `src/lib/tauri.ts` following the existing pattern:
   ```typescript
   export async function yourCommand(arg: string): Promise<ReturnType> {
     return invoke("plugin:zcash|your_command", { args: { arg } });
   }
   ```
2. Add matching request/response interfaces to `src/types/index.ts`.
3. Ensure the Rust command is registered in the plugin (see `tauri-plugin-zcash/CLAUDE.md`).

## Design rules

- **Backgrounds**: zinc-900 (`bg-zinc-900`) for cards, zinc-950 (`bg-zinc-950` / `bg-zuuli-bg`) for page backgrounds.
- **Accent**: purple-500 (`text-purple-500`, `bg-purple-500`, `border-purple-500`). Use `hover:bg-purple-600` for hover states.
- **No emojis** in the UI.
- **Touch targets**: Always use the `min-tap` class on buttons and interactive elements (44px minimum).
- **Accessibility**: Add `aria-label` to all buttons, links, and interactive elements. Use semantic HTML (`<nav>`, `<main>`, `<button>`, etc.).
- **Error display**: Use `useWalletStore().setError(message)` — the global error banner in `App.tsx` handles display.

## State management

- Single Zustand store in `src/store/wallet.ts`.
- No React context — everything goes through the store.
- For non-React access (e.g., in utility functions): `useWalletStore.getState()`.
- Store holds: current page, wallet status, balance, sync status, transactions, seed phrase, lightwalletd URL, unified address, error.
- `resetWalletState()` clears wallet-specific state when switching wallets.

## Key hooks

- **`useWallet`** — checks wallet status on mount, handles navigation to welcome/home based on initialization state.
- **`useSync`** — starts/stops sync, listens to `zcash://sync-progress` Tauri events, updates store.
- **`useBalance`** — polls `get_account_balance` and `get_unified_address`, updates store.

## Tauri events

- `zcash://sync-progress` — emitted by the Rust sync task. Payload: `SyncStatus { syncing, syncedHeight, chainTip, progressPercent }`. Listened to in `useSync` hook.
