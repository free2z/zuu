"""DELETE requests get the request-wide transaction too.

``AtomicMiddleware`` used to wrap POST/PUT/PATCH only, so a DELETE ran in
autocommit: every statement committed on its own, and a DELETE that did two
things and then failed kept the first. The inventory in the PR  found:

* **Storage deleted before the database said so.** The two KYC delete routes
  removed the blob inline and THEN saved the row; a failed save left the row
  pointing at an object that no longer existed. They now clear the column and
  record the key in the upload deletion outbox (``PendingUploadBlobDeletion``)
  in the same transaction, and the worker deletes the object after COMMIT --
  exactly what ``GenericFile`` deletion already does.
* **Locks that only worked because of a decorator.** The conditional zPage
  and variant deletes call ``select_for_update()``, which in autocommit raises
  ``TransactionManagementError``. Each carries its own ``@transaction.atomic``
  for exactly that reason; the tests below pin the ``If-Match`` DELETE paths
  under a real (``transaction=True``) connection, which the existing
  precondition tests do not -- the default marker wraps every test in a
  transaction, so a missing decorator would never have shown there.
* Everything else was one ``Model.delete()`` / ``QuerySet.delete()`` (already
  atomic inside Django's ``Collector``) or already had an explicit
  ``transaction.atomic()``. Wrapping DELETE adds the request's own auth,
  permission and response-render work to the lock window; no DELETE path
  makes an external call inside it.

``django_db(transaction=True)`` is MANDATORY throughout, for the reason the
variant bug hid: under the default marker the test itself is the transaction,
and what persists cannot be observed the way production observes it.
"""
import uuid
from io import BytesIO

import pytest
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db import connection
from django.urls import get_resolver
from PIL import Image
from rest_framework.test import APIClient

from dj.apps.g12f.models import ZPageTranslation, zPage
from dj.apps.kyc.models import W9, UserProfile
from dj.apps.uploads.models import GenericFile, PendingUploadBlobDeletion
from dj.apps.uploads.tasks import delete_pending_blob
from dj.util.middleware import ATOMIC_METHODS

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    # Only the external boundary (GCS) is swapped; the database is real.
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    }
    settings.MEDIA_ROOT = str(tmp_path)


def _client(user):
    # raise_request_exception=False: a real client sees the 500 response.
    client = APIClient(raise_request_exception=False)
    client.force_authenticate(user)
    return client


def _png():
    out = BytesIO()
    Image.new("RGB", (8, 8), (1, 2, 3)).save(out, format="PNG")
    return out.getvalue()


def test_the_engine_is_postgres():
    assert connection.vendor == "postgresql"


def test_delete_is_an_atomic_method():
    assert "DELETE" in ATOMIC_METHODS


# --- the view runs inside the request transaction ----------------------------

def test_a_delete_view_runs_inside_a_transaction(creator_factory, monkeypatch):
    """The direct observation: not "did it return 204" but "was there a
    transaction around the view" (a status code cannot see one)."""
    from dj.apps.uploads.views import MyUploadsViewSet

    seen = []
    original = MyUploadsViewSet.perform_destroy

    def spy(self, instance):
        seen.append(connection.in_atomic_block)
        return original(self, instance)

    monkeypatch.setattr(MyUploadsViewSet, "perform_destroy", spy)
    owner = creator_factory()
    upload = GenericFile.objects.create(
        owner=owner, file=ContentFile(_png(), name="a.png"),
        mime_type="image/png",
    )

    response = _client(owner).delete(f"/api/myuploads/{upload.pk}/")

    assert response.status_code == 204, response.content
    assert seen == [True]


# --- uploads: row delete + deletion outbox --------------------------------

def test_an_upload_delete_that_fails_after_the_row_delete_keeps_everything(
    creator_factory, monkeypatch,
):
    """Row delete, outbox rows and the on_commit enqueue all run; then the
    request fails. Nothing of it may survive: the row, its blob and no
    deletion intent for a blob a live row still owns."""
    from dj.apps.uploads import tasks as upload_tasks
    from dj.apps.uploads.views import MyUploadsViewSet

    original = MyUploadsViewSet.perform_destroy

    def delete_then_fail(self, instance):
        original(self, instance)
        raise RuntimeError("failure after the row delete")

    enqueued = []
    monkeypatch.setattr(MyUploadsViewSet, "perform_destroy", delete_then_fail)
    monkeypatch.setattr(
        upload_tasks, "enqueue_blob_cleanup", lambda pk: enqueued.append(pk))
    owner = creator_factory()
    upload = GenericFile.objects.create(
        owner=owner, file=ContentFile(_png(), name="keep.png"),
        mime_type="image/png",
    )
    name = upload.file.name

    response = _client(owner).delete(f"/api/myuploads/{upload.pk}/")

    assert response.status_code == 500
    assert GenericFile.objects.filter(pk=upload.pk).exists(), (
        "the upload row was deleted by a DELETE that failed: it ran in "
        "autocommit, outside AtomicMiddleware (#2108)"
    )
    assert not PendingUploadBlobDeletion.objects.filter(name=name).exists()
    assert enqueued == []
    assert default_storage.exists(name)


def test_an_upload_delete_that_succeeds_still_goes_through_the_outbox(
    creator_factory,
):
    owner = creator_factory()
    upload = GenericFile.objects.create(
        owner=owner, file=ContentFile(_png(), name="gone.png"),
        mime_type="image/png",
    )
    name = upload.file.name

    response = _client(owner).delete(f"/api/myuploads/{upload.pk}/")

    assert response.status_code == 204, response.content
    assert not GenericFile.objects.filter(pk=upload.pk).exists()
    pending = PendingUploadBlobDeletion.objects.get(name=name)
    # Storage is untouched until the worker runs, after the commit.
    assert default_storage.exists(name)
    delete_pending_blob(pending_blob_id=pending.pk)
    assert not default_storage.exists(name)


# --- zPage variants: a conditional delete must be able to take its lock ----

def _page(creator):
    return zPage.objects.create(
        creator=creator, free2zaddr=str(uuid.uuid4()), title="t",
        description="d", content="c", source_language="en",
        is_published=True,
    )


def test_a_conditional_variant_delete_can_take_its_row_lock(creator_factory):
    """``If-Match`` locks the parent row with ``select_for_update()``, which
    raises ``TransactionManagementError`` (a 500) outside a transaction."""
    creator = creator_factory()
    page = _page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="fr", description="fr",
        content="corps", is_published=True,
    )
    client = _client(creator)
    url = f"/api/zpage/{page.free2zaddr}/variants/fr/"
    etag = client.get(url)["ETag"]

    response = client.delete(url, HTTP_IF_MATCH=etag)

    assert response.status_code == 204, response.content
    assert not ZPageTranslation.objects.filter(
        zpage=page, language="fr").exists()


def test_a_stale_conditional_variant_delete_is_refused_not_crashed(
    creator_factory,
):
    creator = creator_factory()
    page = _page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="fr", description="fr",
        content="corps", is_published=True,
    )
    client = _client(creator)
    url = f"/api/zpage/{page.free2zaddr}/variants/fr/"
    stale = client.get(url)["ETag"]
    ZPageTranslation.objects.filter(zpage=page, language="fr").update(
        content="retravaillé")

    response = client.delete(url, HTTP_IF_MATCH=stale)

    assert response.status_code == 412, response.content
    assert ZPageTranslation.objects.filter(zpage=page, language="fr").exists()


# --- KYC: storage is deleted only after the database commits ---------------

def _profile_with_id_front(user):
    profile = UserProfile.objects.create(user=user)
    profile.id_front.save("front.png", ContentFile(_png()), save=True)
    return profile


def test_a_failed_identity_document_delete_keeps_the_blob(
    creator_factory, monkeypatch,
):
    """The old view deleted the object from storage, THEN saved the row. A
    failing save left the row pointing at a blob that no longer existed."""
    user = creator_factory()
    profile = _profile_with_id_front(user)
    name = profile.id_front.name
    assert default_storage.exists(name)

    def failing_save(self, *args, **kwargs):
        raise RuntimeError("the row write failed")

    monkeypatch.setattr(UserProfile, "save", failing_save)
    response = _client(user).delete(
        "/api/kyc/identity-documents", {"doc_type": "id_front"}, format="json")

    assert response.status_code == 500
    assert default_storage.exists(name), (
        "the identity document was deleted from storage by a request whose "
        "database write failed"
    )
    assert UserProfile.objects.get(pk=profile.pk).id_front.name == name
    assert not PendingUploadBlobDeletion.objects.filter(name=name).exists()


def test_an_identity_document_delete_clears_the_row_then_the_worker_deletes(
    creator_factory,
):
    user = creator_factory()
    profile = _profile_with_id_front(user)
    name = profile.id_front.name

    response = _client(user).delete(
        "/api/kyc/identity-documents", {"doc_type": "id_front"}, format="json")

    assert response.status_code == 200, response.content
    assert response.json()["id_front_url"] is None
    assert not UserProfile.objects.get(pk=profile.pk).id_front
    pending = PendingUploadBlobDeletion.objects.get(name=name)
    assert default_storage.exists(name)
    delete_pending_blob(pending_blob_id=pending.pk)
    assert not default_storage.exists(name)


def _w9_with_file(user):
    profile = UserProfile.objects.create(
        user=user, is_us=True, is_individual=True)
    w9 = W9.objects.create(
        profile=profile, full_name="A", tax_classification="i",
        address="a", city_state_zip="c",
    )
    w9.file.save("w9.pdf", ContentFile(b"%PDF-1.4 test"), save=True)
    return w9


def test_a_failed_tax_form_delete_keeps_the_blob(creator_factory, monkeypatch):
    user = creator_factory()
    w9 = _w9_with_file(user)
    name = w9.file.name

    def failing_save(self, *args, **kwargs):
        raise RuntimeError("the row write failed")

    monkeypatch.setattr(W9, "save", failing_save)
    response = _client(user).delete("/api/kyc/delete-tax-form")

    assert response.status_code == 500
    assert default_storage.exists(name)
    assert W9.objects.get(pk=w9.pk).file.name == name
    assert not PendingUploadBlobDeletion.objects.filter(name=name).exists()


def test_a_tax_form_delete_clears_the_row_then_the_worker_deletes(
    creator_factory,
):
    user = creator_factory()
    w9 = _w9_with_file(user)
    name = w9.file.name

    response = _client(user).delete("/api/kyc/delete-tax-form")

    assert response.status_code == 204, response.content
    assert not W9.objects.get(pk=w9.pk).file
    pending = PendingUploadBlobDeletion.objects.get(name=name)
    assert default_storage.exists(name)
    delete_pending_blob(pending_blob_id=pending.pk)
    assert not default_storage.exists(name)


# --- the inventory, enforced -------------------------------------------------

#DELETE handlers that deliberately run WITHOUT the request transaction, and
#why that is safe. Adding a view here is a reviewed decision; the test below
#fails on any DELETE-capable view that opts out and is not listed.
DELETE_AUTOCOMMIT_ALLOWED = {
    # Opted out class-wide for the paid-comment create path (its idempotency
    # claim must commit before the money transaction). `destroy` is one
    # `Comment.delete()`: a single Collector, atomic inside Django itself.
    "dj.apps.comments.views.CommentViewSet",
    # Opted out for the 10-90s provider stream in `create`. `destroy`
    # is one `PromptResponse.delete()`, atomic inside the Collector.
    "dj.apps.openai.views.PromptResponseViewSet",
}


def _walk(patterns):
    for entry in patterns:
        if hasattr(entry, "url_patterns"):
            yield from _walk(entry.url_patterns)
        else:
            yield entry.callback


def _handles_delete(view):
    actions = getattr(view, "actions", None)
    if actions is not None:  # a DRF ViewSet route
        return "delete" in actions
    cls = getattr(view, "cls", None) or getattr(view, "view_class", None)
    return cls is not None and hasattr(cls, "delete")


def test_every_delete_route_is_atomic_or_explicitly_allowed():
    seen, opted_out = set(), set()
    for view in _walk(get_resolver().url_patterns):
        if not _handles_delete(view):
            continue
        cls = getattr(view, "cls", None) or getattr(view, "view_class", None)
        if cls is None:
            non_atomic = "default" in getattr(view, "_non_atomic_requests", ())
            name = f"{view.__module__}.{view.__qualname__}"
        else:
            non_atomic = (
                getattr(cls, "atomic_request", True) is False
                or "DELETE" in getattr(cls, "non_atomic_methods", ())
            )
            name = f"{cls.__module__}.{cls.__qualname__}"
        seen.add(name)
        if non_atomic:
            opted_out.add(name)
    # The walk is not vacuous: it reaches the routes this issue is about.
    assert {
        "dj.apps.uploads.views.MyUploadsViewSet",
        "dj.apps.g12f.views.zpage.zPageView",
        "dj.apps.kyc.views.IdentityDocumentsView",
        "dj.apps.kyc.views.TaxFormDeleteView",
        "dj.apps.emails.views.DeleteEmailView",
    } <= seen, sorted(seen)
    assert opted_out == DELETE_AUTOCOMMIT_ALLOWED, (
        "a DELETE route opted out of AtomicMiddleware without being reviewed "
        "(or an allowed one no longer exists); see DELETE_AUTOCOMMIT_ALLOWED"
    )
