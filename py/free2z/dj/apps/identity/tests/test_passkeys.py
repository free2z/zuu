"""Passkeys as a sign-in method: the model and its registry adapter.

Real Postgres, no mocks. As in ``test_methods.py``, every "usable" assertion
is paired with a "not usable" one for the same rule, so an adapter that
answered True for everything, or ignored one of its conditions, fails.
"""
import pytest
from django.db import IntegrityError, transaction
from django.db.models import F
from webauthn.helpers.structs import (
    AttestationFormat,
    AuthenticatorTransport,
    CredentialDeviceType,
    PublicKeyCredentialType,
)
from webauthn.registration.verify_registration_response import VerifiedRegistration

from dj.apps.g12f.models import Creator
from dj.apps.identity.methods import (
    LoginMethod,
    can_remove,
    list_methods,
    method_of,
    signin_survives,
    usable_signin_methods,
)
from dj.apps.identity.models import RecoveryCode, WebAuthnCredential
from dj.apps.social.models import SocialIdentity

pytestmark = pytest.mark.django_db

RP_ID = "free2z.cash"


@pytest.fixture(autouse=True)
def passkeys_enabled(settings):
    settings.IDENTITY_PASSKEY_SIGNIN_ENABLED = True
    settings.WEBAUTHN_RP_ID = RP_ID
    settings.GOOGLE_CLIENT_ID = "test-google-id"
    settings.GOOGLE_CLIENT_SECRET = "test-google-secret"
    return settings


def _fresh(user):
    return Creator.objects.get(pk=user.pk)


def _passwordless(creator_factory):
    user = creator_factory()
    user.set_unusable_password()
    user.save()
    return _fresh(user)


def _advance_epoch(user):
    Creator.objects.filter(pk=user.pk).update(
        kt_account_epoch=F("kt_account_epoch") + 1,
    )
    return _fresh(user)


_counter = iter(range(1, 10**6))


def _passkey(user, *, epoch=None, rp_id=RP_ID, name="Laptop"):
    n = next(_counter)
    return WebAuthnCredential.objects.create(
        creator=user,
        credential_id=n.to_bytes(4, "big") * 8,
        public_key=b"\xa5\x01\x02",
        rp_id=rp_id,
        name=name,
        linked_at_epoch=user.kt_account_epoch if epoch is None else epoch,
    )


def _social(user):
    return SocialIdentity.objects.create(
        creator=user, provider="google", provider_uid=f"g-{user.pk}",
        handle="g@x", linked_at_epoch=user.kt_account_epoch,
    )


def _keys(ms):
    return sorted((m.kind, m.pk) for m in ms)


# --------------------------------------------------------------------------- #
# The model
# --------------------------------------------------------------------------- #
def test_method_of_wraps_a_passkey(creator_factory):
    user = _fresh(creator_factory())
    pk = _passkey(user, name="")
    assert method_of(pk) == LoginMethod("passkey", pk.pk, "passkey", "Passkey")


def test_a_recovery_code_is_not_a_sign_in_method(creator_factory):
    user = _fresh(creator_factory())
    code = RecoveryCode.objects.create(
        creator=user, digest="0" * 64, issued_at_epoch=1,
    )
    with pytest.raises(TypeError, match="not a sign-in method"):
        method_of(code)
    assert _keys(list_methods(user)) == [("password", None)]


def test_a_credential_id_belongs_to_one_account_only(creator_factory):
    a, b = _fresh(creator_factory()), _fresh(creator_factory())
    WebAuthnCredential.objects.create(
        creator=a, credential_id=b"x" * 16, public_key=b"k", rp_id=RP_ID,
        linked_at_epoch=1,
    )
    with pytest.raises(IntegrityError), transaction.atomic():
        WebAuthnCredential.objects.create(
            creator=b, credential_id=b"x" * 16, public_key=b"k", rp_id=RP_ID,
            linked_at_epoch=1,
        )


@pytest.mark.parametrize("length,ok", [(15, False), (16, True), (1023, True), (1024, False)])
def test_the_database_bounds_the_credential_id_length(creator_factory, length, ok):
    user = _fresh(creator_factory())

    def create():
        with transaction.atomic():
            WebAuthnCredential.objects.create(
                creator=user, credential_id=b"\x01" * length, public_key=b"k",
                rp_id=RP_ID, linked_at_epoch=1,
            )

    if ok:
        create()
    else:
        with pytest.raises(IntegrityError):
            create()


def test_from_verified_registration_maps_webauthns_result(creator_factory):
    user = _fresh(creator_factory())
    verification = VerifiedRegistration(
        credential_id=b"\x07" * 32,
        credential_public_key=b"\xa5cose",
        sign_count=3,
        aaguid="adce0002-35bc-c60a-648b-0b25f1f05503",
        fmt=AttestationFormat.NONE,
        credential_type=PublicKeyCredentialType.PUBLIC_KEY,
        user_verified=True,
        attestation_object=b"",
        credential_device_type=CredentialDeviceType.MULTI_DEVICE,
        credential_backed_up=True,
    )
    cred = WebAuthnCredential.from_verified_registration(
        user, verification, rp_id=RP_ID, linked_at_epoch=user.kt_account_epoch,
        name="Phone",
        transports=[AuthenticatorTransport.INTERNAL, AuthenticatorTransport.HYBRID],
    )
    cred.save()
    cred = WebAuthnCredential.objects.get(pk=cred.pk)
    assert bytes(cred.credential_id) == b"\x07" * 32
    assert bytes(cred.public_key) == b"\xa5cose"
    assert cred.sign_count == 3
    assert str(cred.aaguid) == "adce0002-35bc-c60a-648b-0b25f1f05503"
    assert cred.transports == ["internal", "hybrid"]
    assert cred.user_verified is True
    assert cred.backup_eligible is True
    assert cred.backed_up is True
    assert cred.linked_at_epoch == user.kt_account_epoch

    # "none" attestation reports an all-zero AAGUID; that is "unknown".
    zero = WebAuthnCredential.from_verified_registration(
        user,
        VerifiedRegistration(
            credential_id=b"\x08" * 32, credential_public_key=b"k", sign_count=0,
            aaguid="00000000-0000-0000-0000-000000000000",
            fmt=AttestationFormat.NONE,
            credential_type=PublicKeyCredentialType.PUBLIC_KEY,
            user_verified=False, attestation_object=b"",
            credential_device_type=CredentialDeviceType.SINGLE_DEVICE,
            credential_backed_up=False,
        ),
        rp_id=RP_ID, linked_at_epoch=1,
    )
    assert zero.aaguid is None
    assert zero.backup_eligible is False


def test_record_use_requires_the_counter_to_advance(creator_factory):
    user = _fresh(creator_factory())
    cred = _passkey(user)
    WebAuthnCredential.objects.filter(pk=cred.pk).update(sign_count=5)
    cred.refresh_from_db()

    assert cred.record_use(6) is True
    assert WebAuthnCredential.objects.get(pk=cred.pk).sign_count == 6
    assert cred.last_used_at is not None

    # A counter that did not move (a replayed or cloned authenticator) is
    # refused and writes nothing.
    assert cred.record_use(6) is False
    assert cred.record_use(2) is False
    assert cred.record_use(0) is False
    assert WebAuthnCredential.objects.get(pk=cred.pk).sign_count == 6


def test_record_use_accepts_an_authenticator_without_a_counter(creator_factory):
    user = _fresh(creator_factory())
    cred = _passkey(user)
    assert cred.sign_count == 0
    assert cred.record_use(0) is True
    assert cred.record_use(0) is True
    # Once a counter has been seen, falling back to 0 is a regression.
    assert cred.record_use(1) is True
    assert cred.record_use(0) is False


def test_a_stale_instance_cannot_rewind_the_counter(creator_factory):
    """The check is in the UPDATE, not in the caller's copy of the row."""
    user = _fresh(creator_factory())
    cred = _passkey(user)
    stale = WebAuthnCredential.objects.get(pk=cred.pk)
    assert cred.record_use(10) is True
    assert stale.sign_count == 0
    assert stale.record_use(4) is False
    assert WebAuthnCredential.objects.get(pk=cred.pk).sign_count == 10


def test_deleting_the_account_deletes_its_passkeys(creator_factory):
    user = _fresh(creator_factory())
    cred = _passkey(user)
    user.delete()
    assert not WebAuthnCredential.objects.filter(pk=cred.pk).exists()


# --------------------------------------------------------------------------- #
# Usable: what it means for a passkey
# --------------------------------------------------------------------------- #
def test_a_current_passkey_is_usable(creator_factory):
    user = _passwordless(creator_factory)
    cred = _passkey(user)
    assert _keys(usable_signin_methods(user)) == [("passkey", cred.pk)]


def test_a_passkey_is_not_usable_while_passkey_sign_in_is_off(
    creator_factory, passkeys_enabled,
):
    """The table ships before the route. Until the route exists, a passkey
    is listed (the owner can see and remove it) but is not a way in.
    """
    user = _passwordless(creator_factory)
    cred = _passkey(user)
    passkeys_enabled.IDENTITY_PASSKEY_SIGNIN_ENABLED = False
    assert _keys(list_methods(user)) == [("passkey", cred.pk)]
    assert usable_signin_methods(user) == []

    # A truthy non-boolean is not "on": the flag is a literal in settings.
    passkeys_enabled.IDENTITY_PASSKEY_SIGNIN_ENABLED = "false"
    assert usable_signin_methods(user) == []


def test_the_shipped_default_leaves_passkey_sign_in_off():
    from dj.free2z import settings as project_settings

    assert project_settings.IDENTITY_PASSKEY_SIGNIN_ENABLED is False


def test_a_passkey_for_another_rp_id_is_not_usable(creator_factory, passkeys_enabled):
    user = _passwordless(creator_factory)
    old = _passkey(user, rp_id="free2z.com")
    assert ("passkey", old.pk) in _keys(list_methods(user))
    assert usable_signin_methods(user) == []

    new = _passkey(user, rp_id="free2z.cash")
    assert _keys(usable_signin_methods(user)) == [("passkey", new.pk)]

    # Case is not identity for an RP id.
    passkeys_enabled.WEBAUTHN_RP_ID = "Free2Z.cash"
    assert _keys(usable_signin_methods(user)) == [("passkey", new.pk)]

    passkeys_enabled.WEBAUTHN_RP_ID = ""
    assert usable_signin_methods(user) == []


def test_a_passkey_linked_before_an_ownership_event_is_stale(creator_factory):
    """Same rule as a social identity: after a password reset, a passkey
    added earlier (possibly by whoever held the account) stops signing in.
    """
    user = _fresh(creator_factory())
    cred = _passkey(user)
    assert ("passkey", cred.pk) in _keys(usable_signin_methods(user))

    user = _advance_epoch(user)
    assert ("passkey", cred.pk) in _keys(list_methods(user))
    assert ("passkey", cred.pk) not in _keys(usable_signin_methods(user))


def test_a_passwordless_accounts_stale_passkey_still_signs_in(creator_factory):
    """The passwordless exemption of ``identity_can_authenticate`` applies:
    refusing it would leave the account with no way in.
    """
    user = _passwordless(creator_factory)
    cred = _passkey(user)
    user = _advance_epoch(user)
    assert _keys(usable_signin_methods(user)) == [("passkey", cred.pk)]


def test_passkeys_of_other_accounts_are_never_listed(creator_factory):
    user = _fresh(creator_factory())
    _passkey(_fresh(creator_factory()))
    assert _keys(list_methods(user)) == [("password", None)]


# --------------------------------------------------------------------------- #
# The last-method guard, with passkeys in the set
# --------------------------------------------------------------------------- #
def test_the_only_passkey_cannot_be_removed(creator_factory):
    user = _passwordless(creator_factory)
    cred = _passkey(user)
    assert can_remove(user, method_of(cred)) is False


def test_a_passkey_is_a_survivor_for_unlinking_a_social_identity(
    creator_factory, passkeys_enabled,
):
    user = _passwordless(creator_factory)
    social = _social(user)
    cred = _passkey(user)
    assert can_remove(user, method_of(social)) is True
    assert can_remove(user, method_of(cred)) is True

    # Negative: with passkey sign-in off, the passkey is not a way in, so
    # the social identity is the last one.
    passkeys_enabled.IDENTITY_PASSKEY_SIGNIN_ENABLED = False
    assert can_remove(user, method_of(social)) is False


def test_a_passkey_for_another_rp_id_is_not_a_survivor(creator_factory):
    user = _passwordless(creator_factory)
    social = _social(user)
    _passkey(user, rp_id="free2z.com")
    assert can_remove(user, method_of(social)) is False


def test_two_passkeys_keep_each_other_removable(creator_factory):
    user = _passwordless(creator_factory)
    a, b = _passkey(user), _passkey(user, name="Phone")
    assert can_remove(user, method_of(a)) is True
    assert can_remove(user, method_of(b)) is True


def test_a_password_keeps_a_passkey_removable(creator_factory):
    user = _fresh(creator_factory())
    cred = _passkey(user)
    assert can_remove(user, method_of(cred)) is True


def test_signin_survives_counts_a_passkey(creator_factory, passkeys_enabled):
    user = _passwordless(creator_factory)
    social = _social(user)
    _passkey(user)
    with transaction.atomic():
        social.delete()
        assert signin_survives(user) is True

    passkeys_enabled.IDENTITY_PASSKEY_SIGNIN_ENABLED = False
    assert signin_survives(user) is False
