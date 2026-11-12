"""Bounded, owner-scoped full account export archive generation."""
from __future__ import annotations

import datetime
import hashlib
import json
import logging
import tempfile
import time
import uuid
import zipfile
from pathlib import Path
from types import SimpleNamespace

from django.conf import settings
from django.core.files.base import File
from django.core.serializers.json import DjangoJSONEncoder
from django.db.models import Q
from django.utils import timezone

from dj.apps.comments.models import Comment
from dj.apps.emails.models import Email
from dj.apps.g12f.models import Creator, Transaction
from dj.apps.ledger.models import Account, Transfer
from dj.apps.oidc.models import AppAuthorization, F2ZApplication, MCPAccountGrant, MCPConnection
from dj.apps.ztripe.models import StripeTransaction, CheckoutIntent
from dj.apps.tuzis.models import ZecCreditReceipt, ZecPendingNotice
from dj.apps.purchases.models import PurchaseIntent, PurchaseReceipt
from dj.util.keyset import keyset_iterator

from .exporter import (
    BoundedZipStreamWriter,
    DEFAULT_MAX_ARCHIVE_BYTES,
    DEFAULT_MAX_DURATION_SECONDS,
    ExportSizeLimitExceeded,
    ExportTimeoutExceeded,
    PublicationExporter,
    _iso_utc,
)
from .account_owned import activity_rows, content_rows, finance_rows, identity_rows, relationship_rows
from .account_media import stage_media
from .models import ExportStatus, PublicationExportJob
from .storage import get_export_storage

logger = logging.getLogger(__name__)

# Coverage is deliberately partial pending a model-by-model inventory.
COVERAGE_WARNING = (
    "This archive is incomplete: some sensitive identity, shared and operational "
    "records are omitted or redacted. "
    "See the manifest for details."
)


class _ExportBounds:
    def __init__(self):
        self.started = time.monotonic()
        self.max_bytes = int(getattr(settings, "ACCOUNT_EXPORT_MAX_ARCHIVE_BYTES", DEFAULT_MAX_ARCHIVE_BYTES))
        self.max_duration = int(getattr(settings, "ACCOUNT_EXPORT_MAX_DURATION_SECONDS", DEFAULT_MAX_DURATION_SECONDS))
        self.staged_bytes = 0

    def check(self, extra_bytes: int = 0):
        if time.monotonic() - self.started > self.max_duration:
            raise ExportTimeoutExceeded("Account export generation exceeded its time limit.")
        if self.staged_bytes + extra_bytes > self.max_bytes:
            raise ExportSizeLimitExceeded("Account export exceeded its size limit.")

    def remaining_seconds(self) -> float:
        remaining = self.max_duration - (time.monotonic() - self.started)
        if remaining <= 0:
            raise ExportTimeoutExceeded("Account export generation exceeded its time limit.")
        return remaining

    def write_jsonl(self, path: Path, records):
        count = 0
        with path.open("w", encoding="utf-8") as stream:
            for record in records:
                self.check()
                line = json.dumps(record, ensure_ascii=False, cls=DjangoJSONEncoder) + "\n"
                encoded_size = len(line.encode("utf-8"))
                self.check(encoded_size)
                stream.write(line)
                self.staged_bytes += encoded_size
                count += 1
        return count


def _profile(user: Creator) -> dict:
    """Self-owned profile fields only; never serialize the auth model wholesale."""
    return {
        "public_id": str(user.public_id),
        "username": user.username,
        "email": user.email or None,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "full_name": user.full_name,
        "description": user.description,
        "p2paddr": user.p2paddr,
        "avatar_url": user.avatar_url,
        "banner_url": user.banner_url,
        "mention_notifications_enabled": user.mention_notifications_enabled,
        "date_joined": _iso_utc(user.date_joined),
        "public_profile_updated_at": _iso_utc(user.public_profile_updated_at),
        "is_verified": user.is_verified,
        "balance_2z": str(user.tuzis),
        "total_zec_equivalent": str(user.total),
        "member_price_2z": str(user.member_price),
    }



# Every concrete Creator field is intentionally classified. The test compares
# this map to Django's model fields so additions require an export decision.
PROFILE_FIELDS = {
    "public_id", "username", "email", "first_name", "last_name", "full_name",
    "description", "p2paddr", "avatar_url", "banner_url", "mention_notifications_enabled",
    "date_joined", "member_price", "public_profile_updated_at", "is_verified", "tuzis", "total",
}
PROFILE_RELATIONS = {"avatar_image", "banner_image"}
PROFILE_EXCLUSIONS = {
    "id": "Internal database key; public_id identifies this account.",
    "password": "Password hash is authentication material.",
    "password_set": "Authentication state, not portable profile content.",
    "last_login": "Security telemetry, not an account preference.",
    "is_superuser": "Staff authorization state.", "is_staff": "Staff authorization state.",
    "is_active": "Account security and deletion state.",
    "groups": "Staff authorization relationships.", "user_permissions": "Staff authorization relationships.",
    "updated_at": "Internal mutation timestamp also reflects security changes.",
    "strikes": "Moderation security state.", "kt_account_epoch": "Security protocol counter.",
    "deleted_at": "Deletion lifecycle state.", "deletion_requested_at": "Deletion lifecycle state.",
    "purge_after": "Deletion lifecycle state.", "deletion_cancelled_at": "Deletion lifecycle state.",
    "username_released_at": "Username reservation lifecycle state.",
    "username_ci_legacy": "Internal uniqueness migration marker.",
}


EMAIL_FIELDS = {"email", "is_public", "get_notifications", "confirmed_at", "created_at"}
EMAIL_EXCLUSIONS = {
    "id": "Internal database key.", "user": "Ownership relation is implicit in the archive.",
    "token": "Confirmation and unsubscribe credential.", "token_epoch": "Credential security counter.",
    "expires_at": "Confirmation credential expiry.", "updated_at": "Internal mutation timestamp.",
}

def _email_rows(user_id):
    for row in keyset_iterator(Email.objects.filter(user_id=user_id), chunk_size=500):
        yield {"email": row.email, "is_public": row.is_public,
               "get_notifications": row.get_notifications,
               "confirmed_at": _iso_utc(row.confirmed_at), "created_at": _iso_utc(row.created_at)}

def _comment_rows(user_id: int):
    # Bannable's default manager hides moderated rows. Both manager arms are
    # included because a full export belongs to the author, even if hidden.
    comments = (
        Comment.objects.filter(author_id=user_id)
        | Comment.banned_objects.filter(author_id=user_id)
    ).only("uuid", "headline", "content", "tuzis", "created_at", "updated_at")
    # keyset_iterator pages through ordinary queries; QuerySet.iterator() uses
    # server-side cursors, which this deployment disables under PgBouncer.
    for row in keyset_iterator(comments, chunk_size=500):
        yield {
            "id": str(row.uuid),
            "headline": row.headline,
            "content": row.content,
            "tuzis": row.tuzis,
            "created_at": _iso_utc(row.created_at),
            "updated_at": _iso_utc(row.updated_at),
        }


def _ledger_rows(user_id: int):
    # Transfer is the ledger's canonical, immutable read model. Restrict both
    # journal legs to the owner's user/debt accounts and deliberately omit
    # peer account ids, refs, and metadata (which can identify other people).
    owner_accounts = dict(
        Account.objects.filter(owner_id=user_id, kind__in=("user", "user_debt"))
        .values_list("id", "kind")
    )
    account_ids = list(owner_accounts)
    if not account_ids:
        return
    transfers = Transfer.objects.filter(
        Q(debit_account_id__in=account_ids) | Q(credit_account_id__in=account_ids)
    ).only("id", "created_at", "debit_account_id", "credit_account_id", "amount", "code")
    for row in keyset_iterator(transfers, chunk_size=1000):
        debit_kind = owner_accounts.get(row.debit_account_id)
        credit_kind = owner_accounts.get(row.credit_account_id)
        internal = debit_kind is not None and credit_kind is not None
        direction = "internal" if internal else "out" if debit_kind else "in"
        amount = int(row.amount)
        yield {
            "created_at": _iso_utc(row.created_at),
            "direction": direction,
            # External movement stays signed from the owner's perspective.
            # Internal user/debt transfers retain their gross amount and make
            # both owner-owned legs explicit; they are not an external outflow.
            "amount_milli_2z": -amount if direction == "out" else amount,
            "from_account_kind": debit_kind or "external",
            "to_account_kind": credit_kind or "external",
            "code": row.code,
        }


def _purchase_rows(user_id: int):
    rows = PurchaseIntent.objects.filter(creator_id=user_id).only(
        "id", "rail", "platform", "status", "quantity_2z", "price_minor", "currency",
        "created_at", "updated_at", "expires_at", "credited_at", "credited_milli_2z",
    )
    for row in keyset_iterator(rows, chunk_size=500, order_by=("created_at", "id")):
        yield {
            "id": str(row.id),
            "rail": row.rail,
            "platform": row.platform,
            "status": row.status,
            "quantity_2z": row.quantity_2z,
            "price_minor": row.price_minor,
            "currency": row.currency,
            "created_at": _iso_utc(row.created_at),
            "updated_at": _iso_utc(row.updated_at),
            "expires_at": _iso_utc(row.expires_at),
            "credited_at": _iso_utc(row.credited_at),
            "credited_milli_2z": row.credited_milli_2z,
        }


def _receipt_rows(user_id: int):
    rows = PurchaseReceipt.objects.filter(intent__creator_id=user_id).only(
        "id", "rail", "amount_minor", "currency", "credited_milli_2z", "created_at"
    )
    for row in keyset_iterator(rows, chunk_size=500, order_by=("created_at", "id")):
        yield {
            "rail": row.rail,
            "amount_minor": row.amount_minor,
            "currency": row.currency,
            "credited_milli_2z": row.credited_milli_2z,
            "created_at": _iso_utc(row.created_at),
        }


def _app_grant_rows(user_id: int):
    rows = AppAuthorization.objects.filter(user_id=user_id).select_related("application").only(
        "id", "application_id", "scope", "spend_cap_2z", "cap_period", "markup_bps", "consented_at",
        "revoked_at", "application__name", "application__client_id",
    )
    for grant in keyset_iterator(rows, chunk_size=500, order_by=("consented_at", "id")):
        application = grant.application
        yield {
            "application_name": application.name,
            "client_id": application.client_id,
            "scope": grant.scope_list,
            "spend_cap_2z": grant.spend_cap_2z,
            "cap_period": grant.cap_period,
            "markup_bps": grant.markup_bps,
            "consented_at": _iso_utc(grant.consented_at),
            "revoked_at": _iso_utc(grant.revoked_at),
        }



def _owned_app_rows(user_id):
    rows = F2ZApplication.objects.filter(user_id=user_id).order_by("id")
    for app in keyset_iterator(rows, chunk_size=500):
        yield {"id": str(app.pk), "name": app.name, "client_id": app.client_id,
               "client_type": app.client_type, "redirect_uris": app.redirect_uris,
               "allowed_scopes": app.allowed_scopes, "logo_url": app.logo_url,
               "privacy_url": app.privacy_url, "terms_url": app.terms_url,
               "markup_bps": app.markup_bps, "frozen": app.frozen}


def _mcp_grant_rows(user_id):
    rows = MCPAccountGrant.objects.filter(user_id=user_id).select_related("connection__application")
    for grant in keyset_iterator(rows, chunk_size=500):
        yield {"id": str(grant.pk), "application_name": grant.connection.application.name,
               "client_id": grant.connection.application.client_id, "scope": grant.scope,
               "consented_at": _iso_utc(grant.consented_at), "revoked_at": _iso_utc(grant.revoked_at)}


def _mcp_connection_rows(user_id):
    rows = MCPConnection.objects.filter(primary_user_id=user_id).select_related("application")
    for connection in keyset_iterator(rows, chunk_size=500):
        yield {"id": str(connection.pk), "application_name": connection.application.name,
               "client_id": connection.application.client_id, "scope": connection.scope,
               "created_at": _iso_utc(connection.created_at), "revoked_at": _iso_utc(connection.revoked_at)}


def _legacy_purchase_rows(user_id):
    for row in keyset_iterator(Transaction.objects.filter(creator_id=user_id), chunk_size=500):
        yield {"kind": "legacy_zcash_transaction", "action": row.action,
               "amount_zec": str(row.amount), "created_at": _iso_utc(row.created_at)}
    for row in keyset_iterator(StripeTransaction.objects.filter(user_id=user_id), chunk_size=500):
        yield {"kind": "stripe_transaction", "amount_cents": row.amount,
               "tuzis_credited": row.tuzis_credited, "timestamp": _iso_utc(row.timestamp)}
    for row in keyset_iterator(ZecCreditReceipt.objects.filter(creator_id=user_id), chunk_size=500):
        yield {"kind": "zec_credit_receipt", "amount_zec": str(row.amount_zec),
               "tuzis_credited": str(row.tuzis_credited) if row.tuzis_credited is not None else None,
               "tuzis_per_zec": str(row.tuzis_per_zec) if row.tuzis_per_zec is not None else None,
               "backfilled": row.backfilled,
               "created_at": _iso_utc(row.created_at), "settled_at": _iso_utc(row.settled_at),
               "vanished_at": _iso_utc(row.vanished_at)}
    for row in keyset_iterator(ZecPendingNotice.objects.filter(creator_id=user_id), chunk_size=500):
        yield {"kind": "zec_pending_notice", "amount_zec": str(row.amount_zec),
               "confirmations": row.confirmations, "created_at": _iso_utc(row.created_at)}
    for row in keyset_iterator(CheckoutIntent.objects.filter(user_id=user_id), chunk_size=500):
        yield {"kind": "checkout_intent", "id": str(row.public_id), "amount_cents": row.amount_cents,
               "currency": row.currency, "tuzis": row.tuzis, "state": row.state,
               "created_at": _iso_utc(row.created_at), "fulfilled_at": _iso_utc(row.fulfilled_at)}

def _publication_job(user_id: int) -> SimpleNamespace:
    return SimpleNamespace(creator_id=user_id, id=uuid.uuid4())


def build_account_archive(user_id: int, archive_path: Path) -> dict:
    """Write one bounded ZIP archive, composing the existing publication ZIP."""
    bounds = _ExportBounds()
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="account_export_") as temp_name:
        staging = Path(temp_name)
        publications_path = staging / "publications.zip"
        publication_exporter = PublicationExporter(
            _publication_job(user_id),
            max_duration_seconds=bounds.remaining_seconds(),
            reject_shared_media=True,
        )
        publication_meta = publication_exporter.build_archive_file(publications_path)
        publication_size = publications_path.stat().st_size
        bounds.check(publication_size)
        bounds.staged_bytes += publication_size
        owner = Creator.objects.get(pk=user_id)
        profile = _profile(owner)
        # IDs are exported only when the referenced file is actually owned.
        for role in ("avatar", "banner"):
            file_id = getattr(owner, f"{role}_image_id")
            profile[f"{role}_upload_id"] = file_id if file_id and getattr(owner, f"{role}_image").owner_id == user_id else None
        (staging / "profile.json").write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        counts = {"comments": bounds.write_jsonl(staging / "comments.jsonl", _comment_rows(user_id))}
        counts["ledger_entries"] = bounds.write_jsonl(staging / "ledger.jsonl", _ledger_rows(user_id))
        counts["purchases"] = bounds.write_jsonl(staging / "purchases.jsonl", _purchase_rows(user_id))
        counts["purchase_receipts"] = bounds.write_jsonl(staging / "purchase_receipts.jsonl", _receipt_rows(user_id))
        counts["connected_apps_and_grants"] = bounds.write_jsonl(staging / "connected_apps.jsonl", _app_grant_rows(user_id))
        media_stats = {"missing_media": 0}
        additional = {
            "uploads": stage_media(owner, staging, bounds, media_stats),
            "content": content_rows(user_id),
            "relationships": relationship_rows(user_id),
            "activity": activity_rows(user_id),
            "identities": identity_rows(user_id),
            "earnings": finance_rows(user_id),
            "email_preferences": _email_rows(user_id),
            "owned_apps": _owned_app_rows(user_id),
            "mcp_grants": _mcp_grant_rows(user_id),
            "mcp_connections": _mcp_connection_rows(user_id),
            "legacy_purchases": _legacy_purchase_rows(user_id),
        }
        for name, rows in additional.items():
            counts[name] = bounds.write_jsonl(staging / f"{name}.jsonl", rows)
        media_warnings = ([f"{media_stats['missing_media']} owned media files could not be included; see uploads.jsonl for each item."] if media_stats["missing_media"] else [])
        manifest = {
            "format": "free2z-account-data-export",
            "version": 1,
            "exported_at": _iso_utc(timezone.now()),
            "profile": "profile.json",
            "publications": "publications.zip (the standard free2z-publication-export archive)",
            "records": {
                "comments": "comments.jsonl",
                "ledger": "ledger.jsonl",
                "purchases": "purchases.jsonl",
                "purchase_receipts": "purchase_receipts.jsonl",
                "connected_apps_and_grants": "connected_apps.jsonl",
                **{name: f"{name}.jsonl" for name in additional},
            },
            "counts": {**counts, "publication_articles": publication_meta["article_count"]},
            "omissions": {
                "media": "Owned storage files and derivatives are included where readable and uniquely attributable; uploads.jsonl records each missing or shared object. External URLs are never fetched.",
                "relationships_and_activity": "Only the caller's actions and received notification state are included; other users' submissions and private targets are omitted. PromptResponse rows with no owner or owned by another account are excluded even when linked to the caller's conversation.",
                "messages": "Chat request role, charge and time are included; other participants and delivery internals are excluded. This service does not store encrypted chat content in ChatRequest.",
                "sensitive_records": "Owner KYC metadata, form fields and readable identity/tax files are included; files with keys shared across owners are individually omitted with warnings. tax.CostBasis and TaxEvent have no Creator ownership relation.",
                "financial_and_operational_records": "Own payable, journal, payout, agreement and claim summaries are included. Provider credentials, payout addresses, raw evidence, ledger hold internals and other-party metadata are omitted.",
                "activity_and_moderation": "Received notification state is included without private targets; moderation notes, meeting credentials and provider delivery internals are excluded.",
                "credentials": "Passwords, secrets, tokens, sessions and security material are excluded.",
                "provider_identifiers": "Payment provider identifiers and raw receipts are redacted.",
            },
            "complete": False,
            "warnings": [COVERAGE_WARNING, *media_warnings, *publication_meta["warnings"]],
            "publication_export_complete": publication_meta["complete"],
            "publication_export_warnings": publication_meta["warnings"],
            "limits": {
                "max_archive_bytes": bounds.max_bytes,
                "max_duration_seconds": bounds.max_duration,
            },
            "snapshot": "Publication data uses the publication export's repeatable-read snapshot; other account records are read during this job. The publication ZIP is embedded unchanged to avoid decompressing and rebuilding its assets.",
        }
        (staging / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            writer = BoundedZipStreamWriter(archive, archive_path, bounds.max_bytes, bounds.max_duration, bounds.started)
            for name in ("manifest.json", "profile.json", "comments.jsonl", "ledger.jsonl", "purchases.jsonl", "purchase_receipts.jsonl", "connected_apps.jsonl", *(f"{name}.jsonl" for name in additional)):
                path = staging / name
                with path.open("rb") as stream:
                    writer.write_stream(name, stream)
            with publications_path.open("rb") as stream:
                writer.write_stream("publications.zip", stream)
            for media_path in (staging / "owned_media").iterdir():
                bounds.check()
                with media_path.open("rb") as stream:
                    writer.write_stream(f"owned_media/{media_path.name}", stream)
            checksums = "".join(f"{digest}  {name}\n" for name, digest in sorted(writer.entry_checksums.items()))
            writer.writestr("checksums.sha256", checksums)
    return {"counts": counts, "publication": publication_meta, "media_warnings": media_warnings}


def process_account_export_job(job: PublicationExportJob) -> None:
    """Generate and persist a full account archive using private export storage."""
    temp_dir = tempfile.TemporaryDirectory(prefix="account_export_archive_")
    path = Path(temp_dir.name) / "account-data-export.zip"
    try:
        if not Creator.objects.filter(
            pk=job.creator_id,
            is_active=True,
            deleted_at__isnull=True,
            deletion_requested_at__isnull=True,
        ).exists():
            raise RuntimeError("Account is no longer active.")
        archive_meta = build_account_archive(job.creator_id, path)
        storage = get_export_storage()
        size = path.stat().st_size
        max_bytes = int(getattr(settings, "ACCOUNT_EXPORT_MAX_ARCHIVE_BYTES", DEFAULT_MAX_ARCHIVE_BYTES))
        if size > max_bytes:
            raise ExportSizeLimitExceeded("Account export exceeded its size limit.")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(64 * 1024), b""):
                digest.update(chunk)
        filename = job.file_name or "free2z-account-data-export.zip"
        storage_key = f"accounts/{job.creator_id}/{job.id}/{filename}"
        job.file_path = storage_key
        job.file_size = size
        job.checksum_sha256 = digest.hexdigest()
        if not PublicationExportJob.objects.filter(pk=job.pk, status=ExportStatus.RUNNING).update(
            file_path=job.file_path, file_size=size, checksum_sha256=job.checksum_sha256,
            updated_at=timezone.now(),
        ):
            raise RuntimeError("Account export job is no longer active.")
        with path.open("rb") as stream:
            actual_key = storage.save(storage_key, File(stream))
        if actual_key != storage_key:
            job.file_path = actual_key
            if not PublicationExportJob.objects.filter(pk=job.pk, status=ExportStatus.RUNNING).update(
                file_path=actual_key, updated_at=timezone.now(),
            ):
                raise RuntimeError("Account export job is no longer active.")
        completed_at = timezone.now()
        updated = PublicationExportJob.objects.filter(
            pk=job.pk,
            status=ExportStatus.RUNNING,
            creator__is_active=True,
            creator__deleted_at__isnull=True,
            creator__deletion_requested_at__isnull=True,
        ).update(
            status=ExportStatus.READY,
            complete=False,
            warnings=[COVERAGE_WARNING, *archive_meta.get("media_warnings", []), *archive_meta["publication"]["warnings"]],
            completed_at=completed_at,
            expires_at=completed_at + datetime.timedelta(hours=24),
            file_path=job.file_path,
            file_size=size,
            checksum_sha256=digest.hexdigest(),
            updated_at=completed_at,
        )
        if updated != 1:
            raise RuntimeError("Account export job is no longer active.")
    except Exception as exc:
        logger.exception("Account data export failed for job %s", job.id)
        error_message = str(exc) if isinstance(exc, (ExportSizeLimitExceeded, ExportTimeoutExceeded)) else "Failed to generate account data export."
        PublicationExportJob.objects.filter(pk=job.pk, status=ExportStatus.RUNNING).update(
            status=ExportStatus.FAILED, error_message=error_message, updated_at=timezone.now(),
        )
        if job.file_path:
            try:
                storage = get_export_storage()
                if storage.exists(job.file_path):
                    storage.delete(job.file_path)
                PublicationExportJob.objects.filter(pk=job.pk, file_path=job.file_path).update(file_path="", updated_at=timezone.now())
            except Exception:
                logger.exception("Could not remove partial account export %s", job.id)
    finally:
        temp_dir.cleanup()
