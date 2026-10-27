"""
Video poster-frame pipeline, against real Postgres.

Google Search Console reports every zPage video as *"No thumbnail URL
provided"*. `thumbnailUrl` is REQUIRED on a `VideoObject`, so the whole
structured-data fix rests on a poster still actually existing — which is
what these tests pin.

Videos are SYNTHESISED here with `av` rather than committed as fixtures, so
the assertions are about a real encode/decode round trip through the same
library production uses, at whatever geometry a case needs. `av` is in
`py/requirements/main.txt`, i.e. installed in CI and in the deployed image;
this module imports it at the top on purpose, so a missing dependency is a
loud collection error rather than a quietly skipped suite.
"""
import json
import logging
import os
import signal
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from io import BytesIO, StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import av
import pytest
from google.api_core.exceptions import NotFound
from PIL import Image

from django.core.files.base import ContentFile
from django.utils import timezone

from procrastinate.contrib.django.models import ProcrastinateJob

from dj.apps.uploads.models import GenericFile, ImageVariant
from dj.apps.uploads.serializers import GenericFileSerializer
from dj.apps.uploads import tasks as upload_tasks
from dj.apps.uploads.tasks import generate_video_poster
from dj.apps.uploads import video_utils
from dj.apps.g12f import embedded_media


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
        },
    }
    settings.MEDIA_ROOT = str(tmp_path)


def _mp4_bytes(width=320, height=240, seconds=3, fps=10, colour_step=8):
    """A real, decodable H.264/MP4 clip whose frames change over time."""
    buffer = BytesIO()
    container = av.open(buffer, mode="w", format="mp4")
    stream = container.add_stream("libx264", rate=fps)
    stream.width = width
    stream.height = height
    stream.pix_fmt = "yuv420p"
    for index in range(seconds * fps):
        value = (index * colour_step) % 256
        image = Image.new("RGB", (width, height), (value, value, value))
        frame = av.VideoFrame.from_image(image)
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode():
        container.mux(packet)
    container.close()
    return buffer.getvalue()


def _make_video(creator, access="public", name="clip.mp4", **kwargs):
    return GenericFile.objects.create(
        owner=creator,
        file=ContentFile(_mp4_bytes(**kwargs), name=name),
        mime_type="video/mp4",
        access=access,
    )


def _clear_poster_jobs():
    """Clear unmanaged Procrastinate rows left by transaction=True tests."""
    from django.db import connection

    with connection.cursor() as cursor:
        cursor.execute(
            "DELETE FROM procrastinate_jobs WHERE task_name = %s",
            ["uploads.generate_video_poster"],
        )


# ---------------------------------------------------------------------------
# enqueue
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_creating_a_video_enqueues_a_poster_job(creator_factory):
    creator = creator_factory()

    gfile = GenericFile.objects.create(
        owner=creator,
        file=ContentFile(b"not-really-mp4", name="clip.mp4"),
        mime_type="video/mp4",
    )

    job = ProcrastinateJob.objects.filter(
        task_name="uploads.generate_video_poster",
        args={"generic_file_id": gfile.pk},
    ).get()
    # HELD for the rollout window. `uploads.generate_video_poster` is a NEW
    # task name: during a deploy a new web pod can accept a video while an
    # OLD catch-all worker is still alive, and that worker fails a job whose
    # name it does not know TERMINALLY. Nothing sweeps for posterless videos
    # afterwards, so the upload would never get one. Same hazard, and same
    # remedy, as BLOB_DELETION_ROLLOUT_DELAY.
    assert job.scheduled_at is not None
    assert job.scheduled_at > timezone.now()


@pytest.mark.django_db(transaction=True)
def test_a_video_does_not_enqueue_the_image_ladder(creator_factory):
    """The two extractors are exclusive: Pillow cannot open an MP4."""
    gfile = GenericFile.objects.create(
        owner=creator_factory(),
        file=ContentFile(b"not-really-mp4", name="clip.mp4"),
        mime_type="video/mp4",
    )
    # Scoped to THIS row: `transaction=True` tests do not roll back, so a
    # global count in a full-suite run measures whatever ran before it.
    assert not ProcrastinateJob.objects.filter(
        task_name="uploads.generate_image_variants",
        args={"generic_file_id": gfile.pk},
    ).exists()


# ---------------------------------------------------------------------------
# extraction
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_task_extracts_a_real_frame(creator_factory):
    gfile = _make_video(creator_factory(), width=320, height=240)

    generate_video_poster(generic_file_id=gfile.pk)

    variant = ImageVariant.objects.get(parent=gfile)
    assert variant.format == "webp"
    with variant.file.open("rb") as handle:
        image = Image.open(handle)
        assert image.format == "WEBP"
        assert (image.width, image.height) == (320, 240)
        assert variant.width == image.width
        # The frame taken is NOT frame 0: the synthesised clip ramps its
        # grey level over time, so a poster from ~2 s in is not black. This
        # is what makes the poster useful rather than merely present.
        assert image.convert("RGB").getpixel((10, 10))[0] > 0


@pytest.mark.django_db
def test_oversized_frames_are_downscaled(creator_factory):
    gfile = _make_video(
        creator_factory(), width=1920, height=1080, seconds=1, fps=10,
    )

    generate_video_poster(generic_file_id=gfile.pk)

    variant = ImageVariant.objects.get(parent=gfile)
    assert variant.width == video_utils.POSTER_MAX_WIDTH
    with variant.file.open("rb") as handle:
        image = Image.open(handle)
        assert image.width == video_utils.POSTER_MAX_WIDTH
        assert image.height == 450  # 16:9 preserved


@pytest.mark.django_db
def test_portrait_frames_are_capped_on_the_longest_edge(creator_factory):
    """
    `POSTER_MAX_WIDTH` is a LONGEST-EDGE ceiling, not a width ceiling.

    Capping only the width let a portrait frame through at 800x1422, and an
    extreme aspect ratio that `MAX_DECODE_PIXELS` still admits (800x16000 is
    only 12.8 MP) through untouched -- a poster twenty times taller than the
    number in the constant's name, fetched on every view of the page.
    """
    gfile = _make_video(
        creator_factory(), width=1080, height=1920, seconds=1, fps=5,
    )

    generate_video_poster(generic_file_id=gfile.pk)

    variant = ImageVariant.objects.get(parent=gfile)
    with variant.file.open("rb") as handle:
        image = Image.open(handle)
        assert max(image.width, image.height) == video_utils.POSTER_MAX_WIDTH
        assert (image.width, image.height) == (450, 800)


@pytest.mark.django_db
def test_oversized_sources_are_refused_before_being_downloaded(
        creator_factory, mocker):
    """
    Existing objects may be larger than this command's 1 GiB processing
    ceiling. Discovering "too big" a gigabyte into the read would spend the
    single catch-all worker's slot, the object-store egress and the node's
    ephemeral disk to learn something the storage metadata already knew.
    """
    gfile = _make_video(creator_factory(), seconds=1, fps=5)
    opened = mocker.patch(
        "django.core.files.storage.base.Storage.open",
        side_effect=AssertionError("must not read an oversized source"),
    )

    original = video_utils.MAX_SOURCE_BYTES
    video_utils.MAX_SOURCE_BYTES = 10
    try:
        assert video_utils.extract_poster_bytes(gfile) is None
    finally:
        video_utils.MAX_SOURCE_BYTES = original

    opened.assert_not_called()


@pytest.mark.django_db
def test_a_storage_failure_retries_instead_of_recording_no_poster(
        creator_factory, mocker):
    """
    A transient object-store read is NOT "this video has no poster".

    Swallowing it would return None, procrastinate would mark the job DONE,
    `VARIANT_RETRY` would never fire, and the upload would silently never get
    a poster -- indistinguishable from a video that genuinely cannot be
    decoded. It has to propagate.
    """
    gfile = _make_video(creator_factory(), seconds=1, fps=5)
    mocker.patch(
        "django.core.files.storage.base.Storage.open",
        side_effect=OSError("transient object-store read"),
    )

    with pytest.raises(OSError):
        generate_video_poster(generic_file_id=gfile.pk)

    assert not ImageVariant.objects.filter(parent=gfile).exists()


@pytest.mark.django_db
def test_a_deleted_source_object_is_terminal_not_retried(
        creator_factory, mocker, caplog):
    """
    A source object gone from storage will NEVER come back (tuzi#2096).

    Before this fix, `_copy_source_to_temp`'s `FileNotFoundError` propagated
    out of `extract_poster_bytes` uncaught -- the same path the storage-
    failure test above exercises for a REAL transient error -- so
    procrastinate retried it, burned `VARIANT_RETRY`'s whole budget on
    something that can never succeed, and only then failed the job
    terminally. That is strictly worse than failing terminally on attempt
    one: same end state, extra queue churn and a delayed poster-less
    upload. This must behave exactly like the "undecodable video" case
    below -- no exception, no poster -- and be logged distinctly so it is
    never mistaken for a live object-store outage.
    """
    gfile = _make_video(creator_factory(), seconds=1, fps=5)
    mocker.patch(
        "django.core.files.storage.base.Storage.open",
        side_effect=FileNotFoundError("source.mp4 does not exist"),
    )

    with caplog.at_level(logging.WARNING,
                         logger="dj.apps.uploads.video_utils"):
        generate_video_poster(generic_file_id=gfile.pk)

    assert not ImageVariant.objects.filter(parent=gfile).exists()
    assert gfile.get_poster() is None
    assert any(
        "source object gone" in record.getMessage()
        for record in caplog.records
    )


@pytest.mark.django_db
def test_a_deleted_gcs_source_object_is_terminal_not_retried(
        creator_factory, mocker, caplog):
    """
    The narrower sibling of the `FileNotFoundError` case above. In
    production, `GoogleCloudStorage._open` (django-storages 1.14.6,
    `storages/backends/gcloud.py:181-186`) calls `bucket.get_blob()`,
    which does its own metadata fetch and returns `None` on a 404 rather
    than raising -- `_open` then raises `FileNotFoundError` itself, from
    `.open()`, the same as the local `FileSystemStorage` case. That is the
    COMMON path and the `FileNotFoundError` test above already covers it
    end to end against the real backend's own exception type.
    `google.api_core.exceptions.NotFound` is the backstop for the TOCTOU
    window where the object existed at `get_blob()` but was deleted before
    the later `download_to_file()` read -- narrower, but the same terminal
    outcome, and worth pinning on its own so a change to either `except`
    clause is caught by a test that actually exercises it.
    """
    gfile = _make_video(creator_factory(), seconds=1, fps=5)
    mocker.patch(
        "django.core.files.storage.base.Storage.open",
        side_effect=NotFound("blob does not exist"),
    )

    with caplog.at_level(logging.WARNING,
                         logger="dj.apps.uploads.video_utils"):
        generate_video_poster(generic_file_id=gfile.pk)

    assert not ImageVariant.objects.filter(parent=gfile).exists()
    assert gfile.get_poster() is None
    assert any(
        "source object gone" in record.getMessage()
        for record in caplog.records
    )


@pytest.mark.django_db
def test_undecodable_video_leaves_no_poster_and_does_not_raise(
        creator_factory):
    gfile = GenericFile.objects.create(
        owner=creator_factory(),
        file=ContentFile(b"\x00\x01\x02 definitely not a video",
                         name="broken.mp4"),
        mime_type="video/mp4",
    )

    generate_video_poster(generic_file_id=gfile.pk)

    assert not ImageVariant.objects.filter(parent=gfile).exists()
    assert gfile.get_poster() is None


@pytest.mark.django_db
def test_frames_above_the_pixel_ceiling_are_refused(creator_factory, settings):
    """A decode ceiling that cannot be tripped is not a ceiling.

    Decoding happens in a child process now, so lowering the constant here
    only reaches it because the PARENT reads it at spawn time and puts it on
    the command line. If that ever stops being true this test goes red rather
    than quietly passing against a ceiling it never lowered -- which is what
    it did on the first cut of the sandbox.
    """
    gfile = _make_video(
        creator_factory(), width=640, height=480, seconds=1, fps=5,
    )
    original = video_utils.MAX_DECODE_PIXELS
    video_utils.MAX_DECODE_PIXELS = 1000
    try:
        generate_video_poster(generic_file_id=gfile.pk)
    finally:
        video_utils.MAX_DECODE_PIXELS = original

    assert not ImageVariant.objects.filter(parent=gfile).exists()


def _encoded(codec, container_format, width=160, height=120, frames=5):
    """A real file in an arbitrary container/codec, for the allowlist tests."""
    buffer = BytesIO()
    container = av.open(buffer, mode="w", format=container_format)
    stream = container.add_stream(codec, rate=5)
    stream.width = width
    stream.height = height
    stream.pix_fmt = "yuv420p"
    for _ in range(frames):
        image = Image.new("RGB", (width, height), (90, 90, 90))
        for packet in stream.encode(av.VideoFrame.from_image(image)):
            container.mux(packet)
    for packet in stream.encode():
        container.mux(packet)
    container.close()
    return buffer.getvalue()


@pytest.mark.django_db
def test_a_codec_outside_the_allowlist_is_refused(creator_factory):
    """
    FFmpeg ships ~200 video decoders and an upload chooses which one runs,
    in-process, in a worker holding production credentials. The allowlist is
    the mitigation; a mitigation that cannot be observed refusing anything is
    not one.

    FFV1 is a real, decodable codec that no browser plays and nothing here
    should ever be handed.
    """
    gfile = GenericFile.objects.create(
        owner=creator_factory(),
        file=ContentFile(_encoded("ffv1", "matroska"), name="odd.mp4"),
        mime_type="video/mp4",
    )

    generate_video_poster(generic_file_id=gfile.pk)

    assert not ImageVariant.objects.filter(parent=gfile).exists()
    assert "ffv1" not in video_utils.ALLOWED_VIDEO_CODECS


@pytest.mark.django_db
def test_a_container_outside_the_allowlist_is_refused(creator_factory):
    """
    Bytes that are not the container we sniffed never reach a demuxer.

    `av.open()` is given an explicit `format=` derived from our own sniffed
    `mime_type`, so FFmpeg never probes attacker-controlled bytes to pick a
    demuxer for itself. An AVI stored as `video/mp4` therefore fails to open
    under the pinned mp4 demuxer -- before any of FFmpeg's other ~40 input
    formats gets to parse it.
    """
    gfile = GenericFile.objects.create(
        owner=creator_factory(),
        file=ContentFile(_encoded("mpeg4", "avi"), name="odd.mp4"),
        mime_type="video/mp4",
    )

    generate_video_poster(generic_file_id=gfile.pk)

    assert not ImageVariant.objects.filter(parent=gfile).exists()
    # The codec IS allowlisted, so this test can only be passing because the
    # container check fired.
    assert "mpeg4" in video_utils.ALLOWED_VIDEO_CODECS


def test_a_decoded_frame_is_measured_not_just_the_declared_geometry():
    """
    H.264/HEVC can change resolution IN BAND, so the `codec_context` geometry
    checked before decoding is a claim, not a fact. FFmpeg has already
    allocated the real frame by the time we hold it, but converting it to RGB
    and resizing it is where a 1 GiB worker actually dies.
    """
    tiny = SimpleNamespace(width=320, height=240)
    huge = SimpleNamespace(width=8000, height=8000)

    video_utils._refuse_oversized_frame(tiny)  # does not raise
    with pytest.raises(video_utils.PosterUnavailable):
        video_utils._refuse_oversized_frame(huge)


@pytest.mark.django_db
def test_extraction_is_idempotent(creator_factory):
    gfile = _make_video(creator_factory(), seconds=1, fps=5)

    generate_video_poster(generic_file_id=gfile.pk)
    generate_video_poster(generic_file_id=gfile.pk)

    assert ImageVariant.objects.filter(parent=gfile).count() == 1


# ---------------------------------------------------------------------------
# URL derivation — the media access model (tuzi#1463)
# ---------------------------------------------------------------------------

@pytest.mark.django_db
@pytest.mark.parametrize("access,prefix", [
    ("public", "/uploadz/public/"),
    ("members", "/uploadz/"),
    ("private", "/uploadz/"),
])
def test_poster_url_follows_the_video_access_level(
        creator_factory, access, prefix):
    """
    A poster is NEVER more public than the video it came from.

    The URL is derived from the parent's `_get_prefix()`, so a members-only
    or private video's poster is only reachable through the authenticated
    `/uploadz/` route — where `uploads_auth` resolves the served name back
    to the parent and answers on the parent's access.
    """
    gfile = _make_video(creator_factory(), access=access, seconds=1, fps=5)

    generate_video_poster(generic_file_id=gfile.pk)
    gfile = GenericFile.objects.prefetch_related("variants").get(pk=gfile.pk)

    poster = gfile.get_poster()
    assert poster is not None
    assert poster.startswith(prefix)
    if access != "public":
        assert not poster.startswith("/uploadz/public/")
    assert gfile.get_url().startswith(prefix)


@pytest.mark.django_db
def test_serializer_exposes_the_poster(creator_factory):
    gfile = _make_video(creator_factory(), seconds=1, fps=5)
    generate_video_poster(generic_file_id=gfile.pk)
    gfile = GenericFile.objects.prefetch_related("variants", "webp").get(
        pk=gfile.pk)

    data = GenericFileSerializer(gfile).data
    assert data["poster"] == gfile.get_poster()
    assert data["poster"].endswith(".webp")
    # `thumbnail` is what existing media pickers already read; a video's
    # thumbnail is its poster.
    assert data["thumbnail"] == data["poster"]


@pytest.mark.django_db
def test_a_video_without_a_poster_reports_none_not_a_guess(creator_factory):
    """
    The blocking rule of: no poster means NO thumbnail claim.

    A URL we could construct but have not generated (or an image belonging
    to the page) would be fetched by the crawler and 404, which is worse
    than the report we already have.
    """
    gfile = GenericFile.objects.create(
        owner=creator_factory(),
        file=ContentFile(b"not-really-mp4", name="clip.mp4"),
        mime_type="video/mp4",
    )
    gfile = GenericFile.objects.prefetch_related("variants", "webp").get(
        pk=gfile.pk)

    assert gfile.get_poster() is None
    assert gfile.get_thumbnail() is None
    assert GenericFileSerializer(gfile).data["poster"] is None


@pytest.mark.django_db
def test_image_thumbnail_behaviour_is_unchanged(creator_factory):
    """The relaxed mime guards must not move an IMAGE's answers."""
    out = BytesIO()
    Image.new("RGB", (40, 30), (1, 2, 3)).save(out, format="PNG")
    gfile = GenericFile.objects.create(
        owner=creator_factory(),
        file=ContentFile(out.getvalue(), name="pic.png"),
        mime_type="image/png",
    )
    gfile = GenericFile.objects.prefetch_related("variants", "webp").get(
        pk=gfile.pk)

    # No Webp row and no variants yet: get_thumbnail falls back to the
    # original, variant_url reports nothing, and get_poster is None because
    # this is not a video.
    assert gfile.get_thumbnail() == gfile.get_url()
    assert gfile.variant_url(128) is None
    assert gfile.get_poster() is None


# ---------------------------------------------------------------------------
# The demuxer sandbox ( follow-up)
#
# `av.open()` allocates in proportion to what an MP4 DECLARES, not to its
# size, so a few hundred bytes reach gigabytes before the call returns and
# before any ceiling in `video_utils` has run. Nothing in-process can bound
# that, which is why demux/decode happens in a child under kernel limits.
# ---------------------------------------------------------------------------

def _sample_table_bomb(declared_samples=60_000_000):
    """A tiny, structurally valid MP4 whose sample tables declare a huge count.

    Synthesised rather than committed as a fixture for the same reason the
    real clips above are: the assertion is about what FFmpeg does with these
    bytes, and a binary blob in the tree is unreviewable. Nothing here
    decodes -- the cost is the demuxer building a sample index sized from
    `stts`/`stsz`/`stsc`.

    Measured through `extract_poster_bytes` on the then-deployed base image
    (`python:3.10-bullseye` at its pinned digest, `av==16.0.1`): 2,140 MB
    without the child's RLIMIT_AS, 36 MB with it.
    """
    import struct

    def box(tag, payload):
        return struct.pack(">I", len(payload) + 8) + tag + payload

    def full(tag, version, flags, payload):
        return box(
            tag, struct.pack(">B3s", version, flags.to_bytes(3, "big")) + payload
        )

    n = declared_samples
    ftyp = box(b"ftyp", b"isom" + struct.pack(">I", 512) + b"isomiso2avc1mp41")
    stts = full(b"stts", 0, 0, struct.pack(">I", 1) + struct.pack(">II", n, 1))
    stsz = full(b"stsz", 0, 0, struct.pack(">II", 1, n))
    stsc = full(
        b"stsc", 0, 0, struct.pack(">I", 1) + struct.pack(">III", 1, n, 1)
    )
    stco = full(b"stco", 0, 0, struct.pack(">I", 1) + struct.pack(">I", 0))
    avcc = box(b"avcC", bytes([
        1, 0x42, 0x00, 0x1E, 0xFF, 0xE1, 0x00, 0x04,
        0x67, 0x42, 0x00, 0x1E, 0x01, 0x00, 0x04, 0x68, 0xCE, 0x3C, 0x80,
    ]))
    avc1 = box(b"avc1", (
        b"\x00" * 6 + struct.pack(">H", 1) + struct.pack(">HH", 0, 0)
        + b"\x00" * 12 + struct.pack(">HH", 320, 240)
        + struct.pack(">II", 0x00480000, 0x00480000)
        + struct.pack(">I", 0) + struct.pack(">H", 1) + b"\x00" * 32
        + struct.pack(">Hh", 24, -1) + avcc
    ))
    stsd = full(b"stsd", 0, 0, struct.pack(">I", 1) + avc1)
    stbl = box(b"stbl", stsd + stts + stsc + stsz + stco)
    dinf = box(b"dinf", full(b"dref", 0, 0,
                             struct.pack(">I", 1) + full(b"url ", 0, 1, b"")))
    minf = box(b"minf", full(b"vmhd", 0, 1, struct.pack(">HHHH", 0, 0, 0, 0))
               + dinf + stbl)
    hdlr = full(b"hdlr", 0, 0, struct.pack(">I", 0) + b"vide"
                + b"\x00" * 12 + b"VideoHandler\x00")
    mdhd = full(b"mdhd", 0, 0, struct.pack(">IIII", 0, 0, 1000, n)
                + struct.pack(">HH", 0x55C4, 0))
    matrix = struct.pack(">9I", 0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000)
    tkhd = full(b"tkhd", 0, 7, struct.pack(">IIIII", 0, 0, 1, 0, n)
                + b"\x00" * 8 + struct.pack(">HHHH", 0, 0, 0, 0) + matrix
                + struct.pack(">II", 320 << 16, 240 << 16))
    trak = box(b"trak", tkhd + box(b"mdia", mdhd + hdlr + minf))
    mvhd = full(b"mvhd", 0, 0, struct.pack(">IIII", 0, 0, 1000, n)
                + struct.pack(">IH", 0x00010000, 0x0100) + b"\x00" * 10
                + matrix + b"\x00" * 24 + struct.pack(">I", 2))
    moov = box(b"moov", mvhd + trak)
    return ftyp + moov + box(b"mdat", b"\x00" * 8)


@pytest.mark.django_db(transaction=True)
def test_a_sample_table_bomb_yields_no_poster_and_does_not_take_the_worker(
    creator_factory,
):
    """The reported vector, end to end through the real extractor.

    A file small enough to pass every size check, valid enough to pass the
    pinned demuxer, and expensive enough to OOM a 1 GiB worker inside
    `av.open()` -- upstream of MAX_DECODE_PIXELS, the codec allowlist, the
    packet cap and the decode deadline, all of which are evaluated after that
    call returns.
    """
    payload = _sample_table_bomb()
    assert len(payload) < 4096, "the point is that it is tiny"

    video = GenericFile.objects.create(
        owner=creator_factory(),
        file=ContentFile(payload, name="bomb.mp4"),
        mime_type="video/mp4",
        access="public",
    )

    assert video_utils.extract_poster_bytes(video) is None

    generate_video_poster(generic_file_id=video.pk)
    video.refresh_from_db()
    assert video.get_poster() is None
    assert not ImageVariant.objects.filter(parent=video).exists()


def test_the_bomb_is_demuxed_under_a_real_address_space_ceiling(tmp_path):
    """...and the ceiling is what keeps it small.

    The child reports its own `VmHWM` and the limits it read back from the
    kernel, because a subprocess spawned WITHOUT its ceilings behaves
    identically in every other observable way -- it would return the same
    answer, pass the test above, and be exactly the unbounded version this
    replaced.

    Linux only: Darwin does not implement RLIMIT_AS (`setrlimit` fails with
    EINVAL), which is itself asserted by
    `test_a_host_that_cannot_enforce_the_ceiling_refuses_on_linux`.
    """
    if not sys.platform.startswith("linux"):
        pytest.skip("RLIMIT_AS is not implemented on this platform")

    source = tmp_path / "bomb.mp4"
    source.write_bytes(_sample_table_bomb())
    out = tmp_path / "poster.webp"

    result = subprocess.run(
        video_utils._child_argv(str(source), "mp4", str(out)),
        capture_output=True,
        env=video_utils._child_env(),
        timeout=video_utils.POSTER_SUBPROCESS_TIMEOUT_SECONDS,
    )
    answer = json.loads(result.stdout.decode())

    assert answer["ok"] is False
    assert answer["limits"]["address_space"] == (
        video_utils.POSTER_SUBPROCESS_ADDRESS_SPACE_BYTES
    )
    assert answer["limits"]["cpu_seconds"] == (
        video_utils.POSTER_SUBPROCESS_CPU_SECONDS
    )
    # Unbounded this file reaches ~2,140 MB. The ceiling is 768 MiB, so
    # anything near it means the limit was not actually installed; the
    # observed figure is ~36 MB and the slack here is for FFmpeg version
    # drift, not for a missing limit.
    peak_mb = answer["peak_rss_kb"] / 1024
    assert peak_mb < 400, f"child peaked at {peak_mb:.0f} MB"


def test_the_spawn_carries_both_kernel_limits():
    """Cheap, platform-independent guard on the command line itself.

    If someone later "simplifies" the spawn, this fails on every platform
    including the macOS laptop where the memory assertion above is skipped.
    """
    argv = video_utils._child_argv("/src.mp4", "mp4", "/out.webp")

    assert argv[0] == sys.executable
    assert argv[1:3] == ["-m", "dj.apps.uploads.video_utils"]
    assert "--child" in argv
    pairs = dict(zip(argv, argv[1:]))
    assert pairs["--address-space"] == str(
        video_utils.POSTER_SUBPROCESS_ADDRESS_SPACE_BYTES
    )
    assert pairs["--cpu-seconds"] == str(
        video_utils.POSTER_SUBPROCESS_CPU_SECONDS
    )
    assert pairs["--max-pixels"] == str(video_utils.MAX_DECODE_PIXELS)


def test_the_address_space_limit_really_terminates_an_over_budget_child():
    """The limit is enforced by the kernel, not merely requested.

    `_apply_child_limits` is called in a child that then asks for more than
    the ceiling; the allocation must fail. Without this, a platform that
    accepts `setrlimit` and ignores it would look identical to one that
    enforces it.
    """
    if not sys.platform.startswith("linux"):
        pytest.skip("RLIMIT_AS is not implemented on this platform")

    limit = 128 * 1024 * 1024
    code = (
        "import sys; sys.path.insert(0, %r)\n"
        "from dj.apps.uploads.video_utils import _apply_child_limits\n"
        "print(_apply_child_limits(%d, 30))\n"
        "b = bytearray(%d)\n"
        "print('ALLOCATED', len(b))\n"
        % (video_utils._child_env()["PYTHONPATH"].split(os.pathsep)[0],
           limit, limit * 4)
    )
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, timeout=60
    )

    assert b"ALLOCATED" not in result.stdout, (
        "the over-budget allocation succeeded; RLIMIT_AS is not enforced"
    )
    assert result.returncode != 0
    assert b"MemoryError" in result.stderr


def test_the_cpu_limit_really_terminates_a_spinning_child():
    """RLIMIT_CPU is the half that closes the decode-hang.

    Nothing in-process could interrupt a native FFmpeg call -- the
    procrastinate worker runs sync tasks off the main thread, so
    `signal.alarm` is unavailable. SIGXCPU lands anyway. Enforced on macOS
    too, so this one is not skipped.

    Either signal is accepted: the soft limit raises SIGXCPU (a nameable
    cause) and the hard limit, 5 s later, raises SIGKILL (an unignorable
    one). Which arrives first is a platform detail -- Linux went straight to
    SIGKILL while the two limits were equal, which is why they no longer
    are. The asserted property is the one that matters: a child that will
    not stop is stopped by the kernel, with the parent doing nothing.
    """
    code = (
        "import sys; sys.path.insert(0, %r)\n"
        "from dj.apps.uploads.video_utils import _apply_child_limits\n"
        "_apply_child_limits(1 << 40, 1)\n"
        "x = 0\n"
        "while True: x += 1\n"
        % video_utils._child_env()["PYTHONPATH"].split(os.pathsep)[0]
    )
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, timeout=120
    )

    assert result.returncode in (-signal.SIGXCPU, -signal.SIGKILL), (
        result.returncode
    )


@pytest.mark.django_db(transaction=True)
def test_a_child_that_hangs_is_killed_on_the_wall_clock(
    creator_factory, monkeypatch
):
    """The bound RLIMIT_CPU cannot supply: a child blocked, not spinning.

    A sleeping child burns no CPU time, so only the parent's wall clock ends
    it. The process is asserted DEAD afterwards -- a timeout that leaves the
    child running would still stall the queue behind it.
    """
    video = _make_video(creator_factory(), seconds=1)
    spawned = {}

    def _sleepy(source_path, demux_format, output_path):
        argv = [sys.executable, "-c", "import time; time.sleep(300)"]
        spawned["argv"] = argv
        return argv

    monkeypatch.setattr(video_utils, "_child_argv", _sleepy)
    monkeypatch.setattr(
        video_utils, "POSTER_SUBPROCESS_TIMEOUT_SECONDS", 2
    )

    started = time.monotonic()
    assert video_utils.extract_poster_bytes(video) is None
    elapsed = time.monotonic() - started

    assert spawned, "the sandbox was never spawned"
    assert elapsed < 60, f"took {elapsed:.1f}s; the wall clock did not fire"
    # Nothing of ours may be left behind.
    assert not [
        line for line in subprocess.run(
            ["ps", "-eo", "command"], capture_output=True,
        ).stdout.decode().splitlines()
        if "time.sleep(300)" in line
    ]


def test_a_host_that_cannot_enforce_the_ceiling_refuses_on_linux(monkeypatch):
    """Fail CLOSED where it counts.

    If `RLIMIT_AS` ever stops being installable on the deployment platform,
    posters must stop rather than the demuxer silently running unbounded
    again -- which is the exact state this whole change exists to leave.
    """
    monkeypatch.setattr(sys, "platform", "linux")
    with pytest.raises(video_utils.PosterUnavailable) as excinfo:
        video_utils._require_enforced_limits({"address_space": None})
    assert "RLIMIT_AS" in str(excinfo.value)

    #...and a real ceiling is accepted.
    video_utils._require_enforced_limits(
        {"address_space": video_utils.POSTER_SUBPROCESS_ADDRESS_SPACE_BYTES}
    )

    # A developer laptop keeps working, loudly.
    monkeypatch.setattr(sys, "platform", "darwin")
    video_utils._require_enforced_limits({"address_space": None})


def test_the_pixel_ceiling_matches_what_the_worker_can_actually_afford():
    """MAX_DECODE_PIXELS is a measurement, not a round number.

    4K DCI (4096x2160) must be admitted -- it is ordinary camera and
    screen-recorder output -- and the old 16 MP ceiling must not be, because
    a `refs=16` decode at that size peaked at 877 MB inside a 1 GiB worker.
    """
    assert 4096 * 2160 <= video_utils.MAX_DECODE_PIXELS
    assert 5328 * 3000 > video_utils.MAX_DECODE_PIXELS
    #...and the ceiling has to fit under the child's address space with room
    # for the reference frames and the RGB copy, or the limit refuses work we
    # meant to accept.
    assert video_utils.POSTER_SUBPROCESS_ADDRESS_SPACE_BYTES > 547 * 1024 * 1024


# ---------------------------------------------------------------------------
# Second codex round on the sandbox itself. Every one of these pins a fix for
# a finding that the first round's tests would have passed straight over.
# ---------------------------------------------------------------------------

def test_the_child_refuses_to_decode_when_it_could_not_install_the_ceiling(
    monkeypatch, capsys, tmp_path
):
    """Fail closed in the CHILD, upstream of `av.open()`.

    The parent checks too, but it cannot check until `communicate()` returns
    -- by which point the demuxer has already allocated whatever it wanted
    and may have taken the pod with it. A ceiling verified after the
    allocation is not a ceiling, so the refusal has to happen in the last
    place that is still upstream of the demuxer.
    """
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(
        video_utils, "_apply_child_limits",
        lambda *a, **k: {
            "cpu_seconds": 45, "address_space": None, "file_bytes": None,
        },
    )

    def _must_not_run(*args, **kwargs):
        raise AssertionError("the demuxer was reached without a ceiling")

    monkeypatch.setattr(video_utils, "_decode_poster", _must_not_run)

    source = tmp_path / "clip.mp4"
    source.write_bytes(_mp4_bytes(seconds=1))

    rc = video_utils._child_main([
        "--child", "--source", str(source), "--format", "mp4",
        "--output", str(tmp_path / "p.webp"),
        "--address-space", "805306368", "--cpu-seconds", "45",
        "--max-pixels", str(video_utils.MAX_DECODE_PIXELS),
        "--max-file-bytes",
        str(video_utils.POSTER_SUBPROCESS_MAX_FILE_BYTES),
    ])

    assert rc == 0
    answer = json.loads(capsys.readouterr().out)
    assert answer["ok"] is False
    assert "RLIMIT_AS" in answer["reason"]


def test_the_child_is_not_handed_the_worker_s_secrets():
    """The demuxer runs attacker-supplied bytes; it gets no credentials.

    An ALLOW-list, because a deny-list is wrong by omission the first time
    somebody adds a secret. This does NOT isolate the child -- it shares the
    pod's network namespace and can still reach the metadata server -- and
    the PR body says so. It removes the cheapest half of the blast radius.
    """
    secrets = {
        "DBPASS": "hunter2",
        "STRIPE_SECRET_KEY": "sk_live_nope",
        "DJANGO_SECRET_KEY": "also-no",
        "AWS_SECRET_ACCESS_KEY": "no",
    }
    with mock.patch.dict(os.environ, secrets):
        env = video_utils._child_env()

    for name in secrets:
        assert name not in env, name
    assert set(env) <= set(video_utils.CHILD_ENV_PASSTHROUGH) | {
        "PYTHONDONTWRITEBYTECODE",
    }
    #...and it still resolves the package, or the child cannot start at all.
    # PYTHONPATH is deliberately INHERITED (prepended, not replaced): it is
    # how `av` and Pillow resolve where site-packages is not the only source,
    # and replacing it outright broke eight tests.
    assert Path(env["PYTHONPATH"].split(os.pathsep)[0]) == Path(video_utils.__file__).resolve().parents[3]


@pytest.mark.django_db(transaction=True)
def test_a_transient_spawn_failure_retries_instead_of_recording_no_poster(
    creator_factory, monkeypatch
):
    """EMFILE is node pressure, not "this video has no poster".

    Swallowing it would mark the job DONE and leave the upload posterless
    without a failed job for the cooled-down sweep readmission to discover.
    It has to reach procrastinate, exactly like the storage-read failure above.
    """
    video = _make_video(creator_factory(), seconds=1)

    def _no_file_descriptors(*args, **kwargs):
        raise OSError(24, "Too many open files")

    monkeypatch.setattr(video_utils.subprocess, "Popen", _no_file_descriptors)

    with pytest.raises(OSError):
        video_utils.extract_poster_bytes(video)


@pytest.mark.django_db(transaction=True)
def test_a_flooding_child_cannot_grow_the_parent(creator_factory, monkeypatch):
    """`communicate()` on pipes buffers the WHOLE child output in the parent.

    So a decoder induced to emit diagnostics for the full wall-clock window
    would grow the worker while the child sat comfortably inside its own
    ceiling -- the exact inversion this change exists to prevent. The child's
    streams go to files, and the parent reads a capped prefix.

    The answer is written FIRST and read from the FRONT, so a flood cannot
    push it out of range either; that is what this asserts.
    """
    video = _make_video(creator_factory(), seconds=1)
    flood = video_utils.POSTER_SUBPROCESS_MAX_STDOUT * 400

    def _flooder(source_path, demux_format, output_path):
        return [
            sys.executable, "-c",
            "import sys\n"
            "sys.stdout.write('{\"ok\": false, \"reason\": \"nope\"}')\n"
            f"sys.stdout.write('x' * {flood})\n"
            f"sys.stderr.write('y' * {flood})\n",
        ]

    monkeypatch.setattr(video_utils, "_child_argv", _flooder)

    # The answer is still parsed, and the flood never reaches this process
    # beyond the cap.
    assert video_utils.extract_poster_bytes(video) is None


def test_the_capped_read_takes_the_front_not_the_tail(tmp_path):
    """Direct control on the helper the test above exercises end to end."""
    handle = open(tmp_path / "out", "w+b")
    handle.write(b'{"ok": true}' + b"x" * 100_000)

    got = video_utils._read_capped(handle, 12)

    assert got == b'{"ok": true}'
    handle.close()


def test_the_child_cannot_fill_the_node_disk():
    """RLIMIT_FSIZE, and the reason it exists is a fix that moved a problem.

    Piping the child's output made the PARENT buffer without limit; sending
    it to files fixed that and opened a new hole, because `/tmp` is an
    unbounded disk-backed emptyDir and a decoder induced to emit diagnostics
    for the whole wall-clock window could put the node into DiskPressure. A
    cap applied by the reader is not a cap on the writer (codex adversarial
    review, two rounds).
    """
    argv = video_utils._child_argv("/src.mp4", "mp4", "/out.webp")
    pairs = dict(zip(argv, argv[1:]))
    assert pairs["--max-file-bytes"] == str(
        video_utils.POSTER_SUBPROCESS_MAX_FILE_BYTES
    )

    limit = 1024 * 1024
    code = (
        "import sys; sys.path.insert(0, %r)\n"
        "from dj.apps.uploads.video_utils import _apply_child_limits\n"
        "_apply_child_limits(1 << 40, 30, %d)\n"
        "open('%s', 'wb').write(b'x' * %d)\n"
        "print('WROTE')\n"
        % (video_utils._child_env()["PYTHONPATH"].split(os.pathsep)[0],
           limit, tempfile.mkstemp()[1], limit * 8)
    )
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, timeout=60
    )

    assert b"WROTE" not in result.stdout, (
        "the over-budget write succeeded; RLIMIT_FSIZE is not enforced"
    )
    assert result.returncode != 0


def test_a_fenced_embed_inside_a_container_is_not_advertised_as_a_video():
    """`marked` renders it as code; the media list must agree.

    The fence scanner used to strip only leading spaces while the directive
    regex looked through blockquote and list prefixes, so a fenced embed
    inside a blockquote was reported as a real video and the page carried a
    `VideoObject` for media it does not contain -- fabricated structured data,
    which is worse than none and exactly what this feature must not produce
    (codex adversarial review).
    """
    fence = "`" * 3
    hidden = [
        f"{fence}\n::embed[/uploadz/public/u/a.mp4]\n{fence}\n",
        f"> {fence}md\n> ::embed[/uploadz/public/u/a.mp4]\n> {fence}\n",
        f"- {fence}\n  ::embed[/uploadz/public/u/a.mp4]\n  {fence}\n",
        f">> {fence}\n>> ::embed[/uploadz/public/u/a.mp4]\n>> {fence}\n",
    ]
    for body in hidden:
        assert embedded_media.embed_values(body) == [], body

    #...and the container forms that DO render must survive, or the fix
    # would have "worked" by suppressing everything.
    visible = [
        ("::embed[/uploadz/public/u/d.mp4]\n", "/uploadz/public/u/d.mp4"),
        ("> ::embed[/uploadz/public/u/b.mp4]\n", "/uploadz/public/u/b.mp4"),
        ("- ::embed[/uploadz/public/u/c.mp4]\n", "/uploadz/public/u/c.mp4"),
    ]
    for body, expected in visible:
        assert embedded_media.embed_values(body) == [expected], body


@pytest.mark.django_db
def test_another_owner_s_upload_metadata_is_not_disclosed(creator_factory):
    """Public BYTES do not imply public management metadata.

    `title` and `description` are owner-managed fields that `MyUploadsViewSet`
    exposes to the owner alone, and upload access defaults to public -- so
    without this, anyone who can guess a public upload path could publish a
    page embedding it and read back metadata that serving the bytes never
    disclosed (codex adversarial review).

    The video is still usable: it stays `is_public`, keeps its URL and
    poster, and `buildVideoObjects` falls back to the page's own title and
    description, which is how a reader meets it anyway.
    """
    owner = creator_factory()
    other = creator_factory()
    video = GenericFile.objects.create(
        owner=owner,
        file=ContentFile(_mp4_bytes(seconds=1), name="clip.mp4"),
        mime_type="video/mp4",
        access="public",
        title="Owner's private working title",
        description="Notes the owner never published",
    )
    body = f"::embed[{video.get_url()}]\n"

    mine = embedded_media.embedded_media(body, owner)
    assert mine[0]["title"] == "Owner's private working title"
    assert mine[0]["description"] == "Notes the owner never published"

    theirs = embedded_media.embedded_media(body, other)
    assert theirs, "the video must still be reported"
    assert theirs[0]["is_public"] is True
    assert theirs[0]["url"] == mine[0]["url"]
    assert theirs[0]["title"] == ""
    assert theirs[0]["description"] == ""


def test_frontmatter_embeds_are_not_advertised_as_videos():
    """`stripLeadingFrontmatter` removes them before `marked` ever runs.

    So a directive inside frontmatter puts NO video on the page, and a
    backend that scanned the raw body emitted a `VideoObject` for media that
    is not there (codex adversarial review) -- the same class as the fenced
    block, and the same rule: whatever the renderer removes before rendering,
    this must remove before scanning.
    """
    hidden = [
        "---\n::embed[/uploadz/public/u/a.mp4]\n---\nArticle\n",
        "---\ntitle: x\n::embed[/uploadz/public/u/a.mp4]\n---\nBody\n",
    ]
    for body in hidden:
        assert embedded_media.embed_values(body) == [], body

    # An embed AFTER the frontmatter is a real video and must survive, or the
    # fix would be swallowing the whole document.
    assert embedded_media.embed_values(
        "---\ntitle: x\n---\n::embed[/uploadz/public/u/z.mp4]\n"
    ) == ["/uploadz/public/u/z.mp4"]


def test_iframe_directives_are_enumerated_but_qrcode_is_not():
    """`renderDirective` sends `embed` AND `iframe` down the same path.

    Only `qrcode` branches away. So `::iframe[...clip.mp4]` renders a real
    `<video>` exactly like `::embed` does, and matching only `embed` meant
    those videos silently got no poster and no `VideoObject` -- an
    under-report rather than a fabrication, but a real one (codex adversarial
    review).
    """
    assert embedded_media.embed_values(
        "::iframe[/uploadz/public/u/i.mp4]\n"
    ) == ["/uploadz/public/u/i.mp4"]
    assert embedded_media.embed_values(
        "::embed[/uploadz/public/u/e.mp4]\n"
    ) == ["/uploadz/public/u/e.mp4"]
    # qrcode renders a QR div, never a video.
    assert embedded_media.embed_values(
        "::qrcode[/uploadz/public/u/q.mp4]\n"
    ) == []


def test_the_backfill_sits_below_every_live_queue_priority():
    """Derived, not hand-picked, and that is the point.

    A hand-picked -10 TIED live language detection and OUTRANKED blob
    cleanup, so a full-corpus backfill could be fetched ahead of both on the
    single concurrency-1 worker that carries them (codex adversarial review).
    """
    from dj.apps.uploads.management.commands import backfill_video_posters
    from dj.apps.jobs.priorities import BACKFILL, INTERACTIVE, MAINTENANCE

    assert backfill_video_posters.BACKFILL_PRIORITY == BACKFILL
    assert INTERACTIVE > MAINTENANCE > BACKFILL


@pytest.mark.django_db
def test_the_backfill_refuses_an_unbounded_run_unless_asked_in_words():
    """Leaving `--limit` off used to mean "the entire corpus".

    That made the shortest command the most dangerous one available. A bound
    is now required for any run that actually enqueues; `--dry-run` still
    needs neither, because it enqueues nothing.
    """
    from django.core.management import call_command
    from django.core.management.base import CommandError

    _clear_poster_jobs()
    with pytest.raises(CommandError, match="unbounded"):
        call_command("backfill_video_posters")

    # Both explicit forms are accepted, and --dry-run alone still works.
    call_command("backfill_video_posters", "--dry-run", stdout=StringIO())
    with pytest.raises(CommandError, match="both --rate"):
        call_command("backfill_video_posters", "--limit", "1")
    options = ["--rate", "40", "--max-inflight", "1000"]
    call_command("backfill_video_posters", "--limit", "1", *options,
                 stdout=StringIO())
    call_command("backfill_video_posters", "--all", *options,
                 stdout=StringIO())


@pytest.mark.django_db(transaction=True)
def test_backfill_rate_spreads_100_schedules_over_at_least_150_seconds(
    creator_factory,
):
    from django.core.management import call_command
    from django.db import connection

    _clear_poster_jobs()
    owner = creator_factory()
    videos = [
        GenericFile.objects.create(
            owner=owner,
            file=ContentFile(b"video", name=f"rate-{index}.mp4"),
            mime_type="video/mp4",
        )
        for index in range(100)
    ]
    ids = [str(video.pk) for video in videos]
    with connection.cursor() as cursor:
        cursor.execute(
            "DELETE FROM procrastinate_jobs WHERE task_name = %s "
            "AND args->>'generic_file_id' = ANY(%s)",
            ["uploads.generate_video_poster", ids],
        )

    enqueued_at = timezone.now()
    call_command(
        "backfill_video_posters", "--limit", "100", "--rate", "40",
        "--max-inflight", "1000", stdout=StringIO(),
    )
    jobs = ProcrastinateJob.objects.filter(
        task_name="uploads.generate_video_poster",
        args__generic_file_id__in=[video.pk for video in videos],
    ).order_by("scheduled_at")
    scheduled = list(jobs.values_list("scheduled_at", flat=True))

    assert len(scheduled) == 100
    assert scheduled[-1] > enqueued_at
    assert scheduled[-1] - scheduled[0] >= timedelta(minutes=2.5)


@pytest.mark.django_db(transaction=True)
def test_backfill_partial_restart_extends_the_persisted_rate_tail(creator_factory):
    from django.core.management import call_command
    from django.db import connection

    _clear_poster_jobs()
    owner = creator_factory()
    videos = [
        GenericFile.objects.create(
            owner=owner,
            file=ContentFile(b"video", name=f"restart-{index}.mp4"),
            mime_type="video/mp4",
        )
        for index in range(4)
    ]
    ids = [str(video.pk) for video in videos]
    with connection.cursor() as cursor:
        cursor.execute(
            "DELETE FROM procrastinate_jobs WHERE task_name = %s "
            "AND args->>'generic_file_id' = ANY(%s)",
            ["uploads.generate_video_poster", ids],
        )

    options = [
        "--limit", "2", "--batch-size", "1", "--rate", "40",
        "--max-inflight", "4",
    ]
    call_command("backfill_video_posters", *options, stdout=StringIO())
    call_command("backfill_video_posters", *options, stdout=StringIO())

    jobs = list(ProcrastinateJob.objects.filter(
        task_name="uploads.generate_video_poster",
        args__generic_file_id__in=[video.pk for video in videos],
    ).order_by("scheduled_at", "id"))
    assert len(jobs) == 4
    assert len({job.args["generic_file_id"] for job in jobs}) == 4
    assert all(job.queueing_lock == f"video-poster-{job.args['generic_file_id']}"
               for job in jobs)
    assert ProcrastinateJob.objects.filter(
        task_name="uploads.generate_video_poster", status="todo",
    ).count() == 4
    scheduled = [job.scheduled_at for job in jobs]
    assert all(
        later - earlier >= timedelta(seconds=60 / 40)
        for earlier, later in zip(scheduled, scheduled[1:])
    )


@pytest.mark.django_db(transaction=True)
def test_concurrent_backfills_serialize_capacity_tail_and_video_selection(
    creator_factory,
):
    from django.core.management import call_command
    from django.db import connection, connections

    _clear_poster_jobs()
    owner = creator_factory()
    videos = [
        GenericFile.objects.create(
            owner=owner,
            file=ContentFile(b"video", name=f"concurrent-{index}.mp4"),
            mime_type="video/mp4",
        )
        for index in range(4)
    ]
    ids = [str(video.pk) for video in videos]
    with connection.cursor() as cursor:
        cursor.execute(
            "DELETE FROM procrastinate_jobs WHERE task_name = %s "
            "AND args->>'generic_file_id' = ANY(%s)",
            ["uploads.generate_video_poster", ids],
        )

    def run_backfill():
        try:
            call_command(
                "backfill_video_posters", "--limit", "2", "--rate", "40",
                "--batch-size", "1", "--max-inflight", "4",
                stdout=StringIO(),
            )
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(run_backfill) for _ in range(2)]
        for future in futures:
            future.result(timeout=30)

    jobs = list(ProcrastinateJob.objects.filter(
        task_name="uploads.generate_video_poster",
        args__generic_file_id__in=[video.pk for video in videos],
    ).order_by("scheduled_at", "id"))
    assert len(jobs) == 4
    assert len({job.args["generic_file_id"] for job in jobs}) == 4
    assert ProcrastinateJob.objects.filter(
        task_name="uploads.generate_video_poster", status="todo",
    ).count() == 4
    scheduled = [job.scheduled_at for job in jobs]
    assert all(
        later - earlier >= timedelta(seconds=60 / 40)
        for earlier, later in zip(scheduled, scheduled[1:])
    )


@pytest.mark.django_db(transaction=True)
def test_retry_terminal_backfill_repairs_old_failed_and_succeeded_without_variant(
    creator_factory,
):
    from django.core.management import call_command
    from django.db import connection

    _clear_poster_jobs()
    owner = creator_factory()
    failed_video, succeeded_video, live_video = [
        GenericFile.objects.create(
            owner=owner,
            file=ContentFile(b"video", name=f"terminal-{index}.mp4"),
            mime_type="video/mp4",
        )
        for index in range(3)
    ]
    past = timezone.now() - timedelta(days=90)
    GenericFile.objects.filter(
        pk__in=[failed_video.pk, succeeded_video.pk],
    ).update(created_at=past)
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE procrastinate_jobs SET status='failed', attempts=1 "
            "WHERE task_name=%s AND args->>'generic_file_id'=%s",
            ["uploads.generate_video_poster", str(failed_video.pk)],
        )
        cursor.execute(
            "UPDATE procrastinate_jobs SET status='succeeded', attempts=0 "
            "WHERE task_name=%s AND args->>'generic_file_id'=%s",
            ["uploads.generate_video_poster", str(succeeded_video.pk)],
        )

    options = ["--limit", "2", "--rate", "40", "--max-inflight", "10"]
    call_command("backfill_video_posters", *options, stdout=StringIO())
    assert ProcrastinateJob.objects.filter(
        task_name="uploads.generate_video_poster",
        args__generic_file_id__in=[failed_video.pk, succeeded_video.pk],
    ).count() == 2

    call_command(
        "backfill_video_posters", "--retry-terminal", *options,
        stdout=StringIO(),
    )

    assert ProcrastinateJob.objects.filter(
        task_name="uploads.generate_video_poster",
        args__generic_file_id=failed_video.pk, status="todo",
    ).count() == 1
    assert ProcrastinateJob.objects.filter(
        task_name="uploads.generate_video_poster",
        args__generic_file_id=succeeded_video.pk, status="todo",
    ).count() == 1
    assert ProcrastinateJob.objects.filter(
        task_name="uploads.generate_video_poster",
        args__generic_file_id=live_video.pk,
    ).count() == 1


@pytest.mark.django_db(transaction=True)
def test_retry_terminal_backfill_observes_cumulative_attempt_ceiling(
    creator_factory,
):
    from django.core.management import call_command
    from django.db import connection

    _clear_poster_jobs()
    video = GenericFile.objects.create(
        owner=creator_factory(),
        file=ContentFile(b"video", name="terminal-ceiling.mp4"),
        mime_type="video/mp4",
    )
    with connection.cursor() as cursor:
        # A terminal row one execution over the full retry/reclaim allowance
        # has no remaining budget for another repair cycle.
        cursor.execute(
            "UPDATE procrastinate_jobs SET status='failed', attempts=%s "
            "WHERE task_name=%s AND args->>'generic_file_id'=%s",
            [
                upload_tasks.VIDEO_POSTER_READMISSION_MAX_RUNS + 1,
                "uploads.generate_video_poster",
                str(video.pk),
            ],
        )

    call_command(
        "backfill_video_posters", "--retry-terminal", "--limit", "1",
        "--rate", "40", "--max-inflight", "10", stdout=StringIO(),
    )

    assert ProcrastinateJob.objects.filter(
        task_name="uploads.generate_video_poster",
        args__generic_file_id=video.pk,
    ).count() == 1


@pytest.mark.django_db(transaction=True)
def test_retry_terminal_backfill_allows_one_exhausted_infra_cycle(
    creator_factory,
):
    from django.core.management import call_command
    from django.db import connection

    _clear_poster_jobs()
    video = GenericFile.objects.create(
        owner=creator_factory(),
        file=ContentFile(b"video", name="terminal-one-cycle.mp4"),
        mime_type="video/mp4",
    )
    with connection.cursor() as cursor:
        # The full normal-retry and worker-reclaim allowance is spent, leaving
        # exactly one more complete repair cycle within the hard total cap.
        cursor.execute(
            "UPDATE procrastinate_jobs SET status='failed', attempts=%s "
            "WHERE task_name=%s AND args->>'generic_file_id'=%s",
            [
                upload_tasks.VIDEO_POSTER_READMISSION_MAX_RUNS,
                "uploads.generate_video_poster",
                str(video.pk),
            ],
        )

    call_command(
        "backfill_video_posters", "--retry-terminal", "--limit", "1",
        "--rate", "40", "--max-inflight", "10", stdout=StringIO(),
    )

    assert ProcrastinateJob.objects.filter(
        task_name="uploads.generate_video_poster",
        args__generic_file_id=video.pk,
    ).count() == 2


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("retry_terminal", [False, True])
def test_backfill_rechecks_history_after_candidate_selection(
    creator_factory, monkeypatch, retry_terminal,
):
    from django.core.management import call_command
    from django.db import connection

    from dj.apps.uploads.management.commands import backfill_video_posters

    _clear_poster_jobs()
    video = GenericFile.objects.create(
        owner=creator_factory(),
        file=ContentFile(b"video", name=f"history-race-{retry_terminal}.mp4"),
        mime_type="video/mp4",
    )
    original = ProcrastinateJob.objects.get(
        task_name="uploads.generate_video_poster",
        args__generic_file_id=video.pk,
    )
    if retry_terminal:
        ProcrastinateJob.objects.filter(pk=original.pk).update(
            status="failed",
            attempts=upload_tasks.VIDEO_POSTER_READMISSION_MAX_RUNS,
        )
    else:
        with connection.cursor() as cursor:
            cursor.execute(
                "DELETE FROM procrastinate_jobs WHERE id=%s",
                [original.pk],
            )

    take_owner_lock = backfill_video_posters._admission_lock

    def producer_wins_after_selection(owner_id):
        take_owner_lock(owner_id)
        if retry_terminal:
            ProcrastinateJob.objects.filter(pk=original.pk).update(
                attempts=upload_tasks.VIDEO_POSTER_READMISSION_ATTEMPT_CEILING,
            )
            return
        raced_job_id = generate_video_poster.configure(
            queueing_lock=f"video-poster-{video.pk}",
        ).defer(generic_file_id=video.pk)
        ProcrastinateJob.objects.filter(pk=raced_job_id).update(
            status="succeeded",
        )

    monkeypatch.setattr(
        backfill_video_posters, "_admission_lock", producer_wins_after_selection,
    )
    options = ["--limit", "1", "--rate", "40", "--max-inflight", "1000"]
    if retry_terminal:
        options.insert(0, "--retry-terminal")
    call_command("backfill_video_posters", *options, stdout=StringIO())

    assert ProcrastinateJob.objects.filter(
        task_name="uploads.generate_video_poster",
        args__generic_file_id=video.pk,
    ).count() == 1


@pytest.mark.django_db(transaction=True)
def test_retry_terminal_queue_collision_keeps_the_batch_transaction_usable(
    creator_factory, monkeypatch,
):
    from django.core.management import call_command
    from django.db import connection

    from dj.apps.uploads.management.commands import backfill_video_posters

    _clear_poster_jobs()
    owner = creator_factory()
    raced, next_video = [
        GenericFile.objects.create(
            owner=owner,
            file=ContentFile(b"video", name=f"operator-race-{i}.mp4"),
            mime_type="video/mp4",
        )
        for i in range(2)
    ]
    original_jobs = list(ProcrastinateJob.objects.filter(
        task_name="uploads.generate_video_poster",
        args__generic_file_id__in=[raced.pk, next_video.pk],
    ).order_by("id"))
    assert len(original_jobs) == 2
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE procrastinate_jobs SET status='failed', attempts=1 "
            "WHERE id = ANY(%s)",
            [[job.id for job in original_jobs]],
        )

    take_owner_lock = backfill_video_posters._admission_lock
    collision_inserted = False

    def operator_requeues_after_history_check(owner_id):
        nonlocal collision_inserted
        take_owner_lock(owner_id)
        if collision_inserted:
            return
        generate_video_poster.configure(
            queueing_lock=f"video-poster-{raced.pk}",
        ).defer(generic_file_id=raced.pk)
        collision_inserted = True

    monkeypatch.setattr(
        backfill_video_posters, "_admission_lock", operator_requeues_after_history_check,
    )
    call_command(
        "backfill_video_posters", "--retry-terminal", "--limit", "2",
        "--batch-size", "2", "--rate", "40", "--max-inflight", "10",
        stdout=StringIO(),
    )

    assert ProcrastinateJob.objects.filter(
        task_name="uploads.generate_video_poster",
        args__generic_file_id=raced.pk,
        status="todo",
    ).count() == 1
    assert ProcrastinateJob.objects.filter(
        task_name="uploads.generate_video_poster",
        args__generic_file_id=next_video.pk,
        status="todo",
    ).count() == 1


@pytest.mark.django_db(transaction=True)
def test_backfill_refuses_enqueue_when_existing_inflight_reaches_the_cap(
    creator_factory,
):
    from django.core.management import call_command
    from django.core.management.base import CommandError

    _clear_poster_jobs()
    video = GenericFile.objects.create(
        owner=creator_factory(),
        file=ContentFile(b"video", name="already-pending.mp4"),
        mime_type="video/mp4",
    )
    before = ProcrastinateJob.objects.filter(
        task_name="uploads.generate_video_poster",
        args={"generic_file_id": video.pk},
    ).count()
    assert before == 1

    with pytest.raises(CommandError, match="max-inflight 1"):
        call_command(
            "backfill_video_posters", "--limit", "1", "--rate", "40",
            "--max-inflight", "1",
        )

    assert ProcrastinateJob.objects.filter(
        task_name="uploads.generate_video_poster",
        args={"generic_file_id": video.pk},
    ).count() == before


@pytest.mark.django_db(transaction=True)
def test_a_child_killed_by_the_node_retries_instead_of_giving_up(
    creator_factory, monkeypatch
):
    """SIGKILL is not our limit firing; it is the cgroup OOM killer.

    Our own timeout kill raises before this point, so a SIGKILL here means
    the NODE was under memory pressure -- which says nothing about this
    video. Terminal would leave a perfectly good upload posterless until its
    cooled-down sweep readmission. `VARIANT_RETRY` allows eight infrastructure
    retries after the initial run, so retrying is bounded.
    """
    video = _make_video(creator_factory(), seconds=1)

    def _oom_killed(source_path, demux_format, output_path):
        return [sys.executable, "-c", "import os, signal; os.kill(os.getpid(), signal.SIGKILL)"]

    monkeypatch.setattr(video_utils, "_child_argv", _oom_killed)

    with pytest.raises(video_utils.PosterRetryable):
        video_utils.extract_poster_bytes(video)


@pytest.mark.django_db(transaction=True)
def test_our_own_ceilings_firing_stay_terminal(creator_factory, monkeypatch):
    """...but a file that trips OUR limits will trip them again.

    Retrying that only burns the queue, so SIGXCPU and SIGXFSZ must NOT be
    retryable. Without this the previous test's fix would make every resource
    bomb cost nine executions instead of one.
    """
    video = _make_video(creator_factory(), seconds=1)

    def _cpu_limited(source_path, demux_format, output_path):
        return [sys.executable, "-c", "import os, signal; os.kill(os.getpid(), signal.SIGXCPU)"]

    monkeypatch.setattr(video_utils, "_child_argv", _cpu_limited)

    assert video_utils.extract_poster_bytes(video) is None
