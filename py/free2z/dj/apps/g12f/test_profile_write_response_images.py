"""A profile write answers with the representation a read does.

``PATCH /api/auth/user/`` takes ``avatar_image``/``banner_image`` as upload
PRIMARY KEYS, and used to answer with them the same way: ``"avatar_image":
123``. ``GET`` answers ``{"id": 123, "url":..., "thumbnail":...}``. The
settings page stores the PATCH body as the creator and hands it to the auth
store behind the header avatar, so every Save -- with or without a new image --
showed "Profile updated successfully" and blanked the avatar and banner until
a reload re-read them through GET.

The contract pinned here is the one every caller already assumed: the body a
write returns is a drop-in replacement for the body a read returns.
"""

from io import BytesIO
from pathlib import Path

import pytest
import yaml
from django.core.files.base import ContentFile
from PIL import Image
from rest_framework.test import APIClient

from dj.apps.uploads.models import GenericFile


URL = "/api/auth/user/"


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
        },
    }
    settings.MEDIA_ROOT = str(tmp_path)


def _png(owner, name):
    out = BytesIO()
    Image.new("RGB", (8, 8), (10, 120, 200)).save(out, format="PNG")
    return GenericFile.objects.create(
        owner=owner,
        file=ContentFile(out.getvalue(), name=name),
        mime_type="image/png",
        access="public",
    )


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _assert_image(value, expected):
    """The shape the UI's ``buildImageUrl`` reads: an object, not an id."""
    assert isinstance(value, dict), (
        f"expected the FeaturedImage object, got {value!r} -- a bare id "
        "renders as an empty <img src> in the settings page and the header"
    )
    assert value["id"] == expected.pk
    assert value["url"]
    assert "thumbnail" in value


@pytest.mark.django_db
def test_patch_that_sets_images_answers_with_image_objects(creator_factory):
    creator = creator_factory(username="avatar-2037")
    avatar = _png(creator, "avatar.png")
    banner = _png(creator, "banner.png")
    client = _client(creator)

    written = client.patch(
        URL,
        {"avatar_image": avatar.pk, "banner_image": banner.pk},
        format="json",
    )

    assert written.status_code == 200, written.content
    body = written.json()
    _assert_image(body["avatar_image"], avatar)
    _assert_image(body["banner_image"], banner)
    # Not merely "an object": the SAME object a read returns, so a client that
    # swaps its cached creator for the write response loses nothing.
    read = client.get(URL).json()
    assert read.pop('balance_snapshot')  # GET adds a fresh balance observation.
    assert body == read


@pytest.mark.django_db
def test_patch_that_does_not_touch_images_keeps_them_in_the_response(
        creator_factory):
    """The Save button always PATCHes; most saves never send an image.

    This is the more common half of: editing the bio alone blanked the
    existing avatar and banner, because the response still carried ids.
    """
    creator = creator_factory(username="bio-only-2037")
    avatar = _png(creator, "avatar.png")
    banner = _png(creator, "banner.png")
    creator.avatar_image = avatar
    creator.banner_image = banner
    creator.save(update_fields=["avatar_image", "banner_image"])
    client = _client(creator)

    written = client.patch(URL, {"description": "new bio"}, format="json")

    assert written.status_code == 200, written.content
    body = written.json()
    assert body["description"] == "new bio"
    _assert_image(body["avatar_image"], avatar)
    _assert_image(body["banner_image"], banner)
    read = client.get(URL).json()
    assert read.pop('balance_snapshot')
    assert body == read


@pytest.mark.django_db
def test_patch_that_clears_an_image_answers_null(creator_factory):
    creator = creator_factory(username="clear-2037")
    avatar = _png(creator, "avatar.png")
    creator.avatar_image = avatar
    creator.save(update_fields=["avatar_image"])

    written = _client(creator).patch(
        URL, {"avatar_image": None}, format="json")

    assert written.status_code == 200, written.content
    assert written.json()["avatar_image"] is None


@pytest.mark.django_db
def test_write_still_accepts_ids_and_rejects_foreign_ones(creator_factory):
    """The REQUEST contract is unchanged: ids in, ownership enforced."""
    creator = creator_factory(username="owner-2037")
    stranger = creator_factory(username="stranger-2037")
    theirs = _png(stranger, "theirs.png")

    refused = _client(creator).patch(
        URL, {"avatar_image": theirs.pk}, format="json")

    assert refused.status_code == 400, refused.content
    creator.refresh_from_db()
    assert creator.avatar_image_id is None


def test_spec_documents_the_read_shape_as_the_write_response():
    """``f2z.yaml`` is what orval generates the client from.

    Before  it declared the PUT/PATCH 200 as ``CreatorProfileUpdate``,
    whose ``avatar_image`` is an integer -- so the generated types described
    the bug faithfully. The request bodies stay the update schemas.
    """
    spec_path = Path(__file__).resolve().parents[5] / "py/free2z/dj/free2z/openapi/f2z.yaml"
    spec = yaml.safe_load(spec_path.read_text())
    operations = spec["paths"]["/api/auth/user/"]

    for method, request_schema in (
        ("put", "CreatorProfileUpdate"),
        ("patch", "PatchedCreatorProfileUpdate"),
    ):
        operation = operations[method]
        response_ref = operation["responses"]["200"]["content"][
            "application/json"]["schema"]["$ref"]
        assert response_ref == "#/components/schemas/CreatorProfileDetail", (
            method, response_ref)
        request_ref = operation["requestBody"]["content"][
            "application/json"]["schema"]["$ref"]
        assert request_ref == f"#/components/schemas/{request_schema}", (
            method, request_ref)
