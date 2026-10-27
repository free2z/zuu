"""The pure eligibility rule, against the ZUULI client's.

``tauri-plugin-f2zmsg/src/handle.rs::eligibility`` is what the wallet shows a
user before it asks the server. If the two disagree, the wallet promises a
handle the server will not reserve (or hides one it would), so the reason
strings and their precedence are pinned here case by case.
"""

import pytest

from dj.apps.handles import policy


@pytest.mark.parametrize(
    ("username", "candidate", "reason"),
    [
        ("alice", "alice", None),
        ("Alice_2", "alice_2", None),
        ("a" * 30, "a" * 30, None),
        ("A" * 30, "a" * 30, None),
        ("", None, "punctuation"),
        ("has.dot", None, "punctuation"),
        ("has-dash", None, "punctuation"),
        ("user@example.com", None, "punctuation"),
        ("a" * 31, None, "too-long"),
        # handle.rs reports punctuation before length.
        ("a." + "a" * 40, None, "punctuation"),
        ("ünicode", None, "non-ascii"),
        ("ＡＬＩＣＥ", None, "non-ascii"),
        # U+212A KELVIN SIGN lowercases to ASCII "k" under str.lower.
        ("K", None, "non-ascii"),
        ("trailing\n", None, "punctuation"),
    ],
)
def test_eligibility_matches_the_client_rule(username, candidate, reason):
    assert policy.eligibility(username) == (candidate, reason)


@pytest.mark.parametrize(
    "value",
    ["alice", "a", "a" * 30, "0_9"],
)
def test_is_handle_accepts_exact_handles(value):
    assert policy.is_handle(value)


@pytest.mark.parametrize(
    "value",
    ["", "Alice", "a" * 31, "a.b", "alice\n", " alice", "K", "ａ", None, 7],
)
def test_is_handle_never_folds_or_trims(value):
    assert not policy.is_handle(value)


def test_reserved_words_are_well_formed_handles():
    """A reserved word that is not a valid handle protects nothing."""
    assert all(policy.is_handle(word) for word in policy.RESERVED_HANDLES)


def test_a_reserved_username_is_never_auto_reserved():
    assert policy.auto_reservable("Support") is None
    assert policy.auto_reservable("supporter") == "supporter"
