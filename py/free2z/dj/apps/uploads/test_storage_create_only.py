"""`CreateOnlyGoogleCloudStorage`: a racing writer can never replace bytes.

No network: the bucket is an in-memory fake that honours GCS's
`if_generation_match=0` precondition (412 when a live object has the name).
"""
import pytest
import storages
from django.core.files.base import ContentFile
from google.api_core.exceptions import PreconditionFailed
from storages.backends.gcloud import GoogleCloudStorage

from dj.apps.uploads.storage import (
    CREATE_TOKEN_METADATA_KEY,
    POSSIBLY_WRITTEN_NAME_ATTR,
    CreateOnlyExhausted,
    CreateOnlyGoogleCloudStorage,
)


class FakeBlob:
    def __init__(self, name, bucket, chunk_size=None):
        self.name = name
        self.bucket = bucket
        # A blob fetched from the bucket carries the stored object's
        # custom metadata, like the real `Bucket.get_blob`.
        self.metadata = getattr(bucket, "metadata", {}).get(name)

    def upload_from_file(self, content, rewind=False, retry=None, size=None,
                         if_generation_match=None, **kwargs):
        if rewind:
            content.seek(0)
        if if_generation_match == 0 and self.name in self.bucket.objects:
            raise PreconditionFailed("412 conditionNotMet")
        self.bucket.objects[self.name] = content.read()
        if hasattr(self.bucket, "metadata"):
            self.bucket.metadata[self.name] = dict(self.metadata or {})


class Bucket:
    """Plain in-memory bucket: objects plus their custom metadata."""

    def __init__(self):
        self.objects = {}
        self.metadata = {}

    def get_blob(self, name, chunk_size=None):
        return FakeBlob(name, self) if name in self.objects else None


def _lose_the_response(mocker):
    """The create lands server-side, the response is lost, and the client
    library's own retry of the same request gets a 412 on that object."""
    real_upload = FakeBlob.upload_from_file

    def upload(self, content, **kwargs):
        real_upload(self, content, **kwargs)
        raise PreconditionFailed("412 conditionNotMet (retry of our own)")

    mocker.patch.object(FakeBlob, "upload_from_file", upload)


class RacingBucket:
    """The first existence check of `race_name` sees nothing, and a
    concurrent writer creates it right after -- the window between
    `get_available_name` and the upload."""

    def __init__(self, race_name):
        self.objects = {}
        self.metadata = {}
        self.race_name = race_name

    def get_blob(self, name, chunk_size=None):
        if name == self.race_name and name not in self.objects:
            self.objects[name] = b"the other writer's private bytes"
            return None
        return FakeBlob(name, self) if name in self.objects else None


def _storage(cls, bucket, mocker):
    mocker.patch("storages.backends.gcloud.Blob", FakeBlob)
    storage = cls(bucket_name="test-bucket", file_overwrite=False)
    storage._bucket = bucket
    return storage


def test_stock_backend_overwrites_the_racing_writers_object(mocker):
    """Negative control: the bug the subclass exists for."""
    bucket = RacingBucket("u/photo.jpg")
    storage = _storage(GoogleCloudStorage, bucket, mocker)

    saved = storage.save("u/photo.jpg", ContentFile(b"mine"))

    assert saved == "u/photo.jpg"
    assert bucket.objects["u/photo.jpg"] == b"mine"   # theirs is gone


def test_create_only_backend_never_overwrites_and_picks_a_new_name(mocker):
    bucket = RacingBucket("u/photo.jpg")
    storage = _storage(CreateOnlyGoogleCloudStorage, bucket, mocker)

    saved = storage.save("u/photo.jpg", ContentFile(b"mine"), max_length=100)

    assert saved != "u/photo.jpg"
    assert saved.startswith("u/photo_") and saved.endswith(".jpg")
    assert bucket.objects["u/photo.jpg"] == b"the other writer's private bytes"
    assert bucket.objects[saved] == b"mine"


def test_create_only_backend_gives_up_rather_than_overwrite(mocker):
    bucket = RacingBucket("u/photo.jpg")
    storage = _storage(CreateOnlyGoogleCloudStorage, bucket, mocker)
    mocker.patch.object(
        FakeBlob, "upload_from_file",
        side_effect=PreconditionFailed("412 conditionNotMet"))

    with pytest.raises(Exception, match="concurrent writer"):
        storage.save("u/photo.jpg", ContentFile(b"mine"))
    assert bucket.objects == {
        "u/photo.jpg": b"the other writer's private bytes"}


def test_overwrite_mode_is_left_alone(mocker):
    bucket = RacingBucket("u/photo.jpg")
    storage = _storage(CreateOnlyGoogleCloudStorage, bucket, mocker)
    storage.file_overwrite = True

    assert storage.save("u/photo.jpg", ContentFile(b"mine")) == "u/photo.jpg"
    assert bucket.objects["u/photo.jpg"] == b"mine"


def test_the_mirrored_upstream_save_is_the_pinned_version():
    """`CreateOnlyGoogleCloudStorage._save` copies django-storages 1.14.6's
    body. On a bump, re-diff it against the new upstream `_save` (anything it
    now sets on the blob or passes to upload_from_file must be carried over)
    and then update this pin."""
    assert storages.__version__ == "1.14.6"


def test_default_storage_is_the_create_only_backend(settings):
    assert settings.STORAGES["default"]["BACKEND"] == (
        "dj.apps.uploads.storage.CreateOnlyGoogleCloudStorage")


# ---: lost responses, and which key a failure may have written -------


def test_a_lost_response_adopts_our_own_object_instead_of_writing_twice(
        mocker):
    bucket = Bucket()
    storage = _storage(CreateOnlyGoogleCloudStorage, bucket, mocker)
    _lose_the_response(mocker)

    saved = storage.save("u/photo.jpg", ContentFile(b"mine"), max_length=100)

    # One object, under the first name, and it is the name the row gets:
    # nothing is orphaned, so nothing needs collecting.
    assert saved == "u/photo.jpg"
    assert bucket.objects == {"u/photo.jpg": b"mine"}


def test_lost_response_negative_control_without_the_token_check(mocker):
    """Negative control: with the read-back disabled the same lost response
    writes a second copy and leaves the first one with no row -- the orphan
     is about."""
    bucket = Bucket()
    storage = _storage(CreateOnlyGoogleCloudStorage, bucket, mocker)
    _lose_the_response(mocker)
    mocker.patch.object(
        CreateOnlyGoogleCloudStorage, "_is_own_object", return_value=False)

    with pytest.raises(CreateOnlyExhausted):
        # Every attempt "loses its response", so without the read-back all
        # five attempts each leave an object behind and the save fails.
        storage.save("u/photo.jpg", ContentFile(b"mine"), max_length=100)
    assert len(bucket.objects) == 5


def test_a_foreign_object_with_another_token_is_never_adopted(mocker):
    """Same bytes, different writer: the two-uploads-of-one-photo race."""
    bucket = RacingBucket("u/photo.jpg")
    bucket.metadata = {
        "u/photo.jpg": {CREATE_TOKEN_METADATA_KEY: "someone-elses-token"}}
    storage = _storage(CreateOnlyGoogleCloudStorage, bucket, mocker)

    saved = storage.save("u/photo.jpg", ContentFile(b"mine"), max_length=100)

    assert saved != "u/photo.jpg"
    assert bucket.objects["u/photo.jpg"] == b"the other writer's private bytes"
    assert bucket.objects[saved] == b"mine"


def test_a_failed_read_back_is_not_proof_of_ownership(mocker):
    bucket = Bucket()
    storage = _storage(CreateOnlyGoogleCloudStorage, bucket, mocker)
    _lose_the_response(mocker)
    # get_available_name still sees what is in the bucket...
    mocker.patch.object(
        storage, "exists", side_effect=lambda name: name in bucket.objects)
    real_get_blob = bucket.get_blob

    def unreadable_once_written(name, chunk_size=None):
        #...but reading an existing object's metadata back fails.
        if name in bucket.objects:
            raise ConnectionError("metadata read timed out")
        return real_get_blob(name, chunk_size)

    bucket.get_blob = unreadable_once_written

    with pytest.raises(CreateOnlyExhausted):
        storage.save("u/photo.jpg", ContentFile(b"mine"), max_length=100)
    # Unprovable, so never adopted: leaked rather than risk serving (or
    # outboxing) an object that might be another writer's.
    assert "u/photo.jpg" in bucket.objects
    assert len(bucket.objects) == 5


def test_the_token_is_merged_into_object_parameter_metadata(mocker):
    bucket = Bucket()
    storage = _storage(CreateOnlyGoogleCloudStorage, bucket, mocker)
    storage.object_parameters = {"metadata": {"kept": "yes"}}

    storage.save("u/photo.jpg", ContentFile(b"mine"))

    stored = bucket.metadata["u/photo.jpg"]
    assert stored["kept"] == "yes"
    assert len(stored[CREATE_TOKEN_METADATA_KEY]) == 32


def test_exhaustion_says_nothing_of_ours_was_written(mocker):
    bucket = RacingBucket("u/photo.jpg")
    storage = _storage(CreateOnlyGoogleCloudStorage, bucket, mocker)
    mocker.patch.object(
        FakeBlob, "upload_from_file",
        side_effect=PreconditionFailed("412 conditionNotMet"))

    with pytest.raises(CreateOnlyExhausted) as raised:
        storage.save("u/photo.jpg", ContentFile(b"mine"))
    assert getattr(raised.value, POSSIBLY_WRITTEN_NAME_ATTR) is None


def test_a_failed_upload_names_its_own_key_not_the_racing_writers(mocker):
    """Attempt 1 412s on a foreign object; attempt 2, under a new name,
    times out after the write. The key to collect is attempt 2's."""
    bucket = RacingBucket("u/photo.jpg")
    storage = _storage(CreateOnlyGoogleCloudStorage, bucket, mocker)
    real_upload = FakeBlob.upload_from_file

    def upload(self, content, **kwargs):
        real_upload(self, content, **kwargs)
        raise TimeoutError("response lost after the write")

    mocker.patch.object(FakeBlob, "upload_from_file", upload)

    with pytest.raises(TimeoutError) as raised:
        storage.save("u/photo.jpg", ContentFile(b"mine"), max_length=100)

    written = getattr(raised.value, POSSIBLY_WRITTEN_NAME_ATTR)
    assert written != "u/photo.jpg"
    assert bucket.objects[written] == b"mine"


def test_a_timeout_on_a_key_a_racing_writer_holds_names_no_key(mocker):
    """codex round 1: a racing writer creates the key and our request times
    out before the 412 arrives. That key is theirs -- possibly with its row
    not yet committed, so the outbox's reference check cannot protect it."""
    bucket = Bucket()
    storage = _storage(CreateOnlyGoogleCloudStorage, bucket, mocker)

    def upload(self, content, **kwargs):
        bucket.objects[self.name] = b"theirs"
        bucket.metadata[self.name] = {CREATE_TOKEN_METADATA_KEY: "theirs"}
        raise TimeoutError("timed out before the 412")

    mocker.patch.object(FakeBlob, "upload_from_file", upload)

    with pytest.raises(TimeoutError) as raised:
        storage.save("u/photo.jpg", ContentFile(b"mine"))
    assert getattr(raised.value, POSSIBLY_WRITTEN_NAME_ATTR) is None


def test_a_timeout_with_nothing_written_yet_still_names_the_key(mocker):
    """The request may still land: collect the key, as before."""
    bucket = Bucket()
    storage = _storage(CreateOnlyGoogleCloudStorage, bucket, mocker)
    mocker.patch.object(
        FakeBlob, "upload_from_file", side_effect=TimeoutError("timed out"))

    with pytest.raises(TimeoutError) as raised:
        storage.save("u/photo.jpg", ContentFile(b"mine"))
    assert getattr(raised.value, POSSIBLY_WRITTEN_NAME_ATTR) == "u/photo.jpg"


def test_a_failure_before_any_upload_names_no_key(mocker):
    bucket = Bucket()
    storage = _storage(CreateOnlyGoogleCloudStorage, bucket, mocker)
    mocker.patch.object(
        storage, "exists", side_effect=ConnectionError("exists() failed"))

    with pytest.raises(ConnectionError) as raised:
        storage.save("u/photo.jpg", ContentFile(b"mine"))
    assert getattr(raised.value, POSSIBLY_WRITTEN_NAME_ATTR) is None
    assert bucket.objects == {}
