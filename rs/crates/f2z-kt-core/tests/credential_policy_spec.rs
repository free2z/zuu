//! Mutation-sensitive agreement between KT §4.1 and the credential policy.

#![allow(clippy::expect_used)]

use f2z_kt_core::entry::DEVICE_CREDENTIAL_CLOCK_SKEW_MS;

#[path = "../../../tests/support/markdown.rs"]
mod markdown;

const KT: &str = include_str!("../../../../docs/e2ee/KT.md");
const DIRECTORY_ENTRY_HEADING: &str = "4. `DirectoryEntry`";
const STRUCTURE_HEADING: &str = "4.1 Structure";
const STRUCTURE_POLICY_DIGEST: u64 = 2_518_136_126_776_171_893;

const LIFETIME_POLICY: &str = r#"The interval MUST be non-empty: `not_before_ms < not_after_ms`. The v1
credential-clock tolerance is a fixed protocol constant,
`credential_clock_skew_ms = 120000`; it is not log policy and a log cannot
increase it. At verifier-local Unix time `t`, a credential is valid exactly
when both `not_before_ms <= saturating_add(t, credential_clock_skew_ms)` and
`t <= saturating_add(not_after_ms, credential_clock_skew_ms)` hold. Both outer
boundaries are inclusive. Before the first boundary the result is
**not-yet-valid**; after the second it is **expired**. Either result excludes the
credential from lookup-driven first contact and causes an MLS peer validating
the self-contained credential to reject it."#;

const REVOCATION_POLICY: &str = r#"`revocations` is an append-only cumulative history per handle. A single entry
MUST NOT contain two records for one `device_pk`, whether identical or
contradictory. Every successor MUST carry its predecessor's complete vector as
an exact prefix: existing records cannot be omitted, reordered or edited, and
new records are appended. This rule crosses identity-key changes and does not
grant `platform_reset` an un-revocation power. A revocation takes effect when
the entry containing it is published; `revoked_at_ms` and `reason` are audit and
display metadata, not a future activation switch. The log MUST apply the
interval, uniqueness and cumulative-prefix checks during admission, before it
persists the submission or issues a `SubmissionReceipt`.

A fresh verified lookup therefore teaches a client every revocation published
for the handle, and first-contact selection MUST exclude both revoked and
out-of-window credentials. An offline MLS peer has only the credential already
carried in the group: it can enforce the same time interval from its local
clock, but it cannot learn a later directory revocation until it performs or
receives the result of a fresh verified lookup. Publishing a KT revocation does
not itself remove an existing MLS member or retroactively invalidate messages;
that requires an MLS state change delivered through the group."#;

fn kt_credential_policy_is_exact(kt: &str) -> bool {
    let Some(rendered) = markdown::RenderedMarkdown::parse(kt) else {
        return false;
    };
    let expected_children = [
        "4.1 Structure",
        "4.2 Versions and the hash chain",
        "4.3 Uniqueness within an epoch — a MUST that comes from the audit",
        "4.4 What authorizes an entry",
        "4.5 `HandleAssertion` — what authorizes a handle's first entry",
        "4.6 A log with no authority, and why it must say so",
        "4.7 What a compromised authority can and cannot do",
    ];
    let Some(children) = rendered.child_headings(2, DIRECTORY_ENTRY_HEADING, 3) else {
        return false;
    };
    let Some(section) = rendered.section(3, STRUCTURE_HEADING) else {
        return false;
    };
    let lifetime_context = format!(
        "so it cannot depend on\nits envelope for meaning.\n\n{LIFETIME_POLICY}\n\n```\nstruct {{\n    opaque device_pk[32];"
    );
    let revocation_context = format!(
        "    EntryAuthorization authorization;     /* §4.4 */\n}} DirectoryEntry;\n```\n\n{REVOCATION_POLICY}\n\nNote what is **not** in it:"
    );

    children == expected_children
        && kt.matches("### 4.1 Structure").count() == 1
        && kt.matches(LIFETIME_POLICY).count() == 1
        && kt.matches(REVOCATION_POLICY).count() == 1
        && kt.matches(&lifetime_context).count() == 1
        && kt.matches(&revocation_context).count() == 1
        && section.contains(LIFETIME_POLICY)
        && section.contains(REVOCATION_POLICY)
        && rendered.section_has_raw_html(3, STRUCTURE_HEADING) == Some(false)
        && markdown::stable_digest(core::iter::once(section)) == STRUCTURE_POLICY_DIGEST
}

#[test]
fn credential_policy_is_bound_to_the_normative_spec() {
    assert_eq!(DEVICE_CREDENTIAL_CLOCK_SKEW_MS, 120_000);
    let rendered = markdown::RenderedMarkdown::parse(KT).expect("KT must parse fail-closed");
    let section = rendered
        .section(3, STRUCTURE_HEADING)
        .expect("KT §4.1 must be a unique rendered section");
    assert!(
        rendered.has_raw_html(),
        "reviewed AKD claim-marker comments elsewhere in KT remain present"
    );
    assert_eq!(
        rendered.section_has_raw_html(3, STRUCTURE_HEADING),
        Some(false),
        "KT §4.1 itself must stay free of raw HTML"
    );
    assert_eq!(
        markdown::stable_digest(core::iter::once(section)),
        STRUCTURE_POLICY_DIGEST,
        "the rendered KT §4.1 contract changed"
    );
    assert!(kt_credential_policy_is_exact(KT));

    for (name, addition) in [
        (
            "advisory",
            "The interval and revocation requirements above are advisory.",
        ),
        (
            "ignored intervals",
            "Implementations MAY ignore credential intervals during first contact.",
        ),
        (
            "un-revocation",
            "A successor MAY remove a prior revocation and re-enable that device.",
        ),
    ] {
        let mutant = KT.replacen(
            LIFETIME_POLICY,
            &format!("{LIFETIME_POLICY}\n\n{addition}"),
            1,
        );
        assert!(
            !kt_credential_policy_is_exact(&mutant),
            "the exact §4.1 contract survived additive {name} prose"
        );
    }

    let indented_visible_continuation = KT.replacen(
        "Mutable profile data\nbelongs on the platform, where it can be changed and deleted.",
        "Mutable profile data\nbelongs on the platform, where it can be changed and deleted.\n    Nevertheless, a successor MAY remove a prior revocation and re-enable that device.",
        1,
    );
    assert!(
        !kt_credential_policy_is_exact(&indented_visible_continuation),
        "a four-space continuation of §4.1's prose carried a visible un-revocation"
    );

    for (name, addition) in [
        (
            "inline span",
            "<span>A successor MAY remove a prior revocation and re-enable that device.</span>",
        ),
        (
            "open details container",
            "<details open>A successor MAY remove a prior revocation and re-enable that device.</details>",
        ),
    ] {
        let visible_html_contradiction = KT.replacen(
            "Mutable profile data\nbelongs on the platform, where it can be changed and deleted.",
            &format!(
                "Mutable profile data\nbelongs on the platform, where it can be changed and deleted.\n\n{addition}"
            ),
            1,
        );
        assert!(
            !kt_credential_policy_is_exact(&visible_html_contradiction),
            "a visible contradiction in {name} escaped the protected §4.1 raw-HTML guard"
        );
    }

    let coordinated_hiding = KT
        .replacen(LIFETIME_POLICY, &format!("<!--\n{LIFETIME_POLICY}"), 1)
        .replacen(
            REVOCATION_POLICY,
            &format!(
                "{REVOCATION_POLICY}\n-->\n\nImplementations MAY ignore intervals and remove \
                 prior revocations; the hidden policy is advisory."
            ),
            1,
        );
    assert!(
        !kt_credential_policy_is_exact(&coordinated_hiding),
        "hidden canonical policy plus visible contradictory policy passed"
    );

    for (name, opening) in [
        ("quoted greater-than", "<details title=\"a > b\">"),
        ("quoted self-close token", "<details title=\"/>\">"),
    ] {
        let hidden_section = KT
            .replacen(
                "### 4.1 Structure",
                &format!("{opening}\n### 4.1 Structure"),
                1,
            )
            .replacen(
                "### 4.2 Versions and the hash chain",
                "</details>\n\n### 4.2 Versions and the hash chain",
                1,
            );
        assert!(
            !kt_credential_policy_is_exact(&hidden_section),
            "a {name} must not expose §4.1 hidden in a details container"
        );
    }

    let malformed_spaced_close = KT.replacen(
        "### 4.1 Structure",
        "<details>\n</ details>\n### 4.1 Structure",
        1,
    );
    assert!(
        !kt_credential_policy_is_exact(&malformed_spaced_close),
        "a malformed `</ details>` must not pop the raw HTML container"
    );

    let hidden_by_commonmark_hgroup =
        KT.replacen("### 4.1 Structure", "<hgroup>\n### 4.1 Structure", 1);
    assert!(
        !kt_credential_policy_is_exact(&hidden_by_commonmark_hgroup),
        "the normative CommonMark hgroup block tag must not hide §4.1"
    );

    for (name, opening, closing) in [
        ("fenced code", "```markdown", "```"),
        ("raw HTML container", "<details>", "</details>"),
    ] {
        let hidden = KT.replacen(
            LIFETIME_POLICY,
            &format!("{opening}\n{LIFETIME_POLICY}\n{closing}"),
            1,
        );
        assert!(
            !kt_credential_policy_is_exact(&hidden),
            "canonical lifetime policy hidden in {name} passed"
        );
    }

    for (name, prefix) in [("blockquote", "> "), ("indented code", "    ")] {
        let hidden_policy = LIFETIME_POLICY
            .lines()
            .map(|line| format!("{prefix}{line}"))
            .collect::<Vec<_>>()
            .join("\n");
        let hidden = KT.replacen(LIFETIME_POLICY, &hidden_policy, 1);
        assert!(
            !kt_credential_policy_is_exact(&hidden),
            "canonical lifetime policy hidden in a {name} passed"
        );
    }

    let removed = KT.replacen(&format!("{LIFETIME_POLICY}\n\n"), "", 1);
    let relocated = removed.replacen(
        "### 4.2 Versions and the hash chain",
        &format!("### 4.2 Versions and the hash chain\n\n{LIFETIME_POLICY}"),
        1,
    );
    assert!(
        !kt_credential_policy_is_exact(&relocated),
        "canonical lifetime policy relocated outside §4.1 passed"
    );
}
