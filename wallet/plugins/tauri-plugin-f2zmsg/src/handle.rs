//! `CLIENT-CONTRACT.md` §11.3 — the messaging handle charset, and the one
//! question a client is allowed to answer locally about it.
//!
//! ```text
//! /^[a-z0-9_]{1,30}$/     ASCII only, compared as bytes, no normalization
//! ```
//!
//! The restriction is not tidiness. A charset with no case and a single script
//! makes an entire class of homograph and mixed-script impersonation **not
//! exist** rather than be defended against — `@аlice` with a Cyrillic а cannot
//! be encoded as a messaging handle at all — and a normalization function is
//! itself an attack surface (`WIRE.md` §14).
//!
//! It excludes an entire class and not every class, and the remainder is the
//! UI's job: `[a-z0-9_]` still contains `1`/`l` and `0`/`o`. Nothing below the
//! UI defends against `@a1ice` versus `@alice`. §11.3's three build rules —
//! render handles in a disambiguating face, never sell the charset as a safety
//! property, and point the user at safety-number verification — are the
//! frontend's, and this module has nothing to say about them.
//!
//! # What this module deliberately does not do
//!
//! **It does not derive a handle from a username.** §11.3 is explicit: case
//! -insensitive username uniqueness lives in two serializers and *not* in the
//! database, production holds case-variant duplicate accounts today, so
//! `lowercase(username)` is **not yet a unique key**. Two accounts folding to
//! the same string are not the same account. So [`eligibility`] answers "could
//! this string be a handle", which is a pure function of the string, and the
//! question "is this handle yours" is the directory's to answer.

use crate::models::{HandleEligibility, IneligibilityReason};

/// §11.3's maximum, after lowercasing.
pub const MAX_HANDLE_LENGTH: usize = 30;

/// Whether a string is already a valid messaging handle, byte for byte.
///
/// No normalization, no case folding, no trimming: this is the exact predicate
/// the directory applies, and a client that applied a looser one would resolve
/// handles the log cannot hold.
#[must_use]
pub fn is_handle(candidate: &str) -> bool {
    !candidate.is_empty()
        && candidate.len() <= MAX_HANDLE_LENGTH
        && candidate
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

/// §3.2's `HandleEligibility` for a free2z username.
///
/// `reason` distinguishes the causes because they are wildly different in
/// prevalence and the UI should say the true specific thing: punctuation is
/// just under a tenth of all accounts, non-ASCII and over-length are very few,
/// and uppercase disqualifies nobody. A single "invalid handle" string would be
/// accurate and useless.
///
/// `NotSignedIn` is not reachable from a string and is therefore not produced
/// here — it is the answer when there is no username to ask about, which the
/// caller knows and this function cannot.
#[must_use]
pub fn eligibility(username: &str) -> HandleEligibility {
    if username.is_empty() {
        return ineligible(IneligibilityReason::Punctuation);
    }
    if !username.is_ascii() {
        return ineligible(IneligibilityReason::NonAscii);
    }

    let candidate = username.to_ascii_lowercase();

    // Order matters, and this order is the contract's: a name that is both too
    // long and contains a dot is reported as punctuation, because punctuation is
    // the thing the user can see and the thing that dominates the population.
    if !candidate
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return ineligible(IneligibilityReason::Punctuation);
    }
    if candidate.len() > MAX_HANDLE_LENGTH {
        return ineligible(IneligibilityReason::TooLong);
    }

    HandleEligibility {
        eligible: true,
        candidate: Some(candidate),
        reason: None,
    }
}

/// The answer for a caller with no signed-in account. Kept here so the whole
/// §3.2 shape is minted in one place.
#[must_use]
pub const fn not_signed_in() -> HandleEligibility {
    HandleEligibility {
        eligible: false,
        candidate: None,
        reason: Some(IneligibilityReason::NotSignedIn),
    }
}

const fn ineligible(reason: IneligibilityReason) -> HandleEligibility {
    HandleEligibility {
        eligible: false,
        candidate: None,
        reason: Some(reason),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[test]
    fn an_ordinary_username_folds_to_a_handle() {
        let result = eligibility("SkylarSaveland");
        assert!(result.eligible);
        assert_eq!(result.candidate.as_deref(), Some("skylarsaveland"));
        assert_eq!(result.reason, None);
    }

    #[test]
    fn uppercase_disqualifies_nobody() {
        assert!(eligibility("ALICE").eligible);
        assert!(eligibility("Alice_99").eligible);
    }

    #[test]
    fn punctuation_is_named_as_punctuation() {
        // §11.3: `.` `@` `+` `-` are just under a tenth of all accounts and are
        // overwhelmingly the reason an account is ineligible.
        for username in ["a.b", "a@b", "a+b", "a-b"] {
            assert_eq!(
                eligibility(username).reason,
                Some(IneligibilityReason::Punctuation),
                "{username}"
            );
        }
    }

    #[test]
    fn a_homograph_is_refused_before_it_can_be_looked_up() {
        // The Cyrillic а. §11.3's mitigation is narrow and exact: the string
        // does not match the charset, so the directory refuses to resolve it at
        // all, turning a silent impersonation into a lookup failure.
        let result = eligibility("\u{0430}lice");
        assert!(!result.eligible);
        assert_eq!(result.reason, Some(IneligibilityReason::NonAscii));
        assert_eq!(result.candidate, None);
    }

    #[test]
    fn over_length_is_measured_after_lowercasing() {
        let thirty = "a".repeat(30);
        assert!(eligibility(&thirty.to_uppercase()).eligible);
        let thirty_one = "a".repeat(31);
        assert_eq!(
            eligibility(&thirty_one).reason,
            Some(IneligibilityReason::TooLong)
        );
    }

    #[test]
    fn a_candidate_is_present_only_when_it_matches() {
        assert_eq!(eligibility("a.b").candidate, None);
        assert_eq!(eligibility("ab").candidate.as_deref(), Some("ab"));
    }

    #[test]
    fn is_handle_is_the_exact_directory_predicate() {
        assert!(is_handle("alice_99"));
        assert!(!is_handle("Alice"), "no case folding here");
        assert!(!is_handle(""));
        assert!(!is_handle(&"a".repeat(31)));
        assert!(!is_handle("a.b"));
        assert!(!is_handle("\u{0430}lice"));
    }

    // `docs/e2ee/WIRE.md` §14.1: "A conforming implementation of this section
    // MUST maintain a mutation-sensitive test that checks the Rust and
    // TypeScript implementations against one shared table of (input →
    // expected HandleEligibility) fixtures ... so that an edit to either
    // implementation which drifts from the other, or from this table, fails a
    // test rather than shipping unnoticed." This crate and
    // `wallet/zuuli/src/lib/messaging/mock.ts` cannot share a test file, so
    // the fixture table is the thing kept in one place:
    // `wallet/zuuli/src/lib/messaging/handle-eligibility.fixtures.json`, read
    // here via `include_str!` and imported as a JSON module by
    // `mock.handle-eligibility.test.ts`. It lives under `wallet/zuuli` rather
    // than `docs/` so a `mock.ts`-side import of it never has to reach outside
    // the wallet project's own module boundary. Neither implementation is the
    // source of truth for the other; both are pinned to the fixture.
    //
    // `input: null` exercises `not_signed_in()`; every other `input` exercises
    // `eligibility(input)`. `#838` is the empty-string row: this table fixes
    // `eligibility("")` at `Punctuation`, and a future edit reintroducing the
    // `mock.ts` bug (answering `NotSignedIn` for an empty, signed-in-account
    // username) fails on the TypeScript side of this same table.
    #[derive(Deserialize)]
    struct FixtureCase {
        label: String,
        input: Option<String>,
        expected: HandleEligibility,
    }

    #[derive(Deserialize)]
    struct Fixture {
        cases: Vec<FixtureCase>,
    }

    #[test]
    fn matches_the_shared_rust_ts_fixture_table() {
        let raw = include_str!("../../../zuuli/src/lib/messaging/handle-eligibility.fixtures.json");
        let fixture: Fixture = serde_json::from_str(raw).expect("fixture parses as JSON");
        assert!(!fixture.cases.is_empty(), "fixture table must not be empty");
        for case in fixture.cases {
            let actual = match &case.input {
                None => not_signed_in(),
                Some(username) => eligibility(username),
            };
            assert_eq!(actual, case.expected, "fixture case: {}", case.label);
        }
    }
}
