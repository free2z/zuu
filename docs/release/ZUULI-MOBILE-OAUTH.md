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

The Free2Z capability contract is the release assertion, while
`/api/auth/social/providers/` controls which sign-in buttons render. Safe
defaults keep the capability false and the relay unset. Provider credentials do
not by themselves enable the path: mobile `/start` fails closed while the relay
is unset. Mobile accepts only X and Google after an operator completes the
backend rollout checklist; their authorization URLs must contain PKCE S256.
GitHub OAuth Apps do not offer PKCE and therefore remain desktop/web-only.

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
- The tuzi companion change #903 exposes the one-destination HTTPS relay,
  consumes provider callbacks exactly once, binds the returned code, accepts
  only the canonical app URI for PKCE providers, and preserves the exact
  desktop loopback shape. It does not enable a capability or provider.

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
