"""Versioned producer state machine shared by both Free2Z clients."""

import base64
import hashlib
import json
import time
from contextlib import contextmanager
from datetime import timedelta

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings
from django.db import connection, transaction, models, DatabaseError
from django.utils import timezone
from dj.apps.g12f.models import Creator
from .models import (
    CreatorMeeting,
    ProducerOperation,
    ProducerStream,
    ProviderRoomCleanup,
)
from .producer_provider import ProducerProvider, ProviderUnavailable, configured

TRANSITIONS = {
    "draft": {"provisioning", "ended"},
    "provisioning": {"ready", "ending", "failed"},
    "ready": {"live", "interrupted", "ending"},
    "live": {"interrupted", "ending"},
    "interrupted": {"live", "ending"},
    "ending": {"ended", "failed"},
    "ended": {"cleaned_up"},
    "failed": {"ending", "cleaned_up"},
    "cleaned_up": set(),
}
GRACE = timedelta(seconds=120)
HEARTBEAT = timedelta(seconds=60)


class Refusal(Exception):
    def __init__(self, code, status=409):
        self.code, self.status = code, status


@contextmanager
def actor_lock(creator_id):
    # Session lock spans short committed write-ahead transactions and bounded
    # provider I/O. Same key as legacy hosts: no simultaneous legacy producer.
    key = f"dyte-host-seat:{creator_id}"
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_try_advisory_lock(hashtext(%s)::bigint)", [key])
        if not cursor.fetchone()[0]:
            raise Refusal("operation_in_progress")
    try:
        yield
    finally:
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_unlock(hashtext(%s)::bigint)", [key])


def transition(stream, state):
    if state not in TRANSITIONS[stream.state]:
        raise Refusal("invalid_transition")
    stream.state = state
    stream.version += 1
    stream.save()


def authenticate(actor, expected):
    query = (
        Creator.objects.select_for_update()
        if connection.in_atomic_block
        else Creator.objects
    )
    current = query.get(pk=actor.pk)
    if (
        not current.is_active
        or current.pk != expected
        or current.kt_account_epoch != actor.kt_account_epoch
    ):
        raise Refusal("actor_authentication_changed", 401)
    return current


def cipher():
    return Fernet(
        base64.urlsafe_b64encode(
            hashlib.sha256(
                (settings.SECRET_KEY + ":free2z-producer-v1").encode()
            ).digest()
        )
    )


def snapshot(stream):
    fresh = stream.confirmed_at and timezone.now() - stream.confirmed_at < HEARTBEAT
    return {
        "id": str(stream.pk),
        "state": stream.state,
        "version": stream.version,
        "title": stream.title,
        "description": stream.description,
        "audience": stream.audience,
        "access": stream.access,
        "owner": str(stream.owner),
        "room_id": str(stream.room_id) if stream.room_id else None,
        "participants": stream.participants
        if fresh and stream.state == "live"
        else None,
        "error_code": stream.error_code,
        "ended_at": stream.ended_at,
        "heartbeat_seconds": 15,
        "grace_seconds": 120,
    }


def readiness(actor):
    from dj.apps.economy.models import EconomicPolicy

    supported_policy = EconomicPolicy.objects.filter(
        pk=True, version__in=(0, 1)
    ).exists()
    available = configured()
    reachable = False
    if available:
        try:
            reachable = ProducerProvider().check() is True
        except ProviderUnavailable:
            pass
    return {
        "eligible": actor.is_active and actor.can_stream,
        "provider_configured": available,
        "provider_reachable": reachable,
        "supported_audiences": ["public"],
        "supported_access": ["free"],
        "contract_version": 1,
        "ready": bool(
            actor.is_active and actor.can_stream and reachable and supported_policy
        ),
    }


def hide(stream):
    if stream.meeting_id:
        CreatorMeeting.objects.filter(pk=stream.meeting_id).update(live_now=False)


def retire_previous_room(stream, provider):
    """Retire the immutable legacy room before creating its replacement.

    The operation's private receipt survives process death before any provider
    call. Keep its historical owner/fee identity after the projection rotates.
    """
    operation = ProducerOperation.objects.filter(
        stream=stream, result__action="provision"
    ).first()
    receipt_id = operation.result.get("retired_room_id") if operation else None
    if receipt_id is None:
        return
    receipt = ProviderRoomCleanup.objects.get(pk=receipt_id)
    if receipt.status == "complete":
        return
    receipt.attempts += 1
    receipt.save(update_fields=["attempts"])
    provider.disable(receipt.provider_meeting_id)
    receipt.status = "complete"
    receipt.completed_at = timezone.now()
    receipt.next_attempt_at = None
    receipt.last_error = ""
    receipt.save(
        update_fields=["status", "completed_at", "next_attempt_at", "last_error"]
    )


def cleanup(stream, provider):
    """Never re-create after an ambiguous create, even after an empty search."""
    if stream.cleanup_attempts >= 20:
        stream.error_code = "cleanup_manual_review"
        stream.save()
        return
    stream.cleanup_attempts += 1
    stream.next_cleanup_at = timezone.now() + timedelta(
        seconds=min(3600, 15 * 2**stream.cleanup_attempts)
    )
    stream.save()
    try:
        retire_previous_room(stream, provider)
        if stream.create_attempted and not stream.room_id:
            matches = provider.find(f"f2z-producer-{stream.pk}")
            if len(matches) != 1:
                raise ProviderUnavailable()
            stream.room_id = matches[0]
            stream.save()
        if stream.room_id:
            provider.disable(str(stream.room_id))
        with transaction.atomic():
            hide(stream)
            stream.token_ciphertext = ""
            stream.participants = None
            if stream.state == "failed":
                transition(stream, "ending")
            if stream.state == "ending":
                stream.ended_at = timezone.now()
                transition(stream, "ended")
            if stream.state == "draft":
                stream.ended_at = timezone.now()
                transition(stream, "ended")
            stream.error_code = ""
            stream.ended_at = stream.ended_at or timezone.now()
            transition(stream, "cleaned_up")
    except (ProviderUnavailable, ValueError, KeyError, TypeError):
        stream.error_code = "cleanup_pending"
        stream.save()


def execute(actor, stream_id, payload):
    key = payload["idempotency_key"]
    # Fingerprint includes the complete validated instruction including version,
    # actor, owner and target. Keys are actor-wide, not endpoint-local.
    fingerprint = hashlib.sha256(
        json.dumps(
            {"target": str(stream_id) if stream_id else None, **payload},
            sort_keys=True,
            default=str,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    with actor_lock(actor.pk):
        actor = authenticate(actor, payload["expected_actor_id"])
        prior = ProducerOperation.objects.filter(creator=actor, key=key).first()
        if prior:
            if prior.fingerprint != fingerprint:
                raise Refusal("idempotency_mismatch")
            stream = prior.stream
            if stream.account_epoch != actor.kt_account_epoch:
                raise Refusal("actor_authentication_changed", 401)
            # Read-only replay: never repeats provisioning, notifications or token mint.
            return reply(stream, prior.status, prior.result, payload["owner"])
        action = payload["action"]
        if stream_id is None:
            if action != "draft":
                raise Refusal("draft_required", 400)
            if (
                ProducerStream.objects.filter(creator=actor)
                .exclude(state="cleaned_up")
                .exists()
            ):
                raise Refusal("stream_already_exists")
            if not actor.can_stream:
                raise Refusal("creator_ineligible", 403)
            stream = ProducerStream(
                creator=actor,
                account_epoch=actor.kt_account_epoch,
                owner=payload["owner"],
                title=payload["title"],
                description=payload["description"],
                audience=payload["audience"],
                access=payload["access"],
            )
        else:
            stream = ProducerStream.objects.filter(pk=stream_id, creator=actor).first()
            if stream is None:
                raise Refusal("stream_not_found", 404)
            if stream.account_epoch != actor.kt_account_epoch and action not in (
                "end",
                "takeover",
            ):
                raise Refusal("actor_authentication_changed", 401)
            if action not in ("update",) and any(
                payload[k] != getattr(stream, k)
                for k in ("title", "description", "audience", "access")
            ):
                raise Refusal("metadata_mismatch")
            if stream.version != payload["version"]:
                raise Refusal("stale_version")
            if action != "takeover" and stream.owner != payload["owner"]:
                raise Refusal("owner_changed")
        if action in ("draft", "update", "provision", "refresh", "publish", "takeover"):
            if not actor.can_stream:
                raise Refusal("creator_ineligible", 403)
            if payload["audience"] != "public" or payload["access"] != "free":
                raise Refusal("access_policy_unavailable", 422)
        if action == "update":
            if stream.state != "draft":
                raise Refusal("metadata_locked")
            stream.title, stream.description = payload["title"], payload["description"]
            stream.version += 1
        if action == "draft" and stream_id:
            raise Refusal("invalid_transition")
        if (
            action in ("provision", "refresh", "publish", "takeover")
            and not configured()
        ):
            raise Refusal("provider_unavailable", 503)
        if action == "provision":
            # Free-to-watch broadcasts still use the existing platform-fee
            # settlement path. Honor the same backend policy fence as legacy
            # starts before any provider POST.
            from dj.apps.economy.epoch import pin_supported_policy

            try:
                with transaction.atomic():
                    pin_supported_policy()
            except (RuntimeError, DatabaseError):
                raise Refusal("billing_policy_unavailable", 503) from None
        # Validate before creating an operation. Once recorded, a request can
        # only be replayed or reconciled; no exception rollback erases a POST.
        allowed = {
            "draft": {"draft"},
            "update": {"draft"},
            "provision": {"draft"},
            "refresh": {"ready", "interrupted", "live"},
            "publish": {"ready", "interrupted", "live"},
            "heartbeat": {"ready", "live", "interrupted"},
            "interrupt": {"ready", "live", "interrupted"},
            "takeover": {"ready", "live", "interrupted"},
            "end": set(TRANSITIONS),
        }
        if stream.state not in allowed[action]:
            raise Refusal("invalid_transition")
        previous = None
        if (
            action == "provision"
            and CreatorMeeting.objects.filter(creator=actor)
            .filter(
                models.Q(host_session_id__isnull=False)
                | models.Q(live_now=True)
                | ~models.Q(lifecycle_state="offline")
                | models.Q(host_start_claim__isnull=False)
            )
            .exists()
        ):
            raise Refusal("legacy_host_active")
        if action == "provision":
            previous = CreatorMeeting.objects.filter(
                creator=actor, meeting_type="broadcast", is_public=True
            ).first()
        with transaction.atomic():
            stream.save()
            op = ProducerOperation.objects.create(
                creator=actor,
                key=key,
                fingerprint=fingerprint,
                stream=stream,
                result={"action": action, "accepted_version": stream.version},
            )
            if action == "provision":
                if previous and previous.meeting_id:
                    receipt, _ = ProviderRoomCleanup.objects.get_or_create(
                        provider_meeting_id=previous.meeting_id,
                        defaults={
                            "creator": actor,
                            "creator_meeting": previous,
                            "meeting_type": "broadcast",
                            "provider_title": actor.username,
                            "price_per_minute": previous.price_per_minute,
                            "provider_session_id": previous.provider_session_id,
                            "start_id": previous.start_id,
                        },
                    )
                    if (
                        receipt.creator_id != actor.pk
                        or receipt.meeting_type != "broadcast"
                    ):
                        raise Refusal("legacy_room_unresolved", 503)
                    op.result["retired_room_id"] = receipt.pk
                    op.save(update_fields=["result"])
                    # Late legacy start callbacks cannot revive this room.
                    previous.handshake_managed = True
                    previous.save(update_fields=["handshake_managed"])
                    stream.meeting = previous
                transition(stream, "provisioning")
            elif action == "end" and stream.state not in (
                "ended",
                "cleaned_up",
                "ending",
            ):
                hide(stream)
                transition(stream, "ending" if stream.state != "draft" else "ended")
        status = 200
        try:
            provider = (
                ProducerProvider()
                if action in ("provision", "refresh", "publish", "takeover")
                or (
                    action == "end"
                    and stream.state != "cleaned_up"
                    and (stream.create_attempted or stream.meeting_id)
                )
                else None
            )
            if action == "provision":
                retire_previous_room(stream, provider)
                stream.create_attempted = True
                stream.save(update_fields=["create_attempted"])
                stream.room_id = provider.create(f"f2z-producer-{stream.pk}")
                # Persist provider ID before any auth/ownership finalization.
                stream.save()
                with transaction.atomic():
                    authenticate(actor, actor.pk)
                    cm, _ = CreatorMeeting.objects.get_or_create(
                        creator=actor, meeting_type="broadcast", is_public=True
                    )
                    cm.meeting_id = stream.room_id
                    cm.handshake_managed = True
                    cm.live_now = False
                    cm.lifecycle_state = "offline"
                    cm.start_id = stream.pk
                    cm.provider_session_id = None
                    cm.provider_session_started_at = None
                    cm.last_seen_at = None
                    cm.zero_probe_since = None
                    cm.price_per_minute = 0
                    cm.save(
                        update_fields=[
                            "meeting_id",
                            "handshake_managed",
                            "live_now",
                            "lifecycle_state",
                            "start_id",
                            "provider_session_id",
                            "provider_session_started_at",
                            "last_seen_at",
                            "zero_probe_since",
                            "price_per_minute",
                        ]
                    )
                    stream.meeting = cm
                    transition(stream, "ready")
            elif action in ("refresh", "takeover"):
                if stream.token_attempted:
                    raise Refusal("token_outcome_unknown")
                if stream.participant_id:
                    provider.retire(str(stream.room_id), str(stream.participant_id))
                if action == "refresh" and stream.state == "live":
                    stream.interrupted_at = timezone.now()
                    transition(stream, "interrupted")
                    hide(stream)
                stream.heartbeat_at = timezone.now()
                stream.error_code = ""
                if action == "takeover":
                    stream.owner = payload["owner"]
                    stream.account_epoch = actor.kt_account_epoch
                    stream.heartbeat_at = timezone.now()
                    stream.interrupted_at = timezone.now()
                    if stream.state != "interrupted":
                        transition(stream, "interrupted")
                    hide(stream)
                # If interrupted during mint, only room deactivation is safe.
                stream.token_attempted = True
                stream.token_ciphertext = ""
                stream.save()
                participant, token = provider.token(
                    str(stream.room_id), f"producer:{key}", actor
                )
                stream.participant_id = participant
                stream.token_ciphertext = cipher().encrypt(token.encode()).decode()
                stream.token_expires_at = timezone.now() + timedelta(minutes=10)
                stream.token_attempted = False
                stream.version += 1
                stream.save()
                authenticate(actor, actor.pk)
            elif action == "publish":
                if not stream.participant_id or stream.token_attempted:
                    raise Refusal("host_ticket_required")
                session, count = provider.live(
                    str(stream.room_id), str(stream.participant_id)
                )
                with transaction.atomic():
                    authenticate(actor, actor.pk)
                    stream.session_id, stream.participants = session, count
                    stream.error_code = ""
                    stream.confirmed_at = timezone.now()
                    stream.heartbeat_at = timezone.now()
                    stream.interrupted_at = None
                    if stream.state != "live":
                        transition(stream, "live")
                    else:
                        stream.save()
                    CreatorMeeting.objects.filter(pk=stream.meeting_id).update(
                        live_now=True,
                        last_seen_at=stream.confirmed_at,
                        provider_session_id=session,
                        # A confirmation timestamp is not a provider start time.
                        provider_session_started_at=None,
                    )
            elif action == "interrupt":
                if stream.state != "interrupted":
                    stream.interrupted_at = timezone.now()
                    transition(stream, "interrupted")
                hide(stream)
            elif action == "heartbeat":
                stream.heartbeat_at = timezone.now()
                stream.save()
            elif action == "end" and stream.state != "cleaned_up":
                cleanup(stream, provider)
                status = 200 if stream.state == "cleaned_up" else 202
        except (ProviderUnavailable, ValueError, KeyError, TypeError, Refusal) as exc:
            if action == "provision":
                stream.error_code = "provision_outcome_unknown"
                transition(stream, "failed")
            elif action in ("refresh", "takeover"):
                stream.error_code = "token_outcome_unknown"
                hide(stream)
                if stream.token_attempted and stream.state in ("ready", "interrupted"):
                    transition(stream, "ending")
            else:
                stream.error_code = (
                    exc.code if isinstance(exc, Refusal) else "provider_unavailable"
                )
            stream.save()
            status = exc.status if isinstance(exc, Refusal) else 503
        op.status = status
        op.result["accepted_version"] = stream.version
        op.save()
        return reply(stream, status, op.result, payload["owner"])


def reply(stream, status, result, owner):
    body = {
        "stream": snapshot(stream),
        "operation": {key: result[key] for key in ("action", "accepted_version")},
        "auth_token": None,
    }
    if status >= 400:
        body["code"] = stream.error_code or "request_refused"
    if (
        result["action"] in ("refresh", "takeover")
        and status == 200
        and stream.owner == owner
        and stream.version == result["accepted_version"]
        and stream.token_expires_at
        and timezone.now() < stream.token_expires_at
        and stream.state in ("ready", "interrupted")
        and stream.token_ciphertext
    ):
        try:
            body["auth_token"] = (
                cipher().decrypt(stream.token_ciphertext.encode()).decode()
            )
        except InvalidToken:
            raise Refusal("ticket_expired") from None
    return body, status


def recover(limit=20, budget_seconds=5):
    """Bounded periodic recovery; no client callback is needed to end grace."""
    deadline = time.monotonic() + budget_seconds
    ids = (
        ProducerStream.objects.exclude(state="cleaned_up")
        .filter(next_cleanup_at__lte=timezone.now())
        .order_by("next_cleanup_at")
        .values_list("pk", flat=True)[:limit]
    )
    for pk in list(ids):
        if time.monotonic() >= deadline:
            break
        stream = ProducerStream.objects.get(pk=pk)
        try:
            with actor_lock(stream.creator_id):
                stream.refresh_from_db()
                now = timezone.now()
                stream.next_cleanup_at = now + timedelta(seconds=15)
                stream.save(update_fields=["next_cleanup_at"])
                actor = Creator.objects.get(pk=stream.creator_id)
                if (
                    not actor.is_active
                    or actor.kt_account_epoch != stream.account_epoch
                ) and stream.state in ("ready", "live", "interrupted"):
                    transition(stream, "ending")
                    hide(stream)
                if stream.state in ("ready", "live") and (
                    now - stream.heartbeat_at > HEARTBEAT
                    or (
                        stream.state == "live"
                        and (
                            stream.confirmed_at is None
                            or now - stream.confirmed_at > HEARTBEAT
                        )
                    )
                ):
                    stream.interrupted_at = now
                    transition(stream, "interrupted")
                    hide(stream)
                if (
                    stream.state == "interrupted"
                    and now - (stream.interrupted_at or stream.heartbeat_at) > GRACE
                ):
                    transition(stream, "ending")
                    hide(stream)
                if stream.state == "provisioning":
                    transition(stream, "failed")
                if stream.state in ("ending", "ended", "failed"):
                    cleanup(
                        stream,
                        ProducerProvider()
                        if stream.create_attempted or stream.meeting_id
                        else None,
                    )
        except (Refusal, ProviderUnavailable):
            continue
