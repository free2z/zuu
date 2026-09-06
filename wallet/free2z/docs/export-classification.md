# Export classification record — free2z (`cash.free2z.free2z`)

> **Status: facts assembled. Nothing here is a determination.**
>
> This document is the engineering half of [#961](https://github.com/free2z/zuu/issues/961)
> for the content surface: an inventory of the cryptography that actually ships,
> measured from the dependency graph rather than assumed. **Corpora approves the
> classification basis and export counsel resolves the legal points.** Every
> proposal below is labelled as a proposal and carries its own
> counter-argument. No value of `iosUsesNonExemptEncryption` or any CI assertion
> about it was changed by the work that produced this file.
>
> Companion records: [ZUULI](../../zuuli/docs/export-classification.md),
> [e2e2z](../../e2e2z/docs/export-classification.md).

## 1. Current standing

`wallet/free2z/release.json` pins `iosUsesNonExemptEncryption: false` and
`release.schema.json` fixes it as `"const": false`. **There is no
`Info.ios.plist` for this app yet** — `wallet/free2z/src-tauri/` contains no
plist at all — so nothing is asserted to Apple until one is generated, and the
first upload is the moment the declaration is made.

No basis has ever been recorded for this app. The only recorded basis in the
tree is ZUULI's, which is tied to wallet and financial-transaction
functionality; free2z has neither.

**The one thing that must not be assumed:** free2z has no wallet and no
messaging plugin, and it is nevertheless **not** an Apple-OS-only app. It
bundles a TLS implementation. That is the finding this record exists to make
explicit.

## 2. How this inventory was measured

Measured at `origin/main` `28f09c6c`, on the iOS release target, with build
scripts, proc-macro-only paths and dev-dependencies excluded from the shipped
set:

```
cd wallet/free2z/src-tauri
cargo tree --locked --edges normal --target aarch64-apple-ios --prefix none
```

258 packages resolve — the smallest of the three surfaces. The JavaScript bundle
was checked separately: `wallet/free2z/package.json` and its lockfile contain no
cryptographic library.

## 3. What ships in the release binary

### 3.1 The whole of it: one bundled TLS client

| Crate | Version | Reached through | Primitive / role |
|---|---|---|---|
| `rustls` | 0.23.43 | `reqwest` 0.12.28 → `tauri-plugin-http` 2.6.0 | **TLS 1.2/1.3** (RFC 8446 / RFC 5246) client |
| `ring` | 0.17.14 | `rustls`, `rustls-webpki` | rustls's default crypto provider: **AES-GCM**, **ChaCha20-Poly1305**, ECDHE (X25519, P-256/384), ECDSA and RSA signature *verification*, **SHA-2**, **HMAC/HKDF** |
| `rustls-webpki` | 0.103.15 | `rustls` | X.509 certificate path validation |
| `webpki-roots` | 1.0.9 | `reqwest`, `hyper-rustls` | **Bundled** Mozilla root store — trust anchors ship in the binary rather than coming from the OS |
| `hyper-rustls` | 0.27.9 | `reqwest` | TLS glue for the HTTP client |
| `tokio-rustls` | 0.26.5 | `reqwest`, `hyper-rustls` | Async TLS glue |
| `subtle` | 2.6.1 | `rustls` | Constant-time comparison |
| `zeroize` | 1.9.0 | `rustls` | Secret hygiene |
| `getrandom` | 0.2/0.3/0.4 | various | OS CSPRNG boundary (`SecRandomCopyBytes` / `getentropy` on Apple) |

The dependency edge is explicit in `wallet/free2z/src-tauri/Cargo.toml`:

```toml
tauri-plugin-http = { version = "2.5.9", default-features = false, features = [
    "rustls-tls",
    "http2",
    "charset",
    "macos-system-configuration",
] }
```

`"rustls-tls"` is the line that puts a bundled TLS implementation in this
binary. `default-features = false` drops only the cookie jar, for the ambient-
authority reason the manifest documents; it does not affect the crypto.

**Purpose:** transport confidentiality, and nothing else. The client's reach is
URL-scoped by `wallet/free2z/src-tauri/capabilities/default.json` to
`https://free2z.cash/*`, `https://*.free2z.cash/*`, `https://free2z.com/*` and
`https://*.free2z.com/*`. free2z authenticates with a bearer token in an
`Authorization` header; it holds no long-term key material of its own.

### 3.2 Compile-time only — not in the shipped binary

`sha2 0.10.9` appears in the graph solely under `tauri-codegen` →
`tauri-macros`, a **proc-macro** that runs during compilation to hash bundled
assets. It is not linked into the application binary. Recorded here so that a
future reader who greps the crate list does not mistake it for shipped
cryptography.

### 3.3 Not in this binary, by construction

`tauri-plugin-zcash` and `tauri-plugin-f2zmsg` are **absent and must stay
absent** — the content surface renders third-party markup, embeds and remote
media, so linking either would put a privileged command in the invoke handler
that [#367](https://github.com/free2z/zuu/issues/367)'s frame confusion could
reach. `wallet/zuuli/scripts/surface-capability-authority.mjs` enforces the
capability half. Consequently free2z contains **no** proving system, **no**
signing keys, **no** message encryption, **no** key derivation, and **no**
secret store.

### 3.4 Apple-OS-supplied cryptography

- **All WebView traffic.** Page loads, images, video, and the
  `@cloudflare/realtimekit` live-media SDK all run inside WKWebView and use the
  system networking stack — including WebRTC's DTLS-SRTP for live sessions,
  which is WebKit's implementation, not ours. free2z bundles no media or
  WebRTC cryptography.
- **WebCrypto.** `wallet/free2z/src/lib/oauth/protocol.ts` uses
  `crypto.subtle.digest("SHA-256", …)` and `crypto.getRandomValues` to
  implement **PKCE (RFC 7636)** for OAuth; `crypto.getRandomValues` and
  `crypto.randomUUID` supply nonces and idempotency keys in
  `features/live/membership.ts` and `features/articles/article-drafts.ts`.
  These are WebKit's WebCrypto, i.e. the OS's.
- **Certificate trust on the WebView path** comes from the OS trust store; on
  the `tauri-plugin-http` path it comes from the bundled `webpki-roots`
  instead. This asymmetry is worth recording precisely because it is the
  difference between "OS-only" and "not OS-only".

### 3.5 Copy protection

None. No DRM, no licence enforcement, no anti-tamper cryptography. Article and
media access control is server-side authorisation over TLS, not client-side
cryptography.

## 4. Standards status of each primitive

Every primitive in this binary is standards-accepted; there is no draft
construction and no unregistered codepoint anywhere in free2z.

| Primitive | Standards body / citation | Accepted? |
|---|---|---|
| TLS 1.3 / TLS 1.2 | IETF RFC 8446 / RFC 5246 | Yes |
| AES-GCM | NIST FIPS 197; NIST SP 800-38D | Yes |
| ChaCha20-Poly1305 (in TLS) | IETF RFC 8439; RFC 7905 | Yes |
| ECDHE — X25519, P-256, P-384 | IETF RFC 7748; NIST FIPS 186-5 / SP 800-56A | Yes |
| ECDSA / RSA (verification only) | NIST FIPS 186-5; IETF RFC 8017 | Yes |
| SHA-2 | NIST FIPS 180-4 | Yes |
| HMAC / HKDF | IETF RFC 2104, FIPS 198-1 / RFC 5869 | Yes |
| X.509 path validation | IETF RFC 5280 | Yes |
| PKCE (WebCrypto path, OS-supplied) | IETF RFC 7636 | Yes |

## 5. Post-quantum

**None, today or planned.** No ML-KEM, no X-Wing, no hybrid key exchange, no
post-quantum signatures anywhere in this binary. rustls 0.23 with the `ring`
provider does not enable a hybrid group by default, and nothing in this
manifest turns one on.

This is stated explicitly because e2e2z and ZUULI both *do* ship hybrid
post-quantum key establishment today, and a reader moving between the three
records should not carry that across.

## 6. Proposed ASC questionnaire answer — a proposal for review

**Proposal.** free2z uses encryption. It is **not** limited to encryption
supplied by Apple's OS, because `tauri-plugin-http`'s `rustls-tls` feature
bundles a complete TLS implementation and a bundled root store. Everything it
bundles is standards-accepted (§4) and is used exclusively for transport
confidentiality to first-party hosts. On Apple's three-tier table that places it
in the **middle tier** — industry-standard encryption implemented outside
Apple's OS — which requires a **French declaration where the app is distributed
in France**, and no CCATS and no Apple document upload. On that reading the
pinned `false` is plausibly correct, but for a reason that has to be recorded
rather than assumed, and the French question has to be answered before the
first upload.

**Reasoning.** This is the simplest of the three assessments by a wide margin.
One purpose (transport), one library family (rustls + ring), zero
non-standard constructions, zero key custody, zero at-rest encryption, zero
post-quantum, zero proprietary algorithms.

**The strongest counter-arguments.**

1. **"It's only HTTPS" is a conclusion, not a fact.** The middle tier still
   carries the French declaration obligation, and free2z's `false` was pinned
   before anyone established that it belongs in the middle tier rather than the
   top one. The value happens to be plausible; the process that produced it did
   not check.
2. **A trivially small change moves the app.** Removing `rustls-tls` in favour
   of `native-tls` would arguably make free2z genuinely Apple-OS-only; adding
   any client-side encryption feature would move it the other way. Nothing in
   CI notices either. If the classification is going to depend on this one
   Cargo feature, that dependency should be recorded where the next person
   editing that manifest will see it.
3. **BIS reporting is a separate question** from Apple's documentation
   requirement, even for an app whose only cryptography is TLS.
4. **The plist does not exist yet.** `release.json` says `false`, but the app
   has no `Info.ios.plist`. Whatever is decided must be written into the plist
   the generator produces, and the CI assertion for this app has to be created,
   not merely reused from ZUULI's.

## 7. What a human still has to decide

1. **Is the middle tier the right tier, and is `false` the right value?**
   *(Owner, with counsel.)*
2. **Is France in free2z's intended territory availability?** **Not determinable
   from the repository.** `wallet/free2z/release.json` carries no territory or
   availability field, there is no `store-identity.json` for this app, and no
   workflow sets one; territory availability is configured in App Store Connect.
   If France is in scope, the French declaration applies under the middle tier.
   *(Owner.)*
3. **Does anything have to be filed with BIS for a transport-only app?** This
   record deliberately asserts no ECCN. *(Counsel.)*
4. **Should the decision be pinned to the `rustls-tls` feature in CI?** If the
   basis is "bundled but standards-accepted transport crypto only", then a
   future change that adds a second purpose should fail a check rather than
   pass silently. *(Owner — engineering can implement whichever answer is
   given.)*
5. **Google Play's own export questions** are out of scope for this record.

Once decided, `Info.ios.plist` must be created with the agreed value,
`release.json` and `release.schema.json` must agree with it, and a bundle
assertion equivalent to `.github/workflows/e2e2z-release.yml`'s must be added
for this app.
