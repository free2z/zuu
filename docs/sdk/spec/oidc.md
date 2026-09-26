# OIDC — Free2Z as an identity provider

**Status:** v1 contract · **Part of:** [f2z-sdk v1](../README.md) ·
**Refs:** [#1047](https://github.com/free2z/zuu/issues/1047),
[#1048](https://github.com/free2z/zuu/issues/1048)

This document specifies how an app signs a user in to Free2Z and obtains
tokens for the account API and the AI gateway. It is written so that three
different implementers can build against it without talking to each other:
the identity provider (IdP), a resource server (the gateway or the account
API), and a client (the SDK). Where a standard already says it, this document
cites the standard and only records the choices the standard leaves open.

## 1. Profile in one table

| Item | Value |
|---|---|
| Issuer (`iss`) | `https://free2z.cash` |
| Discovery | `https://free2z.cash/.well-known/openid-configuration` ([OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html)) |
| Flow | Authorization Code ([RFC 6749](https://www.rfc-editor.org/rfc/rfc6749) §4.1) with PKCE ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)); `response_type=code` only |
| PKCE | `S256` is **required** for every native client. `plain` is rejected for every client |
| Native-app redirects | [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252): loopback on any port, claimed `https` URI, or reverse-DNS private scheme (§3) |
| Scopes | `openid profile email offline_access balance:read purchase:create ai:invoke` (§4) |
| Access token | JWT, `ES256`, `typ: at+jwt` ([RFC 9068](https://www.rfc-editor.org/rfc/rfc9068)), **5 minutes**, `aud`, `aep`, `agen` (§6) |
| ID token | JWT, `RS256` (§7) |
| Refresh token | Opaque, rotating, in families with reuse detection (§8) |
| Authorization response | Carries `iss` ([RFC 9207](https://www.rfc-editor.org/rfc/rfc9207)) |
| Revocation | [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009) at `revocation_endpoint` |
| Introspection | [RFC 7662](https://www.rfc-editor.org/rfc/rfc7662) at `introspection_endpoint`, confidential clients only |
| Step-up | `acr_values`, `max_age`, `prompt=login`; resource servers signal with [RFC 9470](https://www.rfc-editor.org/rfc/rfc9470) (§10) |
| Sender constraint | None in v1 (bearer tokens). DPoP ([RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)) is planned; clients MUST tolerate `dpop_signing_alg_values_supported` appearing in discovery |
| Not in v1 | Implicit and hybrid flows, `response_mode=fragment`, pushed authorization requests, dynamic client registration, `client_credentials`, device authorization grant |

## 2. Registering an app

Apps are registered by a developer in the console at
`https://free2z.cash/developers/apps`. There is no privileged path: the
platform's own apps register the same way. Registration fixes:

| Field | Meaning |
|---|---|
| `client_id` | Assigned by the platform. Opaque, stable |
| `client_type` | `public` (native or browser app; **no secret is issued**) or `confidential` (server-side; a `client_secret` is issued and MUST be sent with `client_secret_basic`, or `client_secret_post` if the client cannot set headers) |
| `redirect_uris` | The exact set of allowed redirect URIs (§3). Matching is exact, except the port of a loopback URI |
| `allowed_scopes` | The subset of §4 the app may request. Requesting a scope outside it fails with `invalid_scope` |
| `markup_bps` | The developer markup in basis points applied to every AI call made through this app, credited to the developer. `0` to the platform cap (v1: **5000**, i.e. 50 %). Shown to the user at consent; changing it re-prompts consent (§5) |
| `default_spend_cap` | The cap pre-selected on the consent screen when `ai:invoke` is requested: an amount in milli-2Z and a period (§5) |
| `allow_zcash_assertion` | Whether the app may use the Zcash sign-in grant (§9.4). Off by default |
| Name, logo, privacy URL, terms URL | Shown at consent |

A registration has a **developer account** — an ordinary Free2Z account —
and that account is where markup is credited.

## 3. Redirect URIs

The IdP accepts three shapes for a public client, following RFC 8252 §7, and
one for a confidential client.

| Shape | Form | Notes |
|---|---|---|
| **Loopback** | `http://127.0.0.1:{port}/{path}` or `http://[::1]:{port}/{path}` | Register with any port (for example `http://127.0.0.1:0/callback`); the IdP ignores the port when matching (RFC 8252 §7.3). `localhost` as a name is **not** accepted — it may resolve off-device. Desktop apps use this |
| **Claimed `https`** | `https://tutor.example.com/oauth/callback` | A universal link (iOS) or App Link (Android) the app has proven it controls. The IdP verifies the domain association file at registration time and again daily; a URI whose association is missing is refused at authorization time with `invalid_request` |
| **Private-use scheme** | `com.example.tutor:/oauth/callback` | The scheme MUST be a reverse-DNS name the developer controls (RFC 8252 §7.1). One slash after the colon, as the RFC recommends. This is the **fallback** on iOS and Android when a claimed link is not available |
| **`https` (confidential)** | `https://api.example.com/oauth/callback` | Server-side apps only |

Mobile guidance, both platforms equal:

- **iOS:** `ASWebAuthenticationSession` with the claimed universal link as the
  callback; the private-use scheme as fallback.
- **Android:** Custom Tabs with the App Link as the callback; the private-use
  scheme as fallback.
- Neither platform embeds a web view for sign-in. An embedded web view is
  refused by policy (RFC 8252 §8.12) and by the IdP where it can detect one.

A redirect URI never carries a query string of its own, so the IdP appends
`?code=…&state=…&iss=…` unambiguously.

## 4. Scopes

| Scope | Grants | Token audience |
|---|---|---|
| `openid` | An ID token; the `sub` claim | — |
| `profile` | `preferred_username`, `name`, `picture` in the ID token and at `userinfo_endpoint` | — |
| `email` | `email`, `email_verified` | — |
| `offline_access` | A refresh token (§8). Without it, the session ends when the access token expires | — |
| `balance:read` | `GET /api/sdk/v1/balance` | `f2z-api` |
| `purchase:create` | `POST /api/sdk/v1/purchases` and the receipt endpoints ([purchase.md](./purchase.md)) | `f2z-api` |
| `ai:invoke` | Every `ai.free2z.cash/v1/*` endpoint ([chat-api.md](./chat-api.md)). Requesting it makes the spend cap part of consent (§5) | `f2z-ai` |

Scopes are space-separated in the `scope` parameter. The IdP returns the
granted set in the token response's `scope` field; a client MUST read it and
not assume it equals the request, because the user may decline scopes at
consent. `openid` is required to receive an ID token; the other scopes work
without it.

## 5. Consent and the grant

The consent screen shows the app's name and developer, the requested scopes
in plain language, the developer markup as a percentage ("this app adds 20 %
to AI prices"), and — when `ai:invoke` is requested — a **spend-cap** control:
an amount and a period.

| Field | Values |
|---|---|
| `spend_cap_m2z` | A whole number of 2Z in milli-2Z (a multiple of `1000`), or `null` for no cap. The user chooses; the app's `default_spend_cap` is only the pre-selection |
| `cap_period` | `day`, `week`, `month` or `total`. Periods are calendar-aligned in UTC (`day` resets at 00:00Z; `week` on Monday 00:00Z; `month` on the 1st). `total` never resets |

The result is a **grant**: (user, app, scopes, cap, generation). One grant
exists per (user, app). Re-authorizing replaces its scopes and cap in place.
The user can inspect, edit or revoke every grant at
`https://free2z.cash/account/apps`:

- **Lowering** a cap or **reducing** scopes takes effect immediately: the cap
  is enforced inside the ledger's hold ([metering.md](./metering.md) §3) and
  scope reduction increments the grant's **generation** (`agen`, §6.3).
- **Raising** a cap requires a recent authentication (step-up, §10). It takes
  effect immediately and does not change `agen`.
- **Revoking** increments `agen` and deletes every refresh token of the
  grant. The next request with any older access token fails with
  `401 token_revoked`.

The IdP re-prompts consent (`prompt=consent` behaviour, even when the client
did not ask for it) when the app's `markup_bps` has increased since the grant
was made, or when requested scopes are not all already granted.

## 6. Access tokens

### 6.1 Format

An access token is a JWS ([RFC 7515](https://www.rfc-editor.org/rfc/rfc7515))
signed with **ES256** (P-256), profiled by RFC 9068.

```
header:  {"alg":"ES256","typ":"at+jwt","kid":"2026-09-a"}
payload: {
  "iss":       "https://free2z.cash",
  "sub":       "u_01J8ZK3Q9V6W0E4H7X2C5N8M1T",
  "aud":       ["f2z-ai", "f2z-api"],
  "client_id": "app_7f3c2e",
  "scope":     "openid profile balance:read ai:invoke",
  "iat":       1790000000,
  "exp":       1790000300,
  "jti":       "019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c",
  "aep":       4,
  "agen":      2,
  "auth_time": 1789999870,
  "acr":       "urn:f2z:acr:mfa",
  "amr":       ["pwd","otp"]
}
```

| Claim | Meaning | Who checks it |
|---|---|---|
| `iss` | Always `https://free2z.cash` | Every resource server, exact string match |
| `sub` | The user's stable, opaque account id. The same for every app (`subject_types_supported: ["public"]`). Never a username or email — those change | — |
| `aud` | **Always a JSON array.** `f2z-ai` for the gateway, `f2z-api` for the account API. Which appear depends on the granted scopes (§4). A resource server MUST refuse a token whose `aud` does not contain its own identifier | Every resource server |
| `client_id` | The app the token was issued to | Resource servers, for rate limits and markup |
| `scope` | Space-separated granted scopes (RFC 9068 §2.2.3) | Resource servers, per endpoint |
| `exp` | `iat + 300`. **Five minutes**, not configurable per app | Every resource server, with at most 30 s of leeway |
| `jti` | Unique per token | Optional replay detection |
| `aep` | **Account epoch** (§6.2) | Every resource server |
| `agen` | **Grant generation** (§6.3) | Every resource server |
| `auth_time`, `acr`, `amr` | When and how the user last authenticated (§10) | Endpoints that require recent or strong authentication |

Resource servers fetch keys from `jwks_uri` and select by `kid`. Keys are
rotated: the JWKS carries the current key and its predecessor for at least 24
hours after a rotation, and a resource server MUST refresh its JWKS cache on
an unknown `kid` (at most once per minute) before refusing the token.

### 6.2 `aep` — the account epoch

Every account has an integer epoch that starts at `1` and **increments on a
security event**: password reset or change, email change, disabling MFA,
removing a passkey, unlinking an identity, merging accounts. It does **not**
change when a method is *added*. Every token carries the epoch at issue time.

A resource server compares the token's `aep` with the account's current
epoch — the platform publishes the current value to resource servers on every
change — and refuses a token whose epoch is behind with `401 token_revoked`.
**If the current epoch cannot be determined, the resource server fails
closed** with `503 revocation_check_unavailable` rather than accepting the
token; a client treats that as retryable.

A stale epoch also invalidates every refresh token of the account; the
token endpoint answers `invalid_grant` and the client must sign the user in
again.

### 6.3 `agen` — the grant generation

Every grant (§5) has an integer generation that starts at `1` and increments
when the grant is revoked or its scopes are reduced. Tokens carry it; a
resource server refuses a token whose `agen` is behind with
`401 token_revoked`, exactly as for `aep`, with the same fail-closed rule.

Between `aep` and `agen`, revocation is effective within the propagation
delay of the epoch publication (target: under one second) rather than the
five-minute token lifetime, and **the ledger re-checks the grant, the epoch
and the cap inside every hold regardless** (ADR 0002), so a race in
propagation can cost latency but never 2Z.

## 7. ID tokens

Issued when `openid` was granted. Signed **RS256**, keyed by `kid` from the
same `jwks_uri` (the JWKS carries both an EC and an RSA key; select by `kid`,
then verify `alg` matches the key type). Claims per OpenID Connect Core §2:
`iss`, `sub`, `aud` (the `client_id`, a string), `exp` (1 hour), `iat`,
`auth_time`, `nonce` (echoed from the request; **`nonce` is required** in
every authorization request that includes `openid`), `acr`, `amr`,
`at_hash`, plus the profile and email claims the granted scopes allow.

The ID token is for the client. It is not accepted by any resource server.

## 8. Refresh tokens

Issued only when `offline_access` was granted.

- **Opaque.** A client MUST NOT parse it.
- **Rotating.** Every use at the token endpoint returns a new refresh token
  and invalidates the one presented. The new access token and the new
  refresh token arrive in the same response.
- **Families.** All tokens descended from one authorization form a family.
  Presenting a refresh token that was already rotated is **reuse**, and
  reuse revokes the whole family: every later refresh in the family fails
  with `invalid_grant`, and the user must sign in again. This is how a stolen
  refresh token is detected — either the thief or the legitimate client will
  eventually present a token the other already used.
- **Lifetime.** A refresh token expires 30 days after it was issued; each
  rotation issues a fresh 30-day token, so an app used at least monthly stays
  signed in. A family has no separate maximum age in v1.
- **Grace for lost responses.** A rotation whose response the client never
  received would otherwise strand it. The IdP therefore accepts the
  *immediately previous* token of a family for **60 seconds** after rotation
  and returns the *same* successor it already issued; a presentation of any
  older token, or of the previous token after the window, is reuse.
- **Single-flight in the client.** An SDK MUST serialise refreshes: one
  refresh in flight per family, with concurrent callers waiting on it. Two
  parallel refreshes are indistinguishable from reuse.
- **Where they live.** In the Rust SDK core, in the OS keychain where one
  exists (macOS Keychain, Windows Credential Manager, the iOS Keychain,
  Android Keystore-backed storage, Secret Service on Linux) with an in-memory
  fallback that the SDK reports. In a Tauri app the refresh token is never
  handed to JavaScript. On the web, refresh tokens are kept in memory only;
  a page reload signs the user in again through the authorization endpoint,
  which is silent when the IdP session is still valid.

Revoking a refresh token at `revocation_endpoint` revokes its family.

## 9. Endpoints and messages

All endpoint URLs come from discovery. The values shown are the current
ones and exist so that the examples are concrete.

### 9.1 Discovery

```http
GET /.well-known/openid-configuration HTTP/1.1
Host: free2z.cash
```

```json
{
  "issuer": "https://free2z.cash",
  "authorization_endpoint": "https://free2z.cash/oauth/authorize",
  "token_endpoint": "https://free2z.cash/api/oauth/token",
  "userinfo_endpoint": "https://free2z.cash/api/oauth/userinfo",
  "jwks_uri": "https://free2z.cash/api/oauth/jwks",
  "revocation_endpoint": "https://free2z.cash/api/oauth/revoke",
  "introspection_endpoint": "https://free2z.cash/api/oauth/introspect",
  "end_session_endpoint": "https://free2z.cash/oauth/logout",
  "response_types_supported": ["code"],
  "response_modes_supported": ["query"],
  "grant_types_supported": [
    "authorization_code",
    "refresh_token",
    "urn:f2z:grant-type:zcash-signature"
  ],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["RS256"],
  "token_endpoint_auth_methods_supported": ["none", "client_secret_basic", "client_secret_post"],
  "code_challenge_methods_supported": ["S256"],
  "scopes_supported": ["openid", "profile", "email", "offline_access",
                       "balance:read", "purchase:create", "ai:invoke"],
  "claims_supported": ["sub", "iss", "aud", "exp", "iat", "auth_time", "nonce",
                       "acr", "amr", "preferred_username", "name", "picture",
                       "email", "email_verified"],
  "acr_values_supported": ["urn:f2z:acr:1fa", "urn:f2z:acr:mfa"],
  "authorization_response_iss_parameter_supported": true,
  "revocation_endpoint_auth_methods_supported": ["none", "client_secret_basic"],
  "introspection_endpoint_auth_methods_supported": ["client_secret_basic"]
}
```

### 9.2 Authorization request

```
https://free2z.cash/oauth/authorize
  ?response_type=code
  &client_id=app_7f3c2e
  &redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fcallback
  &scope=openid%20profile%20offline_access%20balance%3Aread%20ai%3Ainvoke
  &state=af0ifjsldkj
  &nonce=n-0S6_WzA2Mj
  &code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
  &code_challenge_method=S256
```

Rules:

- `state` is required and MUST be at least 128 bits of entropy; the client
  MUST verify it on return.
- `nonce` is required when `scope` contains `openid`.
- `code_verifier` MUST be 43–128 characters (RFC 7636 §4.1), generated fresh
  per request, and never leave the client until the token request.
- Optional: `prompt` (`none`, `login`, `consent`), `max_age` (seconds),
  `acr_values`, `login_hint`, `ui_locales`.
- The authorization code is single-use and expires after **60 seconds**.

### 9.3 Authorization response

Success:

```
http://127.0.0.1:49152/callback?code=SplxlOBeZQQYbYS6WxSbIA&state=af0ifjsldkj&iss=https%3A%2F%2Ffree2z.cash
```

The client MUST verify `iss` equals `https://free2z.cash` (RFC 9207) and
`state` equals what it sent, before using `code`.

Error (RFC 6749 §4.1.2.1): `error`, `error_description`, `state`, `iss`.
The errors a client should expect to handle: `access_denied` (the user
declined), `invalid_scope`, `login_required` and `consent_required` (with
`prompt=none`), `interaction_required`, and `invalid_request` for a redirect
URI whose claim could not be verified.

### 9.4 Token request

Authorization code, public client:

```http
POST /api/oauth/token HTTP/1.1
Host: free2z.cash
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=SplxlOBeZQQYbYS6WxSbIA
&redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fcallback
&client_id=app_7f3c2e
&code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
```

Refresh:

```http
POST /api/oauth/token HTTP/1.1
Host: free2z.cash
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=8xLOxBtZp8
&client_id=app_7f3c2e
```

A refresh MAY carry a `scope` that is a subset of the granted scopes to
receive a narrower access token; it can never widen.

Zcash sign-in, `grant_type=urn:f2z:grant-type:zcash-signature`: an extension
grant in which the client proves control of a Zcash address by signing an
IdP-issued challenge. It is available only to apps registered with
`allow_zcash_assertion`. **Its parameters are reserved in v1 and specified in
a later revision of this document**; discovery advertises the grant type so
that clients can detect support.

Success (RFC 6749 §5.1):

```json
{
  "token_type": "Bearer",
  "access_token": "eyJhbGciOiJFUzI1NiIsInR5cCI6ImF0K2p3dCIsImtpZCI6IjIwMjYtMDktYSJ9...",
  "expires_in": 300,
  "refresh_token": "3qkdY3m9v2c...",
  "scope": "openid profile offline_access balance:read ai:invoke",
  "id_token": "eyJhbGciOiJSUzI1NiIsImtpZCI6IjIwMjYtMDktciJ9..."
}
```

Errors (RFC 6749 §5.2): `invalid_request`, `invalid_client`,
`invalid_grant` (bad or used code, bad verifier, redirect mismatch, refresh
reuse, stale epoch, revoked grant), `unauthorized_client`,
`unsupported_grant_type`, `invalid_scope`. Every `invalid_grant` on a refresh
means "sign in again"; the client SHOULD NOT retry it.

### 9.5 Revocation

```http
POST /api/oauth/revoke HTTP/1.1
Host: free2z.cash
Content-Type: application/x-www-form-urlencoded

token=3qkdY3m9v2c...&token_type_hint=refresh_token&client_id=app_7f3c2e
```

Always `200` (RFC 7009 §2.2). Revoking a refresh token revokes its family.
Revoking an access token is accepted and is a no-op beyond its five-minute
life; use `end_session_endpoint` or the account's app list to revoke a
grant.

### 9.6 Userinfo

`GET userinfo_endpoint` with `Authorization: Bearer <access_token>`. Returns
`sub` and the claims the granted scopes allow. Requires `openid`.

### 9.7 Introspection

RFC 7662, confidential clients only. Returns `active`, `scope`, `client_id`,
`sub`, `exp`, `iat`, `aud`, `aep`, `agen`. Native clients never need it: a
resource server validates the JWT locally.

## 10. Step-up authentication

Some operations require that the user authenticated **recently**, or with
**more than one factor**, regardless of the token's validity. In the SDK's
scope that is: raising a spend cap, and any account-security change made
through an app. The rule is the same everywhere:

1. The resource server answers **`401`** with an RFC 9470 challenge:

   ```http
   HTTP/1.1 401 Unauthorized
   WWW-Authenticate: Bearer error="insufficient_user_authentication",
     error_description="Raising a spend cap requires authentication within the last 5 minutes",
     max_age="300"
   ```

   or, when a second factor is required rather than recency,
   `acr_values="urn:f2z:acr:mfa"`. Both may appear. The body is the standard
   error envelope with `code: insufficient_user_authentication`
   ([errors.md](./errors.md)).

2. The client runs a **new authorization request** (§9.2) carrying the
   challenged `max_age` and/or `acr_values`, plus `prompt=login` when
   `max_age` is present. Because the IdP session usually still exists, the
   user sees only the factor prompt.

3. The new access token carries a fresh `auth_time` and the achieved `acr`;
   the client repeats the original request with it.

`acr` values: `urn:f2z:acr:1fa` (one factor) and `urn:f2z:acr:mfa` (a
second factor was used, or a passkey with user verification, which counts as
MFA). `amr` values follow [RFC 8176](https://www.rfc-editor.org/rfc/rfc8176)
where one exists — `pwd`, `otp`, `hwk` (passkey), `mfa` — plus
`urn:f2z:amr:federated` for a linked provider sign-in and
`urn:f2z:amr:zcash-signature`.

The IdP **fails closed**: an operation that requires recent authentication
refuses when `auth_time` is absent from the session rather than assuming it
is recent.

## 11. Client checklist

An SDK is conformant when every line here holds. The IdP's conformance
suite exercises the same list from the other side.

- Reads discovery; hard-codes only the issuer.
- Uses `S256`; generates a fresh verifier, `state` and `nonce` per request.
- Verifies `iss` and `state` on the authorization response before
  exchanging the code.
- Verifies the ID token's signature, `iss`, `aud`, `exp` and `nonce`.
- Treats the access token as opaque. (It is a JWT for the *resource
  server's* benefit; a client that reads `exp` to schedule a refresh MAY do
  so, and MUST still handle `401 invalid_token` when the clock was wrong.)
- Stores the refresh token where §8 says; never exposes it to app code in a
  Tauri app; never persists it on the web.
- Refreshes single-flight; on `invalid_grant`, clears the session and
  reports "signed out" rather than retrying.
- On `401 token_revoked`, clears the session — the grant or the account
  changed underneath it.
- On `401 insufficient_user_authentication`, runs the step-up flow of §10 and
  retries once.
- On `503 revocation_check_unavailable`, retries with backoff; does not sign
  the user out.
- Opens the system browser or the platform's authentication session for
  sign-in; never an embedded web view.

## 12. What the IdP guarantees to a resource server

- Every access token it issues is verifiable from `jwks_uri` alone.
- `aep` and `agen` are monotonic per account and per grant, and the current
  values are published to resource servers on every change.
- A token's `scope` never exceeds the grant's scopes at issue time; a token's
  `aud` never includes an audience no granted scope requires.
- `auth_time` is the real time of the last interactive authentication, not
  the time of token issue.
