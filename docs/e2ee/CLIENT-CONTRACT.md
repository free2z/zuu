# free2z E2EE — Client contract, version 1

**Status:** Phase 2 interface specification. **Nothing described here is
implemented, and no frontend code exists yet.** The backend is being written now;
this document is the interface it will present, published ahead of it so that UI
work can start in parallel.
**Refs:** [#305](https://github.com/free2z/zuu/issues/305) (epic).
**Companion:** [`ARCHITECTURE.md`](./ARCHITECTURE.md),
[`THREAT-MODEL.md`](./THREAT-MODEL.md), [`WIRE.md`](./WIRE.md),
[`KT.md`](./KT.md), [`decisions/`](./decisions/).

This is the document a ZUULI frontend developer, a web developer, or an agent
implements against **without reading any Rust**. Everything a client needs — the
command surface, the TypeScript boundary, the events, the state machines, the
ordering rule, the error union, the rules that must not be broken, and what is
deliberately absent — is here or is linked from here.

It **decides nothing about the protocol.** Every protocol property below is a
restatement of `ARCHITECTURE.md`, `WIRE.md`, `KT.md` or an ADR, cited at the
point of use. Where this document appears to add a property, it is adding a
*client obligation* that the protocol documents already require of an
implementer, expressed as an API. Where a shape is not yet settled it is marked
**PROVISIONAL** and listed in §12 — a contract that lies is worse than one with
a stated gap.

**It is not an implementation.** No TypeScript and no Rust ships from this
document, and the shapes below must not be copy-pasted into a file and called
done. They are the agreement about what the two sides will exchange.

---

## Contents

1. [Scope, and the trust statement that governs everything](#1-scope-and-the-trust-statement-that-governs-everything)
2. [Where each piece lives](#2-where-each-piece-lives)
3. [The command surface](#3-the-command-surface)
4. [The TypeScript contract](#4-the-typescript-contract)
5. [Events](#5-events)
6. [State machines](#6-state-machines)
7. [Ordering](#7-ordering)
8. [`ErrorCode`](#8-errorcode)
9. [THE RULES YOU MUST NOT BREAK](#9-the-rules-you-must-not-break)
10. [What is deliberately not in v1](#10-what-is-deliberately-not-in-v1)
11. [The browser client](#11-the-browser-client)
12. [What is provisional, and what is open](#12-what-is-provisional-and-what-is-open)

---

## 1. Scope, and the trust statement that governs everything

**ZUULI native gets the full guarantees. The browser does not, and the interface
must say so.** ZUULI is a signed native binary with a Rust crypto core, fetched
once from a signed update channel and verifiable out of band, so the strong
claims in [`THREAT-MODEL.md` §5](./THREAT-MODEL.md#5-summary-what-we-claim-precisely)
are made there. A browser fetches the program that performs the encryption from
the same party the encryption is meant to protect against, on every page load;
against a coerced server serving targeted code to one user there is **no
defense** — not a weak one, **none** — and the attack leaves no trace on the
client
([`THREAT-MODEL.md` §3.6](./THREAT-MODEL.md#36-a-coerced-server-serving-targeted-javascript-to-web-clients),
[ADR 0001](./decisions/0001-platform-priority.md)). Therefore the web UI **must
carry a visible statement of its weaker guarantee in the product**, not only in
documentation; high-value operations that create spending authority are
ZUULI-only; and any copy describing the web client's guarantee as equivalent to
ZUULI's is a **defect**, not a wording preference. §11 says what the browser
client must do about this concretely.

**In scope:** the IPC boundary between ZUULI's React frontend and the native
engine, the TypeScript module layout, the events, the observable state machines,
the client-facing error union, and the client obligations that the protocol
documents impose but cannot enforce.

**Not in scope:** the relay wire protocol ([`WIRE.md`](./WIRE.md)), the
key-transparency protocol ([`KT.md`](./KT.md)), MLS itself
([RFC 9420](https://datatracker.ietf.org/doc/html/rfc9420)), the key hierarchy
([`ARCHITECTURE.md` §4](./ARCHITECTURE.md#4-identity-and-the-key-hierarchy)),
and every visual design decision. A frontend developer needs none of those to
build against this document; a backend developer needs all of them.

---

## 2. Where each piece lives

Three layers, and the split is load-bearing rather than organizational.

```
wallet/zuuli/src/lib/messaging/          ← the TypeScript contract (§4)
   types.ts   bridge.ts   mock.ts   events.ts

wallet/zuuli/src-tauri/src/messaging.rs  ← ENROLLMENT ONLY (§2.2)
   app-crate Tauri commands: f2zmsg_enroll, f2zmsg_enrollment_status, …
   invoked as "f2zmsg_enroll" — NO plugin prefix

wallet/plugins/tauri-plugin-f2zmsg/      ← everything else (§3)
   invoked as "plugin:f2zmsg|<command>"
```

### 2.1 The plugin is the engine

The plugin owns the MLS engine, the relay connections, the local encrypted
store, the directory client and the delivery state machine. It exposes the
command set in §3 and the events in §5. It mirrors `tauri-plugin-zcash`
exactly: `build.rs` declares a `const COMMANDS: &[&str]`, `src/lib.rs` registers
the same list in `invoke_handler`, `src/models.rs` carries
`#[serde(rename_all = "camelCase")]` on every wire struct, and
`permissions/autogenerated/` is generated from `COMMANDS` and committed.

### 2.2 Enrollment lives in the app crate, not the plugin — because the seed must never cross IPC

Enrollment is the one operation that needs the **wallet seed**. The messaging
identity is seed-derived:
`S → MSK → account_node → IdentitySigningKey / DirectoryAuthKey / BackupWrapKey`
([`ARCHITECTURE.md` §4.2](./ARCHITECTURE.md#42-derivation-proposed)), so that
restoring the mnemonic restores the identity. Device keys are generated
on-device from the OS CSPRNG and are deliberately **not** seed-derivable.

If enrollment were a plugin command, the seed would have to reach the plugin,
and the only paths that exist are (a) the frontend reads the seed from
`tauri-plugin-zcash` and passes it to `tauri-plugin-f2zmsg`, or (b) one plugin
calls the other through a shared IPC-visible surface. Path (a) puts the mnemonic
in the webview's JavaScript heap — where it is a string in a garbage-collected
heap that nothing can zeroize, visible to any XSS, any devtools session, and any
future dependency compromise. Path (b) is the same exposure with more steps. The
seed is currently reachable from the frontend through exactly **two** commands —
`get_seed_phrase` and `get_backup_seed_phrase`
(`wallet/plugins/tauri-plugin-zcash/src/commands.rs:1058` and `:1085`, both
`-> Result<String>`, both listed in that plugin's `build.rs` `COMMANDS`) — and
**both** are gated behind a single-use sensitive-display lease
(`consume_sensitive_display`, at `:1072` and `:1098`) **precisely so that the
phrase is displayed to a human and nothing else**. Using either lease as an
enrollment transport would defeat the reason it exists.

The count widens that argument rather than weakening it: there is no ungated
path at all, and the two commands differ only in what they are for and where they
are granted. `get_backup_seed_phrase` additionally requires the wallet to be the
exact active wallet with a backup acknowledgement still pending, and it is the
**only** one of the two granted to the mobile webview —
`wallet/zuuli/src-tauri/capabilities/mobile.json` lists
`zcash:allow-get-backup-seed-phrase` and deliberately does not list
`zcash:allow-get-seed-phrase`.

So: **enrollment is an app-crate Tauri command.** The app crate depends on both
plugins as ordinary Rust crates, reads the seed **in process** from the Zcash
plugin's managed state, derives the messaging keys, hands them to the messaging
plugin's Rust API, and returns to the frontend only a public summary. The seed
never becomes JSON, never crosses the IPC boundary, and never enters the
webview. The frontend calls these the way it already calls `oauth_loopback_start`
— `invoke("f2zmsg_enroll", …)` with **no** `plugin:` prefix — which is the
existing precedent in `wallet/zuuli/src-tauri/src/oauth.rs`.

**That precedent covers the prefix and nothing else.** It is not a precedent for
§3's `args` rule, and saying so matters because the nearest neighbour contradicts
that rule: `wallet/zuuli/src/lib/oauth/transport.ts` passes arguments **flat**
for the loopback commands (`oauth_loopback_wait` at `:203`,
`oauth_loopback_cancel` at `:222`) and **nested under `args`** for the mobile ones
(`oauth_mobile_claim` at `:286`, `oauth_mobile_arm` at `:351`,
`oauth_mobile_finish` at `:625`). Take the prefix from `oauth.rs`; take the
argument shape from §3, which is uniform and settled. Whether `transport.ts`
should be normalised is a separate question, and not this document's to answer.

Two consequences the frontend must know:

- **App-crate commands need no capability entry.** They are not plugin commands,
  so they do not appear in `capabilities/default.json` or `mobile.json`. Do not
  file a bug when they are absent from the permission list.
- **Enrollment is unavailable in the browser.** There is no wallet seed in a
  browser tab, and there will not be one. §11 covers what the browser does
  instead.

### 2.3 Permissions and capabilities

Every plugin command in §3 must appear in four places:

1. `build.rs` — `const COMMANDS`.
2. `src/lib.rs` — `invoke_handler`.
3. `permissions/default.toml` — `allow-<kebab-command>`.
4. `src-tauri/capabilities/default.json` (`"f2zmsg:default"`) and
   `capabilities/mobile.json` (**exact least-privilege list**, one
   `f2zmsg:allow-…` per command the mobile webview actually calls — mirroring
   how `mobile.json` enumerates the Zcash plugin today rather than granting
   `:default`).

**Two of those four are mechanically enforced and two are not**, and the
difference is worth stating exactly, because an implementer who expects a build
failure to catch a missing entry in 3 or 4 will not get one — and because §12.3
scopes future work on this assumption.

> **Correction (2026-08-25) — three and four are enforced now, and the checker
> was generalized rather than duplicated.** Everything below describes the state
> before `tauri-plugin-f2zmsg` existed and is kept because the *reasoning* is
> still the reasoning. What changed:
>
> * `scripts/check-zcash-permissions.mjs` is now
>   **`scripts/check-tauri-plugin-permissions.mjs`** and judges every plugin
>   under `wallet/plugins/`, from a `PLUGINS` registry that must cover every
>   tracked plugin manifest. §12.3's conclusion — that a second checker "has to
>   be written, not parameterized" — was true of the script as it stood and is
>   exactly how two near-identical checkers drift, so the hard-coded path,
>   namespace, registry macro and schema directory became fields instead.
> * **Place 3 is enforced:** `permissions/default.toml` must allow exactly the
>   registered command set.
> * **Place 4 is enforced:** each registered capability file must grant either
>   `<plugin>:default` or an exact list of `<plugin>:allow-…` identifiers, every
>   one of which must be a real command. Capability *policy* still belongs to
>   `wallet/zuuli/scripts/mobile-webview-authority.mjs` and its reviewed
>   allowlist; what is new is that a reviewed identifier must name a command
>   that exists.
> * The `f2zmsg` row of that registry now carries **both Zuuli capability
>   files**. It carried none until #737, because `wallet/zuuli/src-tauri` could
>   not link the plugin at all: `bip32 0.6.0-pre.1` — the only 0.6 release, and
>   what librustzcash pins with `=` — exact-pins `sha2 =0.11.0-pre.4` *and*
>   `hmac =0.13.0-pre.4`, against `ed25519-dalek 3`'s `sha2 ^0.11` and
>   `openmls_rust_crypto`'s `hmac ^0.13`. The second of those is untouched by
>   any choice about our own Ed25519, which is why the fix is two transient
>   upstream pins (free2z/librustzcash and a `[patch.crates-io]` on bip32) and
>   not a crypto migration. `wallet/plugins/tauri-plugin-f2zmsg/README.md`
>   carries the full account and the conditions for removing both.
> * Desktop takes `f2zmsg:default`; mobile enumerates 42 named identifiers —
>   everything except `set_relay_trust`, the one grant that is a security
>   downgrade. The enrollment trio appears in neither, because app-crate
>   commands are not plugin commands (§2.2).

`scripts/check-tauri-plugin-permissions.mjs` enforces, **for the Zcash plugin only**, a
chain of set equalities across six artifacts: `build.rs`'s `COMMANDS` ↔
`lib.rs`'s `tauri::generate_handler!` ↔ the filenames under
`permissions/autogenerated/commands/*.toml` ↔ the `allow-`/`deny-` constants in
`permissions/schemas/schema.json` ↔ the `` `zcash:allow-…` `` identifiers in the
generated `permissions/autogenerated/reference.md` ↔ the `zcash:` identifiers in
**Zuuallet's** tracked `src-tauri/gen/schemas/*-schema.json`, which must in turn
be byte-identical to one another. It also asserts that each generated
`<command>.toml` allows and denies exactly its own command, rejects duplicates
in any of those sets, and carries negative controls behind `--self-test`.

It never opens `permissions/default.toml` or any capability file:

```console
$ grep -n "default.toml\|capabilities" scripts/check-zcash-permissions.mjs
$ # no output
```

So **places 3 and 4 are unenforced today**, in the sense that matters here:
nothing derives either file from the command registry, and nothing fails when a
command is missing from them. What does read those two files is narrower, and
belongs to Zuuli rather than to the plugin:

- `wallet/zuuli/scripts/seed-capture-boundary.mjs` reads
  `permissions/default.toml` only to assert that two specific identifiers
  (`allow-begin-sensitive-display`, `allow-end-sensitive-display`) appear in it.
- `wallet/zuuli/scripts/mobile-webview-authority.mjs` reads
  `capabilities/mobile.json` and holds it against a **hand-maintained reviewed
  allowlist**, not against the command set. Note which way that cuts for
  `f2zmsg`: it requires the non-`zcash:` permissions in `mobile.json` to be
  *exactly* `core:default`, `deep-link:default`, `opener:default` and
  `http:default`, so **the first `f2zmsg:allow-…` entry added to `mobile.json`
  will fail that check** until the reviewed list is deliberately extended. That
  is the gate working as designed — mobile authority is granted by review, not
  by registration — but it is a review step, not parity with §3.
- `src-tauri/capabilities/default.json` is read by no check in this repository;
  only by Tauri's own build.

One more asymmetry to plan around: `src-tauri/gen/schemas/` is generated output
and **Zuuli tracks none of it** — the tracked listing for
`wallet/zuuli/src-tauri/gen/schemas/` is empty — so the sixth link in the chain
above has a counterpart for Zuuallet and none for Zuuli.

`set_relay_trust` (§3.11) is the one command whose grant is a security
downgrade — it is how a user opts in to a relay with
`transport_security: "none"` or `channel_binding_mode: "none"`
([`WIRE.md` §2.3](./WIRE.md#23-listener-rules-and-the-insecure-override),
[§5.3](./WIRE.md#53-tls-exporter-channel-binding--with-the-caveat-stated)). Grant
it, and gate it in the UI behind an explicit per-relay confirmation that states
what travels in the clear.

### 2.4 Routes and navigation

Messaging mounts as a new top-level route. In `src/lib/routes.ts`:

```
messages: "/messages/*"
```

and one `NAVIGATION` entry in `src/components/layout/navigation.ts` with
`id: "messages"`, `kind: "route"`, `to: "/messages"`,
`desktop: { group: "tools", order: 1 }`, `auth: "signed-in"`.

Mobile's `primary` area is full (Home / Live / AI / Wallet / More), so messaging
starts in `{ area: "more", order: 0 }`. Promoting it to primary means demoting
something else; that is a product decision and this document does not make it.

---

## 3. The command surface

All plugin commands are invoked as `plugin:f2zmsg|<command>`. **All payloads are
nested under a single `args` key**, and all field names are `camelCase` on both
sides — the shape `tauri-plugin-zcash` and `src/lib/wallet/bridge.ts` already
use:

```
invoke("plugin:f2zmsg|send_message", { args: { conversationId, body, clientRef } })
```

Commands with no arguments take no `args` key at all
(`invoke("plugin:f2zmsg|get_engine_status")`), again mirroring the wallet
bridge. Every command may fail with an [`ErrorCode`](#8-errorcode); the tables
below name the *characteristic* failures only.

> **PROVISIONAL — the whole surface.** No `tauri-plugin-f2zmsg` exists yet. The
> command **names**, the **grouping**, the **`args` convention** and the
> **camelCase rule** are settled and will not change. Individual field sets are
> the current best understanding of what the engine will need to expose and
> **will move** as the backend lands; §12 tracks the ones already known to be
> unsettled. Build screens against the shapes; do not build a persistence layer
> that assumes them.

### 3.1 Engine lifecycle

| Command | `args` | Returns |
|---|---|---|
| `get_engine_status` | — | `EngineStatus` |
| `start_engine` | — | `EngineStatus` |
| `stop_engine` | — | `EngineStatus` |
| `get_device_info` | — | `DeviceInfo` |

```ts
interface EngineStatus {
  state: EngineState;              // §6.1
  enrolled: boolean;
  handle: string | null;           // the messaging handle, once enrolled
  relaysConnected: number;
  relaysConfigured: number;
  witnessThresholdMet: boolean;    // §6.4 — see independentWitnesses
  independentWitnesses: number;    // KT.md §8.3 — NOT the configured count
  pendingInbound: number;          // durably written, not yet surfaced
  unacknowledgedAlarms: number;    // §3.10
  lastError: ErrorCode | null;
}

interface DeviceInfo {
  deviceId: string;                // local, stable, opaque
  deviceFingerprint: string;       // DSK.public, grouped for human reading
  identityFingerprint: string;     // ISK.public, grouped for human reading
  createdAt: number;               // ms since epoch, local clock
  platform: "zuuli-desktop" | "zuuli-mobile" | "browser";
  durability: DurabilityMode;      // §11.2
}

type DurabilityMode = "durable" | "best-effort" | "none";
```

`start_engine` is idempotent. `stop_engine` closes relay connections and stops
emitting events; it does **not** unenroll and does **not** discard local
history.

### 3.2 Enrollment — app crate (§2.2)

Invoked **without** the `plugin:` prefix.

| Command | `args` | Returns |
|---|---|---|
| `f2zmsg_enrollment_status` | — | `EnrollmentStatus` |
| `f2zmsg_enroll` | `{ handle }` | `EnrollmentStatus` |
| `f2zmsg_unenroll` | `{ confirmation }` | `EnrollmentStatus` |

```ts
interface EnrollmentStatus {
  enrolled: boolean;
  handle: string | null;
  eligibility: HandleEligibility;
  directoryEntryVersion: number | null;
  submittedAt: number | null;
  mergedAtEpoch: number | null;    // null until the log merges it
  blocked: ErrorCode | null;       // e.g. "handle-ineligible", "engine-locked"
}

interface HandleEligibility {
  eligible: boolean;
  candidate: string | null;        // ascii_lower(username), if it matches (§11.3, WIRE.md §14.1)
  reason:
    | null
    | "punctuation"                // contains . @ + or - — the dominant cause (§11.3); also the empty string
    | "non-ascii"                  // raw username contains a non-ASCII byte, checked before folding
    | "too-long"                   // > 30 chars after ascii_lower
    | "not-signed-in";
}
```

`reason` distinguishes the causes because they are wildly different in
prevalence and the UI should say the true specific thing: punctuation accounts
for almost the whole of the ineligible population, non-ASCII and over-length for
very little (§11.3). A single "invalid handle" string would be accurate and
useless. The empty string is `"punctuation"` — one fixed choice among these four
values, since none of them means "empty" and nothing about that answer follows
from the pattern alone; every implementation of this predicate, including the
mock, MUST agree on it (`WIRE.md` §14.1).

`f2zmsg_unenroll` takes a typed confirmation string, in the shape
`discard_unrecoverable_send` already uses (`"I CHECKED WALLET HISTORY"`), because
it is destructive and irreversible from the user's point of view.

**Enrollment is a directory submission and does not take effect instantly.** The
log merges entries at an epoch boundary and answers a submission with a receipt
carrying a deadline ([`KT.md` §5.3](./KT.md#53-the-submission-receipt)). `mergedAtEpoch`
stays `null` until it lands, and the UI must show "submitted" rather than
"active" during that window. The epoch cadence is a placeholder
([§13-P](./ARCHITECTURE.md#13-open-questions)); do not build a progress bar
against a number.

### 3.3 Conversations and first contact

| Command | `args` | Returns |
|---|---|---|
| `list_conversations` | `{ limit?, cursor? }` | `ConversationPage` |
| `get_conversation` | `{ conversationId }` | `Conversation` |
| `start_conversation` | `{ handle }` | `Conversation` |
| `list_contact_requests` | — | `ContactRequest[]` |
| `accept_contact_request` | `{ requestId }` | `Conversation` |
| `reject_contact_request` | `{ requestId, block }` | `void` |
| `leave_conversation` | `{ conversationId }` | `void` |

```ts
interface Conversation {
  conversationId: string;
  peerHandle: string;
  peerIdentityFingerprint: string;
  verification: VerificationState;   // §3.9
  epoch: number;                     // current MLS epoch
  createdAt: number;
  lastMessageAt: number | null;      // display only — derived from local receipt
  unreadCount: number;
  retention: RetentionPolicy;        // §3.7
  ephemeralHint: EphemeralHintState | null;  // §3.8
  receiptPolicy: ReceiptPolicy;      // §3.6
  hasGaps: boolean;                  // §3.5 — never render this silently
  transportHealth: TransportHealth;
}

type TransportHealth = "ok" | "degraded" | "unavailable" | "compromised";

interface ConversationPage {
  conversations: Conversation[];
  cursor: string | null;
}

interface ContactRequest {
  requestId: string;
  peerHandle: string;
  peerIdentityFingerprint: string;
  receivedAt: number;                // local receipt clock
  bodyPreview: string | null;        // PROVISIONAL — see §12
}
```

`start_conversation` performs the whole first-contact handshake of
[`WIRE.md` §12.5](./WIRE.md#125-the-full-handshake-end-to-end), with
[§12.6](./WIRE.md#126-keypackage-publication--where-a-consumable-key-lives)'s
two steps inside it: resolve the handle against a witness-cosigned root, **claim
a `KeyPackage` from the relay the resolved entry names**, **authenticate it
against that entry**, build the group, obtain a second challenge, compute a
second proof-of-work stamp, and `CONTACT_APPEND` the `Welcome`. Four
consequences for the UI:

- **It can take seconds, and the delay is proof-of-work on the user's device —
  now twice.** §12.6 gives the claim its own challenge purpose, so first contact
  pays two stamps rather than one. On a cheap phone that is meaningfully slow and
  the reason is unfixable by tuning
  ([`WIRE.md` §12.4](./WIRE.md#124-the-honest-limits)). Show progress; do not
  present it as a network wait.
- **It fails closed when the witness threshold is unmet.** Resolving a *new*
  handle is refused, not degraded
  ([`KT.md` §8.3](./KT.md#83-the-threshold-rule-and-failing-closed)). See rule 5
  in §9.
- **`relay-unavailable` here can mean the peer's key-package pool is empty**,
  not that the peer does not exist. §10's existence-oracle rule gives both the
  same wire code, and only the client knows the directory lookup succeeded — so
  the client MUST say *"this person cannot be reached right now"* and MUST NOT
  say *"no such user"*.
- **A key package that does not authenticate is never retried.** It is either a
  broken relay or an attempted MITM and the two are indistinguishable from the
  client (§12.6.5). Rule 5 applies: no "try anyway", no silent degrade, and
  manual safety-number verification is the correct thing to offer.

`start_engine` additionally publishes this device's own key-package pool
(§12.6). A device whose relay's additive key-package policy reports
`enabled = 0`, whose relay does not know that additive command, or whose
publish failed, is a device **nobody can start a conversation with** — the
engine reports it through `lastError` and keeps running, because every existing
conversation is unaffected. A UI that surfaces engine state should treat it the
same way it treats a missing contact queue: reachable-by-nobody, not broken.

`transportHealth: "compromised"` means the send side of a queue this conversation
depends on was bound by somebody else — `ERR_ALREADY_BOUND` on a first bind for
a freshly advertised address
([`WIRE.md` §7.4](./WIRE.md#74-the-consequence-said-plainly)). It is a loud,
non-dismissible failure, not a retry and not a toast.

`reject_contact_request({ block: true })` is entirely local: there is no server
that can enforce a block, because there is no server that knows who is talking
to whom
([`WIRE.md` §13.3](./WIRE.md#133-what-is-not-closed)). Say "blocked on this
device", not "blocked".

### 3.4 Sending and listing

| Command | `args` | Returns |
|---|---|---|
| `send_message` | `{ conversationId, body, clientRef }` | `SendAccepted` |
| `retry_send` | `{ msgId }` | `SendAccepted` |
| `cancel_send` | `{ msgId }` | `void` |
| `list_messages` | `{ conversationId, before?, after?, limit }` | `MessagePage` |
| `get_message` | `{ msgId }` | `Message` |

```ts
interface SendAccepted {
  msgId: string;                 // BLAKE2b-256, hex — ARCHITECTURE.md §7
  clientRef: string;             // echoed back; the UI's own idempotency key
  state: DeliveryState;          // "pending" at minimum
}

interface Message {
  msgId: string;
  conversationId: string;
  direction: "outbound" | "inbound";
  epoch: number;                 // MLS epoch — ordering key 1, hashed
  senderLeafIndex: number;       // ordering key 2, hashed (ARCHITECTURE.md §7's
                                 // 2026-08-25 correction). Display and
                                 // diagnostics only: the UI does not order.
  parents: string[];             // msg_ids — the DAG
  sentAt: number;                // ADVISORY ONLY — §7. Never order by this.
  receivedAt: number | null;     // local clock, inbound only. Display only.
  body: MessageBody;
  delivery: DeliveryStatus;      // §3.6
  retentionClass: "chat" | "ceremony";
  expiresAt: number | null;      // local ephemeral-hint expiry, if honored
}

type MessageBody =
  | { kind: "text"; text: string }
  | { kind: "unrecoverable"; reason: "gap-unrecoverable" | "retention-expired" }
  | { kind: "unsupported"; typeTag: string };

interface MessagePage {
  messages: Message[];           // ALREADY in the §7 total order, oldest first.
                                 // The engine linearises; the UI renders the
                                 // sequence as given and never re-sorts (§7).
  cursor: string | null;         // a msgId, never an offset — §7
  hasGapBefore: boolean;         // §3.5 — a hole, not an absence
}
```

`clientRef` is generated by the frontend and is the frontend's dedup key for its
own optimistic row. `msgId` is the protocol's dedup key and is the only identity
that survives a duplicate arriving over a second relay
([`ARCHITECTURE.md` §9.4](./ARCHITECTURE.md#94-relay-trust-model)).

`retry_send` is safe to call after any failure, including one where the outcome
is unknown: a retried `APPEND` produces a duplicate at the relay and duplicates
are removed end-to-end by `msg_id`
([`WIRE.md` §8.3](./WIRE.md#83-idempotent-so-retries-are-safe)).

`{ kind: "unrecoverable" }` exists because a short local retention TTL shortens
the plaintext outbox used for gap repair, so some gaps cannot be repaired
([`ARCHITECTURE.md` §8.4](./ARCHITECTURE.md#84-short-local-retention-and-gap-repair)).
That is surfaced as an explicit marker in the transcript. **It is never rendered
as nothing.**

### 3.5 Gap detection and repair

| Command | `args` | Returns |
|---|---|---|
| `list_gaps` | `{ conversationId }` | `Gap[]` |
| `request_gap_repair` | `{ conversationId, gapIds }` | `GapRepairStatus[]` |

```ts
interface Gap {
  gapId: string;
  conversationId: string;
  missingMsgIds: string[];       // dangling parents we do not hold
  detectedAt: number;
  afterMsgId: string | null;     // where the hole sits in the transcript
  state: GapState;
}

type GapState =
  | "detected"
  | "repair-requested"
  | "repaired"
  | "unrecoverable";             // the sender no longer holds the plaintext

interface GapRepairStatus {
  gapId: string;
  state: GapState;
  reason: ErrorCode | null;
}
```

A gap is a **certainty**, not a suspicion: a receiver that sees a `parents` hash
it does not hold knows it is missing a message, with no server assistance
([`ARCHITECTURE.md` §7](./ARCHITECTURE.md#7-application-framing--hash-linked-causal-ordering)).
The UI renders it in the transcript at the position it occupies.

**What hash links do not detect is tail truncation.** If the last *k* messages
from a peer are dropped and no later message arrives, there is no dangling
parent
([`THREAT-MODEL.md` §4.4](./THREAT-MODEL.md#44-tail-truncation-is-not-detectable-by-hash-links)).
`hasGaps: false` therefore means "no detected gap", never "nothing is missing",
and no UI string may imply the latter.

### 3.6 Delivery state and receipts

| Command | `args` | Returns |
|---|---|---|
| `get_delivery_state` | `{ msgId }` | `DeliveryStatus` |
| `mark_read` | `{ conversationId, upToMsgId }` | `void` |
| `get_receipt_policy` | `{ conversationId }` | `ReceiptPolicy` |
| `set_receipt_policy` | `{ conversationId, deliveryReceipts, readReceipts }` | `ReceiptPolicy` |

```ts
interface DeliveryStatus {
  msgId: string;
  state: DeliveryState;          // §6.2
  acceptedByRelays: number;      // how many of k returned OK
  configuredRelays: number;
  devicesReceipted: number;      // device-delivered receipts seen
  devicesExpected: number;       // recipient device set at send epoch
  failure: ErrorCode | null;
  updatedAt: number;
}

interface ReceiptPolicy {
  deliveryReceipts: boolean;     // default true, batched and jittered
  readReceipts: boolean;         // default FALSE — ARCHITECTURE.md §6.6
}
```

Receipt timing is a **published deanonymization vector** against sealed sender;
sealed-sender group membership has been recovered from receipt patterns alone
([`THREAT-MODEL.md` §4.2](./THREAT-MODEL.md#42-delivery-receipt-timing-is-a-published-deanonymization-vector)).
Receipts are therefore batched and jittered rather than immediate, read receipts
default off, and the settings UI must state the trade-off both ways: disabling
delivery receipts costs the ability to know a message landed, which under
delete-on-ack matters more than in a retaining messenger.

**Do not build a UI that assumes prompt receipt feedback.** Jitter is the point.

### 3.7 Local retention

| Command | `args` | Returns |
|---|---|---|
| `get_retention_policy` | `{ conversationId? }` | `RetentionPolicy` |
| `set_retention_policy` | `{ scope, conversationId?, mode, ttlSeconds }` | `RetentionPolicy` |

```ts
interface RetentionPolicy {
  scope: "global" | "conversation";
  mode: "keep" | "expire";
  ttlSeconds: number | null;     // "expire" only
  effectiveFrom: number;         // forward only — never retroactive
}
```

**`scope` is an argument, not only a result.** The global policy is the primary
case — it is the setting a user changes once — so it must be settable, and
`scope` is what says which one is being written:

- `set_retention_policy({ scope: "global", … })` takes **no** `conversationId`;
  passing one is a client bug and is rejected.
- `set_retention_policy({ scope: "conversation", conversationId, … })` requires
  it, and overrides the global policy for that conversation only.
- `get_retention_policy()` with no `conversationId` returns the global policy.
  With one, it returns the **effective** policy for that conversation, and
  `scope` in the result says which of the two produced the answer — that is the
  field's whole purpose on a read.

Nothing here is protocol: retention is entirely local to this device
([ADR 0007](./decisions/0007-retention-per-user.md)), so a precedence rule
between the global and the per-conversation policy settles a client question and
nothing else.

Retention is a **per-user local choice**. One participant keeps five minutes,
another keeps forever; both are legitimate and neither constrains the other
([ADR 0007](./decisions/0007-retention-per-user.md),
[`ARCHITECTURE.md` §8.1](./ARCHITECTURE.md#81-retention-is-a-per-user-local-choice)).
There is no shared retention state and no group-wide setting.

Nothing here is retroactive, in either direction. Retaining → ephemeral cannot
reach backwards across other people's devices; ephemeral → retaining cannot
recover data that is gone. `effectiveFrom` exists so the UI can say so instead
of implying otherwise.

Shortening retention shortens the gap-repair window (§3.5). Say that at the
moment the user shortens it, not in a help page.

### 3.8 Ephemeral hints

| Command | `args` | Returns |
|---|---|---|
| `send_ephemeral_hint` | `{ conversationId, mode, ttlSeconds }` | `EphemeralHintState` |
| `get_ephemeral_hint` | `{ conversationId }` | `EphemeralHintState \| null` |

```ts
interface EphemeralHintState {
  mode: "ephemeral" | "retained";
  ttlSeconds: number | null;
  requestedBy: string;           // peer handle — the hint is ATTRIBUTABLE
  requestedInEpoch: number;
  honoredLocally: boolean;       // what THIS device is doing about it
}
```

**A hint is a courtesy signal, not a control, and the UI must never present it as
enforcement.** What is real cryptography is that it travels inside MLS, so it is
confidential, authenticated and attributable — nobody can forge "Azhr asked for
this to be ephemeral", and every member sees who asked and in which epoch. What
is *not* real is enforcement: a non-conforming client ignores the hint and **no
mechanism exists, or can exist, to detect that**
([ADR 0007](./decisions/0007-retention-per-user.md),
[`ARCHITECTURE.md` §8.2](./ARCHITECTURE.md#82-the-ephemeral-hint-is-a-courtesy-signal-not-a-control),
[`THREAT-MODEL.md` §4.3](./THREAT-MODEL.md#43-ephemeral-hints-are-a-courtesy-signal-not-a-control)).

Copy that says "this message will be deleted everywhere", or shows a countdown
implying remote deletion, is a defect. `requestedBy` and `honoredLocally` are in
the payload so the UI can say the true thing: who asked, and what this device is
doing.

### 3.9 Purge requests

| Command | `args` | Returns |
|---|---|---|
| `send_purge_request` | `{ conversationId, beforeEpoch }` | `PurgeRequestStatus` |
| `list_purge_requests` | `{ conversationId }` | `PurgeRequestStatus[]` |

```ts
interface PurgeRequestStatus {
  purgeId: string;
  conversationId: string;
  beforeEpoch: number;
  direction: "outbound" | "inbound";
  askedParticipants: number;
  confirmedParticipants: number; // PurgeAck count
  requestedAt: number;
}
```

**A purge is a request, not a deletion, and the UI must say so in exactly those
terms.** The required string shape is *"asked N participants to delete; M
confirmed"* — **never** "deleted"
([`ARCHITECTURE.md` §8.3](./ARCHITECTURE.md#83-purge-requests-and-why-nothing-here-is-retroactive)).
Both counts are in the payload so there is no reason to write anything else.

### 3.10 Directory, safety numbers, self-audit and alarms

| Command | `args` | Returns |
|---|---|---|
| `resolve_handle` | `{ handle }` | `DirectoryResolution` |
| `check_handle_eligibility` | `{ username }` | `HandleEligibility` |
| `get_safety_number` | `{ conversationId }` | `SafetyNumber` |
| `set_verification` | `{ conversationId, safetyNumberDigest, verified }` | `VerificationState` |
| `get_self_audit_state` | — | `SelfAuditState` |
| `list_alarms` | — | `Alarm[]` |
| `acknowledge_alarm` | `{ alarmId, confirmation }` | `Alarm` |

```ts
interface DirectoryResolution {
  handle: string;
  found: boolean;                // false is a PROVED non-membership, not an error
                                 // — the ONLY representation of it; see below.
                                 // The word PROVED is wrong as written: see the
                                 // correction under this section.
  identityFingerprint: string | null;
  deviceCount: number;
  entryVersion: number | null;
  epoch: number;
  witnessCosignatures: number;   // valid, from the client's OWN configured set
  independentWitnesses: number;  // KT.md §8.3 — the number the UI must display
  thresholdMet: boolean;
}

interface SafetyNumber {
  conversationId: string;
  digest: string;                // stable identity for set_verification
  displayGroups: string[];       // pre-grouped for human comparison
  qrPayload: string;
  zcashMemoPayload: string | null; // ZUULI only — ADR 0006
}

type VerificationState =
  | { state: "unverified" }
  | { state: "verified"; verifiedAt: number; digest: string }
  | { state: "changed"; previousDigest: string; changedAt: number };

interface SelfAuditState {
  lastCheckedEpoch: number | null;
  lastCheckedAt: number | null;
  chainIntact: boolean;          // entry_version AND prev_entry_hash unbroken
  unexpectedEntries: number;     // entries THIS device did not submit
  running: boolean;
}

interface Alarm {
  alarmId: string;
  kind: AlarmKind;
  severity: "critical" | "warning";
  raisedAt: number;
  dismissible: false;            // structurally false for every critical alarm
  handle: string | null;
  oldFingerprint: string | null;
  newFingerprint: string | null;
  platformAssisted: boolean;     // ADR 0014 platform_reset
  cooldownEndsAt: number | null;
  acknowledgedAt: number | null;
}

type AlarmKind =
  | "identity-key-changed"       // ADR 0014 case 2 / 3 — §9 rule 4
  | "platform-reset"             // ADR 0014 case 3 — say "platform-assisted"
  | "self-audit-unexpected-entry"
  | "queue-send-address-stolen"  // WIRE.md §7.4
  | "relay-identity-mismatch"    // WIRE.md §5.2
  | "witness-threshold-unmet"    // KT.md §8.3
  | "directory-fork-evidence";   // KT.md §6.3 monotonicity failure
```

**Non-membership has exactly one representation, and it is `found: false`.**
`resolve_handle` on an unregistered handle **succeeds** and returns
`DirectoryResolution` with `found: false`; it never fails, and there is no
`ErrorCode` for an unknown handle. That is not a client convention — it follows
from the protocol: [`KT.md` §9.5](./KT.md#95-error-codes) has **no "unknown
handle" code**, deliberately, because *"an unregistered handle is answered with a
non-membership proof … 'No such user' is a claim the log must prove."* A code
would let a log assert absence; a proof makes it demonstrate absence. Routing
that into an error path would discard the proof, so the UI renders "no such
handle" as an **answer** — same success path, different content — and never as a
failure. `handle-ineligible` (§11.3) is a different thing entirely: the string
cannot be a handle at all, so no lookup is made and no proof exists.

> **Correction (2026-08-24) — `found: false` is an unproved assertion, not a
> proof, and the UI must not present it as one.** The paragraph above and the
> comment in `DirectoryResolution` both say *proved*, restating
> [`KT.md` §9.5](./KT.md#95-error-codes) faithfully — and §9.5 turned out to
> state a requirement the adopted library cannot meet.
> [`KT.md` §8.1](./KT.md#81-lookup)'s correction has the mechanics: `akd` 0.13
> produces **no** proof of non-membership for an unregistered label, so the log
> answers with an assertion that it must label as unproved on the wire
> ([#634](https://github.com/free2z/zuu/issues/634)).
>
> **What survives.** Everything about the *shape*. `resolve_handle` still
> succeeds, `found: false` is still the single representation of non-membership,
> and there is still no unknown-handle `ErrorCode` in either direction (§8.1).
> Routing an absent answer into an error path is still wrong — now because it
> would hide which of the two answers the log gave, rather than because it would
> discard a proof.
>
> **What changes, for whoever writes this screen.** `found: false` is the log's
> word for it and nothing more. The UI **MUST NOT** state or imply that the
> handle's absence was verified — no "verified: no such handle", no proof or
> shield iconography on that branch — and copy that reads as a fact about the
> world rather than a report from the directory is a defect. **The engine MUST
> NOT let `found: false` overwrite a resolution it has already pinned**: if the
> client holds a pin for that handle, this is a contradiction it cannot prove to
> anyone, and it raises an alarm and fails closed rather than forgetting the pin
> (§9's rules; [`KT.md` §8.1](./KT.md#81-lookup)).
>
> **No field is added for this in v1**, deliberately. A flag that is a constant
> `false` in every response this protocol can produce is a reserved field with
> extra steps; when the log can prove absence, the field that carries the proof
> arrives with it, and this document's provisional-shape convention (§12.1) is
> what makes that additive. The limit itself is
> [`THREAT-MODEL.md` §4.11](./THREAT-MODEL.md#411-an-unregistered-handle-is-asserted-not-proved)
> and [`ARCHITECTURE.md` §13-T](./ARCHITECTURE.md#13-open-questions).

Self-audit is the whole point of the directory: every client monitors its own
handle every epoch and **raises a loud, non-dismissible alarm on any key change
it did not initiate**
([`ARCHITECTURE.md` §9.2](./ARCHITECTURE.md#92-the-directory),
[`KT.md` §8.2](./KT.md#82-self-audit)). That is what makes an attempted MITM
detectable by the victim, and it is the only thing that does.

`acknowledge_alarm` takes a typed `confirmation` string, again in
`discard_unrecoverable_send`'s shape. **Acknowledging is not dismissing**: the
alarm stays in `list_alarms` with `acknowledgedAt` set, remains visible in the
conversation, and `dismissible` is `false` by construction so no component can
be written that hides it. §9 rule 4 is the rule; this field is the enforcement.

`independentWitnesses` is the number the UI displays. The configured count is
deliberately not exposed as a headline, because at launch every witness is
operated by one party and **whatever *t* is configured, the cryptographic value
of meeting it is zero** until at least two witnesses are run by outside parties.
A client that displays "3 of 3 witnesses" in that state is displaying a
reassuring number for a property it does not have, which is worse than
displaying nothing
([`KT.md` §8.3](./KT.md#83-the-threshold-rule-and-failing-closed),
[`ARCHITECTURE.md` §9.3](./ARCHITECTURE.md#93-anti-equivocation-without-a-blockchain)).

Manual safety-number verification is **always available** and is the strongest
check in the system regardless of the directory's state. It must never be
gated behind engine health, relay health or witness health.

### 3.11 Relays and witnesses

| Command | `args` | Returns |
|---|---|---|
| `list_relays` | — | `RelayConfig[]` |
| `add_relay` | `{ relayUrl }` | `RelayConfig` |
| `remove_relay` | `{ relayId }` | `void` |
| `get_relay_capabilities` | `{ relayId }` | `RelayCapabilities` |
| `set_relay_trust` | `{ relayId, allowInsecureTransport, allowNoChannelBinding }` | `RelayConfig` |
| `list_witnesses` | — | `WitnessConfig[]` |
| `set_witness_set` | `{ witnesses, threshold }` | `WitnessSetState` |
| `get_witness_set_state` | — | `WitnessSetState` |

```ts
interface RelayConfig {
  relayId: string;
  relayUrl: string;
  connection: "connected" | "connecting" | "disconnected" | "refused";
  trusted: boolean;
  operator: RelayOperator;
  warnings: RelayWarning[];
}

interface RelayOperator {
  name: string;
  contact: string;
  abuseContact: string;
  jurisdiction: string;          // where the operator and hardware sit
  policyUrl: string;
  sourceRepoUrl: string;
  sourceCommit: string;
  buildDigest: string;
}

type RelayWarning =
  | "no-transport-security"      // WIRE.md §2.3 — everything but ciphertext is clear
  | "no-channel-binding"         // WIRE.md §5.3
  | "volatile-antireplay"        // WIRE.md §5.5
  | "token-gated"                // WIRE.md §13.1 — a token is an IDENTIFIER
  | "non-durable"                // WIRE.md §8.4 durability_mode
  | "suspicious-padding-set";    // WIRE.md §9

interface RelayCapabilities {
  paddingSizes: number[];
  maxMessageTtlSeconds: number;
  idleTtlSeconds: number;
  queueCreationMode: "open" | "pow" | "token";
  durabilityMode: "memory" | "batched" | "fsync-per-append";
  perSourceLimits: boolean;
  operator: RelayOperator;
}

interface WitnessInput {         // set_witness_set's `witnesses` element
  witnessId: string;             // hex `witness_pk` — the Ed25519 key a
                                 // cosignature verifies under (KT.md §7.2).
                                 // This is the identity; the name is not.
  name: string;                  // display only, and the user's to choose
}

interface WitnessConfig {
  witnessId: string;             // the same hex `witness_pk`
  name: string;
  independent: boolean;          // NOT self-asserted — see below
  lastCosignedEpoch: number | null;
}

interface WitnessSetState {
  configured: number;
  independent: number;
  threshold: number;
  thresholdMet: boolean;
  bootstrapDisclaimer: boolean;  // true while independent === 0
}
```

`operator.jurisdiction` and the contact fields are not decoration: a user
choosing among relays is making a jurisdictional choice whether or not anyone
tells them so, and the relay picker must surface it
([`WIRE.md` §11.1](./WIRE.md#111-what-an-operator-publishes),
[§11.3](./WIRE.md#113-what-a-client-does-with-it)).

`add_relay` fetches and verifies the signed capability document, compares it
against the `.well-known` copy, and **refuses on digest mismatch**. It also
refuses a relay whose `padding_sizes` is not a superset of what this client
emits, or is implausibly fine-grained. Those refusals are `ErrorCode`s, not
warnings.

> **Correction (2026-08-24) — a token-gated relay is a refusal, not a warning.**
> `"token-gated"` appears in `RelayWarning` and `"token"` in
> `queueCreationMode` above because [`WIRE.md` §13.1](./WIRE.md#131-the-layers)
> offered three queue-creation modes. It has since **reserved** `token`: v1's
> `CREATE_QUEUE` has no field a token can go in, so a relay advertising that mode
> gates creation behind a credential no conforming client can present
> ([#630](https://github.com/free2z/zuu/issues/630)).
>
> `add_relay` **MUST refuse** a capability document whose `queue_creation_mode`
> is the reserved value, as an `ErrorCode` alongside the digest-mismatch and
> padding-set refusals, and **MUST NOT offer an override** — there is nothing a
> user could consent to that would make a token presentable. `"token-gated"`
> therefore describes a relay this client never adds; the member stays in
> `RelayWarning` rather than being removed, so a component written against the
> union does not lose a case it may already handle, and a document advertising
> that mode is a defect on the relay's side rather than a policy choice a user
> weighs.

**So a capability-digest mismatch is never a `RelayWarning`, and there is
deliberately no member for it.** A warning is something a *configured, usable*
relay carries; `WIRE.md` §11.2 says a client that detects the divergence **MUST
refuse**, so there is no such relay to carry it. The one code path is
`relay-capability-mismatch` (§8): at `add_relay` the relay is never added at all,
and if the check fails later for a relay already configured — on first use of a
session or on `NOTICE(3)`, per
[`WIRE.md` §11.3](./WIRE.md#113-what-a-client-does-with-it) — the relay moves to
`connection: "refused"` and raises the same error rather than degrading into a
warning banner. Encoding it both ways would give an implementer a warning state
that the protocol forbids reaching, and the first implementer to render it would
be shipping a relay the spec says must not be used.

`set_witness_set` replaces the **whole** set — it is a set operation, not an
append — and `WitnessInput` deliberately carries **no** `independent` field:
independence is not something a witness or a user asserts, it is computed by a
rule that does not exist yet (below). It also carries no URL, because a client
never contacts a witness: the witness pushes to `/kt/v1/cosign` on the log and
the log serves what it collected
([`KT.md` §9.2](./KT.md#92-endpoints)) — which is exactly why the identity that
matters is a **key**, not an address. A cosignature from any witness not in this
set is ignored entirely: *"not weighed, not counted, not displayed as
reassurance"*
([`KT.md` §8.3](./KT.md#83-the-threshold-rule-and-failing-closed)).

`bootstrapDisclaimer` is `true` while `independent === 0`, and while it is true
the UI **must state plainly that no independent witness exists** rather than
render a witness count. What makes a witness independent, and what *t* defaults
to, are open ([§13-Q](./ARCHITECTURE.md#13-open-questions)); `independent` is
therefore **PROVISIONAL** and will be computed by a rule that does not exist
yet. It is in the contract now so no screen is built that assumes the configured
count is the meaningful one.

---

## 4. The TypeScript contract

Four files under `wallet/zuuli/src/lib/messaging/`, mirroring
`src/lib/wallet/` exactly:

| File | What it is |
|---|---|
| `types.ts` | Every domain type in §3 and §5. The single source of truth for shapes. Mirrors the plugin's `models.rs` serde output; camelCase on both sides. |
| `bridge.ts` | **The only place the frontend talks to the engine.** One method per command, `useMock()` fallback on the first line of each, lazy `@tauri-apps/api/core` import so the browser bundle never requires it. Features import from here and never call `invoke()`. |
| `mock.ts` | A self-contained in-memory engine, including the **echo peer** (§5.4), so every screen is buildable and screenshotable in a plain browser with no Rust backend. |
| `events.ts` | Typed `listen()` wrappers and the mock's event emitter behind one interface, so a component subscribes the same way in both runtime modes (§5). |

`bridge.ts` follows the wallet bridge line for line:

```ts
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(`plugin:f2zmsg|${cmd}`, args);
}

export const messaging = {
  async sendMessage(conversationId: string, body: string, clientRef: string) {
    if (useMock()) return mockMessaging.sendMessage(conversationId, body, clientRef);
    return invoke<SendAccepted>("send_message", {
      args: { conversationId, body, clientRef },
    });
  },
  // …
};
```

Enrollment is the exception and must be visibly so — a separate `enrollment`
export whose `invoke` helper has **no** `plugin:` prefix, with a comment saying
why (§2.2), so nobody "fixes" the inconsistency later.

### 4.1 The mock-covers-bridge parity test — the thing the wallet contract lacks

Today, `src/lib/wallet/` is held together by `tsc --noEmit` and a handful of
behavioral tests in `mock.test.ts`. That catches a *missing* mock method,
because `bridge.ts` would not compile. It **cannot** catch:

- a mock that returns the right TypeScript type but the wrong *values* — a
  `WalletStatus` with `initialized: true` and `activeWalletId: null`;
- a mock whose method exists but takes different parameters than the bridge
  passes;
- a mock that has silently stopped covering a command because the bridge method
  was renamed and the mock's old method is still exported and now dead;
- a real plugin response that does not match the declared type at all, which
  TypeScript believes because `invoke<T>` is an unchecked cast.

That last one is the important one. `invoke<T>()` is a **lie to the compiler**:
it asserts a shape it never checks. A backend field rename ships as `undefined`
in the UI and nothing fails until a user sees a blank row.

**The contract therefore requires a schema-backed parity test**, and this is a
hard requirement on the messaging module rather than a suggestion:

1. **Schemas are the source of truth in `types.ts`.** Each domain type is
   declared once as a runtime schema (a small validator library —
   [`zod`](https://zod.dev) or [`valibot`](https://valibot.dev)) and the static
   type is *derived* from it (`export type Conversation = z.infer<typeof
   ConversationSchema>`). One declaration, two consumers. This is the only new
   dependency this contract asks for, and the cost is real: a validator library
   in the bundle. It buys the three properties below, none of which is
   obtainable from types alone.

2. **`bridge.ts` exports a `RESULTS` manifest** mapping every method name to its
   result schema. The parity test asserts
   `Object.keys(RESULTS).sort()` equals the bridge's own method keys — so adding
   a command without a schema fails the build, mechanically, rather than by
   review.

3. **The parity test drives every bridge method in mock mode and parses the
   result.** For each key in `RESULTS`: call `mockMessaging[key](...sampleArgs)`,
   `RESULTS[key].parse(value)`. A mock returning the wrong shape now fails with
   the field name and the expected type. The test additionally asserts
   `Object.keys(mockMessaging).sort()` equals the bridge's method keys (no dead
   mock methods, no uncovered bridge methods) and
   `mockMessaging[key].length === messaging[key].length` (no arity drift).

4. **The same schemas run at the real boundary in development.** Under
   `import.meta.env.DEV`, `invoke<T>()` parses its response against the same
   schema before returning it. A plugin that renames a field fails loudly on the
   developer's machine instead of silently rendering nothing. In production
   builds the parse is skipped, so the cost is a dev-only one.

5. **Events are covered by the same manifest.** `events.ts` exports an
   `EVENTS` map from event name to payload schema; the parity test asserts the
   mock emits every event in the map at least once across the scenario matrix
   (§5.4), and that each emitted payload parses.

A property tests cannot give you: this catches *mock drift* and *backend drift*
with one mechanism, at the exact place where the two runtime modes are supposed
to be interchangeable. If the messaging module lands without it, the mock will
be wrong within a month and nobody will know until the native build.

---

## 5. Events

This is the app's **first real `listen()` consumer.** `zcash://sync-progress` is
emitted by the Zcash plugin and has **zero listeners in ZUULI today** — only the
reference `zuuallet` app listens to it, and ZUULI polls `get_sync_status`
instead. Polling is acceptable for a progress bar and is not acceptable for
inbound messages, so the messaging module is where the event path gets built for
real. Build it deliberately.

### 5.1 The events

| Event | Payload | When |
|---|---|---|
| `f2zmsg://engine-state` | `EngineStatus` | Any transition in §6.1, and on every relay connect/disconnect. |
| `f2zmsg://message-received` | `{ conversationId, message: Message }` | An inbound message has been **durably written** and is safe to display. |
| `f2zmsg://message-state` | `DeliveryStatus` | Any transition in §6.2, outbound or inbound. |
| `f2zmsg://conversation-updated` | `Conversation` | Retention, hint, verification, epoch or transport-health change. |
| `f2zmsg://contact-request` | `ContactRequest` | An inbound `Welcome` was accepted as a contact request. |
| `f2zmsg://gap-detected` | `Gap` | A dangling parent was seen. **Never silent.** |
| `f2zmsg://gap-repaired` | `Gap` | A `gap_response` landed, or the gap became `unrecoverable`. |
| `f2zmsg://alarm` | `Alarm` | §3.10. Critical alarms are non-dismissible by construction. |
| `f2zmsg://relay-state` | `RelayConfig` | Connection or warning change for one relay. |
| `f2zmsg://retention-expired` | `{ conversationId, msgIds }` | Local plaintext expired under this device's own policy. |
| `f2zmsg://purge-progress` | `PurgeRequestStatus` | A `PurgeAck` arrived. |

Names are `f2zmsg://…`, matching `zcash://sync-progress`'s existing scheme.

### 5.2 Ordering guarantees — read this before writing a reducer

- **Events are notifications that state changed. They are not the state, and
  they are not a log.** The engine's local store is the source of truth; every
  event's job is to tell the UI when to re-read.
- **Per conversation, `message-received` is emitted in the engine's insertion
  order.** That is *not* the display order. Display order is §7's total order,
  **computed by the engine**, and a client reads it back with `list_messages`
  rather than deriving it. An inbound message can arrive whose position is in the
  middle of the existing transcript — and, if it fills a gap, can move messages
  already rendered — so the handler re-reads the visible window and renders the
  sequence it gets. It never sorts, and it never patches a position it computed
  itself. See [§7](#7-ordering)'s correction of 2026-08-25, which withdrew this
  bullet's previous claim that the UI recomputes the order.

  > **Correction (2026-08-25).** This bullet read *"Display order is §7's total
  > order, **recomputed by the UI, always**"* — the sentence that produced
  > [#733](https://github.com/free2z/zuu/issues/733)'s defect by assigning a
  > normative protocol rule to a second implementation in a second language,
  > against [ADR 0001](./decisions/0001-platform-priority.md). §7 carries the
  > full correction, the counterexample, and the ergonomics decision that
  > replaces it.
- **`message-state` transitions for a single `msgId` are monotone** and follow
  §6.2. A transition never runs backwards. Different `msgId`s have no ordering
  relationship at all.
- **Events may be coalesced.** Under load the engine emits the latest state for
  a given key rather than every intermediate one. A reducer that counts events,
  or that requires seeing `accepted` before `queue-delivered`, is wrong.
- **Events may be missed.** They are not durable and are not replayed. A window
  that was closed, an engine that was stopped, or a webview reload loses them.
  **Therefore:** after every `engine-state` transition into `running`, and on
  window focus, the UI **must** re-read via `list_conversations` /
  `list_messages` / `list_alarms` rather than trusting its in-memory state.
  This is the one place where the polling instinct is correct, and it is a
  reconciliation read, not a poll loop.
- **`message-received` fires only after the durable write.** That is the
  contract: if the UI has the event, the message is on disk. This is the
  frontend-visible half of §9 rule 1.

### 5.3 The `events.ts` boundary

One module, two implementations behind one signature, so no component knows
which runtime it is in. Each event in §5.1 gets one named payload type in
`types.ts`; `message-received`'s is the one used below, and it is the §5.1 table
row written as a type:

```ts
interface MessageReceivedEvent {
  conversationId: string;
  message: Message;              // §3.4 — already durably written (§5.2)
}

export function onMessageReceived(
  handler: (e: MessageReceivedEvent) => void,
): Promise<UnlistenFn>;
```

`conversationId` is redundant with `message.conversationId` and is carried anyway,
so a subscriber can route without parsing the message. The two are always equal;
a payload where they differ is an engine bug, not a case to handle.

Under Tauri it wraps `listen()`; under mock it registers against the mock's
emitter. Both return the same `Promise<UnlistenFn>`, and **every caller must
handle the unmount race** the way `App.tsx` already does for its deep-link
listener — the promise can resolve after the component unmounted, so the effect
records `disposed` and calls `unlisten()` immediately if it did.

### 5.4 Mock mode must drive inbound traffic — the echo peer

**A mock that only answers commands leaves every screen that matters built
blind.** The inbox, the transcript, the delivery-state indicators, the gap
marker, the alarm banner and the contact-request flow are all driven by inbound
events; without them a developer builds the send path and guesses at everything
else. So the mock is required to **generate traffic**, not merely respond.

The default mock conversation has an **echo peer**. On `send_message` the mock:

1. returns `SendAccepted` with `state: "pending"`;
2. emits `message-state` through `accepted` → `queue-delivered` →
   `device-delivered` → `delivered` on a timer, so every indicator is
   exercisable;
3. after a delay, emits `message-received` with an inbound reply that has
   **correct `parents`, `epoch` and `senderLeafIndex`**, because the mock stands
   in for the **engine** and therefore owes §7's ordered page (§7's correction of
   2026-08-25, §9 rule 10) — not a bag of messages for the UI to sort.

**The mock owes the order, and must not implement it.** Sorting in the mock would
reintroduce in fixtures the second implementation §7's correction removed. It
does not need to: a mock that only ever *appends causally* — seed first, a send
referencing the current heads, an echo reply referencing the message it answers —
already emits a linear extension of the DAG, and the transcript component reads
it back verbatim. The default fixture additionally **is**
[#733](https://github.com/free2z/zuu/issues/733)'s counterexample — a reply in the
same epoch from the lower leaf index — so a client that starts sorting again
looks wrong on the first screen a developer opens rather than in a case nobody
reaches.

Scenarios are selected exactly the way the wallet mock already does it — a
`localStorage` key read behind **both** a `try`/`catch` **and** optional chaining
on the accessor itself (`globalThis.localStorage?.getItem(...)`,
`wallet/zuuli/src/lib/wallet/mock.ts:58-70`), so an absent `localStorage` and a
throwing one both yield `null` rather than an exception, and production and
native behavior cannot observe it — mirroring `zuuli.mock.wallet-scenario`:

```
zuuli.mock.f2zmsg-scenario      // the scenario switch
zuuli.mock.f2zmsg-echo-delay-ms // mirrors zuuli.mock.send-proposal-delay-ms
```

| Scenario | What it exercises |
|---|---|
| *(unset)* | Default: one conversation, echo peer, everything healthy. |
| `not-enrolled` | The pre-enrollment empty state. |
| `ineligible-handle` | An account whose username is not a valid messaging handle (§11.3). |
| `enrolling` | Submitted, not yet merged at an epoch. |
| `first-contact` | A pending inbound `ContactRequest`. |
| `echo-slow` | Long delivery latency; tests every "still sending" affordance. |
| `gap` | A detected gap in the middle of the transcript. |
| `gap-unrecoverable` | The `{ kind: "unrecoverable" }` marker. |
| `key-change-alarm` | A non-dismissible `identity-key-changed` alarm. |
| `platform-reset` | ADR 0014 case 3: platform-assisted, with a cooldown. |
| `witness-threshold-unmet` | Fail-closed refusal to resolve a new handle (§6.4). |
| `queue-stolen` | `transportHealth: "compromised"` (`WIRE.md` §7.4). |
| `relay-down` | `degraded` engine state, one relay disconnected. |
| `send-unavailable` | `ERR_UNAVAILABLE` backoff and advert-refresh path. |
| `no-durability` | Browser no-ACK mode (§11.2). |

Every scenario must be reachable in a plain browser with no Rust backend, and
the parity test (§4.1 point 5) asserts the matrix emits every event in `EVENTS`.

---

## 6. State machines

### 6.1 Engine state

```
uninitialized ──(wallet present, handle eligible)──► not-enrolled
      │                                                   │
      │                                          f2zmsg_enroll
      ▼                                                   ▼
  ineligible                                          enrolling
 (handle not eligible, §11.3)                             │
                                                  (merged at epoch)
                                                          ▼
   locked ◄──(wallet seed cleared)── starting ──────► running ──► degraded
      │                                 ▲                │   ◄──      │
      └──(seed available)───────────────┘                │            │
                                                     stop_engine      │
                                                          ▼           │
                                                       stopped ◄──────┘

  starting / running / degraded ──(unrecoverable fault)──► faulted
                    ▲                                         │
                    └──────────────── start_engine ───────────┘
```

```ts
type EngineState =
  | "uninitialized"   // no wallet, or the plugin has not started
  | "ineligible"      // wallet present; username is not a valid handle (§11.3)
  | "not-enrolled"    // eligible, no directory entry yet
  | "enrolling"       // submitted; awaiting the log's merge
  | "locked"          // enrolled, but the seed is unavailable: local history
                      // is wrapped under BackupWrapKey and cannot be decrypted
  | "starting"
  | "running"
  | "degraded"        // running, but relays unreachable and/or threshold unmet
  | "stopped"
  | "faulted";        // unrecoverable without user action; carries lastError
```

`degraded` is a **running** state, not an error state. Sending and receiving in
an already-established conversation continues, because the keys were verified
when they were pinned and nothing about a witness outage retroactively unverifies
them ([`KT.md` §8.3](./KT.md#83-the-threshold-rule-and-failing-closed)). What is
refused in `degraded` is resolving a *new* handle and accepting a *key change* —
§6.4.

`faulted` is entered from `starting`, `running` or `degraded` — the three states
in which the engine is actually doing something that can fail unrecoverably — and
it carries `lastError`. **It is not entered from `stopped`**: a stopped engine has
closed its relay connections and emits nothing, so there is no work left to fault.
Leaving `faulted` takes an explicit `start_engine` after the user has acted on
`lastError`; nothing retries out of it on a timer, because the codes that reach it
are the ones §8 marks non-retryable.

There is one entry into `faulted` that is not a transition at all: **the client
can come up with no engine.** `SqliteBackend::open` verifies WAL,
`synchronous = FULL` and `secure_delete` and *refuses* otherwise, because §11.2
says a client that cannot promise durability must not ACK — and the data
directory can also be full, read-only, or hold an `f2zmsg.sqlite` left
half-written by a killed process. In every one of those the correct product
behaviour is that **messaging is unavailable and the rest of the application
works**: the store failing to open must never stop the host application from
starting. The client reports `faulted` with the `lastError` that stopped it
(`storage-full`, `durability-unavailable`, or `internal`). The pure
`check_handle_eligibility` validator still answers from its string alone; every
engine- or storage-dependent command — `start_engine` and the §3.2 enrollment
trio included — refuses with that same code. This is the one `faulted` that
`start_engine` cannot leave; only fixing the storage and restarting can.

`locked` exists because the local encrypted history is wrapped under a
seed-derived key
([`ARCHITECTURE.md` §4.2](./ARCHITECTURE.md#42-derivation-proposed)). Note what
this does **not** mean: see §9 rule 6 about the blur handler.

### 6.2 Delivery state — and what each one is actually evidence of

Four states come from the protocol
([`ARCHITECTURE.md` §6.3](./ARCHITECTURE.md#63-what-delivered-means), which
warns in its first line that **conflating them is how delete-on-ack loses
messages**). Three more are client-local bookkeeping and are marked as such.

```
pending ──► accepted ──► queue-delivered ──► device-delivered ──► delivered
   │            │               │
   ▼            ▼               ▼
 failed      expired         (relay has now deleted its copy)
```

```ts
type DeliveryState =
  // from the protocol — each is evidence of exactly one thing; see the table
  | "accepted"
  | "queue-delivered"
  | "device-delivered"
  | "delivered"
  // client-local bookkeeping — no protocol event corresponds to these
  | "pending"
  | "failed"
  | "expired";
```

| State | Source | Evidence of **exactly** this | Explicitly NOT evidence of |
|---|---|---|---|
| `pending` | client-local | The engine holds it and will try. | Anything reaching the network. |
| `accepted` | protocol | An `APPEND` returned status 0 at ≥1 relay. | The recipient. Anything about the recipient. The relay is forbidden from telling the sender queue state at all ([`WIRE.md` §6.3](./WIRE.md#63-commands-signed-by-the-send-side-queue-key)), and under `durability_mode: memory` or `batched` it may not survive a relay crash ([`WIRE.md` §8.4](./WIRE.md#84-where-this-sits-in-the-four-delivery-states)). |
| `queue-delivered` | protocol | **The reader durably wrote the ciphertext, then ACKed. The relay deleted it at this instant.** | That the message was decrypted, processed, or seen. It is a *storage* fact about the recipient device, not a *reading* fact. |
| `device-delivered` | protocol | One recipient device emitted an authenticated `DeliveryReceipt` inside the MLS group, naming the `msg_id`. | That every device got it. That it was read. |
| `delivered` | protocol | A receipt from **every device in the recipient's device set as of the epoch the message was sent**. Computed by the sender, end to end. | That it was read. The relay has no such concept and could not have one without knowing the device set, i.e. knowing the recipient. |
| `failed` | client-local | The engine gave up after the retry budget. Carries an `ErrorCode`. | That the message did not arrive — an unknown outcome is not a negative one. |
| `expired` | client-local | The message TTL elapsed at the relay with no receipt. | That it was not delivered — the sender learns only from the *continued absence* of a receipt ([`ARCHITECTURE.md` §6.3](./ARCHITECTURE.md#63-what-delivered-means)). |

**Why the distinction is not pedantry.** The relay deletes at `queue-delivered`,
unconditionally and per queue. If a client treats `accepted` as delivery it will
under-report loss; if it treats `queue-delivered` as "the recipient has it" it
will over-report — the recipient device wrote bytes to disk and may still crash
before processing them. The `delivered` computation is the only one that means
what a user means by "delivered", it is a *sender-side* computation across
receipts, and single-device v1 makes `devicesExpected` equal to 1 — which is
exactly the coincidence that tempts an implementer to collapse the states. Do
not collapse them: multi-device is designed in from day one
([ADR 0002](./decisions/0002-multi-device.md)) and the collapse would have to be
undone across the whole UI.

### 6.3 Verification state

```
unverified ──(user compares safety numbers)──► verified
     ▲                                             │
     │                                    (peer identity key changes)
     └───────────── set_verification ◄──────── changed
```

`changed` is not a soft state. It is raised together with an
`identity-key-changed` alarm (§3.10), and returning to `verified` requires the
user to compare safety numbers again — never a "trust anyway" button that
silently re-pins.

### 6.4 Witness threshold — the fail-closed matrix

Reproduced from [`KT.md` §8.3](./KT.md#83-the-threshold-rule-and-failing-closed)
because the UI has to implement exactly this and nothing else:

| Operation | Threshold unmet |
|---|---|
| Resolving a **new** handle; creating a group with it; accepting a first-contact `Welcome` from it | **Refused.** This is the [#133](https://github.com/free2z/zuu/issues/133) moment — an unverified key here *is* the MITM. |
| Accepting a **key change** or a new device credential for an already-pinned handle | **Refused, and surfaced.** The old pin stays in force. |
| Sending and receiving in a conversation already established over pinned keys | **Continues.** |
| Self-audit | **Continues, and reports.** |
| Manual safety-number verification | **Always available.** The strongest check in the system regardless of directory state. |

---

## 7. Ordering

**The DAG is the order. The clock is not.**

Every application payload carries `parents`: the `msg_id`s of every message the
sender had received and not yet referenced at send time
([`ARCHITECTURE.md` §7](./ARCHITECTURE.md#7-application-framing--hash-linked-causal-ordering)).
That gives a **partial order** — a causal DAG that is transport-independent, so
it works identically whether a message arrived over the relay, over WebRTC, or
over any future transport, and it survives a hostile relay that reorders freely
([`WIRE.md` §5.4](./WIRE.md#54-what-the-transcript-deliberately-does-not-cover)).

For display, ties in the partial order are broken by a deterministic **total
order**:

```
sort key = (epoch, senderLeafIndex, msgId)
```

Three fields, in that order, all three of them protocol-authenticated and all
three committed to by `msgId`
([`ARCHITECTURE.md` §7](./ARCHITECTURE.md#7-application-framing--hash-linked-causal-ordering)'s
correction of 2026-08-25 moved `senderLeafIndex` inside the hash). The key
breaks ties — it decides the pairs the DAG leaves **incomparable**, and nothing
else. Applying it to every pair, causally related ones included, is a different
rule that renders a reply above the message it answers.

**The engine computes this order. The UI never does.**
`list_messages` returns `MessagePage.messages` already linearised, oldest first,
and a client renders that sequence in the order it was given. The single
implementation is `rs/crates/f2z-msg-dag` — natively in ZUULI, and through WASM
in the browser client, which is what
[ADR 0001](./decisions/0001-platform-priority.md) meant by *"the crypto core is
Rust, built once … there is no second implementation."* See the correction below;
an earlier revision of this section assigned the computation to the UI, and the
UI got it wrong.

**`sentAt` is advisory and is never used for ordering.** It is a
sender-supplied wall-clock value, and a clock is an attacker-controlled input.
It may be rendered next to a message as the sender's claim; it must not order,
filter, deduplicate, bound a query, decide whether something is "new", drive a
day separator that changes ordering, or feed any security decision. §9 rule 2 is
the same rule stated as a prohibition, because this is the one every messaging
client gets wrong.

`receivedAt` is the local clock at durable write. It is honest about what it is —
this device's opinion — and is fine for a "received" tooltip and for grouping
that does not affect order. It is not comparable across devices.

Practical consequences for the transcript component:

- **Insertion is not append, and it is not even insertion.** An inbound message
  can land in the middle of the transcript, and — when it fills a gap — it can
  **reorder rows already on screen**. Two held messages are incomparable while
  the message that links them is missing, so the sort key alone separates them;
  the moment the missing one lands, the causal chain forces an order, and it may
  be the other one. So the component does not compute a position and does not
  maintain one: on `message-received` it **re-reads the visible window** with
  `list_messages` and renders the sequence it gets back. See the correction below
  for why an insertion index in the event would have been a lie in exactly the
  case that matters.
- **`msgId` is the dedup key**, not `clientRef` and not any tuple involving
  `sentAt`. Duplicates are expected: a device may publish queue addresses on *k*
  relays and senders send to all *k*
  ([`ARCHITECTURE.md` §9.4](./ARCHITECTURE.md#94-relay-trust-model)).
- **A hole in the sort order is not a hole in the conversation** and vice versa.
  Gaps come from `list_gaps` / `gap-detected` (§3.5), never from inferring
  absence from the sort key.
- **A cursor is a `msgId`, never an offset.** Positions in the total order are
  not stable under arrival; the message a cursor names is.
- **An optimistic row for a message this device is sending goes at the end**,
  and that is not an exception to rule 10. A message this device authors
  references the current heads, so it is a sink of the graph and the end is where
  §7 puts it. Appending it is not computing an order; deriving a *position* for
  anything else is.

> **Correction (2026-08-25) — display order is the engine's, not the UI's.
> The sentence that said otherwise is withdrawn, and the code it produced is
> deleted.**
>
> [`§5.2`](#52-ordering-guarantees--read-this-before-writing-a-reducer), as
> written in [#574](https://github.com/free2z/zuu/pull/574), said — and this
> section implied:
>
> > *"Display order is §7's total order, **recomputed by the UI, always**."*
> > ← superseded
>
> **What that produced**, in
> [#664](https://github.com/free2z/zuu/pull/664). `compareMessages` in
> `wallet/zuuli/src/lib/messaging/types.ts`, applied by `Transcript.tsx` as
> `[...messages].sort(compareMessages)`, sorted by
> `(epoch, senderLeafIndex, msgId)` and **never read `parents`**. It was the
> tie-break on its own, mistaken for the order. Bob at leaf 1 sends `A`; Alice at
> leaf 0 replies `B` with `parents = [A]` in the same epoch; the keys are
> `(7, 1, …)` and `(7, 0, …)`, so the reply rendered **above** the message it
> answered. Epochs are non-decreasing along causal edges, so it is confined to a
> single epoch — which is little comfort, because it fires whenever the replier
> holds the lower leaf index, about half of all one-to-one conversations. Found
> by [#732](https://github.com/free2z/zuu/issues/732) implementing the same
> ordering independently in Rust and comparing; filed as
> [#733](https://github.com/free2z/zuu/issues/733).
>
> **The comparator was not the defect; this sentence was.** A JavaScript
> `Array.prototype.sort` comparator *cannot* express a topological order — it
> sees two elements and causal precedence is a relation over the whole graph — so
> no repair to `compareMessages` was available. The repair on offer was a full
> graph pass in TypeScript, and that is precisely what
> [ADR 0001](./decisions/0001-platform-priority.md) rejects: *"two independent
> implementations (Rust + TypeScript) … divergence between two implementations is
> a reliable source of exploitable bugs."* §7's ordering is normative protocol
> logic with correctness consequences, and this document had assigned it to the
> UI — mandating a second implementation of a protocol rule, in a second
> language, which then diverged. Fixing the comparator would have preserved the
> mistake and made it harder to see.
>
> **The correction.** `list_messages` returns messages **already in §7's order**.
> The UI renders what it is given. `compareMessages` is deleted from `types.ts`
> rather than repaired; nothing in the TypeScript tree orders messages, and the
> mock — which stands in for the engine, not for the UI — is bound by the same
> contract and satisfies it by generating its transcript causally rather than by
> sorting one. The browser client gets the identical order from the identical
> Rust core compiled to WASM.
>
> **The ergonomic objection, answered honestly.** The withdrawn sentence gave a
> real reason: *"an inbound message can arrive whose position is in the middle of
> the existing transcript, and it must land there."* That is true, and it is a
> **performance** argument, not a correctness one — it says the UI should not
> have to refetch, never that the UI should compute. Three ways to give the UI
> the new order without a full refetch were available:
>
> | Option | Verdict |
> |---|---|
> | An **insertion index** in `message-received` | **Rejected as incorrect.** An arriving message that fills a gap does not merely insert. Hold `A` and `C`, where `C`'s parent `B` is missing: nothing orders `A` against `C` but the sort key, which can place `C` first. When `B` arrives, `A → B → C` forces `A` before `C` and the two rows swap. One index cannot express that, and it would be wrong in exactly the gap-repair case §3.5 exists for. |
> | A **small ordered-window API** | **Already present.** `list_messages` takes `before` / `after` / `limit`; a window is what the transcript reads. Adding a second such command would be duplication. |
> | **Re-read the visible window on `message-received`** | **Chosen.** |
>
> **The cost, stated.** One IPC round-trip and one re-render of the visible
> window per inbound event — bounded by the page size (50 in ZUULI's transcript),
> not by conversation length — where the withdrawn design paid a client-side sort
> of the same window. §5.2 already **requires** a re-read after every event and
> on window focus, because events may be coalesced and may be missed, so this
> adds no machinery: it removes a comparator and keeps a read that had to exist.
> `Transcript.tsx` already re-read on `message-received` before this correction;
> what changes is that it now trusts the result. Under load the engine coalesces
> events, so the read count is bounded by render cadence rather than by message
> rate.
>
> **What the engine owes in exchange.** `MessagePage.messages` must be a
> contiguous window of the total order induced by **every** message the engine
> holds for that conversation — not a locally sorted page — so that paging
> backwards cannot produce a sequence that contradicts the one on screen.
> Maintaining that incrementally is an implementation concern; producing it is a
> contract.

---

## 8. `ErrorCode`

A **closed union**, and §8.1 is what makes the word honest rather than
aspirational: every code in [`WIRE.md` §10](./WIRE.md#10-error-codes) and
[`KT.md` §9.5](./KT.md#95-error-codes) is mapped there by name, and a stated
default covers whatever a later protocol version adds. Every rejected command and
every `DeliveryStatus.failure` carries exactly one member; adding a member is a
contract change; the frontend never sees a numeric wire code.

```ts
type ErrorCode =
  // relay / transport
  | "relay-unreachable"
  | "relay-rate-limited"
  | "relay-backpressure"
  | "relay-quota"
  | "relay-version-unsupported"
  | "relay-protocol-violation"
  | "relay-identity-mismatch"
  | "relay-refused-insecure"
  | "relay-capability-mismatch"
  | "send-unavailable"
  | "send-address-stolen"
  | "pow-required"
  | "pow-failed"
  // directory / key transparency
  | "directory-unreachable"
  | "directory-rate-limited"
  | "directory-proof-invalid"
  | "directory-version-conflict"
  | "directory-cooldown"
  | "directory-epoch-unavailable"
  | "directory-protocol-violation"
  | "witness-threshold-unmet"
  | "handle-ineligible"
  // local
  | "not-enrolled"
  | "engine-locked"
  | "engine-not-running"
  | "device-clock-skew"
  | "durability-unavailable"
  | "storage-full"
  | "gap-unrecoverable"
  | "not-supported-in-browser"
  | "internal";
```

| Code | Retryable | What the UI must do |
|---|:---:|---|
| `relay-unreachable` | ● | Show the conversation as `degraded`, keep the message `pending`, retry with backoff. Do not mark anything failed. |
| `relay-rate-limited` | ● | Back off. Never retry in a tight loop — the relay's limits are what keep it alive ([`WIRE.md` §13.1](./WIRE.md#131-the-layers)). |
| `relay-backpressure` | ● | Same as rate-limited. The relay is refusing new writes rather than deleting un-acked ones, which is the correct failure mode ([`WIRE.md` §13.2](./WIRE.md#132-never-delete-un-acked-messages-to-make-room)). |
| `relay-quota` | | The user's queue allowance at this relay is exhausted. Offer another relay. |
| `relay-version-unsupported` | | The client and relay share no protocol version. Offer to remove the relay; suggest updating ZUULI. |
| `relay-protocol-violation` | | The relay sent something malformed, or rejected us as malformed. **This is a bug in one of the two implementations.** Surface it as a defect with a report affordance; never silently retry. |
| `relay-identity-mismatch` | | **Fatal and loud.** The relay's proven identity does not match the `relay_id` the peer advertised in-band — a substituted relay ([`WIRE.md` §5.2](./WIRE.md#52-relay-identity-binding--the-attack-it-closes)). Raise an alarm, stop using this relay for this conversation, do not retry against it. |
| `relay-refused-insecure` | | The relay declares `transport_security: "none"` or `channel_binding_mode: "none"` and the user has not opted in. Offer the opt-in with copy stating that ciphertext is protected by MLS but connection metadata, queue addresses and commands travel in the clear ([`WIRE.md` §2.3](./WIRE.md#23-listener-rules-and-the-insecure-override)). |
| `relay-capability-mismatch` | | Its padding set, TTL ceiling, or `.well-known` digest disagrees with what it serves. Refuse the relay and say which check failed ([`WIRE.md` §11.2](./WIRE.md#112-served-two-ways-on-purpose), [§11.3](./WIRE.md#113-what-a-client-does-with-it)). |
| `send-unavailable` | ● | The single collapsed send-side refusal: absent, deleted, expired, full, or backpressure — the relay is forbidden from distinguishing them ([`WIRE.md` §6.3](./WIRE.md#63-commands-signed-by-the-send-side-queue-key)). Exponential backoff to the retry budget, then ask the peer in-band for a fresh queue advert. **The UI cannot tell the user why, and must not guess.** |
| `send-address-stolen` | | **Fatal, loud, non-dismissible.** `ERR_ALREADY_BOUND` on a first bind for a freshly advertised address: a relay operator took the write capability ([`WIRE.md` §7.4](./WIRE.md#74-the-consequence-said-plainly)). Mark `transportHealth: "compromised"`, abandon the queue, name the relay. Not a warning toast. Not a log line. |
| `pow-required` | ● | Obtain a challenge and compute a stamp. Show it as work, not as a network wait. |
| `pow-failed` | ● | The challenge expired or was consumed. Get a fresh one and retry once. |
| `directory-unreachable` | ● | Existing conversations continue. New-handle resolution is unavailable — say that, do not fall back. |
| `directory-rate-limited` | ● | Back off. |
| `directory-proof-invalid` | | **Fatal.** An inclusion proof, a monotonicity check, or an entry authorization failed. This is **fork evidence**, not a network glitch ([`KT.md` §8.1](./KT.md#81-lookup), [§6.3](./KT.md#63-monotonicity)). Raise `directory-fork-evidence`; do not retry, do not "try another server". |
| `directory-version-conflict` | ● | Someone (probably another of the user's own attempts) submitted for this handle in this epoch. Refresh the published state and retry once ([`KT.md` §4.3](./KT.md#43-uniqueness-within-an-epoch--a-must-that-comes-from-the-audit)). |
| `directory-cooldown` | | A platform reset is pending and its cooldown has not elapsed. Show the cooldown end, and state that the old key remains in force and can still cancel the reset ([ADR 0014](./decisions/0014-directory-key-rotation.md)). |
| `directory-epoch-unavailable` | | The epoch or audit range asked for is outside the horizon the log still serves; it has been pruned ([`KT.md` §9.3](./KT.md#93-sizes-are-a-rate-limit-input-not-a-footnote)). This is the log answering honestly that it no longer holds those bytes — **not** a network failure and **not** fork evidence. Do not retry the same range and do not "try another server". |
| `directory-protocol-violation` | | The log rejected our request as malformed, unsupported, unauthorized-by-construction or over-wide, or answered something we cannot parse. **This is a bug in one of the two implementations**, exactly as `relay-protocol-violation` is for the relay. Surface it as a defect with a report affordance; never silently retry. Deliberately **not** `directory-proof-invalid`: that one is a *cryptographic* failure and is fork evidence, and collapsing the two would turn every one of our own encoding bugs into an accusation. |
| `witness-threshold-unmet` | | **Fail closed, per §6.4's matrix.** Never "proceed anyway", never a silent degrade. Offer manual safety-number verification, which is always available and is the strongest check. |
| `handle-ineligible` | | The account's username is not a valid messaging handle. §11.3 — this must be a first-class, non-apologetic state. |
| `not-enrolled` | | Route to enrollment. |
| `engine-locked` | | The seed is unavailable, so local history cannot be decrypted. Prompt to unlock. Never auto-unlock. |
| `engine-not-running` | ● | Call `start_engine` once, then retry once. |
| `device-clock-skew` | ● | **This device's clock is wrong**, not the relay's: `timestamp_ms` fell outside the relay's published `clock_skew_ms` window ([`WIRE.md` §5.5](./WIRE.md#55-anti-replay-a-bounded-window-plus-a-seen-set)). Re-learn the relay's time from `HELLO` / `GET_CHALLENGE`, apply the offset **locally**, retry once. If it persists, say plainly that the device clock is off and by roughly how much — never that the relay misbehaved, and never a defect-report affordance. **Never set the system clock from a relay-supplied time**: `WIRE.md` §5.5 forbids it, and a relay that could move this device's clock could move the anti-replay window with it. |
| `durability-unavailable` | | Storage durability was refused, so nothing may be ACKed. In a browser this is the storage API declining, and the client enters **no-ACK mode** (§11.2) and says what is degraded. On ZUULI it is the durable store failing to open at all — a filesystem that will not give WAL, a read-only or permission-denied data directory — and there is no degraded mode to enter: messaging is unavailable for the life of the process (§6.1). Either way, **do not ACK.** |
| `storage-full` | | Local storage exhausted. Inbound stops being acknowledged — which is correct, because an un-ACKed message is still on the relay. Offer to reduce retention. |
| `gap-unrecoverable` | | The sender no longer holds the plaintext. Render the `{ kind: "unrecoverable" }` marker in place ([`ARCHITECTURE.md` §8.4](./ARCHITECTURE.md#84-short-local-retention-and-gap-repair)). Never a silent hole. |
| `not-supported-in-browser` | | A ZUULI-only operation was attempted in a browser (§10, §11.1). State the reason — it is a trust-model boundary, not a missing feature. |
| `internal` | | Engine fault, carries no detail by design ([`WIRE.md` §10](./WIRE.md#10-error-codes)). Offer a report affordance. |

"Retryable" means *the engine or the UI may retry automatically, with backoff*.
Everything unmarked requires a user decision or is a defect; retrying it
automatically converts a signal into noise, which for the four fatal codes means
converting an attack indicator into a flaky-network indicator.

### 8.1 The wire-code mapping, in full

The bridge does this translation and the frontend never sees a number. It is
tabulated in full because "closed" is only a real property if every code has a
target — a union that quietly drops six codes into the nearest-looking member is
how a wrong device clock ends up rendered as a relay defect.

**[`WIRE.md` §10](./WIRE.md#10-error-codes) → `ErrorCode`**

| Wire | Name | `ErrorCode` |
|---:|---|---|
| 1 | `ERR_MALFORMED` | `relay-protocol-violation` |
| 2 | `ERR_UNSUPPORTED_VERSION` | `relay-version-unsupported` |
| 3 | `ERR_FRAME_TYPE` | `relay-protocol-violation` |
| 4 | `ERR_TOO_MANY_INFLIGHT` | `relay-backpressure` |
| 5 | `ERR_UNKNOWN_COMMAND` | `relay-protocol-violation` |
| 6 | `ERR_BAD_SIGNATURE` | `relay-protocol-violation` |
| 7 | `ERR_STALE_TIMESTAMP` | **`device-clock-skew`** |
| 8 | `ERR_REPLAY` | `relay-protocol-violation` — a repeated `(signer_key, nonce)` is our CSPRNG's fault |
| 9 | `ERR_CHANNEL_BINDING` | `relay-protocol-violation` — reserved and unused in v1, so receiving it *is* the violation |
| 10 | `ERR_NO_ACCESS` | `send-unavailable` on a send-side command; `relay-protocol-violation` on a recv-side one. **See the note below: the source contradicts itself here and this row is not a resolution of it.** |
| 11 | `ERR_ALREADY_BOUND` | `send-address-stolen` on a first bind for a freshly advertised address (§3.3); `relay-protocol-violation` on any later bind, because we should not have tried |
| 12 | `ERR_BAD_SIZE` | `relay-capability-mismatch` — our emitted size is not in the relay's `padding_sizes` |
| 13 | `ERR_ACK_TOO_HIGH` | `relay-protocol-violation` — an `ACK` past the head is a client bug |
| 14 | `ERR_QUOTA` | `relay-quota` |
| 15 | `ERR_UNAVAILABLE` | `send-unavailable` |
| 16 | `ERR_POW_REQUIRED` | `pow-required` |
| 17 | `ERR_POW_INVALID` | `pow-failed` |
| 18 | `ERR_BACKPRESSURE` | `relay-backpressure` |
| 19 | `ERR_RATE_LIMITED` | `relay-rate-limited` |
| 20 | `ERR_NOT_PERMITTED` | `relay-protocol-violation` — the wrong command for this queue kind is a client bug |
| 21 | `ERR_INTERNAL` | `internal` |

**[`KT.md` §9.5](./KT.md#95-error-codes) → `ErrorCode`**

| Wire | Name | `ErrorCode` |
|---:|---|---|
| 1 | `ERR_MALFORMED` | `directory-protocol-violation` |
| 2 | `ERR_UNSUPPORTED_VERSION` | `directory-protocol-violation` |
| 3 | `ERR_BAD_SIGNATURE` | `directory-protocol-violation` — the log rejecting **our** submission's signature |
| 4 | `ERR_BAD_AUTHORIZATION` | `directory-protocol-violation` — e.g. a key change we submitted with one signature |
| 5 | `ERR_VERSION_CONFLICT` | `directory-version-conflict` |
| 6 | `ERR_COOLDOWN` | `directory-cooldown` |
| 7 | `ERR_EPOCH_UNAVAILABLE` | **`directory-epoch-unavailable`** |
| 8 | `ERR_RANGE_TOO_WIDE` | `directory-protocol-violation` |
| 9 | `ERR_RATE_LIMITED` | `directory-rate-limited` |
| 10 | `ERR_NOT_A_WITNESS` | `directory-protocol-violation` — a client never calls `/kt/v1/cosign`, so seeing this means we sent a request we had no business sending |
| 11 | `ERR_INTERNAL` | `internal` |

**Note what is not in either table.** `directory-proof-invalid`,
`witness-threshold-unmet`, `relay-identity-mismatch`, `relay-unreachable`,
`relay-refused-insecure`, `handle-ineligible` and the whole local group are
**client-side outcomes, not wire codes**: the client computes them and no server
sends them. Keeping them out of the mapping is deliberate — a code a relay or a
log chooses can never, on its own, produce one of the codes that mean an
attack.

And there is **no unknown-handle code, in either direction**.
[`KT.md` §9.5](./KT.md#95-error-codes) has none deliberately, and §3.10's
`found: false` is this document's single representation of non-membership —
which in v1 is an **unproved assertion by the log**, per §3.10's correction.

**The default rule, so the union stays closed as the protocol grows.** A code
neither table names — one from a protocol version newer than this client, or a
known code returned in a context these tables do not give it — maps to
`relay-protocol-violation` if a relay returned it, and
`directory-protocol-violation` if the log did. It is never mapped to `internal`,
which means *our own engine* faulted, and it is never dropped. That is what
"closed" buys a frontend: the set of values a component can receive is fixed, so
a protocol that grows a code produces a defect report instead of an `undefined`
branch.

**`ERR_NO_ACCESS` (10) — the mapping is chosen so the client does not depend on
an open question, and is not an answer to it.**
[`WIRE.md` §5.1](./WIRE.md#51-construction) step 5 of the relay's verification
order says a command whose `signer_key` does not authorize the address fails with
`ERR_NO_ACCESS` (10);
[`WIRE.md` §6.3](./WIRE.md#63-commands-signed-by-the-send-side-queue-key) and §10
say every send-side refusal that would distinguish queue state collapses to
`ERR_UNAVAILABLE` (15). Those contradict for a send-side command, and the
contradiction is [#550](https://github.com/free2z/zuu/issues/550) item 1 —
**open as of 2026-08-23**, and not settled by this document, which decides
nothing about the protocol. Mapping *both* codes to `send-unavailable` on the
send side makes the client behave identically whichever way #550 lands, and shows
the user the same thing either way — which is independently what §10's
existence-oracle rule wants, since a sender that could tell an absent queue from
an unauthorized one is the oracle. If #550 resolves the other way, this row is
where the change goes and nothing else moves.

---

## 9. THE RULES YOU MUST NOT BREAK

Short, blunt, and each one has a specific failure behind it.

1. **Never ACK before the durable local write completes.** The relay deletes on
   ACK. ACK-on-read plus a crash is **permanent message loss**, because the
   relay's copy is already gone. This is the single most safety-critical rule in
   the delivery layer, the wire protocol cannot enforce it, and the frontend's
   half of it is that `message-received` fires only after the write
   ([`ARCHITECTURE.md` §6.3](./ARCHITECTURE.md#63-what-delivered-means),
   [`WIRE.md` §8.4](./WIRE.md#84-where-this-sits-in-the-four-delivery-states),
   [ADR 0002](./decisions/0002-multi-device.md)). A client that cannot promise
   durability **must not ACK at all** — §11.2.

2. **Never use `sentAt` for ordering, filtering, dedup, or any security
   decision.** It is attacker-controlled. Dedup by `msgId`. Ordering is §7's,
   and since 2026-08-25 the frontend does not perform it at all — see rule 10
   ([`ARCHITECTURE.md` §7](./ARCHITECTURE.md#7-application-framing--hash-linked-causal-ordering)).

3. **Never claim web parity. Never describe an ephemeral hint as enforcement.
   Never present a purge as a deletion.** Web copy claiming ZUULI's guarantee is
   false and is a hard product constraint
   ([ADR 0001](./decisions/0001-platform-priority.md),
   [`THREAT-MODEL.md` §3.6](./THREAT-MODEL.md#36-a-coerced-server-serving-targeted-javascript-to-web-clients)).
   A hint is a courtesy signal a non-conforming client ignores undetectably
   ([ADR 0007](./decisions/0007-retention-per-user.md)). A purge is *"asked N
   participants to delete; M confirmed"*, never *"deleted"*
   ([`ARCHITECTURE.md` §8.3](./ARCHITECTURE.md#83-purge-requests-and-why-nothing-here-is-retroactive)).

4. **Never make the key-change alarm dismissible, and never use a toast.**
   `sonner` — the toast library already in the app — auto-dismisses, and
   [`ARCHITECTURE.md` §9.2](./ARCHITECTURE.md#92-the-directory) requires the
   alarm to be **loud and non-dismissible**. It is persistent UI in the
   conversation and in the app, `acknowledge_alarm` records acknowledgement
   without hiding anything, and `Alarm.dismissible` is typed `false` so a
   dismissible component cannot be written against it.

5. **Never proceed silently when the witness set has fewer than *t* independent
   members.** *"Proceeding silently would overclaim and must not be the
   default."* Fail closed per §6.4's matrix, and display the number of
   **independent** witnesses — not the configured count — stating plainly when
   it is zero
   ([`KT.md` §8.3](./KT.md#83-the-threshold-rule-and-failing-closed)).

6. **Never copy `tauri-plugin-zcash`'s `on_event` blur handler.** That plugin
   clears the in-memory seed on `tauri::WindowEvent::Focused(false)`. Desktop
   windows lose focus constantly — every alt-tab, every notification, every
   spotlight search — and a messaging engine that tears down its state on blur
   would drop relay connections, stop acknowledging inbound messages, and leave
   ciphertext sitting on relays every time the user looked at another window.
   Lock on explicit lock, on `Exit`/`ExitRequested`, and on an idle timeout if
   one is wanted. **Not on blur.**

7. **Never surface a detected gap as a silent hole.** A gap is a certainty and
   is rendered in place, either as a repairable gap or as the
   `{ kind: "unrecoverable" }` marker. Equally: `hasGaps: false` never means
   "nothing is missing", because tail truncation is undetectable
   ([`THREAT-MODEL.md` §4.4](./THREAT-MODEL.md#44-tail-truncation-is-not-detectable-by-hash-links)).

8. **Never offer FROST/DKG in a browser.** Ceremonies create spending authority
   over real funds and are ZUULI-only; WASM additionally cannot guarantee memory
   zeroization, which independently disqualifies the browser for ceremony key
   handling ([ADR 0001](./decisions/0001-platform-priority.md),
   [`THREAT-MODEL.md` §3.6](./THREAT-MODEL.md#36-a-coerced-server-serving-targeted-javascript-to-web-clients)).
   The browser build must not render the entry point at all — not disabled, not
   "coming soon".

9. **Never present `found: false` as a verified absence, and never let it
   overwrite a pin.** Added 2026-08-24. `akd` 0.13 cannot prove that a handle is
   unregistered, so the log's "not registered" is an **assertion labelled
   unproved**, not a proof
   ([`KT.md` §8.1](./KT.md#81-lookup)'s correction, §3.10's correction,
   [`THREAT-MODEL.md` §4.11](./THREAT-MODEL.md#411-an-unregistered-handle-is-asserted-not-proved)).
   Copy or iconography implying the absence was checked is false in exactly the
   way rule 3's forbidden copy is false. And if the client already holds a pin
   for that handle, the answer is a contradiction it **cannot prove to anyone**:
   raise an alarm and fail closed. Silently dropping the pin would complete the
   attack.

10. **Never order a transcript in the frontend.** Added 2026-08-25.
   `list_messages` returns messages already in §7's order; render the sequence
   as given. Not a comparator, not a topological pass, not "just a stable sort
   for safety" — §7's order is protocol logic, the engine owns it, and a second
   implementation in TypeScript is what [ADR 0001](./decisions/0001-platform-priority.md)
   exists to prevent. It has been written once already and it rendered replies
   above the messages they answered in half of all one-to-one conversations
   ([§7](#7-ordering)'s correction, [#733](https://github.com/free2z/zuu/issues/733)).
   This binds the **mock** as well: a mock is a stand-in for the engine, so it
   owes the same ordered page, and it satisfies that by generating its transcript
   causally rather than by sorting one.

---

## 10. What is deliberately not in v1

Each of these is a decision with a record, not an oversight, and none of them
should be designed around speculatively.

| Not in v1 | Why, and where |
|---|---|
| **Multi-device registration** | The protocol, queues and key hierarchy assume per-device fan-out from day one; the **UI ships single-device**. Adding a device to an account is a wiretap and deserves its own design and review cycle ([ADR 0002](./decisions/0002-multi-device.md)). Build `devicesExpected` into the delivery UI anyway — it is 1 today and will not be. |
| **History transfer to a new device** | MLS forward secrecy means a new device cannot decrypt past epochs by design ([§13-D](./ARCHITECTURE.md#13-open-questions)). |
| **FROST/DKG ceremonies in the messenger UI** | Designed ([`ARCHITECTURE.md` §11](./ARCHITECTURE.md#11-frostdkg--the-first-application)) and ZUULI-only ([ADR 0001](./decisions/0001-platform-priority.md)). The `retentionClass: "ceremony"` value exists in the contract because ceremony transcripts are retained by default ([`ARCHITECTURE.md` §8.5](./ARCHITECTURE.md#85-ceremony-transcripts-are-retained-by-default)); nothing else about ceremonies is in v1. |
| **Attachments / encrypted media** | Out of scope for the first release; the storage decision must be made before building, not after ([§13-L](./ARCHITECTURE.md#13-open-questions)). |
| **Push notifications** | An **unresolved metadata leak**: push tokens are stable identifiers and notification timing goes to Apple and Google. There is no position yet and it must not be described as solved ([§13-H](./ARCHITECTURE.md#13-open-questions), [`THREAT-MODEL.md` §4.7](./THREAT-MODEL.md#47-push-notifications-are-an-unresolved-metadata-leak)). The protocol assumes a held WebSocket ([`WIRE.md` §16](./WIRE.md#16-what-this-document-leaves-open)). |
| **Nostr fallback transport** | Nostr relays retain by default and NIP-40 expiration is advisory, so it trades away the delete-on-ack property. Per conversation, opt-in, and the UI must state that ciphertext may be retained indefinitely by third parties ([`ARCHITECTURE.md` §6.7](./ARCHITECTURE.md#67-nostr-as-fallback-transport), [`THREAT-MODEL.md` §4.8](./THREAT-MODEL.md#48-nostr-fallback-means-accepting-retention)). |
| **Groups larger than 2** | 1:1 is one MLS group like any other, so the model generalizes; fan-out is O(members × devices) and the scale limit is unanswered ([§13-M](./ARCHITECTURE.md#13-open-questions)). `Conversation` deliberately carries `peerHandle` rather than a member list — that is the v1 shape, and it will change. |
| **Handle rename and transfer** | A change of *owner* rather than of *key*, creating a MITM window of a different shape. Still open ([§13-K](./ARCHITECTURE.md#13-open-questions)); [ADR 0014](./decisions/0014-directory-key-rotation.md) settles key rotation only. |
| **Client gossip** | The only anti-equivocation that functions before independent witnesses exist, and **its wire format does not exist** ([`KT.md` §8.4](./KT.md#84-gossip), [§13-R](./ARCHITECTURE.md#13-open-questions)). No UI for it in v1. |
| **A separate opt-in messaging handle** | The clean answer for the ~10% of real, active accounts the charset rule excludes (§11.3), deferred as directory design ([`WIRE.md` §14.4](./WIRE.md#144-alternatives-rejected)). Whether v1 simply excludes them or serves them this way is **an undecided product question**, not a settled omission ([§13-O](./ARCHITECTURE.md#13-open-questions)) — the one row in this table that may still move before v1. |
| **P2P (WebRTC) transport for messages** | An optimization, not a dependency ([`ARCHITECTURE.md` §10](./ARCHITECTURE.md#10-p2p-webrtc--an-optimization-not-a-dependency)). Not in the v1 command surface. |

---

## 11. The browser client

### 11.1 State the weaker guarantee, in the product

The browser build must carry a visible, persistent statement that its guarantee
depends on the server being honest at page-load time — in the messaging UI
itself, at the point where a user decides whether to have a sensitive
conversation, not in a footer or a help page. This is a **hard product
constraint**
([`THREAT-MODEL.md` §3.6](./THREAT-MODEL.md#36-a-coerced-server-serving-targeted-javascript-to-web-clients),
[ADR 0001](./decisions/0001-platform-priority.md)).

The browser build must not render ceremony entry points at all (§9 rule 8), and
`DeviceInfo.platform === "browser"` is how the UI knows.

### 11.2 Durability, and the hard rule

**A client that cannot promise durability must not ACK.**

The relay deletes ciphertext the instant it receives an ACK. IndexedDB is the
browser's only realistic local store and it is **evictable**: under storage
pressure, in a private window, or when the user clears site data, a browser may
discard the entire origin's storage without asking. `navigator.storage.persist()`
requests exemption and **may be refused**, silently, and differs by browser and
by engagement heuristics. `navigator.storage.persisted()` reports the current
state and can change after it was granted.

So the browser client's startup sequence is:

1. Call `navigator.storage.persist()`. Wrap it: it can throw or be absent.
2. Call `navigator.storage.persisted()` and `navigator.storage.estimate()`.
3. Set `DeviceInfo.durability`:
   - `"durable"` — persistence granted. Normal operation: durable write, then ACK.
   - `"best-effort"` / `"none"` — persistence refused or unavailable. **Enter
     no-ACK mode.**

**No-ACK mode** is a first-class operating mode, not an error path:

- The client **reads** its queues and displays messages normally.
- It **never sends `ACK`**, so the relay never deletes. The messages remain on
  the relay until their message TTL expires (default 7 days, ceiling 30 —
  [`WIRE.md` §7.7](./WIRE.md#77-ttls)), and any device that later achieves
  durability — including ZUULI on the same seed — receives them.
- It does **not** emit `device-delivered` receipts for messages it cannot durably
  hold, because a receipt is an end-to-end assertion the client cannot back.
- The UI states plainly: *this browser cannot promise to keep messages, so they
  are left on the relay and will expire.* Offer ZUULI as the durable client.
- Queues fill. The relay's per-queue caps are real, and a queue at its cap makes
  the sender's `APPEND` fail with `send-unavailable` — the sender sees delivery
  stop and cannot be told why ([`WIRE.md` §6.3](./WIRE.md#63-commands-signed-by-the-send-side-queue-key)).
  That is the honest cost of no-ACK mode and the UI must own it rather than
  discover it.

**The failure mode this rule prevents:** a browser tab ACKs on read, the relay
deletes, the browser evicts its IndexedDB overnight, and the messages are gone
from every copy that ever existed. There is no recovery path — not from the
relay, not from the peer, not from the mnemonic. Losing 7 days of relay-side
retention is recoverable; this is not.

Two further browser-storage rules:

- **Never treat a successful write as a durable write.** An IndexedDB
  transaction that completes is a write to a store the browser may discard as a
  unit. Only `persisted() === true` distinguishes them.
- **Re-check on every startup and on `visibilitychange`.** Persistence can be
  revoked. A client that checked once at install and cached the answer is a
  client that will ACK into a non-durable store.

### 11.3 The handle charset, and accounts that cannot have a handle

A messaging handle is:

```
/^[a-z0-9_]{1,30}$/     ASCII only, compared as bytes, no normalization
```

The restriction is not tidiness. A charset with no case and a single script makes
an entire class of homograph and mixed-script impersonation **not exist**, rather
than be defended against — `@аlice` with a Cyrillic а cannot be encoded as a
messaging handle at all — and a normalization function is itself the attack
surface
([`WIRE.md` §14](./WIRE.md#14-handle-charset-for-messaging--blocking-pre-check-resolved)).

**An entire class, not every class — and the remainder is your job, not the
protocol's.** `[a-z0-9_]` still contains `1`/`l` and `0`/`o`, indistinguishable
in most UI sans-serif faces: `@a1ice` and `@alice`, or `@b0b` and `@bob`, are
pairs a user cannot separate by reading them. Nothing below the UI defends
against that. Three build rules follow.

- **Render handles in a face that disambiguates** — monospace, or a text face
  with a slashed or dotted zero and a distinguishable `1`/`l`. A handle set in
  the same proportional sans as body copy cannot be checked by eye, and every
  surface that shows a handle counts: search results, invites, message headers,
  profile links.
- **Never write copy that sells the charset as a safety property.** "Handles are
  ASCII, so they can't be faked" is false and must not ship. What is true, and
  is the most a string of copy may claim, is that a handle cannot contain
  characters from another script.
- **Point the user at the check that is real.** Who a peer *is*, is established
  by safety-number verification — always available, and the strongest check in
  the system regardless of directory state
  ([§6.3](#63-verification-state),
  [§6.4](#64-witness-threshold--the-fail-closed-matrix)). A handle is an
  address, not an authentication, and first-contact copy should say so rather
  than implying the handle did the work.

An account is eligible iff `ascii_lower(username)` matches the pattern —
**`ascii_lower`, never a general "lowercase," and the distinction is load-
bearing.** Reject the raw username if it is not ASCII, checked before any
folding; only then fold ASCII `A`–`Z` to `a`–`z` and nothing else
([`WIRE.md` §14.1](./WIRE.md#141-proposed-rule)). A locale- or Unicode-aware
`lowercase()` folds some non-ASCII characters *to* ASCII — the Kelvin sign,
U+212A, folds to `k` — which would let a non-ASCII username slip past this
charset entirely, defeating the reason the charset exists. Older sentences in
this document set that say `lowercase(username)` mean `ascii_lower(username)`
in this exact sense.

The argument originally given for folding case — that platform uniqueness is
already enforced case-insensitively, so folding *cannot* collide two distinct
existing accounts — **is false, and was retracted on the record**
([`WIRE.md` §14.3](./WIRE.md#143-the-decision-and-the-cost-accepted)).
Case-insensitive uniqueness is an application convention living in two
serializers, not a property of the database, and folding case does collide real
accounts today. The eligibility *rule* is unchanged and uppercase still
disqualifies nobody; what does not hold is that the mapping is injective, and
the client consequences of that are spelled out below.

**What this predicate answers, and what it does not.** `ascii_lower(username)
matches the pattern` is candidate derivation: a pure function of the string,
implemented and safe to ship as
`tauri-plugin-f2zmsg`'s `handle.rs::eligibility`, exposed as
`check_handle_eligibility` below. It asserts nothing about who owns a handle in
the directory — that is authoritative publication, and it remains blocked on
backend work this contract does not do (the corrected census below, the
collision groups §14.3 of `WIRE.md` found in production, and a database-level
uniqueness invariant that does not exist yet). A client MUST NOT treat
`check_handle_eligibility` returning `eligible: true` as a reservation or a
guarantee that enrollment will succeed — only as "this string is well-formed."

free2z usernames are considerably broader — Django's `^[\w.@+-]+$` up to 150
characters — so **existing accounts containing `.`, `@`, `+`, `-`, any non-ASCII
character, or exceeding 30 characters after lowercasing are not eligible for a
messaging handle in v1.**

**How many accounts that is, is now measured, and the answer is the reason this
screen matters.** Measured against production on 2026-08-23
([`WIRE.md` §14.2](./WIRE.md#142-checked-against-free2zs-real-username-rules--measured),
[§13-O](./ARCHITECTURE.md#13-open-questions)):

| Of all existing accounts | Share |
|---|---:|
| Eligible after case-folding | **~90%** |
| **Ineligible** | **~10%** |

Ineligibility is overwhelmingly caused by `.` `@` `+` or `-` in the username —
just under a tenth of all accounts. Non-ASCII characters and over-length names
account for very few, and uppercase disqualifies nobody because the mapping
folds case. **Every ineligible account has logged in at least once and all but
one is still active**: this is not a set of dead rows, it is roughly a tenth of
real, current users. Design the ineligible state as a state a tenth of users
will see, because it is one.

Three things the frontend must not infer from that number:

- **It is not a live guarantee about today's account population.** This is a
  historical figure from one query against production on 2026-08-23, and this
  repository cannot re-run it: registrations continue, and `WIRE.md` §14.3's
  collision groups — found by the same query — are expected to be resolved
  before the mapping ships, which moves the eligible share without updating
  this table. Treat it as the evidence that motivated the design below, not as
  a number to cite as current.
- **It is not a temporary gap awaiting a migration.** Whether that ~10% is
  excluded from messaging discovery in v1 or served by a separate opt-in
  messaging handle is an **undecided product question**
  ([§13-O](./ARCHITECTURE.md#13-open-questions), §13-K). Do not write copy that
  promises either outcome.
- **`ascii_lower(username)` is not yet a unique key.** Case-insensitive username
  uniqueness lives in two serializers and **not in the database**, and
  production holds case-variant duplicate accounts today, in more than one
  group ([`WIRE.md` §14.3](./WIRE.md#143-the-decision-and-the-cost-accepted)).
  Those must be resolved before the mapping ships — backend work, tracked
  elsewhere — but the client consequence is now: never derive a messaging handle
  from a username locally, and never assume two accounts that fold to the same
  string are the same account. Always ask `check_handle_eligibility`.

Note also that the platform's *own* username space already contains the
homograph surface — `UnicodeUsernameValidator` is the validator actually
attached, non-ASCII usernames are legal on free2z today, and a small non-zero
number of accounts carry one
([`THREAT-MODEL.md` §4.10](./THREAT-MODEL.md#410-the-platform-username-space-contains-homographs-messaging-handles-do-not)).
The messaging charset does not fix that and must not be presented as fixing it.
Its mitigation is narrow and exact: a homograph string does not match the
messaging charset, so the directory refuses to resolve it at all, turning a
silent impersonation into a **lookup failure**. That means a user pasting a
handle copied from a free2z profile page or a comment byline may get
`handle-ineligible`, or a proved `found: false` (§3.10), for a username that
visibly exists — and the UI must explain that rather than look broken.

So the ineligible state is **a first-class screen, not an error dialog**:

- `check_handle_eligibility` is callable **before** enrollment and before the
  engine runs, so the UI can decide what to render without provoking a failure.
- `EngineState: "ineligible"` renders an explanatory state that says what
  *specifically* disqualifies the username (`reason` distinguishes
  `punctuation` from `non-ascii` from `too-long`), and that the account works
  exactly as it does today —
  it simply cannot be discovered by handle in the messenger yet.
- It must **not** be apologetic-and-empty, must not offer a rename flow (handle
  rename and transfer are unsolved — [§13-K](./ARCHITECTURE.md#13-open-questions)),
  and must not imply the restriction is temporary or arbitrary. Say what it buys,
  precisely: `@аlice` with a Cyrillic а cannot exist as a **messaging handle**.
  It can and does exist as a free2z username — that is exactly the surface the
  charset excludes from the messenger, and overstating it into "nobody can
  register that" is false (§11.3 above,
  [`THREAT-MODEL.md` §4.10](./THREAT-MODEL.md#410-the-platform-username-space-contains-homographs-messaging-handles-do-not)).
- Nothing about the ineligible state may look broken: no empty inbox that reads
  as a bug, no perpetual spinner, no notification badge, no navigation entry
  that leads somewhere dead.

The mock's `ineligible-handle` scenario (§5.4) exists so this screen is built
and reviewed rather than discovered at launch.

### 11.4 Everything else the browser shares

The browser speaks the **same protocol** through the same Rust core compiled to
WASM — there is no second implementation and no second code path
([ADR 0001](./decisions/0001-platform-priority.md)). So §3's command semantics,
§5's events, §6's state machines, §7's ordering and §8's errors all apply
unchanged. What differs is exactly three things: the trust statement (§11.1),
durability (§11.2), and the operations that are ZUULI-only (§10).

The client verifier reaches the browser cleanly — `lookup_verify` is ~1.11 ms in
WASM and the verifier bundle is ~48 KB brotli
([`KT.md` §10](./KT.md#10-measured-costs)) — so directory verification is not a
reason to weaken the browser client. **Append-only consistency verification is
not available to any client**, browser or native: the proof is
O(entries added) and was measured at 3.9 MB / 1–3 s for five epochs, which is a
witness's job, not a phone's
([`ARCHITECTURE.md` §9.2](./ARCHITECTURE.md#92-the-directory),
[`KT.md` §8.5](./KT.md#85-what-a-client-cannot-verify)). No UI may imply the
client checked it.

---

## 12. What is provisional, and what is open

### 12.1 Provisional in this document

Marked so an implementer does not mistake precision for settlement. The
**shapes** are the current best understanding; the **conventions** around them
(`plugin:f2zmsg|<cmd>`, `args` nesting, camelCase, event naming, the four TS
files) are settled.

| Item | Why it is provisional |
|---|---|
| Every field set in §3 | No `tauri-plugin-f2zmsg` exists. Fields will be added and removed as the engine lands. |
| `ContactRequest.bodyPreview` | Showing any part of an unsolicited, unauthenticated-at-the-relay first-contact payload is a moderation and safety question ([`WIRE.md` §12.4](./WIRE.md#124-the-honest-limits)) that has not been answered. It may become `null` always. |
| `WitnessConfig.independent` | Computed by a rule that does not exist ([§13-Q](./ARCHITECTURE.md#13-open-questions)). |
| `Conversation.peerHandle` (singular) | v1 is 1:1. Groups > 2 will replace this with a member list (§10). |
| `DeliveryStatus.devicesExpected` | Always 1 in single-device v1 ([ADR 0002](./decisions/0002-multi-device.md)); the field exists so the UI does not have to be rebuilt. |
| `SafetyNumber.zcashMemoPayload` | Verification over a shielded Zcash memo is described in [`ARCHITECTURE.md` §9.2](./ARCHITECTURE.md#92-the-directory) and has no specified payload format. |
| Retry budgets and backoff constants | Not specified anywhere yet; `send_retry_max` is named in [`WIRE.md` §6.3](./WIRE.md#63-commands-signed-by-the-send-side-queue-key) without a value. |
| Enrollment merge latency | Depends on the KT epoch cadence, whose values are placeholders ([§13-P](./ARCHITECTURE.md#13-open-questions)). |

### 12.2 Open questions this document inherits

Not answered here, and not answerable here. Listed so a frontend developer knows
which uncertainties are theirs to design around and which are somebody else's to
close: padding bucket sizes ([§13-F](./ARCHITECTURE.md#13-open-questions)),
relay redundancy *k* ([§13-G](./ARCHITECTURE.md#13-open-questions)), push
notifications ([§13-H](./ARCHITECTURE.md#13-open-questions)), handle rename and
transfer ([§13-K](./ARCHITECTURE.md#13-open-questions)), group scale
([§13-M](./ARCHITECTURE.md#13-open-questions)), proof-of-work calibration
([§13-N](./ARCHITECTURE.md#13-open-questions)) — which directly sets how slow
first contact feels on a phone — messaging-handle eligibility
([§13-O](./ARCHITECTURE.md#13-open-questions): the *measurement* is closed as of
2026-08-23 and is in §11.3, but the **product** question of whether the ~10% is
excluded in v1 or served by a separate opt-in handle is not), KT epoch cadence
([§13-P](./ARCHITECTURE.md#13-open-questions)), witness independence and the
default *t* ([§13-Q](./ARCHITECTURE.md#13-open-questions)), the client gossip
wire format ([§13-R](./ARCHITECTURE.md#13-open-questions)), and MLS `KeyPackage`
publication and exhaustion ([`KT.md` §12](./KT.md#12-what-this-document-leaves-open)).

### 12.3 Keeping this document from rotting

The failure mode for a document like this is that the plugin grows a command,
nobody updates §3, and the contract quietly becomes fiction. That is the kind of
drift `scripts/check-tauri-plugin-permissions.mjs` already prevents for every
plugin under `wallet/plugins/` — as of 2026-08-25 across eight artifacts, and at
the time this section was written across six (§2.3): `build.rs`'s
`COMMANDS`, `invoke_handler`, `permissions/autogenerated/commands/`,
`permissions/schemas/schema.json`, the generated `reference.md`, and Zuuallet's
tracked target schemas. It does **not** read `permissions/default.toml` or any
capability file, and its plugin directory, its `zcash:` identifier prefix and
its Zuuallet schema directory are hard-coded throughout.

Two pieces of work follow, and **neither is a one-line change**:

- ~~**A permission checker for `f2zmsg`.**~~ **Done, 2026-08-25, and the
  prediction below was wrong in an instructive way.** It said the checker "has
  to be written, not parameterized". It was parameterized instead, and the
  reason is that "write a second one" is the decision that produces two
  near-identical checkers which then drift — one gains an assertion, the other
  does not, and the plugin nobody looked at ships a command with no permission.
  Everything this paragraph correctly identified as *different* between the two
  plugins turned out to be a field rather than an obstacle: the namespace, the
  registry macro, the consuming apps, and whether a consumer tracks generated
  target schemas at all. Zuuli tracks none, so `f2zmsg`'s row simply carries no
  sixth link.

  Both gaps §2.3 named are closed with it — `permissions/default.toml` and the
  capability files are now derived from the command registry and checked for
  every plugin, which nothing did before, for any plugin. The original text is
  kept below rather than deleted, because a prediction that was reasonable and
  wrong is worth more to the next reader than a tidy record:

  > It has to be written, not parameterized: nothing in the existing script
  > generalizes past the hard-coded plugin path, namespace and schema
  > directory, and Zuuli tracks no generated schemas at all, so the sixth link
  > has no counterpart to compare against. Having to write it is the
  > opportunity to close the two gaps §2.3 names — deriving
  > `permissions/default.toml` from the command registry, and asserting the
  > `f2zmsg` grants in `capabilities/default.json` — which nothing checks
  > today, for any plugin. Stating the gap makes the checker a justified piece
  > of scoped work rather than an assumed freebie.
- ~~**A companion `scripts/check-client-contract.mjs`**~~ **Done, 2026-08-25,
  and it did not need a new file.** `wallet/zuuli/scripts/messaging-contract.node-test.mjs`
  already read §3's command tables and compared them to `bridge.ts`; it now
  compares the same tables to `tauri-plugin-f2zmsg`'s command registry as well,
  in both directions, with the enrollment trio excluded because §2.2 puts those
  in the app crate. Three artifacts, one comparison, no third place for the set
  to be written down.

---

## 13. References

[`ARCHITECTURE.md`](./ARCHITECTURE.md) ·
[`THREAT-MODEL.md`](./THREAT-MODEL.md) ·
[`WIRE.md`](./WIRE.md) ·
[`KT.md`](./KT.md) ·
[ADR 0001](./decisions/0001-platform-priority.md) ·
[ADR 0002](./decisions/0002-multi-device.md) ·
[ADR 0004](./decisions/0004-metadata-ambition.md) ·
[ADR 0005](./decisions/0005-federation.md) ·
[ADR 0006](./decisions/0006-zcash-coupling.md) ·
[ADR 0007](./decisions/0007-retention-per-user.md) ·
[ADR 0009](./decisions/0009-queue-addressing-and-binding.md) ·
[ADR 0011](./decisions/0011-first-contact-contact-queues.md) ·
[ADR 0012](./decisions/0012-anti-abuse-v1.md) ·
[ADR 0013](./decisions/0013-key-transparency-log.md) ·
[ADR 0014](./decisions/0014-directory-key-rotation.md) ·
[RFC 9420 — MLS](https://datatracker.ietf.org/doc/html/rfc9420) ·
[Storage Standard — persistence](https://storage.spec.whatwg.org/) ·
the existing two-runtime-mode contract in `wallet/zuuli/src/lib/wallet/`
(`bridge.ts`, `mock.ts`, `types.ts`, `mock.test.ts`), which this one mirrors.
