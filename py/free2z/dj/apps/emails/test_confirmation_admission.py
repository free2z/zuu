"""Atomic confirmation-mail quota mechanics."""

import pytest
from django.core.cache import cache

from dj.apps.emails import confirmation_limits
from dj.apps.emails.confirmation_limits import (
    ALLOWED,
    RECIPIENT_LIMITED,
    USER_LIMITED,
    claim_confirmation_account_attempt,
    claim_confirmation_recipient,
)


@pytest.fixture(autouse=True)
def _clear_confirmation_limit_cache():
    cache.clear()
    yield
    cache.clear()


def test_recipient_ceiling_is_shared_across_accounts_and_casefolded():
    for user_id in (1, 2, 3):
        assert claim_confirmation_account_attempt(user_id) == ALLOWED
        assert claim_confirmation_recipient("Mailbox@example.com") == ALLOWED

    # Recipient suppression still spends the account's attempt slot.
    assert claim_confirmation_account_attempt(4) == ALLOWED
    assert claim_confirmation_recipient("mailbox@EXAMPLE.COM") == RECIPIENT_LIMITED

    assert claim_confirmation_account_attempt(4) == ALLOWED
    assert claim_confirmation_recipient("different@example.com") == ALLOWED


def test_gmail_aliases_share_recipient_ceiling_but_other_provider_aliases_do_not():
    for _ in range(3):
        assert claim_confirmation_recipient("First.Last+tag@gmail.com") == ALLOWED
    assert claim_confirmation_recipient("firstlast@googlemail.com") == RECIPIENT_LIMITED

    # Plus tags are meaningful for many other providers; do not merge them.
    assert claim_confirmation_recipient("first+tag@example.net") == ALLOWED
    assert claim_confirmation_recipient("first@example.net") == ALLOWED


def test_account_ceiling_applies_across_distinct_recipients():
    for _ in range(10):
        assert claim_confirmation_account_attempt(55) == ALLOWED

    assert claim_confirmation_account_attempt(55) == USER_LIMITED


def test_ambiguous_redis_claim_fails_closed_without_retry(mocker):
    class _Client:
        def eval(self, *args):
            raise TimeoutError("reply lost after possible execution")

    class _RedisCache:
        client = mocker.Mock()
        client.get_client.return_value = _Client()

        @staticmethod
        def make_key(key):
            return key

    mocker.patch.object(
        confirmation_limits, "_admission_cache", return_value=_RedisCache()
    )
    with pytest.raises(confirmation_limits.ConfirmationMailAdmissionUnavailable):
        claim_confirmation_account_attempt(7)
