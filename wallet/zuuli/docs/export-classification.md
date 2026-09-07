# Export classification record — ZUULI (`cash.free2z.zuuli`)

> **Status: facts assembled. Nothing here is a determination.**
>
> This document is the engineering half of [#961](https://github.com/free2z/zuu/issues/961)
> for ZUULI: an inventory of the cryptography that actually ships, measured from
> the dependency graph rather than assumed. **Corpora approves the
> classification basis and export counsel resolves the legal points.** Every
> proposal below is labelled as a proposal and carries its own
> counter-argument. No value of `ITSAppUsesNonExemptEncryption`,
> `iosUsesNonExemptEncryption`, or any CI assertion about them was changed by
> the work that produced this file.
>
> It extends, and does not replace,
> [`releasing.md` § Release records for cryptography](./releasing.md#release-records-for-cryptography),
> which remains the runbook's own record of the answer given to App Store
> Connect. Companion records:
> [e2e2z](../../e2e2z/docs/export-classification.md),
> [free2z](../../free2z/docs/export-classification.md).

## 1. The finding that matters most

ZUULI's recorded basis says its non-OS cryptography "uses published,
non-proprietary algorithms and is **limited to its Zcash wallet and
financial-transaction functionality**."

**That second clause no longer describes the binary.** Since
[#750](https://github.com/free2z/zuu/issues/750) (merged 2026-08-25), ZUULI
links `tauri-plugin-f2zmsg` and the messaging-core crates, and its iOS
dependency graph contains the complete MLS end-to-end-encrypted messaging
engine — OpenMLS, HPKE, and X-Wing hybrid post-quantum key establishment
(X25519 + ML-KEM-768) — identical to e2e2z's. `wallet/zuuli/release.json`
records build 20; the messaging plugin has been in the source of every build
from 16 onward.

Two qualifications, both real:

- **Most of it is unreachable from the WebView.** After
  [#916](https://github.com/free2z/zuu/issues/916), no capability grants any
  `f2zmsg:` permission, so the plugin's 43 commands are registered but cannot
  be invoked from the frontend (`wallet/zuuli/src-tauri/src/lib.rs`).
- **The enrollment trio is reachable and does real cryptography.**
  `f2zmsg_enroll`, `f2zmsg_enrollment_status` and `f2zmsg_unenroll` are
  app-crate commands routed by `generate_handler!`, which bypasses the
  capability ACL. Enrollment derives the seed-based messaging key hierarchy and
  issues a signed `DeviceCredential` — it is in ZUULI and not in e2e2z
  precisely because it needs the wallet seed
  ([#904](https://github.com/free2z/zuu/issues/904)).

Whether "linked but mostly unreachable" changes the export answer is a legal
question. What is not in question is that the *recorded basis* is now narrower
than the *shipped binary*, and `releasing.md` itself sets that as the trigger
to revisit: "Re-evaluate this declaration before shipping any proprietary or
non-standard cryptography, or **any material change to how encryption is
used**."

## 2. How this inventory was measured

Measured at `origin/main` `28f09c6c`, on the iOS release target, with build
scripts, proc-macro-only paths and dev-dependencies excluded:

```
git submodule update --init z/zcash/librustzcash
cd wallet/zuuli/src-tauri
cargo tree --locked --edges normal --target aarch64-apple-ios --prefix none
```

501 packages resolve. The JavaScript bundle was checked separately:
`wallet/zuuli/package.json` and its lockfile contain **no** cryptographic
library. The frontend's only cryptography is WebCrypto — see §3.6.

## 3. What ships in the release binary

### 3.1 Zcash shielded protocol — bundled, and the largest block

All reached through `tauri-plugin-zcash` → the librustzcash path dependencies in
`z/zcash/librustzcash`.

| Crate | Version | Primitive / role |
|---|---|---|
| `zcash_primitives`, `zcash_protocol`, `zcash_keys`, `zcash_client_backend`, `zcash_client_sqlite`, `zcash_transparent`, `pczt`, `zip321` | path deps | The protocol implementation itself |
| `sapling-crypto` | 0.7.0 | Sapling note/spend/output circuits and key agreement |
| `zcash_proofs` | 0.30.0 | Groth16 proving and verification, Sapling parameter loading |
| `bellman`, `bls12_381`, `pairing`, `jubjub`, `group`, `ff` | 0.14.0 / 0.8.0 / 0.23.0 / 0.10.0 | **Groth16 zk-SNARK** over the **BLS12-381** pairing curve; Jubjub for in-circuit arithmetic |
| `orchard` | 0.15.3 | Orchard actions, Sinsemilla and Poseidon hashes |
| `halo2_proofs`, `halo2_gadgets`, `halo2_poseidon`, `pasta_curves` | 0.3.2 / 0.5.0 / 0.1.0 / 0.5.1 | **Halo 2** proof system over the **Pallas/Vesta** cycle |
| `redjubjub`, `reddsa` | 0.8.0 / 0.5.2 | **RedDSA / RedJubjub / RedPallas** — re-randomisable Schnorr signatures for spend authorisation |
| `zcash_note_encryption` | 0.4.2 | Note encryption: **ChaCha20-Poly1305** AEAD with a **BLAKE2b** KDF (ZIP 212) |
| `chacha20poly1305`, `chacha20`, `poly1305`, `aead`, `cipher`, `universal-hash` | — | The AEAD implementation beneath it |
| `aes`, `cbc`, `fpe` | 0.8.4 / 0.1.2 / 0.6.1 | **FF1 format-preserving encryption over AES** — Sapling diversifier derivation (ZIP 32), *not* bulk data encryption |
| `blake2b_simd`, `blake2s_simd`, `blake2` | 1.0.4 / 1.0.4 / 0.10.6 | **BLAKE2b/BLAKE2s** — Zcash's pervasive hash and PRF construction |
| `zcash_spec` | 0.2.1 | The BLAKE2b-based PRF/KDF constructions the protocol specifies |
| `equihash` | 0.3.0 | Equihash proof-of-work verification |
| `zcash_script`, `secp256k1`, `secp256k1-sys` | 0.4.5 / 0.29.1 / 0.10.1 | Transparent-pool **ECDSA over secp256k1**, consensus script verification |
| `ripemd`, `sha1`, `sha2` | 0.1.3 & 0.2.0 / 0.10.7 & 0.11.0 / 0.10.9 & 0.11.0 | **RIPEMD-160**, **SHA-256** — transparent address and script hashing |
| `zip32` | 0.2.1 | ZIP 32 shielded hierarchical key derivation |
| `bip32` (free2z fork, rev `131d490e`) | 0.6.0-pre.1 | **BIP-32** transparent key derivation. The fork holds `secp256k1` at 0.29 and is documented as transient in the app manifest |
| `bip0039`, `pbkdf2`, `password-hash` | 0.12.0 / 0.12.2 / 0.5.0 | **BIP-39** mnemonic → seed, i.e. **PBKDF2-HMAC-SHA-512** |
| `bech32`, `f4jumble`, `zcash_address`, `zcash_encoding` | 0.11.1 / 0.1.1 / 0.13.0 / 0.4.0 | Address encoding — Bech32/Bech32m and F4Jumble. Encoding, not cryptography |
| `secrecy`, `zeroize`, `subtle` | 0.8.0 / 1.9.0 / 2.6.1 | Secret hygiene and constant-time comparison |

**Purpose:** financial-transaction confidentiality and authorisation — shielded
note encryption, zero-knowledge proof generation and verification, spend
authorisation signatures, and hierarchical key derivation from the user's seed.

### 3.2 Messaging — bundled, and identical to e2e2z's

Reached through `tauri-plugin-f2zmsg` plus the four crates ZUULI names directly
(`f2z-msg-identity`, `f2z-kt-core`, `f2z-codec`, `f2z-msg-mls`).

`openmls 0.9.0`, `openmls_libcrux_crypto 0.4.0`, `hpke-rs 0.7.0`,
`hpke-rs-libcrux 0.7.0`, `libcrux-kem 0.0.9`, **`libcrux-ml-kem 0.0.10`**,
`libcrux-curve25519`/`-ecdh`, `libcrux-chacha20poly1305`/`-poly1305`/`-aead`/`-aes`,
`libcrux-sha2`/`-sha3`, `libcrux-hkdf`/`-hmac`/`-hmac-drbg`, `libcrux-ed25519`,
`libcrux-p256`, `ed25519-dalek` 2.2.0 and 3.0.0, `curve25519-dalek` 4.1.3 and
5.0.0, `hkdf`, `hmac`, `blake3` (via `akd_core` → `f2z-kt-core`), `tls_codec`.

The ciphersuite is a single compile-time constant,
`MLS_256_XWING_CHACHA20POLY1305_SHA256_Ed25519`. **Full detail, including the
unregistered-codepoint problem, is in
[e2e2z's record §3.1 and §4](../../e2e2z/docs/export-classification.md#31-message-confidentiality--mls-bundled)** —
it is not repeated here, because it is the same code.

**Purpose in ZUULI specifically:** identity and device-credential issuance
(authentication/signing) is reachable; message confidentiality is in the binary
but not reachable from the WebView today.

### 3.3 Transport — bundled TLS, three stacks

| Crate | Version | Reached through | Role |
|---|---|---|---|
| `rustls` | 0.23.42 | `tonic` (lightwalletd gRPC), `reqwest`/`hyper-rustls` (`tauri-plugin-http`, `tauri-plugin-zcash`), `tokio-tungstenite` (relay), `ureq` (key transparency) | **TLS 1.2/1.3** client |
| `rustls` | **0.21.12** | `minreq` → `zcash_proofs` | A **second, older** TLS stack, used to fetch Sapling proving parameters |
| `ring` | 0.17.14 | `rustls` | rustls's default crypto provider |
| `rustls-webpki` | 0.101.7, 0.103.13 | `rustls` | X.509 path validation |
| `rustls-platform-verifier` | 0.7.0 | `tauri-plugin-zcash`, `ureq` | Delegates certificate trust to the **OS** trust store |
| `webpki-roots` | 0.25.4, 0.26.11, 1.0.9 | `minreq`, `tokio-tungstenite`, `reqwest` | **Bundled** Mozilla root store on those paths |
| `tokio-rustls`, `hyper-rustls`, `tokio-tungstenite` | — | — | TLS/WebSocket glue |

**Purpose:** transport confidentiality to lightwalletd, to the free2z API, to
the messaging relay and key-transparency service, and to the proving-parameter
host. That three TLS client stacks and three root stores ship in one binary is
worth recording as an inventory fact; it is a supply-chain observation, not an
export one.

### 3.4 At-rest seed custody — OS-supplied, with one bundled legacy decoder

- **iOS** — Keychain via `Security.framework`, with
  `SecAccessControlCreateWithFlags`,
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, `.userPresence`, and
  `LAContext` for Face ID (`wallet/plugins/tauri-plugin-zcash/ios/Sources/ZcashPlugin.swift`;
  `NSFaceIDUsageDescription` is in `Info.ios.plist`). Service
  `cash.free2z.zuuli.seed.v1`, `kSecAttrSynchronizable = false`.
- **Android** — `AndroidKeyStore` with `setUserAuthenticationRequired(true)`.
- **Desktop** — `keyring 3.6.3` (`apple-native`, `linux-native-sync-persistent`
  + `crypto-rust`, `windows-native`).
- **Messaging wrap key** — a second, deliberately unprivileged custody layer in
  `tauri-plugin-f2zmsg/src/custody.rs`, namespace
  `cash.free2z.zuuli.f2zmsg.wrap.v1`, with the *opposite* accessibility policy
  (`AfterFirstUnlock`, no user presence) because background delivery has to
  work with the screen locked.
- **One bundled cipher, read-only.**
  `wallet/plugins/tauri-plugin-zcash/src/wallet/keychain.rs`'s `legacy_file`
  module decrypts a **ChaCha20-Poly1305** seed file from a removed file-based
  fallback. It is a migration *decoder* — the module comment says "There is
  deliberately no `store`" — and it is not `cfg`-gated, so it compiles into
  every target including iOS.

**Purpose:** at-rest key sealing. Overwhelmingly Apple-OS-supplied; the one
bundled cipher exists only to read data written by a version that no longer
ships.

### 3.5 Copy protection

None. No DRM, no licence enforcement, no anti-tamper cryptography.

### 3.6 Apple-OS-supplied cryptography (not bundled)

- Keychain / `Security.framework` / `LocalAuthentication`, as above.
- Certificate trust via `security-framework` on the `rustls-platform-verifier`
  paths.
- **WebCrypto in the WebView**, which is WebKit's and therefore the OS's:
  `crypto.subtle.digest("SHA-256", …)` and `crypto.getRandomValues` in
  `wallet/zuuli/src/lib/oauth/protocol.ts` implement **PKCE (RFC 7636)** for
  desktop and mobile OAuth, and `crypto.getRandomValues` /
  `crypto.randomUUID` supply idempotency keys and nonces elsewhere.
- All WebView-initiated HTTPS (page loads, media) uses the system networking
  stack.

## 4. Standards status of each primitive

| Primitive | Standards body / citation | Accepted? |
|---|---|---|
| TLS 1.3 / 1.2 | IETF RFC 8446 / RFC 5246 | Yes |
| AES; AES-based FF1 | NIST FIPS 197; NIST SP 800-38G | Yes |
| ChaCha20-Poly1305 | IETF RFC 8439 | Yes |
| SHA-2 | NIST FIPS 180-4 | Yes |
| RIPEMD-160 | ISO/IEC 10118-3 | Yes |
| HMAC / HKDF | IETF RFC 2104, FIPS 198-1 / RFC 5869 | Yes |
| PBKDF2 | IETF RFC 8018; NIST SP 800-132 | Yes |
| BLAKE2b / BLAKE2s | IETF RFC 7693 | Yes |
| ECDSA over secp256k1 | ECDSA: NIST FIPS 186-5, ISO/IEC 14888-3. The **curve** is SEC 2 (Certicom/SECG), not a NIST curve | Partly — see below |
| Ed25519 / X25519 | IETF RFC 8032, FIPS 186-5 / RFC 7748 | Yes |
| HPKE | IETF RFC 9180 | Yes |
| MLS | IETF RFC 9420 | Yes |
| ML-KEM-768 | NIST FIPS 203 | Yes |
| **X-Wing hybrid KEM** | IETF CFRG **Internet-Draft** — not an RFC | **Not yet** |
| **MLS ciphersuite `0x004D`** | `draft-ietf-mls-pq-ciphersuites` — **not an IANA assignment** | **No** |
| **Groth16 over BLS12-381** | Academic construction; BLS12-381 has only an expired CFRG draft. Specified by the **Zcash Protocol Specification** and ZIPs | **No standards body** |
| **Halo 2 over Pallas/Vesta** | Same — open, published, non-proprietary, but no IETF/NIST/ISO standard | **No standards body** |
| **RedDSA / RedJubjub / RedPallas** | Zcash Protocol Specification | **No standards body** |
| **Sinsemilla, Poseidon, Equihash** | Academic / Zcash Protocol Specification | **No standards body** |
| BIP-32 / BIP-39 / Bech32 / Bech32m | Bitcoin Improvement Proposals — open community specifications | **No standards body** |
| BLAKE3 | Published specification, no standard | No |

**This table is the sharpest thing in this document.** ZUULI's recorded basis
claims its algorithms are "published, non-proprietary", which is true and
verifiable. It does **not** claim they are "accepted as international
standards", which is the phrase Apple's third tier turns on. For the Zcash
proving stack those are genuinely different claims: Groth16, Halo 2, RedDSA,
Sinsemilla and Poseidon are open, peer-reviewed and widely deployed, and are
specified in a public protocol document — and none of them is an IETF, NIST or
ISO standard. Whether "accepted by international standards bodies" covers an
open non-proprietary specification of that kind is a legal reading, and
engineering should not supply it.

## 5. Post-quantum: shipping today, not planned

Hybrid post-quantum key establishment — X25519 + **ML-KEM-768** via X-Wing — is
in ZUULI's shipping binary today, through the messaging engine, unconditionally
and not behind a flag. It is *reachable* only via enrollment (§1); it is
*present* regardless.

Nothing in the Zcash side is post-quantum. Every signature in either half —
Zcash spend authorisation, MLS leaf, identity, device, KT log — remains
classical. Post-quantum signatures are future work
([#316](https://github.com/free2z/zuu/issues/316)).

## 6. Proposed ASC questionnaire answer — a proposal for review

**Proposal.** The technical facts supporting the current `false` have changed
since it was recorded, and the basis should be **restated** rather than
reaffirmed. The restatement engineering can support is: *ZUULI's non-OS
cryptography uses published, non-proprietary algorithms and serves (a) its Zcash
wallet and financial-transaction functionality and (b) an end-to-end encrypted
messaging engine whose identity/enrollment path is reachable and whose message
path is not exposed to the WebView in this build.* Whether that still lands on
`false` is for Corpora and counsel.

**Reasoning for `false` surviving.** Nothing proprietary or of our own invention
ships. The transport tier is ordinary TLS. The at-rest tier is overwhelmingly
Apple's own Keychain. The wallet tier implements a public protocol
specification. The messaging tier is RFC 9420 with RFC-and-FIPS primitives.
Apple's middle tier — industry-standard encryption implemented outside Apple's
OS — requires only a French declaration where the app is distributed in France.

**The strongest counter-arguments.**

1. **The recorded basis is now false as written.** "Limited to its Zcash wallet
   and financial-transaction functionality" does not describe a binary
   containing a complete MLS messenger. If the original answer rested on an
   EAR exemption for banking or money transactions, that reasoning does not
   reach the messaging engine, and "it is mostly unreachable from the WebView"
   is an argument about *exposure*, not about what the binary *contains*.
2. **The Zcash proving stack is not "industry standard" in Apple's sense.**
   Open and published is not the same as accepted by an international standards
   body (§4). A strict reading could put the shielded-protocol cryptography
   outside the middle tier — which would be the most consequential single
   finding in this record.
3. **BIS reporting is a separate question.** Apple's documentation requirement
   and U.S. self-classification duties are different obligations; `false`
   answers only the first, and both a cryptocurrency wallet and an E2EE
   messenger are categories where the second is worth checking.
4. **Twenty accepted builds prove Apple's acceptance, nothing more.** Not a
   government classification, and not evidence that the basis was ever reviewed
   against the current binary.

## 7. What a human still has to decide

1. **Does the recorded basis need restating now that messaging ships in
   ZUULI?** `releasing.md`'s own re-evaluation trigger appears to have fired.
   *(Owner, with counsel.)*
2. **Does "published, non-proprietary" satisfy Apple's "accepted as
   international standards" for the Zcash proving stack (Groth16/BLS12-381,
   Halo 2/Pallas, RedDSA, Sinsemilla, Poseidon, Equihash)?** *(Counsel.)*
3. **Does linking-but-not-exposing the MLS message path change the answer?**
   *(Counsel.)*
4. **Which EAR route applies, and is anything owed to BIS?** This record
   deliberately asserts no ECCN. *(Counsel.)*
5. **Is France in ZUULI's intended territory availability?** **Not determinable
   from the repository** — `release.json` and `store-identity.json` carry no
   territory field, no workflow sets one, and availability is configured in App
   Store Connect. If France is in scope, the French declaration applies under
   the middle tier. *(Owner.)*
6. **Were builds 16–20 uploaded, and under the old basis?** The repository shows
   the messaging plugin in the source of builds 16 onward; which builds actually
   reached App Store Connect is a store-side fact this record cannot establish.
   *(Owner.)*
