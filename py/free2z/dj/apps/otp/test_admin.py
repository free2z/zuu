"""Security regressions for the OTP secret admin."""

import pytest
from django.contrib.auth.models import Permission
from django.contrib.contenttypes.models import ContentType
from django.urls import reverse
from django.utils import timezone

from dj.apps.otp.models import OTPSecret


@pytest.mark.django_db
def test_otp_secret_admin_change_form_never_renders_seed(client, creator_factory):
    admin_user = creator_factory(is_staff=True, is_superuser=True)
    secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    otp_secret = OTPSecret.objects.create(
        user=creator_factory(), secret=secret, is_active=True
    )
    client.force_login(admin_user)

    response = client.get(
        reverse("admin:otp_otpsecret_change", args=[otp_secret.pk])
    )

    assert response.status_code == 200
    assert secret.encode() not in response.content
    assert "secret" not in response.context["adminform"].form.fields


@pytest.mark.django_db
def test_otp_secret_admin_change_form_is_targeted_and_readonly(
    client, creator_factory
):
    admin_user = creator_factory(is_staff=True, is_superuser=True)
    secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    owner = creator_factory()
    last_used_at = timezone.now()
    otp_secret = OTPSecret.objects.create(
        user=owner, secret=secret, is_active=True,
    )
    OTPSecret.objects.filter(pk=otp_secret.pk).update(last_used_at=last_used_at)
    client.force_login(admin_user)

    change_url = reverse("admin:otp_otpsecret_change", args=[otp_secret.pk])
    opened_form = client.get(change_url)
    assert opened_form.status_code == 200
    assert secret.encode() not in opened_form.content
    form = opened_form.context["adminform"].form
    assert "secret" not in form.fields
    assert {"user", "created_at", "last_used_at"}.isdisjoint(form.fields)

    response = client.post(
        change_url, {"is_active": "", "_save": "Save"},
    )

    assert response.status_code == 302
    assert secret.encode() not in response.content
    otp_secret.refresh_from_db()
    assert otp_secret.is_active is False
    assert otp_secret.user_id == owner.pk
    assert otp_secret.last_used_at == last_used_at
    assert otp_secret.secret == secret


@pytest.mark.django_db
def test_stale_changelist_submission_cannot_deactivate_unselected_factor(
    client, creator_factory,
):
    admin_user = creator_factory(is_staff=True, is_superuser=True)
    account_a = creator_factory()
    account_b = creator_factory()
    factor_a = OTPSecret.objects.create(
        user=account_a, secret="GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
        is_active=True,
    )
    factor_b = OTPSecret.objects.create(
        user=account_b, secret="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
        is_active=False,
    )
    client.force_login(admin_user)
    changelist_url = reverse("admin:otp_otpsecret_changelist")

    opened_list = client.get(changelist_url)
    assert opened_list.status_code == 200
    assert factor_b.secret.encode() not in opened_list.content

    # B completes enrollment after the operator loaded the page. This is the
    # stale unchecked value the old list_editable formset would save.
    OTPSecret.objects.filter(pk=factor_b.pk).update(is_active=True)
    response = client.post(
        changelist_url,
        {
            "form-TOTAL_FORMS": "2",
            "form-INITIAL_FORMS": "2",
            "form-MIN_NUM_FORMS": "0",
            "form-MAX_NUM_FORMS": "1000",
            "form-0-id": str(factor_a.pk),
            "form-0-is_active": "",
            "form-1-id": str(factor_b.pk),
            "form-1-is_active": "",
            "_save": "Save",
        },
    )

    assert response.status_code in (200, 302)
    factor_a.refresh_from_db()
    factor_b.refresh_from_db()
    assert factor_a.is_active is True
    assert factor_b.is_active is True


@pytest.mark.django_db
def test_view_only_admin_cannot_edit_otp_secret_on_changelist(
    client, creator_factory
):
    admin_user = creator_factory(is_staff=True)
    content_type = ContentType.objects.get_for_model(OTPSecret)
    view_permission = Permission.objects.get(
        content_type=content_type, codename="view_otpsecret"
    )
    admin_user.user_permissions.add(view_permission)
    otp_secret = OTPSecret.objects.create(
        user=creator_factory(),
        secret="GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
        is_active=True,
    )
    client.force_login(admin_user)

    response = client.post(
        reverse("admin:otp_otpsecret_change", args=[otp_secret.pk]),
        {"is_active": "", "_save": "Save"},
    )

    assert response.status_code == 403
    otp_secret.refresh_from_db()
    assert otp_secret.is_active is True


@pytest.mark.django_db
@pytest.mark.parametrize(
    "lookup",
    [
        "secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
        "secret__startswith=GEZD",
        "secret__regex=^G",
    ],
)
def test_view_only_admin_cannot_query_seed_lookup_oracle(
    client, creator_factory, lookup,
):
    admin_user = creator_factory(is_staff=True)
    content_type = ContentType.objects.get_for_model(OTPSecret)
    view_permission = Permission.objects.get(
        content_type=content_type, codename="view_otpsecret"
    )
    admin_user.user_permissions.add(view_permission)
    OTPSecret.objects.create(
        user=creator_factory(),
        secret="GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
        is_active=True,
    )
    client.force_login(admin_user)

    response = client.get(
        f"{reverse('admin:otp_otpsecret_changelist')}?{lookup}"
    )

    assert response.status_code == 400


@pytest.mark.django_db
def test_otp_secret_admin_add_is_disabled_even_for_add_permission(
    client, creator_factory
):
    admin_user = creator_factory(is_staff=True)
    content_type = ContentType.objects.get_for_model(OTPSecret)
    add_permission = Permission.objects.get(
        content_type=content_type, codename="add_otpsecret"
    )
    admin_user.user_permissions.add(add_permission)
    user = creator_factory()
    client.force_login(admin_user)

    add_url = reverse("admin:otp_otpsecret_add")
    assert client.get(add_url).status_code == 403
    response = client.post(add_url, {"user": user.pk, "is_active": "on"})

    assert response.status_code == 403
    assert not OTPSecret.objects.filter(user=user).exists()
