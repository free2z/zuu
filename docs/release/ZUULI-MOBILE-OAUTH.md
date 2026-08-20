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
- The tuzi companion change #1260 exposes transport-specific discovery and the
  one-destination HTTPS relay,
  consumes provider callbacks exactly once, binds the returned code, accepts
  only the canonical app URI for PKCE providers, and preserves the exact
  desktop loopback shape. It does not enable a capability or provider.

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

The backend rollout in free2z/tuzi#1260 must be deployed before this preflight
can pass. At the time this client change was prepared, the production mobile
discovery path still resolved to an authenticated legacy route and returned
HTTP 403, while the generic endpoint reported desktop X ready. That is an
external activation blocker, not evidence of live mobile success.

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
