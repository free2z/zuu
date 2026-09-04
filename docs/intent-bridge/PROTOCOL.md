# The cross-app intent bridge, version 1

**Status:** wire format and both implementations landed. **Not shippable as a
transport** — see [§7](#7-what-is-blocked-on-461).

Issues: [#905](https://github.com/free2z/zuu/issues/905) (this document),
[#904](https://github.com/free2z/zuu/issues/904) (why the apps are splitting),
[#461](https://github.com/free2z/zuu/issues/461) (the blocking prerequisite).

Companion documents:

- [`CALLER-AUTHENTICATION.md`](./CALLER-AUTHENTICATION.md) — who is calling, per
  platform, and what cannot be established.
- [`CONFORMANCE.md`](./CONFORMANCE.md) — every guard, and the mutation that
  proves the test for it is not inert.
- [`AUTHORITY.md`](./AUTHORITY.md) — the ZUULI side: what `execute-payment`
  actually does, why `sign-challenge` is not implemented, and where the
  confirmation is weaker than it looks.

---

## 1. What this is

A versioned request/response protocol carrying **authority delegation** from
`cash.free2z.zuuli`, which holds the Zcash seed, to applications that hold none
— today `cash.free2z.free2z` and `cash.free2z.e2e2z`, tomorrow whatever else
[#904](https://github.com/free2z/zuu/issues/904) splits out.

| Intent | The request carries | ZUULI does | Returns |
|---|---|---|---|
| `sign-challenge` | challenge bytes, purpose, claimed caller | native confirmation | signature |
| `issue-device-credential` | device **public** keys, handle, validity window | derives §4.2 account keys, native confirmation | `DeviceCredential` |
| `execute-payment` | recipient, amount, memo, fee | re-derives and shows its **own** payment review | txid or refusal |

Two invariants that the format itself enforces, rather than leaving to
discipline:

- **The seed never appears in a message.** There is no field it could occupy.
- **Device private keys never leave their app.**
  `issue-device-credential` carries `device_pk` and `device_kem_pk`; the private
  halves are generated from the OS CSPRNG in the calling app and stay there
  (`docs/e2ee/ARCHITECTURE.md` §4.1).

And one that the *pipeline* enforces: **nothing here is a continuous grant.**
Every intent is one-shot, expiring on two clocks, and bound to one approval of
one rendering.

## 2. Where the code is

| Half | Path | Role |
|---|---|---|
| Wallet — the rules | `rs/crates/f2z-intent` | parse, validate, expire, one-use, authorize caller, bind confirmation |
| Wallet — the authority | `wallet/zuuli/src-tauri/src/intent.rs` | receive, confirm natively, act. `execute-payment` only — see [`AUTHORITY.md`](./AUTHORITY.md) |
| Clients | `wallet/shared/src/intent` (`@free2z/wallet-shared`) | build requests, remember them, refuse unsolicited answers |
| First caller | `wallet/e2e2z/src/lib/enrollment` | `issue-device-credential`, built through the client half, with one transport seam that is shut |

There is **one** client implementation and
`wallet/zuuli/scripts/project-boundary.mjs` enforces that: the guard names may
only be declared under `wallet/shared/src/intent`, the module must be
re-exported from the package's single entry point, and an app that mints a
label in this protocol's domain namespace is a violation. Seven negative
controls in `project-boundary.node-test.mjs` prove each half of that rule
fires.

Neither half performs cryptography beyond hashing. The signature comes from
`f2z-msg-identity`, the `DeviceCredential` from `f2z-kt-core`, the transaction
from `tauri-plugin-zcash`. This protocol decides *which bytes those layers may
act on, and when*.

## 3. The wire format

The encoding is `tls_codec` — the TLS presentation language — reached through
`f2z-codec`. Not a new codec, and not JSON, for three reasons in decreasing
order of importance:

1. **Re-encode equality.** `docs/e2ee/WIRE.md` §3.3 requires every received
   structure to be decoded, re-encoded and byte-compared, and requires the
   *re-encoded* bytes to be what a hash covers. The confirmation binding of
   [§5](#5-binding-an-intent-to-its-confirmation) is a digest over the request,
   so a request that decodes two ways is a request whose approval means two
   things. `f2z_codec::decode_canonical` is the only implementation of that
   rule in this repository and stays the only one.
2. **One decoder in the audit scope.** The client half ships inside apps that
   already carry `f2z-codec` for messaging.
3. **One encoding per value.** JSON has several for most values — key order,
   number formatting, whitespace, duplicate keys — so "the bytes the user
   approved" and "the bytes the wallet executed" would be the same string only
   by convention.

### 3.1 Envelopes

```text
struct {
    uint16 version;             // 1
    opaque body<0..2^24-1>;     // IntentRequestV1, when version == 1
} IntentRequestEnvelope;

struct {
    uint16 version;
    opaque body<0..2^24-1>;     // IntentResponseV1, when version == 1
} IntentResponseEnvelope;
```

**The body is opaque at the envelope layer, and that is the entire
version-refusal mechanism.** A reader checks `version` and refuses
`INTENT_UNSUPPORTED_VERSION` *before interpreting a single byte of `body`*.

This is not cosmetic. Had `version` and the v1 fields shared one flat
structure, a version-2 request that merely appended a field would decode as a
version-1 request plus trailing bytes — and a decoder one line less strict than
ours would accept it, granting authority from a message it did not understand.
`#905` asks for "an unknown version is refused, not best-guessed"; the opaque
body is what makes that structural rather than remembered.

### 3.2 Version-1 bodies

```text
struct {
    uint16 intent;              // the family; 0 is not a family
    opaque request_id[32];      // CSPRNG. One-use key AND response correlator.
    opaque caller<0..255>;      // CLAIMED. Not authenticated by this structure.
    opaque purpose<0..255>;     // shown inside ZUULI's own rendering
    uint64 issued_at_ms;
    uint64 expires_at_ms;
    opaque payload<0..2^24-1>;  // the family request
} IntentRequestV1;

struct {
    opaque request_id[32];      // echoes the request
    uint16 intent;              // echoes the request
    uint16 status;              // 0 fulfilled, else a refusal status
    opaque payload<0..2^24-1>;  // the family result; empty on refusal
} IntentResponseV1;
```

`intent` is a raw `uint16` and not a codec enum, for the same reason `version`
is: an unknown family survives re-encode equality and is then refused by
**policy** (`INTENT_UNKNOWN_INTENT`), rather than by a decode failure that would
make a well-framed request indistinguishable from a corrupt one. `payload` is
opaque until `intent` has been resolved, so an unknown family's payload is never
decoded as a known family's.

### 3.3 Family payloads

```text
struct { opaque challenge<0..2^24-1>; } SignChallengeRequestV1;
struct { opaque signer_pk[32]; opaque signature[64]; } SignChallengeResultV1;

struct {
    opaque handle<0..255>;
    opaque device_pk[32];
    opaque device_kem_pk<0..2^24-1>;
    uint64 not_before_ms;
    uint64 not_after_ms;
} IssueDeviceCredentialRequestV1;
struct { opaque credential<0..2^24-1>; } IssueDeviceCredentialResultV1;

struct {
    opaque recipient<0..255>;
    uint64 amount_zatoshis;
    opaque memo<0..255>;
    uint64 fee_zatoshis;
} ExecutePaymentRequestV1;
struct { opaque txid[32]; } ExecutePaymentResultV1;
```

`credential` is carried as opaque bytes on purpose: it is a
`f2z_kt_core::DeviceCredential`, defined once in that crate, and a second
definition here would be a second chance to disagree about the bytes the whole
key-transparency directory is built on.

`ExecutePaymentRequestV1` is a **proposal, not an instruction.** ZUULI
re-derives its own payment review from its own wallet state and shows that; the
values here only have to survive comparison against it.

### 3.4 Field rules a decoder cannot express

Refused at parse, on both sides:

| Rule | Why |
|---|---|
| `expires_at_ms > issued_at_ms` | an inverted window has no valid instant |
| `expires_at_ms - issued_at_ms ≤ 300 000` | five minutes. `#904`: "nothing here is a continuous grant". Enforced on the *declared* window, so it binds even when the verifying clock is wrong |
| `0 < challenge ≤ 512 bytes` | the wallet signs what it is given; an unbounded field is a general-purpose signing oracle, and a user cannot audit a kilobyte of base64 |
| `amount_zatoshis > 0` | a zero-value payment is not a payment |
| `not_after_ms > not_before_ms` | as above |
| bridge text (see §3.5) on `caller`, `purpose`, `handle`, `recipient`, non-empty `memo` | these are rendered to a human who is about to delegate authority |
| a refusal carries an empty payload | a payload beside a non-zero status is a channel with no defined meaning |

### 3.5 Bridge text

UTF-8, non-empty, at most 255 bytes, trimmed, and containing **no** code point
in: `U+0000`–`U+001F`, `U+007F`–`U+009F`, `U+00AD`, `U+061C`, `U+180E`,
`U+200B`–`U+200F`, `U+202A`–`U+202E`, `U+2060`–`U+2064`, `U+2066`–`U+2069`,
`U+FEFF`, `U+E0000`–`U+E007F`.

[#528](https://github.com/free2z/zuu/issues/528) established that the native
payment review renders layout controls *visibly* rather than letting a memo
spoof the review it appears inside. The bridge inherits the requirement and
answers it one step earlier, by refusing outright — because the source differs.
A memo the wallet's own user typed is content they authored and can see;
escaping preserves their text while making the trickery visible. A `purpose`
string arriving over the bridge is authored by another app with the explicit
goal of appearing inside ZUULI's confirmation. There is no legitimate
intent-bridge string that needs `U+202E RIGHT-TO-LEFT OVERRIDE`.

**Not** refused: confusable scripts. `раypal` in Cyrillic parses. Shipping a
confusables table into a `no_std` crate is not the control that stops it — the
caller registry is, because ZUULI renders the caller's name from **its own
registry** and never from the request. That limit is stated here rather than
implied.

### 3.6 A canonical vector

The same 130 bytes are pinned, by hand, in
`rs/crates/f2z-intent/tests/wire_vectors.rs` **and**
`wallet/zuuli/src/lib/intent-bridge.test.ts`. Two implementations agreeing with
themselves proves nothing; two implementations agreeing with one written-down
constant is what makes "one wire format" a fact rather than an intention.
[#564](https://github.com/free2z/zuu/issues/564) is the precedent: a re-encode
of a re-decode stays green straight through a format change.

```text
0001                      version = 1
00007d                    body length = 125
  0001                    intent = 1 (sign-challenge)
  77 x32                  request_id
  12 "cash.free2z.free2z" caller
  11 "Sign in to free2z"  purpose
  0000018bcfe56800        issued_at_ms  = 1 700 000 000 000
  0000018bcfe65260        expires_at_ms = 1 700 000 060 000
  000023                  payload length = 35
    000020                challenge length = 32
    5a x32
```

Its request digest (§5) is
`2e23dfbdfa0ad8da3036bac0756e9191b29f8d7aac3e46b192934c7ddf09affb`.

## 4. The wallet-side pipeline

`f2z_intent::IntentGate::admit` is the single entry point, and it is single on
purpose: every guard below is separately testable, which is also the hazard —
an integration that parses and forgets to claim has a bridge that looks
finished and replays. `#553`'s lesson. `admit` returns an `AdmittedIntent`, and
an `AdmittedIntent` cannot be constructed any other way, so "this request was
admitted" is a type rather than a comment.

The order is a decision:

1. **Parse** — canonical decode, version gate, family gate, field rules.
2. **Authorize the caller** — see
   [`CALLER-AUTHENTICATION.md`](./CALLER-AUTHENTICATION.md). Before the
   identifier is recorded, so a stranger cannot fill the ledger.
3. **Check the window** — against the wallet's clock, not the caller's claim,
   with a two-minute tolerance on *issuance* and none on expiry.
4. **Spend the identifier** — last, so a request refused by 1–3 does not burn an
   identifier the honest caller may retry with.

Then, and only then, ZUULI renders **its own** confirmation.

### 4.1 Which refusals burn the identifier

A caller-facing consequence of that ordering, because it decides what a retry
has to look like:

| Refused at | `request_id` |
|---|---|
| steps 1–3 — malformed, unsupported version, unknown family, invalid field, unregistered caller, expired or not-yet-valid window | **not spent.** The honest caller may present the same bytes again |
| step 4 and everything after — replay, ledger full, and every refusal the wallet reaches *after* admission (a family this build does not implement, a user who cancelled, `INTENT_UNAVAILABLE`) | **spent, permanently** |

So **an honest caller that retries after `INTENT_UNAVAILABLE` must mint a fresh
`request_id`.** Re-presenting the same bytes gets `INTENT_REPLAY`, not a second
attempt.

That is the safe direction and it is deliberate rather than incidental: the
alternative — releasing an identifier because *this* attempt did not spend
money — would mean deciding, after the fact, that an approval the user may have
already given did not count. One-use has to be decided before the wallet acts,
or it is not one-use.

### 4.2 One-use

The replay ledger holds 1024 unexpired identifiers. When it is full it
**refuses** (`INTENT_LEDGER_FULL`) rather than evicting the oldest — because an
attacker who can send N+1 intents would otherwise evict the record of the one
they want to replay, and the ledger would then cheerfully accept it. That is
`WIRE.md` §5.5's seen-set bound, answered the same way. Because every window is
capped at five minutes, pruning always makes progress, so a full ledger is a
transient refusal and never a wedge.

The ledger is process-local and lost on restart, deliberately — the same choice
`wallet/zuuli/src/lib/wallet/creator-tip.ts` makes. Be precise about what that
costs, because it is easy to overstate:

- A restart destroys the **authorization object**, so an approval granted before
  the restart cannot be spent after it. That much the process boundary gives.
- It does **not** make the *request* unrepeatable. Inside its ≤5-minute window
  the same bytes are admitted again by an empty ledger, and the user is shown
  the same confirmation again.

So the barrier against a restart turning one issuance into two payments is **a
second human approval**, not the ledger. Two approvals of two identical
confirmations are two payments. That is the correct behaviour for a control
whose authority is the human — but "one-use" here means one use per process, and
the durable guarantee is the confirmation, not the identifier.

## 5. Binding an intent to its confirmation

This is the guard that makes the bridge a security boundary rather than a
message format. It generalises two things this repository already does:
[#528](https://github.com/free2z/zuu/issues/528)'s native confirmation token,
and `creator-tip.ts`'s frozen nonce-keyed snapshot.

```text
request_digest = H("free2z/intent/v1/request", canonical IntentRequestEnvelope)

struct {
    opaque request_digest[32];
    opaque review_digest[32];   // the wallet's OWN re-derivation of what it showed
    opaque token[32];           // CSPRNG, minted when the user approves
} ConfirmationTranscriptV1;

token_hash = H("free2z/intent/v1/confirmation", ConfirmationTranscriptV1)
```

`H(label, x)` is `BLAKE2b-256(label || x)` with no separator —
`docs/e2ee/WIRE.md` §1.3 — so the label set must be prefix-free across the whole
repository, and `scripts/check-hash-domain-labels.mjs` holds it that way.

`request_digest` covers **every** field, because it is taken over the re-encoded
envelope. `review_digest` is the wallet's own summary of what it rendered — for
`execute-payment`, the existing `send_review_digest`, derived from the
*proposal* rather than from the request. Binding both means neither can move
alone: change one zatoshi and `request_digest` changes; re-render the review
against a different proposal and `review_digest` changes.

The transcript is a codec structure and not a concatenation. Three fixed-width
fields would concatenate unambiguously today; a fourth, variable-width field
added later would not, and "this concatenation happens to be unambiguous" is a
property nobody re-checks at the moment they add a field.

The authorization expires on **both** a monotonic and a wall clock and refuses a
wall-clock reading earlier than issuance. All three are load-bearing and each is
defeated without the others:

| Attack | Caught by |
|---|---|
| suspend the device (monotonic stalls, real time passes) | the **wall** deadline |
| hold the wall clock just after issuance while real time passes | the **monotonic** deadline |
| wind the wall clock back past issuance | the issuance comparison |

`ConfirmationAuthorization::consume` takes `self`, so one-use is the borrow
checker's job rather than a `bool` field's.

## 6. The client side

`createIntentSession()` is `creator-tip.ts` generalised. Its comment survives
the substitution of "deep-link response" for "route state" word for word:

> A route state is renderer-controlled and therefore cannot authenticate
> itself. Keep the source snapshot in module memory and use the route nonce
> only as a lookup capability. Reloads and fresh deep links intentionally lose
> this map and fail closed.

A response is an *answer* only if this client is holding a matching outstanding
question. Family and window are re-checked against the frozen record, the entry
is removed whether the response is accepted or refused, and the map is never
persisted.

**What that proves:** the responder saw the request. `request_id` is 32 CSPRNG
bytes that appeared in exactly one outbound link, so a bystander cannot forge a
response.

**What it does not prove:** that the responder is ZUULI. See §7.

### 6.1 The first caller

`wallet/free2z/src/lib/bridge/creator-tip.ts` is the first production consumer:
a creator ZEC tip ([#790](https://github.com/free2z/zuu/issues/790)). It
collects the amount — the product gap that kept `execute-payment` unbuildable,
since `encodeExecutePaymentPayload` refuses a non-positive amount — builds the
request through this package, and hands it to `./intent-transport`, which is
**one interface with one fail-closed implementation**. Its `exchange` cannot
return bytes; it rejects with a typed error naming #461, and the UI says that
nothing was sent.

Two details of that caller are worth copying rather than reinventing:

- **One question per exchange.** The outstanding-question map is created per
  call with capacity one. `IntentSession.accept` returns the family and the
  payload but not *which* question was answered, so a shared map with two
  requests in flight could let the second's answer be read as the first's. A
  map holding one question cannot make that mistake.
- **A txid is a value, not a formatting step.** It comes back only from
  `decodeExecutePaymentResult`, which reads exactly 32 bytes and refuses
  anything else, because an app that has shown "sent" cannot unshow it.

## 7. What is blocked on #461

Everything above is correct regardless of how the bytes travel. Nothing above is
*sufficient* without a transport that authenticates the response destination,
and we do not have one:

- **Custom schemes are not an authenticated channel.** Any app can register
  `zuuli://`. `#904` says this plainly and `#905` refuses to ship on it. Doing
  so would recreate [#367](https://github.com/free2z/zuu/issues/367) — a
  confused deputy — at the OS layer instead of the frame layer.
- **Verified App Links and Universal Links are domain-bound.** Only the app
  whose package or team owns the domain association receives the link. That is
  the property the response half of this protocol rests on, and it requires
  `assetlinks.json` and `apple-app-site-association` served from a domain we
  control — [#461](https://github.com/free2z/zuu/issues/461), currently blocked.

Therefore, until #461 lands:

- **No intent carrying authority may be dispatched over a deep link.** Not
  `sign-challenge`, not `issue-device-credential`, not `execute-payment`.
- The one caller that exists, `wallet/e2e2z/src/lib/enrollment`, holds that line
  in one file: `transport.ts` declares an `IntentTransport` interface and ships
  the only implementation there is, which **rejects**. It rejects before the
  caller samples a device key set — sampling one for a request that cannot leave
  the process discards the previous secrets for nothing — and it rejects again
  inside `dispatch`, unconditionally, so flipping the availability flag moves the
  refusal rather than removing it. When #461 lands, the work is to write an
  `IntentTransport` and register it; nothing else on that path changes.
- `f2z-intent` deliberately contains **no transport**: no URL parsing, no intent
  filter, no scheme. Adding one is the work #461 gates, not work this crate
  quietly permits.
- The residual risk if the App Link assumption fails is stated in
  [`CALLER-AUTHENTICATION.md` §4](./CALLER-AUTHENTICATION.md#4-response-authenticity).

What *is* usable today, and is why this landed ahead of the transport: the wire
format is fixed, both implementations exist and agree byte-for-byte, every guard
has a mutation-verified test, and the two hard questions are written down
instead of discovered during integration.
