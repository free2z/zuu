"""Tests for the KYC basic-info API, against real Postgres.

Regression coverage for the self-approval mass-assignment hole: ``application_status``
was a writable field on ``BasicInfoSerializer``, so a NEW user could
``POST {"application_status": "APPROVED"}`` to ``/api/kyc/user-profile`` and
advance their own identity-verification state past admin review.
"""
import pytest

from dj.apps.kyc.models import UserProfile


@pytest.mark.django_db
def test_user_profile_requires_auth(api_client):
    response = api_client.get("/api/kyc/user-profile")
    assert response.status_code in (401, 403), response.content


@pytest.mark.django_db
def test_cannot_self_approve_application_status(api_client, creator_factory):
    user = creator_factory()
    api_client.force_authenticate(user=user)

    response = api_client.post(
        "/api/kyc/user-profile",
        {"is_us": True, "is_individual": True, "application_status": "APPROVED"},
        format="json",
    )

    assert response.status_code in (200, 201), response.content
    profile = UserProfile.objects.get(user=user)
    # The writable fields took effect...
    assert profile.is_us is True
    assert profile.is_individual is True
    # ...but the status gate did NOT.
    assert profile.application_status == "NEW"


@pytest.mark.django_db
def test_can_edit_own_basic_info(api_client, creator_factory):
    user = creator_factory()
    api_client.force_authenticate(user=user)
    response = api_client.post(
        "/api/kyc/user-profile",
        {"is_us": False, "is_individual": False},
        format="json",
    )
    assert response.status_code in (200, 201), response.content
    profile = UserProfile.objects.get(user=user)
    assert profile.is_us is False
    assert profile.is_individual is False


@pytest.mark.django_db
def test_tax_form_upload_without_file_is_400_not_500(api_client, creator_factory):
    """TaxFormUploadView did ``request.FILES.get('file').content_type`` — with
    no file that's ``None.content_type`` -> AttributeError -> 500."""
    user = creator_factory()
    UserProfile.objects.create(user=user)  # can_edit() true for NEW
    api_client.force_authenticate(user=user)

    response = api_client.post("/api/kyc/upload-tax-form", {}, format="multipart")

    assert response.status_code == 400, response.content


@pytest.mark.django_db
def test_identity_documents_get_without_profile_is_not_500(api_client, creator_factory):
    """IdentityDocumentsView.get read ``request.user.userprofile`` directly; a
    user with no profile row got RelatedObjectDoesNotExist -> 500."""
    user = creator_factory()
    assert not UserProfile.objects.filter(user=user).exists()
    api_client.force_authenticate(user=user)

    response = api_client.get("/api/kyc/identity-documents")

    assert response.status_code == 200, response.content
