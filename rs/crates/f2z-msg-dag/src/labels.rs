//! The one domain-separation label this crate mints.
//!
//! `ARCHITECTURE.md` §7:
//!
//! ```text
//! msg_id = BLAKE2b-256("free2z/msg/v1/msgid" || canonical(rest))
//! ```
//!
//! That is `WIRE.md` §1.3's `H(label, x)` construction — label bytes, then the
//! message, **no separator and no terminator** — so the same rule applies to
//! this label as to every other one in the tree: the *set* of labels must be
//! prefix-free, because without a separator a label that is a proper prefix of
//! another is a cross-domain collision waiting for an attacker-chosen message.
//!
//! Prefix-freeness is a property of the union, not of any one crate's array.
//! `scripts/check-hash-domain-labels.mjs` holds this label against every other
//! `free2z/` label in every tracked file — `f2z-msg-identity`'s four
//! `free2z/msg/v1/…` leaves included, which is the set this one is most likely
//! to collide with. The test below is the cheap local half and is deliberately
//! not the load-bearing one; [zuu#602] is what happens when a check covers a
//! subset of the namespace.
//!
//! [zuu#602]: https://github.com/free2z/zuu/issues/602

/// `msg_id = BLAKE2b-256("free2z/msg/v1/msgid" || canonical(rest))`
/// (`ARCHITECTURE.md` §7).
///
/// `rest` is every field of the message **except** `msg_id` itself — see
/// [`crate::message::AppMessageTbs`], which is exactly that set and nothing
/// else, so "the rest" is a type rather than a convention somebody has to
/// remember to apply.
pub const LABEL_MSG_ID: &[u8] = b"free2z/msg/v1/msgid";

/// Every label this crate defines.
///
/// One entry, and it stays a closed array anyway: a second construction added
/// under an unregistered label is a domain nobody checked, and the array is
/// what the repository-wide script and the test below both range over.
pub const LABELS: [&[u8]; 1] = [LABEL_MSG_ID];

#[cfg(test)]
mod tests {
    use super::*;

    /// The four `free2z/msg/v1/…` labels `f2z-msg-identity` mints.
    ///
    /// Restated here rather than imported, deliberately: this crate does not
    /// depend on `f2z-msg-identity` and must not gain a dependency on it just
    /// to run a test. The restatement can rot, which is exactly why it is not
    /// the load-bearing check — `scripts/check-hash-domain-labels.mjs` reads
    /// the real constants out of the tracked tree and is what CI gates on.
    const NEIGHBOURING_LABELS: [&[u8]; 4] = [
        b"free2z/msg/v1/identity-sig",
        b"free2z/msg/v1/ceremony-sig",
        b"free2z/msg/v1/directory-auth",
        b"free2z/msg/v1/backup-wrap",
    ];

    #[test]
    fn the_label_is_prefix_free_against_its_namespace_neighbours() {
        for ours in LABELS {
            assert!(ours.is_ascii(), "a label must be exact ASCII bytes");
            assert!(
                ours.starts_with(b"free2z/msg/v1/"),
                "an unversioned label cannot be rotated"
            );
            for theirs in NEIGHBOURING_LABELS {
                assert_ne!(ours, theirs);
                assert!(!theirs.starts_with(ours), "{ours:?} is a prefix of another");
                assert!(!ours.starts_with(theirs), "another label is a prefix of us");
            }
        }
    }
}
