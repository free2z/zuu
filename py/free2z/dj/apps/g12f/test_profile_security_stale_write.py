"""Regression coverage for Creator profile stale-write security."""

from datetime import timedelta
from decimal import Decimal
from pathlib import Path
import threading

import pytest
import yaml
from django.conf import settings
from django.contrib.auth.hashers import make_password
from django.core.cache import cache
from django.db import connection
from django.db.models.query import QuerySet
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.emails import views as email_views
from dj.apps.emails.models import Email, PasswordResetToken
from dj.apps.emails.views import (
    _release_reset_email_quota,
    _spend_reset_email_quota,
    send_password_reset_email,
)
from dj.apps.g12f.models import Creator, Subscription
from dj.apps.g12f.serializers.creator import CreatorProfileUpdateSerializer
from dj.apps.twitter.models import TwitterProfile


SECURITY_CASES = (
    ("is_staff", True, False),
    ("is_superuser", True, False),
    ("is_active", True, False),
    ("strikes", 1, 2),
    ("password_set", True, False),
    (
        "last_login",
        timezone.now() - timedelta(days=2),
        timezone.now() - timedelta(days=1),
    ),
)


@pytest.mark.django_db
@pytest.mark.parametrize(("field", "loaded_value", "security_value"), SECURITY_CASES)
def test_profile_patch_cannot_restore_stale_security_state(
    creator_factory,
    field,
    loaded_value,
    security_value,
):
    """A self-service PATCH writes profile fields, never auth-owned columns."""
    user = creator_factory(**{field: loaded_value})
    request_user = Creator.objects.get(pk=user.pk)

    # The security decision commits after authentication loaded request.user.
    Creator.objects.filter(pk=user.pk).update(**{field: security_value})

    client = APIClient()
    client.force_authenticate(user=request_user)
    response = client.patch(
        "/api/auth/user/",
        {"full_name": "Safe Profile Edit"},
        format="json",
    )

    assert response.status_code == 200, response.content
    row = Creator.objects.get(pk=user.pk)
    assert getattr(row, field) == security_value
    assert row.full_name == "Safe Profile Edit"
    assert response.json()["full_name"] == "Safe Profile Edit"

    # The serializer refreshes the same object DRF and the rest of the request
    # use, so preserving the database decision does not leave stale privileges
    # or moderation state in memory.
    assert getattr(request_user, field) == security_value


@pytest.mark.django_db
def test_profile_patch_cannot_restore_a_stale_password(creator_factory):
    user = creator_factory(password="old-password")
    request_user = Creator.objects.get(pk=user.pk)

    reset_hash = make_password("reset-password")
    Creator.objects.filter(pk=user.pk).update(password=reset_hash)

    client = APIClient()
    client.force_authenticate(user=request_user)
    response = client.patch(
        "/api/auth/user/",
        {"description": "Edited while resetting"},
        format="json",
    )

    assert response.status_code == 200, response.content
    row = Creator.objects.get(pk=user.pk)
    assert row.check_password("reset-password")
    assert not row.check_password("old-password")
    assert row.description == "Edited while resetting"
    assert request_user.check_password("reset-password")


@pytest.mark.django_db
def test_profile_put_cannot_restore_stale_security_state(creator_factory):
    """PUT uses the same narrowly owned write path as PATCH."""
    user = creator_factory(is_staff=True)
    request_user = Creator.objects.get(pk=user.pk)
    Creator.objects.filter(pk=user.pk).update(is_staff=False)

    client = APIClient()
    client.force_authenticate(user=request_user)
    response = client.put(
        "/api/auth/user/",
        {
            "username": user.username,
            "full_name": "Complete Profile Edit",
        },
        format="json",
    )

    assert response.status_code == 200, response.content
    row = Creator.objects.get(pk=user.pk)
    assert row.is_staff is False
    assert row.full_name == "Complete Profile Edit"
    assert request_user.is_staff is False


@pytest.mark.django_db
def test_profile_patch_returns_authoritative_server_owned_state(creator_factory):
    user = creator_factory(
        tuzis=Decimal("100"),
        total=Decimal("1"),
        is_verified=False,
    )
    request_user = Creator.objects.get(pk=user.pk)

    Creator.objects.filter(pk=user.pk).update(
        tuzis=Decimal("60"),
        total=Decimal("2"),
        is_verified=True,
    )

    client = APIClient()
    client.force_authenticate(user=request_user)
    response = client.patch(
        "/api/auth/user/",
        {"first_name": "Current"},
        format="json",
    )

    assert response.status_code == 200, response.content
    assert response.json()["first_name"] == "Current"
    assert Decimal(response.json()["tuzis"]) == Decimal("60")
    assert Decimal(response.json()["total"]) == Decimal("2")
    assert response.json()["is_verified"] is True

    row = Creator.objects.get(pk=user.pk)
    assert row.first_name == "Current"
    assert row.tuzis == Decimal("60")
    assert row.total == Decimal("2")
    assert row.is_verified is True


@pytest.mark.django_db
def test_profile_relationship_shapes_match_the_openapi_contract(creator_factory):
    user = creator_factory()
    star = creator_factory(username="profile-star")
    fan = creator_factory(username="profile-fan")
    expires = timezone.now() + timedelta(days=1)
    Subscription.objects.create(star=star, fan=user, expires=expires)
    Subscription.objects.create(star=user, fan=fan, expires=expires)
    TwitterProfile.objects.create(
        creator=user,
        twitter_id="12345",
        username="profile_twitter",
        name="Profile Twitter",
    )

    client = APIClient()
    client.force_authenticate(user=user)
    response = client.get("/api/auth/user/")

    assert response.status_code == 200, response.content
    assert response.json()["stars"] == ["profile-star"]
    assert response.json()["fans_count"] == 1
    assert "fans" not in response.json()
    assert response.json()["twitter"] == {
        "id": "12345",
        "name": "Profile Twitter",
        "username": "profile_twitter",
    }
    assert response.json()["avatar_image"] is None
    assert response.json()["banner_image"] is None

    spec_path = Path(settings.BASE_DIR) / "openapi/f2z.yaml"
    schemas = yaml.safe_load(spec_path.read_text())["components"]["schemas"]
    for component in ("CreatorProfileDetail", "CreatorProfileUpdate"):
        properties = schemas[component]["properties"]
        assert properties["stars"] == {
            "type": "array",
            "items": {"type": "string"},
            "readOnly": True,
        }
        #a count, not an array. If this ever goes back to
        # type: array the payload is unbounded again.
        assert properties["fans_count"] == {
            "type": "integer",
            "readOnly": True,
        }
        assert "fans" not in properties
        assert properties["twitter"] == {
            "allOf": [{"$ref": "#/components/schemas/TwitterProfileSummary"}],
            "nullable": True,
            "readOnly": True,
        }
    detail_properties = schemas["CreatorProfileDetail"]["properties"]
    for image_field in ("avatar_image", "banner_image"):
        assert detail_properties[image_field] == {
            "allOf": [{"$ref": "#/components/schemas/FeaturedImage"}],
            "nullable": True,
        }
        assert image_field not in schemas["CreatorProfileDetail"]["required"]


@pytest.mark.django_db
def test_profile_update_rejects_new_fields_until_they_are_allowlisted(
    creator_factory,
    rf,
):
    """A future serializer field cannot silently become a model writer."""
    user = creator_factory()
    request = rf.patch("/api/auth/user/")
    request.user = user
    serializer = CreatorProfileUpdateSerializer(
        instance=user,
        context={"request": request},
    )

    with pytest.raises(AssertionError, match="unapproved model fields: is_staff"):
        serializer.update(user, {"is_staff": True})

    user.refresh_from_db()
    assert user.is_staff is False


@pytest.mark.django_db
def test_password_change_cannot_restore_stale_staff_status(creator_factory):
    user = creator_factory(password="old-password", is_staff=True)
    request_user = Creator.objects.get(pk=user.pk)
    Creator.objects.filter(pk=user.pk).update(is_staff=False)

    client = APIClient()
    client.force_authenticate(user=request_user)
    response = client.post(
        "/api/auth/password/change/",
        {
            # Required since; this test is about stale is_staff, not
            # about re-authentication.
            "old_password": "old-password",
            "new_password1": "a-long-enough-new-password",
            "new_password2": "a-long-enough-new-password",
        },
        format="json",
    )

    assert response.status_code == 200, response.content
    row = Creator.objects.get(pk=user.pk)
    assert row.is_staff is False
    assert row.check_password("a-long-enough-new-password")
    assert request_user.is_staff is False


@pytest.mark.django_db
def test_frontend_password_change_invalidates_preexisting_reset_token(
    creator_factory,
):
    user = creator_factory(password="old-password")
    email = Email.objects.create(
        user=user,
        email="frontend-change-invalidates-reset@example.com",
        token="email-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )
    reset_token = PasswordResetToken.objects.create(email=email)
    client = APIClient()
    client.force_authenticate(user=user)

    changed = client.post(
        "/api/auth/password/change/",
        {
            "old_password": "old-password",
            "new_password1": "a-long-enough-frontend-password",
            "new_password2": "a-long-enough-frontend-password",
        },
        format="json",
    )
    attempted_reuse = APIClient().post(
        "/api/emails/do-reset-password",
        {
            "token": str(reset_token.token),
            "password": "attacker-controlled-password",
        },
        format="json",
    )

    assert changed.status_code == 200, changed.content
    assert attempted_reuse.status_code == 400
    assert attempted_reuse.json() == {
        "message": "Invalid token.",
        "code": "token_invalid",
    }
    reset_token.refresh_from_db()
    assert reset_token.used is True
    row = Creator.objects.get(pk=user.pk)
    assert row.check_password("a-long-enough-frontend-password")
    assert not row.check_password("attacker-controlled-password")


@pytest.mark.django_db
def test_custom_password_change_cannot_restore_stale_staff_status(creator_factory):
    user = creator_factory(password="old-password", is_staff=True)
    request_user = Creator.objects.get(pk=user.pk)
    Creator.objects.filter(pk=user.pk).update(is_staff=False)

    client = APIClient()
    client.force_authenticate(user=request_user)
    response = client.post(
        "/api/emails/change-password",
        {
            "old_password": "old-password",
            "new_password": "a-long-enough-custom-password",
            "confirm_password": "a-long-enough-custom-password",
        },
        format="json",
    )

    assert response.status_code == 200, response.content
    row = Creator.objects.get(pk=user.pk)
    assert row.is_staff is False
    assert row.check_password("a-long-enough-custom-password")


@pytest.mark.django_db
def test_normal_password_change_invalidates_preexisting_reset_token(
    creator_factory,
):
    user = creator_factory(password="old-password")
    email = Email.objects.create(
        user=user,
        email="normal-change-invalidates-reset@example.com",
        token="email-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )
    reset_token = PasswordResetToken.objects.create(email=email)
    client = APIClient()
    client.force_authenticate(user=user)

    changed = client.post(
        "/api/emails/change-password",
        {
            "old_password": "old-password",
            "new_password": "a-long-enough-normal-password",
        },
        format="json",
    )
    attempted_reuse = APIClient().post(
        "/api/emails/do-reset-password",
        {
            "token": str(reset_token.token),
            "password": "attacker-controlled-password",
        },
        format="json",
    )

    assert changed.status_code == 200, changed.content
    assert attempted_reuse.status_code == 400
    assert attempted_reuse.json() == {
        "message": "Invalid token.",
        "code": "token_invalid",
    }
    reset_token.refresh_from_db()
    assert reset_token.used is True
    row = Creator.objects.get(pk=user.pk)
    assert row.check_password("a-long-enough-normal-password")
    assert not row.check_password("attacker-controlled-password")


def test_reset_email_quota_claim_is_atomic_across_concurrent_requests():
    email_address = "concurrent-reset-quota@example.com"
    cache_key = f"reset_email_count_v2_{email_address}"
    cache.delete(cache_key)
    barrier = threading.Barrier(8)
    claims = []

    def claim_slot():
        barrier.wait(timeout=10)
        claims.append(_spend_reset_email_quota(email_address))

    threads = [threading.Thread(target=claim_slot) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert all(not thread.is_alive() for thread in threads)
    assert sum(claims) == 3
    cache.delete(cache_key)


def test_reset_email_quota_refund_does_not_create_missing_counter():
    email_address = "missing-refund@example.com"
    cache_key = f"reset_email_count_v2_{email_address}"
    cache.delete(cache_key)

    _release_reset_email_quota(email_address)

    assert cache.get(cache_key) is None


def test_ambiguous_redis_claim_is_marked_untracked(mocker):
    redis_client = mocker.Mock()
    redis_client.eval.side_effect = ConnectionError("response lost")
    fake_cache = mocker.Mock()
    fake_cache.client.get_client.return_value = redis_client
    fake_cache.make_key.return_value = "redis-reset-key"
    mocker.patch.object(email_views, "cache", fake_cache)

    claim = email_views._spend_reset_email_quota("ambiguous@example.com")

    assert claim is email_views._UNTRACKED_RESET_EMAIL_QUOTA
    fake_cache.add.assert_not_called()


def test_ambiguous_redis_refund_does_not_decrement_twice(mocker):
    redis_client = mocker.Mock()
    redis_client.eval.side_effect = ConnectionError("response lost")
    fake_cache = mocker.Mock()
    fake_cache.client.get_client.return_value = redis_client
    fake_cache.make_key.return_value = "redis-reset-key"
    mocker.patch.object(email_views, "cache", fake_cache)

    email_views._release_reset_email_quota("ambiguous@example.com")

    fake_cache.get.assert_not_called()
    fake_cache.decr.assert_not_called()


@pytest.mark.django_db
def test_failed_reset_delivery_refunds_token_and_quota(
    creator_factory,
    mocker,
):
    user = creator_factory(password="old-password")
    email = Email.objects.create(
        user=user,
        email="failed-delivery-quota@example.com",
        token="email-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )
    cache_key = f"reset_email_count_v2_{email.email}"
    cache.delete(cache_key)
    send_mock = mocker.patch(
        "dj.apps.emails.views.EmailMultiAlternatives.send",
        side_effect=RuntimeError("mail unavailable"),
    )

    with pytest.raises(RuntimeError, match="mail unavailable"):
        send_password_reset_email(email)

    assert not PasswordResetToken.objects.filter(email=email).exists()
    assert cache.get(cache_key) in (None, 0)

    send_mock.side_effect = None
    assert [
        send_password_reset_email(email)
        for _ in range(4)
    ] == [True, True, True, None]
    assert PasswordResetToken.objects.filter(email=email).count() == 3
    cache.delete(cache_key)


@pytest.mark.django_db
def test_failed_delivery_does_not_refund_ambiguous_quota_claim(
    creator_factory,
    mocker,
):
    user = creator_factory(password="old-password")
    email = Email.objects.create(
        user=user,
        email="ambiguous-delivery-quota@example.com",
        token="email-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )
    mocker.patch.object(
        email_views,
        "_spend_reset_email_quota",
        return_value=email_views._UNTRACKED_RESET_EMAIL_QUOTA,
    )
    release_mock = mocker.patch.object(email_views, "_release_reset_email_quota")
    mocker.patch(
        "dj.apps.emails.views.EmailMultiAlternatives.send",
        side_effect=RuntimeError("mail unavailable"),
    )

    with pytest.raises(RuntimeError, match="mail unavailable"):
        send_password_reset_email(email)

    assert not PasswordResetToken.objects.filter(email=email).exists()
    release_mock.assert_not_called()


@pytest.mark.django_db
def test_ambiguous_redis_claim_uses_durable_token_ceiling(
    creator_factory,
    mocker,
):
    user = creator_factory(password="old-password")
    email = Email.objects.create(
        user=user,
        email="redis-outage-quota@example.com",
        token="email-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )
    for _ in range(3):
        PasswordResetToken.objects.create(email=email)
    mocker.patch.object(
        email_views,
        "_spend_reset_email_quota",
        return_value=email_views._UNTRACKED_RESET_EMAIL_QUOTA,
    )
    send_mock = mocker.patch("dj.apps.emails.views.EmailMultiAlternatives.send")

    assert send_password_reset_email(email) is None

    assert PasswordResetToken.objects.filter(email=email).count() == 3
    send_mock.assert_not_called()


@pytest.mark.django_db
def test_failed_reset_token_creation_refunds_quota(
    creator_factory,
    mocker,
):
    user = creator_factory(password="old-password")
    email = Email.objects.create(
        user=user,
        email="failed-token-create@example.com",
        token="email-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )
    cache_key = f"reset_email_count_v2_{email.email}"
    cache.delete(cache_key)
    mocker.patch.object(
        PasswordResetToken.objects,
        "create",
        side_effect=RuntimeError("token insert failed"),
    )

    with pytest.raises(RuntimeError, match="token insert failed"):
        send_password_reset_email(email)

    assert cache.get(cache_key) in (None, 0)
    assert not PasswordResetToken.objects.filter(email=email).exists()


@pytest.mark.django_db
def test_reset_issuance_rechecks_locked_recovery_address(
    creator_factory,
    mocker,
):
    user = creator_factory(password="old-password")
    stale_email = Email.objects.create(
        user=user,
        email="old-recovery@example.com",
        token="email-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )
    original_get = QuerySet.get
    address_changed = False

    def change_address_before_account_lock(queryset, *args, **kwargs):
        nonlocal address_changed
        if (
            not address_changed
            and queryset.model is Creator
            and queryset.query.select_for_update
        ):
            address_changed = True
            Email.objects.filter(pk=stale_email.pk).update(
                email="new-recovery@example.com",
                confirmed_at=None,
            )
        return original_get(queryset, *args, **kwargs)

    mocker.patch.object(QuerySet, "get", change_address_before_account_lock)
    send_mock = mocker.patch("dj.apps.emails.views.EmailMultiAlternatives.send")

    assert send_password_reset_email(stale_email) is None

    assert not PasswordResetToken.objects.filter(email_id=stale_email.pk).exists()
    send_mock.assert_not_called()
    assert cache.get("reset_email_count_v2_old-recovery@example.com") is None


@pytest.mark.django_db
def test_recovery_address_change_invalidates_reset_tokens(
    creator_factory,
    mocker, recent_login):
    user = creator_factory(password="old-password")
    email = Email.objects.create(
        user=user,
        email="old-address@example.com",
        token="email-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )
    reset_token = PasswordResetToken.objects.create(email=email)
    mocker.patch("dj.apps.emails.views.send_confirmation_email")
    client = APIClient()
    client.force_authenticate(user=user)
    recent_login(client, user)

    response = client.post(
        "/api/emails/add",
        {"email": "new-address@example.com"},
        format="json",
    )

    assert response.status_code == 201, response.content
    email.refresh_from_db()
    reset_token.refresh_from_db()
    assert email.email == "new-address@example.com"
    assert email.confirmed_at is None
    assert reset_token.used is True


@pytest.mark.django_db
def test_stale_confirmation_cannot_restore_rotated_recovery_address(
    creator_factory,
    mocker,
):
    user = creator_factory(password="old-password")
    email = Email.objects.create(
        user=user,
        email="old-confirmation@example.com",
        token="old-confirmation-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=None,
    )
    original_get = QuerySet.get
    address_changed = False

    def rotate_address_before_confirmation_lock(queryset, *args, **kwargs):
        nonlocal address_changed
        if (
            not address_changed
            and queryset.model is Creator
            and queryset.query.select_for_update
        ):
            address_changed = True
            Email.objects.filter(pk=email.pk).update(
                email="new-confirmation@example.com",
                token="new-confirmation-token",
                confirmed_at=None,
            )
        return original_get(queryset, *args, **kwargs)

    mocker.patch.object(QuerySet, "get", rotate_address_before_confirmation_lock)
    # POST, not GET, since: the emailed link now lands on a page that
    # writes nothing and the button posts. The race this pins is unchanged.
    response = APIClient().post(
        "/api/emails/confirm",
        {"token": "old-confirmation-token"},
        format="json",
    )

    assert response.status_code == 404, response.content
    email.refresh_from_db()
    assert email.email == "new-confirmation@example.com"
    assert email.token == "new-confirmation-token"
    assert email.confirmed_at is None


@pytest.mark.django_db
def test_stale_resend_uses_current_recovery_address(
    creator_factory,
    mocker,
):
    user = creator_factory(password="old-password")
    email = Email.objects.create(
        user=user,
        email="old-resend@example.com",
        token="old-resend-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )
    Email.objects.filter(pk=email.pk).update(
        updated_at=timezone.now() - timedelta(minutes=6)
    )
    original_get = QuerySet.get
    address_changed = False

    def rotate_address_before_resend_lock(queryset, *args, **kwargs):
        nonlocal address_changed
        if (
            not address_changed
            and queryset.model is Creator
            and queryset.query.select_for_update
        ):
            address_changed = True
            Email.objects.filter(pk=email.pk).update(
                email="new-resend@example.com",
                token="new-address-token",
                confirmed_at=None,
            )
        return original_get(queryset, *args, **kwargs)

    mocker.patch.object(QuerySet, "get", rotate_address_before_resend_lock)
    send_mock = mocker.patch("dj.apps.emails.views.send_confirmation_email")
    client = APIClient()
    client.force_authenticate(user=user)

    response = client.post("/api/emails/resend", {}, format="json")

    assert response.status_code == 204, response.content
    email.refresh_from_db()
    assert email.email == "new-resend@example.com"
    assert email.confirmed_at is None
    assert email.token not in {"old-resend-token", "new-address-token"}
    assert send_mock.call_args.args[0].email == "new-resend@example.com"


@pytest.mark.django_db
def test_stale_opt_out_cannot_delete_rotated_recovery_address(
    creator_factory,
    mocker,
):
    user = creator_factory(password="old-password")
    email = Email.objects.create(
        user=user,
        email="old-opt-out@example.com",
        token="old-opt-out-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )
    original_get = QuerySet.get
    address_changed = False

    def rotate_address_before_opt_out_lock(queryset, *args, **kwargs):
        nonlocal address_changed
        if (
            not address_changed
            and queryset.model is Creator
            and queryset.query.select_for_update
        ):
            address_changed = True
            Email.objects.filter(pk=email.pk).update(
                email="new-opt-out@example.com",
                token="new-opt-out-token",
                confirmed_at=None,
            )
        return original_get(queryset, *args, **kwargs)

    mocker.patch.object(QuerySet, "get", rotate_address_before_opt_out_lock)

    # POST, not GET, since: the unsubscribe link now lands on a page that
    # writes nothing and the button posts. The race this pins is unchanged.
    response = APIClient().post(
        "/api/emails/opt-out/old-opt-out@example.com",
        {"token": "old-opt-out-token"},
        format="json",
    )

    assert response.status_code == 404, response.content
    email.refresh_from_db()
    assert email.email == "new-opt-out@example.com"
    assert email.token == "new-opt-out-token"
    assert email.confirmed_at is None


@pytest.mark.django_db
def test_custom_password_reset_cannot_restore_stale_staff_status(
    creator_factory,
    mocker,
):
    user = creator_factory(password="old-password", is_staff=True)
    email = Email.objects.create(
        user=user,
        email="reset@example.com",
        token="email-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )
    reset_token = PasswordResetToken.objects.create(email=email)
    sibling_token = PasswordResetToken.objects.create(email=email)

    def demote_while_reset_is_validated(password, loaded_user):
        # The view has resolved reset_token.email.user at this point. Commit a
        # concurrent staff revocation before its password save.
        assert loaded_user.pk == user.pk
        Creator.objects.filter(pk=user.pk).update(is_staff=False)

    mocker.patch(
        "dj.apps.emails.views.validate_password",
        side_effect=demote_while_reset_is_validated,
    )

    response = APIClient().post(
        "/api/emails/do-reset-password",
        {
            "token": str(reset_token.token),
            "password": "a-long-enough-reset-password",
        },
        format="json",
    )

    assert response.status_code == 200, response.content
    row = Creator.objects.get(pk=user.pk)
    assert row.is_staff is False
    assert row.check_password("a-long-enough-reset-password")
    reset_token.refresh_from_db()
    assert reset_token.used is True
    sibling_token.refresh_from_db()
    assert sibling_token.used is True


@pytest.mark.django_db
def test_custom_password_reset_rolls_back_if_token_consumption_fails(
    creator_factory,
    mocker,
):
    user = creator_factory(password="old-password")
    email = Email.objects.create(
        user=user,
        email="rollback-reset@example.com",
        token="email-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )
    reset_token = PasswordResetToken.objects.create(email=email)
    mocker.patch.object(
        PasswordResetToken,
        "save",
        side_effect=RuntimeError("token write failed"),
    )

    with pytest.raises(RuntimeError, match="token write failed"):
        APIClient().post(
            "/api/emails/do-reset-password",
            {
                "token": str(reset_token.token),
                "password": "a-long-enough-reset-password",
            },
            format="json",
        )

    row = Creator.objects.get(pk=user.pk)
    assert row.check_password("old-password")
    reset_token.refresh_from_db()
    assert reset_token.used is False


@pytest.mark.django_db(transaction=True)
def test_two_reset_tokens_for_one_creator_cannot_both_win(
    creator_factory,
    mocker,
):
    user = creator_factory(password="old-password")
    email = Email.objects.create(
        user=user,
        email="concurrent-reset@example.com",
        token="email-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )
    tokens = [
        PasswordResetToken.objects.create(email=email),
        PasswordResetToken.objects.create(email=email),
    ]
    passwords = ["first-long-enough-password", "second-long-enough-password"]
    ready_for_account_lock = threading.Barrier(2)
    original_get = QuerySet.get

    def synchronize_account_lock(queryset, *args, **kwargs):
        if queryset.model is Creator and queryset.query.select_for_update:
            ready_for_account_lock.wait(timeout=10)
        return original_get(queryset, *args, **kwargs)

    mocker.patch.object(QuerySet, "get", synchronize_account_lock)
    statuses = []
    errors = []

    def redeem(reset_token, password):
        try:
            response = APIClient().post(
                "/api/emails/do-reset-password",
                {"token": str(reset_token.token), "password": password},
                format="json",
            )
            statuses.append(response.status_code)
        except Exception as exc:  # pragma: no cover - asserted below
            errors.append(exc)
        finally:
            connection.close()

    threads = [
        threading.Thread(target=redeem, args=(token, password))
        for token, password in zip(tokens, passwords)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=20)

    assert not errors
    assert all(not thread.is_alive() for thread in threads)
    assert sorted(statuses) == [200, 400]
    row = Creator.objects.get(pk=user.pk)
    assert sum(row.check_password(password) for password in passwords) == 1
    assert not PasswordResetToken.objects.filter(
        email=email,
        used=False,
    ).exists()


@pytest.mark.django_db(transaction=True)
def test_concurrent_pre_reset_token_issuance_is_invalidated(
    creator_factory,
    mocker,
):
    user = creator_factory(password="old-password")
    email = Email.objects.create(
        user=user,
        email="issuance-race@example.com",
        token="email-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )
    redemption_token = PasswordResetToken.objects.create(email=email)
    issuance_holds_account_lock = threading.Event()
    redemption_reached_account_lock = threading.Event()
    allow_token_insert = threading.Event()
    original_create = PasswordResetToken.objects.create
    original_get = QuerySet.get

    def pause_issuance_create(*args, **kwargs):
        # send_password_reset_email() reaches token creation only after locking
        # the Creator. Hold that lock while redemption starts and queues behind
        # it, then let issuance commit first.
        issuance_holds_account_lock.set()
        assert allow_token_insert.wait(timeout=10)
        return original_create(*args, **kwargs)

    def observe_redemption_account_lock(queryset, *args, **kwargs):
        if (
            threading.current_thread().name == "reset-redeemer"
            and queryset.model is Creator
            and queryset.query.select_for_update
        ):
            redemption_reached_account_lock.set()
        return original_get(queryset, *args, **kwargs)

    mocker.patch.object(
        PasswordResetToken.objects,
        "create",
        side_effect=pause_issuance_create,
    )
    mocker.patch.object(QuerySet, "get", observe_redemption_account_lock)
    mocker.patch("dj.apps.emails.views.EmailMultiAlternatives.send")
    errors = []
    reset_statuses = []

    def issue():
        try:
            send_password_reset_email(email)
        except Exception as exc:  # pragma: no cover - asserted below
            errors.append(exc)
        finally:
            connection.close()

    def redeem():
        try:
            response = APIClient().post(
                "/api/emails/do-reset-password",
                {
                    "token": str(redemption_token.token),
                    "password": "a-long-enough-reset-password",
                },
                format="json",
            )
            reset_statuses.append(response.status_code)
        except Exception as exc:  # pragma: no cover - asserted below
            errors.append(exc)
        finally:
            connection.close()

    issuer = threading.Thread(target=issue, name="reset-issuer")
    redeemer = threading.Thread(target=redeem, name="reset-redeemer")
    issuer.start()
    assert issuance_holds_account_lock.wait(timeout=10)
    redeemer.start()
    assert redemption_reached_account_lock.wait(timeout=10)
    allow_token_insert.set()
    issuer.join(timeout=20)
    redeemer.join(timeout=20)

    assert not errors
    assert not issuer.is_alive()
    assert not redeemer.is_alive()
    assert reset_statuses == [200]
    tokens = PasswordResetToken.objects.filter(email=email)
    assert tokens.count() == 2
    assert not tokens.filter(used=False).exists()


@pytest.mark.django_db(transaction=True)
def test_reset_winning_account_lock_suppresses_stale_token_issuance(
    creator_factory,
    mocker,
):
    user = creator_factory(password="old-password")
    email = Email.objects.create(
        user=user,
        email="reset-wins-issuance-race@example.com",
        token="email-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )
    redemption_token = PasswordResetToken.objects.create(email=email)
    issuance_reached_account_lock = threading.Event()
    allow_issuance_lock = threading.Event()
    original_get = QuerySet.get

    def pause_issuer_before_account_lock(queryset, *args, **kwargs):
        if (
            threading.current_thread().name == "stale-reset-issuer"
            and queryset.model is Creator
            and queryset.query.select_for_update
        ):
            # The issuance epoch was captured before this query. Pause before
            # acquiring the lock so redemption can change that epoch first.
            issuance_reached_account_lock.set()
            assert allow_issuance_lock.wait(timeout=10)
        return original_get(queryset, *args, **kwargs)

    mocker.patch.object(QuerySet, "get", pause_issuer_before_account_lock)
    send_mock = mocker.patch(
        "dj.apps.emails.views.EmailMultiAlternatives.send"
    )
    errors = []
    reset_statuses = []

    def issue():
        try:
            send_password_reset_email(email)
        except Exception as exc:  # pragma: no cover - asserted below
            errors.append(exc)
        finally:
            connection.close()

    def redeem():
        try:
            response = APIClient().post(
                "/api/emails/do-reset-password",
                {
                    "token": str(redemption_token.token),
                    "password": "a-long-enough-reset-password",
                },
                format="json",
            )
            reset_statuses.append(response.status_code)
        except Exception as exc:  # pragma: no cover - asserted below
            errors.append(exc)
        finally:
            connection.close()

    issuer = threading.Thread(target=issue, name="stale-reset-issuer")
    redeemer = threading.Thread(target=redeem, name="epoch-reset-redeemer")
    issuer.start()
    assert issuance_reached_account_lock.wait(timeout=10)
    redeemer.start()
    redeemer.join(timeout=20)
    assert not redeemer.is_alive()
    allow_issuance_lock.set()
    issuer.join(timeout=20)

    assert not errors
    assert not issuer.is_alive()
    assert reset_statuses == [200]
    assert PasswordResetToken.objects.filter(email=email).count() == 1
    redemption_token.refresh_from_db()
    assert redemption_token.used is True
    send_mock.assert_not_called()
    assert cache.get(f"reset_email_count_{email.email}") is None


@pytest.mark.django_db
def test_ban_cannot_restore_other_stale_security_state(creator_factory):
    user = creator_factory(is_staff=True, strikes=2)
    stale = Creator.objects.get(pk=user.pk)
    Creator.objects.filter(pk=user.pk).update(is_staff=False, strikes=3)

    stale.ban_and_soft_delete()

    row = Creator.objects.get(pk=user.pk)
    assert row.is_active is False
    assert row.is_staff is False
    assert row.strikes == 3
