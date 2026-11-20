# ZUULI mobile OAuth verification

ZUULI uses the system browser for social OAuth on every native platform.
Desktop captures the return on an ephemeral, nonce-bearing
`http://127.0.0.1` listener. iOS and Android register exactly:

```text
cash.free2z.zuuli://oauth/callback
```

The app callback is a private-use URI following RFC 8252. Google no longer
supports arbitrary private-scheme provider callbacks and X requires exact
production HTTPS callbacks, so providers return first to the environment's
exact Free2Z relay (production is
`https://free2z.cash/api/auth/social/mobile/callback`). The relay atomically
consumes a provider-only state, binds the code to a distinct app completion
state, and redirects only to the compile-time URI above. It never accepts a
destination from a request. Claimed HTTPS Universal Links / Android App Links
remain the store-grade upgrade tracked in #242; they require the Apple Team ID
and final Android signing-certificate fingerprints.

Provider discovery is transport-specific. Web and Tauri desktop use
`/api/auth/social/providers/`, which reports provider credential readiness.
Tauri iOS and Android use `/api/auth/social/mobile/providers/`, which reports a
provider only when credentials, PKCE support, the exact safe relay, and the
explicit mobile rollout flag are all ready. A native transport-discriminator or
mobile discovery failure fails closed; the client must never fall back to the
generic endpoint. Safe defaults keep every mobile capability false. Provider
credentials do not by themselves enable the path. Mobile accepts only X and
Google after an operator completes the backend rollout checklist; their
authorization URLs must contain PKCE S256. GitHub OAuth Apps do not offer PKCE
and therefore remain desktop/web-only.

The companion backend suppresses nginx logging for the exact relay and redacts
the query from gunicorn/daphne records. Before enabling a provider, verify that
load-balancer/CDN access logs also omit or redact query strings for
`/api/auth/social/mobile/callback`; OAuth codes and states must not be retained
at the edge.

## Automated contract

- Rust tests validate exact scheme + host + path, duplicate parameters,
  malformed callbacks, session binding, ten-minute expiry, crash-safe
  armed-to-received persistence, and the generated Tauri configuration.
- Claim, resume, timeout, and cancellation are scoped to the random completion
  state, so a stale cold-start waiter cannot consume or clear a newer flow.
- TypeScript tests validate the provider authorization host/path allowlist,
  exact redirect/state binding, app-generated PKCE S256, and one-way Knox token
  binding. Only the challenge leaves the app before callback; an app that
  intercepts the private-use URI cannot redeem the code without the verifier.
- The backend contract exposes transport-specific discovery and the
  one-destination HTTPS relay, consumes provider callbacks exactly once, binds
  the returned code, accepts only the canonical app URI for PKCE providers,
  and preserves the exact desktop loopback shape. It does not by itself prove
  that a capability or provider is enabled in a deployed environment.

### Read-only production start preflight

Before a signed-device smoke, verify discovery and the native start responses:

```sh
cd wallet/zuuli
npm ci
npm run verify:social-start
```

This command makes anonymous, credential-free GET requests to production. It
strictly parses both generic and mobile provider discovery, requires X to be
advertised by the matching contract before requesting its representative
desktop and exact mobile starts, and validates the returned authorization URLs
in memory. The production mobile response must name the exact production relay,
a nonempty X client identifier, and the required X identity scopes. It never
opens a provider URL and never calls the OAuth completion
endpoint, so it cannot sign in, link an identity, or mutate an account. A
missing mobile endpoint, disabled rollout flag, missing relay, invalid redirect
policy, or unsafe authorization response makes the command fail. Passing this
preflight is necessary but does not replace the signed-device callback proof
below.

Read-only observation on 2026-11-12: production generic discovery reported
X configured and Google/GitHub unconfigured; mobile discovery returned HTTP 200
with every provider false. This establishes that mobile readiness is not being
advertised. It does not identify which rollout prerequisites are missing and
is not evidence of provider-console setup or a successful device callback.

## Signed-device smoke test

Run this against a non-production Free2Z environment with one Google or X OAuth
client configured for that environment's exact HTTPS relay. Never register the
private app URI with the provider, or put client secrets in the app/repository.

1. Install a signed ZUULI build on one iOS 18+ device and one Android 10+
   device. Confirm the package/bundle ID is `cash.free2z.zuuli`.
2. With ZUULI signed out, tap the configured provider. Confirm Safari/Chrome,
   not an embedded webview, opens the provider's HTTPS authorization page.
3. Approve. Confirm the OS returns to ZUULI and exactly one Free2Z session is
   created. Deliver the same callback URL again; confirm it is rejected and no
   second exchange occurs.
4. Start again, background ZUULI, then approve. Confirm the warm-start callback
   finishes.
5. Start again, force-quit ZUULI while the browser is open, then approve.
   Confirm the callback cold-starts ZUULI and the persisted pending flow
   finishes once.
6. Start an account-link flow, change or clear the Knox session before approval,
   then approve. Confirm the callback is rejected as a changed session and no
   identity is linked to either account.
7. Cancel at the provider. Confirm ZUULI reports cancellation and clears the
   pending flow. Start another flow immediately and confirm it succeeds.
8. Change the callback's state, host, path, duplicate `state`, duplicate `code`,
   add a fragment, and replay an expired callback. Confirm every variant fails
   closed without calling the code-exchange endpoint.
9. Repeat a normal login on macOS/Linux and confirm desktop still uses only an
   ephemeral `127.0.0.1` listener with a 32-hex-character path nonce.

Record device/OS versions, signing identity fingerprints, provider, backend
environment, app commit, backend commit, and screen recording in the release
candidate issue. Do not paste codes, states, tokens, or provider secrets.

## Apple web sign-in (issue #1301)

Apple is a **web-only** provider. It is available on the Free2Z sign-in sheet
and in account settings when configured; native loopback and mobile PKCE
clients must not offer it. This does not enable Google or change the mobile
rollout decision above. Both native discovery parsers tolerate the web-only
Apple row while retaining their native provider set.

The Django integration uses Apple's confidential authorization-code flow with
`response_mode=fragment`, **no name/email scopes**, and a per-attempt nonce.
The exact HTTPS `/oauth/reauth-callback` URI is registered with Apple. Codes
arrive in the browser fragment, which is never sent in an HTTP request URL;
the callback immediately clears history and keeps the code in memory until
its CSRF-protected POST. No cross-site POST callback or CSRF exemption is
needed. The attempt also requires a Secure, HttpOnly, host-only cookie and the
same initiating account/epoch. The popup's sessionStorage state, opener origin,
window and random notification nonce bind the UI return. Concurrent starts
replace the cookie and invalidate the older attempt; restart if needed.

Only the verified `(apple, sub)` identifies a person. The token is checked with
PyJWT against Apple's fixed JWKS endpoint, RS256, exact issuer and Services-ID
audience, expiry, issued-at and required matching nonce. The set cache expires
after five minutes; an unknown key triggers a refresh after PyJWT's 30-second
cooldown. No indefinitely cached signing keys or token-supplied key URLs are
used. The single-use state is consumed before exchange; failed/cancelled,
expired or incorrect-OTP attempts require a new authorization. Apple codes
also expire after five minutes and Apple enforces their single use. Access and
refresh tokens are discarded; Free2Z manages its normal revocable session.

Apple email claims, including private relay, changed, empty or absent email,
are ignored. They cannot sign in to, merge with, or link an existing Free2Z
account by email. New accounts get an unusable password, no recovery email and
a random public username that does not expose the Apple subject. Users may
add a recovery address separately under the existing confirmation policy.
Explicit linking requires the current account's recent authentication and
MFA when enrolled. Apple web unlink sends `provider_uid` in the JSON body of
`POST /api/auth/social/apple/unlink/`, keeping the stable subject out of access-log
URLs. It uses the shared last-usable-login guard and account
epoch/session revocation. Add/reconnect another usable method before removing
the last one. A team/Services-ID transfer needs Apple's separate user-migration
procedure; do not change those identifiers assuming email will reconnect users.

### Operator setup — external acceptance

1. In Apple Developer, use a primary App ID enabled for Sign in with Apple,
   an associated web Services ID and a Sign in with Apple P-256 key. Register
   the web domain and exact `https://<web-host>/oauth/reauth-callback` return URL.
   Do not register localhost, IP/loopback or private-use native callbacks.
2. Install **server-only** `APPLE_CLIENT_ID` (Services ID), `APPLE_TEAM_ID`,
   `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY` (multiline PEM) through the existing
   deployment secret channel. The server signs a five-minute ES256 client
   secret for each exchange. No Apple credential belongs in an app bundle,
   browser environment, URL, screenshot or repository.
3. Set `APPLE_REDIRECT_URIS` to the comma-separated exact registered HTTPS web
   callback URIs. Empty credentials/redirects leave discovery false and start
   and completion return 503 without preventing boot. Configuration presence
   is not proof of successful registration or credentials. After separately
   verifying callback registration, add `apple` to `SOCIAL_WEB_REAUTH_PROVIDERS`
   to offer reauthentication of an already-linked identity.
4. With an owned test account, verify actual Apple consent, code exchange,
   cancellation, existing-account linking, MFA and private/absent email. Check
   edge/application logging does not capture POST bodies or fragments. Keep
   the callback free of analytics that capture location fragments. No live
   provider registration/console changes were performed by the local tests.

As of the issue #1301 local implementation, **signed-device Google acceptance
has not been established**. Repository records contain a smoke procedure, not
successful Google device proof. No connected provider-console/device document
session, `adb` or `xcrun` was available in the implementation environment.
`ZUULI_SOCIAL_AUTH_ENABLED` stays false by default. Do not turn it on based on
unit/browser tests, credential presence or the anonymous start preflight.
Complete the separate provider-console and signed iOS/Android checklist above,
record its build/environment and redacted results, then make the rollout
configuration decision. Apple setup and signed-device Google verification
remain external acceptance requirements.

Primary references checked for this flow:

- [Apple authorization parameters and response modes](https://developer.apple.com/documentation/signinwithapple/incorporating-sign-in-with-apple-into-other-platforms)
- [Apple code exchange](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens)
- [Apple stable subject and optional email](https://developer.apple.com/documentation/signinwithapplejs/authorizationi/id_token)
- [Apple public keys and key selection](https://developer.apple.com/documentation/signinwithapplerestapi/fetch-apple's-public-key-for-verifying-token-signature)
- [Apple client-secret creation (linked from the Sign in with Apple REST overview)](https://developer.apple.com/documentation/accountorganizationaldatasharing/creating-a-client-secret)
- [Apple discovery: RS256 and fixed issuer/endpoints](https://appleid.apple.com/.well-known/openid-configuration)
- [Google web-server redirect registration](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google native app browser/PKCE requirements](https://developers.google.com/identity/protocols/oauth2/native-app)
