"""One storage key, one GenericFile row.

Prod had two rows sharing `XOZOKDIP/IMG_1628.JPG` (and two more sharing
`XOZOKDIP/IMG_9127.JPG`). In each pair the object's GCS generation equals the
*second* row's `created_at` to the second: the first row's object had been
deleted out from under it, `Storage.get_available_name` (which only asks the
bucket) then saw a free name, and the next same-named upload reused it.
"""
from io import StringIO

import pytest
from django.core.files.base import ContentFile
from django.core.management import call_command
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.loader import MigrationLoader

from dj.apps.uploads.models import GenericFile, PendingUploadBlobDeletion
from dj.apps.uploads.tasks import delete_pending_blob

EVIL_SVG = (
    b'<svg xmlns="http://www.w3.org/2000/svg">'
    b'<script>alert(1)</script></svg>'
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


def _upload(owner, name="photo.jpg", payload=b"bytes"):
    return GenericFile.objects.create(
        owner=owner,
        file=ContentFile(payload, name=name),
        mime_type="image/jpeg",
    )


@pytest.mark.django_db
def test_an_upload_never_reuses_a_key_whose_object_vanished(creator_factory):
    """The prod mechanism, end to end: object gone, row still there."""
    owner = creator_factory(username="xozokdip")
    first = _upload(owner, payload=b"first")
    storage = first.file.storage
    storage.delete(first.file.name)   # deleted out from under a live row
    assert not storage.exists(first.file.name)

    second = _upload(owner, payload=b"second")

    assert second.file.name != first.file.name
    assert second.file.name.startswith("xozokdip/photo_")
    # The row that lost its object did not silently acquire someone else's.
    assert not storage.exists(first.file.name)


@pytest.mark.django_db
def test_the_database_refuses_a_second_row_on_one_key(creator_factory):
    owner = creator_factory()
    first = _upload(owner)
    second = _upload(owner, name="other.jpg")

    second.file.name = first.file.name
    with pytest.raises(IntegrityError), transaction.atomic():
        second.save(update_fields=["file"])


@pytest.mark.django_db
def test_a_flagged_legacy_row_may_share_but_a_new_row_still_may_not(
        creator_factory):
    owner = creator_factory()
    first = _upload(owner)
    legacy = _upload(owner, name="other.jpg")
    GenericFile.objects.filter(pk=legacy.pk).update(
        file=first.file.name, legacy_shared_file=True)

    newcomer = _upload(owner, name="third.jpg")
    newcomer.file.name = first.file.name
    with pytest.raises(IntegrityError), transaction.atomic():
        newcomer.save(update_fields=["file"])


@pytest.mark.django_db
def test_deleting_one_row_of_a_legacy_pair_keeps_the_shared_object(
        creator_factory):
    owner = creator_factory()
    first = _upload(owner, payload=b"shared")
    legacy = _upload(owner, name="other.jpg")
    GenericFile.objects.filter(pk=legacy.pk).update(
        file=first.file.name, legacy_shared_file=True)
    storage = first.file.storage
    name = first.file.name

    first.delete()
    pending = PendingUploadBlobDeletion.objects.get(name=name)
    delete_pending_blob(pending_blob_id=pending.pk)

    assert storage.exists(name)
    legacy.refresh_from_db()
    with legacy.file.open("rb") as fh:
        assert fh.read() == b"shared"

    legacy.delete()
    delete_pending_blob(pending_blob_id=pending.pk)
    assert not storage.exists(name)


@pytest.mark.django_db(transaction=True)
def test_neutralizing_a_legacy_pair_leaves_neither_row_dangling(
        creator_factory):
    """`audit_active_uploads --neutralize` deleted the old key by name."""
    owner = creator_factory(username="kevin")
    first = GenericFile.objects.create(
        owner=owner, file=ContentFile(EVIL_SVG, name="evil.svg"),
        mime_type="image/svg+xml",
    )
    legacy = GenericFile.objects.create(
        owner=owner, file=ContentFile(b"x", name="other.svg"),
        mime_type="image/svg+xml",
    )
    GenericFile.objects.filter(pk=legacy.pk).update(
        file=first.file.name, legacy_shared_file=True)
    storage = first.file.storage
    old_name = first.file.name

    call_command("audit_active_uploads", "--neutralize", "--apply",
                 stdout=StringIO(), stderr=StringIO())

    for row in (first, legacy):
        row.refresh_from_db()
        assert row.file.name.endswith(".bin"), row.pk
        with row.file.open("rb") as fh:
            assert fh.read() == EVIL_SVG
    assert first.file.name != legacy.file.name
    assert not storage.exists(old_name)


@pytest.mark.django_db(transaction=True)
def test_0014_keeps_every_existing_duplicate_and_flags_all_but_the_oldest(
        creator_factory):
    executor = MigrationExecutor(connection)
    executor.migrate(MigrationLoader(connection).graph.leaf_nodes())
    owner = creator_factory()
    try:
        executor = MigrationExecutor(connection)
        executor.migrate([("uploads", "0013_pendinguploadblobdeletion")])
        old_apps = executor.loader.project_state(
            [("uploads", "0013_pendinguploadblobdeletion")]).apps
        Old = old_apps.get_model("uploads", "GenericFile")

        def row(name):
            return Old.objects.create(
                owner_id=owner.pk, file=name, mime_type="image/jpeg").pk

        # The two prod shapes, a triple, and a unique bystander.
        a1, a2 = row("u/IMG_1628.JPG"), row("u/IMG_1628.JPG")
        b1, b2, b3 = (row("u/IMG_9127.JPG") for _ in range(3))
        solo = row("u/solo.jpg")

        executor = MigrationExecutor(connection)
        executor.migrate([("uploads", "0014_genericfile_file_unique")])
    finally:
        MigrationExecutor(connection).migrate(
            MigrationLoader(connection).graph.leaf_nodes())

    flags = dict(GenericFile.objects.values_list("pk", "legacy_shared_file"))
    # No row lost, merged or repointed.
    assert set(flags) >= {a1, a2, b1, b2, b3, solo}
    assert GenericFile.objects.get(pk=a2).file.name == "u/IMG_1628.JPG"
    assert GenericFile.objects.get(pk=b3).file.name == "u/IMG_9127.JPG"
    # The oldest keeps the claim; the rest are marked.
    assert [flags[pk] for pk in (a1, a2, b1, b2, b3, solo)] == [
        False, True, False, True, True, False]
    #...and the claimed name is closed to a new row.
    with pytest.raises(IntegrityError), transaction.atomic():
        GenericFile.objects.create(
            owner=owner, file="u/IMG_1628.JPG", mime_type="image/jpeg")
