"""Create-only Google Cloud Storage writes for `file_overwrite=False`.

`Storage.save` picks a name with `get_available_name` -- an `exists()` round
trip -- and then django-storages uploads to it unconditionally. Two writers
that pick the same free name therefore both "win": the second silently
replaces the first one's bytes. Before `uploads_genericfile_file_uniq` that
left two rows on one object; with the constraint the loser's INSERT is
rolled back, but its bytes are what the winner's row now serves. A creator
uploading `photo.jpg` publicly and `photo.jpg` privately at the same moment
would publish the private one under the public row.

This backend closes the gap at the storage layer, the only place it can be
closed: every upload is sent with `if_generation_match=0` ("create only if no
live object has this name"). A 412 means another writer got there first; the
save is retried from the top, where `get_available_name` now sees that object
and picks an alternative. The local `FileSystemStorage` has always behaved
this way (`O_CREAT | O_EXCL` plus the same retry), so dev and tests were
never exposed.

`file_overwrite=True` keeps the stock behaviour: overwrite is what it asks
for.

Lost responses. If an upload succeeds server-side but its response
is lost, the client library's retry gets a 412 on its OWN object. Treated as
a foreign writer, that would move the save on to a new name and leave the
first object with no row -- an orphan nobody can collect, because nothing
can tell it apart from a racing writer's object by name, size or hash (two
concurrent uploads of the same photo have identical bytes; that is the very
race above), so it could never safely go in the deletion outbox. Instead
every attempt stamps its object with a random per-attempt token in custom
metadata (`CREATE_TOKEN_METADATA_KEY`), written atomically with the bytes.
On a 412 the live object's metadata is read back: our token means the create
DID happen, and the save adopts that name -- no second copy, no orphan,
nothing to collect. Any other token, no token, or a failed read means "not
provably ours", and the save moves on as before. Only that last case (a lost
response AND a failed read-back) still leaks bytes (never served: every
`/uploadz/` read is authorized against a row), and it leaks rather than risk
deleting a racing writer's object.

Failure contract for callers that must outbox a key they may have written
(`tasks._save_generated_file`): an exception out of `save` carries
`POSSIBLY_WRITTEN_NAME_ATTR` -- the one key the failed call may have left
behind, or None when it wrote nothing of its own (every candidate 412'd on a
foreign object: `CreateOnlyExhausted`; or it failed before reaching the
upload). It is never a name another writer created.
"""
import logging
import uuid

from django.core.exceptions import SuspiciousFileOperation
from google.api_core.exceptions import PreconditionFailed
from storages.backends.gcloud import (
    CONTENT_ENCODING,
    CONTENT_TYPE,
    DEFAULT_RETRY,
    GoogleCloudFile,
    GoogleCloudStorage,
)
from storages.utils import clean_name

# A collision needs a concurrent writer on the same name; each retry picks a
# fresh random suffix, so a second collision is already vanishingly unlikely.
CREATE_ONLY_ATTEMPTS = 5

# Custom object metadata (served as `x-goog-meta-f2z-create-token`). A fresh
# uuid4 per attempt: it identifies nothing but that one upload request.
CREATE_TOKEN_METADATA_KEY = "f2z-create-token"

# Set on every exception `CreateOnlyGoogleCloudStorage.save` raises: the key
# the failed call may have written, or None if it wrote nothing of its own.
POSSIBLY_WRITTEN_NAME_ATTR = "create_only_possibly_written_name"

logger = logging.getLogger(__name__)


class CreateOnlyExhausted(SuspiciousFileOperation):
    """Every candidate name was already taken by another writer's object.

    Nothing of this call's was written (short of a lost response whose
    read-back also failed -- see the module docstring).
    """


class CreateOnlyGoogleCloudStorage(GoogleCloudStorage):

    def save(self, name, content, max_length=None):
        if self.file_overwrite:
            return super().save(name, content, max_length=max_length)
        for _ in range(CREATE_ONLY_ATTEMPTS):
            try:
                return super().save(name, content, max_length=max_length)
            except PreconditionFailed:
                # Someone else created this name between our exists() check
                # and our upload (`_save` has already ruled out our own lost
                # response). Their object is untouched; pick another name.
                continue
            except Exception as exc:
                # `_save` tags a failure of the upload request itself with
                # its key. Anything untagged failed before a byte of this
                # attempt was sent (name validation, the exists() round trip,
                # blob setup), and every earlier attempt 412'd on an object
                # that is not ours: nothing of this call's is in the bucket.
                if not hasattr(exc, POSSIBLY_WRITTEN_NAME_ATTR):
                    setattr(exc, POSSIBLY_WRITTEN_NAME_ATTR, None)
                raise
        exc = CreateOnlyExhausted(
            f'Could not create a new object for {name!r} after '
            f'{CREATE_ONLY_ATTEMPTS} attempts: every candidate name was '
            'taken by a concurrent writer.')
        setattr(exc, POSSIBLY_WRITTEN_NAME_ATTR, None)
        raise exc

    def _is_own_object(self, blob_name, token):
        """True only if the live object at *blob_name* carries *token*.

        A failed read is "not provably ours" (False): adopting a foreign
        object would serve someone else's bytes under our row.
        """
        try:
            blob = self.bucket.get_blob(blob_name)
        except Exception:
            logger.warning(
                "create-only: could not read %s back after a 412; treating "
                "it as another writer's object (if it was our own lost "
                "response, those bytes are leaked)",
                blob_name, exc_info=True,
            )
            return False
        if blob is None:
            return False
        metadata = blob.metadata or {}
        return metadata.get(CREATE_TOKEN_METADATA_KEY) == token

    def _may_be_ours(self, blob_name, token):
        """After an ambiguous (non-412) upload failure: may this call have
        left an object at *blob_name* that it is safe to queue for deletion?

        - our token on it: yes, it is ours;
        - nothing there: yes -- nobody else's object is there to lose, and
          a request that is still in flight may yet land ours (the
          pre- behaviour: collect the attempted key);
        - any other object, or a failed read: no. Another writer may own
          it, possibly with its row not yet committed, so the outbox's
          live-reference check would not protect it. Unprovable: leaked.
        """
        try:
            blob = self.bucket.get_blob(blob_name)
        except Exception:
            logger.warning(
                "create-only: could not read %s back after a failed upload; "
                "not queueing it for deletion (if it was ours, it is leaked)",
                blob_name, exc_info=True,
            )
            return False
        if blob is None:
            return True
        metadata = blob.metadata or {}
        return metadata.get(CREATE_TOKEN_METADATA_KEY) == token

    def _save(self, name, content):
        # Mirrors django-storages 1.14.6 GoogleCloudStorage._save (pinned in
        # py/requirements/main.txt; test_storage_create_only.py fails if the
        # upstream body changes) with two additions: if_generation_match=0,
        # and the per-attempt create token below.
        if self.file_overwrite:
            return super()._save(name, content)

        cleaned_name = clean_name(name)
        name = self._normalize_name(cleaned_name)

        content.name = cleaned_name
        file_object = GoogleCloudFile(name, "rw", self)

        blob_params = self.get_object_parameters(name)
        if file_object.mime_encoding and CONTENT_ENCODING not in blob_params:
            blob_params[CONTENT_ENCODING] = file_object.mime_encoding

        upload_params = {}
        upload_params["predefined_acl"] = blob_params.pop(
            "acl", self.default_acl)
        upload_params[CONTENT_TYPE] = blob_params.pop(
            CONTENT_TYPE, file_object.mime_type
        )

        if (
            self.gzip
            and upload_params[CONTENT_TYPE] in self.gzip_content_types
            and CONTENT_ENCODING not in blob_params
        ):
            content = self._compress_content(content)
            blob_params[CONTENT_ENCODING] = "gzip"

        for prop, val in blob_params.items():
            setattr(file_object.blob, prop, val)

        # Addition 2: a per-attempt token, merged into whatever
        # metadata the object parameters set, so a 412 on our own lost
        # response can be told apart from a racing writer's object.
        token = uuid.uuid4().hex
        metadata = dict(file_object.blob.metadata or {})
        metadata[CREATE_TOKEN_METADATA_KEY] = token
        file_object.blob.metadata = metadata

        try:
            file_object.blob.upload_from_file(
                content,
                rewind=True,
                retry=DEFAULT_RETRY,
                size=getattr(content, "size", None),
                if_generation_match=0,
                **upload_params,
            )
        except PreconditionFailed:
            if self._is_own_object(file_object.blob.name, token):
                # The create succeeded and only its response was lost; the
                # client's retry then hit our own object. Adopt it.
                logger.info(
                    "create-only: adopted %s after a lost upload response",
                    name)
                return cleaned_name
            raise
        except Exception as exc:
            # A timeout or 5xx can arrive after the object was committed --
            # or before our request ever reached a key a racing writer had
            # already created. Only claim the key when that is not the case.
            setattr(
                exc, POSSIBLY_WRITTEN_NAME_ATTR,
                cleaned_name
                if self._may_be_ours(file_object.blob.name, token) else None)
            raise
        return cleaned_name
