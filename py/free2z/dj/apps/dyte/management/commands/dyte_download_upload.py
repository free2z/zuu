"""
Listens to the settings.PUBSUB["DYTE_VIDEO_READY"] topic
and downloads the file from dyte, sets the permission to the creator
and uploads to our GCS.
"""

import mimetypes
import hashlib
import os
import json
import re
import tempfile
import logging
import time
import traceback
import uuid
from datetime import datetime, timedelta
from urllib.parse import unquote, urlparse, urlsplit

import requests
from google.cloud.pubsub_v1.types import FlowControl
from django.core.files import File
from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import (
    DatabaseError, close_old_connections, connection, transaction,
)
from django.db.models import Q
from django.utils import timezone

from utils.filename import limit_filename_length
from gcp.pubsub.client import PubSubClient
from dj.apps.uploads.models import GenericFile
from dj.apps.g12f.models.creator import Creator
from dj.apps.dyte.recording import (
    is_allowed_recording_url,
    redact_recording_url,
)
from dj.apps.dyte.models import (
    BROADCAST,
    CreatorMeeting,
    MEETING_TYPES,
    PAY_PER_VIEW,
    PRIVATE,
    RecordingDelivery,
    SUBSCRIBERS_ONLY,
)


# TODO: real logging for k8s tho. Hrm.
logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s - %(levelname)s - %(message)s')


# Requests/urllib3 may copy a provider's presigned URL into an exception. Keep
# every log and durable diagnostic credential-free, including relative request
# targets that omit the scheme and host.
_CREDENTIAL_PARAM_RE = re.compile(
    r'(?i)\b(x-amz-[a-z-]+|signature|sig|token|credential|key|secret)'
    r'=[^&\s\'\"]+'
)
_ABSOLUTE_URL_RE = re.compile(r'(?i)(?:https?:)?//[^\s<>\'\"]+')
_URL_USERINFO_RE = re.compile(
    r'(?i)(?P<prefix>\bhttps?://|//)[^/@\s]+@'
)
_SAFE_LOG_IDENTIFIER_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$')

RECORDING_SPOOL_WRITE_FAILED_SIGNAL = 'RECORDING SPOOL WRITE FAILED'
RECORDING_SPOOL_FLUSH_FAILED_SIGNAL = 'RECORDING SPOOL FLUSH FAILED'
RECORDING_DOWNLOAD_RETRY_EXHAUSTED_SIGNAL = 'RECORDING DOWNLOAD RETRY EXHAUSTED'
RECORDING_INGESTION_STUCK_SIGNAL = 'RECORDING INGESTION STUCK'

# A presigned URL can briefly be unavailable while the provider finishes
# copying the recording. Keep retries local to one callback so a transient 403
# or 404 cannot be lost when the provider does not publish the callback again.
# The fixed cap and exponential delay bound how long the subscriber occupies
# its only flow-control slot.
RECORDING_DOWNLOAD_RETRY_STATUS_CODES = frozenset({403, 404})
RECORDING_DOWNLOAD_MAX_ATTEMPTS = 3
RECORDING_DOWNLOAD_RETRY_BACKOFF_SECONDS = 1.0
RECORDING_DOWNLOAD_RETRY_MAX_BACKOFF_SECONDS = 4.0
RECORDING_RECOVERY_RETRY_BACKOFF_SECONDS = 60.0
RECORDING_RECOVERY_RETRY_MAX_BACKOFF_SECONDS = 15 * 60.0


def _safe_recording_url(url):
    return redact_recording_url(
        url, settings.DYTE_RECORDING_ALLOWED_HOSTS)


def _safe_log_identifier(value):
    """Keep ACK/drop logs useful without serializing untrusted payloads."""
    if value is None:
        return '<missing>'
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, str):
        if not value:
            return '<empty>'
        try:
            return str(uuid.UUID(value))
        except (AttributeError, TypeError, ValueError):
            if _SAFE_LOG_IDENTIFIER_RE.fullmatch(value):
                return value
            fingerprint = hashlib.sha256(
                value.encode('utf-8', 'replace')).hexdigest()[:12]
            return f'<invalid-string:{fingerprint}>'
    return f'<invalid-{type(value).__name__}>'


def _message_payload(message):
    """Decode the queue payload for diagnostics only; never raise."""
    try:
        raw_data = getattr(message, 'data', b'')
        if isinstance(raw_data, bytes):
            raw_data = raw_data.decode('utf-8')
        if not isinstance(raw_data, str):
            return None
        payload = json.loads(raw_data)
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError):
        return None
    return payload if isinstance(payload, dict) else None


def _message_recording_url(message):
    """Read only the URL field needed to scrub a callback traceback."""
    payload = _message_payload(message)
    if payload is not None and isinstance(payload.get('url'), str):
        return payload['url']
    return ''


def _message_recording_identity(message):
    """Name the recording a failing callback is looping on.

    A traceback says where we broke; it does not say *which* recording is
    wedging the subscriber's single flow-control slot. With max_messages=1 an
    unhandled failure NACK-loops on one message forever, so the identifier is
    the difference between "restart the pod" and "this one recording is
    poison". Every field is passed through `_safe_log_identifier`, so an
    untrusted payload cannot inject log content.
    """
    payload = _message_payload(message)
    if payload is None:
        return 'recording=<unparseable payload>'
    parts = []
    for label, field in (
        ('recording', 'recording_idempotency_key'),
        ('provider_event', 'provider_event_id'),
        ('creator', 'username'),
    ):
        if field in payload:
            parts.append(f'{label}={_safe_log_identifier(payload[field])}')
    return ' '.join(parts) if parts else 'recording=<no identifiers in payload>'


def scrub_recording_diagnostic(text, url=''):
    """Remove presigned URL credentials from provider-controlled text.

    Exception messages can contain either the complete URL or only urllib3's
    raw path/query. Remove both forms, plus host labels that may themselves be
    bearer capabilities, before the value reaches logs or a database field.
    """
    scrubbed = str(text or '').replace('\r', ' ').replace('\n', ' ')
    raw_url = str(url or '')
    parsed_urls = []
    if raw_url:
        scrubbed = scrubbed.replace(raw_url, _safe_recording_url(raw_url))
        try:
            parsed_urls.append(urlsplit(raw_url))
        except Exception:
            pass

    for parsed in parsed_urls:
        path = parsed.path or ''
        if path and path != '/':
            targets = [path]
            if parsed.query:
                targets.append(f'{path}?{parsed.query}')
            if parsed.fragment:
                targets.append(f'{targets[-1]}#{parsed.fragment}')
            for target in sorted(targets, key=len, reverse=True):
                scrubbed = scrubbed.replace(target, '<redacted recording path>')
                scrubbed = scrubbed.replace(
                    unquote(target), '<redacted recording path>')

        safe_origin = _safe_recording_url(raw_url)
        safe_hostname = None
        if safe_origin.startswith('https://'):
            safe_hostname = urlsplit(safe_origin).hostname
        replacement = safe_hostname or '<redacted recording host>'
        known_hostnames = {parsed.hostname} if parsed.hostname else set()
        if parsed.hostname:
            try:
                known_hostnames.add(
                    parsed.hostname.encode('idna').decode('ascii'))
            except UnicodeError:
                pass
        for hostname in sorted(known_hostnames, key=len, reverse=True):
            scrubbed = re.sub(
                re.escape(hostname), lambda _match: replacement, scrubbed,
                flags=re.IGNORECASE,
            )

    scrubbed = _ABSOLUTE_URL_RE.sub(
        lambda match: _safe_recording_url(match.group(0)), scrubbed)
    scrubbed = _URL_USERINFO_RE.sub(r'\g<prefix><redacted>@', scrubbed)
    scrubbed = _CREDENTIAL_PARAM_RE.sub(r'\1=<redacted>', scrubbed)
    if len(scrubbed) <= 1000:
        return scrubbed
    # Keep both the first failing frame and the exception message at the end.
    return f'{scrubbed[:600]} ... <truncated> ... {scrubbed[-350:]}'


def catch_errors(callback):
    def wrapper(message):
        try:
            close_old_connections()
            callback(message)
        except DatabaseError:
            diagnostic = scrub_recording_diagnostic(
                traceback.format_exc(), _message_recording_url(message))
            logging.error(
                "Recording callback database failure [%s]: %s; nacking",
                _message_recording_identity(message),
                diagnostic,
            )
            # Database-backed lease/receipt failures are transient. ACK would
            # make the already-claimed webhook recording disappear forever.
            message.nack()
        except Exception:
            diagnostic = scrub_recording_diagnostic(
                traceback.format_exc(), _message_recording_url(message))
            logging.error(
                "Recording callback failure [%s]: %s; nacking",
                _message_recording_identity(message),
                diagnostic,
            )
            # Unhandled failures are potentially transient (S3/GCS/network).
            # Nack so Pub/Sub retries; permanent invalid-input cases are
            # explicitly acknowledged inside the callback before reaching here.
            message.nack()
    return wrapper


def recording_source_url_key(username, url):
    """Fingerprint the credential-free source shared by rollout payloads."""
    parsed = urlparse(url)
    material = (
        f'{str(username).casefold()}\x1f{parsed.scheme.lower()}://'
        f'{parsed.netloc.lower()}{parsed.path}'
    )
    return hashlib.sha256(material.encode()).hexdigest()


# Recordings from restricted meetings (subscribers-only, PPV, private) must
# never leak as public GenericFiles. The subscriber falls back to the most
# restrictive tier (`private`) for anything it cannot positively identify as
# public: the envelope carries no per-item PPV entitlement, so a mistaken
# `members`/`public` for a restricted meeting is a hard-leak, while a mistaken
# `private` for a public meeting is only an access-siloed replay. See issue
#.
DEFAULT_RECORDING_ACCESS = 'private'
_MAX_POSTGRES_BIGINT = 2 ** 63 - 1

# The first of these `BROADCAST`/`SUBSCRIBERS_ONLY`/`PAY_PER_VIEW`/`PRIVATE`
# whose value is present (and valid) in the payload wins. Only broadcast maps
# to public; subscribers-only maps to members; everything else is private.
_GENERIC_FILE_ACCESS_BY_MEETING_TYPE = {
    BROADCAST: 'public',
    SUBSCRIBERS_ONLY: 'members',
    PAY_PER_VIEW: 'private',
    PRIVATE: 'private',
}


def recording_access_for_meeting_type(meeting_type):
    """Map a validated meeting type to a GenericFile.access value (fail-closed)."""
    return _GENERIC_FILE_ACCESS_BY_MEETING_TYPE.get(meeting_type, DEFAULT_RECORDING_ACCESS)


def _validated_meeting_pk(value):
    """Return a database-safe CreatorMeeting pk, or None for poison input.

    ``persist_recording_context`` runs before the download and writes this
    value to a PositiveBigIntegerField. Keep malformed Pub/Sub integers out of
    that write so they are safely ACKed as restricted recordings rather than
    becoming a permanent NACK loop on the recordings subscriber.
    """
    if (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 1 <= value <= _MAX_POSTGRES_BIGINT
    ):
        return value
    return None


def resolve_recording_access(data, creator, *, delivery=None):
    """Resolve the GenericFile access tier for a recording payload.

    Reads ``meeting_pk`` (the stable DB primary key of the creator's
    ``CreatorMeeting``) out of the queue payload and looks the meeting's
    ``meeting_type`` up in the database, filtered by the resolved
    ``creator`` and ``is_public=True`` so a ``username``/``meeting_pk``
    mismatch — or a non-public (private) variant of even a broadcast meeting
    type — fails closed to ``private``: the subscriber cannot be tricked by a
    payload that omits the meeting, that names a meeting owned by a different
    creator, or that rides a private row's ``meeting_type`` into storing a
    restricted recording as public.

    The read is a ``select_for_update`` row lock: this runs inside the
    callback's ``transaction.atomic()`` save boundary, so a concurrent
    ``meeting_type`` downgrade by the creator waits for this transaction
    instead of committing between this SELECT and ``gfile.save()`` and
    leaving a stale public recording behind ( adversarial review).

    When a callback supplies its durable ``delivery``, clear the saved
    ``meeting_pk`` if the identifier cannot be resolved to the creator's
    current public room. The delivery is a recovery input, not an audit trail;
    retaining a deleted or otherwise unresolvable identifier would make its
    durable context claim an attribution that the completed recording does
    not have.
    """
    meeting_pk = _validated_meeting_pk(
        data.get('meeting_pk') if isinstance(data, dict) else None)
    if meeting_pk is None:
        if delivery is not None and delivery.meeting_pk is not None:
            delivery.meeting_pk = None
            delivery.save(update_fields=['meeting_pk'])
        return DEFAULT_RECORDING_ACCESS
    meeting = (
        CreatorMeeting.objects.select_for_update().filter(
            pk=meeting_pk, creator=creator, is_public=True,
        ).values('meeting_type').first()
    )
    if meeting is None:
        if delivery is not None and delivery.meeting_pk is not None:
            delivery.meeting_pk = None
            delivery.save(update_fields=['meeting_pk'])
        return DEFAULT_RECORDING_ACCESS
    meeting_type = meeting['meeting_type']
    if meeting_type not in MEETING_TYPES:
        return DEFAULT_RECORDING_ACCESS
    return recording_access_for_meeting_type(meeting_type)


def lock_source_alias(source_url_key):
    """Serialize the short legacy/current alias decision on PostgreSQL."""
    if not source_url_key:
        return
    lock_id = int.from_bytes(
        bytes.fromhex(source_url_key)[:8], byteorder='big', signed=True)
    with connection.cursor() as cursor:
        cursor.execute('SELECT pg_advisory_xact_lock(%s)', [lock_id])


def claim_recording(
    recording_key, *, source_url_key='', legacy_fallback=False,
):
    """Acquire a short DB-backed processing lease without holding a DB lock."""
    if recording_key is None:
        return 'claimed', None

    now = timezone.now()
    lease_token = uuid.uuid4()
    lease_expires_at = now + timedelta(
        seconds=settings.DYTE_RECORDING_LEASE_SECONDS)
    with transaction.atomic():
        lock_source_alias(source_url_key)
        delivery = RecordingDelivery.objects.select_for_update().filter(
            idempotency_key=recording_key).first()
        if delivery is None and source_url_key:
            # Bridge only opposite generations. Two current provider recording
            # UUIDs are allowed to share an object path; conflating those would
            # silently lose a real recording. A legacy URL-derived receipt and
            # a current UUID receipt, however, may represent the same queued
            # recording during this one rollout.
            aliases = RecordingDelivery.objects.select_for_update().filter(
                source_url_key=source_url_key,
                legacy_fallback=not legacy_fallback,
                processed_at__gte=(
                    now - timedelta(
                        seconds=settings.DYTE_RECORDING_TRANSITION_ALIAS_SECONDS
                    )
                ),
            )
            if aliases.filter(completed_at__isnull=False).exists():
                return 'completed', None
            active_alias = aliases.filter(
                completed_at__isnull=True,
                lease_expires_at__gt=now,
            ).exists()
            if active_alias:
                return 'busy', None
            aliases.filter(completed_at__isnull=True).delete()
        if delivery is None:
            delivery, created = RecordingDelivery.objects.get_or_create(
                idempotency_key=recording_key,
                defaults={
                    'source_url_key': source_url_key,
                    'legacy_fallback': legacy_fallback,
                    'lease_token': lease_token,
                    'lease_expires_at': lease_expires_at,
                },
            )
            if created:
                return 'claimed', lease_token
        if delivery.completed_at is not None:
            return 'completed', None
        if (
            delivery.lease_expires_at is not None
            and delivery.lease_expires_at > now
        ):
            return 'busy', None
        delivery.lease_token = lease_token
        delivery.lease_expires_at = lease_expires_at
        delivery.source_url_key = source_url_key
        delivery.legacy_fallback = legacy_fallback
        delivery.save(update_fields=[
            'source_url_key', 'legacy_fallback', 'lease_token',
            'lease_expires_at',
        ])
    return 'claimed', lease_token


def release_recording_claim(recording_key, lease_token):
    """Make an incomplete claim immediately available after a transient error."""
    if recording_key is not None and lease_token is not None:
        RecordingDelivery.objects.filter(
            idempotency_key=recording_key,
            completed_at__isnull=True,
            lease_token=lease_token,
        ).update(lease_expires_at=timezone.now())


def persist_recording_context(
    recording_key, lease_token, creator, data, download_url,
):
    """Save the recovery inputs while the callback still owns the lease.

    The URL is provider-controlled and credential-bearing, so it is never
    exposed in admin or logs. It is retained only until the recording is
    completed or the bounded recovery window expires. A callback with a
    genuinely refreshed URL starts a new retry epoch; a duplicate callback
    carrying the same URL preserves the existing age and attempt budget.
    """
    if recording_key is None or lease_token is None:
        return
    meeting_pk = _validated_meeting_pk(
        data.get('meeting_pk') if isinstance(data, dict) else None)
    existing_url = RecordingDelivery.objects.filter(
        idempotency_key=recording_key,
        completed_at__isnull=True,
        lease_token=lease_token,
    ).values_list('download_url', flat=True).first()
    if existing_url is None:
        raise DatabaseError('recording lease disappeared before download')
    refreshed_url = existing_url != download_url
    values = {
        'creator_id': creator.pk,
        'meeting_pk': meeting_pk,
        'download_url': download_url,
    }
    if refreshed_url:
        values.update({
            'recovery_started_at': timezone.now(),
            'retry_count': 0,
            'first_failure_at': None,
            'next_retry_at': None,
            'recovery_queued_at': None,
            'last_failure_status': None,
            'retry_exhausted_at': None,
            'stuck_alerted_at': None,
        })
    updated = RecordingDelivery.objects.filter(
        idempotency_key=recording_key,
        completed_at__isnull=True,
        lease_token=lease_token,
    ).update(**values)
    if updated != 1:
        raise DatabaseError('recording lease disappeared before download')


def _recording_recovery_delay(retry_count):
    return min(
        RECORDING_RECOVERY_RETRY_BACKOFF_SECONDS * (2 ** retry_count),
        RECORDING_RECOVERY_RETRY_MAX_BACKOFF_SECONDS,
    )


def record_recording_failure(
    recording_key, lease_token, *, status_code=None, terminal=False,
):
    """Commit one failed download and return its durable recovery deadline."""
    if recording_key is None or lease_token is None:
        return 'discarded', None
    now = timezone.now()
    with transaction.atomic():
        delivery = RecordingDelivery.objects.select_for_update().filter(
            idempotency_key=recording_key,
            completed_at__isnull=True,
            lease_token=lease_token,
        ).first()
        if delivery is None:
            return 'stale', None
        first_failure_at = delivery.first_failure_at or now
        retry_count = delivery.retry_count + 1
        exhausted = terminal or (
            retry_count >= settings.DYTE_RECORDING_RECOVERY_MAX_ATTEMPTS
            or now >= first_failure_at + timedelta(
                seconds=settings.DYTE_RECORDING_RECOVERY_MAX_AGE_SECONDS)
        )
        if exhausted:
            delivery.retry_count = retry_count
            delivery.first_failure_at = first_failure_at
            delivery.next_retry_at = None
            delivery.recovery_queued_at = None
            delivery.retry_exhausted_at = now
            delivery.download_url = ''
            if isinstance(status_code, int) and not isinstance(status_code, bool):
                delivery.last_failure_status = status_code
            delivery.lease_expires_at = now
            delivery.lease_token = None
            delivery.save(update_fields=[
                'retry_count', 'first_failure_at', 'next_retry_at',
                'recovery_queued_at', 'retry_exhausted_at', 'download_url',
                'last_failure_status',
                'lease_expires_at', 'lease_token',
            ])
            return 'exhausted', None

        next_retry_at = now + timedelta(
            seconds=_recording_recovery_delay(retry_count - 1))
        delivery.retry_count = retry_count
        delivery.first_failure_at = first_failure_at
        delivery.next_retry_at = next_retry_at
        delivery.recovery_queued_at = None
        if isinstance(status_code, int) and not isinstance(status_code, bool):
            delivery.last_failure_status = status_code
        delivery.lease_expires_at = now
        delivery.lease_token = None
        delivery.save(update_fields=[
            'retry_count', 'first_failure_at', 'next_retry_at',
            'recovery_queued_at', 'last_failure_status', 'lease_expires_at',
            'lease_token',
        ])
    return 'scheduled', next_retry_at


def terminalize_recording_delivery(recording_key, *, status_code=None):
    """End recovery for a due receipt that cannot be retried safely."""
    now = timezone.now()
    with transaction.atomic():
        delivery = RecordingDelivery.objects.select_for_update().filter(
            idempotency_key=recording_key,
            completed_at__isnull=True,
            retry_exhausted_at__isnull=True,
        ).filter(
            Q(next_retry_at__lte=now) | Q(next_retry_at__isnull=True),
        ).filter(
            Q(lease_token__isnull=True) | Q(lease_expires_at__lte=now),
        ).first()
        if delivery is None:
            return False
        delivery.retry_count += 1
        delivery.first_failure_at = delivery.first_failure_at or now
        delivery.recovery_started_at = delivery.recovery_started_at or now
        delivery.next_retry_at = None
        delivery.recovery_queued_at = None
        delivery.retry_exhausted_at = now
        delivery.download_url = ''
        if isinstance(status_code, int) and not isinstance(status_code, bool):
            delivery.last_failure_status = status_code
        delivery.lease_token = None
        delivery.lease_expires_at = now
        delivery.save(update_fields=[
            'retry_count', 'first_failure_at', 'recovery_started_at',
            'next_retry_at', 'recovery_queued_at', 'retry_exhausted_at',
            'download_url', 'last_failure_status', 'lease_token',
            'lease_expires_at',
        ])
    return True


def enqueue_recording_recovery(recording_key, next_retry_at):
    """Put a durable, delayed recovery job behind the subscriber ACK."""
    from dj.apps.dyte.tasks import retry_recording_delivery

    queued_at = timezone.now()
    # The receipt marker and the Procrastinate row must commit together. A
    # marker committed before defer() would make the sweep skip a receipt if
    # this process is killed in the gap between the two writes.
    with transaction.atomic():
        claimed = RecordingDelivery.objects.filter(
            idempotency_key=recording_key,
            completed_at__isnull=True,
            retry_exhausted_at__isnull=True,
            lease_token__isnull=True,
            next_retry_at=next_retry_at,
            recovery_queued_at__isnull=True,
        ).update(recovery_queued_at=queued_at)
        if claimed != 1:
            return False
        retry_recording_delivery.configure(
            schedule_at=next_retry_at,
        ).defer(delivery_id=str(recording_key))
    return True


def renew_recording_claim(recording_key, lease_token):
    """Extend an owned lease immediately before the object-storage upload."""
    if recording_key is None:
        return True
    if lease_token is None:
        return False
    return RecordingDelivery.objects.filter(
        idempotency_key=recording_key,
        completed_at__isnull=True,
        lease_token=lease_token,
    ).update(
        lease_expires_at=(
            timezone.now()
            + timedelta(seconds=settings.DYTE_RECORDING_LEASE_SECONDS)
        ),
    ) == 1


def discard_recording_claim(recording_key, lease_token):
    """Remove an incomplete claim for a permanently rejected message."""
    if recording_key is not None and lease_token is not None:
        RecordingDelivery.objects.filter(
            idempotency_key=recording_key,
            completed_at__isnull=True,
            lease_token=lease_token,
        ).delete()


def cleanup_uncommitted_upload(
    gfile, recording_key, *, verify_receipt=True,
):
    """Delete a GCS object that never became a durable creator file."""
    name = getattr(gfile.file, 'name', None)
    if not name:
        return
    if verify_receipt and recording_key is not None:
        try:
            committed = RecordingDelivery.objects.filter(
                idempotency_key=recording_key,
                completed_at__isnull=False,
            ).exists()
        except DatabaseError:
            # A failed COMMIT is ambiguous. Never delete an object that may
            # already be referenced by a successfully committed row.
            logging.exception(
                "Could not verify recording %s before GCS cleanup",
                recording_key,
            )
            return
        if committed:
            return
    try:
        gfile.file.storage.delete(name)
    except Exception:
        logging.exception("Failed to clean uncommitted recording object %s", name)


def log_recording_spool_write_failure(recording_key, username, total):
    """Emit the page signal for the common local spool write failure."""
    logging.exception(
        "%s: recording %s for creator "
        "%s could not be written to local disk after reading "
        "%d bytes. NACKing for redelivery; ingestion remains "
        "blocked until local storage recovers.",
        RECORDING_SPOOL_WRITE_FAILED_SIGNAL,
        recording_key, username, total,
    )


def log_recording_spool_flush_failure(recording_key, username, total):
    """Emit a distinct signal for delayed buffered-I/O failures."""
    logging.exception(
        "%s: recording %s for creator "
        "%s could not flush buffered data to local disk after reading "
        "%d bytes. NACKing for redelivery; ingestion remains "
        "blocked until local storage recovers.",
        RECORDING_SPOOL_FLUSH_FAILED_SIGNAL,
        recording_key, username, total,
    )


@catch_errors
def callback(message):
    logging.info("Processing recording queue message")
    try:
        data = json.loads(message.data.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        logging.error("Discarding malformed recording queue payload")
        message.ack()
        return
    if not isinstance(data, dict):
        logging.error("Discarding non-object recording queue payload")
        message.ack()
        return
    username = data.get('username')
    dl_url = data.get('url')
    # Pub/Sub payloads are untyped at this boundary. Validate required fields
    # before urlparse(), ORM lookups, or receipt creation: a structurally bad
    # message can never become valid on redelivery, and NACKing it would let one
    # poison message monopolize this subscriber's max_messages=1 flow slot.
    if not isinstance(username, str) or not username:
        logging.error(
            "Discarding recording message with invalid username: %s",
            _safe_log_identifier(username),
        )
        message.ack()
        return
    if not isinstance(dl_url, str) or not dl_url:
        logging.error(
            "Discarding recording message with invalid URL: %s",
            _safe_log_identifier(dl_url),
        )
        message.ack()
        return
    redacted_url = _safe_recording_url(dl_url)
    raw_recording_key = data.get('recording_idempotency_key')
    raw_provider_event_id = data.get('provider_event_id')
    recording_key = None
    legacy_fallback = not bool(raw_recording_key)
    if data.get('_recording_recovery') is True:
        legacy_fallback = data.get('_legacy_fallback') is True
    source_url_key = recording_source_url_key(username, dl_url)
    lease_token = None
    if raw_recording_key:
        try:
            recording_key = uuid.UUID(raw_recording_key)
        except (AttributeError, TypeError, ValueError):
            logging.error(
                "Invalid recording_idempotency_key in message: %s",
                _safe_log_identifier(raw_recording_key),
            )
            message.ack()
            return
    elif raw_provider_event_id:
        # Transition messages that do not yet carry the semantic recording key
        # use the webhook delivery UUID. Preserve that receipt key while
        # old/new subscriber pods and already-published messages drain.
        try:
            recording_key = uuid.UUID(raw_provider_event_id)
        except (AttributeError, TypeError, ValueError):
            logging.error(
                "Invalid provider_event_id in recording message: %s",
                _safe_log_identifier(raw_provider_event_id),
            )
            message.ack()
            return
    else:
        # Messages published by the pre-idempotency web code have no provider
        # UUID. Derive a stable transition key so a rollout backlog is still
        # protected from subscriber redelivery.
        parsed_url = urlparse(dl_url)
        recording_key = uuid.uuid5(
            uuid.NAMESPACE_URL,
            f'{username}\x1f{parsed_url.scheme}://{parsed_url.netloc}{parsed_url.path}',
        )

    if recording_key is not None:
        claim_result, lease_token = claim_recording(
            recording_key,
            source_url_key=source_url_key,
            legacy_fallback=legacy_fallback,
        )
        if claim_result == 'completed':
            logging.info("Ignoring duplicate recording %s", recording_key)
            message.ack()
            return
        if claim_result == 'busy':
            logging.info("Recording %s is already processing", recording_key)
            # Never ACK unfinished work: the current owner may have crashed.
            # Subscriber flow control limits this consumer to one outstanding
            # recording, so NACK cannot fan out into concurrent disk spools.
            message.nack()
            return
        # Durable recovery uses this to settle a NACK only if this callback
        # actually owned the lease. A fresh provider callback may win the
        # race while an already-queued recovery job is starting.
        if hasattr(message, 'lease_token'):
            message.lease_token = lease_token

    # The owner is the account id when the producer sent one; the username
    # only for messages queued before it did. A username can change hands
    # (account deletion frees it), an id never does.
    creator_id = data.get('creator_id') if isinstance(data, dict) else None
    try:
        if isinstance(creator_id, int) and not isinstance(creator_id, bool):
            creator = Creator.objects.get(pk=creator_id)
        else:
            creator = Creator.objects.get(username__iexact=username)
    except Creator.DoesNotExist:
        logging.info("No creator found for recording %s", recording_key)
        discard_recording_claim(recording_key, lease_token)
        message.ack()
        return

    # A deleted account (g12f.account_deletion) gets no new recordings. Its
    # username is reserved for 30 days and then freed, and a message queued
    # before the producer sent ``creator_id`` names only the username: a
    # meeting that belongs to a DELETED account other than the one the name
    # now resolves to is that case, and is dropped rather than saved into the
    # account that registered the name since.
    meeting_pk = _validated_meeting_pk(
        data.get('meeting_pk') if isinstance(data, dict) else None)
    meeting_owner_deleted = meeting_pk is not None and CreatorMeeting.objects.filter(
        pk=meeting_pk, creator__deleted_at__isnull=False,
    ).exclude(creator_id=creator.pk).exists()
    if creator.deleted_at is not None or meeting_owner_deleted:
        logging.warning(
            "Dropping recording %s: its account was deleted", recording_key,
        )
        discard_recording_claim(recording_key, lease_token)
        message.ack()
        return

    # SSRF guard. The URL rides in on the webhook payload; a signature
    # only proves the provider sent it, not that it is safe to GET from inside
    # the cluster. Refuse anything that is not an https URL on an allowlisted
    # provider-storage host BEFORE making any outbound request. ack() so a
    # rejected message is not redelivered forever (it will never become valid).
    if not is_allowed_recording_url(
        dl_url, settings.DYTE_RECORDING_ALLOWED_HOSTS
    ):
        logging.error(
            "REJECTED recording URL not on the allowlist: %s (creator %s)",
            redacted_url, username,
        )
        discard_recording_claim(recording_key, lease_token)
        message.ack()
        return

    # Keep the validated provider URL and the creator identity in the durable
    # receipt before the first outbound request. If this callback is ACKed
    # after a transient HTTP failure, the recovery worker has everything it
    # needs even when the provider never sends another webhook.
    persist_recording_context(
        recording_key, lease_token, creator, data, dl_url)

    # Production uses persistent connections. Do not pin one callback's Cloud
    # SQL session while it downloads a video. The next ORM call reconnects.
    if not connection.in_atomic_block:
        connection.close()

    logging.info("Downloading %s for creator %s", redacted_url, username)

    response = None
    for attempt in range(RECORDING_DOWNLOAD_MAX_ATTEMPTS):
        try:
            # allow_redirects=False: an allowlisted host must not be able to 3xx us
            # onto an internal address (e.g. the metadata endpoint) — the redirect
            # target is never re-checked, so we simply do not follow it. Provider
            # presigned URLs are terminal and do not redirect.
            response = requests.get(
                dl_url,
                stream=True,
                timeout=settings.DYTE_RECORDING_DOWNLOAD_TIMEOUT_SECONDS,
                allow_redirects=False,
            )
        except requests.exceptions.RequestException as exc:
            logging.error(
                "Download failed for %s: %s",
                redacted_url,
                scrub_recording_diagnostic(exc, dl_url),
            )
            release_recording_claim(recording_key, lease_token)
            raise

        response_status = getattr(response, 'status_code', 200)
        if response_status not in RECORDING_DOWNLOAD_RETRY_STATUS_CODES:
            break

        response.close()
        response = None
        if attempt + 1 >= RECORDING_DOWNLOAD_MAX_ATTEMPTS:
            outcome, next_retry_at = record_recording_failure(
                recording_key,
                lease_token,
                status_code=response_status,
            )
            if outcome == 'scheduled':
                logging.warning(
                    "Recording download HTTP %d exhausted local retries for "
                    "recording=%s; durable recovery scheduled at %s",
                    response_status,
                    _safe_log_identifier(recording_key),
                    next_retry_at,
                )
                enqueue_recording_recovery(recording_key, next_retry_at)
            elif outcome == 'exhausted':
                logging.error(
                    "%s: recording=%s creator=%s returned HTTP %d after "
                    "%d durable retry rounds; awaiting a fresh provider "
                    "callback",
                    RECORDING_DOWNLOAD_RETRY_EXHAUSTED_SIGNAL,
                    _safe_log_identifier(recording_key),
                    _safe_log_identifier(username),
                    response_status,
                    settings.DYTE_RECORDING_RECOVERY_MAX_ATTEMPTS,
                )
            message.ack()
            return

        delay = min(
            RECORDING_DOWNLOAD_RETRY_BACKOFF_SECONDS * (2 ** attempt),
            RECORDING_DOWNLOAD_RETRY_MAX_BACKOFF_SECONDS,
        )
        logging.warning(
            "Transient recording download HTTP %d for recording=%s; "
            "retrying attempt %d/%d in %.1f seconds",
            response_status,
            _safe_log_identifier(recording_key),
            attempt + 2,
            RECORDING_DOWNLOAD_MAX_ATTEMPTS,
            delay,
        )
        time.sleep(delay)

    # A bounded retry can consume every transient response and leave no
    # response object. Settle that path above rather than dereferencing None
    # and turning a permanently handled message into a NACK loop.
    if response is None:
        raise RuntimeError('recording download response disappeared')
    if response.is_redirect or response.is_permanent_redirect:
        logging.error(
            "REJECTED recording URL that redirected: %s -> %s",
            redacted_url,
            _safe_recording_url(response.headers.get("Location", "")),
        )
        response.close()
        discard_recording_claim(recording_key, lease_token)
        message.ack()
        return

    response_status = getattr(response, 'status_code', 200)
    if 400 <= response_status < 500 and response_status not in {408, 429}:
        logging.error(
            "Permanently rejecting recording URL returning HTTP %d: %s",
            response_status, redacted_url,
        )
        response.close()
        # ACK the unusable URL so it cannot poison the sole subscriber, but
        # terminalize the incomplete receipt and clear its capability. A later
        # callback with refreshed credentials for the same recording UUID can
        # revive it with a new bounded recovery epoch.
        record_recording_failure(
            recording_key, lease_token, status_code=response_status,
            terminal=True,
        )
        logging.error(
            "%s: recording=%s creator=%s returned terminal HTTP %d",
            RECORDING_DOWNLOAD_RETRY_EXHAUSTED_SIGNAL,
            _safe_log_identifier(recording_key),
            _safe_log_identifier(username),
            response_status,
        )
        message.ack()
        return

    try:
        response.raise_for_status()
    except requests.exceptions.RequestException:
        response.close()
        release_recording_claim(recording_key, lease_token)
        raise
    file_name = os.path.basename(urlparse(dl_url).path)

    # Stream to a disk-backed spooled temp file rather than a pure in-memory
    # BytesIO: recordings are videos, the subscriber pod's memory LIMIT is
    # 2Gi, and buffering a whole recording in RAM would OOM-kill it (kubelet
    # then redelivers, so it wedges). SpooledTemporaryFile keeps small files in
    # RAM and spills larger ones to disk, so peak memory is bounded by
    # DYTE_RECORDING_SPOOL_MAX_BYTES regardless of recording size. The
    # DYTE_RECORDING_MAX_BYTES cap is a backstop against an unbounded/hostile
    # response (it bounds disk, not RAM).
    max_bytes = settings.DYTE_RECORDING_MAX_BYTES
    file_data = tempfile.SpooledTemporaryFile(
        max_size=settings.DYTE_RECORDING_SPOOL_MAX_BYTES, mode="w+b")
    download_started = time.monotonic()
    try:
        total = 0
        for chunk in response.iter_content(chunk_size=8192):
            if (
                time.monotonic() - download_started
                > settings.DYTE_RECORDING_TOTAL_TIMEOUT_SECONDS
            ):
                raise requests.exceptions.Timeout(
                    'recording exceeded total download time limit')
            total += len(chunk)
            if total > max_bytes:
                logging.error(
                    "REJECTED recording exceeding %d bytes: %s",
                    max_bytes, redacted_url)
                response.close()
                discard_recording_claim(recording_key, lease_token)
                message.ack()
                return
            try:
                file_data.write(chunk)
            except Exception:
                # A local spool failure is OUR outage, not a bad provider
                # response. Keep the exception on the ordinary NACK path so
                # the intact recording is retried, but give operators a
                # stable alert signal: this subscriber has one replica and
                # one flow-control slot, so ENOSPC otherwise wedges ingestion
                # for every creator without terminating on its own.
                log_recording_spool_write_failure(
                    recording_key, username, total)
                raise
        try:
            # Buffered disk I/O can accept write() and report ENOSPC only when
            # seek() flushes the buffer. Treat that as the same local spool
            # outage rather than falling through to a silent generic NACK.
            file_data.seek(0)
        except Exception:
            log_recording_spool_flush_failure(
                recording_key, username, total)
            raise
        mime_type, _ = mimetypes.guess_type(file_name)
        if mime_type is None:
            content_type = response.headers.get('Content-Type', '')
            if isinstance(content_type, str):
                mime_type = content_type.partition(';')[0].strip() or None
        # RealtimeKit recording outputs are MP4, but a presigned object URL
        # need not carry either a filename extension or a Content-Type header.
        # GenericFile.mime_type is NOT NULL; leaving this as None would turn
        # one valid recording into an indefinitely redelivered poison message.
        mime_type = (mime_type or 'video/mp4')[:64]

        logging.info(
            "Saving recording %s for creator %s (%s)",
            recording_key, username, mime_type,
        )
        gfile = GenericFile(
            owner=creator,
            title=(
                f'{username} Live '
                f'{datetime.now().strftime("%Y-%m-%d")}'
            )[:128],
            mime_type=mime_type,
            # Fail-closed placeholder; the authoritative tier is resolved from
            # the meeting's current meeting_type just before save() inside the
            # transaction below, so a restriction changed while the recording
            # was downloading cannot publish stale public access.
            access=DEFAULT_RECORDING_ACCESS,
        )
        if not renew_recording_claim(recording_key, lease_token):
            logging.info(
                "Recording %s lease was taken over before upload",
                recording_key,
            )
            message.ack()
            return
        if not connection.in_atomic_block:
            connection.close()
        # Upload outside the DB transaction. Object storage cannot join it;
        # save=False avoids holding a Cloud SQL connection during slow GCS I/O.
        _, extension = os.path.splitext(file_name)
        upload_name = limit_filename_length(
            f'recordings/{lease_token or uuid.uuid4()}{extension}')
        # Save directly to storage so GenericFile.upload_to does not prefix a
        # potentially 150-character username into a 100-character FileField.
        # The per-lease UUID also makes concurrent takeover objects distinct.
        gfile.file.name = gfile.file.storage.save(
            upload_name, File(file_data), max_length=100)
        lost_lease = False
        delivery = None
        with transaction.atomic():
            # The account may have been deleted during the download. Lock its
            # row FIRST -- account deletion takes the account row before the
            # recording receipts, so this order cannot deadlock against it --
            # and refuse to attach anything to a deleted account; the
            # uploaded object is cleaned up below like a lost lease.
            owner_deleted_at = Creator.objects.select_for_update().filter(
                pk=creator.pk).values_list('deleted_at', flat=True).first()
            if owner_deleted_at is not None:
                logging.warning(
                    "Recording %s: account deleted during download; discarded",
                    recording_key,
                )
                lost_lease = True
            if recording_key and not lost_lease:
                delivery = RecordingDelivery.objects.select_for_update().get(
                    idempotency_key=recording_key)
                if delivery.completed_at is not None:
                    logging.info(
                        "Recording %s completed concurrently", recording_key)
                    lost_lease = True
                elif delivery.lease_token != lease_token:
                    logging.info(
                        "Recording %s lease was taken over", recording_key)
                    lost_lease = True
            if not lost_lease:
                # Resolve the access tier here, inside the transaction and
                # immediately before the durable save: the meeting's current
                # meeting_type is what the row publishes, never a value read
                # before the potentially multi-GiB download. The
                # resolver row-locks the matched CreatorMeeting, so a
                # concurrent meeting_type downgrade cannot commit between this
                # read and gfile.save() to leave a stale public recording
                # (adversarial review).
                gfile.access = resolve_recording_access(
                    data, creator, delivery=delivery)
                gfile.save()
                if recording_key:
                    delivery.generic_file = gfile
                    # The provider URL is a short-lived capability. Once the
                    # object is durably attached, retaining it would leave a
                    # stale credential in the recovery receipt and make the
                    # completion assertion lie about the cleanup boundary.
                    delivery.download_url = ''
                    delivery.completed_at = timezone.now()
                    delivery.lease_token = None
                    delivery.lease_expires_at = None
                    delivery.save(update_fields=[
                        'generic_file', 'completed_at', 'lease_token',
                        'lease_expires_at', 'download_url', 'next_retry_at',
                        'first_failure_at', 'recovery_started_at',
                        'recovery_queued_at', 'last_failure_status',
                        'retry_exhausted_at', 'stuck_alerted_at',
                    ])
        if lost_lease:
            cleanup_uncommitted_upload(
                gfile, recording_key, verify_receipt=False)
            message.ack()
            return
    except Exception:
        if 'gfile' in locals():
            cleanup_uncommitted_upload(gfile, recording_key)
        release_recording_claim(recording_key, lease_token)
        raise
    finally:
        response.close()
        file_data.close()
    logging.info(f"Saved {gfile}, acking message")
    message.ack()


class Command(BaseCommand):
    def handle(self, *args, **options):
        ps = PubSubClient()

        ps.subscribe(
            settings.PUBSUB["DYTE_VIDEO_READY"]["topic"],
            settings.PUBSUB["DYTE_VIDEO_READY"]["DLUP"],
            callback,
            # A recording can spool up to 2 GiB. Pub/Sub defaults to a
            # multi-thread callback executor; bounding outstanding messages to
            # one prevents a burst from filling the node's shared /tmp.
            flow_control=FlowControl(max_messages=1),
        )
