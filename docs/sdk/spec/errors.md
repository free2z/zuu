# Error catalogue

**Status:** v1 contract · **Part of:** [f2z-sdk v1](../README.md) ·
**Refs:** [#1047](https://github.com/free2z/zuu/issues/1047),
[#1048](https://github.com/free2z/zuu/issues/1048)

Every error a client can receive from the gateway, the account API, or the
identity provider, with the HTTP status it comes with, whether retrying the
same request can succeed, and what a client should do. `f2z-ai-proto`
carries this list as a closed enum; the SDKs map each code to user-facing
copy so that app code switches on `code`, never on `message`.

## 1. The envelope

Every non-2xx response from `ai.free2z.cash/v1/*` and
`free2z.cash/api/sdk/v1/*` is:

```json
{
  "error": {
    "code": "cap_exceeded",
    "message": "This app's spend cap for the current week is exhausted.",
    "retryable": false,
    "details": {
      "cap_m2z": 200000,
      "cap_period": "week",
      "resets_at": "2026-09-28T00:00:00Z"
    }
  }
}
```

| Field | Rule |
|---|---|
| `code` | One of the codes below. Stable; new codes may be added, so a client MUST have a default branch |
| `message` | English, for logs and developers. Not localised; not for end users |
| `retryable` | `true` means the identical request may succeed later. It never means "retry immediately": honour `Retry-After` when present, otherwise back off exponentially from 1 s |
| `details` | Optional, code-specific, documented per code below. A client MUST tolerate its absence and unknown keys |

Two surfaces use a different shape because their standards require it:

- **The OAuth token, revocation and introspection endpoints** answer with
  RFC 6749 `{"error": "...", "error_description": "..."}` (§5).
- **Authentication challenges** additionally carry a `WWW-Authenticate:
  Bearer` header ([RFC 6750](https://www.rfc-editor.org/rfc/rfc6750) §3,
  [RFC 9470](https://www.rfc-editor.org/rfc/rfc9470)) with the same `error`
  code; the body is still the envelope.

Inside an SSE stream, the terminal `error` event carries `code`, `message`
and `retryable` with the same meanings, plus `charged_m2z` and `partial`
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
| 503 | `revocation_check_unavailable` | yes | The server could not confirm the token's `aep`/`agen` and fails closed | Retry with backoff; do **not** sign the user out | — |

## 3. Requests, limits and money

| Status | `code` | Retry | Meaning | `details` |
|---|---|---|---|---|
| 400 | `invalid_request` | no | A field is missing, malformed or out of range; an unknown field was sent; an image part on a model without vision | `field`, `reason` |
| 400 | `context_too_long` | no | The input does not fit the model's context window with at least one output token | `input_tokens_estimate`, `context_window` |
| 402 | `insufficient_balance` | no (until topped up) | The user's available 2Z cannot cover the model's minimum charge for this request | `available_m2z`, `required_m2z` (the minimum hold for one output token), `min_charge_m2z` |
| 403 | `cap_exceeded` | no (until the period resets or the user raises the cap) | The grant's spend cap for the current period cannot cover the minimum charge | `cap_m2z`, `cap_period`, `cap_remaining_m2z`, `resets_at` (`null` for `total`) |
| 403 | `model_not_allowed` | no | The model exists but this app may not use it | `model` |
| 404 | `model_not_found` | no | Unknown or disabled model id | `model` |
| 404 | `call_not_found` | no | No such call for this (user, app) | — |
| 404 | `purchase_not_found` | no | No such purchase for this (user, app) | — |
| 409 | `idempotency_conflict` | no | The `Idempotency-Key` was used with a different body, or names a call that is still streaming | `call_id` |
| 409 | `too_many_holds` | yes | The account already has 16 open holds | — |
| 413 | `payload_too_large` | no | Over the 4 MiB / 20 MiB body limit | `limit_bytes` |
| 429 | `rate_limited` | yes, after `Retry-After` | Requests per minute for this (app, user) exceeded | — |
| 429 | `concurrency_exceeded` | yes, after `Retry-After` | A fifth simultaneous stream for this user | `limit` |

## 4. Providers and the stream

These can be an HTTP response (before the stream exists) or an SSE
`error` event (after `meta`). In a stream, `charged_m2z` says what the
failed call still cost ([metering.md](./metering.md) §5).

| Status | `code` | Retry | Meaning |
|---|---|---|---|
| 502 | `provider_error` | yes | The provider answered with an error or malformed stream. Before the first byte: nothing charged, `fallback` tried if given. After: charged for what was produced |
| 503 | `provider_unavailable` | yes | The provider is down or the gateway's circuit breaker for it is open. Nothing charged |
| 504 | `provider_timeout` | yes | No first byte within the model's `first_byte_timeout_s`. Nothing charged |
| (stream) | `stream_timeout` | yes | 60 s without any provider output, or the 300 s hard limit. Charged for what was produced |
| (stream) | `content_filter` | no | The provider refused or stopped for policy. Charged for what was produced; often 0 |
| (stream, local) | `stream_interrupted` | yes | Not sent by the gateway: an SDK synthesises it when the connection closed without a terminal event. Consult `GET /v1/calls/{id}` |
| 503 | `catalogue_unavailable` | yes | The gateway has no verified price catalogue and refuses to price anything |
| 500 | `internal` | yes | A gateway fault. Nothing charged if before `meta`; otherwise settled from what is known |

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

Authorization-endpoint errors are delivered on the redirect URI with
`state` and `iss`; a client MUST verify both before trusting `error`.

## 6. Purchases

Codes specific to [purchase.md](./purchase.md); the envelope is §1.

| Status | `code` | Retry | Meaning | `details` |
|---|---|---|---|---|
| 400 | `invalid_quantity` | no | Below the rail's minimum, above its maximum, not a whole 2Z, or not one of the rail's fixed packs | `min_m2z`, `max_m2z`, `packs` |
| 400 | `rail_unavailable` | no | The rail is not offered to this app or on this platform (for example `apple_iap` from a non-iOS client) | `rail` |
| 409 | `intent_expired` | no | The purchase intent passed `expires_at` before payment | — |
| 409 | `intent_not_pending` | no | The intent is already `credited`, `failed` or `expired`; the operation does not apply | `status` |
| 409 | `receipt_already_used` | no | This store transaction already credited a purchase | `purchase_id` |
| 422 | `receipt_invalid` | no | The store receipt did not verify, names a different product, or its account token does not match this intent | `reason` |
| 503 | `store_unavailable` | yes | The store's verification service could not be reached | — |

## 7. Rules for every implementation

- **Status and code agree.** The tables above are exhaustive for which
  status a code arrives with; a code never changes status between servers.
- **Money errors are never retryable by the client alone.** `402` and
  `403 cap_exceeded` say what would have to change (`details`); an SDK shows
  the buy or cap surface rather than retrying.
- **Nothing is charged for a refused request.** Every `4xx` before `meta`
  means no hold was taken or the hold was released.
- **A `5xx` before `meta` is safe to retry** with the same
  `Idempotency-Key`; a `5xx` after `meta` is a new call if retried.
- **`message` is not stable** and MUST NOT be parsed; `code` and `details`
  are.
