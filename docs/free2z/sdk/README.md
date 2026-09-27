# f2z-sdk v1 — Free2Z sign-in, 2Z balance and metered AI for any app

**Status:** v1 contract, draft for implementation (2026-09-26) ·
**Refs:** [#1047](https://github.com/free2z/zuu/issues/1047) (epic),
[#1048](https://github.com/free2z/zuu/issues/1048) (this document set)

This directory is the **contract** that every implementer of the platform
builds against — the identity provider, the AI gateway, the account API and
the SDKs — and it is also the public developer documentation. It is written
for a third-party developer who has no other context and no privileged access:
if something here cannot be done by a stranger with the published packages and
a registered app, that is a defect in the platform, not a limitation of the
reader.

The first integrator is a separate company building an AI tutor app with
Tauri 2 for desktop, iOS and Android. **iOS and Android are equal, first-class
targets alongside desktop and web**; nothing in this contract is desktop-first.

For application work, start with the [integration handoff](./INTEGRATION.md).
Package maintainers can use the [release verification guide](./RELEASING.md).
It separates the implemented Rust preview and mock flows from the pending
Tauri/TypeScript packages and live-platform prerequisites.

## The three capabilities

1. **Sign users in to Free2Z.** Free2Z is an OAuth 2.0 / OpenID Connect
   identity provider. An app gets a short-lived, scoped access token and a
   stable user identity; it never sees a password, a passkey or a linked
   provider's credential. Users may link Google, GitHub, Apple, X, passkeys
   and Zcash to one account, and the app does not need to know which one they
   used. → [`spec/oidc.md`](./spec/oidc.md)
2. **Show and sell 2Z.** An app can read the user's balance and start a
   purchase by card or by Zcash. (Apple and Google in-app purchase exist
   only in Free2Z's own apps in v1.) The purchase is completed and credited
   by Free2Z; the app only opens the right surface and polls for the
   result. → [`spec/purchase.md`](./spec/purchase.md)
3. **Call AI.** A low-latency streaming gateway at `https://ai.free2z.cash`
   exposes one unified chat API over several providers, metered in 2Z with
   cost-plus pricing and rounded **up** to a whole 2Z per call. A registered
   app may add its own markup, which is credited to the developer.
   → [`spec/chat-api.md`](./spec/chat-api.md), [`spec/metering.md`](./spec/metering.md)

## 2Z, in one paragraph

**2Z are platform credits.** They are not money, not a currency and not a
crypto asset; they are not transferable between users by an app, and they are
not redeemable. **1 2Z corresponds to $0.01 of usage.** A user buys 2Z with a
card, an in-app purchase or Zcash, and spends them on AI calls made through
apps they have authorized. Wherever this documentation says "price" or
"charge" it means a quantity of 2Z; wherever it says "cost" it means what a
provider bills the platform in USD, which is the input to the price and never
something a user pays directly.

### Units on the wire

Every amount of 2Z on every API in this contract is an **integer**, and the
field name says the unit — there are exactly two:

| Suffix | Unit | Used for |
|---|---|---|
| `_2z` | whole 2Z | Anything that is whole by construction: charges, holds, minimum charges, spend caps, purchase quantities, pack sizes |
| `_milli_2z` | milli-2Z (one thousandth of a 2Z) | Anything that can be fractional: balances, remaining cap, credited purchase amounts, the collected part of a charge and its shortfall, published rates (`_milli_2z_per_mtok`), the three-way split of a charge |

A field never carries a decimal, a float or a string amount, and a name
never carries an amount without its unit, so a milli-for-whole mix-up is
visible at the field name and can be caught by a type. `f2z-ai-proto`
follows the same rule (`hold_2z`, `charged_2z`, `balance_hint_milli_2z`);
SDKs format for display, the wire never does.

## Where things live

| Host | Role | Specified in |
|---|---|---|
| `https://free2z.cash` | The identity provider (issuer), the account API (balance, purchases, app grants), the developer console | [`spec/oidc.md`](./spec/oidc.md), [`spec/purchase.md`](./spec/purchase.md) |
| `https://ai.free2z.cash` | The AI gateway | [`spec/chat-api.md`](./spec/chat-api.md), [`spec/metering.md`](./spec/metering.md) |

The OIDC discovery document at
`https://free2z.cash/.well-known/openid-configuration` is normative for the
identity provider's endpoint URLs; a client MUST read it rather than hard-code
paths. The account API is rooted at `https://free2z.cash/api/sdk/v1/` and the
gateway API at `https://ai.free2z.cash/v1/`; those two roots are fixed by this
contract.

## The namespace

Everything below lives in this repository. Licences follow the existing rule
in [`rs/README.md`](../../../rs/README.md): shared crates are MIT, server
binaries are AGPL.

| Path | Package | What it is | Licence |
|---|---|---|---|
| `rs/crates/f2z-ai-proto` | `f2z-ai-proto` (crates.io) | Wire types for `/v1/chat`, the SSE event enum, the catalogue schema, error codes and `price_2z()` — the one pricing function, shared by gateway and SDK | MIT |
| `rs/crates/f2z-ai` | — (unpublished) | The gateway service behind `ai.free2z.cash` | AGPL |
| `rs/crates/f2z-ai-testkit` | — (unpublished) | Mock providers, a load harness and the ledger-contract fixtures | MIT |
| `rs/crates/f2z-sdk` | `f2z-sdk` (crates.io) | Rust SDK core: `oauth`, `keychain`, `balance`, `purchase`, `ai`. No Tauri dependency | MIT |
| `rs/crates/f2z-zec-scanner` | — (unpublished) | Receive-only (viewing-key) Zcash payment scanner | AGPL |
| `wallet/plugins/tauri-plugin-f2z` | `tauri-plugin-f2z` (crates.io) + `@free2z/tauri-plugin-f2z-api` (npm) | Tauri 2 plugin (`tauri = "2"`, from 2.5 up; peer `@tauri-apps/api ^2.5`). Tokens stay in Rust; JavaScript never sees them | MIT |
| `ts/free2z/sdk` | `@free2z/sdk` (npm) | Framework-agnostic TypeScript client. `FetchTransport` for the web, explicit `NativeTransport(nativeBridge)` inside a Tauri webview; same API on both (pre-release source preview) | MIT |
| `ts/free2z/sdk-ui` | `@free2z/sdk-ui` (npm, later) | Web components `<f2z-sign-in>`, `<f2z-balance>`, `<f2z-buy>` | MIT |
| `wallet/examples/free2z/hello-ai` | — | The reference Tauri app: sign in, buy 2Z, stream a chat | — |
| `docs/free2z/sdk/` | — | This contract (D1), later the guides (D2), reference (D3) and security/operations notes (D4) | — |
| `docs/free2z/ai-gateway/` | — | The gateway's architecture decision records | — |

Supported releases use **published packages** from crates.io and npm, never
private or workspace path dependencies. The documented public source preview
is an interim integration route, not a stable release. Pre-1.0 (`0.x`) releases follow a
strict changelog; the public surface is frozen at `1.0`. The layout is
decided in [ADR 0004](../ai-gateway/adr/0004-zuu-namespace-layout.md).

## The trust model

Who holds what, and who is trusted for what. An implementation that violates
a row here is wrong even if every test passes.

| Party | Holds | Never holds | Trusted for |
|---|---|---|---|
| **The user** | Their Free2Z credentials, the devices they signed in on | — | Deciding which apps get which scopes and how much each may spend |
| **The identity provider** (`free2z.cash`) | Credentials, linked identities, the signing keys for tokens, the record of every grant | Provider API keys (those are the gateway's) | Issuing tokens; the account epoch and grant generation that revoke them |
| **The account ledger** (behind `free2z.cash`) | Every balance and every hold | — | **The only authority on whether a 2Z can be spent** — a token is never authoritative for a balance ([ADR 0002](../ai-gateway/adr/0002-hold-functions-single-balance-authority.md)) |
| **The AI gateway** (`ai.free2z.cash`) | Provider API keys, a signed copy of the price catalogue, in-flight streams | Passwords, refresh tokens, balances (it asks the ledger, per call) | Metering a call honestly from provider-reported usage; never running tools, never fetching client-supplied URLs |
| **A registered app** | Its `client_id`; on a confidential (server-side) client, a `client_secret`; per user, an access token and a refresh token | The user's password or any linked credential; provider keys; other users' tokens | Presenting prompts on the user's behalf within the granted scopes and cap. Not trusted for prices: the app's markup is applied by the platform from the registration, never from a request |
| **The SDK on a device** | Tokens (in the Rust core, in the OS keychain where one exists; in memory on the web) | — | Keeping tokens out of the app's JavaScript (Tauri) and off disk (web) |

Consequences that follow directly:

- **A stale token cannot spend.** Access tokens live five minutes and carry
  the account epoch (`aep`) and grant generation (`agen`); the gateway
  refuses a token whose epoch or generation is out of date, and the ledger
  re-checks the grant and the cap inside the hold regardless. Revocation is
  effective on the next hold even against a token the gateway would have
  accepted.
- **An app cannot raise its own price.** Markup is a property of the
  registration, capped by the platform, shown to the user at consent and
  applied by the ledger at settlement.
- **A user cannot be charged more than they agreed to.** The spend cap
  chosen at consent is enforced inside the same atomic operation that
  reserves the 2Z, and bounds what settlement may collect when an
  estimate was low; the gateway cannot bypass it. The markup the user is
  charged is the one they consented to, not the one the app registers
  later.
- **The platform never sees a card number or an Apple/Google account.**
  Cards are handled by the payment processor's hosted surfaces; in-app
  purchases (first-party apps only) are verified against the store's
  signed receipt; Zcash payments are observed with a viewing key, so the
  platform can *see* a payment but holds no key that could *spend* one.
- **A balance can be negative only by a reversal, never by a call.** A
  refund or chargeback that takes back 2Z already spent leaves a debt the
  balance endpoint reports explicitly; the account cannot spend until
  future credits repay it, and no AI call can create one.
- **Prompts and completions are not logged** by the gateway. Per-app debug
  capture is opt-in by the developer, sampled, and applies only to users
  whose grant records that they consented to it — enabling it re-prompts
  consent ([`spec/oidc.md`](./spec/oidc.md) §5).

## Reading order

| Document | Who needs it |
|---|---|
| [`spec/oidc.md`](./spec/oidc.md) | Everyone. Registration, redirect rules, PKCE, tokens and claims, refresh rotation, revocation, step-up |
| [`spec/chat-api.md`](./spec/chat-api.md) | Anyone calling or implementing the gateway. `POST /v1/chat` and the full SSE grammar with examples |
| [`spec/metering.md`](./spec/metering.md) | Anyone who needs to explain a charge. Hold → stream → settle, the formula, worked examples, the edge cases |
| [`spec/purchase.md`](./spec/purchase.md) | Anyone selling 2Z in an app. Card and Zcash for every app; StoreKit 2 and Play Billing in Free2Z's own apps |
| [`spec/errors.md`](./spec/errors.md) | Everyone. The error catalogue: every status, code, whether to retry |
| [`../ai-gateway/`](../ai-gateway/README.md) | Gateway implementers. The ADRs and the operational contract |

## The v1 numbers

Every number below is a **v1 default**: fixed for this contract's
implementation, tunable by the platform later, and cited by the document
that uses it. An implementer reads them here; a change to one is a change
to this table first.

| Number | v1 default | Where |
|---|---|---|
| Platform margin | 2000 bps (20 %) | [`spec/metering.md`](./spec/metering.md) §2.2 |
| Developer markup cap | 5000 bps (50 %) | [`spec/oidc.md`](./spec/oidc.md) §2 |
| Minimum charge per call | 1 2Z (never below) | [`spec/metering.md`](./spec/metering.md) §2.2 |
| Card purchase | 100–10,000 2Z per intent | [`spec/purchase.md`](./spec/purchase.md) §2 |
| Zcash purchase | 100–1,000,000 2Z per intent; 30-minute quote; 3 confirmations | [`spec/purchase.md`](./spec/purchase.md) §2, §5 |
| Access token | 5 minutes | [`spec/oidc.md`](./spec/oidc.md) §6 |
| Refresh token | 30 days, rotating; 60 s grace for a lost rotation | [`spec/oidc.md`](./spec/oidc.md) §8 |
| Authorization code | 60 seconds, single use | [`spec/oidc.md`](./spec/oidc.md) §9.2 |
| Hold TTL | 300 s from the last extension; extended every 60 s | [`spec/metering.md`](./spec/metering.md) §3 |
| Open holds per account | 16 | [`spec/metering.md`](./spec/metering.md) §3 |
| Concurrent streams per user | 4, counted from hold to settlement, release or expiry | [`spec/chat-api.md`](./spec/chat-api.md) §1 |
| Per-stream delivery buffer | 256 KiB; the upstream read is never throttled by the client | [`spec/chat-api.md`](./spec/chat-api.md) §2.4 |
| Delivery-stall threshold | 30 s without delivery progress = disconnect (delivery only) | [`spec/chat-api.md`](./spec/chat-api.md) §2.4 |
| Idempotency window | 24 hours | [`spec/chat-api.md`](./spec/chat-api.md) §2.5 |
| Call records readable | 90 days | [`spec/chat-api.md`](./spec/chat-api.md) §7 |
| Catalogue validity | `expires_at = issued_at + 72 h`; re-signed every 24 h; alert under 48 h left | [`../ai-gateway/README.md`](../ai-gateway/README.md#the-catalogue-contract) |
| Provider timeouts | connect 5 s; first byte per model; idle 60 s; hard limit 300 s | [`../ai-gateway/README.md`](../ai-gateway/README.md) |

## Conventions used in the specification

- **MUST / SHOULD / MAY** are used as in RFC 2119.
- JSON examples are complete unless a line reads `...`.
- Timestamps in this contract's own JSON (the gateway and account APIs)
  are RFC 3339 in UTC with a `Z` suffix. Where a standard dictates
  otherwise the standard wins: OIDC claims (`exp`, `iat`, `auth_time`) and
  the signed catalogue (`issued_at`, `expires_at`) are Unix seconds.
- Identifiers (`call_id`, purchase `id`, `hold` ids) are UUIDs rendered in
  lower-case hyphenated form. Call ids are UUIDv7, so they sort by time.
- "Native client" means an app running on a device the user controls —
  desktop, iOS, Android, or a browser page — that cannot keep a secret.
  "Confidential client" means server-side code that can.
- **Wording rule.** 2Z are *platform credits*. Documentation, UI copy and
  error messages never call them money, currency, coins or tokens, and never
  describe a purchase as a deposit, an exchange or an investment.

For a real Tauri adapter before registry publication, use the
[pinned source-preview installation guide](./SOURCE-PREVIEW.md). Live service
acceptance remains a separate prerequisite.
