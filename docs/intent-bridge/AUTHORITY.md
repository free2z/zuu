# The ZUULI authority side

**Status:** `execute-payment` implemented and mutation-verified.
`sign-challenge` and `issue-device-credential` **deliberately not implemented**.
Still no transport — see [`PROTOCOL.md` §7](./PROTOCOL.md#7-what-is-blocked-on-461).

Issues: [#905](https://github.com/free2z/zuu/issues/905),
[#904](https://github.com/free2z/zuu/issues/904),
[#461](https://github.com/free2z/zuu/issues/461) (blocking prerequisite).

Code: `wallet/zuuli/src-tauri/src/intent.rs`.

---

## 1. What this is

[`PROTOCOL.md`](./PROTOCOL.md) and `rs/crates/f2z-intent` decide **whether** a
request may be acted on. This document is the other half: what acting on one
means inside `cash.free2z.zuuli`, the app that holds the seed.

```text
  decoded bytes ──► IntentGate::admit          every guard, one call
                      ▼
                    execute-payment only       §3
                      ▼
                    propose_send               ZUULI's OWN proposal
                      ▼
                    prepare_send_confirmation  the plugin re-derives the review
                      ▼
                    review_matches_request     the review must agree with the ask
                      ▼
                    native dialog              ZUULI's OWN rendering (§4)
                      ▼ approved
                    ConfirmationAuthorization  binds request ⊗ review ⊗ token
                    issue_send_confirmation    #528's own execution credential
                      ▼
                    consume (takes self)       one use, both clocks
                      ▼
                    take_send_proposal → ensure_active_seed_loaded → execute_send
```

No guard is re-implemented. `IntentGate::admit` is called exactly once and its
verdict is final, which is `#553`'s rule: a guard whose application depends on
somebody remembering it covers whatever they last remembered.

## 2. Two things this deliberately does not have

**No transport.** No deep-link parsing, no URL handling, no intent filter, no
scheme registration. `receive_intent` takes bytes somebody else decided to hand
it. `#461` is unresolved and dispatching authority over a custom scheme would
recreate [#367](https://github.com/free2z/zuu/issues/367) — a confused deputy —
at the OS layer instead of the frame layer.

**No IPC surface.** `receive_intent` is not a `#[tauri::command]` and appears in
no capability. The privileged WebView must not be able to mint an intent: `#367`
is precisely that the WebView's frames are not separated from one another, so a
command turning caller-supplied bytes into a payment confirmation is the deputy
that issue is about. A test reads `lib.rs` and fails if anything from the module
reaches the invoke handler, with a positive control so an empty parse cannot
make it vacuous.

## 3. Only `execute-payment`, and why that ordering is not arbitrary

`#905`'s correction comment is the reason, restated because it is the single
most important design fact on this surface:

> Strength runs: **strong for `execute-payment`, medium for
> `issue-device-credential`, weak for `sign-challenge`.** … shipping
> `sign-challenge` first because it "only signs" is backwards.

For `execute-payment` the confirmation carries content a human can audit — a
recipient address and an amount, both re-derived by the wallet from its own
state. For `sign-challenge` the only human-meaningful content is *who is asking*
and *why*, and absent caller attestation both are attacker-chosen: a hostile app
sends `caller: cash.free2z.free2z`, `purpose: "Sign in to free2z"`, ZUULI renders
an entirely honest confirmation with a dishonest sender, the user approves, and
the attacker replays the login attestation. The confirmation did not fail — it
was never able to tell the difference.

So both other families are **admitted by the gate and refused by this surface**,
with `INTENT_UNKNOWN_INTENT`. That status is not a lie: this build genuinely does
not implement them.

## 4. The confirmation, field by field

Every value on the screen comes from `SendReview` — what
`tauri-plugin-zcash` re-derived from its own native proposal — except one
string, and that one is quoted and escaped.

| Line | Source | Caller can influence? |
|---|---|---|
| "Another app asked ZUULI to send this Zcash payment." | literal | no |
| `Requesting app:` | **our** registry, via `AuthorizedCaller::display_name` | no — the request's `caller` field is a lookup key and never appears |
| `Identity:` | `CallerTrust` | no |
| `Its stated reason, in its own words:` | the request's `purpose` | yes — quoted and escaped with #528's `quote_native_memo` |
| `To:` / `Amount:` / `Memo (quoted):` | `send::native_review_lines`, from the proposal | only as an *input* to the proposal, which must then survive `review_matches_request` |
| `Network fee:` / `Total:` / `Network:` / `Change:` | as above | no |
| `The requesting app expected a fee of …` | the request's `fee_zatoshis` | yes, as a number — shown as a discrepancy, never enforced |

`native_review_lines` is the block the wallet's own send flow shows, factored
out of `format_native_send_confirmation` rather than copied: two renderings of
one payment is how `0.001` and `0.0001` end up on two screens that each claim to
describe the same thing.

`review_matches_request` is a fail-closed comparison, not a formality. Agreement
is the expected case — `propose_send` was handed the caller's own values — but
the review is what the user approves while `request_digest` is what the
confirmation binds, so any divergence would mean the human approved one thing
while the transcript attested to another.

## 5. The binding, and where it is weaker than it looks

The approval is `f2z_intent::ConfirmationAuthorization`: `H(label,
request_digest ‖ review_digest ‖ token)`, dual-clock, one-use by ownership.
`review_digest` is the plugin's own `send_review_digest`, which already covers
proposal id, wallet id, session id, network, recipient, amount, memo, fee policy,
fee, total and change policy — so binding it binds every field #528 binds.

What the intent binding **adds** over #528's token is the `request_digest` half:
the plugin knows nothing about intents, so it alone cannot express "the user
approved *this delegation*" rather than "the user approved *a payment*".

What it does **not** add, and this should be read plainly: on this surface the
whole sequence from `issue` to `consume` runs inside one `async` function
holding `send_operation`, and the token never leaves the process. In #528 the
token is handed to a renderer and presented back, so the token is a real bearer
credential crossing a real trust boundary. Here it does not cross one. The
dual-clock deadline is likewise a second deadline over an interval the plugin's
own confirmation already bounds. Both are worth keeping — they are what makes
the binding correct when the flow is eventually split across a transport
round-trip, and they are cheap — but a reviewer should not read the intent-level
token as an independent barrier today. It is a *binding*, not a second gate.

Three further honest limits:

- **The ledger is process-local, and "one-use" means one use per process.** A
  restart destroys the authorization *object*, so an approval granted before it
  cannot be spent after it. It does **not** make the request unrepeatable:
  inside its ≤5-minute window the same bytes are admitted again by an empty
  ledger, the same dialog is shown, and two approvals are two payments. The
  barrier there is **a second human approval, not the ledger** — which is the
  correct barrier for a control whose authority is the human, but it is not what
  "a confirmed intent cannot be resurrected" would have implied, so it is
  written the accurate way instead.
- **`INTENT_UNAVAILABLE` is a coarse balance oracle at the level of control
  flow**, even though its *payload* carries nothing. An amount the wallet cannot
  fund fails inside `propose_send`, which runs **before** `confirm_natively`, so
  a registered caller learns fundable-or-not from a silent refusal with no user
  interaction at all — and a descending binary search over the balance costs at
  most one visible dialog, at the bottom. §7's "carries no detail, because
  'insufficient funds' is a balance oracle" is true of the bytes and not of the
  surface. Not exploitable today: the registry holds two first-party apps and
  there is no transport. It becomes a real question the moment either of those
  changes, and the fix is not a different status code — it is deciding whether
  an unregistered-in-practice caller may probe at all, or moving the proposal
  behind the confirmation.
- **`Claimed` is the only trust verdict any shipping platform reaches today.**
  See §6.

## 6. The caller registry, and the empty certificate lists

```rust
const REGISTERED_CALLERS: &[(&str, &str)] = &[
    ("cash.free2z.free2z", "free2z"),
    ("cash.free2z.e2e2z", "free2z Chat"),
];
```

`signing_certs` is empty for both, and that is fail-closed rather than
unfinished. `CallerRegistry::authorize` treats a platform attestation that no
registered certificate matches as a **refusal**, never as a downgrade to
`Claimed`. So until the Android surface measures whether `startActivityForResult`
composes with a verified App Link — `#905`'s first amended acceptance criterion —
and real digests are registered, an attested call is refused rather than quietly
believed. `#911` gave `CallerTrust` no `Claimed` → `Attested` path; this keeps it
that way.

The display name is always drawn from this table. A hostile app that
impersonates a registered identifier still gets `Claimed`, still gets ZUULI's
"Identity: NOT CONFIRMED" line, and still has to get past a human reading an
address and an amount.

## 7. The refusal that was added: `INTENT_UNAVAILABLE` (12)

The wallet-side implementation is the first thing in this protocol that can
*try* and fail, and the v1 union had no member for it. Squeezing "no wallet
open", "cannot be funded" or "the broadcast did not complete" into
`INTENT_INVALID_VALUE` would tell an honest caller its message was wrong, and it
would then "fix" a message that was already correct.

`INTENT_UNAVAILABLE` carries no detail, for the same reason nothing else here
does: the caller is an app the wallet does not trust, and "insufficient funds" is
a balance oracle. **That is a statement about the payload, not about the
surface** — the *control flow* still leaks fundability, because an unfundable
amount fails in `propose_send` before any dialog is shown. §5's honest-limits
list says how much that is worth and why it is not exploitable today. Both halves of the protocol were updated —
`rs/crates/f2z-intent/src/error.rs` and `wallet/shared/src/intent/error.ts` — and
the density/stability test moved its "unknown status" probe from 12 to 13.

An **ambiguous** broadcast (`BroadcastStatus::Unknown`) is reported as
`INTENT_UNAVAILABLE` and not as a fulfilled payment. The wallet retains the exact
bytes for `retry_pending_send`; telling the caller a txid landed when it may not
have is the one answer that cannot be corrected later.

### `txid` byte order

`ExecutePaymentResultV1.txid` carries the 32 bytes in the order ZUULI *renders*
a transaction identifier — `format!("{txid}")` over a `zcash_protocol::TxId`,
which is the reversed/display order every explorer uses. The wire field is
opaque, so the choice has to be written down somewhere: it is written down here,
and a client that hex-encodes those bytes gets the string a user would paste into
an explorer.

## 8. Conformance — mutation-verified, not asserted

Same method and same standard as [`CONFORMANCE.md`](./CONFORMANCE.md): every
guard was deleted or inverted in the source, the suite was run, the named test
was watched to fail, and the guard was restored. The matrix ends
`AFTER RESTORE: GREEN`, which is the second half of the evidence.

```
cargo test --locked --manifest-path wallet/zuuli/src-tauri/Cargo.toml
# for each row: patch, cargo test --lib <test> -- --exact, restore
```

Baseline: **48 tests green** in `wallet/zuuli/src-tauri` — 26 of them new, in
`intent::tests` — and 63 still green in `f2z-intent`.

| Guard, as mutated | Test that must fail | Result |
|---|---|---|
| the receiver uses the process's one gate, not a fresh one | `a_replayed_intent_is_refused_by_the_receiver` | FAILS |
| the family dispatch admits `execute-payment` (inverted to refuse everything) | `only_execute_payment_is_acted_on` | FAILS |
| the delegation re-derives the review against the request | `the_delegation_order_…` | FAILS |
| the approval is spent **before** execution | `the_delegation_order_…` | FAILS |
| the confirmation is the OS-owned dialog | `the_delegation_order_…` | FAILS |
| review comparison: amount | `the_rederived_review_must_describe_the_payment_that_was_asked_for` | FAILS |
| review comparison: recipient | same | FAILS |
| review comparison: memo | same | FAILS |
| review comparison: exactly one payment | same | FAILS |
| the name rendered comes from our registry, not the request | `the_confirmation_names_the_caller_from_our_registry_and_not_from_the_request` | FAILS |
| an unattested caller renders as unconfirmed | `an_unattested_caller_is_rendered_as_unconfirmed` | FAILS |
| the caller's `purpose` is escaped | `a_hostile_purpose_cannot_restructure_the_dialog` | FAILS |
| the display name is escaped | `a_hostile_display_name_cannot_restructure_the_dialog_either` | FAILS |
| a fee the caller did not expect is shown | `a_fee_the_caller_did_not_expect_is_shown_rather_than_enforced` | FAILS |
| a refusal never encodes as fulfilled | `a_refusal_never_claims_to_have_acted` | FAILS |
| a refusal carries no payload | `a_refusal_echoes_the_question_and_carries_nothing_else` | FAILS |
| a response echoes the identifier it answers | `a_fulfilled_payment_carries_the_txid_and_the_correlation` | FAILS |
| a txid that is not 32 bytes is not reported as a payment | `a_txid_that_is_not_thirty_two_bytes_is_not_reported_as_a_payment` | FAILS |
| a review digest that is not a digest cannot bind | `a_review_digest_that_is_not_a_digest_cannot_bind_a_confirmation` | FAILS |
| registry membership: an attacker enrolled | `an_unregistered_caller_never_reaches_a_confirmation` | FAILS |
| registry membership: a delegated surface dropped | `the_registry_is_exactly_the_two_delegated_surfaces` | FAILS |
| an unmatched attestation refuses rather than downgrades | `an_attested_call_is_refused_until_a_certificate_is_registered` | FAILS |
| confirmation deadline: **monotonic** half | `the_intent_approval_binds_…_and_expires_on_both_clocks` | FAILS |
| confirmation deadline: **wall** half | same | FAILS |
| confirmation deadline: **rollback** guard | same | FAILS |
| the authority is managed state | `the_intent_authority_is_not_reachable_from_the_webview` | FAILS |
| the dialog verdict is not inverted (approve on *Cancel*) | `the_delegation_order_…` | FAILS |
| a dialog closed without a verdict refuses | `silence_from_the_dialog_is_a_refusal` | FAILS |
| only an accepted broadcast is a payment (inverted) | `only_an_accepted_broadcast_is_reported_as_a_payment` | FAILS |
| only an accepted broadcast is a payment (deleted) | same | FAILS |

**30 mutations, 30 failures, 0 survivors.**

The three dual-clock rows mutate `f2z-intent`'s `Deadline::check` and are the
same three `CONFORMANCE.md` records — repeated here because this surface is
where the deadline is actually *used*, and a test that only re-asserted the
crate's own behaviour without exercising it here would have been decoration.
Each half is defeated without the others: suspend is caught by the wall
deadline, a wall clock held just after issuance by the monotonic one, and a
rollback by the issuance comparison.

### The last four rows exist because the first twenty-six missed them

An adversarial review of this PR found two surviving mutations, and both were on
guards this document names as central. They are recorded here rather than
quietly folded in, because "0 survivors" is only worth anything if the times it
was wrong are visible:

- **The dialog verdict was undefended.** Dropping the `!` from
  `if !confirm_natively(…)` — approve on *Cancel* — left every test green. The
  ordering test's step literal was `"confirm_natively(app, message)"`, which
  matches with or without the negation. The primary control of the whole design
  had no test that would notice it being inverted.
- **The ambiguous-broadcast rule was undefended.** Inverting or deleting the
  `BroadcastStatus::Accepted` check left the suite green; nothing referenced
  `BroadcastStatus` at all, while §7 and the PR body both advertised "an
  ambiguous broadcast is reported as `UNAVAILABLE`, never as a txid" as a
  headline property.

Both were closed by moving the decision into a pure function that a test can
drive, rather than by adding an assertion about the source:
`payment_outcome(&ExecuteSendResult)` covers `Accepted` / `Rejected` /
`Unknown` plus a malformed identifier, and `dialog_verdict(Option<bool>)` covers
authorize / cancel / silence. Each has a positive control, so a mapping that
refused everything would not pass either.

One half stays a source assertion and is labelled as such: the `!` on
`confirm_natively` cannot be exercised without a real window and a funded
wallet, so the ordering test now pins the literal
`"if !confirm_natively(app, message).await {"`. That is the same category as the
other ordering rows — weaker than a functional test, and claimed as no more.

### One mutation that cannot be written, stated rather than omitted

The family restriction of §3 is enforced by the **absence of code**: there is no
`sign-challenge` implementation on this surface to enable, so "accept
`sign-challenge`" is not a patch anybody can apply. The mutation in the table is
therefore the *inverse* one — make the dispatch refuse everything — which kills
the positive control in `only_execute_payment_is_acted_on` and proves the test is
not a suite that refuses everything and calls it a guard. That is weaker than a
two-sided proof and is reported as such, the way `CONFORMANCE.md` reports its two
redundant-by-construction rows rather than claiming coverage it does not have.

## 9. What the plugin gained, and why none of it is a weakening

Three changes in `tauri-plugin-zcash`, all widening:

| Change | Why |
|---|---|
| `format_zec_amount` and `quote_native_memo` are `pub` | one amount format and one escaper for every native confirmation this wallet shows |
| `native_review_lines` split out of `format_native_send_confirmation` | the payment block is shared; the existing function reproduces its previous output exactly and its tests are untouched |
| `ensure_active_seed_loaded` moved from `commands.rs` to `wallet/mod.rs` | a second, non-IPC caller appeared; `commands.rs` keeps the name so the sequencing rule `send-review-boundary.node-test.mjs` reads out of `execute_send` — consume the confirmation *before* loading custody — is still stated where a reader of the command finds it |

No check was relaxed, no `#[allow]` was added, and every existing plugin test
still passes (150 lib tests + the production route probe).
