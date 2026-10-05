# Quickstart: your first Free2Z app in 15 minutes

**Part of:** [f2z-sdk v1](./README.md) · **Audience:** an app developer with
no other context · **Status:** pre-release (2026-10-05) — the packages are not
on npm or crates.io yet; build from source and test against mocks.

> **Version requirement.** This guide uses `preflight`, `formatMilli2z`,
> typed error codes, `ChatRequest::new` and `Milli2z::display_2z`, which are
> newer than the revision pinned in the
> [source-preview guide](./SOURCE-PREVIEW.md) (`534d2a58`). Follow that guide
> but pin a `main` commit that contains them, and move all three Tauri
> pieces — `@free2z/sdk`, `@free2z/tauri-plugin-f2z-api` and
> `tauri-plugin-f2z` — to the same commit together.

You will build the loop every paid-AI app needs: **sign in → check the
budget and balance → pick a model → preflight a strict request → stream it →
parse structured JSON → read the receipt → sign out**, plus the recovery
screens for "not enough 2Z" and "this app's budget is used up".

The Rust version of this app is compiled and run by CI against local fakes:
[`rs/crates/f2z-sdk/examples/first_app.rs`](../../../rs/crates/f2z-sdk/examples/first_app.rs)
(`cargo run -p f2z-sdk --example first_app`). The TypeScript version is below.

## 1. Six things to know first

| Concept | The rule |
|---|---|
| **2Z** | Platform credits, not money. 1 2Z = $0.01 of usage. |
| **Units** | Every amount is an integer and its field name says the unit: `_2z` = whole 2Z (charges, holds), `_milli_2z` = thousandths (balances, remaining budget). In TypeScript they are `bigint`; never pass them through `Number`. Format only for display: `formatMilli2z(41_500n)` → `"41.500"` (Rust: `Milli2z::display_2z()`). |
| **Two limits** | A call needs both enough **balance** (the user's 2Z) and enough **budget** (what the user lets *this app* spend per period). Buying 2Z does not raise a budget. |
| **Charges** | A call is priced from the provider's reported usage, rounded **up** to a whole 2Z, minimum 1 2Z per call. An estimate is what a call would *hold* now — not a quote and not a maximum. |
| **Strict output** | Without `max_output_tokens_strict`, the gateway may *lower* `max_output_tokens` to what the user can afford, and a truncated answer is still charged. For anything that must be whole (JSON, a lesson), set the flag: the call then runs in full or is refused before any charge. |
| **Keys** | Every chat call carries an `idempotencyKey` you create and persist **before** sending. Re-sending the same key never runs or charges twice; it returns the original call's receipt. A new attempt is a new key. |

## 2. Register your app

Register a **public native client** in the Free2Z developer console (a
Tauri or browser app cannot keep a secret). You get a `client_id`, which is
public configuration. Register your redirect URIs exactly
([rules](./spec/oidc.md#3-redirect-uris)). Optionally set a default
per-user budget (`default_spend_cap_2z` + `default_cap_period`).

## 3. The app (TypeScript, Tauri)

Inside a Tauri webview, tokens stay in Rust: use `NativeTransport` over the
plugin's `nativeBridge`. In a plain browser app, swap the transport for
`FetchTransport` (see [the SDK README](../../../ts/free2z/sdk/README.md));
everything after the first line is identical.

```ts
import {
  Client,
  NativeTransport,
  SdkError,
  formatMilli2z,
  type ChatRequest,
} from "@free2z/sdk";
import { nativeBridge } from "@free2z/tauri-plugin-f2z-api";

const client = new Client(new NativeTransport(nativeBridge));

export async function firstApp(): Promise<void> {
  // 1. Sign in, suggesting a lifetime budget. The user decides.
  const session = await client.signIn({ spendCap: { cap2z: 500n, period: "total" } });
  if (!session.grantedScopes.includes("ai:invoke")) return hideAiFeatures();

  // 2. Budget and balance. `enforced` is the only proof a budget is enforced.
  const grant = await client.grant();
  if (grant.spend_cap_2z !== null && !grant.enforced) noteBudgetNotYetEnforced(grant);
  const balance = await client.balance();
  showBalance(`${formatMilli2z(balance.available_milli_2z)} 2Z`);
  if (balance.debt_milli_2z > 0n) showDebt(balance.debt_milli_2z);

  // 3. A model that can return JSON. Never hard-code a model id.
  const { models } = await client.models();
  const model = models.find((m) => m.capabilities?.structured_output);
  if (!model) throw new Error("no structured-output model available");

  // 4. A strict request: all 1800 tokens, or a refusal before any charge.
  const request: ChatRequest = {
    model: model.id,
    messages: [
      { role: "system", content: [{ type: "text", text: "You write short classroom activities." }] },
      { role: "user", content: [{ type: "text", text: "A two-step activity about one half." }] },
    ],
    max_output_tokens: 1800n,
    max_output_tokens_strict: true,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "activity",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { title: { type: "string" }, steps: { type: "array", items: { type: "string" } } },
          required: ["title", "steps"],
        },
      },
    },
  };

  // 5. Preflight before enabling "Generate": no hold, no charge.
  const check = await client.preflight(request);
  switch (check.kind) {
    case "ready":
      break;
    case "needs_top_up": // balance too low
      return offerPurchase(check.required2z);
    case "needs_budget": // this app's budget is used up; buying 2Z will not help
      return linkToBudget("https://free2z.cash/account/apps", check.resetsAt);
    case "too_large": // can never run as asked
      return askToShorten();
  }

  // 6. Stream it. Create AND persist both ids before sending.
  const operationId = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  await journal.save({ operationId, idempotencyKey, subject: session.subject, request });
  let text = "";
  let finish: string | undefined;
  const stream = await client.chat(request, { operationId, idempotencyKey });
  try {
    for await (const event of stream) {
      if (event.type === "delta") text += event.text;
      if (event.type === "done") finish = event.finish_reason;
      if (event.type === "error") showFailure(event.code, event.charge); // may still have cost 2Z
    }
  } catch (error) {
    // A broken stream is exactly when the call may still settle and charge:
    // keep the partial text and fall through to the receipt.
    showStreamError(error);
  }

  // 7. Parse only a completed answer — and still validate it: model output
  //    is untrusted text, and `length` means truncated JSON.
  if (finish === "stop") renderActivity(parseActivity(text)); // try/catch JSON.parse inside

  // 8. The receipt — always. `pending` is "settling", never zero.
  if (stream.callId) {
    const record = await client.waitForCall(stream.callId);
    if (record.charge.state === "charged") showCharge(record.charge.charged2z);
  } // no callId: re-send the same request with the same key to recover it

  // 9. Sign out. `revoked: false` means the server did not confirm revocation.
  await client.signOut();
}
```

Wrap steps 2–8 in the error handling of [§5](#5-errors-and-the-recovery-ux).

## 4. Test without the network

`NativeBridge` is structural, so a test can pass a plain object. Native
values use **decimal strings** for integers, exactly as the plugin sends
them; the SDK converts them to `bigint`.

```ts
const mock = {
  session: async () => ({ signedIn: true, subject: "u1", grantedScopes: ["ai:invoke"], persistence: "memory_only", generation: "1" }),
  balance: async () => ({ available_milli_2z: "41500", held_milli_2z: "0", balance_milli_2z: "41500", debt_milli_2z: "0", as_of: "2026-10-05T00:00:00Z" }),
  estimate: async () => Promise.reject({
    code: "insufficient_balance", retryable: false, status: 402,
    details: { reason: "max_output_tokens_strict", required_2z: "12", available_milli_2z: "500" },
  }),
  // ...the rest of NativeBridge as your test needs
};
const result = await new Client(new NativeTransport(mock)).preflight(request);
// result.kind === "needs_top_up", result.required2z === 12n
```

Cover at least: insufficient balance, budget used up, a failed call that
still charged, cancellation while settling (`charge.state === "pending"`), a
lost response recovered with the same key (a `replay` event), and switching
accounts. In Rust, the crate's own fakes live in
`rs/crates/f2z-sdk/tests/support/` and are not a published test kit yet.

## 5. Errors and the recovery UX

Switch on `SdkError.code` (TypeScript, typed as `SdkErrorCode`) or on
`Error` variants and `ApiError::error_code()` (Rust). Never parse `message`:
it is a developer hint, not user copy, and not stable.

| What happened | TypeScript `code` | Rust | Show the user |
|---|---|---|---|
| Not enough 2Z | `insufficient_balance` (402) | `ErrorCode::InsufficientBalance` | "You need N more 2Z" → purchase; re-read the balance after `credited` |
| App budget used up | `cap_exceeded` (403) | `ErrorCode::CapExceeded` | "Raise this app's budget" → `https://free2z.cash/account/apps`, or wait for `details.resets_at` |
| Debt after a refund | `account_in_debt` (403) | `ErrorCode::AccountInDebt` | Show `debt_milli_2z` and the buy surface; never auto-retry |
| Too long | `context_length_exceeded` (400) | `ErrorCode::ContextLengthExceeded` | Shorten the input or lower `max_output_tokens` |
| Busy | `rate_limited`, `concurrency_limit` (429), `unavailable` (503) | same codes; `retry_after` | "Busy, retrying" — honour `retryAfterSeconds`; never suggest buying 2Z |
| Session over | `signed_out`, `token_revoked`, `invalid_token` | `Error::SignedOut` | Sign-in screen; stop spending |
| Needs fresh login | `insufficient_user_authentication` + `error.stepUp` | `Error::StepUpRequired` | `signIn({ maxAge, acrValues })`, then retry once |
| Outcome unknown | `unconfirmed` | `Error::Unconfirmed` | Re-send the **same** request with the **same** key to learn the outcome |
| Stream broke / Stop pressed | `stream_interrupted`, `cancelled` | `Error::StreamInterrupted`, `Error::Cancelled` | Keep the partial text; `waitForCall(callId)` for the charge — Stop is not free |
| Already done | `replay` event / `replayed` | `Error::Replayed` | Show the existing receipt; nothing new was charged |
| Model gone | `model_not_found`, `model_disabled` | same codes | Re-read `models()` and pick another |

Every code with its HTTP status and retry rule is in
[the error catalogue](./spec/errors.md). `error.retryable` is `true` only
when the identical refusal may succeed later **and** nothing ran; for chat, a
retry is always a **new** idempotency key.

**Web and native spell some local codes differently today** (a
[known gap](https://github.com/free2z/zuu/issues/1135)): handle both.

| Failure | Web (`FetchTransport`) | Native (`NativeTransport`) |
|---|---|---|
| Network | `transport` | `transport_error` |
| Bad server response | `invalid_response` | `protocol_error` |
| Bad configuration | `invalid_config` | `configuration_error` |
| Sign-in window closed / failed | `cancelled`, `popup_blocked`, `browser_unavailable`, `auth_timeout` | `browser_error`, `timeout` |
| Keychain | — | `storage_unavailable` |

## 6. Sessions: refresh, sign-out, more than one account

- **Refresh is automatic.** Access tokens live five minutes; every SDK
  refreshes them (one shared refresh at a time) and retries once. You see
  `signed_out` only when the refresh token is gone, expired, reused or
  revoked — then show sign-in.
- **Sign-out** clears local tokens and revokes the refresh token at the
  server; `revoked: false` means revocation was not confirmed (the local
  session is still gone).
- **One client, one account.** A `Client` holds one session. To switch
  accounts: `signOut()`, then `signIn({ prompt: "login" })`. Key everything
  you persist (operation journal, cached balance, idempotency keys) by
  `session.subject`, and drop or quarantine it when the subject changes —
  never recover another user's call with their key.
- **Persistence.** `session.persistence === "memory_only"` means the OS
  keychain was unavailable: a restart will ask the user to sign in again;
  tell them.

## 7. Where next

- [Integration handoff](./INTEGRATION.md) — the Tauri boundary, purchases,
  cancellation and receipts in depth.
- [Chat API](./spec/chat-api.md) — every event and field on the wire.
- [Metering](./spec/metering.md) — how a charge is computed, with worked
  examples.
- [Purchases](./spec/purchase.md) — card and Zcash checkout and polling.
