# ZUULI mobile OAuth and claimed-link release gate

ZUULI uses the system browser for social OAuth. Providers return to the exact
Free2Z relay `https://free2z.cash/api/auth/social/mobile/callback`; that relay
consumes provider state once and returns the authorization result to the app.
The provider callback and app callback are intentionally different endpoints.

The reviewed app-link contract is:

| Contract | Exact value |
| --- | --- |
| Bundle/package ID | `cash.free2z.zuuli` |
| Transition callback | `cash.free2z.zuuli://oauth/callback` |
| Claimed callback | `https://free2z.com/oauth/callback` |
| Apple application ID | `F9AV5HKF6N.cash.free2z.zuuli` |
| Apple associated domain | `applinks:free2z.com` |
| Android host/path | `free2z.com` + `/oauth/callback` |

`wallet/zuuli/mobile-oauth-links.json` is the canonical rollout record. During
`private-transition`, native projects register both exact targets but new OAuth
attempts still request the private URI. The callback parser accepts only the
target stored with the pending state, so a backend mistake or competing link
handler cannot move an attempt between channels. Strict state, app-held PKCE,
session binding, crash-safe recovery, and one-shot redemption remain unchanged.
The verifier also requires `activeRedirectUri` and both compiled
`MOBILE_REDIRECT_URI` aliases to match the rollout, so changing only the label
cannot accidentally bless a build that still uses the transition callback.
The app callback deliberately uses `free2z.com`, not the provider relay's
`free2z.cash` host: Safari keeps a same-domain Universal Link in the browser,
while Apple recommends a different associated host for sign-in handoffs.
Safari also suppresses app launches from server-initiated OAuth redirects. For
claimed flows the relay therefore returns a no-store confirmation page on
`free2z.cash`; the user must tap its single cross-domain **Continue to ZUULI**
link. That real user gesture targets the exact claimed URI. A 3xx, meta refresh,
or script redirect is not an equivalent implementation and must not replace it.

## Domain association requirements

The production HTTPS origin must return direct HTTP 200 responses, with a valid
certificate, no redirect, and `Content-Type: application/json`:

- `/.well-known/apple-app-site-association` containing only application ID
  `F9AV5HKF6N.cash.free2z.zuuli` and component path `/oauth/callback`;
- `/.well-known/assetlinks.json` containing only package
  `cash.free2z.zuuli`, relation `delegate_permission/common.handle_all_urls`,
  and the final Google Play **App Signing** SHA-256 certificate fingerprint(s).

Do not use the Android debug, local release, or upload-key fingerprint. With
Play App Signing, the certificate distributed to users is managed by Google
and its fingerprint comes from Play Console. The tuzi companion is
free2z/tuzi#977; its Digital Asset Links endpoint returns 503 while that value
is absent or malformed.

iOS carries the `com.apple.developer.associated-domains` entitlement. Before a
signed build can ship, enable Associated Domains for the App ID and regenerate
the App Store provisioning profile so it contains the same entitlement. The
protected release preflight and IPA verifier require that exact entitlement but
accept the regenerated profile's new well-formed UUID; the profile name, Team
ID, application ID, protected bytes, and authorized signer remain pinned. The
repository's known Team ID is not a substitute for that portal operation.

The exact `/oauth/callback` browser fallback must be `no-store`, omit codes and
states from its body, and use the protected no-access-log edge backend. A
browser reaching it means OS link verification failed; it must never attempt a
web OAuth completion.

## Automated gates

Run from `wallet/zuuli`:

```sh
npm run oauth-links:verify
npm run test:oauth-links
```

The normal release verifier runs the repository consistency check. It permits
`private-transition`, keeping internal Play/TestFlight work unblocked while
the external association is deployed.

A public-store release must instead run:

```sh
SOURCE_SHA="$(git rev-parse HEAD)"
ZUULI_OAUTH_DEVICE_EVIDENCE=/secure/path/device-evidence.json \
  npm run oauth-links:verify-public -- --source-sha="$SOURCE_SHA"
```

That command fails closed unless rollout is `claimed`, device evidence names the
exact `--source-sha` being promoted, at least one strict Play
App Signing fingerprint is committed, both live association documents match
the exact reviewed unambiguous JSON without redirects or duplicate keys, and
the evidence JSON records:

- exact 40-character ZUU and tuzi commits;
- claimed URI and Apple application ID;
- Android distributed signing fingerprint;
- `userInitiatedHandoff: true` after exercising the reviewed confirmation tap;
- `cold: true` and `warm: true` for signed physical iOS and Android tests.

Evidence metadata belongs in the release-candidate record, not source control
when it contains device/operator details. Never record codes, states, tokens,
provider secrets, or session material.

## Signed-device proof matrix

On a signed iOS 18+ device and Android 10+ device, test each platform cold
(force-quit while the browser is open) and warm (app backgrounded). Confirm the
relay confirmation renders no secrets outside its single link, tapping
**Continue to ZUULI** opens ZUULI through the claimed HTTPS callback, completes
exactly once, and never shows the fallback page. Also verify cancellation, replay, changed session,
wrong state, duplicate code/state, wrong host/path, fragment, and expiry all
fail without exchange.

After production adoption is demonstrated and supported installed versions no
longer need the private URI, remove it in a separate reviewed change from the
frontend constant, Rust allowlist, Tauri config, Android manifest, iOS URL type,
and tuzi allowlist. Do not remove it in the same rollout that first enables the
claimed link.
