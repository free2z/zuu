//! §12.6: a key package is checked against the directory, or it is not used.
//!
//! Every test here is about the one property that makes publishing key packages
//! at an untrusted relay safe: **a package that does not match the directory
//! entry the log proved is refused.** The relay is assumed hostile
//! (`THREAT-MODEL.md` §3.3), so every substitution it could attempt is tried
//! below with real keys and real signatures rather than with a mock.

// Test code, run on the host by a person reading the failure.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_msg_mls::{CredentialError, EngineError, MlsEngine};
use openmls::prelude::{GroupId, MlsGroup};
use openmls_traits::OpenMlsProvider as _;

mod common;
use common::{NOW, device, directory_entry, issue_credential, with_revocation};

#[path = "../../../tests/support/markdown.rs"]
mod markdown;

const WIRE: &str = include_str!("../../../../docs/e2ee/WIRE.md");
const KEY_PACKAGE_AUTHENTICATION_HEADING: &str =
    "#### 12.6.5 Authentication — mandatory, and structural";
const NEXT_WIRE_HEADING: &str = "#### 12.6.6 Exhaustion, and the package of last resort";
const KEY_PACKAGE_PARENT_HEADING: &str =
    "12.6 `KeyPackage` publication — where a consumable key lives";
const KEY_PACKAGE_AUTHENTICATION_TABLE: &str = r#"| # | Check |
|---|---|
| 1 | RFC 9420's own `KeyPackage` validation: the package signature, the leaf-node signature, the lifetime, the extensions, and `init_key != encryption_key`. |
| 2 | The ciphersuite is `ARCHITECTURE.md` §5.2's, and only that one. A relay that could choose the suite could downgrade the hybrid PQ. |
| 3 | The credential parses as a `free2z/device-credential/v1`, not as a bare handle in a `BasicCredential`. |
| 4 | The credential's signature verifies under the **entry's** `identity_pk` — not under the key inside the credential. |
| 5 | The credential's `handle` is the entry's `handle`. |
| 6 | The complete signed `DeviceCredential` exactly equals the credential the entry publishes in `devices` for that `device_pk`; matching the key alone is insufficient. |
| 7 | At verifier-local time, that published credential is `Valid` under `KT.md` §4.1's exact shared inclusive fixed-skew rule; **not-yet-valid** and **expired** credentials are refused. |
| 8 | The credential's `device_pk` does **not** appear in the entry's cumulative `revocations`. |
| 9 | The leaf's `signature_key` is the credential's `device_pk` — the identity→device binding of `ARCHITECTURE.md` §4.2. |"#;
const KEY_PACKAGE_AUTHENTICATION_SECTION: &str = r#"**A fetched key package MUST be verified against the `DirectoryEntry` the
key-transparency lookup proved, before it is used for anything.** A client that
skips this has reintroduced [#133](https://github.com/free2z/zuu/issues/133) one
level down: the relay would choose whose init key the `Welcome` is encrypted to,
and `ARCHITECTURE.md` §9.1's sentence applies unchanged — *encrypting perfectly
to the wrong key is not security*.

The check is possible because a `KeyPackage` carries the device's
`DeviceCredential` as its MLS `Credential` (`KT.md` §4.1,
`ARCHITECTURE.md` §4.2), and that credential is signed by the identity key the
directory publishes. In full, a client MUST refuse the package unless **all** of
these hold:

| # | Check |
|---|---|
| 1 | RFC 9420's own `KeyPackage` validation: the package signature, the leaf-node signature, the lifetime, the extensions, and `init_key != encryption_key`. |
| 2 | The ciphersuite is `ARCHITECTURE.md` §5.2's, and only that one. A relay that could choose the suite could downgrade the hybrid PQ. |
| 3 | The credential parses as a `free2z/device-credential/v1`, not as a bare handle in a `BasicCredential`. |
| 4 | The credential's signature verifies under the **entry's** `identity_pk` — not under the key inside the credential. |
| 5 | The credential's `handle` is the entry's `handle`. |
| 6 | The complete signed `DeviceCredential` exactly equals the credential the entry publishes in `devices` for that `device_pk`; matching the key alone is insufficient. |
| 7 | At verifier-local time, that published credential is `Valid` under `KT.md` §4.1's exact shared inclusive fixed-skew rule; **not-yet-valid** and **expired** credentials are refused. |
| 8 | The credential's `device_pk` does **not** appear in the entry's cumulative `revocations`. |
| 9 | The leaf's `signature_key` is the credential's `device_pk` — the identity→device binding of `ARCHITECTURE.md` §4.2. |

Check 4 is the one the section exists for. A relay that invents an identity key,
issues itself a credential under it and signs a key package with the matching
device key passes 1, 2, 3 and 9; only the directory's `identity_pk` stops it.
Checks 6–8 make a replaced, withdrawn, not-yet-valid, expired, or revoked
device unreachable for first contact. In particular, accepting a matching
`device_pk` instead of the complete published credential would preserve the
longer lifetime of a stale package after the owner replaced that credential.

The reference implementation's safe first-party route makes this structural:
`f2z_msg_mls::VerifiedKeyPackage` has no constructor but the verifying one, and
`MlsEngine::add_member` takes that type instead of bytes. Its crate-level public
API still exposes enough raw OpenMLS capabilities for an external caller to go
around that wrapper; [#903](https://github.com/free2z/zuu/issues/903) tracks
sealing that escape. This is an implementation status disclosure, not a
weakening of the wire requirement: every client MUST perform all nine checks
before proposing the Add."#;

const KEY_PACKAGE_EXHAUSTION_SECTION: &str = r#"When the pool is empty a relay serves the **package of last resort** — RFC 9420's
`last_resort` KeyPackage extension — repeatedly, without deleting it.

**This is a real weakening and it is stated rather than buried.** A reusable
package means a reused init key: two initiators derive their `Welcome` encryption
from the same secret, and an attacker who later compromises that secret can open
every `Welcome` ever addressed to it. The full accounting is
[`THREAT-MODEL.md` §4.12](./THREAT-MODEL.md#412-a-last-resort-key-package-is-a-reused-init-key).

The alternative is worse and is the reason the trade is taken: **without it,
exhaustion means a device becomes unreachable to anyone new** for as long as it
is offline, and an attacker willing to pay `max_pool_size` claim stamps can
put it in that state deliberately. That is §12.4's contact-queue flood with a
much smaller bill, and it would make first contact denial-of-service cheap.

Two rules bound the cost:

- A device **SHOULD** publish exactly one last-resort package and **SHOULD** give
  it a lifetime materially shorter than its device credential's. The only
  mitigation available against a reusable key is that it stops being usable.
- A device **SHOULD NOT** replace its last-resort package on every top-up. A
  `Welcome` may already be in flight against the retired one and the sender has
  no way to learn it was withdrawn.

A device **MAY** publish no last-resort package at all, accepting unreachability
over reuse. A relay then answers `ERR_UNAVAILABLE` on an empty pool, and a client
MUST surface that as *"this person cannot be reached right now"* rather than as
*"this person does not exist"* — the two are the same wire code, by §10's rule,
and only the client knows the lookup succeeded.

**Refill, and the trap in it.** A device SHOULD top its pool up to a target on
every `start_engine` and whenever something arrives on its contact queue.

**A device MUST NOT decide when to refill from its own last-recorded count.**
Most claims never produce a `Welcome` — a stranger may claim and never write —
so consumption is *invisible* to the owner. A device that trusted its own number
would sit at "I published 32" while the relay held zero, fall back to its
reusable package of last resort on every first contact, and never notice.

The way to ask is a **publish with an empty `packages` vector and an empty
`last_resort`**: it changes nothing and returns the relay's true `pool_size` and
`has_last_resort`. That is not a special case bolted on — it is why the response
carries state at all, and it is safe for the reason §12.6.3 gives: the caller is
the queue's owner, authenticated by the receive-side key.

The numbers (a target, a low-water mark) are policy and are not fixed here; the
reference client uses 32 and 8 against a cap of 64, and calls both placeholders.

**Offline for a long time.** The pool drains, the last-resort package carries
first contact at the cost above, and when *that* expires the device is
unreachable to new contacts until it comes back. Established conversations are
entirely unaffected at every stage — they use ordinary queues and no key package
is ever consulted again."#;

const KEY_PACKAGE_AUTHENTICATION_TEXT: &str = "12.6.5 Authentication — mandatory, and structural";
const KEY_PACKAGE_EXHAUSTION_TEXT: &str = "12.6.6 Exhaustion, and the package of last resort";
// This is intentionally the complete ordinary rendered-prose surface, not a
// vocabulary search for likely weakenings. Otherwise a contradictory paragraph
// elsewhere in WIRE can evade the guard by choosing one synonym we did not list.
// Fenced examples and quoted/raw-HTML content cannot establish this normative
// contract; the exact §12.6 structure and prose are checked separately below.
const WIRE_RENDERED_PROSE_DIGEST: u64 = 8_772_757_061_631_922_358;

fn wire_rendered_prose_digest(rendered: &markdown::RenderedMarkdown) -> u64 {
    markdown::stable_digest(rendered.paragraphs())
}

fn wire_has_exact_key_package_authentication_table(wire: &str) -> bool {
    let Some(rendered) = markdown::RenderedMarkdown::parse(wire) else {
        return false;
    };
    let expected_children = [
        "12.6.1 The tension, stated first",
        "12.6.2 The answer: the relay, at the address the directory already publishes",
        "12.6.3 `PUBLISH_KEY_PACKAGES` — `0x0032`",
        "12.6.4 `CLAIM_KEY_PACKAGE` — `0x0033`",
        KEY_PACKAGE_AUTHENTICATION_TEXT,
        KEY_PACKAGE_EXHAUSTION_TEXT,
        "12.6.7 What a client may not conclude from `last_resort`",
        "12.6.8 Privacy — what this adds, precisely",
        "12.6.9 Anti-abuse",
    ];
    let Some(children) = rendered.child_headings(3, KEY_PACKAGE_PARENT_HEADING, 4) else {
        return false;
    };

    children == expected_children
        && !rendered.has_raw_html()
        && wire.matches(KEY_PACKAGE_AUTHENTICATION_HEADING).count() == 1
        && wire.matches(NEXT_WIRE_HEADING).count() == 1
        && wire.matches(KEY_PACKAGE_AUTHENTICATION_SECTION).count() == 1
        && wire.matches(KEY_PACKAGE_EXHAUSTION_SECTION).count() == 1
        && rendered
            .section(4, KEY_PACKAGE_AUTHENTICATION_TEXT)
            .as_deref()
            == Some(KEY_PACKAGE_AUTHENTICATION_SECTION)
        && rendered.section(4, KEY_PACKAGE_EXHAUSTION_TEXT).as_deref()
            == Some(KEY_PACKAGE_EXHAUSTION_SECTION)
        && wire_rendered_prose_digest(&rendered) == WIRE_RENDERED_PROSE_DIGEST
}

#[test]
fn wire_key_package_authentication_list_is_exhaustive_and_mutation_sensitive() {
    let rendered = markdown::RenderedMarkdown::parse(WIRE).expect("WIRE must parse fail-closed");
    assert_eq!(
        wire_rendered_prose_digest(&rendered),
        WIRE_RENDERED_PROSE_DIGEST,
        "WIRE's ordinary rendered prose changed; review the change before updating the contract"
    );
    assert!(
        wire_has_exact_key_package_authentication_table(WIRE),
        "WIRE §12.6.5 must carry the exact exhaustive authentication table"
    );

    for (name, original, replacement) in [
        (
            "full credential equality",
            "The complete signed `DeviceCredential` exactly equals the credential the entry publishes in `devices` for that `device_pk`; matching the key alone is insufficient.",
            "The credential's `device_pk` appears in the entry's `devices`.",
        ),
        (
            "shared inclusive validity rule",
            "At verifier-local time, that published credential is `Valid` under `KT.md` §4.1's exact shared inclusive fixed-skew rule; **not-yet-valid** and **expired** credentials are refused.",
            "The credential lifetime is acceptable.",
        ),
        (
            "cumulative revocation",
            "The credential's `device_pk` does **not** appear in the entry's cumulative `revocations`.",
            "The credential has not been revoked recently.",
        ),
    ] {
        assert_eq!(
            WIRE.matches(original).count(),
            1,
            "{name} mutation must target exactly one normative claim"
        );
        let mutant = WIRE.replacen(original, replacement, 1);
        assert!(
            !wire_has_exact_key_package_authentication_table(&mutant),
            "the checker survived deletion of {name}"
        );
    }

    let extra_rule = WIRE.replacen(
        KEY_PACKAGE_AUTHENTICATION_TABLE,
        &format!(
            "{KEY_PACKAGE_AUTHENTICATION_TABLE}\n\
             | 10 | Implementations MAY accept a matching device key without full credential equality. |"
        ),
        1,
    );
    assert!(
        !wire_has_exact_key_package_authentication_table(&extra_rule),
        "the checker accepted a tenth, contradictory authentication rule"
    );

    let advisory = WIRE.replacen(
        KEY_PACKAGE_AUTHENTICATION_TABLE,
        &format!(
            "{KEY_PACKAGE_AUTHENTICATION_TABLE}\n\n\
             The nine checks are advisory; matching the device key alone is sufficient."
        ),
        1,
    );
    assert!(
        !wire_has_exact_key_package_authentication_table(&advisory),
        "the checker accepted additive prose making full credential equality optional"
    );

    let synonymous_weakening = WIRE.replacen(
        KEY_PACKAGE_AUTHENTICATION_TABLE,
        &format!(
            "{KEY_PACKAGE_AUTHENTICATION_TABLE}\n\n\
             The nine checks are recommendations; a matching device key is adequate."
        ),
        1,
    );
    assert!(
        !wire_has_exact_key_package_authentication_table(&synonymous_weakening),
        "the checker accepted a synonymous additive weakening"
    );

    let adjacent_weakening = WIRE.replacen(
        NEXT_WIRE_HEADING,
        &format!(
            "{NEXT_WIRE_HEADING}\n\n\
             Despite §12.6.5, clients MAY accept a key package whenever its `device_pk` \
             matches a published device; exact credential equality is advisory."
        ),
        1,
    );
    assert!(
        !wire_has_exact_key_package_authentication_table(&adjacent_weakening),
        "the checker accepted a contradiction in adjacent §12.6.6"
    );

    for (name, original, addition) in [
        (
            "§12.6.5 four-space paragraph continuation",
            "before proposing the Add.",
            "Clients MAY match only `device_pk` and skip complete credential equality.",
        ),
        (
            "§12.6.6 four-space paragraph continuation",
            "is ever consulted again.",
            "Expired key packages MAY be accepted when the pool is exhausted.",
        ),
    ] {
        assert_eq!(
            WIRE.matches(original).count(),
            1,
            "{name} mutation must target exactly one rendered paragraph ending"
        );
        let visible_continuation =
            WIRE.replacen(original, &format!("{original}\n    {addition}"), 1);
        assert!(
            !wire_has_exact_key_package_authentication_table(&visible_continuation),
            "the checker discarded a visible {name} as indented code"
        );
    }

    let elsewhere_weakening = WIRE.replacen(
        "# free2z E2EE — Relay wire protocol, version 1",
        "# free2z E2EE — Relay wire protocol, version 1\n\nClients MAY use a matching device key without exact \
         `DeviceCredential` equality; the §12.6.5 checks are advisory.",
        1,
    );
    assert!(
        !wire_has_exact_key_package_authentication_table(&elsewhere_weakening),
        "the checker accepted a contradiction elsewhere in WIRE"
    );

    let html_elsewhere_weakening = WIRE.replacen(
        "# free2z E2EE — Relay wire protocol, version 1",
        "# free2z E2EE — Relay wire protocol, version 1\n\n<div>Clients MAY ignore \
         §12.6.5 and match only the device key.</div>",
        1,
    );
    assert!(
        !wire_has_exact_key_package_authentication_table(&html_elsewhere_weakening),
        "the checker accepted contradictory prose in a raw HTML container"
    );

    let hidden_and_contradicted = WIRE
        .replacen(
            KEY_PACKAGE_AUTHENTICATION_HEADING,
            &format!("<!--\n{KEY_PACKAGE_AUTHENTICATION_HEADING}"),
            1,
        )
        .replacen(
            NEXT_WIRE_HEADING,
            &format!(
                "{NEXT_WIRE_HEADING}\n-->\n\nClients MAY accept a package on matching \
                 `device_pk` alone; the hidden checks above are advisory."
            ),
            1,
        );
    assert!(
        !wire_has_exact_key_package_authentication_table(&hidden_and_contradicted),
        "the checker counted comment-hidden canonical policy over visible contradictory prose"
    );

    let same_line_comment = WIRE.replacen(
        KEY_PACKAGE_AUTHENTICATION_HEADING,
        &format!("<!-- hidden raw block -->{KEY_PACKAGE_AUTHENTICATION_HEADING}"),
        1,
    );
    assert!(
        !wire_has_exact_key_package_authentication_table(&same_line_comment),
        "text after a raw-comment close on the same line counted as a rendered heading"
    );

    let lazy_blockquote = WIRE.replacen(
        &format!("{KEY_PACKAGE_AUTHENTICATION_HEADING}\n\n"),
        &format!(
            "{KEY_PACKAGE_AUTHENTICATION_HEADING}\n> Quoted non-normative example whose marker is omitted on continuation lines\n"
        ),
        1,
    );
    assert!(
        !wire_has_exact_key_package_authentication_table(&lazy_blockquote),
        "unmarked lazy blockquote continuations established the canonical policy"
    );

    // A CommonMark closer may contain trailing whitespace and nothing else.
    // Treating the second line as a closer makes the canonical section appear
    // rendered even though the unclosed fence actually hides it through EOF.
    let malformed_fence_closer = WIRE.replacen(
        KEY_PACKAGE_AUTHENTICATION_HEADING,
        &format!(
            "```markdown\n``` this is literal fenced content, not a closer\n\
             {KEY_PACKAGE_AUTHENTICATION_HEADING}"
        ),
        1,
    );
    assert!(
        !wire_has_exact_key_package_authentication_table(&malformed_fence_closer),
        "the checker treated a fence with trailing text as a CommonMark closer"
    );

    for (name, opening, closing) in [
        ("fenced code", "```markdown", "```"),
        ("raw HTML container", "<div hidden>", "</div>"),
        ("raw HTML block", "<textarea>", "</textarea>"),
    ] {
        let hidden = WIRE
            .replacen(
                KEY_PACKAGE_AUTHENTICATION_HEADING,
                &format!("{opening}\n{KEY_PACKAGE_AUTHENTICATION_HEADING}"),
                1,
            )
            .replacen(
                NEXT_WIRE_HEADING,
                &format!("{NEXT_WIRE_HEADING}\n{closing}"),
                1,
            );
        assert!(
            !wire_has_exact_key_package_authentication_table(&hidden),
            "the checker counted canonical policy hidden in {name}"
        );
    }

    let authentication_block =
        format!("{KEY_PACKAGE_AUTHENTICATION_HEADING}\n\n{KEY_PACKAGE_AUTHENTICATION_SECTION}");
    for (name, prefix) in [("blockquote", "> "), ("indented code", "    ")] {
        let hidden_block = authentication_block
            .lines()
            .map(|line| format!("{prefix}{line}"))
            .collect::<Vec<_>>()
            .join("\n");
        let hidden = WIRE.replacen(&authentication_block, &hidden_block, 1);
        assert!(
            !wire_has_exact_key_package_authentication_table(&hidden),
            "the checker counted canonical policy hidden in a {name}"
        );
    }

    let without_authentication = WIRE.replacen(&format!("{authentication_block}\n\n"), "", 1);
    let relocated = without_authentication.replacen(
        "#### 12.6.7 What a client may not conclude from `last_resort`",
        &format!(
            "{authentication_block}\n\n#### 12.6.7 What a client may not conclude from `last_resort`"
        ),
        1,
    );
    assert!(
        !wire_has_exact_key_package_authentication_table(&relocated),
        "the checker accepted the canonical section at a different structural ordinal"
    );
}

#[test]
fn a_substituted_relay_id_breaks_the_device_authenticated_routing_advert() {
    let alice = device("alice", 11, 111);
    let entry = directory_entry(&[alice.credential().clone()]);
    let authentic = b"conversation|relay-url|relay-id-A|send-addr";
    let substituted = b"conversation|relay-url|relay-id-B|send-addr";
    let signature = alice
        .sign_routing_advert(authentic)
        .expect("routing signature");

    f2z_msg_mls::MlsEngine::<f2z_msg_store::MemoryBackend>::authenticate_routing_advert(
        &entry,
        alice.credential().credential.device_pk.as_bytes(),
        authentic,
        &signature,
        NOW,
    )
    .expect("the active directory device signed the complete advert");
    assert!(
        f2z_msg_mls::MlsEngine::<f2z_msg_store::MemoryBackend>::authenticate_routing_advert(
            &entry,
            alice.credential().credential.device_pk.as_bytes(),
            substituted,
            &signature,
            NOW,
        )
        .is_err(),
        "deleting relay-id coverage would make this mutation survive"
    );
}

#[test]
fn a_swapped_welcome_breaks_the_device_authenticated_routing_transcript() {
    let alice = device("alice", 11, 111);
    let entry = directory_entry(&[alice.credential().clone()]);
    let authentic = b"conversation|route|digest-of-alice-welcome";
    let swapped = b"conversation|route|digest-of-attacker-welcome";
    let signature = alice
        .sign_routing_advert(authentic)
        .expect("routing signature");

    f2z_msg_mls::MlsEngine::<f2z_msg_store::MemoryBackend>::authenticate_routing_advert(
        &entry,
        alice.credential().credential.device_pk.as_bytes(),
        authentic,
        &signature,
        NOW,
    )
    .expect("Alice's active directory device signed the Welcome-bound transcript");
    assert!(
        f2z_msg_mls::MlsEngine::<f2z_msg_store::MemoryBackend>::authenticate_routing_advert(
            &entry,
            alice.credential().credential.device_pk.as_bytes(),
            swapped,
            &signature,
            NOW,
        )
        .is_err(),
        "deleting Welcome coverage would make this substitution survive"
    );
}

#[test]
fn routing_advert_refusals_name_the_directory_device_state() {
    let bob = device("bob", 22, 222);
    let payload = b"conversation|relay-url|relay-id|send-addr";
    let signature = bob.sign_routing_advert(payload).expect("routing signature");
    let device_pk = bob.credential().credential.device_pk;

    let unpublished = device("bob", 22, 244);
    let unpublished_entry = directory_entry(&[unpublished.credential().clone()]);
    let error = MlsEngine::<f2z_msg_store::MemoryBackend>::authenticate_routing_advert(
        &unpublished_entry,
        device_pk.as_bytes(),
        payload,
        &signature,
        NOW,
    )
    .expect_err("the routing signer is not published");
    assert!(
        matches!(
            error,
            EngineError::Credential(CredentialError::DeviceNotPublished)
        ),
        "{error:?}"
    );

    let entry = directory_entry(&[bob.credential().clone()]);
    let revoked = with_revocation(&entry, device_pk);
    let error = MlsEngine::<f2z_msg_store::MemoryBackend>::authenticate_routing_advert(
        &revoked,
        device_pk.as_bytes(),
        payload,
        &signature,
        NOW,
    )
    .expect_err("the routing signer is revoked");
    assert!(
        matches!(
            error,
            EngineError::Credential(CredentialError::DeviceRevoked)
        ),
        "{error:?}"
    );

    let skew = f2z_kt_core::entry::DEVICE_CREDENTIAL_CLOCK_SKEW_MS;
    for (not_before, not_after, expected) in [
        (NOW + skew + 1, NOW + skew + 2, CredentialError::NotYetValid),
        (NOW - skew - 2, NOW - skew - 1, CredentialError::Expired),
    ] {
        let published = issue_credential("bob", 22, 222, not_before, not_after).0;
        let entry = directory_entry(&[published]);
        let error = MlsEngine::<f2z_msg_store::MemoryBackend>::authenticate_routing_advert(
            &entry,
            device_pk.as_bytes(),
            payload,
            &signature,
            NOW,
        )
        .expect_err("the routing signer is outside its published window");
        assert!(
            matches!(error, EngineError::Credential(actual) if actual == expected),
            "expected {expected:?}, got {error:?}"
        );
    }
}

#[test]
fn a_batch_is_generated_in_order_and_every_package_verifies() {
    let bob = device("bob", 22, 222);
    let alice = device("alice", 11, 111);
    let entry = directory_entry(&[bob.credential().clone()]);

    let batch = bob.generate_key_packages(8, None).expect("a batch");
    assert_eq!(batch.len(), 8);
    // Distinct init keys, or the pool is one package wearing eight hats.
    let mut seen = batch.clone();
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), 8, "a pool of identical packages is not a pool");

    for wire in &batch {
        let verified = alice
            .verify_key_package(wire, &entry, NOW)
            .expect("the directory vouches for it");
        assert!(!verified.last_resort(), "a pooled package is single-use");
        assert_eq!(
            verified.device_pk(),
            bob.credential().credential.device_pk.as_bytes()
        );
    }
}

#[test]
fn the_last_resort_package_says_so_in_its_own_signed_extensions() {
    let bob = device("bob", 22, 222);
    let alice = device("alice", 11, 111);
    let entry = directory_entry(&[bob.credential().clone()]);

    let wire = bob
        .generate_last_resort_key_package(Some(86_400))
        .expect("a last-resort package");
    let verified = alice
        .verify_key_package(&wire, &entry, NOW)
        .expect("it is still a valid package from the right device");
    // RFC 9420's `last_resort` extension, read out of what the device signed —
    // never out of the relay's advisory response byte.
    assert!(verified.last_resort());
}

#[test]
fn a_last_resort_package_is_usable_and_is_never_refused_for_being_one() {
    // §12.6's exhaustion behaviour depends on this: availability is what the
    // reusable package buys, and a layer that refused it would have converted
    // the trade into a failure to reach somebody.
    let bob = device("bob", 22, 222);
    let alice = device("alice", 11, 111);
    let entry = directory_entry(&[bob.credential().clone()]);

    let wire = bob.generate_last_resort_key_package(None).expect("package");
    let verified = alice
        .verify_key_package(&wire, &entry, NOW)
        .expect("verified");
    let mut group = alice.create_group(b"conversation").expect("group");
    let (_commit, welcome) = alice
        .add_member(&mut group, &verified, NOW)
        .expect("a last-resort package joins a group like any other");
    let bob_group = bob.join_from_welcome(&welcome, NOW).expect("bob joins");
    assert_eq!(group.group_id(), bob_group.group_id());
}

#[test]
fn a_mismatched_outer_group_id_rolls_back_and_the_correct_group_reloads() {
    let bob = device("bob", 22, 222);
    let alice = device("alice", 11, 111);
    let entry = directory_entry(&[bob.credential().clone()]);
    let package = bob.generate_key_package().expect("package");
    let verified = alice
        .verify_key_package(&package, &entry, NOW)
        .expect("verified package");
    let actual_id = b"actual-conversation-id-32-bytes!";
    assert_eq!(actual_id.len(), 32);
    let mismatched_id = b"other-conversation-id--32-bytes!";
    assert_eq!(mismatched_id.len(), 32);
    let mut alice_group = alice.create_group(actual_id).expect("group");
    let (_commit, welcome) = alice
        .add_member(&mut alice_group, &verified, NOW)
        .expect("welcome");

    let error = bob
        .join_from_welcome_for_group_id(&welcome, NOW, mismatched_id)
        .expect_err("the outer id must agree with the Welcome");
    assert!(matches!(error, EngineError::GroupIdMismatch));
    assert!(
        MlsGroup::load(bob.provider().storage(), &GroupId::from_slice(actual_id))
            .expect("load after refused join")
            .is_none(),
        "the failed join must roll back instead of leaving an orphan group"
    );

    let joined = bob
        .join_from_welcome_for_group_id(&welcome, NOW, actual_id)
        .expect("the rolled-back init key remains usable");
    assert_eq!(joined.group_id().as_slice(), actual_id);
    drop(joined);
    assert!(
        MlsGroup::load(bob.provider().storage(), &GroupId::from_slice(actual_id))
            .expect("restart-style reload")
            .is_some(),
        "a correctly keyed conversation must reload after the live group is dropped"
    );
}

#[test]
fn a_package_signed_under_a_different_identity_key_is_refused() {
    // **The MITM.** A hostile relay makes up an identity key, issues itself a
    // credential under it for the handle it is impersonating, and signs a real
    // key package with the matching device key. Every check that looks only at
    // the package passes. The directory's `identity_pk` is what stops it.
    let bob = device("bob", 22, 222);
    let impostor = device("bob", 99, 222);
    let alice = device("alice", 11, 111);

    let entry = directory_entry(&[bob.credential().clone()]);
    let substituted = impostor.generate_key_package().expect("package");

    let error = alice
        .verify_key_package(&substituted, &entry, NOW)
        .expect_err("a package under an identity key the log never proved");
    assert!(
        matches!(
            error,
            EngineError::Credential(CredentialError::BadSignature)
        ),
        "{error:?}"
    );
}

#[test]
fn a_package_for_a_different_handle_is_refused() {
    // A genuine credential, correctly signed, from a real device — for somebody
    // else. Reachable when one identity key speaks for two handles, and the
    // relay serves the wrong one's package.
    let carol = device("carol", 22, 222);
    let bob_credential = common::issue_credential("bob", 22, 233, NOW - 1_000, NOW + 1_000).0;
    let alice = device("alice", 11, 111);

    let mut entry = directory_entry(std::slice::from_ref(&bob_credential));
    // The impostor shares the identity key, so only the handle differs.
    entry.identity_pk = carol.credential().credential.identity_pk;
    entry.handle = bob_credential.credential.handle.clone();
    entry.devices = vec![bob_credential, carol.credential().clone()].into();

    let wire = carol.generate_key_package().expect("package");
    let error = alice
        .verify_key_package(&wire, &entry, NOW)
        .expect_err("the credential names carol, the entry names bob");
    assert!(
        matches!(
            error,
            EngineError::Credential(CredentialError::InvalidHandle)
        ),
        "{error:?}"
    );
}

#[test]
fn a_package_from_a_device_the_entry_does_not_publish_is_refused() {
    // Same identity key, same handle, correctly signed — a device the owner
    // never put in the directory. An old phone, or one the identity key signed
    // for and the owner then withdrew.
    let published = device("bob", 22, 222);
    let unpublished = device("bob", 22, 244);
    let alice = device("alice", 11, 111);

    let entry = directory_entry(&[published.credential().clone()]);
    let wire = unpublished.generate_key_package().expect("package");

    let error = alice
        .verify_key_package(&wire, &entry, NOW)
        .expect_err("the directory publishes the device set");
    assert!(
        matches!(
            error,
            EngineError::Credential(CredentialError::DeviceNotPublished)
        ),
        "{error:?}"
    );
}

#[test]
fn a_package_from_a_revoked_device_is_refused() {
    let bob = device("bob", 22, 222);
    let alice = device("alice", 11, 111);

    let entry = directory_entry(&[bob.credential().clone()]);
    let wire = bob.generate_key_package().expect("package");
    // Before the revocation it verifies; that is what makes the assertion after
    // it a statement about the revocation and not about anything else.
    alice
        .verify_key_package(&wire, &entry, NOW)
        .expect("verified");

    let revoked = with_revocation(&entry, bob.credential().credential.device_pk);
    let error = alice
        .verify_key_package(&wire, &revoked, NOW)
        .expect_err("a revoked device must not be reachable for first contact");
    assert!(
        matches!(
            error,
            EngineError::Credential(CredentialError::DeviceRevoked)
        ),
        "{error:?}"
    );
}

#[test]
fn an_expired_package_is_refused() {
    let bob = device("bob", 22, 222);
    let alice = device("alice", 11, 111);
    let entry = directory_entry(&[bob.credential().clone()]);

    let wire = bob.generate_key_package().expect("package");
    // Far past the credential's `not_after`. §12.6's refill rule exists so this
    // is a thing a long-offline device causes, and it must be a refusal rather
    // than an unopenable `Welcome`.
    let error = alice
        .verify_key_package(&wire, &entry, NOW + 100_000_000_000)
        .expect_err("an expired package is not usable");
    assert!(
        matches!(error, EngineError::Credential(CredentialError::Expired)),
        "{error:?}"
    );
}

#[test]
fn first_contact_uses_the_published_credential_window_not_only_the_package_window() {
    let bob = device("bob", 22, 222);
    let alice = device("alice", 11, 111);
    let wire = bob.generate_key_package().expect("package");
    let skew = f2z_kt_core::entry::DEVICE_CREDENTIAL_CLOCK_SKEW_MS;

    for (not_before, not_after, expected) in [
        (NOW + skew + 1, NOW + skew + 2, CredentialError::NotYetValid),
        (NOW - skew - 2, NOW - skew - 1, CredentialError::Expired),
    ] {
        // Same identity, handle and device key as the still-valid credential
        // inside `wire`; only the directory-published lifetime excludes it.
        let published = issue_credential("bob", 22, 222, not_before, not_after).0;
        let entry = directory_entry(&[published]);
        let error = alice
            .verify_key_package(&wire, &entry, NOW)
            .expect_err("the published credential is inactive");
        assert!(
            matches!(error, EngineError::Credential(actual) if actual == expected),
            "expected {expected:?}, got {error:?}"
        );
    }
}

#[test]
fn a_stale_longer_lived_credential_for_the_same_device_key_is_not_published() {
    let (embedded, signer) = issue_credential("bob", 22, 222, NOW - 1_000_000, NOW + 1_000_000);
    let bob = MlsEngine::new(
        f2z_msg_store::MemoryBackend::new(),
        signer,
        embedded.clone(),
        NOW,
    )
    .expect("the older credential is currently valid");
    let wire = bob.generate_key_package().expect("package");

    // The replacement uses the exact same identity, handle and DSK, and is
    // also valid now. Only full credential equality catches that the relay
    // retained the older, longer-lived credential embedded in `wire`.
    let published = issue_credential("bob", 22, 222, NOW - 500, NOW + 500).0;
    assert_eq!(
        embedded.credential.device_pk,
        published.credential.device_pk
    );
    assert_ne!(embedded, published);

    let alice = device("alice", 11, 111);
    let entry = directory_entry(&[published]);
    let error = alice
        .verify_key_package(&wire, &entry, NOW)
        .expect_err("a stale credential is not the credential the directory publishes");
    assert!(
        matches!(
            error,
            EngineError::Credential(CredentialError::PublishedCredentialMismatch)
        ),
        "{error:?}"
    );
}

#[test]
fn trailing_bytes_after_a_package_are_refused() {
    let bob = device("bob", 22, 222);
    let alice = device("alice", 11, 111);
    let entry = directory_entry(&[bob.credential().clone()]);

    let mut wire = bob.generate_key_package().expect("package");
    wire.push(0);
    let error = alice
        .verify_key_package(&wire, &entry, NOW)
        .expect_err("exactly one encoding, or nothing");
    assert!(matches!(error, EngineError::Mls(_)), "{error:?}");
}

#[test]
fn a_welcome_is_bound_to_the_package_it_was_addressed_to() {
    // Consumption is the relay's rule, but the reason it matters is here: a
    // `Welcome` addressed to one package cannot be opened with another's init
    // key, so serving a package twice does not merely waste it — it is what
    // makes two initiators share one secret.
    let bob = device("bob", 22, 222);
    let alice = device("alice", 11, 111);
    let entry = directory_entry(&[bob.credential().clone()]);

    let first = bob.generate_key_package().expect("package");
    let second = bob.generate_key_package().expect("package");
    assert_ne!(first, second);

    let verified = alice
        .verify_key_package(&first, &entry, NOW)
        .expect("verified");
    let mut group = alice.create_group(b"conversation").expect("group");
    let (_commit, welcome) = alice.add_member(&mut group, &verified, NOW).expect("add");

    // Bob still holds both private init keys, so this succeeds — which is the
    // point: the binding is to the *package*, and the relay's job is only to
    // stop handing the same one out twice.
    let joined = bob.join_from_welcome(&welcome, NOW).expect("join");
    assert_eq!(joined.group_id(), group.group_id());
}
