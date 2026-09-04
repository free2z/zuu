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
