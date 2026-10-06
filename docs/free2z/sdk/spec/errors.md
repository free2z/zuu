# Error catalogue

**Status:** v1 contract · **Part of:** [f2z-sdk v1](../README.md) ·
**Refs:** [#1047](https://github.com/free2z/zuu/issues/1047),
[#1048](https://github.com/free2z/zuu/issues/1048)

Every error a client can receive from the gateway, the account API, or the
identity provider, with the HTTP status it comes with, whether retrying the
same request can succeed, and what a client should do. `f2z-ai-proto`
carries the gateway's codes as `ErrorCode`, each with its `http_status()`
and `retryable()`, plus an `Unknown` variant for a code newer than the
crate; the SDKs map each code to user-facing copy so that app code
switches on `code`, never on `message`. The crate carries every code in
§2–§4 (`ErrorCode::ALL`), and its test suite parses the tables below and
fails if a code, its status or its retryability disagrees with them; a
code without an HTTP status (`delivery_aborted`) answers `None`.

## 1. The envelope

Every non-2xx response from `ai.free2z.cash/v1/*` and
`free2z.cash/api/sdk/v1/*` is:

```json
{
  "error": {
    "code": "cap_exceeded",
    "message": "This app's spend cap for the current week is exhausted.",
    "details": {
      "cap_2z": 200,
      "cap_period": "week",
      "resets_at": "2026-09-28T00:00:00Z"
    }
  }
}
```

| Field | Rule |
|---|---|
| `code` | One of the codes below. Stable; new codes may be added, so a client MUST have a default branch |
| `message` | English, for logs and developers. Not localised; not for end users; never contains prompt or completion text |
| `details` | Optional, code-specific, documented per code below. A client MUST tolerate its absence and unknown keys |

**Retryability is a property of the code, not a field.** The "Retry"
column below is what `ErrorCode::retryable()` answers; `yes` means the
identical request may succeed later, never "retry immediately" — honour
`Retry-After` when present, otherwise back off exponentially from 1 s.

Two surfaces use a different shape because their standards require it:

- **The OAuth token, revocation and introspection endpoints** answer with
  RFC 6749 `{"error": "...", "error_description": "..."}` (§5).
- **Authentication challenges** additionally carry a `WWW-Authenticate:
  Bearer` header ([RFC 6750](https://www.rfc-editor.org/rfc/rfc6750) §3,
  [RFC 9470](https://www.rfc-editor.org/rfc/rfc9470)) with the same `error`
  code; the body is still the envelope.

Inside an SSE stream, the terminal `error` event carries `code` and
`message` with the same meanings, plus the settlement fields and `partial`
([chat-api.md](./chat-api.md) §3.7).

## 2. Authentication and authorization — shared by every resource server

| Status | `code` | Retry | Meaning | Client action | `details` |
|---|---|---|---|---|---|
| 401 | `invalid_token` | no | Missing, malformed, expired, bad signature, wrong `iss`, or `aud` does not include this server | Refresh the access token and retry once; then sign in again | `reason` ∈ `missing`, `malformed`, `expired`, `signature`, `issuer`, `audience` |
| 401 | `token_revoked` | no | `aep` or `agen` is behind the current value: the account had a security event, or the grant was revoked or narrowed | Clear the session; sign in again (re-consent is shown if needed) | `reason` ∈ `account_epoch`, `grant_generation` |
| 401 | `insufficient_user_authentication` | no | The operation needs a more recent or stronger authentication (RFC 9470) | Run the step-up flow of [oidc.md](./oidc.md) §10 with the `max_age` / `acr_values` from `WWW-Authenticate`, then retry once | `max_age`, `acr_values` |
| 403 | `insufficient_scope` | no | The token lacks the scope this endpoint requires (RFC 6750) | Re-authorize requesting the scope in `details.scope` | `scope` |
| 403 | `app_disabled` | no | The app's registration is suspended | Nothing the client can do; surface to the developer | — |
| 403 | `account_frozen` | no | The user's account cannot spend (for example a payment dispute is open) | Tell the user to visit their account | — |
| 403 | `account_in_debt` | no (until repaid) | A refund or chargeback took back 2Z already spent; the account owes the difference and cannot spend until future credits repay it ([purchase.md](./purchase.md) §3.1) | Show the debt from `GET /balance` and the buy surface | `debt_milli_2z` |
| 503 | `unavailable` | yes | The server cannot serve the request right now and fails closed: it could not confirm the token's `aep`/`agen`, it has no signing keys to verify the token with (the issuer's JWKS has not loaded, or verification is not configured), shared admission cannot be confirmed, it is draining, or (gateway) the provider's circuit breaker is open or nonstreaming response memory cannot be reserved before a call | Retry with backoff; do **not** sign the user out | `reason` ∈ `revocation_check`, `token_keys`, `shared_admission`, `draining`, `provider_circuit_open`, `response_budget` |

## 3. Requests, limits and balances

| Status | `code` | Retry | Meaning | `details` |
|---|---|---|---|---|
| 400 | `invalid_request` | no | A field is missing, malformed or out of range; an unknown field was sent; an image part on a model without vision; a `response_format` the model cannot honour (`reason: "response_format_unsupported"`) or of an unknown `type` (`field: "response_format.type"`, `reason: "unsupported"`); a tool feature the model or its adapter cannot honour — `tools` without `capabilities.tools`, `tools[i].strict: true` without `capabilities.strict_tools`, or `tool_choice` / `parallel_tool_calls` where the adapter cannot express them (`reason: "tools_unsupported"`, `field` naming which); with `max_output_tokens_strict`, a `max_output_tokens` above the model's | `field`, `reason`, `max_output_tokens`, `model_max_output_tokens` (strict only) |
| 400 | `context_length_exceeded` | no | The input does not fit the model's context window with at least one output token — or, with `max_output_tokens_strict`, with `max_output_tokens` of them | `input_tokens_estimate`, `context_window`, `reason`, `max_output_tokens` (strict only) |
| 402 | `insufficient_balance` | no (until topped up) | The user's available 2Z cannot cover the model's minimum charge for this request — or, with `max_output_tokens_strict`, the worst case of the full `max_output_tokens` | `available_milli_2z`, `required_2z` (the minimum hold for one output token; with strict, the hold for `max_output_tokens`), `min_charge_2z`, `reason`, `max_output_tokens` (strict only) |
| 403 | `cap_exceeded` | no (until the period resets or the user raises the cap) | The grant's spend cap for the current period cannot cover the minimum charge — or, with `max_output_tokens_strict`, the worst case of the full `max_output_tokens` | `cap_2z`, `cap_period`, `cap_remaining_milli_2z`, `resets_at` (`null` for `total`), `reason`, `required_2z`, `max_output_tokens` (strict only) |
| 403 | `model_disabled` | no | The model exists but is not callable: disabled, its provider disabled by policy, or not available to this app | `model` |
| 404 | `model_not_found` | no | Unknown model id | `model` |
| 404 | `call_not_found` | no | No such call for this (user, app) | — |
| 404 | `purchase_not_found` | no | No such purchase for this (user, app) | — |
| 409 | `idempotency_conflict` | no | The `Idempotency-Key` was used with a different body, or names a call that is still streaming | `call_id` |
| 409 | `too_many_holds` | yes | The account already has 16 open holds (the limit); this would be the seventeenth | — |
| 413 | `payload_too_large` | no | Over the 4 MiB / 20 MiB body limit | `limit_bytes` |
| 429 | `rate_limited` | yes, after `Retry-After` | Requests per minute for this (app, user), or an explicitly configured aggregate application admission limit, exceeded | — |
| 429 | `concurrency_limit` | yes, after `Retry-After` | A fifth simultaneous stream for this user | `limit` |

## 4. Providers and the stream

These can be an HTTP response (before the HTTP response began) or an SSE
`error` event (after it). In a stream, the settlement fields say what the
failed call still cost ([metering.md](./metering.md) §5). The status
column is the HTTP status when the error is an HTTP response; once a
stream is open the status is already `200` and the code arrives in the
`error` event, and in non-streamed mode a failure after output began is
always `502` with the code preserved ([chat-api.md](./chat-api.md) §4).

| Status | `code` | Retry | Meaning |
|---|---|---|---|
| 502 | `provider_error` | yes | The provider answered with an error or a malformed stream. A refused request (a non-2xx head): nothing charged, `fallback` tried if given. An accepted request (a 2xx head) that then failed: charged for what was produced — on the provider's usage when it reported one, else on the gateway's estimate ([metering.md](./metering.md) §5.4, `usage_source: "estimated"`), input included even when no output arrived |
| 504 | `provider_timeout` | yes | The provider did not answer in time: no first byte within the model's `ttfb_timeout_ms` (nothing charged; `details.phase: "first_byte"`), or, on an accepted stream, the model's idle limit (the catalogue's `idle_timeout_ms`, default 60 s) or the 300 s hard limit — charged on the provider's usage if it arrived, else on the estimate ([metering.md](./metering.md) §5.4): the input estimate plus whatever output was produced, which is nothing when a reasoning model timed out silent (`details.phase` ∈ `idle`, `hard_limit`) |
| 503 | `unavailable` | yes | See §2: draining, revocation or shared admission state unknown, or the provider's circuit breaker open. Nothing charged |
| 503 | `catalog_unavailable` | yes | The gateway has no verified, unexpired price catalogue and refuses to price anything |
| 500 | `internal` | yes | A gateway fault. Nothing charged if before `meta`; otherwise settled from what is known. Retryable because a retry is a new `Idempotency-Key` and so a new call (§7). A ledger answer the gateway did not expect (`markup_mismatch`, `unknown_rate_card`, [metering.md](./metering.md) §3) surfaces as this code with `details.reason`; the ledger's `revoked` surfaces as `401 token_revoked` |
| (stream) | `delivery_aborted` | no | Delivery to this client ended — the per-stream buffer (256 KiB) filled, or 30 s passed without delivery progress — while the upstream read and the settlement continue ([chat-api.md](./chat-api.md) §2.4). Sent best-effort; `settlement: "pending"`; read `GET /v1/calls/{id}` until its `status` is terminal. Not retryable: the call is still running and will be charged |
| (SDK-local) | `stream_interrupted` | yes | **Not a gateway code** and not in `ErrorCode`: an SDK synthesises it when the connection closed without a terminal event, and it never appears in a call record — a call whose gateway died records `unavailable` ([metering.md](./metering.md) §5.6). Consult `GET /v1/calls/{id}` |

A content-filter stop is **not an error** on any surface: it is
`finish_reason: "content_filter"` on `done` or on the non-streamed
response, charged for what was produced.

## 5. The identity provider

The token endpoint follows RFC 6749 §5.2 exactly; the authorization
endpoint follows §4.1.2.1 and OpenID Connect Core §3.1.2.6. The subset a
client should handle:

| Endpoint | `error` | Meaning | Client action |
|---|---|---|---|
| authorize | `access_denied` | The user declined | Show "sign-in cancelled" |
| authorize | `invalid_scope` | A scope is unknown or not in the app's `allowed_scopes` | Developer error |
| authorize | `invalid_request` | Bad redirect URI (including an unverifiable claimed link), missing `code_challenge`, `plain` method, missing `nonce` with `openid` | Developer error |
| authorize | `login_required`, `consent_required`, `interaction_required` | With `prompt=none`: the user must interact | Repeat without `prompt=none` |
| token | `invalid_grant` | Code expired or used; verifier mismatch; refresh token expired, rotated (reuse), stale epoch, or the grant was revoked | For a code: restart sign-in. For a refresh: clear the session, sign in again. Never retry |
| token | `invalid_client` | Unknown `client_id`, or a confidential client's secret is wrong | Developer error |
| token | `invalid_scope` | A refresh asked for a scope outside the grant | Developer error |
| token | `unauthorized_client` | The app may not use this grant type (for example the Zcash grant without `allow_zcash_assertion`) | Developer error |
| token | `unsupported_grant_type` | — | Developer error |
| revoke | `unsupported_token_type` | An access token was presented; only refresh tokens can be revoked ([oidc.md](./oidc.md) §9.5) | Revoke the grant instead |

Authorization-endpoint errors are delivered on the redirect URI with
`state` and `iss`; a client MUST verify both before trusting `error`.
**Except**: when the `client_id` is unknown or the `redirect_uri` is
missing or not registered, the IdP MUST NOT redirect (RFC 6749 §4.1.2.1)
— it shows an error page and the client's callback is never invoked. An
SDK therefore treats "no callback within its timeout" as a failed sign-in
that is almost always a registration mistake.

### 5.1 Sign-in that ends at the browser (SDK-local)

Not IdP codes and never on the wire: an SDK reports them when the browser
step ends **without any callback**, so an app can tell a deliberate cancel
from a failure. The native Tauri plugin (`tauri-plugin-f2z`) and the
TypeScript `NativeTransport` report:

| `code` | Retry | Meaning | Client action |
|---|---|---|---|
| `user_cancelled` | no | The user dismissed the sign-in sheet: iOS `ASWebAuthenticationSession` cancel, or returning to the Android app from the Custom Tab without a callback (Android cannot tell that apart from a browser that closed itself) | Not an error. Leave the sign-in button available; do not show a failure |
| `browser_unavailable` | no | No browser or authentication session could be shown: no default browser, no window to present from, or the session refused to start. Nothing was shown | Explain that sign-in needs a browser |
| `timeout` | no | No callback before the deadline (300 s on iOS/Android; `callback_timeout` on desktop). Desktop cannot observe a closed browser tab, so a desktop cancel arrives as this. Also the §5 registration mistake | Offer sign-in again; if it persists, check the registration |
| `browser_error` | no | Any other browser or session failure, and **every** one from a plugin older than these codes | The fallback. Always handle it |

These are additive: `browser_error` remains, and an app that handled only it
keeps working. Switch on the code and keep a default branch. The IdP's own
refusal (`access_denied`, …) is unchanged — it arrives as a callback.
The Rust SDK's equivalents are `Error::UserCancelled`,
`Error::BrowserUnavailable`, `Error::Timeout` and `Error::Browser`; an
`AuthSession` implementation returns the most specific one it can.

## 6. Purchases

Codes specific to [purchase.md](./purchase.md); the envelope is §1.

| Status | `code` | Retry | Meaning | `details` |
|---|---|---|---|---|
| 400 | `invalid_quantity` | no | Below the rail's minimum, above its maximum, not a whole 2Z, or not one of the rail's fixed packs | `min_2z`, `max_2z`, `packs` |
| 400 | `rail_unavailable` | no | The rail is not offered to this app or on this platform (`apple_iap` / `google_iap` from any third-party app in v1, or from the wrong platform) | `rail` |
| 409 | `intent_not_pending` | no | The intent is `failed`; the operation does not apply. (A receipt resubmitted for an intent that is already `credited`, `expired` or in a reversal state is **not** an error: it answers `200` with the intent — [purchase.md](./purchase.md) §4.4) | `status` |
| 409 | `receipt_already_used` | no | This store transaction already credited a **different** purchase intent | `purchase_id` |
| 422 | `receipt_invalid` | no | The store receipt did not verify, names a different product or app, is not a production transaction, was revoked, or its account token does not match this intent | `reason` ∈ `signature`, `product`, `app`, `environment`, `revoked`, `account_token` |
| 202 | — | — | Not an error: a Google purchase whose store state is still pending ([purchase.md](./purchase.md) §4.3). The intent is returned with `status: pending` and `rail_data.store_state: "pending"`; resubmit later or wait for the poll | — |
| 503 | `store_unavailable` | yes | The store's verification service could not be reached | — |

## 7. Rules for every implementation

- **Status and code agree.** The tables above are exhaustive for which
  status a code arrives with; a code never changes status between servers.
  The one documented exception is a non-streamed call that fails **after
  output began**, which is always `502` whatever the code, so that the
  partial result and its settlement travel in one shape
  ([chat-api.md](./chat-api.md) §4).
- **Balance errors are never retryable by the client alone.** `402`,
  `403 cap_exceeded` and `403 account_in_debt` say what would have to change
  (`details`); an SDK shows the buy or cap surface rather than retrying.
- **Nothing is charged for a refused request.** Every `4xx` before `meta`
  means no hold was taken or the hold was released.
- **Re-sending with the same `Idempotency-Key` never does new work**: it
  returns what the key already produced (a call record, or a
  `409 idempotency_conflict` while it is in flight). A retry the user
  wants attempted again — after a retryable `5xx` before `meta`, or a
  network failure with no response at all — is a **new key**; the old key
  can first be re-sent to learn whether the original in fact ran
  ([chat-api.md](./chat-api.md) §2.5).
- **`message` is not stable** and MUST NOT be parsed; `code` and `details`
  are.
