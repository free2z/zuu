"""Optimistic concurrency coverage for Creator's privileged admin editor."""

from decimal import Decimal

import pytest
from django import forms
from django.contrib.auth.models import Group, Permission
from django.contrib.contenttypes.models import ContentType
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import F
from django.urls import reverse
from django.utils import timezone

from dj.apps.g12f.models import Creator
from dj.apps.g12f.admin import CreatorAdminForm
from dj.apps.twitter.models import TwitterProfile


@pytest.mark.django_db
@pytest.mark.parametrize("current_username", [None, "ordinary-creator"])
def test_creator_admin_rejects_reserved_username(
    current_username, creator_factory,
):
    creator = (
        Creator()
        if current_username is None
        else creator_factory(username=current_username)
    )
    form = CreatorAdminForm(instance=creator)
    form.cleaned_data = {"username": "trending"}

    with pytest.raises(ValidationError, match="System reserved name"):
        form.clean_username()


@pytest.mark.django_db
def test_creator_admin_allows_grandfathered_username_case_change(
    creator_factory,
):
    creator = creator_factory(username="trending")
    form = CreatorAdminForm(instance=creator)
    form.cleaned_data = {"username": "TRENDING"}

    assert form.clean_username() == "TRENDING"


def _admin_form_payload(response):
    """Round-trip every rendered field as a browser's submitted form would."""
    form = response.context["adminform"].form
    payload = {}
    for name, field in form.fields.items():
        value = form[name].value()
        if value is None or value is False:
            continue
        if isinstance(field.widget, forms.MultiWidget):
            for index, (widget, part) in enumerate(
                zip(field.widget.widgets, field.widget.decompress(value))
            ):
                if part is not None:
                    payload[f"{name}_{index}"] = widget.format_value(part)
            continue
        if value is True:
            payload[name] = "on"
        elif isinstance(value, (list, tuple)):
            payload[name] = [str(item) for item in value]
        else:
            payload[name] = str(value)
    return payload


@pytest.mark.django_db
def test_creator_admin_rejects_form_loaded_before_security_change(
    client,
    creator_factory,
):
    admin_user = creator_factory(is_staff=True, is_superuser=True)
    target = creator_factory(is_staff=True, strikes=2, full_name="Before")
    client.force_login(admin_user)
    url = reverse("admin:g12f_creator_change", args=[target.pk])

    opened_form = client.get(url)
    assert opened_form.status_code == 200
    payload = _admin_form_payload(opened_form)
    payload["full_name"] = "Stale admin edit"

    # A direct moderation writer lands after the human opened the admin page.
    # The row fingerprint catches it even without an updated_at convention.
    Creator.objects.filter(pk=target.pk).update(
        is_staff=False,
        strikes=3,
    )

    response = client.post(url, payload)

    assert response.status_code == 200
    assert "changed after you opened the form" in response.content.decode()
    row = Creator.objects.get(pk=target.pk)
    assert row.is_staff is False
    assert row.strikes == 3
    assert row.full_name == "Before"


@pytest.mark.django_db
def test_creator_admin_detects_real_writer_that_bypasses_updated_at(
    client,
    creator_factory,
):
    admin_user = creator_factory(is_staff=True, is_superuser=True)
    target = creator_factory(is_verified=False, full_name="Before")
    TwitterProfile.objects.create(
        creator=target,
        twitter_id="admin-race-twitter-id",
        username="admin_race_twitter",
    )
    client.force_login(admin_user)
    url = reverse("admin:g12f_creator_change", args=[target.pk])
    opened_form = client.get(url)
    payload = _admin_form_payload(opened_form)
    payload["full_name"] = "Stale admin edit"
    loaded_timestamp = target.updated_at

    # cache_total() is a real production writer whose explicit update_fields
    # intentionally omits updated_at. A timestamp token would miss this trust
    # change and let the stale admin checkbox revoke verification.
    current = Creator.objects.get(pk=target.pk)
    current.cache_total()

    response = client.post(url, payload)

    assert response.status_code == 200
    assert "changed after you opened the form" in response.content.decode()
    row = Creator.objects.get(pk=target.pk)
    assert row.updated_at == loaded_timestamp
    assert row.is_verified is True
    assert row.full_name == "Before"


@pytest.mark.django_db
@pytest.mark.parametrize("relation", ["groups", "user_permissions"])
def test_creator_admin_rejects_form_loaded_before_privilege_m2m_revocation(
    client,
    creator_factory,
    relation,
):
    admin_user = creator_factory(is_staff=True, is_superuser=True)
    target = creator_factory(full_name="Before")
    if relation == "groups":
        privilege = Group.objects.create(name="stale-admin-privilege")
    else:
        privilege = Permission.objects.create(
            content_type=ContentType.objects.get_for_model(Creator),
            codename="stale_admin_privilege",
            name="Stale admin privilege",
        )
    getattr(target, relation).add(privilege)

    client.force_login(admin_user)
    url = reverse("admin:g12f_creator_change", args=[target.pk])
    opened_form = client.get(url)
    assert opened_form.status_code == 200
    payload = _admin_form_payload(opened_form)
    payload["full_name"] = "Stale admin edit"

    # A second admin revokes access after this page loaded. Posting the old
    # multi-select must not let ModelForm.save_m2m() grant it again.
    getattr(target, relation).remove(privilege)
    response = client.post(url, payload)

    assert response.status_code == 200
    assert "changed after you opened the form" in response.content.decode()
    target.refresh_from_db()
    assert target.full_name == "Before"
    assert not getattr(target, relation).filter(pk=privilege.pk).exists()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("relation", ["groups", "user_permissions"])
def test_creator_admin_does_not_restore_revocation_after_validation(
    client,
    creator_factory,
    relation,
):
    admin_user = creator_factory(is_staff=True, is_superuser=True)
    target = creator_factory(full_name="Before")
    if relation == "groups":
        privilege = Group.objects.create(name="mid-save-admin-privilege")
    else:
        privilege = Permission.objects.create(
            content_type=ContentType.objects.get_for_model(Creator),
            codename="mid_save_admin_privilege",
            name="Mid-save admin privilege",
        )
    getattr(target, relation).add(privilege)

    client.force_login(admin_user)
    url = reverse("admin:g12f_creator_change", args=[target.pk])
    opened_form = client.get(url)
    payload = _admin_form_payload(opened_form)
    payload["full_name"] = "Fresh admin edit"
    form_class = opened_form.context["adminform"].form.__class__

    # Reproduce the exact clean() -> save_model() -> concurrent join-table
    # revocation -> save_m2m() ordering. The submitted multi-select is
    # unchanged, so the admin edit has no privilege delta to apply.
    with transaction.atomic():
        form = form_class(
            data=payload,
            instance=Creator.objects.get(pk=target.pk),
        )
        assert form.is_valid(), form.errors
        instance = form.save(commit=False)
        instance.save()
        getattr(target, relation).remove(privilege)
        form.save_m2m()

    target.refresh_from_db()
    assert target.full_name == "Fresh admin edit"
    assert not getattr(target, relation).filter(pk=privilege.pk).exists()


@pytest.mark.django_db
@pytest.mark.parametrize("relation", ["groups", "user_permissions"])
def test_creator_admin_applies_explicit_privilege_delta(
    client,
    creator_factory,
    relation,
):
    admin_user = creator_factory(is_staff=True, is_superuser=True)
    target = creator_factory()
    if relation == "groups":
        privilege = Group.objects.create(name="explicit-admin-privilege")
    else:
        privilege = Permission.objects.create(
            content_type=ContentType.objects.get_for_model(Creator),
            codename="explicit_admin_privilege",
            name="Explicit admin privilege",
        )

    client.force_login(admin_user)
    url = reverse("admin:g12f_creator_change", args=[target.pk])
    payload = _admin_form_payload(client.get(url))
    payload[relation] = [str(privilege.pk)]

    response = client.post(url, payload)

    assert response.status_code == 302
    assert getattr(target, relation).filter(pk=privilege.pk).exists()


@pytest.mark.django_db
@pytest.mark.parametrize("submitted_version", [None, "forged-version"])
def test_creator_admin_rejects_missing_or_forged_version(
    client,
    creator_factory,
    submitted_version,
):
    admin_user = creator_factory(is_staff=True, is_superuser=True)
    target = creator_factory(full_name="Before")
    client.force_login(admin_user)
    url = reverse("admin:g12f_creator_change", args=[target.pk])
    payload = _admin_form_payload(client.get(url))
    payload["full_name"] = "Unversioned admin edit"
    if submitted_version is None:
        payload.pop("_loaded_row_fingerprint")
    else:
        payload["_loaded_row_fingerprint"] = submitted_version

    response = client.post(url, payload)

    assert response.status_code == 200
    assert "changed after you opened the form" in response.content.decode()
    target.refresh_from_db()
    assert target.full_name == "Before"


@pytest.mark.django_db
def test_creator_admin_saves_when_loaded_version_is_current(client, creator_factory):
    admin_user = creator_factory(is_staff=True, is_superuser=True)
    target = creator_factory(full_name="Before")
    client.force_login(admin_user)
    url = reverse("admin:g12f_creator_change", args=[target.pk])

    opened_form = client.get(url)
    payload = _admin_form_payload(opened_form)
    payload["full_name"] = "Fresh admin edit"
    response = client.post(url, payload)

    assert response.status_code == 302, response.context["adminform"].form.errors
    target.refresh_from_db()
    assert target.full_name == "Fresh admin edit"


@pytest.mark.django_db
def test_balance_churn_cannot_block_emergency_admin_deactivation(
    client,
    creator_factory,
):
    admin_user = creator_factory(is_staff=True, is_superuser=True)
    target = creator_factory(is_active=True, tuzis=Decimal("10"))
    client.force_login(admin_user)
    url = reverse("admin:g12f_creator_change", args=[target.pk])
    payload = _admin_form_payload(client.get(url))
    payload.pop("is_active")  # unchecked checkbox means deactivate

    Creator.objects.filter(pk=target.pk).update(
        tuzis=F("tuzis") + Decimal("1"),
        updated_at=timezone.now(),
    )

    response = client.post(url, payload)

    assert response.status_code == 302
    target.refresh_from_db()
    assert target.is_active is False
    assert target.tuzis == Decimal("11")
