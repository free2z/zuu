"""The authenticated account contract reports only the caller's link state."""

import pytest
from rest_framework.test import APIClient

from dj.apps.social.models import SocialIdentity
from dj.apps.zauth.models import ZcashIdentity


@pytest.mark.django_db
def test_auth_user_reports_linked_identity_presence_without_credentials(
    creator_factory,
):
    owner = creator_factory(username="identity-owner")
    ZcashIdentity.objects.create(
        creator=owner, zcash_address="t1PrivateZcashAddressForOwner"
    )
    SocialIdentity.objects.create(
        creator=owner, provider="google", provider_uid="private-google-id",
        handle="private-handle",
    )
    SocialIdentity.objects.create(
        creator=owner, provider="x", provider_uid="private-x-id",
        handle="private-x-handle",
    )

    client = APIClient()
    client.force_authenticate(user=owner)
    response = client.get("/api/auth/user/")

    assert response.status_code == 200
    body = response.json()
    assert body["zcash_identity_linked"] is True
    assert body["social_identities"] == ["google", "x"]
    for private_value in (
        "t1PrivateZcashAddressForOwner", "private-google-id",
        "private-x-id", "private-handle", "private-x-handle",
    ):
        assert private_value not in response.content.decode()


@pytest.mark.django_db
def test_auth_user_reports_empty_link_state_and_is_not_public(
    creator_factory,
):
    owner = creator_factory(username="identity-unlinked")
    client = APIClient()
    client.force_authenticate(user=owner)
    response = client.get("/api/auth/user/")
    assert response.status_code == 200
    assert response.json()["zcash_identity_linked"] is False
    assert response.json()["social_identities"] == []

    client.force_authenticate(user=None)
    assert client.get("/api/auth/user/").status_code in (401, 403)

    public = APIClient().get(f"/api/creator/{owner.username}/")
    assert public.status_code == 200, public.content
    body = public.json()
    assert "zcash_identity_linked" not in body
    assert "social_identities" not in body


@pytest.mark.django_db
def test_auth_user_never_returns_another_accounts_identity_state(
    creator_factory,
):
    owner = creator_factory(username="identity-owner-private")
    other = creator_factory(username="identity-other-private")
    ZcashIdentity.objects.create(
        creator=other, zcash_address="t1OnlyTheOtherAccount"
    )
    SocialIdentity.objects.create(
        creator=other, provider="github", provider_uid="other-private-id",
    )

    client = APIClient()
    client.force_authenticate(user=owner)
    response = client.get("/api/auth/user/")
    assert response.status_code == 200
    assert response.json()["zcash_identity_linked"] is False
    assert response.json()["social_identities"] == []
    assert "other-private-id" not in response.content.decode()
    assert "t1OnlyTheOtherAccount" not in response.content.decode()
