<div align="center">

# ZUULI

**by 2Z Inc**

_Your Z. Your keys. Your universe._

A Zcash-native app for desktop and mobile: a wallet fused with the free2z
platform's AI, livestreaming, articles, and **2Z** credit economy.

</div>

---

## What ZUULI includes

- **Zcash-key sign-in integration** — the native wallet can sign a free2z
  challenge with its transparent login key, without an email or password.
- **A native Zcash wallet** — create/restore, sync, send, receive, and history
  surfaces backed by `librustzcash` through `tauri-plugin-zcash` (the same
  engine as the `zuuallet` reference wallet).
- **AI Studio** — model and personality selection through free2z's metered
  conversation API, with the authoritative 2Z balance refreshed after a turn.
- **Livestreaming surfaces** — public discovery and RealtimeKit room UI, with
  authenticated broadcast, subscriber, PPV, and private-stream contracts.
- **Articles surfaces** — public feed/reader plus authenticated authoring,
  comments, and tips.
- **The 2Z economy** — 2Z balances, creator tips, memberships, Activity, and
  top-up surfaces. Card checkout and ZEC settlement are still incomplete.

These are implemented surfaces, not a claim that every production path has
passed. The source-and-runtime evidence, release blockers, and issue links live
in [STATUS.md](STATUS.md). Mock-mode flows are demo evidence only.

## The 2Z (Tuzi)

ZUULI represents free2z platform credits as integer 2Z (Tuzis). Production
pricing and quote endpoints provide the authoritative current card/ZEC quote;
individual charging and settlement paths remain subject to the evidence and
gaps in [STATUS.md](STATUS.md).

## Run it

```bash
npm install
VITE_MOCK=1 npm run dev  # browser fixtures for UI exploration/screenshots
npm run dev              # real staging API through Vite; no native wallet
npm run tauri dev        # native wallet + staging API by default
npm run tauri -- ios dev
npm run tauri -- android dev
```

Mock selection is explicit: set `VITE_MOCK=1` to use normal API and wallet
fixtures. It does not erase persisted native OAuth recovery state or guarantee
network isolation; use a fresh plain-browser profile plus network controls for
an offline proof. Without the flag, the API layer is real-first. Development
defaults to `stage.free2z.cash`; production bundles default to `free2z.cash`.
The real wallet bridge requires a Tauri shell, so a plain real-first browser run
is not an end-to-end wallet run.

Card checkout permits `https://checkout.stripe.com` by default. If Stripe
Custom Domains is enabled for the account, add its exact DNS name at build time
with `VITE_STRIPE_CHECKOUT_HOSTS=pay.example.com` (comma-separated for more than
one). Do not include a scheme, path, port, userinfo, suffix wildcard, or a domain
that is not configured in Stripe. This is an outbound-URL safety policy, not
evidence that native checkout and settlement work end to end; see
[STATUS.md](STATUS.md).

The committed native projects live under `src-tauri/gen/apple` and
`src-tauri/gen/android`. ZUULI uses application identifier
`cash.free2z.zuuli`, targets iOS 18+, and supports Android API 29+ while
compiling against API 36. Mobile builds require the corresponding Xcode or
Android SDK/NDK toolchain; signing credentials stay outside the repository.
The immutable package train, protected store upload, credential contract, and
physical-device checklist live in [the release runbook](docs/releasing.md).
This identifier replaces the unreleased development identifier
`com.2zinc.zuuli`. Existing development data is handled by the fail-closed
[identifier migration](docs/app-data-identifier-migration.md); never treat an
identifier cutover as deletion, manually discard the legacy directory, or mix
the two identities.

## How it's built

React 18 · TypeScript · Vite · Tailwind · shadcn/ui · Tauri v2 · Zustand.
The first-party Rust-to-browser build proof, measurements, generated-artifact
contract, and recommendation are documented in [the WASM spike](docs/wasm-spike.md).
See [CLAUDE.md](./CLAUDE.md) for architecture and the shared `src/lib/` contract.

Part of [the ZUU](../../README.md) — the Zcash User Universe.
