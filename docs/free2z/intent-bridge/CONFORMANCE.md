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

Baseline: 69 tests green (38 unit, 25 conformance, 6 wire vectors).

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

### Version 2 of the credential payload (ADR 0017 §4.1)

`issue-device-credential-v2` is a **family code** rather than a version field
inside the payload, so the guards worth mutating are the selector and the new
field rules. Same method, same standard.

| Guard, as mutated | Test that must fail | Result |
|---|---|---|
| the family selector: code 2 resolved to version 2 | `the_two_credential_payload_versions_never_decode_as_each_other`, `the_frozen_v1_credential_request_still_parses_as_v1` | FAILS |
| the `wss://` scheme and host check | `a_v2_endpoint_must_be_a_real_wss_relay` | FAILS |
| the all-zero endpoint check | `a_v2_endpoint_must_be_a_real_wss_relay` | FAILS |
| the shared device-field rules, reached from version 2 | `a_v2_request_keeps_every_v1_rule` | FAILS |

**4 mutations, 4 failures, 0 survivors**, each restored and re-run green.

The first row is the one to read twice. Version 2's payload is version 1's with
three fields appended, so a decoder that "tried both" would accept either under
either code — which is exactly the best-guessing `#905` refuses. Under the
family gate, version 2's bytes are trailing data to version 1's decoder and
version 1's are a truncation to version 2's, and the **frozen** version-1
vector still parses as version 1 under the same request digest a confirmation
bound before version 2 existed.

The three dual-clock rows are the ones worth reading twice. Each half of
`Deadline::check` defends against a *different* ordinary device behaviour, and
the first version of that test only caught one of them — removing the monotonic
half left the suite green, because the fixture's "suspend" case is caught by the
wall deadline. The test was strengthened with a third case (the wall clock held
just after issuance while real time passes) before the row above could be
written. That is what a mutation matrix is for: the mutation found a weak test,
not a weak guard.

## TypeScript — `wallet/shared/src/intent`

Baseline: 50 tests green.

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
| the version-2 encoder's endpoint rules (scheme, host, 32-byte keys, all-zero) | FAILS |
| status 13 known as `INTENT_HANDLE_UNAVAILABLE` rather than unknown | FAILS |

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
device public keys — and hands it to the transport seam. In a native runtime
that is `appLinkTransport.ts`, over the verified App Links `#977` landed for
`#461`; everywhere else, including every row below, it is the fail-closed
default, which refuses.

Baseline: 43 tests green across `transport.test.ts`, `deviceKeys.test.ts` and
`issueDeviceCredential.test.ts`, plus 5 across
`wallet/e2e2z/src/lib/messaging/enroll-intent.test.ts` and
`enroll-chunk-failure.test.ts`, plus the 8 in
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
| seed authority: the wallet plugin as a dependency | `e2e2z holds no seed authority, and no unreviewed dispatch authority` | FAILS |
| seed authority: a `plugin:zcash\|` invoke in the renderer | `e2e2z holds no seed authority, and no unreviewed dispatch authority` | FAILS |
| seed authority: `get_seed_phrase` named in executable code | `e2e2z holds no seed authority, and no unreviewed dispatch authority` | FAILS |
| the endpoint dropped from the parsed device keys | `refuses an endpoint a stranger could not reach this device at` | FAILS |
| the version-1 encoder used for the request | `is the structure the wallet parses, with the fields #905 specifies` | FAILS |
| `enroll`'s lazy `import()` inside the `try`, so a chunk-load failure still wears the typed refusal | `a chunk that never loads > still refuses with the typed enrollment refusal` | FAILS |
| dispatch authority: a second production module calls `setIntentTransport` | `e2e2z holds no seed authority, and no unreviewed dispatch authority` | FAILS |

**12 mutations, 12 failures, 0 survivors.** Every one was applied, watched to
fail with a named assertion, and restored; the tree ends green.

The last two rows came out of adversarial review and are the same objection
pointed in two directions. `enroll` reaches its client through a lazy
`import()`; with that statement *outside* the `try`, a chunk that fails to load
escapes as an untyped error, and the screen — which branches on
`isEnrollmentUnavailable` — would say "something broke" instead of the one true
thing this app can say. And `setIntentTransport` is exported so the tests can
drive the shipping path against a wallet stand-in — and, since #461 landed as
#977, so that `src/lib/enrollment/appLinkTransport.ts` can register the one
reviewed transport; a guard defeated by one *further* call to it from any other
renderer module has exactly the shape of the guard defeated by one boolean that
`transport.ts` argues against. Neither changed what the app can do — both were
already fail-closed — and both are now pinned rather than true by accident.

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
`setIntentTransport` is permitted from a test and from the one sanctioned
module and refused from every other production module — including a sibling in
the same directory, so the exemption cannot be read as covering
`src/lib/enrollment/*` — an assertion that the transport rule fails loudly if
the export it is about is ever renamed away, an assertion that the exemption
fails loudly if the module it names stops existing or stops installing, and an
assertion that the reader saw a manifest, a capability file and more than
twenty sources. A boundary scanner that has silently stopped finding files
reports success forever (`#553`).

### What none of this proves

`CALLER-AUTHENTICATION.md` §5: **there is no signature over responses.** Every
case in `a response is judged as if the responder were hostile` establishes one
thing — that whoever answered had seen the request, because `request_id` is 32
CSPRNG bytes that appeared in exactly one outbound message. Not one of them
establishes that the responder was ZUULI. An app that *received* the request
holds the identifier and can answer with a `DeviceCredential` of its own
choosing, and this client would accept it. The App Link transport narrows that
without closing it: a verified link reaches only the app that owns the domain
association, so while the association resolves, no other app receives the
request or the answer. What these tests cannot observe is that association
failing — §4.1's case, where a link silently degrades to the web — and nothing
here signs a response ([#929](https://github.com/free2z/zuu/issues/929)).

## The publishing authority — `wallet/zuuli/src-tauri`

ADR 0017 §4.1's path: the handle a confirmation names, the entry the wallet
signs, and the order the two happen in. Reproduce with
`cargo test --locked --manifest-path wallet/zuuli/src-tauri/Cargo.toml`, then
one row at a time: patch, `cargo test --lib <test> -- --exact`, restore.

| Guard, as mutated | Test that must fail | Result |
|---|---|---|
| `vouched_handle` ignores the authority signature's result | `an_assertion_that_does_not_verify_names_no_handle` | FAILS |
| the predecessor identity-key comparison is dropped | `a_handle_published_under_another_identity_is_refused_before_anything_is_signed` | FAILS |
| `sign_for_publication` skips the precheck | `an_assertion_the_log_would_refuse_is_caught_before_submission` | FAILS |
| the native dialog is not called at all | `the_publish_order_is_plan_then_prompt_then_seed_then_assertion_then_submit` | FAILS |
| the confirmation's handle taken from the admitted request | `the_publish_confirmation_never_renders_the_requested_handle` | FAILS |
| `refusal_after_submission` delegating to `publication_refusal` | `nothing_after_the_submission_claims_that_nothing_happened` | FAILS |
| the certain mapping applied to the submission's own refusal | `the_certain_refusal_mapping_is_never_applied_after_the_submission` | FAILS |
| the assertion fetched before the confirmation (the reviewed ordering) | `the_publish_order_is_plan_then_prompt_then_seed_then_assertion_then_submit` | FAILS |
| the seed read before the confirmation | same | FAILS |
| the fulfilled answer echoes a fixed family instead of the one asked | `a_fulfilled_answer_echoes_the_version_that_was_asked` | FAILS |

One row that **cannot** be written, recorded rather than omitted: "the
version-2 family answered on version 1's handler". The dispatch is a match on
`IntentBody`, so a handler that took the other version's body does not compile —
`version_two_is_dispatched_to_the_publishing_path_and_nowhere_else` is a
positive-and-negative control over that, not a mutation. Type-enforced is
stronger than test-enforced; claiming a mutation for it would not be.

And in the engine and the messaging surface, whose guards decide whether a
published device is reachable at all:

| Guard, as mutated | Test that must fail | Result |
|---|---|---|
| `install_identity` does not commit the pending contact queue | `the_queue_is_opened_before_the_credential_and_installed_with_it` | FAILS |
| `prepare_device` does not clear a pending queue | `a_second_preparation_discards_the_first_queue` | FAILS |
| `enrollment_status` ignores `submitted_by_issuer` | `an_issuer_submitted_device_is_waiting_rather_than_blocked` | FAILS |
| `e2e2z_enrollment_status` stops asking the log whether the entry merged | `the_enrollment_read_asks_the_log_while_the_entry_is_unmerged` | FAILS |

And the renderer's half of the session slot, whose guard is about *which value
the wallet ends up holding*:

| Guard, as mutated | Test that must fail | Result |
|---|---|---|
| the single-slot queue, replaced by the generation counter this branch first shipped | `leaves the wallet holding the last value asked for, not the last to arrive` | FAILS |
| a value overtaken before dispatch sent anyway | `drops a value that was overtaken before it was ever sent` | FAILS |
| the `finally` that re-arms the queue | `keeps publishing after a reporter throws` | FAILS |
| the guard around a reporter that throws | same | FAILS |

The first row is the one worth reading. The generation counter it replaces
*looked* like an ordering guard — it incremented, compared and recorded — but
the comparison happened **after** `invoke` had already written the slot, and
nothing read the recorded value. The test that shipped with it asserted arrival
order, which the bug satisfies: a stale sign-in landing last was the expected
result. Both are now stated as the property that matters, which is the value the
wallet holds when the dust settles, and the old implementation fails them.

**19 Rust mutations across these tables, 19 failures, 0 survivors**, plus the
eight TypeScript rows above — 27 in all. Every one was applied, watched to
fail with a named assertion, restored **from a saved copy of the working file**
(never `git checkout`, which would discard the change under test), and re-run
green.

### What none of this proves, again

The last row is **source-asserted**, like the ordering rows: reaching the real
branch needs a Tauri app, an engine and a log, and the Playwright spec that
watches the screen move from "Submitted, not yet active" to "Handle active"
drives a host stand-in rather than a real lookup. What *is* exercised against a
real log, witness and relay is `rs/crates/f2z-kt-client/tests/intent_publication.rs`:
a real `IssueDeviceCredentialRequestV2`, admitted by the real gate, published by
the real submission path, found by a stranger who knew only the handle. Nothing
in either place has run on a device against a deployed log.

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
| `IntentErrorCode.Unavailable` (status 12, from #914) in the client | `carries INTENT_UNAVAILABLE through as itself, not as a decode failure` | FAILS |
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
| `unknown-status` | **no** — the response is well-formed but its meaning is unfamiliar |
| `refused` + anything else | **no** |

The sharpest case is `INTENT_UNAVAILABLE`: `intent.rs`'s `payment_outcome`
returns it for every `BroadcastStatus` but `Accepted`, **including `Unknown`**,
where "the transaction exists locally and the wallet retains the exact bytes for
`retry_pending_send`, but nothing establishes that the network took them". Copy
that says "your ZEC is untouched" there is wrong in the one direction that
matters.

`INTENT_UNAVAILABLE` is status 12, which
[#914](https://github.com/free2z/zuu/pull/914) added to **both** halves —
`rs/crates/f2z-intent/src/error.rs` and `wallet/shared/src/intent/error.ts` —
when it introduced the status. The two have never disagreed on `main`.

The client preserves unfamiliar well-formed statuses as `unknown-status`
with the original uint16 value. It must not relabel them `INTENT_MALFORMED`,
accept a payload, infer no effect, or leave the question available for replay.
The normative caller rule is [PROTOCOL §6.2](./PROTOCOL.md#62-outcome-uncertainty-and-unfamiliar-statuses).

| Required property | Consumer test | Conformance failure |
|---|---|---|
| Preserve an unknown status and consume the question once | ZUULI `intent-bridge.test.ts`: `preserves unknown status %i and consumes the question exactly once` | Unknown status becomes malformed/success, or a replay becomes acceptable |
| Keep decoding and correlation ahead of status handling | ZUULI `intent-bridge.test.ts`: `does not let unknown statuses bypass framing, correlation, family or expiry checks` | An unfamiliar status bypasses a response check |
| Preserve payment uncertainty without a new payment | Free2Z `creator-tip.test.ts`: `preserves a well-formed unknown status without a txid or automatic retry` | A txid, decode-failure label, or second dispatch is fabricated |
| Do not claim no funds moved on uncertain statuses | Free2Z `tip-copy.test.ts`: `is certain only where certainty is earned`, plus all shipped locale checks | `INTENT_UNAVAILABLE` or `unknown-status` receives no-effect copy |
| Preserve enrollment uncertainty without a credential | E2E2Z `issueDeviceCredential.test.ts`: `surfaces an unknown status without claiming a decode failure or enrollment` | An unfamiliar status installs a credential, becomes malformed, or permits response replay |

`features/creator/tip-copy.ts` is now the single exhaustive map, with a `never`
binding so a new outcome cannot fall through, and
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

## The App Link association

`wallet/zuuli/scripts/app-link-association.node-test.mjs` holds the four
surfaces of [#461](https://github.com/free2z/zuu/issues/461) — each app's
`tauri.conf.json`, its generated Android manifest, its generated iOS
entitlements, and the two association documents — to one reviewed record.

Its mutations are **in the test file rather than in a scripted patch/restore
loop**, which is the stronger arrangement here: each case reads the real
committed bytes, applies one corruption to one of them in memory, and asserts a
named failure. There is no window in which a mutation can be left applied, and
no fixture that can pass while the shipped manifest says something else.

| Case | Proves |
|---|---|
| an app signing fingerprint replaced by ZUULI's **upload** certificate | the certificate that verifies in a sideloaded test build and fails for every real install is refused, in the record and in the rendered document |
| an assetlinks document with one package removed | both the fixed-point check and the "names every shipped app" check fire, and they are independent questions |
| an App ID moved to another Apple team | the Apple document must name the team the apps are actually signed by |
| iOS entitlements emptied | an app that claims no associated domain never fetches the AASA, and every bridge link opens Safari |
| iOS entitlements pointed at `free2z.cash` | claiming a host that does not serve the association is the same silent failure |
| `android:autoVerify="true"` deleted | without it the filter is an ordinary link filter any app may also claim |
| `android:pathPrefix` deleted | the assetlinks relation is host-wide, so the prefix is the only per-app boundary on every Android version |
| one app also claiming another's `/bridge/<app>/` prefix | two apps matching one URL means the OS chooses arbitrarily |
| `appLink: true` downgraded to `false` | an unverified web link is not an authenticated channel |
| a second `https` route declaring `appLink: false` | the downgrade is refused even beside a correct verified route |
| an app-link route widened to `/bridge/` | a prefix that swallows the other apps is refused |
| `store-identity.json` losing its app signing certificate | the store record and the association record cannot drift apart |
| a bundle whose `developmentTeam` is not the AASA's team | the appID prefix cannot name a team the build is not signed by |
| two apps sharing one Play App Signing key | each Play listing has its own key; one app's certificate authorising another package is the valid-but-wrong document the whole mechanism avoids |
| a component with a non-terminal `*` | Apple's and Google's wildcards agree only in the terminal position |
| a mixed-case component | a `caseSensitive: false` component could otherwise merge two owners |
| a lower-cased fingerprint | one documented format, so the rendered document does not depend on how someone pasted it |

Live run, on the real tree:

```
App Link association is coherent for 3 apps on free2z.com
# tests 23
# pass 23
# fail 0
```

**What this does not prove.** Nothing here reaches a device or a CDN. The
association is only real once `https://free2z.com/.well-known/assetlinks.json`
serves the three fingerprints — it returns `503` today — and once
`adb shell pm get-app-links <pkg>` reports `verified` on a signed build. See
[`PROTOCOL.md` §7.1](./PROTOCOL.md#71-what-has-landed-of-461-and-what-has-not).

## The transport — `bridge.rs` and `appLinkTransport.ts`

The App Link transport carries intent bytes between the apps and decides
nothing about them, so its guards are about the channel: which links are
accepted, where a payload is read from and written to, and where an answer
goes.

Baseline: 6 tests in `wallet/zuuli/src-tauri/src/bridge.rs`, 2 in `intent.rs`
(`the_answer_is_addressed_from_the_registry` and
`every_registered_caller_has_a_verified_https_reply_url`), 4 in
`wallet/e2e2z/src-tauri/src/bridge.rs` and 11 in
`wallet/e2e2z/src/lib/enrollment/appLinkTransport.test.ts`. Reproduce one row at
a time: patch, then `cargo test --lib <test> -- --exact` or
`npx vitest run src/lib/enrollment/appLinkTransport.test.ts -t <title>`, then
restore.

| Guard, as mutated | Test that must fail | Result |
|---|---|---|
| ZUULI accepts a non-`https` link | `only_a_verified_bridge_link_is_accepted` | FAILS |
| ZUULI accepts any host | `only_a_verified_bridge_link_is_accepted` | FAILS |
| ZUULI accepts any path | `only_a_verified_bridge_link_is_accepted` | FAILS |
| ZUULI reads the request from the query as well as the fragment | `only_a_verified_bridge_link_is_accepted` | FAILS |
| ZUULI takes the request as raw text instead of hex | `only_a_verified_bridge_link_is_accepted` | FAILS |
| a fragment key matched by prefix | `a_fragment_value_is_read_by_name_and_not_by_position` | FAILS |
| the answer written to the query | `a_reply_url_carries_only_hex_in_its_fragment` | FAILS |
| the transport choosing its own destination | `the_destination_comes_from_the_outcome_and_is_not_chosen_here` | FAILS |
| a parser reference in the transport's code | `the_transport_never_parses_what_it_carries` | FAILS |
| the reply URL fixed instead of looked up for the admitted caller | `the_answer_is_addressed_from_the_registry` | FAILS |
| the registry lookup matching any identifier | `every_registered_caller_has_a_verified_https_reply_url` | FAILS |
| e2e2z dispatches an empty request | `a_request_that_could_restructure_the_link_is_refused` | FAILS |
| e2e2z dispatches a request of any length | `a_request_that_could_restructure_the_link_is_refused` | FAILS |
| e2e2z dispatches half a byte | `a_request_that_could_restructure_the_link_is_refused` | FAILS |
| e2e2z lets `&`, `=` and `#` into the request | `a_request_that_could_restructure_the_link_is_refused` | FAILS |
| the renderer able to name the destination | `the_authority_is_a_constant_and_not_an_argument` | FAILS |
| the request dispatched in the query | `a_dispatch_url_carries_the_request_in_its_fragment` | FAILS |
| e2e2z accepts a non-`https` answer | `an inbound link > is refused on every condition the association rests on` | FAILS |
| e2e2z accepts an answer on any host | `an inbound link > is refused on every condition the association rests on` | FAILS |
| e2e2z accepts an answer on any path, the authority's own prefix included | `an inbound link > is refused on every condition the association rests on` | FAILS |
| e2e2z reads the answer from the query | `an inbound link > is refused on every condition the association rests on` | FAILS |
| e2e2z accepts an answer with no `rid` | `an inbound link > is refused on every condition the association rests on` | FAILS |
| e2e2z matches a fragment key by prefix | `an inbound link > is refused on every condition the association rests on` | FAILS |
| an answer to another request resolves the dispatch | `the App Link transport > ignores an answer to a request it is not waiting for` | FAILS |
| a second dispatch while one is outstanding | `the App Link transport > refuses a second dispatch while one is outstanding` | FAILS (times out) |
| a timeout that ignores the request's deadline | `the App Link transport > times out on the request's own deadline` | FAILS (times out) |
| the transport installed in a browser | `installation > leaves a browser on the fail-closed default` | FAILS |

**27 mutations, 27 failures, 0 survivors.** One run on the finished tree, every
file restored byte for byte, and the tree ends green.

### What the first run found

Four rows survived the first run, and each was a test passing for the wrong
reason:

- **Delimiters in a dispatched request.** Every `&` and `#` case was odd
  length, so the parity check refused it before the charset check ran. The
  replacements are even length and otherwise hex.
- **The dispatch URL.** Nothing tested it, because it was built inside the
  command. `dispatch_url` is now a function with its own test.
- **An answer to another request.** The test raced the dispatch against an
  already-resolved promise, which wins even when the dispatch did resolve. It
  now waits a macrotask and checks a flag.
- **A fragment key matched by prefix.** Rust had a case for it; TypeScript did
  not.

### Notes on rows that pass

- `req`, `res` and `rid` are not hex, so a dispatched request could not spell a
  key the authority reads even without the delimiter refusal. That refusal is
  defence in depth, and its row proves it holds on its own.
- The single-flight and deadline rows fail by timing out, not by assertion:
  with either guard gone, the promise never settles.
- The no-parsing row is source-asserted. It proves the scan reads code and not
  comments, not that parsing is impossible.

### What none of this proves

No row delivers a link. The operating system routes an App Link, and
`on_open_url` and `open_url` need a running app. Whether `free2z.com`'s
association resolves on a signed build is the App Link association section's
question. `CallerAttestation::None` is not mutated either: nothing an App Link
carries could replace it.

## The free2z transport — `appLinkTransport.ts` and the creator tip

free2z's caller transport carries `execute-payment` for the creator ZEC tip
(#790). It is e2e2z's transport with two differences that get their own rows:
free2z registers no `invoke_handler`, so the link is built here and opened
through `tauri-plugin-opener`; and a payment adds one rule e2e2z does not need
— once the link has opened, ZUULI may have paid, so no failure after that point
may be read as "nothing was sent".

Baseline: 18 tests in `wallet/free2z/src/lib/bridge/appLinkTransport.test.ts`
and 96 in `creator-tip.test.ts`. Reproduce one row at a time: patch, then
`npx vitest run src/lib/bridge/appLinkTransport.test.ts src/lib/bridge/creator-tip.test.ts`,
then restore.

| Guard, as mutated | Test that must fail | Result |
|---|---|---|
| a non-`https` answer accepted | `an inbound link > is refused on every condition the association rests on` | FAILS |
| an answer on any host accepted | `an inbound link > is refused on every condition the association rests on` | FAILS |
| the reply path matched as a prefix, not exactly | `an inbound link > is refused on every condition the association rests on` | FAILS |
| an answer carrying a query accepted | `an inbound link > is refused on every condition the association rests on` | FAILS |
| a fragment key matched by prefix | `an inbound link > is refused on every condition the association rests on` | FAILS |
| an answer accepted whatever its `rid` | `an exchange > ignores an answer to a request it is not waiting for` | FAILS |
| an answer delivered with nothing waiting | `an exchange > ignores an answer when nothing is waiting` | FAILS |
| a second exchange allowed while one waits | `an exchange > refuses a second exchange while one is outstanding` | FAILS |
| a deadline other than the request's own | `an exchange > times out on the request's own deadline, and says so as 'unknown'` | FAILS |
| any transport error read as "no channel" | `a creator tip over the App Link > is 'unknown', never 'not sent', when ZUULI does not answer in time` | FAILS |
| a failure to open the link swallowed | `an exchange > rejects, as a broken channel, when the platform will not open the link` | FAILS |
| the request sent in the query | `the outbound link > goes to ZUULI's bridge, with the request in the fragment only` | FAILS |
| the App Link chosen on a desktop build | `the transport this runtime gets > is the refusal in a desktop build, which has no App Link association` | FAILS |
| the App Link chosen in a browser | `the transport this runtime gets > is the refusal in a browser` | FAILS |
| the answer listener registered off mobile | `the transport this runtime gets > listens for answers only where it can send` | FAILS |
| the tip handing the transport another request's `rid` | `a creator tip over the App Link > hands the transport the request's own identifier and deadline` | FAILS |
| the tip handing the transport the wrong deadline | `a creator tip over the App Link > hands the transport the request's own identifier and deadline` | FAILS |

17 mutations, 17 failures, 0 survivors. Each row's log was read to confirm the
test that failed is the one named, not a neighbour failing by accident.

### Notes on rows that pass

- The five inbound rows share one table test; each mutation makes a different
  URL in it come back non-null, and the assertion names that URL.
- The single-flight, deadline, `rid` and open-failure rows fail by timing out,
  not by assertion: with the guard gone, the promise never settles the way the
  test waits for.
- The first run of the harness reported every row in `appLinkTransport.ts` as
  unchanged, because it confirmed each mutation with `git diff` and a new,
  untracked file has none. It now compares file contents. A mutation that is
  not applied cannot fail, so "0 survivors" is only worth reading once each row
  is known to have been applied.

### What none of this proves

No row delivers a link, and none pays. `openUrl` and `onOpenUrl` are mocked,
ZUULI's answer is written by hand, and the startup call in `src/main.tsx` that
registers the listener is not exercised by any unit test. Whether a tip reaches
ZUULI and its answer reaches free2z on a signed device is still unobserved.

## Cross-language agreement

`rs/crates/f2z-intent/tests/wire_vectors.rs` and
`wallet/zuuli/src/lib/intent-bridge.test.ts` pin the **same** 130-byte hex
string, derived by hand from `PROTOCOL.md` §3 rather than printed from either
encoder. [#564](https://github.com/free2z/zuu/issues/564) is why: an encoder and
a decoder that move together stay green straight through a format break, so
each implementation round-tripping itself proves only that it agrees with
itself.
