# Export classification record — e2e2z (`cash.free2z.e2e2z`)

> **Status: facts assembled. Nothing here is a determination.**
>
> This document is the engineering half of [#961](https://github.com/free2z/zuu/issues/961):
> a per-app inventory of the cryptography that actually ships, measured from the
> dependency graph rather than assumed. **Corpora approves the classification
> basis and export counsel resolves the legal points.** Every proposal below is
> labelled as a proposal and carries its own counter-argument. No value of
> `ITSAppUsesNonExemptEncryption`, `iosUsesNonExemptEncryption`, or any CI
> assertion about them was changed by the work that produced this file.
>
> Companion records: [ZUULI](../../zuuli/docs/export-classification.md),
> [free2z](../../free2z/docs/export-classification.md).

## 1. Why this app cannot inherit ZUULI's basis

`wallet/e2e2z/src-tauri/Info.ios.plist` declares
`ITSAppUsesNonExemptEncryption = false`, `wallet/e2e2z/release.json` pins
`iosUsesNonExemptEncryption: false`, `release.schema.json` fixes it as
`"const": false`, and `.github/workflows/e2e2z-release.yml` asserts it on the
shipped bundle. The declaration is therefore made in-repo and mechanically
frozen; App Store Connect never asks, because the plist key answers at upload
time.

The only recorded basis in the tree is ZUULI's, in
[`wallet/zuuli/docs/releasing.md`](../../zuuli/docs/releasing.md), which says
ZUULI's non-OS cryptography "uses published, non-proprietary algorithms and is
**limited to its Zcash wallet and financial-transaction functionality**." e2e2z
is not a wallet and holds no seed. Its function *is* message confidentiality.
That basis does not describe it, and copying it forward is the specific defect
#961 exists to fix.

## 2. How this inventory was measured

Measured at `origin/main` `28f09c6c`, on the iOS release target, with build
scripts, proc-macro-only paths and dev-dependencies excluded from the shipped
set:

```
cd wallet/e2e2z/src-tauri
cargo tree --locked --edges normal --target aarch64-apple-ios --prefix none
```

360 packages resolve. The JavaScript bundle was checked separately: neither
`wallet/e2e2z/package.json` nor its lockfile contains a cryptographic library,
and `wallet/e2e2z/src/lib/enrollment/deviceKeys.ts` states as a rule that there
is no `crypto.subtle` in this frontend and there must never be one. **All of
e2e2z's cryptography is in the Rust binary or in the OS.**

Re-run the command above after any dependency change; a diff in the crate list
is the trigger to revisit this record.

## 3. What ships in the release binary

### 3.1 Message confidentiality — MLS, bundled

| Crate | Version | Reached through | Primitive / role |
|---|---|---|---|
| `openmls` | 0.9.0 | `f2z-msg-mls` → `tauri-plugin-f2zmsg` | MLS (RFC 9420) group messaging protocol |
| `openmls_libcrux_crypto` | 0.4.0 | `f2z-msg-mls` | The crypto provider; selects libcrux for every primitive |
| `openmls_traits`, `openmls_memory_storage` | 0.6.0 / 0.6.0 | `openmls` | Provider/storage traits |
| `hpke-rs`, `hpke-rs-crypto`, `hpke-rs-libcrux` | 0.7.0 | `openmls_libcrux_crypto`, `openmls` | HPKE (RFC 9180) — MLS welcome/init-key encryption |
| `libcrux-kem`, `libcrux-ml-kem` | 0.0.9 / 0.0.10 | `hpke-rs-libcrux` | **ML-KEM-768** (FIPS 203), the PQ half of X-Wing |
| `libcrux-curve25519`, `libcrux-ecdh` | 0.0.8 | `hpke-rs-libcrux` | **X25519** (RFC 7748), the classical half of X-Wing |
| `libcrux-chacha20poly1305`, `libcrux-poly1305`, `libcrux-aead`, `libcrux-aes` | 0.0.9 / 0.0.6 / 0.0.9 / 0.0.9 | `hpke-rs-libcrux`, `openmls_libcrux_crypto` | **ChaCha20-Poly1305** (RFC 8439) AEAD; AES is linked by the provider but not selected by our ciphersuite |
| `libcrux-sha2`, `libcrux-sha3` | 0.0.8 / 0.0.10 | provider, ML-KEM | **SHA-256/512** (FIPS 180-4), **SHA-3/SHAKE** (FIPS 202) |
| `libcrux-hkdf`, `libcrux-hmac`, `libcrux-hmac-drbg` | 0.0.8 / 0.0.8 / 0.0.1 | provider | **HKDF** (RFC 5869), **HMAC** (RFC 2104 / FIPS 198-1) |
| `libcrux-ed25519` | 0.0.9 | `f2z-msg-mls` (our own `Signer`) | **Ed25519** (RFC 8032) — MLS leaf signatures |
| `libcrux-p256` | 0.0.8 | provider | NIST P-256; linked, not selected by our ciphersuite |
| `tls_codec` | 0.5.0 | `openmls`, `f2z-msg-identity` | RFC 9420 wire encoding (not TLS transport, not cryptography) |

The ciphersuite is a compile-time constant with exactly one value
(`rs/crates/f2z-msg-mls/src/engine.rs`):

```rust
pub const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_256_XWING_CHACHA20POLY1305_SHA256_Ed25519;
```

It is not negotiable and not configurable, and `keypackage.rs` refuses any key
package that names a different one, so a relay cannot downgrade a client.

**Purpose:** message confidentiality and sender authentication, end to end,
between devices. Application payloads travel as MLS `PrivateMessage`
(RFC 9420 §6.3); the relay sees an opaque blob and a queue address.

### 3.2 Identity and key hierarchy — bundled

| Crate | Reached through | Primitive / role |
|---|---|---|
| `ed25519-dalek` 2.2.0 and 3.0.0 | `f2z-msg-identity`, `f2z-kt-core` | **Ed25519** — device credential issuance, directory/queue authentication, KT log signatures |
| `blake2` 0.10.6 | `f2z-msg-identity` | **BLAKE2b-512** (RFC 7693) with a 16-byte personalization — the ZIP 32 idiom used for the seed-derived messaging tree |
| `hkdf` 0.12.4 + `sha2` 0.10.9/0.11.0 | `f2z-msg-identity` | **HKDF-SHA-256** — the four account leaves |
| `blake3` 1.8.7 | `akd_core` → `f2z-kt-core` | BLAKE3 hashing inside the key-transparency (AKD) tree |
| `curve25519-dalek` 4.1.3 and 5.0.0, `signature`, `zeroize`, `subtle` | above | Curve arithmetic, signature traits, secret hygiene, constant-time comparison |

Per-device keys (`DeviceSignatureKey`, the X-Wing `DeviceInitKey`, per-queue
keys) come from the **OS CSPRNG** (`rand` 0.10 in `tauri-plugin-f2zmsg`, over
`getrandom`) and are never seed-derived. e2e2z does not link
`tauri-plugin-zcash` and cannot reach a seed; a build that links it fails
`wallet/e2e2z/scripts/authority-boundary.node-test.mjs`.

**Purpose:** authentication and signing (identity → device binding), plus key
derivation. Not confidentiality.

### 3.3 Transport — bundled TLS

| Crate | Version | Reached through | Role |
|---|---|---|---|
| `rustls` | 0.23.43 | `ureq` → `f2z-kt-client`; `tokio-tungstenite` → `tauri-plugin-f2zmsg` | **TLS 1.2/1.3** (RFC 8446 / RFC 5246) client |
| `ring` | 0.17.14 | `rustls` | rustls's default crypto provider — AES-GCM, ChaCha20-Poly1305, ECDHE, ECDSA/RSA verification, SHA-2, HMAC/HKDF |
| `rustls-webpki` | 0.103.15 | `rustls` | X.509 path validation |
| `rustls-platform-verifier` | 0.7.0 | `ureq` | Delegates certificate trust to the **OS** trust store (`security-framework` on Apple) |
| `webpki-roots` | 0.26.11, 1.0.9 | `tokio-tungstenite` (`rustls-tls-webpki-roots`) | **Bundled** Mozilla root store for the relay WebSocket |
| `tokio-tungstenite` / `tungstenite` | 0.30.0 | `tauri-plugin-f2zmsg` | RFC 6455 WebSocket to the relay |

**Purpose:** transport confidentiality to the relay and to the key-transparency
service. This is the ordinary "HTTPS/TLS" case, with one nuance worth recording:
the TLS *protocol* is bundled (rustls + ring), not Apple's; certificate *trust*
is OS-supplied on the `ureq` path and bundled (webpki-roots) on the WebSocket
path.

### 3.4 At-rest key sealing — OS-supplied on iOS and Android

`tauri-plugin-f2zmsg/src/custody.rs` (ADR 0016 §3, [#937](https://github.com/free2z/zuu/issues/937))
holds one 32-byte `DeviceWrapKey` in the OS secret store:

- **iOS** — Keychain via `Security.framework` (`SecItemAdd`/`SecItemCopyMatching`),
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, no `SecAccessControl`,
  `kSecAttrSynchronizable = false`. See
  `wallet/plugins/tauri-plugin-f2zmsg/ios/Sources/F2zMsgPlugin.swift`. **No
  bundled cipher is involved on iOS.**
- **Android** — an `AndroidKeyStore` **AES-256-GCM** key, non-exportable,
  StrongBox where offered with a TEE then software fallback;
  `javax.crypto.Cipher` with `GCMParameterSpec`. See
  `wallet/plugins/tauri-plugin-f2zmsg/android/src/main/java/F2zMsgPlugin.kt`.
  The cipher is the platform's, not a bundled implementation.
- **macOS / Linux / Windows** — `keyring` 3.6.3 (`apple-native`,
  `linux-native-sync-persistent` + `crypto-rust`, `windows-native`). Not present
  in the iOS graph.

The local message store is `rusqlite`-backed
(`rs/crates/f2z-msg-store`); the group state it holds is OpenMLS's own key
material, sealed under the `DeviceWrapKey` above rather than under a separate
bundled cipher.

### 3.5 Not in this binary

`tauri-plugin-zcash` and the entire librustzcash/Zcash proving stack are
**absent by construction** and enforced by a build gate. e2e2z carries no
Groth16/Halo 2 proving system, no `secp256k1`, no BIP-32/BIP-39, and no wallet
database. Its Cargo manifest documents this as the security boundary
([#904](https://github.com/free2z/zuu/issues/904)).

## 4. Standards status of each primitive

This is the hinge for Apple's middle tier — *industry-standard encryption
implemented outside Apple's OS* requires only a French declaration where the app
is distributed in France, with no CCATS and no Apple document upload.

| Primitive | Standards body / citation | Accepted? |
|---|---|---|
| TLS 1.3 / 1.2 | IETF RFC 8446 / RFC 5246 | Yes |
| ChaCha20-Poly1305 | IETF RFC 8439; in TLS RFC 7905 | Yes |
| AES / AES-GCM (in `ring`, and Android keystore) | NIST FIPS 197; NIST SP 800-38D | Yes |
| SHA-2 | NIST FIPS 180-4 | Yes |
| SHA-3 / SHAKE | NIST FIPS 202 | Yes |
| HMAC | IETF RFC 2104; NIST FIPS 198-1 | Yes |
| HKDF | IETF RFC 5869 | Yes |
| Ed25519 | IETF RFC 8032; NIST FIPS 186-5 | Yes |
| X25519 | IETF RFC 7748 | Yes |
| HPKE | IETF RFC 9180 | Yes |
| MLS protocol | IETF RFC 9420 (architecture: RFC 9750) | Yes |
| ML-KEM-768 | NIST FIPS 203 | Yes |
| BLAKE2b | IETF RFC 7693 | Yes |
| **X-Wing hybrid KEM** | IETF CFRG **Internet-Draft** `draft-connolly-cfrg-xwing-kem` — **not an RFC** | **Not yet** |
| **The MLS ciphersuite codepoint `0x004D`** | `draft-ietf-mls-pq-ciphersuites` — **not an IANA assignment**; registered MLS suites are `0x0001`–`0x0007` | **No** |
| BLAKE3 | Published specification, no IETF/NIST/ISO standard | No |

Two of these deserve the emphasis they are given above, because they are the
only places where "industry standard, accepted by international standards
bodies" is genuinely arguable rather than obvious.

`rs/crates/f2z-msg-mls/src/version.rs` records the codepoint problem in the
source, states that it is a **naming** risk and not a re-key —
[#385](https://github.com/free2z/zuu/issues/385) checked libcrux's X-Wing
draft-06 vectors against the live draft-10 Appendix C vectors and found them
byte-identical — and stores a `ProtocolVersion` beside every group so a
relabel is a migration that can be written. A test asserts
`codepoint_is_registered() == false`.

## 5. Post-quantum: shipping today, not planned

**This is the fact most likely to be got wrong, so it is stated plainly:
hybrid post-quantum key establishment is in the binary that ships today.** It is
not roadmap work and it is not behind a flag.

- **Today, in the shipping binary:** X25519 + **ML-KEM-768** via X-Wing, as the
  MLS KEM, on every group, unconditionally. `docs/e2ee/ARCHITECTURE.md` §5.2:
  "hybrid post-quantum from day one." `libcrux-ml-kem 0.0.10` is in the iOS
  dependency graph via `libcrux-kem` → `hpke-rs-libcrux` →
  `openmls_libcrux_crypto` → `f2z-msg-mls` → `tauri-plugin-f2zmsg` → `e2e2z`.
- **Not today, and listed as future work:** post-quantum *signatures*. Every
  signature in the system — MLS leaf, identity, device, ceremony, KT log — is
  Ed25519. `ARCHITECTURE.md` §5.5 states this as an accepted limitation and
  §13-C lists migration (e.g. ML-DSA) as future work; the roadmap issue is
  [#316](https://github.com/free2z/zuu/issues/316).

A record that describes e2e2z as "planning" post-quantum work would be wrong in
the direction that matters.

One documentation discrepancy worth correcting somewhere: `ARCHITECTURE.md` §5.2
describes the AEAD as "AES-128-GCM (or ChaCha20-Poly1305 where AES is not
hardware-accelerated)". The shipping ciphersuite constant is
ChaCha20-Poly1305 unconditionally, and `provider.rs` has a test named
`the_ciphersuite_uses_chacha20poly1305_and_not_aes_gcm`. **The code, not the
prose, is what this record reports.**

## 6. Proposed ASC questionnaire answer — a proposal for review

**Proposal.** e2e2z uses encryption; it is not limited to encryption supplied by
Apple's OS; and the encryption it bundles is standards-track cryptography used
for message and transport confidentiality. On Apple's three-tier table that
places it in the **middle tier** — industry-standard encryption implemented
outside Apple's OS — which requires a **French declaration where the app is
distributed in France** and no CCATS and no Apple document upload. On that
reading the current `false` may be sustainable, but **for a different reason
than ZUULI's**, and it must be recorded as e2e2z's own basis rather than
inherited.

**Reasoning.** Every primitive that carries confidentiality in this app —
TLS 1.3, ChaCha20-Poly1305, HPKE, X25519, ML-KEM-768, SHA-2, HKDF, Ed25519 — is
an IETF RFC or a NIST FIPS, and the protocol wrapping them is RFC 9420. Nothing
here is a proprietary algorithm of our own invention. The implementations are
third-party open-source libraries (OpenMLS, libcrux, rustls/ring, RustCrypto).

**The strongest counter-argument, and it is not weak.**

1. **The composition is not the standard, even where the parts are.** X-Wing is
   a CFRG Internet-Draft, not an RFC, and the MLS ciphersuite codepoint `0x004D`
   is not an IANA assignment. A reviewer who reads "accepted as international
   standards" strictly can say that the *KEM actually used* is a draft
   construction at an unregistered codepoint — which is closer to Apple's third
   tier ("not accepted as international standards") than the middle one, even
   though X25519 and ML-KEM are each standardised. This is a legal reading
   question about how much aggregation the phrase tolerates, and it is exactly
   the kind of question engineering should not answer.
2. **End-to-end encrypted messaging is the category most likely to carry
   separate U.S. obligations.** Apple's documentation requirement and BIS's
   reporting duties are different questions. Even if the middle tier is right
   and `false` is right for Apple, the EAR mass-market self-classification
   route (annual self-classification report / encryption registration) may
   still apply. Nothing in this repository discharges that, and `false` in the
   plist asserts nothing about it either way.
3. **ZUULI's precedent proves only Apple's acceptance.** ZUULI has shipped 20
   builds with `false`. That is evidence that App Store Connect accepted the
   uploads. It is not a government classification and it is not precedent for a
   messenger.
4. **"Open source" does not settle it.** The messaging crates are MIT and
   public on GitHub. Publication may bear on the analysis; it does not by itself
   resolve the application's status.

## 7. What a human still has to decide

Engineering cannot close any of these. They are listed so the decision is cheap,
not so it is skipped.

1. **Is the middle tier the right tier for e2e2z?** Specifically: does X-Wing at
   an unregistered MLS codepoint count as "industry-standard encryption" for
   Apple's purposes, given that both of its component KEMs are standardised?
   *(Counsel.)*
2. **Is `false` the correct value for `ITSAppUsesNonExemptEncryption`?** Both
   directions need a considered answer — `true` leads to a follow-up exemption
   question that also has to be answered. *(Owner, with counsel.)*
3. **Which EAR route applies, and does anything have to be filed?** Mass-market
   self-classification, ECCN, annual self-classification report, encryption
   registration. This record deliberately asserts no ECCN. *(Counsel.)*
4. **Is France in e2e2z's intended territory availability?** **This cannot be
   determined from the repository.** `wallet/e2e2z/release.json` and
   `store-identity.json` carry no territory or availability field, and no
   workflow sets one; territory availability is configured in App Store Connect
   and is not mirrored here. If France is in scope, the French declaration
   applies under the middle tier. *(Owner.)*
5. **Does the answer have to hold for Google Play too?** Play asks its own
   export-compliance questions and this record covers only the Apple side plus
   the underlying technical facts.
6. **Should the technical facts be re-verified before the first real upload?**
   `dry_run: true` builds, signs and validates without uploading, so it makes no
   declaration; only the first real upload does.

Once decided, the acceptance criteria in
[#961](https://github.com/free2z/zuu/issues/961) require `Info.ios.plist`,
`release.json`, `release.schema.json` and the workflow assertion to agree with
the decision, and the basis to be recorded here rather than left implicit.
