""": a generated file's failure never hands another writer's key to the
deletion outbox, and a lost upload response leaves no orphan behind.

`_save_generated_file` sets the field's name BEFORE the storage write so a
write-then-raise can still be outboxed. Under the create-only backend the
save can move off that name -- a 412 there means another writer owns it --
so on failure the field must end up holding the key THIS call may have
written, or nothing.

The legacy-thumbnail path (`create_thumbnail`) is driven end to end against
real Postgres; only the GCS bucket is faked (the same in-memory fake as
test_storage_create_only.py, which honours `if_generation_match=0`).
"""
from io import BytesIO

import pytest
from PIL import Image

from django.core.files.base import ContentFile

from dj.apps.uploads.image_utils import create_thumbnail
from dj.apps.uploads.models import (
    GenericFile,
    PendingUploadBlobDeletion,
    Webp,
)
from dj.apps.uploads.storage import CreateOnlyGoogleCloudStorage
from dj.apps.uploads.test_storage_create_only import Bucket, FakeBlob
from google.api_core.exceptions import PreconditionFailed


FOREIGN = b"another writer's bytes"


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    # The parent upload lives on local disk; only the thumbnail field is
    # pointed at the fake GCS bucket below.
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
        },
    }
    settings.MEDIA_ROOT = str(tmp_path)


@pytest.fixture
def bucket(mocker, monkeypatch):
    mocker.patch("storages.backends.gcloud.Blob", FakeBlob)
    fake = Bucket()
    storage = CreateOnlyGoogleCloudStorage(
        bucket_name="test-bucket", file_overwrite=False)
    storage._bucket = fake
    monkeypatch.setattr(Webp._meta.get_field("file"), "storage", storage)
    return fake


def _image(creator):
    out = BytesIO()
    Image.new("RGB", (100, 60), (10, 120, 200)).save(out, format="PNG")
    return GenericFile.objects.create(
        owner=creator,
        file=ContentFile(out.getvalue(), name="pic.png"),
        mime_type="image/png",
    )


def _another_writer_wins_every_name(mocker, bucket):
    """Each candidate name is created by a racing writer between our
    exists() check and our upload, so every attempt 412s on THEIR object."""
    def upload(self, content, **kwargs):
        bucket.objects.setdefault(self.name, FOREIGN)
        raise PreconditionFailed("412 conditionNotMet")

    mocker.patch.object(FakeBlob, "upload_from_file", upload)


@pytest.mark.django_db
def test_exhausted_create_never_outboxes_the_racing_writers_key(
        creator_factory, mocker, bucket):
    gfile = _image(creator_factory())
    _another_writer_wins_every_name(mocker, bucket)

    create_thumbnail(gfile)

    gfile.refresh_from_db()
    assert gfile.skip_thumbnail is True        # failed, as it should
    assert not Webp.objects.filter(parent=gfile).exists()
    # Five foreign objects, every one of them untouched and none of them
    # queued for deletion. Before  the first one -- the name
    # `_save_generated_file` pre-assigned -- went into the outbox.
    assert len(bucket.objects) == 5
    assert set(bucket.objects.values()) == {FOREIGN}
    assert not PendingUploadBlobDeletion.objects.exists()


@pytest.mark.django_db
def test_write_then_raise_after_a_412_outboxes_our_key_only(
        creator_factory, mocker, bucket):
    gfile = _image(creator_factory())
    attempts = []
    real_upload = FakeBlob.upload_from_file

    def upload(self, content, **kwargs):
        attempts.append(self.name)
        if len(attempts) == 1:
            # A racing writer takes the first name.
            bucket.objects[self.name] = FOREIGN
            raise PreconditionFailed("412 conditionNotMet")
        real_upload(self, content, **kwargs)
        raise TimeoutError("response lost after the write")

    mocker.patch.object(FakeBlob, "upload_from_file", upload)

    create_thumbnail(gfile)

    foreign_name, our_name = attempts
    assert foreign_name != our_name
    assert list(PendingUploadBlobDeletion.objects.values_list(
        "name", flat=True)) == [our_name]
    assert bucket.objects[foreign_name] == FOREIGN


@pytest.mark.django_db
def test_a_lost_response_leaves_one_object_and_nothing_to_collect(
        creator_factory, mocker, bucket):
    gfile = _image(creator_factory())
    real_upload = FakeBlob.upload_from_file

    def lost_response(self, content, **kwargs):
        real_upload(self, content, **kwargs)
        raise PreconditionFailed("412 conditionNotMet (retry of our own)")

    mocker.patch.object(FakeBlob, "upload_from_file", lost_response)

    create_thumbnail(gfile)

    webp = Webp.objects.get(parent=gfile)
    assert list(bucket.objects) == [webp.file.name]
    assert not PendingUploadBlobDeletion.objects.exists()
