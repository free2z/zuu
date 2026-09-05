# Status of the three-app split

What works, what fails closed on purpose, and what is blocked. Last derived
against `main` on **2026-09-04**.

This page exists so that no other page has to hedge. If something here
contradicts a claim elsewhere in the repository, this page is the one that was
checked against the tree — and the other page is a bug.

> **The one-line summary.** The three apps exist, build, and are held apart by
> the required CI gate. **No intent can cross between them**, because there is
> no transport. Every cross-app feature you can see in the UI stops at a single
> named seam and says so.

Per-app detail stays in the per-app documents:
[`wallet/zuuli/STATUS.md`](../wallet/zuuli/STATUS.md),
[`wallet/free2z/README.md`](../wallet/free2z/README.md),
[`wallet/e2e2z/README.md`](../wallet/e2e2z/README.md).

---

## 1. What works

| | Evidence |
| --- | --- |
| Three apps exist as buildable Tauri projects with distinct identifiers | `wallet/{zuuli,free2z,e2e2z}/src-tauri/tauri.conf.json` |
| free2z has **no** privileged capability and **no** IPC surface at all | `wallet/free2z/src-tauri/src/lib.rs` registers no `invoke_handler`; its `Cargo.toml` links neither wallet plugin |
| e2e2z holds **no** Zcash code | `wallet/e2e2z/src-tauri/Cargo.lock` contains zero `zcash_*`/`orchard`/`sapling` crates |
| Those two properties are enforced, not asserted | `wallet/zuuli/scripts/surface-capability-authority.mjs`, run by `npm run test` inside the required `zuuli / frontend` gate job |
| No import crosses between wallet applications | `wallet/zuuli/scripts/project-boundary.mjs`, same gate |
| One versioned wire format, agreed byte-for-byte by two implementations | the same 130-byte vector pinned by hand in `rs/crates/f2z-intent/tests/wire_vectors.rs` **and** `wallet/zuuli/src/lib/intent-bridge.test.ts` |
| Every bridge guard has a mutation-verified test | [`intent-bridge/CONFORMANCE.md`](./intent-bridge/CONFORMANCE.md) |
| `execute-payment` is implemented end-to-end **on ZUULI's side of the seam** | `wallet/zuuli/src-tauri/src/intent.rs` — admit, propose, re-derive the review, confirm natively, bind, execute |
| Content surfaces are ported to free2z: articles, creator, live, AI, search | `wallet/free2z/src/features/` |
| The messaging surface is ported to e2e2z | `wallet/e2e2z/src/features/messages/` |
| Both delegated surfaces have CI build coverage | `.github/workflows/wallet-surfaces.yml` |

Merged for the split, in order: [#909](https://github.com/free2z/zuu/pull/909)
scaffolds · [#911](https://github.com/free2z/zuu/pull/911) intent protocol ·
[#919](https://github.com/free2z/zuu/pull/919) CI gate ·
[#914](https://github.com/free2z/zuu/pull/914) ZUULI authority side ·
[#913](https://github.com/free2z/zuu/pull/913) messaging → e2e2z ·
[#912](https://github.com/free2z/zuu/pull/912) articles/creator → free2z ·
[#920](https://github.com/free2z/zuu/pull/920) live/AI/search → free2z ·
[#926](https://github.com/free2z/zuu/pull/926) e2e2z caller ·
[#924](https://github.com/free2z/zuu/pull/924) free2z caller.

## 2. What fails closed, by design

These are built, validated, tested — and then refuse. That is the intended
behaviour today, not an outage.

### 2.1 There is no transport

**Nothing can cross between the apps.** Verified App Links / Universal Links
([#461](https://github.com/free2z/zuu/issues/461)) are not wired, and a
custom-scheme deep link is not an authenticated channel — any app can register
`zuuli://`, so shipping on one would recreate
[#367](https://github.com/free2z/zuu/issues/367)'s confused deputy at the OS
layer instead of the frame layer.

Both callers build a real, validated request and then stop at **one named
seam**:

| Caller | The seam | Behaviour |
| --- | --- | --- |
| `wallet/free2z/src/lib/bridge/intent-transport.ts` | `installedIntentTransport` | rejects with `IntentTransportUnavailableError`, code `INTENT_TRANSPORT_UNAVAILABLE`, reason naming #461 |
| `wallet/e2e2z/src/lib/enrollment/transport.ts` | the single `IntentTransport` implementation | rejects before device keys are sampled, and again unconditionally inside `dispatch` |

Neither seam has a flag, an environment check, or an "if a wallet is installed"
branch — those are the shapes that decay into a channel nobody reviewed.
`rs/crates/f2z-intent` contains no URL parsing, no intent filter and no scheme,
for the same reason. When #461 lands, the work is to write an `IntentTransport`
and register it; nothing else on either path changes.

The creator-tip UI is honest about this: only three outcomes may tell a payer
that nothing was sent — no transport, a request that could not be built, and an
explicit `INTENT_NOT_CONFIRMED` from the wallet. A lost answer or an
`INTENT_UNAVAILABLE` sends the payer to ZUULI to look instead of reassuring
them.

### 2.2 `sign-challenge` has no caller and no implementation

ZUULI refuses it with `INTENT_UNKNOWN_INTENT`, and that status is not a lie:
this build genuinely does not implement it. The ordering is deliberate —
[`AUTHORITY.md`](./intent-bridge/AUTHORITY.md) §3: a challenge is an opaque
nonce that confirms nothing to the person approving it, so absent caller
attestation both "who is asking" and "why" are attacker-chosen. Shipping it
first because it "only signs" is backwards.

The visible consequence today: free2z's **Login with Zcash** is *absent rather
than stubbed behind a button that cannot work*. Password and linked accounts
work; the Zcash method is missing and the login screen says so
(`wallet/free2z/src/features/auth/`).

Anything else that would depend on `sign-challenge` should be expected to be
absent for the same reason. The Profile and revenue-share surfaces have not
been ported yet — that is [#927](https://github.com/free2z/zuu/pull/927), still
open at the time of writing.

### 2.3 e2e2z shows no enrolled state

Every enrollment call refuses with a typed
`EnrollmentUnavailableError { reason: "enrollment-requires-wallet-app" }`
without reaching Tauri IPC, and the screen renders a standing "enrollment
happens in the wallet app" state: no claim control, no conversation list, no
engine start/stop. Nothing synthesises an `EnrollmentStatus` — every field of
one is a claim about the key transparency directory, and a fabricated
`enrolled: true` would show a handle nobody published.

## 3. What is blocked

| Issue | What it blocks |
| --- | --- |
| [**#461**](https://github.com/free2z/zuu/issues/461) | *Everything cross-app.* Verified App Links / Universal Links need `assetlinks.json` and `apple-app-site-association` served from a domain we control |
| [**#928**](https://github.com/free2z/zuu/issues/928) | Enrollment could not complete **even with a transport**: `IssueDeviceCredentialResultV1` carries no `identity_pk` and no `BackupWrapKey`, both of which `install_identity` requires, and e2e2z registers no install command. The obvious fix would ship a seed-derived key into e2e2z, breaching the account/device split — so this is a design question, not a wire-format patch. **Decided in [ADR 0016](./e2ee/decisions/0016-enrollment-sealing-boundary.md)** (2026-09-05): sealing moves to a per-device wrap key, the result type gains no fields, and the install step is an e2e2z app-crate command. Nothing is implemented, and `device_kem_pk` stays open |
| [**#918**](https://github.com/free2z/zuu/issues/918) | free2z's native layer is unwired — the HTTP plugin, the OAuth transport, and its own deep-link scheme. Its bundle is `"active": false` |
| [**#904**](https://github.com/free2z/zuu/issues/904) phase 4 | ZUULI's hardening. See §4 |

**Therefore: no user can claim a messaging handle in any shipped build** until
#461 and #928 both resolve. That is the plainest consequence of the two rows
above and it is stated here so nobody has to derive it.

Also open against the bridge, and worth reading before building on it:
[#929](https://github.com/free2z/zuu/issues/929) (correlation is not
authentication, and two clients now depend on it) and
[#930](https://github.com/free2z/zuu/issues/930) (`INTENT_UNAVAILABLE` does not
mean "nothing happened").

## 4. In progress: hardening ZUULI

[#904](https://github.com/free2z/zuu/issues/904) phase 4. The ports were
**copies**, so removing the content surfaces from ZUULI is a separate step and
is being worked now — do not infer ZUULI's current feature set from this page.

The target state:

- ZUULI renders no third-party content, so it needs no permissive CSP and can
  drop the markdown and embed dependency tree.
- Its capabilities are re-scoped to what a wallet authority actually needs.
- The known hazard recorded on #904 is addressed: the Zcash plugin's seed lock
  is **label-blind** — `WindowEvent::Focused(false)` ignores the label, which is
  harmless with one window and wrong with two.

Until that lands, ZUULI still contains the surfaces that were copied out of it.

## 5. Keeping this page true

This is the page most likely to go stale, which is why the root
[`README.md`](../README.md) points at it rather than restating it. When you
change any of the following, update the corresponding row here in the same pull
request:

- a transport seam stops rejecting;
- an intent family gains an authority-side implementation;
- a delegated surface gains or loses a capability or a plugin;
- an issue in §3 closes.
