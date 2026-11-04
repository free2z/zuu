"""
create_thumbnails batching/streaming tests (2026-07-19 prod OOM).

Real Postgres, per repo convention — the whole point of these tests is
what the ORM actually sends to the database, so a mocked DB would prove
nothing. Only the storage backend (GCS in settings) is redirected to a
tmp dir, the same external-boundary swap test_image_variants.py makes.

The regression under test: the old command evaluated a single
`filter(...)[:1000]` queryset, so every pending row (and everything
Pillow allocated through it) stayed alive for the whole run. These
tests assert the opposite property directly — that no single SELECT
against uploads_genericfile ever fetches more than --batch-size rows.
"""
from io import BytesIO

import pytest
from PIL import Image

from django.core.files.base import ContentFile
from django.core.management import call_command
from django.db import connection
from django.test.utils import CaptureQueriesContext

from dj.apps.uploads.image_utils import MAX_DECODE_PIXELS
from dj.apps.uploads.management.commands import create_thumbnails
from dj.apps.uploads.models import GenericFile, Webp


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
        },
    }
    settings.MEDIA_ROOT = str(tmp_path)


def _png_bytes(width=40, height=30, color=(10, 120, 200)):
    out = BytesIO()
    Image.new("RGB", (width, height), color).save(out, format="PNG")
    return out.getvalue()


def _make_image(creator, name="pic.png", access="public", data=None,
                mime_type="image/png"):
    return GenericFile.objects.create(
        owner=creator,
        file=ContentFile(data if data is not None else _png_bytes(),
                         name=name),
        mime_type=mime_type,
        access=access,
    )


def _genericfile_selects(captured):
    return [
        q["sql"] for q in captured.captured_queries
        if q["sql"].lstrip().upper().startswith("SELECT")
        and "uploads_genericfile" in q["sql"]
        and " LIMIT " in q["sql"].upper()
    ]


@pytest.mark.django_db(transaction=True)
def test_processes_every_pending_image_exactly_once(creator_factory):
    creator = creator_factory()
    images = [_make_image(creator, name=f"pic{i}.png") for i in range(5)]

    call_command("create_thumbnails", "--batch-size", "2")

    assert Webp.objects.count() == 5
    assert set(
        Webp.objects.values_list("parent_id", flat=True)
    ) == {i.pk for i in images}


@pytest.mark.django_db(transaction=True)
def test_never_fetches_more_than_batch_size_rows(creator_factory):
    """
    The actual OOM regression: bound the working set, not the table.

    Every SELECT the command issues against uploads_genericfile must
    carry LIMIT <= batch_size, and there must be several of them — i.e.
    the rows are streamed in pages, not slurped in one query.
    """
    creator = creator_factory()
    for i in range(7):
        _make_image(creator, name=f"batch{i}.png")

    with CaptureQueriesContext(connection) as captured:
        call_command("create_thumbnails", "--batch-size", "2")

    selects = _genericfile_selects(captured)
    # 7 rows / 2 per page = 4 pages of work + 1 empty page to terminate.
    assert len(selects) >= 4
    for sql in selects:
        limit = int(sql.upper().rsplit(" LIMIT ", 1)[1].split()[0])
        assert limit <= 2, sql

    assert Webp.objects.count() == 7


@pytest.mark.django_db(transaction=True)
def test_limit_caps_work_per_run_and_run_resumes(creator_factory):
    creator = creator_factory()
    for i in range(5):
        _make_image(creator, name=f"lim{i}.png")

    call_command("create_thumbnails", "--limit", "2", "--batch-size", "10")
    assert Webp.objects.count() == 2

    # The next tick picks up exactly where this one stopped.
    call_command("create_thumbnails", "--limit", "2", "--batch-size", "10")
    assert Webp.objects.count() == 4

    call_command("create_thumbnails")
    assert Webp.objects.count() == 5


@pytest.mark.django_db(transaction=True)
def test_batch_size_never_exceeds_remaining_limit(creator_factory):
    creator = creator_factory()
    for i in range(5):
        _make_image(creator, name=f"cap{i}.png")

    with CaptureQueriesContext(connection) as captured:
        call_command("create_thumbnails", "--limit", "3", "--batch-size", "10")

    for sql in _genericfile_selects(captured):
        limit = int(sql.upper().rsplit(" LIMIT ", 1)[1].split()[0])
        assert limit <= 3, sql
    assert Webp.objects.count() == 3


@pytest.mark.django_db(transaction=True)
def test_unreadable_image_is_skipped_and_does_not_wedge_the_sweep(
        creator_factory):
    """
    A file that can't be decoded must leave the pending set, otherwise
    every run re-picks it and the sweep never advances — the failure
    mode that kept the prod job busy for 33h.
    """
    creator = creator_factory()
    bad = _make_image(creator, name="bad.png", data=b"not-an-image")
    good = _make_image(creator, name="good.png")

    call_command("create_thumbnails", "--batch-size", "1")

    bad.refresh_from_db()
    assert bad.skip_thumbnail is True
    assert Webp.objects.filter(parent=good).exists()
    assert not create_thumbnails.pending_queryset().exists()


@pytest.mark.django_db(transaction=True)
def test_oversized_raster_is_skipped_without_decoding(
        creator_factory, monkeypatch):
    """
    Decoded size is width*height*4 and unrelated to the compressed size
    on disk, so the pixel ceiling — not the file size — is what keeps a
    single image from blowing the container's memory limit.
    """
    creator = creator_factory()
    # A 4000x4000 flat PNG is a few KB on disk but 64MP decoded.
    huge = _make_image(creator, name="huge.png",
                       data=_png_bytes(4000, 4000))
    monkeypatch.setattr(
        "dj.apps.uploads.image_utils.MAX_DECODE_PIXELS", 1_000_000)

    call_command("create_thumbnails")

    huge.refresh_from_db()
    assert huge.skip_thumbnail is True
    assert not Webp.objects.filter(parent=huge).exists()
    assert MAX_DECODE_PIXELS > 0  # sanity: the real ceiling is set


@pytest.mark.django_db(transaction=True)
def test_private_and_non_raster_images_are_not_picked_up(creator_factory):
    creator = creator_factory()
    private = _make_image(creator, name="priv.png", access="private")
    gif = _make_image(creator, name="anim.gif", data=b"GIF89a...",
                      mime_type="image/gif")
    public = _make_image(creator, name="pub.png")

    call_command("create_thumbnails")

    assert Webp.objects.count() == 1
    assert Webp.objects.get().parent_id == public.pk
    assert not Webp.objects.filter(parent__in=[private, gif]).exists()
