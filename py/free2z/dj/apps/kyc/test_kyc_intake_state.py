"""State-handling invariants the SvelteKit intake flow depends on.

The flow uploads one document per request and derives every "is this step
done?" answer from the server, so two things have to hold that nothing
previously asserted:

  * a write to one document column must not carry the rest of the row with it
    (two uploads in flight over the same profile is the normal case, not an
    edge case);
  * the applicant must be able to CLEAR their electronic signature, because a
    signature that outlives the tax form it signed is not a signature.

Real Postgres, per the repo rule: these are all about what actually lands in
the row, and a mock would assert nothing.
"""
import pytest

from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test.utils import CaptureQueriesContext

from dj.apps.kyc.models import UserProfile


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    # Default storage is GCS; only that external boundary is swapped.
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    }
    settings.MEDIA_ROOT = str(tmp_path)


PNG = (
    b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01'
    b'\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01'
    b'\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82'
)

IDENTITY_URL = "/api/kyc/identity-documents"


@pytest.fixture
def applicant(creator_factory):
    user = creator_factory()
    profile = UserProfile.objects.create(
        user=user, is_us=True, is_individual=True)
    return user, profile


def _png(name):
    return SimpleUploadedFile(name, PNG, content_type="image/png")


@pytest.mark.django_db
def test_document_upload_writes_only_the_columns_it_touched(api_client, applicant):
    """A per-field upload must not restate the whole row.

    The intake page uploads each document in its own request, so a person who
    picks the ID front and the ID back a second apart has two requests holding
    two snapshots of the same profile. With a blanket ``profile.save()`` the
    later one writes ITS copy of every column and silently reverts the other
    upload — and could revert ``application_status`` from PENDING to NEW if a
    submit raced an upload.
    """
    user, profile = applicant
    api_client.force_authenticate(user=user)

    with CaptureQueriesContext(connection) as queries:
        response = api_client.post(
            IDENTITY_URL, {"id_front": _png("front.png")}, format="multipart")

    assert response.status_code == 200, response.content

    updates = [
        q["sql"] for q in queries.captured_queries
        if q["sql"].lstrip().upper().startswith("UPDATE")
        and '"kyc_userprofile"' in q["sql"]
    ]
    assert updates, "expected an UPDATE on kyc_userprofile"

    for sql in updates:
        assert "id_front" in sql
        # The columns this request had no business writing.
        assert "application_status" not in sql, sql
        assert "id_back" not in sql, sql
        assert "live_photo" not in sql, sql
        assert "tax_form_signature" not in sql, sql


@pytest.mark.django_db
def test_document_delete_writes_only_the_column_it_cleared(api_client, applicant):
    """Same invariant for the delete path.

    ``FieldFile.delete()`` defaults to saving the whole model, which has
    exactly the clobbering problem above.
    """
    user, profile = applicant
    api_client.force_authenticate(user=user)
    api_client.post(IDENTITY_URL, {"id_back": _png("back.png")}, format="multipart")

    with CaptureQueriesContext(connection) as queries:
        response = api_client.delete(
            IDENTITY_URL, {"doc_type": "id_back"}, format="json")

    assert response.status_code == 200, response.content
    assert response.data["id_back_url"] is None

    updates = [
        q["sql"] for q in queries.captured_queries
        if q["sql"].lstrip().upper().startswith("UPDATE")
        and '"kyc_userprofile"' in q["sql"]
    ]
    assert updates, "expected an UPDATE on kyc_userprofile"
    for sql in updates:
        assert "id_back" in sql
        assert "application_status" not in sql, sql
        assert "id_front" not in sql, sql


@pytest.mark.django_db
def test_a_second_upload_does_not_revert_the_first(api_client, applicant):
    """The end-to-end shape of the same thing, from the applicant's side."""
    user, _ = applicant
    api_client.force_authenticate(user=user)

    api_client.post(IDENTITY_URL, {"id_front": _png("front.png")}, format="multipart")
    response = api_client.post(
        IDENTITY_URL, {"id_back": _png("back.png")}, format="multipart")

    assert response.status_code == 200, response.content
    assert response.data["id_front_url"], "the first upload was lost"
    assert response.data["id_back_url"]


@pytest.mark.django_db
def test_an_upload_never_moves_the_application_status(api_client, applicant):
    """The status is the identity-verification gate; a file upload is not a
    status change and must never write that column."""
    user, profile = applicant
    api_client.force_authenticate(user=user)

    api_client.post(IDENTITY_URL, {"id_front": _png("front.png")}, format="multipart")

    profile.refresh_from_db()
    assert profile.application_status == "NEW"


@pytest.mark.django_db
def test_first_ever_upload_works_on_a_row_created_by_the_request_itself(
    api_client, creator_factory,
):
    """The very first request a new applicant makes.

    ``get_or_create`` inserts the profile inside this same request, and the
    upload then saves with ``update_fields``. That combination is worth its own
    test: ``save(update_fields=...)`` forces an UPDATE rather than an INSERT, so
    on a row the request has only just created it is exactly the kind of thing
    that works everywhere except the one path nobody exercised.
    """
    user = creator_factory()
    assert not UserProfile.objects.filter(user=user).exists()
    api_client.force_authenticate(user=user)

    response = api_client.post(
        IDENTITY_URL, {"id_front": _png("front.png")}, format="multipart")

    assert response.status_code == 200, response.content
    assert response.data["id_front_url"]

    profile = UserProfile.objects.get(user=user)
    assert profile.id_front
    assert profile.application_status == "NEW"


@pytest.mark.django_db
def test_a_post_with_no_files_is_a_harmless_no_op(api_client, applicant):
    """No files, nothing written.

    ``save(update_fields=[])`` is a Django no-op, which is the behaviour we
    want; the guard exists so an empty POST cannot become a bare ``save()``
    that restates the whole row.
    """
    user, profile = applicant
    api_client.force_authenticate(user=user)

    response = api_client.post(IDENTITY_URL, {}, format="multipart")

    assert response.status_code == 200, response.content
    assert response.data["id_front_url"] is None


@pytest.mark.django_db
def test_signature_can_be_cleared(api_client, applicant):
    """Replacing the tax form has to be able to invalidate the old signature.

    ``tax_form_signature`` lives on the profile rather than on the tax form, so
    swapping the PDF leaves the typed name attached to a document nobody
    signed. The intake flow clears it by posting an empty string; if the API
    rejected that, the flow would silently keep the stale signature.
    """
    user, profile = applicant
    api_client.force_authenticate(user=user)

    signed = api_client.post(
        "/api/kyc/tax-form-signature",
        {"tax_form_signature": "Ada Lovelace"},
        format="json",
    )
    assert signed.status_code == 200, signed.content

    cleared = api_client.post(
        "/api/kyc/tax-form-signature",
        {"tax_form_signature": ""},
        format="json",
    )
    assert cleared.status_code == 200, cleared.content

    profile.refresh_from_db()
    assert profile.tax_form_signature == ""


@pytest.mark.django_db
def test_rejection_reason_is_readable_but_not_writable(api_client, applicant):
    """A reviewer writes it in the admin; the applicant only reads it.

    Read matters because "rejected" with no reason is a dead end. Not-writable
    matters for the same reason ``application_status`` is not writable: nothing
    the applicant sends should be able to edit the review record.
    """
    user, profile = applicant
    api_client.force_authenticate(user=user)

    profile.rejection_reason = "The back of the ID is cut off."
    profile.application_status = "REJECTED"
    profile.save(update_fields=["rejection_reason", "application_status"])

    read = api_client.get("/api/kyc/user-profile")
    assert read.status_code == 200, read.content
    assert read.data["rejection_reason"] == "The back of the ID is cut off."

    # REJECTED is not editable, so this is refused outright...
    blocked = api_client.post(
        "/api/kyc/user-profile",
        {"rejection_reason": "actually it was fine"},
        format="json",
    )
    assert blocked.status_code == 400, blocked.content

    #...and even from an editable state the field is read-only.
    profile.application_status = "NEW"
    profile.save(update_fields=["application_status"])
    ignored = api_client.post(
        "/api/kyc/user-profile",
        {"is_us": True, "rejection_reason": "actually it was fine"},
        format="json",
    )
    assert ignored.status_code in (200, 201), ignored.content
    profile.refresh_from_db()
    assert profile.rejection_reason == "The back of the ID is cut off."
