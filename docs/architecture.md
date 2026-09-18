# The three-app architecture

How `cash.free2z.zuuli`, `cash.free2z.free2z` and `cash.free2z.e2e2z` divide
authority, why the division exists, and what mechanically enforces it.

Issues: [#904](https://github.com/free2z/zuu/issues/904) (the split),
[#367](https://github.com/free2z/zuu/issues/367) (the driver),
[#905](https://github.com/free2z/zuu/issues/905) (the bridge),
[#461](https://github.com/free2z/zuu/issues/461) (closed association-declaration history;
transport remains in #905).

Companion documents. This page deliberately does **not** restate them:

- [`intent-bridge/PROTOCOL.md`](./intent-bridge/PROTOCOL.md) — the wire format
  and both implementations.
- [`intent-bridge/AUTHORITY.md`](./intent-bridge/AUTHORITY.md) — what ZUULI does
  with an admitted intent.
- [`intent-bridge/CALLER-AUTHENTICATION.md`](./intent-bridge/CALLER-AUTHENTICATION.md)
  — who is calling, per platform, and what cannot be established.
- [`intent-bridge/CONFORMANCE.md`](./intent-bridge/CONFORMANCE.md) — every guard
  and the mutation that proves its test is not inert.
- [`e2ee/ARCHITECTURE.md`](./e2ee/ARCHITECTURE.md) — the account-key /
  device-key separation this split rests on.
- [`status.md`](./status.md) — what is actually working today.

---

## 1. The driver

ZUULI was one Tauri app, one window, one WebView, holding the Zcash seed and
rendering third-party content: article embeds, the Cloudflare RealtimeKit
livestream SDK, remote images, AI output.

**[#367](https://github.com/free2z/zuu/issues/367).** Wry injects Tauri's bridge
scripts into **every** frame (`setOf("*")`, ignoring the `main_only` flag), and
its Android IPC reports the *top-level* URL rather than the requesting frame. A
remote subframe therefore resolves as the trusted main window and can invoke
privileged commands. Reported upstream separately.

**[#816](https://github.com/free2z/zuu/issues/816) /
[#818](https://github.com/free2z/zuu/issues/818).** The packaged CSP blocked
RealtimeKit's first request and broke Join Free — a runtime failure mode that
exists only because a privileged WebView renders third-party code.

The generalisation: **any embed policy permissive enough to be useful is too
permissive to sit next to seed access.** `frame-src 'none'` works today
precisely because the feature was given up.

### Why not sandbox inside one app

This was the preferred option and it does not hold where the threat is:

- [tauri#11528](https://github.com/tauri-apps/tauri/issues/11528) — multiple
  webviews are desktop-only, behind an unstable feature flag.
  [tauri#11794](https://github.com/tauri-apps/tauri/issues/11794) (`add_child`
  on mobile) is also open.
- Multi-*window* on mobile needs Android 12L / API 32; our `minSdk` is 29.
- Even at API 32, Android launches a separate activity onto the back stack and
  iPhone replaces the UI. On a phone the UX cost of another window already
  equals another app — so the single-app argument evaporates exactly where the
  vulnerability lives.

## 2. The principle

**The wallet is a signing authority. Every other surface holds only delegated,
scoped, revocable credentials — never the seed.**

This was already our design.
[`e2ee/ARCHITECTURE.md`](./e2ee/ARCHITECTURE.md) §4.2 separates **account keys**
(seed-derived, restorable: `CeremonySigningKey`, `DirectoryAuthKey`,
`BackupWrapKey`) from **device keys** (OS CSPRNG, never seed-derived, never
exported: `DeviceSignatureKey`, `DeviceInitKey`, `QueueKey_{q}`), bound by a
`DeviceCredential` implemented in
`rs/crates/f2z-msg-identity/src/credential.rs`.

The consequence is what makes a third app cheap rather than a compromise:
**ongoing messaging never needs the seed — only enrollment does.** The same
shape generalises; signing a login challenge is an attestation, not a spend.

One seed root stays fine — one backup phrase, one identity — **provided the root
never leaves the wallet app.**

Three surfaces and not two, so that the dangerous one holds **neither** spending
authority **nor** messaging keys.

## 3. The three surfaces

| | [`cash.free2z.zuuli`](../wallet/zuuli/) | [`cash.free2z.free2z`](../wallet/free2z/) | [`cash.free2z.e2e2z`](../wallet/e2e2z/) |
| --- | --- | --- | --- |
| Role | wallet authority | content | messaging |
| Holds | master seed, spending keys, account-level messaging keys | Knox token, 2Z balance | device keys + device credential |
| Renders remote content | never | **yes** — articles, creator, live, AI, search | never |
| Privileged plugins | `zcash` | **none** | `f2zmsg` |
| Bundle `active` | `true` | `true` (native layer landed in [#942](https://github.com/free2z/zuu/pull/942), closing #918) | `true` |

### 3.1 What makes the content surface safe

Not its CSP. **Its dependency list, and its empty IPC surface.**

`wallet/free2z/src-tauri/src/lib.rs` registers **no `invoke_handler` at all**
and links neither `tauri-plugin-zcash` nor `tauri-plugin-f2zmsg`; its capability
files carry no `zcash:*` and no `f2zmsg:*` entry. Under #367 a remote subframe
in that process resolves as the trusted main window — and finds nothing
privileged to call. A CSP is a policy that can be relaxed under product
pressure; an absent command cannot be invoked.

### 3.2 What the messaging surface holds

`wallet/e2e2z/src-tauri/Cargo.lock` contains **zero Zcash crates** — no
`zcash_*`, no `orchard`, no `sapling`. It registers `tauri-plugin-f2zmsg` and
five app commands: `e2e2z_device_credential_keys` opens this device's contact
queue at the relay and returns the **public** halves of an OS-CSPRNG device key
set together with the endpoint the relay issued (ADR 0017 §4.1),
`e2e2z_install_device_credential` installs the signed credential,
`e2e2z_retry_device_unlock` reopens this device's seal,
`e2e2z_enrollment_status` reads what this device's store holds — asking the log
whether the entry has merged while it has not — and `e2e2z_dispatch_intent`
hands an `issue-device-credential-v2` request to ZUULI's verified App Link.
None accepts or derives account keys.

ZUULI's three app-crate enrollment commands — `f2zmsg_enrollment_status`,
`f2zmsg_enroll`, `f2zmsg_unenroll` — are deliberately absent here. In ZUULI they
borrow the seed from `tauri-plugin-zcash`'s managed state in-process
([`e2ee/CLIENT-CONTRACT.md`](./e2ee/CLIENT-CONTRACT.md) §2.2). There is no seed
here to borrow, so enrollment is a bridge call: on iPhone and Android e2e2z
asks ZUULI for a credential over the App Link transport (#1019) and installs
it (#1022). A build without that transport (desktop, a browser) still refuses
with a typed error rather than synthesising an `EnrollmentStatus` nobody
published.

### 3.3 What the wallet authority does not have

`wallet/zuuli/src-tauri/src/intent.rs` handles intents, and `receive_intent` is
**not** a `#[tauri::command]` and appears in no capability. #367 is precisely
that the WebView's frames are not separated from one another, so a command
turning caller-supplied bytes into a payment confirmation would be the deputy
that issue is about. A test reads `lib.rs` and fails if anything from the module
reaches the invoke handler.

**One thing the intent path does add to the invoke surface, and what bounds
it.** `free2z_session_sync` (ADR 0017 §4.1) lets the WebView publish the
signed-in free2z session into a native slot, because an intent arrives from the
operating system with no argument to carry a Knox token on. It is write-only —
it answers `()`, and a test asserts this module exposes no command that hands a
token back — but it is a *write*, and an app-crate command is not
capability-gated, so under #367 anything reaching the invoke bridge can write
it. ZUULI's CSP forbids frames (`frame-src 'none'`), so that means an XSS in
ZUULI's own origin rather than a hostile embed. What bounds the damage is the
publishing path rather than the command: it resolves **which account** the
session belongs to before it discloses anything, names that account in the
native confirmation, and reads the seed and sends `identity_pk` only after an
approval. A session somebody else wrote therefore costs a declined dialog, and
a declined or ignored request leaks nothing about the wallet.

## 4. What enforces the boundary

The split is worth nothing if it is a convention. "free2z has no wallet
capability" is a property a one-line edit can quietly reverse, and the edit
looks like every other capability edit. Three checks run inside the **required**
`gate` in [`.github/workflows/zuuli.yml`](../.github/workflows/zuuli.yml), whose
change detector selects `wallet/free2z/**` and `wallet/e2e2z/**`:

| Check | What it refuses |
| --- | --- |
| [`wallet/zuuli/scripts/surface-capability-authority.mjs`](../wallet/zuuli/scripts/surface-capability-authority.mjs) | any `zcash:*`/`f2zmsg:*` entry in free2z, any `zcash:*` entry or blanket `f2zmsg:default` in e2e2z, and linking a forbidden plugin. Capability files are enumerated off the filesystem, so a new one cannot escape by being added |
| [`wallet/zuuli/scripts/project-boundary.mjs`](../wallet/zuuli/scripts/project-boundary.mjs) | an import crossing between wallet applications in either direction, and a second client-side implementation of the intent guards outside `wallet/shared/src/intent` |
| `rust_fmt` / `rust_clippy` / `rust_deny` | crate **discovery**, not a list — both new `src-tauri` crates were gated from their first commit |

Each app's Rust crate also asserts its own manifest in a unit test, so the
property is stated where the violation would be written as well as centrally.

Each surface's own suite — typecheck, vitest, ui-copy and Playwright, including
`wallet/e2e2z/tests/enrollment-gap.pw.ts` — runs in `zuuli.yml`'s `surfaces` job,
which the required gate awaits (#915). Their Tauri backends are compiled and
tested by
[`.github/workflows/wallet-surfaces.yml`](../.github/workflows/wallet-surfaces.yml),
which publishes no gate — deliberately. What keeps those surfaces unprivileged
is the required gate above, not their own build.

## 5. How the surfaces talk

Over the versioned [intent bridge](./intent-bridge/PROTOCOL.md). Four families
are defined; **three are implemented on the authority side.**

| Intent | The request carries | ZUULI does | Returns | Authority side |
| --- | --- | --- | --- | --- |
| `execute-payment` | recipient, amount, memo, fee | re-derives and shows its **own** payment review | txid or refusal | **implemented** |
| `issue-device-credential` | device **public** keys, handle, validity window | derives account keys, confirms natively | `DeviceCredential` | **implemented** (#1019); publishes nothing |
| `issue-device-credential-v2` | the same, plus the contact endpoint the device opened | establishes whose handle it is, confirms natively naming the **authority's** handle, signs and submits the `DirectoryEntry`, verifies the receipt | `DeviceCredential` | **implemented** (ADR 0017 §4.1) |
| `sign-challenge` | challenge bytes, purpose, claimed caller | *(designed)* confirm natively | signature | refused, `INTENT_UNKNOWN_INTENT` |

`sign-challenge`'s refusal is deliberate and the status is not a lie: this
build genuinely does not implement it. Version 1 of the credential family stays
implemented and its wire vector stays frozen, because builds already in
testers' hands send it; what it cannot do is publish the device, which is why
version 2 exists and carries an endpoint only the requesting device knows.

Two invariants the format itself enforces: **the seed never appears in a
message** — there is no field it could occupy — and **device private keys never
leave their app**. One the pipeline enforces: **nothing here is a continuous
grant**; every intent is one-shot, expires on two clocks within five minutes,
and is bound to one approval of one rendering.

Where the code lives:

| Half | Path |
| --- | --- |
| the rules | `rs/crates/f2z-intent` |
| the authority | `wallet/zuuli/src-tauri/src/intent.rs` |
| the one client implementation | `wallet/shared/src/intent` (`@free2z/wallet-shared`) |
| callers | `wallet/free2z/src/lib/bridge/`, `wallet/e2e2z/src/lib/enrollment/` |

**Ordering was a decision, not an accident.** Strength runs strong for
`execute-payment`, medium for `issue-device-credential`, weak for
`sign-challenge` — a challenge is an opaque nonce that confirms nothing to the
person approving it, so shipping it first because it "only signs" is backwards.
[`AUTHORITY.md`](./intent-bridge/AUTHORITY.md) §3 has the full argument.

## 6. What is not built yet

Read [`status.md`](./status.md) rather than inferring from this page. In short:
there is **no transport** ([#905](https://github.com/free2z/zuu/issues/905));
#461 closed after client association declarations landed, without implementing
the channel.
`sign-challenge` has neither a caller nor an authority-side implementation.
Both credential families now have both halves — e2e2z asks over the App Link
transport and ZUULI answers, and version 2 also publishes the device in the
directory and keeps the log's receipt — but **no build is configured to reach a
log or a relay**: `internal-directory.conf` ships placeholders, so a shipping
e2e2z refuses at the contact queue and a shipping ZUULI has nothing to publish
to. What [#928](https://github.com/free2z/zuu/issues/928) closed is the install
step, and #1019 and ADR 0017 §4.1 closed the two above it. Free2Z's native layer landed in
[#942](https://github.com/free2z/zuu/pull/942), closing #918; its production
HTTP capability remains scoped and stateless, without wallet or device-key
authority. ZUULI's phase-4 hardening is in progress.
