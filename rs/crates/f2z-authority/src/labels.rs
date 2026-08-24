//! Domain separation: every label this crate signs under or hashes with.
//!
//! `KT.md` §1.3 fixes `H(label, x) = BLAKE2b-256(label || x)` with **no
//! separator and no terminator**, which is only unambiguous while no label is a
//! prefix of another. That is a property of a *set*, not of the construction,
//! so it has to be asserted rather than assumed — [`LABELS`] exists so a test
//! can do it mechanically, and [`KT_LABELS`] extends the same test across the
//! labels `KT.md` already spends, because a new label here that shadows one
//! there is the same bug even though it is in a different file.
//!
//! The two `*_TBS` labels are not hash prefixes. They are the `opaque
//! label<0..255>` **first field** of a signed structure, exactly as
//! `DirectoryEntryTBS`, `RotationProofTBS` and `ResetAuthorizationTBS` carry
//! theirs (`KT.md` §4.1, §4.4). Because the field is length-prefixed, they are
//! separated by construction — they are held to the prefix-free rule anyway, so
//! that nobody has to work out which of the five is which before adding a
//! sixth.

/// The `label` field of a [`HandleAssertionTBS`], and therefore the first bytes
/// of everything an authority signs.
///
/// This is the "domain-separated signing prefix": an authority key that is also
/// used elsewhere cannot have one of its other signatures reinterpreted as an
/// assertion, because no other structure in the system starts with these bytes
/// under a `<0..255>` length prefix.
///
/// [`HandleAssertionTBS`]: crate::assertion::HandleAssertionTBS
pub const LABEL_ASSERTION_TBS: &[u8] = b"free2z/kt/v1/handle-assertion";

/// The `label` field of an [`AssertionBindingTBS`] — what the *identity* key
/// signs.
///
/// [`AssertionBindingTBS`]: crate::assertion::AssertionBindingTBS
pub const LABEL_ASSERTION_BINDING_TBS: &[u8] = b"free2z/kt/v1/assertion-binding";

/// `authority_id = H("free2z/kt/v1/authority-id", authority_pk)`.
///
/// The same shape as `WIRE.md` §5.2's `relay_id`, and for the same reason: a
/// key id that is *derived* from the key cannot disagree with it, so an
/// [`AuthoritySet`] entry cannot name one authority and carry another's key.
///
/// [`AuthoritySet`]: crate::authority::AuthoritySet
pub const LABEL_AUTHORITY_ID: &[u8] = b"free2z/kt/v1/authority-id";

/// `handle_id = H("free2z/kt/v1/handle-id", handle)`.
pub const LABEL_HANDLE_ID: &[u8] = b"free2z/kt/v1/handle-id";

/// `assertion_digest = H("free2z/kt/v1/assertion-digest", tls_codec(HandleAssertion))`
/// — the value the identity key's binding signature commits to.
pub const LABEL_ASSERTION_DIGEST: &[u8] = b"free2z/kt/v1/assertion-digest";

/// Every label this crate defines, so a test can hold the set prefix-free.
pub const LABELS: [&[u8]; 5] = [
    LABEL_ASSERTION_TBS,
    LABEL_ASSERTION_BINDING_TBS,
    LABEL_AUTHORITY_ID,
    LABEL_HANDLE_ID,
    LABEL_ASSERTION_DIGEST,
];

/// The labels `KT.md` v1 already spends, restated here **only** so the
/// prefix-free test can range over both sets.
///
/// This is not a second source of truth for them and nothing in this crate
/// reads it: the log's own crate owns those structures. It is here because the
/// property that matters — no label is a prefix of another — is a property of
/// every label in the `free2z/kt/v1/` namespace at once, and a test that only
/// sees half of them proves half of it.
pub const KT_LABELS: [&[u8]; 7] = [
    b"free2z/kt/v1/entry",
    b"free2z/kt/v1/rotation",
    b"free2z/kt/v1/reset",
    b"free2z/kt/v1/receipt",
    b"free2z/kt/v1/prev",
    b"free2z/kt/v1/value",
    b"free2z/kt/v1/handle:",
];

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;

    #[test]
    fn no_label_is_a_prefix_of_another_anywhere_in_the_namespace() {
        let all: Vec<&[u8]> = LABELS.iter().chain(KT_LABELS.iter()).copied().collect();
        for (i, a) in all.iter().enumerate() {
            for (j, b) in all.iter().enumerate() {
                if i == j {
                    continue;
                }
                assert!(
                    !b.starts_with(a),
                    "label {:?} is a prefix of {:?}",
                    core::str::from_utf8(a),
                    core::str::from_utf8(b)
                );
            }
        }
    }

    #[test]
    fn every_label_is_in_the_kt_v1_namespace() {
        for label in LABELS {
            assert!(
                label.starts_with(b"free2z/kt/v1/"),
                "{:?} is outside the namespace",
                core::str::from_utf8(label)
            );
        }
    }
}
