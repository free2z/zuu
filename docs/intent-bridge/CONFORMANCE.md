# The conformance suite, and the mutations that prove it is not inert

[#905](https://github.com/free2z/zuu/issues/905) asks for a conformance suite
"covering replay, expiry, tamper, wrong-caller, forged-response — **each proven
to fail without the guard**." This document is that proof.

## Why the proof is required

This repository has been bitten twice by tests that passed whether or not the
code they claimed to test was present.
[#589](https://github.com/free2z/zuu/issues/589) found
`small_order_keys_are_rejected_by_strict_verification` using an all-zero
signature that *both* the safe and the unsafe function reject, so the test
passed with strict verification removed.
[#603](https://github.com/free2z/zuu/issues/603) then found a second crate had
independently written the same inert fixture.

An assertion that a guard works is worth what a green run is worth. So every
case below was verified by **deleting or inverting the guard in the source**,
running the suite, watching it fail with a named assertion, and restoring the
guard. The tables record what happened.

## How to reproduce

Both matrices are ordinary scripted edit/run/restore loops. Rust:

```
cargo test -p f2z-intent          # baseline: green
# for each row: patch src/, cargo test -- --exact <test>, restore
```

TypeScript:

```
cd wallet/zuuli && npx vitest run src/lib/intent-bridge.test.ts
# for each row: patch wallet/shared/src/intent/, re-run, restore
```

Both were run to completion in the foreground on the branch that introduced
them. Both ended `AFTER RESTORE: GREEN`, which is the second half of the
evidence — a matrix that leaves a mutation applied has proved nothing about the
tree that ships.

## Rust — `rs/crates/f2z-intent`

Baseline: 63 tests green (35 unit, 25 conformance, 3 wire vectors).

| Guard, as mutated | Test that must fail | Result |
|---|---|---|
| version gate refuses an unimplemented version | `an_unknown_version_is_refused_before_the_body_is_read` | FAILS |
| family gate refuses an unimplemented intent | `an_unknown_intent_family_is_refused_rather_than_reinterpreted` | FAILS |
| canonical decode refuses trailing bytes | `malformed_input_is_refused_at_every_shape` | FAILS |
| challenge length bound | `an_oversized_challenge_is_refused_so_signing_is_not_an_oracle` | FAILS |
| declared-lifetime ceiling | `wire::tests::an_over_long_window_is_refused_regardless_of_the_verifying_clock` | FAILS |
| replay ledger refuses a spent identifier | `a_replayed_intent_is_refused` | FAILS |
| ledger fails closed instead of evicting | `a_full_ledger_refuses_rather_than_forgetting_what_it_must_refuse` | FAILS |
| request-window expiry | `an_expired_intent_is_refused` | FAILS |
| confirmation deadline: **monotonic** half | `a_confirmation_cannot_be_extended_by_suspend_or_by_the_clock` | FAILS |
| confirmation deadline: **wall** half | `a_confirmation_cannot_be_extended_by_suspend_or_by_the_clock` | FAILS |
| confirmation deadline: **rollback** guard | `a_confirmation_cannot_be_extended_by_suspend_or_by_the_clock` | FAILS |
| confirmation binds the request digest | `a_tampered_field_breaks_the_confirmation_binding` | FAILS |
| caller registry membership | `a_wrong_caller_intent_is_refused` | FAILS |
| Android package attestation | `an_android_impersonator_is_caught_by_the_platform_and_by_the_certificate` | FAILS |
| Android signing-certificate check | `an_android_impersonator_is_caught_by_the_platform_and_by_the_certificate` | FAILS |
| layout-control refusal in bridge text | `a_layout_control_cannot_reach_the_confirmation` | FAILS |
| response family cross-check | `a_response_to_a_question_nobody_asked_is_refused` | FAILS |
| response one-use | `a_response_is_accepted_exactly_once` | FAILS |

**18 mutations, 18 failures, 0 survivors.**

The three dual-clock rows are the ones worth reading twice. Each half of
`Deadline::check` defends against a *different* ordinary device behaviour, and
the first version of that test only caught one of them — removing the monotonic
half left the suite green, because the fixture's "suspend" case is caught by the
wall deadline. The test was strengthened with a third case (the wall clock held
just after issuance while real time passes) before the row above could be
written. That is what a mutation matrix is for: the mutation found a weak test,
not a weak guard.

## TypeScript — `wallet/shared/src/intent`

Baseline: 24 tests green.

| Guard, as mutated | Result |
|---|---|
| version gate (response) | FAILS |
| version gate (request) | FAILS |
| family gate | FAILS |
| refusal-may-not-carry-a-payload | FAILS |
| layout-control refusal | FAILS |
| trimmed-text rule | FAILS |
| fatal UTF-8 decoding (`TextDecoder({fatal:true})`) | FAILS |
| declared-lifetime ceiling | FAILS |
| challenge length bound | FAILS |
| session correlation by identifier | FAILS |
| session family cross-check | FAILS |
| session one-use | FAILS |
| session expiry | FAILS |
| session fails closed when full | FAILS |
| trailing-byte refusal **and** request re-encode equality, together | FAILS |

### Two guards that survive their own mutation, and why that is a fact about the format

Reported honestly rather than quietly dropped from the table:

| Guard | Mutation result |
|---|---|
| `ByteReader.take` bounds check | **still green** |
| `ByteReader.finish` trailing-byte refusal, alone | **still green** |

Neither is a hole in the tests. Version 1 has exactly one encoding per value —
no varints, no optional fields, no alternative representations — so
`finish()` and re-encode equality are *redundant by construction*: a trailing
byte makes the offset disagree with the length **and** makes the re-encoding
differ, and either one alone refuses it. Likewise, running the reader past its
input always leaves `offset > length`, which `finish()` catches even with the
bounds check deleted.

The combined row above is the honest proof: with **both** trailing-byte guards
removed, a trailing byte is accepted and the suite fails. The redundancy is
deliberate — `WIRE.md` §3.3 requires re-encode equality, and the bounds check is
what keeps a *future* reader safe if someone adds a decode path that forgets
`finish()` — and claiming an independent test for each would have been the
overstatement this document exists to avoid.

## The e2e2z caller — `wallet/e2e2z/src/lib/enrollment`

The first application to build an intent. `#904` splits the messaging surface
away from the wallet, so e2e2z holds device keys and never anything
seed-derived, and the one operation it cannot perform alone is enrollment
(`ARCHITECTURE.md` §4.2). It therefore builds an `issue-device-credential`
request — really, through the shared implementation, over its own OS-CSPRNG
device public keys — and fails at the transport, because there is not one.

Baseline: 42 tests green across `transport.test.ts`, `deviceKeys.test.ts` and
`issueDeviceCredential.test.ts`, plus 5 across
`wallet/e2e2z/src/lib/messaging/enroll-intent.test.ts` and
`enroll-chunk-failure.test.ts`, plus the 6 in
`wallet/e2e2z/scripts/authority-boundary.node-test.mjs`. Reproduce with
`cd wallet/e2e2z && npx vitest run && node --test scripts/authority-boundary.node-test.mjs`.

| Guard, as mutated | Test that must fail | Result |
|---|---|---|
| `enroll` refuses instead of returning a status, **after** a fulfilled response | `enroll builds a real intent and still cannot enroll > never resolves to an EnrollmentStatus even on a fulfilled response` | FAILS |
| `enroll` refuses instead of returning a status, **before** the intent path | `the enrollment gap > never resolves to an EnrollmentStatus, however shaped` | FAILS |
| the shipping transport rejects rather than resolving | `the intent transport > never resolves to bytes a caller could mistake for a response` | FAILS |
| the shipping transport's refusal is not gated on `available` | `the intent transport > does not gate its refusal on the availability flag` | FAILS |
| session correlation, seen from the caller | `refuses an answer to a different request`, `refuses an answer whose identifier differs in one byte`, `refuses a replay of an answer it already accepted` | FAILS |
| `IssueDeviceCredentialResultV1` trailing-byte refusal **and** re-encode equality, together | `the issue-device-credential family result > refuses trailing bytes` | FAILS |
| `IssueDeviceCredentialResultV1` non-empty credential | `the issue-device-credential family result > refuses a zero-length credential` | FAILS |
| seed authority: the wallet plugin as a dependency | `e2e2z holds neither seed authority nor dispatch authority` | FAILS |
| seed authority: a `plugin:zcash\|` invoke in the renderer | `e2e2z holds neither seed authority nor dispatch authority` | FAILS |
| seed authority: `get_seed_phrase` named in executable code | `e2e2z holds neither seed authority nor dispatch authority` | FAILS |
| `enroll`'s lazy `import()` inside the `try`, so a chunk-load failure still wears the typed refusal | `a chunk that never loads > still refuses with the typed enrollment refusal` | FAILS |
| dispatch authority: only a test may call `setIntentTransport` | `e2e2z holds neither seed authority nor dispatch authority` | FAILS |

**12 mutations, 12 failures, 0 survivors.** Every one was applied, watched to
fail with a named assertion, and restored; the tree ends green.

The last two rows came out of adversarial review and are the same objection
pointed in two directions. `enroll` reaches its client through a lazy
`import()`; with that statement *outside* the `try`, a chunk that fails to load
escapes as an untyped error, and the screen — which branches on
`isEnrollmentUnavailable` — would say "something broke" instead of the one true
thing this app can say. And `setIntentTransport` is exported so the tests can
drive the shipping path against a wallet stand-in; a guard defeated by one call
to it from a renderer module has exactly the shape of the guard defeated by one
boolean that `transport.ts` argues against. Neither changed what the app can do
— both were already fail-closed — and both are now pinned rather than true by
accident.

### What survived, and what that means

Two observations are recorded rather than smoothed over, because each says
something true about where a guard actually lives:

| Mutation | Result | Why |
|---|---|---|
| fabricating a status **after** the transport check | `enrollment-gap.test.ts` **still green** | with no transport, `enroll` refuses before it reaches the fabricated line. #913's negative control is intact — it is simply testing an earlier point on the same path, which is why the *second* row above exists |
| weakening `decodeIssueDeviceCredentialResult`'s framing | `refuses every truncation` **still green** | `ByteReader.take` bounds-checks before every read, so a truncation refuses without `finish()`. The same redundancy the TypeScript table above documents, in the same format, for the same reason |

The authority scan additionally carries its own coverage anchors — a fabricated
violation of each of its three seed routes, an assertion that prose about the
seed is *not* a violation while executable code is, an assertion that
`setIntentTransport` is permitted from a test and refused from a production
module, an assertion that the transport rule fails loudly if the export it is
about is ever renamed away, and an assertion that the reader saw a manifest, a
capability file and more than twenty sources. A boundary scanner that has
silently stopped finding files reports success forever (`#553`).

### What none of this proves

`CALLER-AUTHENTICATION.md` §5: **there is no signature over responses.** Every
case in `a response is judged as if the responder were hostile` establishes one
thing — that whoever answered had seen the request, because `request_id` is 32
CSPRNG bytes that appeared in exactly one outbound message. Not one of them
establishes that the responder was ZUULI. An app that *received* the request
holds the identifier and can answer with a `DeviceCredential` of its own
choosing, and this client would accept it. Only a transport that authenticates
the response destination closes that, which is
[#461](https://github.com/free2z/zuu/issues/461), which is why the transport is
shut.

## TypeScript — the caller side, `wallet/free2z`

`wallet/free2z/src/lib/bridge/creator-tip.test.ts` is where the shared client
is exercised as a *product* rather than as a protocol: a creator ZEC tip
(#790) builds a real `execute-payment` request, hands it to the one transport
seam, and judges the answer.

```
cd wallet/free2z && npx vitest run src/lib/bridge src/lib/format.test.ts
```

Baseline: 190 tests green (73 bridge, 66 formatting, 17 tip copy, plus the i18n catalog suites the copy states feed). Every guard below is
pinned **alone**: deleting any one of them, by itself, turns something red.

| Guard, as mutated | Test that must fail | Result |
|---|---|---|
| ZEC→zatoshi factor (`padEnd(8, "0")` → `padEnd(7, "0")`) | `converts 1 ZEC`, and five more | FAILS |
| `encodeExecutePaymentPayload`'s `amountZatoshis <= 0n` | `the encoder itself refuses 0n zatoshis`, `refuses to build a request for 0 zatoshis` | FAILS |
| `requestCreatorTipPayment`'s `Number.isSafeInteger` | `refuses 0.5 zatoshis as a refusal, never as a thrown RangeError`, and four more | FAILS |
| session correlation by identifier (`findIndex` → `() => true`) | `rejects a response addressed to a different request` | FAILS |
| `decodeExecutePaymentResult`'s fixed 32-byte read | `never reports an empty payload as a payment`, and five more | FAILS |
| creator-tip trim-equality rule | `refuses an untrimmed username`, `…label` | FAILS |
| creator-tip control-character rejection | `refuses a control character in the label`, `…a DEL in the username` | FAILS |
| creator-tip recipient-whitespace rejection | `refuses an address split by a space` | FAILS |
| `IntentErrorCode.Unavailable` (status 12) in the client | `carries INTENT_UNAVAILABLE through as itself, not as a decode failure` | FAILS |
| `unsendable` gets its own copy, not the wallet-declined copy | `never tells the payer the wallet declined when it was never asked` | FAILS |
| certainty attribution per outcome | `is certain only where certainty is earned` | FAILS |
| an ambiguous broadcast read as a plain refusal | `treats an ambiguous broadcast as unknown, not as a refusal` | FAILS |

The txid row is the one worth reading the output of: with the length check
relaxed, an empty payload is reported as `{ kind: 'sent', txid: '' }` — a
*correlated* fulfilment carrying no transaction. A caller that renders that has
told its user a payment landed, and cannot unsay it.

### The copy has to be true, and "true" depends on what we can prove

A review of #924 found four `CreatorTipFailure` kinds and three toast branches:
`unsendable` and `transport-failed` fell through to *"the wallet did not
complete this payment"*. For `unsendable` that is false — nothing left free2z
and ZUULI was never asked — and it is reachable from untrusted profile data, not
just from developer error, because a `recipient` or `username` carrying
`U+200B`/`U+202E` passes free2z's C0/DEL check and is refused by `VisibleText`.

Fixing it surfaced a second, larger problem. The copy was organised around *did
it work*, and the honest axis is **do we know what happened**:

| Outcome | Can this app prove no funds moved? |
|---|---|
| `no-transport` | yes — no channel exists |
| `unsendable` | yes — nothing was encoded, the wallet was never asked |
| `refused` + `INTENT_NOT_CONFIRMED` | yes — ZUULI returns it before `execute_send` |
| `transport-failed` | **no** — the request may have arrived, the answer did not |
| `refused` + anything else | **no** |

The sharpest case is `INTENT_UNAVAILABLE`: `intent.rs`'s `payment_outcome`
returns it for every `BroadcastStatus` but `Accepted`, **including `Unknown`**,
where "the transaction exists locally and the wallet retains the exact bytes for
`retry_pending_send`, but nothing establishes that the network took them". Copy
that says "your ZEC is untouched" there is wrong in the one direction that
matters.

And the client could not even see it. `error.ts` defined statuses 1–11 while
`rs/crates/f2z-intent/src/error.rs` defines twelve, so
`IntentSession.accept`'s `intentErrorFromStatus(status) ?? Malformed` reported an
`INTENT_UNAVAILABLE` refusal as `INTENT_MALFORMED` — "the wallet's answer was
garbage" instead of "the wallet could not finish, go look". That is fixed here,
and the mutation that removes status 12 again reproduces the old reading exactly:

```
× carries INTENT_UNAVAILABLE through as itself, not as a decode failure
  → expected { kind: 'refused', error: 1 } to deeply equal { kind: 'refused', error: undefined }
```

`features/creator/tip-copy.ts` is now the single exhaustive map, with a `never`
binding so a sixth outcome cannot fall through, and
`tip-copy.test.ts` asserts the honesty property against the **real shipped
`en`/`es`/`fr` catalogs** through a real i18next instance — a reassuring
sentence added to the wrong message by a later translation is exactly what a
key-level assertion would miss. It carries its own negative control, so a typo
in every regex cannot leave it green.

### The positive-amount check used to be written twice. That was the bug.

The first version of this work had `amountZatoshis <= 0` in
`requestCreatorTipPayment` **and** `<= 0n` in `encodeExecutePaymentPayload`, and
the matrix recorded that neither copy could be mutated alone — only removing
both turned a test red. That was reported honestly rather than counted as
covered, and then treated as the defect it is: two copies that no test can tell
apart is not defence in depth. It is one guard plus a decoy, and either could
have been deleted in a later refactor with the suite fully green.

The fix was to delete the duplicate, not to invent a test for it. Measuring
first showed the split was not where it looked:

| Value | Caller's `<= 0` | Encoder's `<= 0n` | Distinguishable? |
|---|---|---|---|
| `0` | refuses | refuses, at the same point, with the same code | **no** |
| `-1` | refuses | refuses — and `-1 < 0` too, so the mutation never changed this | **no** |
| `0.5`, `NaN`, `Infinity` | `isSafeInteger` refuses | **throws `RangeError`** out of `outcome()` | yes |
| `2^53` | `isSafeInteger` refuses | **accepts it and encodes it** | yes |

So the caller's real contribution is *representability*, which nothing else
enforces, and positivity belongs solely to the encoder where `PROTOCOL.md` §3.4
puts it. Splitting them that way leaves two guards that are each independently
mutation-provable — the two rows in the table above — and no third copy that a
green suite would let somebody delete.

The last row is the one that changed the design rather than just the tests:
`BigInt(2**53)` converts cleanly, so without `Number.isSafeInteger` a nonsense
amount reaches the wire and is **sent**. The check that looked like a duplicate
of the encoder's was, in the cases that matter, the only thing standing there.

## The boundary scanner

`wallet/zuuli/scripts/project-boundary.node-test.mjs` gains seven cases, and
they are negative controls rather than assertions:

| Case | Proves |
|---|---|
| a second implementation inside an application | reserved declarations are refused outside `wallet/shared/src/intent` |
| a second implementation smuggled in as a local helper | the same, for the realistic shape — one function, not a module |
| an application minting a label in the bridge's namespace | the domain namespace belongs to the shared implementation |
| an application that imports the shared implementation | the rule does not fire on the correct thing |
| a shared package that stops re-exporting `./intent` | the single implementation stays reachable through the one entry point |
| an intent bridge that quietly loses a guard | the anchor narrows loudly rather than silently (#553) |
| a wallet tree with no intent bridge at all | the anchor's subject cannot vanish |

Live run, on the real tree:

```
Wallet project boundaries verified across 3 discovered projects, 338 source
files, 1688 parsed module references, 5 production shared-package consumers,
5 single-implementation intent-bridge guards, and 2 constrained production
Vite builds.
```

## Cross-language agreement

`rs/crates/f2z-intent/tests/wire_vectors.rs` and
`wallet/zuuli/src/lib/intent-bridge.test.ts` pin the **same** 130-byte hex
string, derived by hand from `PROTOCOL.md` §3 rather than printed from either
encoder. [#564](https://github.com/free2z/zuu/issues/564) is why: an encoder and
a decoder that move together stay green straight through a format break, so
each implementation round-tripping itself proves only that it agrees with
itself.
