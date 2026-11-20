"""Copy owned storage objects into the account archive without fetching URLs."""
from django.db.models import Q
from dj.apps.uploads.models import GenericFile, ImageVariant, Webp
from dj.apps.kyc.models import UserProfile, W9, W8BEN, W8BENE
from dj.util.keyset import keyset_iterator
from .exporter import CHUNK_SIZE, ExportSizeLimitExceeded, ExportTimeoutExceeded, PublicationExporter


def _shared_with_other_owner(name, user_id):
    # Legacy shared paths can cross owner boundaries. A path is not authority.
    return (
        GenericFile.objects.filter(file=name).exclude(owner_id=user_id).exists()
        or ImageVariant.objects.filter(file=name).exclude(parent__owner_id=user_id).exists()
        or Webp.objects.filter(file=name).exclude(parent__owner_id=user_id).exists()
        or UserProfile.objects.filter(Q(id_front=name) | Q(id_back=name) | Q(additional_document=name) | Q(live_photo=name)).exclude(user_id=user_id).exists()
        or any(model.objects.filter(file=name).exclude(profile__user_id=user_id).exists() for model in (W9, W8BEN, W8BENE))
    )


def stage_media(owner, staging, bounds, stats):
    user_id = owner.pk
    media_dir = staging / "owned_media"
    media_dir.mkdir()
    reader = PublicationExporter(type("Job", (), {"creator_id": user_id})(), max_duration_seconds=bounds.remaining_seconds())
    for role in ("avatar", "banner"):
        file_id = getattr(owner, f"{role}_image_id")
        url = getattr(owner, f"{role}_url")
        owned = file_id and getattr(owner, f"{role}_image").owner_id == user_id
        if (file_id and not owned) or (not file_id and url):
            stats["missing_media"] += 1
            yield {"kind": role, "archive_path": None,
                   "warning": "Profile media is external or not owned and could not be included."}
    sources = (
        ("upload", GenericFile.objects.filter(owner_id=user_id)),
        ("variant", ImageVariant.objects.filter(parent__owner_id=user_id).select_related("parent")),
        ("thumbnail", Webp.objects.filter(parent__owner_id=user_id).select_related("parent")),
    )
    for kind, query in sources:
        for row in keyset_iterator(query, chunk_size=250):
            bounds.check()
            parent = row if kind == "upload" else row.parent
            record = {"kind": kind, "id": row.pk, "upload_id": parent.pk,
                      "title": parent.title, "description": parent.description,
                      "mime_type": parent.mime_type, "access": parent.access,
                      "created_at": parent.created_at, "archive_path": None}
            if kind == "variant":
                record.update({"width": row.width, "format": row.format})
            name = row.file.name if row.file else ""
            path = media_dir / f"{kind}-{row.pk}.bin"
            written = 0
            try:
                if not name or _shared_with_other_owner(name, user_id):
                    raise ValueError("missing or shared storage object")
                # Uses the publication export's bounded GCS stream and Django
                # storage only, never a user-supplied URL.
                with reader._open_asset_stream(row.file) as src, path.open("wb") as dest:
                    while chunk := src.read(CHUNK_SIZE):
                        bounds.check(len(chunk))
                        dest.write(chunk)
                        written += len(chunk)
                        bounds.staged_bytes += len(chunk)
                bounds.check()
                record["archive_path"] = f"owned_media/{path.name}"
                record["byte_length"] = written
            except (ExportSizeLimitExceeded, ExportTimeoutExceeded):
                raise
            except Exception:
                path.unlink(missing_ok=True)
                bounds.staged_bytes -= written
                stats["missing_media"] += 1
                record["warning"] = "File unavailable or ownership of its storage object could not be established."
            yield record

    kyc_sources = (
        ("identity", UserProfile.objects.filter(user_id=user_id), ("id_front", "id_back", "additional_document", "live_photo")),
        ("w9", W9.objects.filter(profile__user_id=user_id), ("file",)),
        ("w8ben", W8BEN.objects.filter(profile__user_id=user_id), ("file",)),
        ("w8bene", W8BENE.objects.filter(profile__user_id=user_id), ("file",)),
    )
    for kind, query, fields in kyc_sources:
        for row in keyset_iterator(query, chunk_size=250):
            for field in fields:
                blob = getattr(row, field)
                if not blob or not blob.name:
                    continue
                bounds.check()
                path = media_dir / f"{kind}-{row.pk}-{field}.bin"
                record = {"kind": kind, "field": field, "archive_path": None}
                written = 0
                try:
                    if _shared_with_other_owner(blob.name, user_id):
                        raise ValueError("shared storage object")
                    with reader._open_asset_stream(blob) as src, path.open("wb") as dest:
                        while chunk := src.read(CHUNK_SIZE):
                            bounds.check(len(chunk))
                            dest.write(chunk)
                            written += len(chunk)
                            bounds.staged_bytes += len(chunk)
                    bounds.check()
                    record["archive_path"] = f"owned_media/{path.name}"
                    record["byte_length"] = written
                except (ExportSizeLimitExceeded, ExportTimeoutExceeded):
                    raise
                except Exception:
                    path.unlink(missing_ok=True)
                    bounds.staged_bytes -= written
                    stats["missing_media"] += 1
                    record["warning"] = "File unavailable or ownership of its storage object could not be established."
                yield record
