"""
`mime_type` is server-owned: no client can write it through the API.

 stopped trusting the browser-supplied `content_type` and made
`validate_upload()` — which reads the file's *bytes* — the only authority on
what an upload is. `GenericFileSerializer` has always listed `mime_type` in
`read_only_fields`; `FeaturedImageSerializer` had no `read_only_fields` at
all, and it is the serializer `MyUploadsViewSet` uses. So
`PATCH /api/myuploads/<id>/` accepted an arbitrary `mime_type` from any
authenticated client, for their own row.

What a forged value actually reaches: `GenericFile.get_thumbnail()` and
`GenericFile.variant_url()` both gate on `mime_type.startswith("image")`, the
variant worker is enqueued off the same check, and clients decide how to
render a row from it. It does NOT change the `Content-Type` on the wire —
django-storages derives that from the stored filename, which  rewrites to
match the sniffed type.

The second half of this module is the other side of that contract: making the
field read-only must NOT break the upload views, which assign the sniffed type
into `validated_data` *after* `is_valid()` and so bypass field-level
read-only entirely.

File storage is redirected to a tmp dir (default storage in settings is GCS;
only that external boundary is swapped, per repo test rules).
"""
import json
from io import BytesIO

import pytest
from PIL import Image

from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse

from dj.apps.uploads.models import GenericFile
from dj.apps.uploads.serializers import FeaturedImageSerializer


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
        },
    }
    settings.MEDIA_ROOT = str(tmp_path)


def _png_bytes():
    out = BytesIO()
    Image.new("RGB", (8, 8), (10, 120, 200)).save(out, format="PNG")
    return out.getvalue()


PNG = _png_bytes()


def _upload_a_png(client, title="cat"):
    """Create a row through the real upload view, so `mime_type` is whatever
    the server sniffed rather than whatever a test typed."""
    created = client.post(
        reverse("uploads_handle"),
        {
            "body": json.dumps([{"title": title, "access": "public"}]),
            "files": SimpleUploadedFile("cat.png", PNG,
                                        content_type="image/png"),
        },
    )
    assert created.status_code == 201, created.content
    return created.json()[0]


# ---------------------------------------------------------------------------
# The fix: PATCH /api/myuploads/<id>/ cannot rewrite the sniffed type
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_patch_myuploads_cannot_change_the_sniffed_mime_type(
        client, creator_factory):
    """
    The PATCH must SUCCEED and edit what it is allowed to edit — a 400 here
    would be a different (and worse) contract, since `title` is what this
    endpoint exists for. Only `mime_type` is ignored.
    """
    creator = creator_factory(username="kevin")
    client.force_login(creator)
    created = _upload_a_png(client)
    assert created["mime_type"] == "image/png"

    response = client.patch(
        f"/api/myuploads/{created['id']}/",
        data=json.dumps({
            "title": "renamed",
            "mime_type": "application/pdf",
        }),
        content_type="application/json",
    )

    assert response.status_code == 200, response.content
    body = response.json()
    # The writable field went through...
    assert body["title"] == "renamed"
    #...and the server-owned one did not.
    assert body["mime_type"] == "image/png"

    stored = GenericFile.objects.get(id=created["id"])
    assert stored.title == "renamed"
    assert stored.mime_type == "image/png"


@pytest.mark.django_db(transaction=True)
def test_put_myuploads_cannot_change_the_sniffed_mime_type(
        client, creator_factory):
    """PUT is the same serializer with `partial=False` — a read-only field is
    dropped from `validated_data` on both, but that is worth pinning: a
    required-looking field is exactly the kind of thing a full replace is
    expected to honour."""
    creator = creator_factory(username="jonathan")
    client.force_login(creator)
    created = _upload_a_png(client)

    response = client.put(
        f"/api/myuploads/{created['id']}/",
        data=json.dumps({
            "title": "replaced",
            "description": "",
            "access": "public",
            "mime_type": "text/html",
        }),
        content_type="application/json",
    )

    assert response.status_code == 200, response.content
    assert response.json()["mime_type"] == "image/png"
    assert GenericFile.objects.get(id=created["id"]).mime_type == "image/png"


@pytest.mark.django_db(transaction=True)
def test_the_forgeable_consequences_stay_correct(client, creator_factory):
    """
    Name the thing a forged `mime_type` actually reaches, so this does not
    decay into a test of a Meta attribute.

    `get_thumbnail()` returns None for a non-image; flipping a PNG's declared
    type to `application/pdf` would have made a real image stop offering a
    thumbnail (and, in reverse, made a PDF claim to be one).
    """
    creator = creator_factory(username="skyl")
    client.force_login(creator)
    created = _upload_a_png(client)

    client.patch(
        f"/api/myuploads/{created['id']}/",
        data=json.dumps({"mime_type": "application/pdf"}),
        content_type="application/json",
    )

    stored = GenericFile.objects.get(id=created["id"])
    assert stored.get_thumbnail() is not None
    assert FeaturedImageSerializer(stored).data["thumbnail"] is not None


@pytest.mark.django_db(transaction=True)
def test_the_writable_fields_are_still_writable(client, creator_factory):
    """`title`, `description` and `access` must stay writable — the media
    dashboard edits them, and  builds on exactly that."""
    creator = creator_factory(username="editor")
    client.force_login(creator)
    created = _upload_a_png(client)

    response = client.patch(
        f"/api/myuploads/{created['id']}/",
        data=json.dumps({
            "title": "a better title",
            "description": "with a caption",
            "access": "private",
        }),
        content_type="application/json",
    )

    assert response.status_code == 200, response.content
    stored = GenericFile.objects.get(id=created["id"])
    assert stored.title == "a better title"
    assert stored.description == "with a caption"
    assert stored.access == "private"


@pytest.mark.django_db(transaction=True)
def test_id_and_timestamps_are_not_writable_either(client, creator_factory):
    """`id`/`created_at`/`updated_at` were already read-only by construction
    (pk, `auto_now_add`, `auto_now`); `read_only_fields` now says so. This
    pins the behaviour rather than the declaration."""
    creator = creator_factory(username="clock")
    client.force_login(creator)
    created = _upload_a_png(client)
    before = GenericFile.objects.get(id=created["id"])

    response = client.patch(
        f"/api/myuploads/{created['id']}/",
        data=json.dumps({
            "id": created["id"] + 9999,
            "created_at": "1999-01-01T00:00:00Z",
        }),
        content_type="application/json",
    )

    assert response.status_code == 200, response.content
    assert not GenericFile.objects.filter(
        id=created["id"] + 9999).exists()
    after = GenericFile.objects.get(id=created["id"])
    assert after.created_at == before.created_at


# ---------------------------------------------------------------------------
# The upload views are unaffected: they write `mime_type` AFTER `is_valid()`
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_batch_upload_still_stores_the_sniffed_type(client, creator_factory):
    """`uploads_handle` sets `validated_data['mime_type']` after validation,
    which is not a serializer field write and is therefore untouched by
    `read_only_fields`. A client-declared type in the JSON metadata is still
    ignored in favour of the bytes."""
    creator = creator_factory(username="batch")
    client.force_login(creator)

    created = client.post(
        reverse("uploads_handle"),
        {
            "body": json.dumps([{
                "title": "cat",
                "access": "public",
                # A lie, in the one place a client could put one.
                "mime_type": "application/pdf",
            }]),
            # And a second lie on the multipart part itself.  rejects a
            # declared type that is off-allowlist outright, so the interesting
            # case is an allowlisted declaration that simply disagrees with the
            # bytes — the sniffed type has to win.
            "files": SimpleUploadedFile("cat.png", PNG,
                                        content_type="image/jpeg"),
        },
    )

    assert created.status_code == 201, created.content
    record = created.json()[0]
    assert record["mime_type"] == "image/png"
    assert GenericFile.objects.get(
        id=record["id"]).mime_type == "image/png"


@pytest.mark.django_db(transaction=True)
def test_single_upload_still_stores_the_sniffed_type(client, creator_factory):
    """The same for `single_public_upload_handle`."""
    creator = creator_factory(username="single")
    client.force_login(creator)

    created = client.post(
        reverse("uploads_single_public"),
        {
            "title": "cat",
            "access": "public",
            "mime_type": "application/pdf",
            "file": SimpleUploadedFile("cat.png", PNG,
                                       content_type="image/jpeg"),
        },
    )

    assert created.status_code == 201, created.content
    record = created.json()
    assert record["mime_type"] == "image/png"
    assert GenericFile.objects.get(
        id=record["id"]).mime_type == "image/png"


# ---------------------------------------------------------------------------
# The side effect the codex adversarial review caught
# ---------------------------------------------------------------------------
#
# `mime_type` was the last REQUIRED writable field on this serializer. Before
# the change a bodiless `POST /api/myuploads/` 400'd on it — by accident, not
# by design. With it read-only nothing is required any more, and DRF happily
# created a row with `file=''` and `mime_type=''`: 201, a `url` of
# `/uploadz/public/`, and a `mime_type` that is not a member of the enum the
# generated client was handed. Observed, not theorised, before the guard in
# `MyUploadsViewSet.create` was added.

@pytest.mark.django_db(transaction=True)
def test_post_myuploads_refuses_instead_of_creating_a_fileless_orphan(
        client, creator_factory):
    creator = creator_factory(username="poster")
    client.force_login(creator)

    response = client.post(
        "/api/myuploads/",
        data=json.dumps({}),
        content_type="application/json",
    )

    assert response.status_code == 400, response.content
    assert not GenericFile.objects.filter(owner=creator).exists()

    # The body is the point of the refusal — it carries the redirect to the
    # endpoints that DO upload. `UploadCreateUnsupportedSerializer` declares
    # exactly this shape so a generated client can surface it instead of
    # typing the error `void` (codex review, finding 2).
    body = response.json()
    assert list(body) == ["file"]
    assert isinstance(body["file"], list)
    assert "/uploads/handle" in body["file"][0]
    assert "/uploads/single-public" in body["file"][0]


@pytest.mark.django_db(transaction=True)
def test_post_myuploads_refuses_a_populated_body_too(client, creator_factory):
    """The pre-existing shape of the bug: sending a valid `mime_type` used to
    return 201 for a row with no bytes behind it. There is no body that makes
    this route work, so there is no body it should accept."""
    creator = creator_factory(username="poster2")
    client.force_login(creator)

    response = client.post(
        "/api/myuploads/",
        data=json.dumps({
            "title": "not a file",
            "access": "public",
            "mime_type": "image/png",
        }),
        content_type="application/json",
    )

    assert response.status_code == 400, response.content
    assert not GenericFile.objects.filter(owner=creator).exists()


@pytest.mark.django_db(transaction=True)
def test_the_refusal_does_not_lift_itself_when_file_joins_meta_fields(
        client, creator_factory, monkeypatch):
    """
    The first version of the guard was `if 'file' not in Meta.fields`, so
    adding `file` to the serializer for ANY reason — including read-only,
    purely to expose the stored name — would have silently enabled a generic
    `ModelViewSet.create()` with no byte sniffing, no EXIF stripping and no
    nginx size authorization (codex review, finding 1).

    A serializer field list is not an authorization decision. Re-enabling
    creation has to be a deliberate edit to `MyUploadsViewSet.create`, and
    this is the test that says so.

    It sends a REAL multipart file, not an empty body. An empty body 400s
    either way — `super().create()` would reject the missing required
    `file` — so it would have passed against the very implementation it
    exists to forbid (codex review of this branch, finding 1). With a valid
    file attached the conditional version returns 201 and writes a row that
    never saw `validate_upload()`; only the unconditional refusal still 400s.
    The body assertion is the second discriminator: `super().create()` cannot
    produce this message.
    """
    creator = creator_factory(username="fieldlist")
    client.force_login(creator)

    monkeypatch.setattr(
        FeaturedImageSerializer.Meta,
        "fields",
        tuple(FeaturedImageSerializer.Meta.fields) + ("file",),
    )

    response = client.post(
        "/api/myuploads/",
        {
            "title": "smuggled",
            "access": "public",
            "file": SimpleUploadedFile("cat.png", PNG,
                                       content_type="image/png"),
        },
    )

    assert response.status_code == 400, response.content
    assert "/uploads/handle" in response.json()["file"][0]
    assert not GenericFile.objects.filter(owner=creator).exists()


@pytest.mark.django_db(transaction=True)
def test_perform_create_still_sets_the_owner(creator_factory, rf):
    """`perform_create` is kept for whenever the endpoint is completed, so it
    must stay correct while unreachable — an ownerless row is invisible to its
    creator forever. Mirrors `test_myuploads_create_sets_owner`."""
    from dj.apps.uploads.views import MyUploadsViewSet

    creator = creator_factory(username="owner-check")
    request = rf.post("/api/myuploads/")
    request.user = creator

    view = MyUploadsViewSet()
    view.request = request

    saved = {}

    class _Serializer:
        def save(self, **kwargs):
            saved.update(kwargs)

    view.perform_create(_Serializer())
    assert saved == {"owner": creator}
