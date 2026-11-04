"""A zPage write answers with the representation a read does.

``POST``/``PUT``/``PATCH /api/zpage/`` (and the variant writes) take
``featured_image`` as an upload PRIMARY KEY, and used to answer with it the
same way: ``"featured_image": 123``. Every read answers ``{"id": 123, "url":
..., "thumbnail":...}``. The editor stores the write response as the article
and, when an AI translation is delivered, compares it with a fresh GET over the
shared settings -- so ``coverImageId`` was ``null`` on one side and the real id
on the other, and every covered article reported "Shared article settings
changed elsewhere" and paused saving. ``p2paddr`` had the same split: the write
serializer answered the page's raw column, reads answer the effective address
(falling back to the creator's).

Same class, and same contract, as  on ``/api/auth/user/``: the body a
write returns is a drop-in replacement for the body the matching read returns.
"""
import uuid
from io import BytesIO
from pathlib import Path

import pytest
import yaml
from django.core.files.base import ContentFile
from PIL import Image
from rest_framework.test import APIClient

from dj.apps.g12f.models import Creator, zPage
from dj.apps.uploads.models import GenericFile

CREATOR_ADDRESS = (
    "zs12f4y80pjhy042rmxq339dr6885jqqvh9fc6j8pvxg3hyhc8hmsqurlkqtkzwp03quca27pt0f7k"
)


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
        },
    }
    settings.MEDIA_ROOT = str(tmp_path)


def _png(owner, name="cover.png"):
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


def _page(creator, **overrides):
    values = {
        "creator": creator,
        "free2zaddr": str(uuid.uuid4()),
        "title": "English title",
        "description": "English description",
        "content": "English body",
        "source_language": "en",
        "is_published": False,
    }
    values.update(overrides)
    return zPage.objects.create(**values)


def _url(page):
    return f"/api/zpage/{page.free2zaddr}/"


def _payload(**overrides):
    body = {
        "title": "Covered article",
        "content": "Body",
        "description": "",
        "canonical_url": "",
        "tags": ["cover"],
        "vanity": "",
        "p2paddr": "",
        "featured_image": None,
        "is_published": False,
        "is_subscriber_only": False,
        "publish_at": None,
    }
    body.update(overrides)
    return body


def _assert_image(value, expected):
    """The shape the editor's ``hydrateEditorState`` reads: an object."""
    assert isinstance(value, dict), (
        f"expected the FeaturedImage object, got {value!r} -- a bare id makes "
        "the editor's coverImageId null and every AI-translation delivery "
        "report 'Shared article settings changed elsewhere'"
    )
    assert value["id"] == expected.pk
    assert value["url"]
    assert "thumbnail" in value


def _read(client, page):
    """The read the editor compares against (`?mine=true`, owner drafts)."""
    response = client.get(_url(page), {"mine": "true"})
    assert response.status_code == 200, response.content
    return response.json()


@pytest.mark.django_db
def test_put_with_a_cover_answers_with_the_read_representation(
        creator_factory):
    creator = creator_factory(username="cover-put-2048")
    cover = _png(creator)
    page = _page(creator)
    client = _client(creator)

    written = client.put(
        _url(page), _payload(featured_image=cover.pk), format="json")

    assert written.status_code == 200, written.content
    body = written.json()
    _assert_image(body["featured_image"], cover)
    # Not merely "an object": the SAME body a read returns, so a client that
    # swaps its cached article for the write response loses nothing and sees
    # no phantom change on its next comparison.
    assert body == _read(client, page)


@pytest.mark.django_db
def test_patch_that_does_not_touch_the_cover_keeps_it_in_the_response(
        creator_factory):
    creator = creator_factory(username="cover-patch-2048")
    cover = _png(creator)
    page = _page(creator, featured_image=cover)
    client = _client(creator)

    written = client.patch(_url(page), {"title": "Retitled"}, format="json")

    assert written.status_code == 200, written.content
    body = written.json()
    assert body["title"] == "Retitled"
    _assert_image(body["featured_image"], cover)
    assert body == _read(client, page)


@pytest.mark.django_db
def test_post_answers_with_the_read_representation(creator_factory):
    creator = creator_factory(username="cover-post-2048")
    cover = _png(creator)
    client = _client(creator)

    created = client.post(
        "/api/zpage/",
        _payload(featured_image=cover.pk, source_language="en"),
        format="json",
    )

    assert created.status_code == 201, created.content
    body = created.json()
    _assert_image(body["featured_image"], cover)
    page = zPage.objects.get(free2zaddr=body["free2zaddr"])
    assert body == _read(client, page)


@pytest.mark.django_db
def test_write_answers_the_effective_support_address_like_a_read(
        creator_factory):
    """The editor's other shared key, ``zcashAddress``.

    A page with no address of its own is supported through its creator's. The
    read has always said so; the write used to answer the raw empty column, so
    a creator who cleared the page address was also told settings "changed
    elsewhere".
    """
    creator = creator_factory(username="address-2048")
    # Bypasses the model validator; the address only has to be non-empty.
    Creator.objects.filter(pk=creator.pk).update(p2paddr=CREATOR_ADDRESS)
    creator.refresh_from_db()  # request.user is a fresh row in production
    page = _page(creator)
    client = _client(creator)

    written = client.put(_url(page), _payload(p2paddr=""), format="json")

    assert written.status_code == 200, written.content
    page.refresh_from_db()
    assert page.p2paddr == "", "the write itself stores what was sent"
    assert written.json()["p2paddr"] == CREATOR_ADDRESS
    assert written.json()["p2paddr"] == _read(client, page)["p2paddr"]


@pytest.mark.django_db
def test_variant_write_answers_with_the_variant_read_representation(
        creator_factory):
    """Translation saves go through ``/variants/{language}/``; same rule."""
    creator = creator_factory(username="variant-2048")
    cover = _png(creator)
    page = _page(creator, featured_image=cover)
    client = _client(creator)
    variant_url = f"{_url(page)}variants/es/"

    written = client.put(
        variant_url,
        {"title": "Titulo", "content": "Cuerpo", "tags": [],
         "is_published": False},
        format="json",
    )

    assert written.status_code == 200, written.content
    body = written.json()
    assert body["title"] == "Titulo"
    _assert_image(body["featured_image"], cover)
    read = client.get(variant_url)
    assert read.status_code == 200, read.content
    read_body = read.json()
    # The one documented exception. A write path deliberately loads no variant
    # provenance (see `zPageView.get_queryset`: a prefetch taken before the
    # write would describe the row as it was, and autosave keeps its query
    # count), so a TRANSLATION write answers `origin`/`is_stale` as `null`,
    # which the schema defines as "unknown". It did before  too, and no
    # editor comparison reads them.
    assert body["origin"] is None and body["is_stale"] is None
    provenance = ("origin", "is_stale")
    assert {k: v for k, v in body.items() if k not in provenance} == {
        k: v for k, v in read_body.items() if k not in provenance
    }


@pytest.mark.django_db
def test_write_still_takes_ids_and_rejects_a_foreign_cover(creator_factory):
    """The REQUEST contract is unchanged: ids in, ownership enforced."""
    creator = creator_factory(username="owner-2048")
    stranger = creator_factory(username="stranger-2048")
    theirs = _png(stranger, "theirs.png")
    page = _page(creator)

    refused = _client(creator).put(
        _url(page), _payload(featured_image=theirs.pk), format="json")

    assert refused.status_code == 400, refused.content
    assert "featured_image" in refused.json()
    page.refresh_from_db()
    assert page.featured_image_id is None


def test_spec_documents_the_read_shape_as_every_write_response():
    """``f2z.yaml`` is what orval generates the client from.

    Before  every zPage write declared its 2xx as ``zPageUpdate``, whose
    ``featured_image`` is an integer -- so the generated types described the
    bug faithfully. Request bodies stay the update schemas.
    """
    spec_path = Path(__file__).resolve().parents[5] / "py/free2z/dj/free2z/openapi/f2z.yaml"
    spec = yaml.safe_load(spec_path.read_text())
    paths = spec["paths"]
    cases = [
        ("/api/zpage/", "post", "201", "zPageUpdate"),
        ("/api/zpage/{id}/", "put", "200", "zPageUpdate"),
        ("/api/zpage/{id}/", "patch", "200", "PatchedzPageUpdate"),
        ("/api/zpage/{id}/variants/{language}/", "put", "200", "zPageUpdate"),
        ("/api/zpage/{id}/variants/{language}/", "patch", "200",
         "PatchedzPageUpdate"),
        ("/api/zpage/{id}/translations/{language}/", "put", "200",
         "zPageUpdate"),
    ]
    for path, method, code, request_schema in cases:
        operation = paths[path][method]
        response_ref = operation["responses"][code]["content"][
            "application/json"]["schema"]["$ref"]
        assert response_ref == "#/components/schemas/zPageDetail", (
            path, method, response_ref)
        request_ref = operation["requestBody"]["content"][
            "application/json"]["schema"]["$ref"]
        assert request_ref == f"#/components/schemas/{request_schema}", (
            path, method, request_ref)
