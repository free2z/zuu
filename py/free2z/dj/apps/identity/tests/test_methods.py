"""The LoginMethod registry and the last-sign-in-method guard.

Real Postgres, no mocks. Every "usable" assertion has a paired "not usable"
assertion for the same kind. A guard that answered True for everything, or
an adapter that ignored its own rule, would fail one side of each pair.
"""
import pytest
from django.db.models import F

from dj.apps.g12f.models import Creator
from dj.apps.identity import methods
from dj.apps.identity.methods import (
    LoginMethod,
    can_remove,
    list_methods,
    method_of,
    registered_kinds,
    signin_survives,
    usable_signin_methods,
)
from dj.apps.social.models import SocialIdentity
from dj.apps.twitter.models import TwitterProfile
from dj.apps.zauth.models import ZcashIdentity

pytestmark = pytest.mark.django_db

ZADDR = "t1VpYecBW4UudbGcy4ufh61eWxQCoFaUrPs"


@pytest.fixture(autouse=True)
def providers_configured(settings):
    """Google and X (both the social and the legacy flow) have credentials.
    GitHub is left unconfigured on purpose.
    """
    settings.GOOGLE_CLIENT_ID = "test-google-id"
    settings.GOOGLE_CLIENT_SECRET = "test-google-secret"
    settings.GITHUB_CLIENT_ID = ""
    settings.GITHUB_CLIENT_SECRET = ""
    settings.TWITTER_CLIENT_ID = "test-x-id"
    settings.TWITTER_CLIENT_SECRET = "test-x-secret"
    return settings


def _fresh(user):
    return Creator.objects.get(pk=user.pk)


def _passwordless(creator_factory):
    user = creator_factory()
    user.set_unusable_password()
    user.save()
    return _fresh(user)


def _advance_epoch(user):
    """An ownership event, reduced to its counter (setup only)."""
    Creator.objects.filter(pk=user.pk).update(
        kt_account_epoch=F("kt_account_epoch") + 1,
    )
    return _fresh(user)


def _social(user, provider="google", uid="g-1", epoch=None):
    return SocialIdentity.objects.create(
        creator=user, provider=provider, provider_uid=uid, handle=f"{uid}@x",
        linked_at_epoch=user.kt_account_epoch if epoch is None else epoch,
    )


def _zcash(user, epoch=None):
    return ZcashIdentity.objects.create(
        creator=user, zcash_address=ZADDR,
        linked_at_epoch=user.kt_account_epoch if epoch is None else epoch,
    )


def _twitter(user, allow_login=True, epoch=None):
    return TwitterProfile.objects.create(
        creator=user, twitter_id="4242", username="tw4242",
        allow_login=allow_login,
        linked_at_epoch=user.kt_account_epoch if epoch is None else epoch,
    )


def _keys(ms):
    return sorted((m.kind, m.pk) for m in ms)


# --------------------------------------------------------------------------- #
# Registry
# --------------------------------------------------------------------------- #
def test_registry_covers_every_current_method_kind_in_order():
    assert registered_kinds() == (
        "password", "social", "zcash", "twitter", "passkey",
    )


def test_registering_a_duplicate_kind_is_refused():
    with pytest.raises(ValueError):
        methods.register(methods.PasswordAdapter())
    assert registered_kinds() == (
        "password", "social", "zcash", "twitter", "passkey",
    )


def test_method_of_wraps_each_identity_model(creator_factory):
    user = _fresh(creator_factory())
    s, z, t = _social(user), _zcash(user), _twitter(user)
    assert method_of(s) == LoginMethod("social", s.pk, "google", "g-1@x")
    assert method_of(z) == LoginMethod("zcash", z.pk, "zcash", ZADDR)
    assert method_of(t) == LoginMethod("twitter", t.pk, "x", "tw4242")
    with pytest.raises(TypeError):
        method_of(user)


# --------------------------------------------------------------------------- #
# list_methods / usable_signin_methods, one kind at a time
# --------------------------------------------------------------------------- #
def test_password_is_a_method_only_while_usable(creator_factory):
    user = _fresh(creator_factory())
    assert _keys(list_methods(user)) == [("password", None)]
    assert _keys(usable_signin_methods(user)) == [("password", None)]

    user = _passwordless(creator_factory)
    assert list_methods(user) == []
    assert usable_signin_methods(user) == []


def test_social_identity_is_usable_at_the_current_epoch_only(creator_factory):
    user = _fresh(creator_factory())
    s = _social(user)
    assert ("social", s.pk) in _keys(list_methods(user))
    assert ("social", s.pk) in _keys(usable_signin_methods(user))

    # Negative: after an ownership event a password account's identity is
    # stale. It is still listed (it can be re-linked), but it cannot sign in.
    user = _advance_epoch(user)
    assert ("social", s.pk) in _keys(list_methods(user))
    assert ("social", s.pk) not in _keys(usable_signin_methods(user))


def test_social_identity_is_unusable_while_its_provider_is_unconfigured(
    creator_factory, providers_configured,
):
    """The login view answers 503 for an unconfigured provider, so its
    identity cannot sign in, however current its epoch.
    """
    user = _passwordless(creator_factory)
    google = _social(user, provider="google", uid="g-1")
    github = _social(user, provider="github", uid="gh-1")
    assert ("social", github.pk) in _keys(list_methods(user))
    assert _keys(usable_signin_methods(user)) == [("social", google.pk)]
    # With only the unconfigured GitHub identity left, Google is the last
    # way in.
    assert can_remove(user, method_of(google)) is False

    providers_configured.GITHUB_CLIENT_ID = "test-github-id"
    providers_configured.GITHUB_CLIENT_SECRET = "test-github-secret"
    assert ("social", github.pk) in _keys(usable_signin_methods(user))
    assert can_remove(user, method_of(google)) is True


def test_zcash_identity_is_usable_at_the_current_epoch_only(creator_factory):
    user = _fresh(creator_factory())
    z = _zcash(user)
    assert ("zcash", z.pk) in _keys(usable_signin_methods(user))

    user = _advance_epoch(user)
    assert ("zcash", z.pk) in _keys(list_methods(user))
    assert ("zcash", z.pk) not in _keys(usable_signin_methods(user))


def test_twitter_profile_is_usable_only_with_allow_login(creator_factory):
    user = _fresh(creator_factory())
    t = _twitter(user, allow_login=True)
    assert ("twitter", t.pk) in _keys(usable_signin_methods(user))

    TwitterProfile.objects.filter(pk=t.pk).update(allow_login=False)
    assert ("twitter", t.pk) in _keys(list_methods(user))
    assert ("twitter", t.pk) not in _keys(usable_signin_methods(user))


def test_twitter_profile_is_unusable_while_legacy_login_is_unconfigured(
    creator_factory, providers_configured,
):
    user = _passwordless(creator_factory)
    s = _social(user)
    t = _twitter(user, allow_login=True)
    assert can_remove(user, method_of(s)) is True

    # The legacy authorize view 503s without a client id, so the profile
    # cannot sign in and Google becomes the last way in.
    providers_configured.TWITTER_CLIENT_ID = "  "
    assert ("twitter", t.pk) in _keys(list_methods(user))
    assert ("twitter", t.pk) not in _keys(usable_signin_methods(user))
    assert can_remove(user, method_of(s)) is False

    # The callback's token exchange needs the secret too. A client id alone
    # starts the flow and then fails at X.
    providers_configured.TWITTER_CLIENT_ID = "test-x-id"
    assert can_remove(user, method_of(s)) is True
    providers_configured.TWITTER_CLIENT_SECRET = ""
    assert ("twitter", t.pk) not in _keys(usable_signin_methods(user))
    assert can_remove(user, method_of(s)) is False


def test_twitter_profile_is_usable_at_the_current_epoch_only(creator_factory):
    user = _fresh(creator_factory())
    t = _twitter(user, allow_login=True)
    user = _advance_epoch(user)
    assert ("twitter", t.pk) not in _keys(usable_signin_methods(user))


def test_methods_of_other_accounts_are_never_listed(creator_factory):
    user = _fresh(creator_factory())
    other = _fresh(creator_factory())
    _social(other)
    _zcash(other)
    _twitter(other)
    assert _keys(list_methods(user)) == [("password", None)]


# --------------------------------------------------------------------------- #
# can_remove: the last-method guard
# --------------------------------------------------------------------------- #
def test_the_only_method_cannot_be_removed(creator_factory):
    user = _passwordless(creator_factory)
    for make in (_social, _zcash, _twitter):
        identity = make(user)
        assert can_remove(user, method_of(identity)) is False
        identity.delete()


def test_a_password_keeps_every_identity_removable(creator_factory):
    user = _fresh(creator_factory())
    for make in (_social, _zcash, _twitter):
        identity = make(user)
        assert can_remove(user, method_of(identity)) is True
        identity.delete()


@pytest.mark.parametrize("pair", [
    (_social, _zcash), (_social, _twitter), (_zcash, _twitter),
])
def test_either_of_two_usable_identities_can_be_removed(creator_factory, pair):
    user = _passwordless(creator_factory)
    a, b = pair[0](user), pair[1](user)
    assert can_remove(user, method_of(a)) is True
    assert can_remove(user, method_of(b)) is True


def test_a_disabled_twitter_login_is_not_a_survivor(creator_factory):
    user = _passwordless(creator_factory)
    s = _social(user)
    _twitter(user, allow_login=False)
    assert can_remove(user, method_of(s)) is False


def test_the_guard_reads_the_password_from_the_database(creator_factory):
    """``can_remove`` re-reads the account under its lock and does not trust
    the caller's copy. Here the caller's copy is stale and still has a
    password.
    """
    user = _fresh(creator_factory())
    s = _social(user)
    stale_copy = _fresh(user)
    user.set_unusable_password()
    user.save()
    assert stale_copy.has_usable_password()
    assert can_remove(stale_copy, method_of(s)) is False


def test_signin_survives_reads_the_committed_state(creator_factory):
    user = _passwordless(creator_factory)
    s = _social(user)
    assert signin_survives(user) is True
    s.delete()
    assert signin_survives(user) is False

    user.set_password("pw")
    user.save()
    stale_copy = Creator.objects.get(pk=user.pk)
    user.set_unusable_password()
    user.save()
    # The caller's copy still has a password; the database does not.
    assert stale_copy.has_usable_password()
    assert signin_survives(stale_copy) is False


def test_a_stale_identity_is_removable_only_while_something_else_works(
    creator_factory,
):
    user = _fresh(creator_factory())
    s = _social(user, epoch=user.kt_account_epoch)
    user = _advance_epoch(user)
    # The password still works, so removing the stale identity is fine.
    assert can_remove(user, method_of(s)) is True

    # No password, and the stale row is the only thing left. On main it is
    # the passwordless fallback and is therefore usable. Either way, removing
    # it would leave nothing.
    user.set_unusable_password()
    user.save()
    assert can_remove(_fresh(user), method_of(s)) is False
