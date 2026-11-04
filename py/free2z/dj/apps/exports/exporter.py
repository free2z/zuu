import datetime
import hashlib
import json
import logging
import mimetypes
import os
import re
import stat
import tempfile
import time
import zipfile
from decimal import Decimal
from pathlib import Path
from urllib.parse import unquote, urlsplit

import yaml
from django.conf import settings
from django.core.files.base import File
from django.db import connection, transaction
from django.db.models import Q
from django.utils import timezone
from storages.backends.gcloud import GoogleCloudStorage

from dj.apps.g12f.embedded_media import FRONTMATTER_RE, _strip_fenced_blocks
from dj.apps.g12f.localization import get_owner_visible_variants
from dj.apps.g12f.models import Creator, Poll, Series, zPage
from dj.apps.uploads.models import GenericFile
from .models import ExportStatus, PublicationExportJob
from .storage import get_export_storage

logger = logging.getLogger(__name__)

# Operational bound: the 1 GiB payload cap can occupy roughly twice that on
# disk while the staged source/assets and final ZIP coexist.
DEFAULT_MAX_ARCHIVE_BYTES = 1 * 1024 * 1024 * 1024  # 1 GiB
DEFAULT_MAX_DURATION_SECONDS = 30 * 60  # 30 minutes
CHUNK_SIZE = 64 * 1024  # 64 KB
GCS_DOWNLOAD_CHUNK_SIZE = 256 * 1024  # google-resumable-media requires 256 KiB multiples
MAX_REFERENCED_UPLOAD_KEYS = 10_000
MAX_UNBUNDLED_REFERENCES = 10_000
MAX_EXPORT_WARNINGS = 1_000

# Directives & Link extractors. This prefix mirrors the frontend block
# tokenizer's container handling (and dj.apps.g12f.embedded_media): directives
# are block syntax, not every ``::word`` appearing in prose or source code.
_LIST_MARKER = r"(?:[-*+]|\d{1,9}[.)])[ \t]+"
_BLOCKQUOTE = r"(?:>[ \t]{0,3})+"
_CONTAINER_PREFIX = (
    r"(?:(?:" + _BLOCKQUOTE + r"(?:" + _LIST_MARKER + r")?"
    r"|" + _LIST_MARKER + r")[ \t]{0,3})?"
)
DIRECTIVE_RE = re.compile(
    r"^(?P<prefix> {0,3}" + _CONTAINER_PREFIX + r")"
    r"(?P<directive>::(?P<name>[a-zA-Z0-9_-]+)\[(?P<arg>[^\]\n]+)\])"
    r"(?P<trailing>[ \t]*)$",
    re.IGNORECASE,
)
SUPPORTED_DIRECTIVES = frozenset({"embed", "iframe", "qrcode"})
MD_LINK_RE = re.compile(r"(!?\[.*?\])\((.*?)\)")
HTML_ATTR_RE = re.compile(r"""(?i)\b(?:src|href)=["']([^"']+)["']""")

ALLOWED_FREE2Z_HOSTS = frozenset({
    "free2z.cash",
    "www.free2z.cash",
    "free2z.com",
    "www.free2z.com",
    "storage.googleapis.com",
})

# free2zaddr is max_length=128; language is max_length=35 (LANGUAGE_TAG_MAX_LENGTH)
SAFE_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,128}$")
SAFE_LANG_RE = re.compile(r"^[a-zA-Z0-9_-]{1,35}$")


class ExportSizeLimitExceeded(Exception):
    """Raised when generated archive or temporary disk usage exceeds limit."""


class ExportTimeoutExceeded(Exception):
    """Raised when export execution exceeds maximum allowed wall time."""


class HostilePathError(Exception):
    """Raised when an entry path attempts traversal or absolute referencing."""


def sanitize_archive_path(path_str: str) -> str:
    """Validate and normalize archive entry path according to security rules.

    Rejects:
    - Absolute paths
    - Path traversal ('..')
    - NUL bytes or control characters (< ASCII 32 or == 127)
    """
    if path_str.startswith("/") or path_str.startswith("\\"):
        raise HostilePathError(f"Absolute archive paths are not permitted: {path_str}")

    for ch in path_str:
        code = ord(ch)
        if code < 32 or code == 127:
            raise HostilePathError(f"Control characters are not permitted in archive paths: {path_str!r}")

    normalized = os.path.normpath(path_str).replace("\\", "/")
    parts = normalized.split("/")

    if ".." in parts or normalized.startswith(".."):
        raise HostilePathError(f"Directory traversal is not permitted: {path_str}")

    return normalized


def _iso_utc(dt: datetime.datetime | None) -> str | None:
    if dt is None:
        return None
    if timezone.is_naive(dt):
        dt = timezone.make_aware(dt, datetime.timezone.utc)
    else:
        dt = dt.astimezone(datetime.timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _decimal_to_str(val: Decimal | None) -> str | None:
    if val is None:
        return None
    return str(val)


def normalize_upload_candidate(raw_url: str) -> str | None:
    """Extract clean relative upload key from candidate URL if it belongs to Free2Z upload storage."""
    if not raw_url:
        return None
    try:
        parsed = urlsplit(raw_url.strip())
    except Exception:
        return None

    # Check host if absolute URL
    if parsed.netloc:
        netloc_lower = parsed.netloc.lower()
        if netloc_lower not in ALLOWED_FREE2Z_HOSTS:
            return None
        if netloc_lower == "storage.googleapis.com":
            path = unquote(parsed.path)
            for bucket_prefix in ["/free2z-uploads/", "free2z-uploads/"]:
                if path.startswith(bucket_prefix):
                    rel = path[len(bucket_prefix):].lstrip("/")
                    if rel.startswith("public/"):
                        rel = rel[len("public/"):]
                    return rel.lstrip("/")
            return None
        else:
            path = unquote(parsed.path)
    else:
        path = unquote(parsed.path)

    # Reject traversal or control characters in decoded path
    for ch in path:
        code = ord(ch)
        if code < 32 or code == 127:
            return None
    if ".." in path.split("/"):
        return None

    for prefix in [
        "/uploadz/public/",
        "/uploadz/",
        "/uploads/public/",
        "/uploads/",
        "uploadz/public/",
        "uploadz/",
        "uploads/public/",
        "uploads/",
    ]:
        if path.startswith(prefix):
            rel_key = path[len(prefix):]
            return rel_key.lstrip("/")

    return None


class BoundedZipStreamWriter:
    """Streams data into a ZIP file while enforcing ZIP64, regular-file attributes, size, and timeout bounds."""

    def __init__(
        self,
        zip_file: zipfile.ZipFile,
        zip_path: Path,
        max_bytes: int,
        max_duration: int,
        start_time: float,
    ):
        self.zip_file = zip_file
        self.zip_path = zip_path
        self.max_bytes = max_bytes
        self.max_duration = max_duration
        self.start_time = start_time
        self.total_uncompressed = 0
        self.seen_paths: set[str] = set()
        self.entry_checksums: dict[str, str] = {}

    def check_limits(self, additional_bytes: int = 0):
        now = time.monotonic()
        if now - self.start_time > self.max_duration:
            raise ExportTimeoutExceeded("Export generation exceeded maximum time limit.")
        if self.total_uncompressed + additional_bytes > self.max_bytes:
            raise ExportSizeLimitExceeded("Export archive exceeded maximum size limit.")
        if self.zip_path.exists() and self.zip_path.stat().st_size > self.max_bytes:
            raise ExportSizeLimitExceeded("Export archive exceeded maximum size limit.")

    def writestr(self, arcname: str, data: bytes | str):
        arcname = sanitize_archive_path(arcname)
        if arcname in self.seen_paths:
            raise ValueError(f"Duplicate archive path detected: {arcname}")
        self.seen_paths.add(arcname)

        if isinstance(data, str):
            data_bytes = data.encode("utf-8")
        else:
            data_bytes = data

        self.check_limits(len(data_bytes))
        sha256 = hashlib.sha256(data_bytes).hexdigest()
        self.entry_checksums[arcname] = sha256

        zinfo = zipfile.ZipInfo(arcname, time.gmtime()[:6])
        zinfo.compress_type = zipfile.ZIP_DEFLATED
        zinfo.create_system = 3  # Unix
        zinfo.external_attr = (stat.S_IFREG | 0o644) << 16
        self.zip_file.writestr(zinfo, data_bytes)
        self.total_uncompressed += len(data_bytes)

    def write_stream(self, arcname: str, stream):
        arcname = sanitize_archive_path(arcname)
        if arcname in self.seen_paths:
            raise ValueError(f"Duplicate archive path detected: {arcname}")
        self.seen_paths.add(arcname)

        zinfo = zipfile.ZipInfo(arcname, time.gmtime()[:6])
        zinfo.compress_type = zipfile.ZIP_DEFLATED
        zinfo.create_system = 3  # Unix
        zinfo.external_attr = (stat.S_IFREG | 0o644) << 16

        hasher = hashlib.sha256()

        with self.zip_file.open(zinfo, mode="w", force_zip64=True) as dest:
            while True:
                self.check_limits()
                chunk = stream.read(CHUNK_SIZE)
                if not chunk:
                    break
                self.check_limits(len(chunk))
                hasher.update(chunk)
                dest.write(chunk)
                self.total_uncompressed += len(chunk)

        self.entry_checksums[arcname] = hasher.hexdigest()


class PublicationExporter:
    """Builds a complete, self-contained, portable publication archive ZIP."""

    def __init__(self, job: PublicationExportJob):
        self.job = job
        self.creator_id = job.creator_id
        self.creator: Creator | None = None
        self.max_bytes = getattr(settings, "EXPORT_MAX_ARCHIVE_BYTES", DEFAULT_MAX_ARCHIVE_BYTES)
        self.max_duration = getattr(settings, "EXPORT_MAX_DURATION_SECONDS", DEFAULT_MAX_DURATION_SECONDS)
        self.start_time = time.monotonic()

        self.warnings: list[str] = []
        self._warning_set: set[str] = set()
        self.complete = True
        self.spooled_bytes = 0

        self.asset_registry: dict[str, dict] = {}  # sha256 -> asset metadata
        self.upload_to_asset: dict[str, str] = {}  # normalized upload key -> relative asset path
        self.genericfile_to_asset: dict[int, str] = {}  # genericfile.id -> relative asset path
        self.unbundled_references: list[dict] = []
        self._unbundled_reference_keys: set[tuple] = set()
        self._unbundled_limit_warned = False
        self._referenced_upload_limit_warned = False

        self.temp_dir: tempfile.TemporaryDirectory | None = None
        self.temp_zip_path: Path | None = None

    def _check_timeout(self):
        if time.monotonic() - self.start_time > self.max_duration:
            raise ExportTimeoutExceeded("Export generation exceeded maximum time limit.")

    def _warn(self, message: str, incomplete: bool = True):
        if message not in self._warning_set and len(self.warnings) < MAX_EXPORT_WARNINGS:
            self._warning_set.add(message)
            self.warnings.append(message)
        if incomplete:
            self.complete = False
        logger.warning("Publication export job %s: %s", self.job.id, message)

    def _record_unbundled(self, url: str, reason: str, free2zaddr: str | None, lang: str | None):
        """Record unbundled media reference deduplicating identical entries."""
        key = (url, reason, free2zaddr, lang)
        if key in self._unbundled_reference_keys:
            return
        if len(self.unbundled_references) >= MAX_UNBUNDLED_REFERENCES:
            if not self._unbundled_limit_warned:
                self._unbundled_limit_warned = True
                self._warn(
                    "Additional unbundled media references were omitted after the export safety limit.",
                    incomplete=True,
                )
            return
        rec = {
            "url": url,
            "reason": reason,
            "article_free2zaddr": free2zaddr,
            "language": lang,
        }
        self._unbundled_reference_keys.add(key)
        self.unbundled_references.append(rec)

    def _record_referenced_upload(self, snapshot_meta: dict, key: str):
        """Bound candidate cardinality before it reaches the ownership query."""
        referenced = snapshot_meta["referenced_upload_keys"]
        if key in referenced:
            return
        if len(referenced) >= MAX_REFERENCED_UPLOAD_KEYS:
            if not self._referenced_upload_limit_warned:
                self._referenced_upload_limit_warned = True
                self._warn(
                    "Additional upload references were omitted after the export safety limit.",
                    incomplete=True,
                )
            return
        referenced.add(key)

    def _open_asset_stream(self, field_file):
        """Open an asset without buffering an entire GCS blob in RAM."""
        storage = field_file.storage
        if isinstance(storage, GoogleCloudStorage):
            blob = storage.bucket.blob(
                field_file.name,
                chunk_size=GCS_DOWNLOAD_CHUNK_SIZE,
            )
            remaining = max(
                1,
                min(60, int(self.max_duration - (time.monotonic() - self.start_time))),
            )
            return blob.open(
                "rb",
                chunk_size=GCS_DOWNLOAD_CHUNK_SIZE,
                timeout=remaining,
            )
        return field_file.open("rb")

    def export(self):
        """Execute full publication export pipeline."""
        self.job.status = ExportStatus.RUNNING
        self.job.started_at = timezone.now()
        self.job.save(update_fields=["status", "started_at", "updated_at"])

        self.temp_dir = tempfile.TemporaryDirectory(prefix="export_spool_")
        spool_path = Path(self.temp_dir.name)
        self.temp_zip_path = spool_path / "export_output.zip"

        try:
            # 1. Single Repeatable-Read Database Snapshot spooled to disk
            snapshot_meta = self._spool_snapshot_to_disk(spool_path)

            # 2. Bulk spool, hash, and deduplicate creator-owned uploads into local spool files
            self._resolve_creator_assets(snapshot_meta, spool_path)

            # 3. Stream ZIP archive from verified local spool
            self._build_archive_zip(spool_path, snapshot_meta)

            # 4. Save to private export storage. _persist_archive_to_storage()
            # records the deterministic object key on the job before the
            # upload starts, so an abrupt worker death can still be reconciled
            # by cleanup_expired_jobs().
            self._persist_archive_to_storage()

            completed_at = timezone.now()
            updated = PublicationExportJob.objects.filter(
                id=self.job.id,
                status=ExportStatus.RUNNING,
            ).update(
                status=ExportStatus.READY,
                complete=self.complete,
                warnings=self.warnings,
                completed_at=completed_at,
                expires_at=completed_at + datetime.timedelta(hours=24),
                file_path=self.job.file_path,
                file_size=self.job.file_size,
                checksum_sha256=self.job.checksum_sha256,
                article_count=self.job.article_count,
                asset_count=self.job.asset_count,
                updated_at=completed_at,
            )
            if updated != 1:
                # The abandonment sweep may have failed this row while a
                # storage operation was still returning. Never resurrect it as
                # READY after cleanup has revoked the artifact.
                raise RuntimeError("Publication export job is no longer active.")
            self.job.refresh_from_db()

        except (ExportSizeLimitExceeded, ExportTimeoutExceeded) as e:
            self._handle_failure(str(e))
            raise
        except Exception as e:
            logger.exception("Publication export failed for job %s: %s", self.job.id, e)
            self._handle_failure("Failed to generate publication export archive.")
            raise
        finally:
            self._cleanup_temp_files()

    def _handle_failure(self, user_safe_error: str):
        self.job.status = ExportStatus.FAILED
        self.job.error_message = user_safe_error
        self.job.save(update_fields=["status", "error_message", "updated_at"])

        if self.job.file_path:
            try:
                storage = get_export_storage()
                if storage.exists(self.job.file_path):
                    storage.delete(self.job.file_path)
                self.job.file_path = ""
                self.job.save(update_fields=["file_path", "updated_at"])
            except Exception as e:
                logger.error("Failed to delete partial export artifact %s on failure: %s", self.job.file_path, e)

    def _cleanup_temp_files(self):
        if self.temp_dir is not None:
            try:
                self.temp_dir.cleanup()
            except Exception:
                pass
            self.temp_dir = None

    def _spool_snapshot_to_disk(self, spool_path: Path) -> dict:
        """Capture single coherent repeatable-read DB snapshot and stream articles directly to disk spool JSONL."""
        spool_articles_dir = spool_path / "articles"
        spool_articles_dir.mkdir(parents=True, exist_ok=True)
        articles_jsonl_path = spool_path / "articles.jsonl"

        snapshot_meta = {
            "creator": {},
            "series": [],
            "referenced_upload_keys": set(),
            "referenced_gf_ids": set(),
            "owned_generic_files": [],
            "article_count": 0,
            "articles_jsonl_path": str(articles_jsonl_path),
        }

        # PostgreSQL genuine REPEATABLE READ snapshot
        with transaction.atomic():
            if connection.vendor == "postgresql":
                with connection.cursor() as cursor:
                    cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")

            # Reload Creator by creator_id with avatar_image and banner_image within transaction
            creator = (
                Creator.objects.select_related("avatar_image", "banner_image")
                .get(id=self.creator_id)
            )
            self.creator = creator
            canonical_creator_url = f"https://free2z.cash/{creator.username}"

            # Public avatar and banner handling
            avatar_image_id = None
            if creator.avatar_image_id:
                if getattr(creator.avatar_image, "access", None) == "public":
                    avatar_image_id = creator.avatar_image_id
                    snapshot_meta["referenced_gf_ids"].add(creator.avatar_image_id)
                else:
                    self._warn("Creator avatar image is private and was excluded from profile metadata.", incomplete=False)

            banner_image_id = None
            if creator.banner_image_id:
                if getattr(creator.banner_image, "access", None) == "public":
                    banner_image_id = creator.banner_image_id
                    snapshot_meta["referenced_gf_ids"].add(creator.banner_image_id)
                else:
                    self._warn("Creator banner image is private and was excluded from profile metadata.", incomplete=False)

            snapshot_meta["creator"] = {
                "username": creator.username,
                "full_name": creator.full_name or "",
                "description": creator.description or "",
                "p2paddr": creator.p2paddr or "",
                "canonical_url": canonical_creator_url,
                "created_at": _iso_utc(creator.date_joined),
                "avatar_image_id": avatar_image_id,
                "banner_image_id": banner_image_id,
            }

            # Series metadata & ordering (Series has NO description field)
            series_qs = (
                Series.objects.filter(creator=creator)
                .prefetch_related("pageorder_set__page")
                .order_by("id")
            )
            article_series_memberships: dict[str, list[dict]] = {}
            for s in series_qs:
                s_id_str = str(s.id)
                ordered_orders = list(
                    s.pageorder_set.filter(page__creator=creator)
                    .order_by("order", "id")
                    .values_list("page__free2zaddr", "order")
                )
                ordered_addrs_with_order = [
                    {"free2zaddr": addr, "order": order_num}
                    for addr, order_num in ordered_orders
                ]
                for addr, order_num in ordered_orders:
                    article_series_memberships.setdefault(addr, []).append(
                        {
                            "series_id": s_id_str,
                            "series_name": s.name,
                            "order": order_num,
                        }
                    )

                snapshot_meta["series"].append(
                    {
                        "id": s_id_str,
                        "name": s.name,
                        "created_at": _iso_utc(s.created_at),
                        "updated_at": _iso_utc(s.updated_at),
                        "articles": ordered_addrs_with_order,
                    }
                )

            # Query all owned articles with prefetch
            # Both related sets carry complete article bodies. Keep the
            # batch deliberately small: a creator can have many draft
            # languages, and batching 50 articles can otherwise materialize
            # close to the worker's whole 1 GiB limit before the streaming
            # size checks get a chance to run.
            #
            # Not `.iterator(chunk_size=1)`: with
            # DISABLE_SERVER_SIDE_CURSORS that would receive every article
            # body of this creator in one client-side result. Instead: ONE
            # ordered scan for the ids (integers only), then one primary-key
            # fetch per article with its prefetches. Not a keyset walk on
            # (created_at, id) either -- no index serves that order across
            # drafts and published pages, so each page would rescan the
            # creator's rows (quadratic; codex review). Every statement runs
            # inside the REPEATABLE READ transaction above, so the ids and
            # the rows come from the same snapshot.
            article_ids = list(
                zPage.objects.filter(creator=creator)
                .order_by("created_at", "id")
                .values_list("id", flat=True)
            )
            article_base_qs = (
                zPage.objects.filter(creator=creator)
                .select_related("poll", "featured_image", "enclosure")
                .prefetch_related("tags", "translations", "variants")
            )

            def _articles_one_at_a_time():
                for article_id in article_ids:
                    yield from article_base_qs.filter(pk=article_id)

            article_qs = _articles_one_at_a_time()

            seen_free2zaddrs = set()

            with articles_jsonl_path.open("w", encoding="utf-8") as articles_jsonl_file:
                for page in article_qs:
                    self._check_timeout()
                    addr = page.free2zaddr

                    # Sanitize free2zaddr before creating directory
                    if not SAFE_NAME_RE.match(addr):
                        raise HostilePathError(f"Hostile or invalid article free2zaddr: {addr!r}")
                    if addr in seen_free2zaddrs:
                        raise ValueError(f"Duplicate article address detected in snapshot: {addr}")
                    seen_free2zaddrs.add(addr)

                    article_dir = spool_articles_dir / addr
                    article_dir.mkdir(parents=True, exist_ok=True)
                    translations_dir = article_dir / "translations"
                    translations_dir.mkdir(parents=True, exist_ok=True)

                    if page.featured_image_id:
                        snapshot_meta["referenced_gf_ids"].add(page.featured_image_id)
                    if page.enclosure_id:
                        snapshot_meta["referenced_gf_ids"].add(page.enclosure_id)

                    # Poll metadata (EXCLUDING viewing keys and voter identities)
                    poll_meta = None
                    if page.poll is not None:
                        poll: Poll = page.poll
                        poll_options = []
                        for i in range(1, 6):
                            opt_text = getattr(poll, f"option{i}", "")
                            if opt_text:
                                poll_options.append(
                                    {
                                        "text": opt_text,
                                        "votes": getattr(poll, f"option{i}_votes", 0),
                                        "total": _decimal_to_str(getattr(poll, f"option{i}_total", None)),
                                    }
                                )
                        poll_meta = {
                            "question": poll.question,
                            "options": poll_options,
                        }

                    # Public localization abstraction for owner-visible variants
                    variants = get_owner_visible_variants(page)
                    article_variants_meta = []
                    seen_variant_languages = set()

                    for var in variants:
                        lang = var.language
                        if not SAFE_LANG_RE.match(lang):
                            raise HostilePathError(f"Hostile or invalid variant language: {lang!r}")
                        if lang in seen_variant_languages:
                            raise ValueError(f"Duplicate variant language '{lang}' in article {addr}")
                        seen_variant_languages.add(lang)

                        # Scan and collect candidate upload keys from content
                        self._scan_content_for_upload_candidates(var.content, snapshot_meta)

                        # Write raw Markdown body to disk spool
                        if var.is_source:
                            raw_rel = f"articles/{addr}/source.free2z.md"
                            portable_rel = f"articles/{addr}/index.md"
                            target_raw = article_dir / "source.free2z.md"
                        else:
                            raw_rel = f"articles/{addr}/translations/{lang}.free2z.md"
                            portable_rel = f"articles/{addr}/translations/{lang}.md"
                            target_raw = translations_dir / f"{lang}.free2z.md"

                        if target_raw.exists():
                            raise ValueError(f"Spool collision detected: {target_raw}")

                        raw_bytes = var.content.encode("utf-8")
                        self.spooled_bytes += len(raw_bytes)
                        if self.spooled_bytes > self.max_bytes:
                            raise ExportSizeLimitExceeded("Export temporary disk spool exceeded maximum size limit.")

                        with target_raw.open("wb") as f:
                            f.write(raw_bytes)

                        article_variants_meta.append(
                            {
                                "language": lang,
                                "is_source": var.is_source,
                                "title": var.title,
                                "description": var.description,
                                "is_published": var.is_published,
                                "origin": var.origin,
                                "is_stale": var.is_stale,
                                "updated_at": _iso_utc(var.updated_at),
                                "created_at": _iso_utc(var.created_at),
                                "path": portable_rel,
                                "raw_path": raw_rel,
                            }
                        )

                    vanity_val = page.vanity if page.vanity else None
                    canonical_f2z = (
                        f"https://free2z.cash/{creator.username}/{vanity_val}"
                        if vanity_val
                        else f"https://free2z.cash/{creator.username}/{addr}"
                    )
                    tags_list = sorted(list(page.tags.names()))

                    source_var = next((v for v in variants if v.is_source), None)
                    source_title = source_var.title if source_var else (page.title or "")
                    source_description = source_var.description if source_var else (page.description or "")

                    # Derive explicit publication status (scheduled in Free2Z is is_published=False with future publish_at)
                    if not page.is_published and page.publish_at and page.publish_at > timezone.now():
                        publication_status = "scheduled"
                    elif page.is_published:
                        publication_status = "published"
                    else:
                        publication_status = "draft"

                    article_record = {
                        "free2zaddr": addr,
                        "vanity": vanity_val,
                        "canonical_free2z_url": canonical_f2z,
                        "canonical_url": page.canonical_url or None,
                        "category": page.category or "GENERAL",
                        "source_language": page.source_language or "und",
                        "source_title": source_title,
                        "source_description": source_description,
                        "p2paddr": getattr(page, "p2paddr", None) or None,
                        "publication_status": publication_status,
                        "is_published": page.is_published,
                        "is_subscriber_only": page.is_subscriber_only,
                        "created_at": _iso_utc(page.created_at),
                        "updated_at": _iso_utc(page.updated_at),
                        "published_at": _iso_utc(getattr(page, "published_at", None)),
                        "publish_at": _iso_utc(page.publish_at),
                        "goal": _decimal_to_str(page.goal),
                        "total": _decimal_to_str(page.total),
                        "tuzi_total": page.tuzi_total,
                        "tags": tags_list,
                        "series_memberships": article_series_memberships.get(addr, []),
                        "featured_image_id": page.featured_image_id,
                        "enclosure_id": page.enclosure_id,
                        "poll": poll_meta,
                        "variants": article_variants_meta,
                    }

                    line_str = json.dumps(article_record, ensure_ascii=False) + "\n"
                    line_bytes = line_str.encode("utf-8")
                    self.spooled_bytes += len(line_bytes)
                    if self.spooled_bytes > self.max_bytes:
                        raise ExportSizeLimitExceeded("Export temporary disk spool exceeded maximum size limit.")
                    articles_jsonl_file.write(line_str)
                    snapshot_meta["article_count"] += 1

            # Query all creator GenericFiles within the single repeatable-read transaction
            referenced_keys = snapshot_meta["referenced_upload_keys"]
            referenced_ids = snapshot_meta["referenced_gf_ids"]

            q = Q()
            if referenced_ids:
                q |= Q(id__in=referenced_ids)
            if referenced_keys:
                q |= Q(file__in=referenced_keys)

            if referenced_ids or referenced_keys:
                owned_gfs = list(GenericFile.objects.filter(owner=creator).filter(q))
            else:
                owned_gfs = []

            snapshot_meta["owned_generic_files"] = owned_gfs

        return snapshot_meta

    def _scan_content_for_upload_candidates(self, content: str, snapshot_meta: dict):
        """Extract candidate upload keys from Markdown links, HTML attributes, and directives."""
        if not content:
            return

        for match in MD_LINK_RE.finditer(content):
            url = match.group(2).strip()
            norm = normalize_upload_candidate(url)
            if norm:
                self._record_referenced_upload(snapshot_meta, norm)

        for match in HTML_ATTR_RE.finditer(content):
            url = match.group(1).strip()
            norm = normalize_upload_candidate(url)
            if norm:
                self._record_referenced_upload(snapshot_meta, norm)

        for line in self._portable_rewrite_line_pairs(content):
            match = DIRECTIVE_RE.match(line[1])
            if match:
                target = match.group("arg").strip()
                norm = normalize_upload_candidate(target)
                if norm:
                    self._record_referenced_upload(snapshot_meta, norm)

    def _resolve_creator_assets(self, snapshot_meta: dict, spool_path: Path):
        """Stream referenced remote blobs once into verified local spool files, hash and deduplicate strictly by SHA."""
        spool_assets_dir = spool_path / "assets"
        spool_assets_dir.mkdir(parents=True, exist_ok=True)

        owned_files = snapshot_meta["owned_generic_files"]

        for gf in owned_files:
            self._check_timeout()
            orig_url = gf.get_url() if hasattr(gf, "get_url") else f"/uploadz/{gf.file.name}"
            norm_key = normalize_upload_candidate(gf.file.name)
            temp_spool = spool_assets_dir / f"temp_{gf.id}.bin"
            bytes_streamed = 0

            try:
                if not gf.file or not gf.file.storage.exists(gf.file.name):
                    self._warn("A referenced media asset could not be read from storage.", incomplete=True)
                    self._record_unbundled(orig_url, "missing_blob", None, None)
                    continue

                hasher = hashlib.sha256()

                with self._open_asset_stream(gf.file) as src, temp_spool.open("wb") as dst:
                    while True:
                        self._check_timeout()
                        chunk = src.read(CHUNK_SIZE)
                        if not chunk:
                            break
                        self.spooled_bytes += len(chunk)
                        if self.spooled_bytes > self.max_bytes:
                            raise ExportSizeLimitExceeded("Export temporary disk spool exceeded maximum size limit.")
                        hasher.update(chunk)
                        dst.write(chunk)
                        bytes_streamed += len(chunk)

                sha256 = hasher.hexdigest()

                upload_info = {
                    "id": gf.id,
                    "name": Path(gf.file.name).name,
                    "mime_type": gf.mime_type or "application/octet-stream",
                    "access": gf.access,
                    "byte_length": bytes_streamed,
                    "original_url": orig_url,
                }

                if sha256 in self.asset_registry:
                    # Strict SHA deduplication: reuse existing registry entry and delete redundant temp spool
                    if temp_spool.exists():
                        temp_spool.unlink()
                        self.spooled_bytes -= bytes_streamed

                    existing_entry = self.asset_registry[sha256]
                    rel_asset_path = existing_entry["path"]
                    if not any(u["id"] == gf.id for u in existing_entry["uploads"]):
                        existing_entry["uploads"].append(upload_info)
                else:
                    ext = self._safe_extension(gf.file.name, gf.mime_type)
                    final_spool = spool_assets_dir / f"{sha256}{ext}"
                    rel_asset_path = f"assets/{sha256}{ext}"

                    temp_spool.rename(final_spool)
                    self.asset_registry[sha256] = {
                        "sha256": sha256,
                        "path": rel_asset_path,
                        "spool_file": str(final_spool),
                        "byte_length": bytes_streamed,
                        "mime_type": gf.mime_type or "application/octet-stream",
                        "uploads": [upload_info],
                        "references": [],
                    }

                # Install lookup mappings
                self.genericfile_to_asset[gf.id] = rel_asset_path
                if norm_key:
                    self.upload_to_asset[norm_key] = rel_asset_path
                self.upload_to_asset[gf.file.name] = rel_asset_path
                self.upload_to_asset[orig_url] = rel_asset_path

            except ExportSizeLimitExceeded:
                if temp_spool.exists():
                    temp_spool.unlink()
                    self.spooled_bytes -= bytes_streamed
                raise
            except Exception as e:
                logger.warning("Failed to spool media asset %s: %s", gf.id, e)
                if temp_spool.exists():
                    temp_spool.unlink()
                    self.spooled_bytes -= bytes_streamed
                self._warn("A referenced media asset could not be read from storage.", incomplete=True)
                self._record_unbundled(orig_url, "missing_blob", None, None)

    def _safe_extension(self, filename: str, mime_type: str | None) -> str:
        ext = Path(filename).suffix.lower()
        if ext and re.match(r"^\.[a-z0-9]{1,10}$", ext):
            return ext
        if mime_type:
            guessed = mimetypes.guess_extension(mime_type)
            if guessed:
                return guessed.lower()
        return ".bin"

    def _build_archive_zip(self, spool_path: Path, snapshot_meta: dict):
        """Construct final ZIP64 archive streaming metadata, markdown, verified assets, and checksums."""
        manifest_articles_jsonl = spool_path / "manifest_articles.jsonl"

        with zipfile.ZipFile(self.temp_zip_path, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            writer = BoundedZipStreamWriter(
                zf, self.temp_zip_path, self.max_bytes, self.max_duration, self.start_time
            )

            # 1. Creator avatar and banner assets (resolved from snapshot)
            creator_meta = snapshot_meta["creator"]
            avatar_asset_path = None
            if creator_meta.get("avatar_image_id"):
                avatar_asset_path = self.genericfile_to_asset.get(creator_meta["avatar_image_id"])
                if avatar_asset_path:
                    sha = Path(avatar_asset_path).stem
                    if sha in self.asset_registry:
                        self.asset_registry[sha]["references"].append({"role": "avatar", "article_free2zaddr": None, "language": None})

            banner_asset_path = None
            if creator_meta.get("banner_image_id"):
                banner_asset_path = self.genericfile_to_asset.get(creator_meta["banner_image_id"])
                if banner_asset_path:
                    sha = Path(banner_asset_path).stem
                    if sha in self.asset_registry:
                        self.asset_registry[sha]["references"].append({"role": "banner", "article_free2zaddr": None, "language": None})

            manifest_creator = {
                "username": creator_meta["username"],
                "full_name": creator_meta["full_name"],
                "description": creator_meta["description"],
                "p2paddr": creator_meta["p2paddr"],
                "canonical_url": creator_meta["canonical_url"],
                "avatar_asset": avatar_asset_path,
                "banner_asset": banner_asset_path,
                "created_at": creator_meta["created_at"],
            }

            # 2. Iterate articles from JSONL spool, write portable and raw files to ZIP
            articles_jsonl_path = Path(snapshot_meta["articles_jsonl_path"])
            with articles_jsonl_path.open("r", encoding="utf-8") as in_f, manifest_articles_jsonl.open("w", encoding="utf-8") as out_f:
                for line in in_f:
                    self._check_timeout()
                    art = json.loads(line)
                    addr = art["free2zaddr"]

                    featured_asset = self.genericfile_to_asset.get(art.get("featured_image_id"))
                    if featured_asset:
                        sha = Path(featured_asset).stem
                        if sha in self.asset_registry:
                            self.asset_registry[sha]["references"].append({"role": "featured_image", "article_free2zaddr": addr, "language": None})

                    enclosure_asset = self.genericfile_to_asset.get(art.get("enclosure_id"))
                    if enclosure_asset:
                        sha = Path(enclosure_asset).stem
                        if sha in self.asset_registry:
                            self.asset_registry[sha]["references"].append({"role": "enclosure", "article_free2zaddr": addr, "language": None})

                    manifest_variants = []
                    for var in art["variants"]:
                        self._check_timeout()
                        is_source = var["is_source"]
                        raw_spool_file = spool_path / var["raw_path"]

                        with raw_spool_file.open("r", encoding="utf-8") as rf:
                            raw_content = rf.read()

                        portable_body = self._rewrite_markdown_to_portable(
                            raw_content, addr, var["language"], is_source
                        )

                        # Build YAML Front Matter with published_at and publication_status
                        front_matter = {
                            "title": var["title"],
                            "description": var["description"],
                            "free2zaddr": addr,
                            "vanity": art["vanity"],
                            "language": var["language"],
                            "is_source": is_source,
                            "publication_status": art["publication_status"],
                            "is_published": var["is_published"],
                            "is_subscriber_only": art["is_subscriber_only"],
                            "category": art["category"],
                            "tags": art["tags"],
                            "created_at": var["created_at"],
                            "updated_at": var["updated_at"],
                            "published_at": art["published_at"],
                            "publish_at": art["publish_at"],
                            "canonical_url": art["canonical_url"],
                            "canonical_free2z_url": art["canonical_free2z_url"],
                            "featured_image": featured_asset,
                            "enclosure": enclosure_asset,
                            "origin": var["origin"],
                            "is_stale": var["is_stale"],
                        }
                        if art["goal"]:
                            front_matter["goal"] = art["goal"]
                        if art["poll"]:
                            front_matter["poll"] = art["poll"]

                        fm_yaml = yaml.safe_dump(
                            front_matter,
                            sort_keys=False,
                            allow_unicode=True,
                        )
                        full_portable = f"---\n{fm_yaml}---\n\n{portable_body}"

                        # Write portable file to ZIP
                        writer.writestr(var["path"], full_portable)

                        # Stream raw file from spool to ZIP
                        with raw_spool_file.open("rb") as rf_bin:
                            writer.write_stream(var["raw_path"], rf_bin)

                        manifest_variants.append(
                            {
                                "language": var["language"],
                                "is_source": is_source,
                                "title": var["title"],
                                "description": var["description"],
                                "is_published": var["is_published"],
                                "origin": var["origin"],
                                "is_stale": var["is_stale"],
                                "updated_at": var["updated_at"],
                                "created_at": var["created_at"],
                                "path": var["path"],
                                "raw_path": var["raw_path"],
                            }
                        )

                    article_manifest_record = {
                        "free2zaddr": addr,
                        "vanity": art["vanity"],
                        "canonical_free2z_url": art["canonical_free2z_url"],
                        "canonical_url": art["canonical_url"],
                        "category": art["category"],
                        "source_language": art["source_language"],
                        "source_title": art["source_title"],
                        "source_description": art["source_description"],
                        "p2paddr": art["p2paddr"],
                        "publication_status": art["publication_status"],
                        "is_published": art["is_published"],
                        "is_subscriber_only": art["is_subscriber_only"],
                        "created_at": art["created_at"],
                        "updated_at": art["updated_at"],
                        "published_at": art["published_at"],
                        "publish_at": art["publish_at"],
                        "goal": art["goal"],
                        "total": art["total"],
                        "tuzi_total": art["tuzi_total"],
                        "tags": art["tags"],
                        "series_memberships": art["series_memberships"],
                        "featured_image_asset": featured_asset,
                        "enclosure_asset": enclosure_asset,
                        "poll": art["poll"],
                        "variants": manifest_variants,
                    }
                    out_f.write(json.dumps(article_manifest_record, ensure_ascii=False) + "\n")

            # 3. Stream verified local spool files into ZIP
            manifest_assets = []
            for sha256, asset_info in sorted(self.asset_registry.items()):
                self._check_timeout()
                spool_file_path = Path(asset_info["spool_file"])
                with spool_file_path.open("rb") as f:
                    writer.write_stream(asset_info["path"], f)

                manifest_assets.append(
                    {
                        "sha256": sha256,
                        "path": asset_info["path"],
                        "byte_length": asset_info["byte_length"],
                        "mime_type": asset_info["mime_type"],
                        "uploads": asset_info["uploads"],
                        "references": asset_info["references"],
                    }
                )

            # 4. Stream manifest.json to spool file, then stream into ZIP
            now_str = _iso_utc(timezone.now())
            manifest_spool_path = spool_path / "manifest.json"
            with manifest_spool_path.open("w", encoding="utf-8") as mf:
                mf.write('{\n  "format": "free2z-publication-export",\n  "version": 1,\n')
                mf.write(f'  "exported_at": {json.dumps(now_str)},\n')
                mf.write(f'  "complete": {"true" if self.complete else "false"},\n')
                mf.write(f'  "warnings": {json.dumps(self.warnings, ensure_ascii=False)},\n')
                mf.write(f'  "creator": {json.dumps(manifest_creator, indent=2, ensure_ascii=False)},\n')
                mf.write(f'  "series": {json.dumps(snapshot_meta["series"], indent=2, ensure_ascii=False)},\n')
                mf.write('  "articles": [\n')

                first_art = True
                with manifest_articles_jsonl.open("r", encoding="utf-8") as in_mf:
                    for line in in_mf:
                        if not first_art:
                            mf.write(",\n")
                        art_obj = json.loads(line)
                        mf.write("    " + json.dumps(art_obj, indent=4, ensure_ascii=False).replace("\n", "\n    "))
                        first_art = False
                mf.write("\n  ],\n")
                mf.write(f'  "assets": {json.dumps(manifest_assets, indent=2, ensure_ascii=False)},\n')
                mf.write(f'  "unbundled_references": {json.dumps(self.unbundled_references, indent=2, ensure_ascii=False)}\n}}')

            with manifest_spool_path.open("rb") as mf_bin:
                writer.write_stream("manifest.json", mf_bin)

            # 5. Write creator.json and series.json
            writer.writestr("creator.json", json.dumps(manifest_creator, indent=2, ensure_ascii=False))
            writer.writestr("series.json", json.dumps(snapshot_meta["series"], indent=2, ensure_ascii=False))

            # 6. Write README.md
            readme_text = self._build_readme_text(now_str)
            writer.writestr("README.md", readme_text)

            # 7. Write checksums.sha256 from incrementally computed entry checksums (NO zf.read())
            self._write_checksums_sha256(writer)

        # Record metrics on job
        self.job.article_count = snapshot_meta["article_count"]
        self.job.asset_count = len(manifest_assets)

    def _write_checksums_sha256(self, writer: BoundedZipStreamWriter):
        """Write checksums.sha256 using incrementally recorded SHA-256 digests without re-reading archive."""
        sorted_names = sorted(writer.entry_checksums.keys())
        lines = [f"{writer.entry_checksums[name]}  {name}\n" for name in sorted_names]
        checksums_text = "".join(lines)
        writer.writestr("checksums.sha256", checksums_text)

    def _rewrite_markdown_to_portable(
        self, raw_content: str, free2zaddr: str, lang: str, is_source: bool
    ) -> str:
        """Rewrite raw Free2Z Markdown into portable standard Markdown/HTML with relative asset paths.

        - Explicit depth: source index.md is at articles/<addr>/ (../../), translations at articles/<addr>/translations/ (../../../)
        - Supported directives transformed into standard HTML/Markdown
        - Unsupported directives preserved verbatim + warning + complete=False
        - Complete unbundled references recorded for external URLs and unowned/missing uploads
        """
        if not raw_content:
            return ""

        rel_prefix = "../../" if is_source else "../../../"

        # 1. Transform directives only where the renderer recognizes block
        # directives. A global ``::word`` regex corrupts fenced examples and
        # mistakes ordinary C++ such as ``std::vector`` for an extension.
        def directive_replacer(match):
            name = match.group("name").lower()
            arg = match.group("arg").strip()
            full_match = match.group("directive")
            prefix = match.group("prefix")
            trailing = match.group("trailing")

            if name not in SUPPORTED_DIRECTIVES:
                self._warn(
                    f"Unsupported Free2Z directive '::{name}' was preserved as raw text in an article.",
                    incomplete=True,
                )
                return match.group(0)

            norm_key = normalize_upload_candidate(arg)
            target_path = f"{rel_prefix}{self.upload_to_asset[norm_key]}" if (norm_key and norm_key in self.upload_to_asset) else arg

            if norm_key and norm_key in self.upload_to_asset:
                sha = Path(self.upload_to_asset[norm_key]).stem
                if sha in self.asset_registry:
                    self.asset_registry[sha]["references"].append(
                        {"role": "inline_body", "article_free2zaddr": free2zaddr, "language": lang}
                    )
            elif norm_key:
                self._record_unbundled(arg, "unowned_or_missing", free2zaddr, lang)
            elif arg.startswith("http://") or arg.startswith("https://"):
                self._record_unbundled(arg, "external", free2zaddr, lang)

            if name == "embed":
                ext = Path(target_path).suffix.lower()
                if ext in {".mp4", ".webm", ".ogg", ".mov"}:
                    replacement = f'<video controls src="{target_path}"></video>'
                elif ext in {".mp3", ".wav", ".m4a", ".aac"}:
                    replacement = f'<audio controls src="{target_path}"></audio>'
                elif ext in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".heic"}:
                    replacement = f"![Embedded Media]({target_path})"
                elif "youtube.com" in target_path or "youtu.be" in target_path or "vimeo.com" in target_path:
                    replacement = f"[Embedded Video]({target_path})"
                else:
                    replacement = f"[Embedded Media]({target_path})"
            elif name == "iframe":
                replacement = f'<iframe src="{target_path}"></iframe>'
            elif name == "qrcode":
                replacement = f"**QR Code:** `{target_path}`"
            else:
                return full_match

            return f"{prefix}{replacement}{trailing}"

        rewritten_lines = []
        for original_line, scan_line in self._portable_rewrite_line_pairs(raw_content):
            if scan_line.strip() == "" and original_line != "":
                # Frontmatter and fenced code are displayed as metadata/code,
                # never as live links or directives. Preserve them byte-for-
                # byte within the normalized portable Markdown body.
                rewritten_lines.append(original_line)
                continue

            content = DIRECTIVE_RE.sub(directive_replacer, original_line)

            # 2. Transform Markdown links & images
            def link_replacer(match):
                label = match.group(1)
                raw_url = match.group(2).strip()

                norm_key = normalize_upload_candidate(raw_url)
                if norm_key and norm_key in self.upload_to_asset:
                    asset_rel = self.upload_to_asset[norm_key]
                    sha = Path(asset_rel).stem
                    if sha in self.asset_registry:
                        self.asset_registry[sha]["references"].append(
                            {"role": "inline_body", "article_free2zaddr": free2zaddr, "language": lang}
                        )
                    return f"{label}({rel_prefix}{asset_rel})"

                if raw_url.startswith("http://") or raw_url.startswith("https://"):
                    self._record_unbundled(raw_url, "external", free2zaddr, lang)
                elif norm_key:
                    self._record_unbundled(raw_url, "unowned_or_missing", free2zaddr, lang)

                return match.group(0)

            content = MD_LINK_RE.sub(link_replacer, content)

            # 3. Transform HTML src/href tags
            def html_attr_replacer(match):
                raw_attr = match.group(0)
                url = match.group(1).strip()
                norm_key = normalize_upload_candidate(url)
                if norm_key and norm_key in self.upload_to_asset:
                    asset_rel = self.upload_to_asset[norm_key]
                    sha = Path(asset_rel).stem
                    if sha in self.asset_registry:
                        self.asset_registry[sha]["references"].append(
                            {"role": "inline_body", "article_free2zaddr": free2zaddr, "language": lang}
                        )
                    return raw_attr.replace(url, f"{rel_prefix}{asset_rel}")

                if url.startswith("http://") or url.startswith("https://"):
                    self._record_unbundled(url, "external", free2zaddr, lang)
                elif norm_key:
                    self._record_unbundled(url, "unowned_or_missing", free2zaddr, lang)

                return raw_attr

            content = HTML_ATTR_RE.sub(html_attr_replacer, content)
            rewritten_lines.append(content)
        return "\n".join(rewritten_lines)

    @staticmethod
    def _portable_rewrite_line_pairs(content: str):
        """Pair source lines with a renderer-aligned scan mask.

        The shared media scanner already mirrors Marked's fenced-code rules.
        Blank the leading frontmatter without deleting its line positions, then
        reuse that scanner so portable rewrites never mutate syntax the reader
        displays as metadata or code.
        """
        normalized = (content or "").replace("\r\n", "\n").replace("\r", "\n")
        scan_text = normalized
        frontmatter = FRONTMATTER_RE.match(scan_text)
        if frontmatter:
            hidden = frontmatter.group(0)
            scan_text = "".join("\n" if char == "\n" else " " for char in hidden) + scan_text[frontmatter.end():]
        masked = _strip_fenced_blocks(scan_text)
        return zip(normalized.split("\n"), masked.split("\n"), strict=True)

    def _persist_archive_to_storage(self):
        """Stream completed temporary ZIP into private export storage and calculate final checksum."""
        storage = get_export_storage()
        file_size = self.temp_zip_path.stat().st_size
        if file_size > self.max_bytes:
            raise ExportSizeLimitExceeded("Final archive file exceeded size limit.")

        timestamp_str = timezone.now().strftime("%Y%m%dT%H%M%SZ")
        filename = self.job.file_name or f"free2z-{self.creator.username}-articles-{timestamp_str}.zip"
        storage_key = f"publications/{self.creator.id}/{self.job.id}/{filename}"

        h = hashlib.sha256()
        with self.temp_zip_path.open("rb") as f:
            while True:
                self._check_timeout()
                chunk = f.read(CHUNK_SIZE)
                if not chunk:
                    break
                h.update(chunk)

        # Persist the intended key before creating the private object. If the
        # process is killed after GCS commits the upload but before READY is
        # saved, the abandoned-job sweep now has a durable key to delete.
        # The job UUID makes this key unique for the normal first upload.
        self.job.file_path = storage_key
        self.job.file_name = filename
        self.job.file_size = file_size
        self.job.checksum_sha256 = h.hexdigest()
        self.job.save(
            update_fields=[
                "file_path",
                "file_name",
                "file_size",
                "checksum_sha256",
                "updated_at",
            ]
        )

        with self.temp_zip_path.open("rb") as f:
            actual_key = storage.save(storage_key, File(f))
        self._check_timeout()

        # FileSystemStorage and a retry after manual intervention may choose an
        # alternate available name. Record that returned key immediately; the
        # normal GCS first-write path returns storage_key unchanged.
        if actual_key != storage_key:
            self.job.file_path = actual_key
            self.job.save(update_fields=["file_path", "updated_at"])

    def _build_readme_text(self, exported_at: str) -> str:
        return f"""# Free2Z Publication Export Archive

**Format:** free2z-publication-export
**Version:** 1
**Exported At:** {exported_at}
**Creator:** {self.creator.username} ({self.creator.full_name or 'Free2Z Creator'})
**Profile:** https://free2z.cash/{self.creator.username}

---

## Overview

This archive contains a complete, self-contained, portable snapshot of your Free2Z publication.
It includes all published articles, drafts, scheduled posts, subscriber-only articles, multilingual translations, series orderings, polls, and creator-owned media assets.

## Archive Layout

```
.
├── manifest.json                  # Canonical publication metadata contract (v1)
├── README.md                      # Specification, schema documentation, and verification
├── creator.json                   # Creator profile metadata
├── series.json                    # Series and article collection orderings
├── checksums.sha256               # SHA-256 integrity verification table
├── articles/
│   └── <free2zaddr>/
│       ├── index.md               # Portable source Markdown with YAML front matter
│       ├── source.free2z.md       # Exact raw source Markdown
│       └── translations/
│           ├── <lang>.md          # Portable translated Markdown with YAML front matter
│           └── <lang>.free2z.md   # Exact raw translated Markdown
└── assets/
    └── <sha256>.<ext>             # Original media blobs deduplicated by SHA-256
```

## Markdown Transformations in Portable Files

- **Owned Media:** All links, images, and embedded media referring to creator-owned uploads are rewritten to portable relative paths (`../../assets/<sha256>.<ext>` or `../../../assets/<sha256>.<ext>`).
- **Directives:**
  - `::embed[<video>]` -> `<video controls src="..."></video>`
  - `::embed[<audio>]` -> `<audio controls src="..."></audio>`
  - `::embed[<image>]` -> `![Embedded Media](...)`
  - `::iframe[<url>]` -> `<iframe src="..."></iframe>`
  - `::qrcode[<data>]` -> `**QR Code:** `<data>``
- **Verbatim Raw Content:** The exact, unmodified Free2Z Markdown is preserved in `source.free2z.md` and `<lang>.free2z.md`.

## Integrity Verification

To verify that all files in this archive match their computed SHA-256 digests:

```bash
sha256sum -c checksums.sha256
```

## Importer Compatibility

- The `manifest.json` schema is versioned (version 1). Importers must safely ignore unknown future properties.
- Secrets, passwords, viewing keys, balances, voter identities, and third-party comments are strictly excluded.
"""


def process_export_job(job_id: str):
    """Entry point for procrastinate export background task.

    In production, the dedicated exports-worker runs exclusively on queue='exports'
    with concurrency=1 (k8s/free2z/worker), preventing concurrent worker thrashing
    and isolating archival generation from general background tasks.
    """
    try:
        job = PublicationExportJob.objects.get(id=job_id)
    except PublicationExportJob.DoesNotExist:
        logger.error("PublicationExportJob %s does not exist.", job_id)
        return

    if job.status != ExportStatus.QUEUED:
        logger.info("PublicationExportJob %s already in status %s, skipping.", job_id, job.status)
        return

    # Claim by compare-and-set. Procrastinate can redeliver after a lost worker
    # acknowledgement, and rolling Deployments can briefly have two replicas.
    # Accepting RUNNING above let both deliveries build/upload concurrently and
    # leak whichever private object lost the final row update.
    claimed_at = timezone.now()
    claimed = PublicationExportJob.objects.filter(
        id=job_id,
        status=ExportStatus.QUEUED,
    ).update(
        status=ExportStatus.RUNNING,
        started_at=claimed_at,
        updated_at=claimed_at,
    )
    if claimed != 1:
        logger.info("PublicationExportJob %s was claimed by another worker; skipping.", job_id)
        return
    job.refresh_from_db()

    exporter = PublicationExporter(job)
    exporter.export()


def cleanup_expired_jobs(limit: int = None) -> tuple:
    """Sweep and delete expired or abandoned export archives from storage.

    Sweeps, oldest first, at most ``limit`` rows in total:
    1. Abandoned QUEUED or RUNNING jobs updated > 2 hours ago
    2. READY jobs where expires_at <= now
    3. EXPIRED or FAILED jobs where file_path is still present

    Returns ``(cleaned, remaining)``.

    WHY THE CAP. Each of these loops does one REMOTE storage delete
    per row, sequentially, and none of them was bounded. This runs as the
    periodic ``exports.cleanup_expired_exports`` task on the catch-all
    ``default`` procrastinate queue, so a backlog of N archives is N
    sequential GCS round trips holding that lane -- behind which every
    other default / images / billing-fallback job waits. There is no wall
    clock to derive from a remote delete, which is exactly why the task is
    classified NEVER-reclaimable: an unbounded loop has no threshold. A row
    cap gives it one.

    WHY EACH SWEEP GETS A GUARANTEED SHARE, rather than three loops draining
    one pool in order (codex adversarial review). Sweep 3's rows are exactly
    the ones whose storage delete has already failed at least once, and a
    delete that fails because the object is unreachable keeps failing. With
    a single shared pool, `limit` undeletable strays consume the entire
    batch on every tick, forever -- and sweep 1 then never runs. Sweep 1 is
    the one that releases abandoned QUEUED/RUNNING rows, which occupy the
    GLOBAL ``EXPORT_MAX_ACTIVE_JOBS`` (4) admission slots: four stranded
    rows plus a stray backlog and *every user's* export request 503s
    indefinitely. Storage hygiene must never be able to block product
    recovery, so the sweeps run most-urgent-first and each is guaranteed
    ``limit // 3`` -- but only as much of that share as it could actually
    spend, so a sweep with nothing pending lends its whole share forward
    and the total still never exceeds ``limit``.

    ``remaining`` is recomputed from the same cutoffs AFTER the sweep, so it
    is the real backlog and not an estimate: a row whose delete failed has
    moved into sweep 3's population and is counted there, and a run that
    exhausted its budget reports everything it did not reach. The caller
    logs it, so "the sweep is not keeping up" is visible instead of being
    absorbed silently by a periodic task that always looks successful.
    """
    if limit is None:
        limit = getattr(settings, "EXPORT_CLEANUP_BATCH", 200)
    budget = max(1, int(limit))
    #Rows every LATER sweep is guaranteed, whatever an earlier one does.
    share = max(1, budget // 3)

    now = timezone.now()
    abandoned_cutoff = now - datetime.timedelta(hours=2)
    storage = get_export_storage()
    cleaned_count = 0

    # Callables, not querysets: each is evaluated once to take the batch and
    # once afterwards to count the backlog, and the second evaluation must
    # see the rows this run already transitioned.
    def expired_due():
        return PublicationExportJob.objects.filter(
            status=ExportStatus.READY,
            expires_at__lte=now,
        )

    def stray_files():
        return PublicationExportJob.objects.filter(
            status__in=[ExportStatus.EXPIRED, ExportStatus.FAILED]
        ).exclude(file_path="")

    def abandoned_jobs():
        return PublicationExportJob.objects.filter(
            status__in=[ExportStatus.QUEUED, ExportStatus.RUNNING],
            updated_at__lte=abandoned_cutoff,
        )

    # Counted once, up front, to size the reservations. Reserving a flat
    # `share` per later sweep would starve the earlier ones whenever the
    # later ones have nothing to do (and, at small limits, always): reserve
    # only what a later sweep could actually spend.
    pending_after = {
        'abandoned': [expired_due().count(), stray_files().count()],
        'expired': [stray_files().count()],
        'stray': [],
    }

    def _allowance(sweep):
        """What this sweep may spend, reserving what later sweeps can use.

        Never zero while budget remains. At ``limit`` values below 3 the
        reservation would otherwise consume the whole budget and the FIRST
        sweep -- abandoned-job recovery, the one holding the global
        admission slots -- would get nothing, on every tick, forever
        (``EXPORT_CLEANUP_BATCH=1`` is a permitted setting; codex round 2).
        A reservation is a promise to a later sweep, not a licence to
        starve an earlier one.
        """
        reserved = sum(min(share, count) for count in pending_after[sweep])
        return max(1 if budget > 0 else 0, budget - reserved)

    # 1. Abandoned running jobs (> 2 hours stale). FIRST: these hold the
    #    global EXPORT_MAX_ACTIVE_JOBS admission slots, so until they are
    #    released nobody can start an export at all.
    for job in abandoned_jobs().order_by("updated_at", "id")[:_allowance('abandoned')]:
        budget -= 1
        if job.file_path:
            try:
                if storage.exists(job.file_path):
                    storage.delete(job.file_path)
                job.file_path = ""
            except Exception as e:
                logger.error("Failed to delete abandoned export file %s: %s", job.file_path, e)
        job.status = ExportStatus.FAILED
        job.error_message = "Export job was abandoned or timed out."
        job.save(update_fields=["status", "error_message", "file_path", "updated_at"])
        cleaned_count += 1

    # 2. Ready jobs past expiry -- longest expired first, so the archives
    #    that have been costing storage the longest go first. This is the
    #    expiry contract itself: a downloadable archive that should no
    #    longer be downloadable.
    for job in expired_due().order_by("expires_at", "id")[:_allowance('expired')]:
        budget -= 1
        if job.file_path:
            try:
                if storage.exists(job.file_path):
                    storage.delete(job.file_path)
                job.file_path = ""
                job.status = ExportStatus.EXPIRED
                job.save(update_fields=["status", "file_path", "updated_at"])
                cleaned_count += 1
            except Exception as e:
                logger.error("Failed to delete expired export file %s: %s", job.file_path, e)
                job.status = ExportStatus.EXPIRED
                job.save(update_fields=["status", "updated_at"])
        else:
            job.status = ExportStatus.EXPIRED
            job.save(update_fields=["status", "updated_at"])

    # 3. Expired / Failed jobs that still have a file_path. LAST: every row
    #    here has already survived a failed delete, so it is both the least
    #    urgent work and the most likely to fail again -- the one sweep
    #    that must not be able to consume the whole batch.
    for job in stray_files().order_by("updated_at", "id")[:_allowance('stray')]:
        budget -= 1
        try:
            if storage.exists(job.file_path):
                storage.delete(job.file_path)
            job.file_path = ""
            job.save(update_fields=["file_path", "updated_at"])
            cleaned_count += 1
        except Exception as e:
            logger.error("Failed to delete stray export file %s: %s", job.file_path, e)
            # Touch updated_at so a permanently undeletable object goes to
            # the BACK of the ordering. This sweep is ordered oldest-first
            # and now capped, so without this a prefix of `limit` rows that
            # always fail is re-selected on every tick and no newer stray is
            # ever attempted -- the uncapped loop used to reach them (codex
            # round 2). auto_now makes the save itself the rotation; the
            # row stays in `remaining`, so the backlog is still reported.
            job.save(update_fields=["updated_at"])

    remaining = (
        expired_due().count()
        + stray_files().count()
        + abandoned_jobs().count()
    )
    return cleaned_count, remaining
