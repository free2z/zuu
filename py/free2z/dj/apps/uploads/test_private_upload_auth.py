"""
The private (KYC) upload gate authorizes by exact stored file.

nginx asks `uploads_auth_private` about the raw request URI and then fetches
the object named by its own normalized path. The two must be the same
object, so the gate accepts only a path that is already in canonical form
(`<profile-id>/<name>`, each segment decoded on its own, no dot segments,
no encoded separators) and only when that decoded name is a document
currently recorded on the profile.
"""
import pytest

from django.urls import reverse

from dj.apps.kyc.models import UserProfile, W9


AUTH = "uploads_auth_private"


def _profile_with_documents(user):
    profile = UserProfile(user=user)
    profile.id_front.name = f"{profile.id}/id-front.png"
    profile.id_back.name = f"{profile.id}/id-back.png"
    profile.additional_document.name = f"{profile.id}/proof.pdf"
    profile.live_photo.name = f"{profile.id}/selfie.jpg"
    profile.save()
    w9 = W9(profile=profile, full_name="A", address="B",
            city_state_zip="C", tax_classification="individual")
    w9.file.name = f"{profile.id}/w-9.pdf"
    w9.save()
    return profile


def _auth(client, uri):
    return client.get(reverse(AUTH), HTTP_X_ORIGINAL_URI=uri).status_code


@pytest.fixture
def two_profiles(creator_factory):
    owner = creator_factory(username="kyc-owner")
    other = creator_factory(username="kyc-other")
    return (
        owner, _profile_with_documents(owner),
        other, _profile_with_documents(other),
    )


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("name", [
    "id-front.png", "id-back.png", "proof.pdf", "selfie.jpg", "w-9.pdf",
])
def test_owner_reads_each_recorded_document(client, two_profiles, name):
    owner, mine, _, _ = two_profiles
    client.force_login(owner)
    assert _auth(client, f"/uploadz/private/{mine.id}/{name}") == 200
    # A query string is not part of the object name.
    assert _auth(client, f"/uploadz/private/{mine.id}/{name}?v=1") == 200


@pytest.mark.django_db(transaction=True)
def test_unrecorded_name_in_own_directory_is_denied(client, two_profiles):
    owner, mine, _, _ = two_profiles
    client.force_login(owner)
    assert _auth(client, f"/uploadz/private/{mine.id}/old-id-front.png") == 401


@pytest.mark.django_db(transaction=True)
def test_another_profiles_document_is_denied(client, two_profiles):
    owner, _, _, theirs = two_profiles
    client.force_login(owner)
    assert _auth(client, f"/uploadz/private/{theirs.id}/id-front.png") == 401
    assert _auth(client, f"/uploadz/private/{theirs.id}/w-9.pdf") == 401


@pytest.mark.django_db(transaction=True)
def test_anonymous_is_denied(client, two_profiles):
    _, mine, _, _ = two_profiles
    assert _auth(client, f"/uploadz/private/{mine.id}/id-front.png") == 401


# Every path below either is not in canonical `<profile-id>/<name>` form or
# would be normalized by nginx into a different object than its text names.
NON_CANONICAL = [
    "/uploadz/private/{mine}/../{theirs}/id-front.png",
    "/uploadz/private/{mine}/%2E%2E/{theirs}/id-front.png",
    "/uploadz/private/{mine}/%2e%2e/{theirs}/id-front.png",
    "/uploadz/private/{mine}/.%2E/{theirs}/id-front.png",
    "/uploadz/private/{mine}/./../{theirs}/id-front.png",
    "/uploadz/private/{mine}%2F..%2F{theirs}/id-front.png",
    "/uploadz/private/{mine}%2f%2e%2e%2f{theirs}/id-front.png",
    "/uploadz/private/{mine}/..%2F{theirs}%2Fid-front.png",
    "/uploadz/private/{mine}/..%5C{theirs}%5Cid-front.png",
    "/uploadz/private/{mine}/..\\{theirs}\\id-front.png",
    "/uploadz/private/./{mine}/id-front.png",
    "/uploadz/private/{mine}/./id-front.png",
    "/uploadz/private/{mine}//id-front.png",
    "/uploadz/private//{mine}/id-front.png",
    "/uploadz/private/{mine}/id-front.png/",
    "/uploadz/private/{mine}/id-front.png/.",
    "/uploadz/private/{mine}/sub/id-front.png",
    "/uploadz/private/{mine}",
    "/uploadz/private/{mine}/",
    "/uploadz/private/{mine}/%zz",
    "/uploadz/private/{mine}/%ff.png",
    "/uploadz/private/{mine}/id-front.png%00",
    "/uploadz/private/{mine_upper}/id-front.png",
    "/uploadz/%70rivate/{mine}/id-front.png",
    "/uploadz/private/../private/{mine}/id-front.png",
    "/uploadz/public/{mine}/id-front.png",
    "",
]


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("template", NON_CANONICAL)
def test_non_canonical_path_is_denied(client, two_profiles, template):
    owner, mine, _, theirs = two_profiles
    client.force_login(owner)
    uri = template.format(
        mine=mine.id, theirs=theirs.id, mine_upper=str(mine.id).upper())
    assert _auth(client, uri) == 401


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("template", NON_CANONICAL)
def test_non_canonical_path_is_denied_for_superuser(
        client, two_profiles, template):
    """Reviewer access is broad, but still only to an exact recorded name."""
    owner, mine, _, theirs = two_profiles
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])
    client.force_login(owner)
    uri = template.format(
        mine=mine.id, theirs=theirs.id, mine_upper=str(mine.id).upper())
    assert _auth(client, uri) == 401


@pytest.mark.django_db(transaction=True)
def test_superuser_reads_recorded_documents_only(client, two_profiles):
    owner, _, _, theirs = two_profiles
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])
    client.force_login(owner)
    assert _auth(client, f"/uploadz/private/{theirs.id}/id-front.png") == 200
    assert _auth(client, f"/uploadz/private/{theirs.id}/w-9.pdf") == 200
    assert _auth(client, f"/uploadz/private/{theirs.id}/missing.png") == 401


@pytest.mark.django_db(transaction=True)
def test_url_the_model_hands_out_is_authorized(client, two_profiles):
    """The admin and API build these URLs; each must pass the gate."""
    owner, mine, _, _ = two_profiles
    client.force_login(owner)
    for field in ("id_front", "id_back", "additional_document", "live_photo"):
        assert _auth(client, mine.get_id_url(field)) == 200
    assert _auth(client, mine.w9.get_url()) == 200
