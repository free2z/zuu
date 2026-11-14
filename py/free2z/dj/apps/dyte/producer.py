"""Versioned producer state machine shared by both Free2Z clients."""

import base64
import hashlib
import json
import time
import uuid
from contextvars import ContextVar
from contextlib import contextmanager
from datetime import timedelta

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings
from django.db import connection, transaction, models, DatabaseError
from django.utils import timezone
from django.db.models.functions import Now
from dj.apps.g12f.models import Creator
from .models import (
    CreatorMeeting,
    ProducerActorClaim,
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


CLAIM_TTL = timedelta(
    seconds=max(
        120,
        4 * (settings.DYTE_CONNECT_TIMEOUT_SECONDS + settings.DYTE_READ_TIMEOUT_SECONDS)
        + 30,
    )
)
_current_claim = ContextVar("free2z_producer_claim", default=None)


@contextmanager
def seat_decision(creator_id):
    # Shared with legacy host decisions, but held for one short transaction.
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT pg_try_advisory_xact_lock(hashtext(%s)::bigint)",
                [f"dyte-host-seat:{creator_id}"],
            )
            if not cursor.fetchone()[0]:
                raise Refusal("operation_in_progress")
        # Same lock order as account deletion: creator before claim/state.
        creator = Creator.objects.select_for_update().get(pk=creator_id)
        yield creator


class ActorClaim:
    def __init__(self, creator_id, token, recovery, reclaimed):
        self.creator_id, self.token = creator_id, token
        self.recovery, self.reclaimed = recovery, reclaimed
        self.depth = 0

    @contextmanager
    def atomic(self):
        if self.depth:
            yield
            return
        with seat_decision(self.creator_id) as creator:
            if not creator.is_active and not self.recovery:
                raise Refusal("actor_authentication_changed", 401)
            row = ProducerActorClaim.objects.select_for_update().get(
                creator_id=self.creator_id
            )
            if row.token != self.token:
                raise Refusal("operation_in_progress")
            row.expires_at = Now() + CLAIM_TTL
            row.save(update_fields=["expires_at"])
            self.depth += 1
            try:
                yield
            finally:
                self.depth -= 1


@contextmanager
def actor_lock(creator_id, *, recovery=False):
    # A request-wide transaction would make every pre-I/O marker a savepoint.
    # Refuse it instead of silently losing claims/markers on a later rollback.
    if connection.in_atomic_block:
        raise Refusal("producer_requires_autocommit", 503)
    nonce = uuid.uuid4()
    with seat_decision(creator_id) as creator:
        if not creator.is_active and not recovery:
            raise Refusal("actor_authentication_changed", 401)
        row, _ = ProducerActorClaim.objects.select_for_update().get_or_create(
            creator_id=creator_id
        )
        reclaimed = row.token is not None
        if reclaimed and (
            not recovery
            or ProducerActorClaim.objects.filter(
                pk=row.pk, expires_at__gt=Now()
            ).exists()
        ):
            raise Refusal("operation_in_progress")
        row.token, row.expires_at = nonce, Now() + CLAIM_TTL
        row.save(update_fields=["token", "expires_at"])
    claim = ActorClaim(creator_id, nonce, recovery, reclaimed)
    context = _current_claim.set(claim)
    try:
        yield claim
    finally:
        _current_claim.reset(context)
        # A stale worker cannot release a successor's ownership.
        ProducerActorClaim.objects.filter(creator_id=creator_id, token=nonce).update(
            token=None, expires_at=None
        )


@contextmanager
def fenced():
    claim = _current_claim.get()
    if claim is None:
        raise Refusal("producer_claim_required", 503)
    with claim.atomic():
        yield


def _save(instance, **kwargs):
    with fenced():
        instance.save(**kwargs)


def revoke_producers(creator_id, *, purge=False):
    """Account deletion owns the creator row, before any claim/state locks.

    No provider I/O belongs in the deletion transaction. Revoke capabilities
    and fencing ownership now; retain immutable room/operation identities so
    recovery and historical billing can still attribute and deactivate rooms.
    """
    with transaction.atomic():
        Creator.objects.select_for_update().get(pk=creator_id)
        ProducerActorClaim.objects.filter(creator_id=creator_id).update(
            token=None, expires_at=None
        )
        streams = ProducerStream.objects.filter(creator_id=creator_id)
        streams.filter(state="draft").update(
            state="ended", ended_at=Now(), version=models.F("version") + 1
        )
        streams.exclude(state__in=("ended", "ending", "cleaned_up")).update(
            state="ending", version=models.F("version") + 1
        )
        streams.update(
            token_ciphertext="",
            token_expires_at=None,
            participants=None,
            confirmed_at=None,
            next_cleanup_at=Now(),
        )
        CreatorMeeting.objects.filter(pk__in=streams.values("meeting_id")).update(
            live_now=False
        )
        if purge:
            streams.update(title="", description="")
            # Only hashes of user metadata are removed. UUID keys, action,
            # accepted version and retirement receipt are content-free proof.
            ProducerOperation.objects.filter(creator_id=creator_id).update(
                fingerprint=""
            )


def transition(stream, state):
    if state not in TRANSITIONS[stream.state]:
        raise Refusal("invalid_transition")
    stream.state = state
    stream.version += 1
    _save(stream)


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
    with fenced():
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
    _save(receipt, update_fields=["attempts"])
    provider.disable(receipt.provider_meeting_id)
    receipt.status = "complete"
    receipt.completed_at = timezone.now()
    receipt.next_attempt_at = None
    receipt.last_error = ""
    _save(
        receipt,
        update_fields=["status", "completed_at", "next_attempt_at", "last_error"],
    )


def cleanup(stream, provider):
    """Never re-create after an ambiguous create, even after an empty search."""
    if stream.cleanup_attempts >= 20:
        stream.error_code = "cleanup_manual_review"
        _save(stream)
        return
    stream.cleanup_attempts += 1
    stream.next_cleanup_at = timezone.now() + timedelta(
        seconds=min(3600, 15 * 2**stream.cleanup_attempts)
    )
    _save(stream)
    try:
        retire_previous_room(stream, provider)
        if stream.create_attempted and not stream.room_id:
            matches = provider.find(f"f2z-producer-{stream.pk}")
            if len(matches) != 1:
                raise ProviderUnavailable()
            stream.room_id = matches[0]
            _save(stream)
        if stream.room_id:
            provider.disable(str(stream.room_id))
        with fenced():
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
        _save(stream)


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
            with fenced():
                authenticate(actor, actor.pk)
                stream.refresh_from_db()
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
        with fenced():
            _save(stream)
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
                    _save(op, update_fields=["result"])
                    # Late legacy start callbacks cannot revive this room.
                    previous.handshake_managed = True
                    _save(previous, update_fields=["handshake_managed"])
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
                with fenced():
                    authenticate(actor, actor.pk)
                    stream.create_attempted = True
                    _save(stream, update_fields=["create_attempted"])
                stream.room_id = provider.create(f"f2z-producer-{stream.pk}")
                # Persist provider ID before any auth/ownership finalization.
                _save(stream)
                with fenced():
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
                    _save(
                        cm,
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
                        ],
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
                with fenced():
                    authenticate(actor, actor.pk)
                    stream.token_attempted = True
                    stream.token_ciphertext = ""
                    _save(stream)
                participant, token = provider.token(
                    str(stream.room_id), f"producer:{key}", actor
                )
                stream.participant_id = participant
                stream.token_ciphertext = cipher().encrypt(token.encode()).decode()
                stream.token_expires_at = timezone.now() + timedelta(minutes=10)
                stream.token_attempted = False
                stream.version += 1
                _save(stream)
                authenticate(actor, actor.pk)
            elif action == "publish":
                if not stream.participant_id or stream.token_attempted:
                    raise Refusal("host_ticket_required")
                session, count = provider.live(
                    str(stream.room_id), str(stream.participant_id)
                )
                with fenced():
                    authenticate(actor, actor.pk)
                    stream.session_id, stream.participants = session, count
                    stream.error_code = ""
                    stream.confirmed_at = timezone.now()
                    stream.heartbeat_at = timezone.now()
                    stream.interrupted_at = None
                    if stream.state != "live":
                        transition(stream, "live")
                    else:
                        _save(stream)
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
                _save(stream)
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
            _save(stream)
            status = exc.status if isinstance(exc, Refusal) else 503
        op.status = status
        op.result["accepted_version"] = stream.version
        _save(op)
        with fenced():
            authenticate(actor, actor.pk)
            stream.refresh_from_db()
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
    expired = list(
        ProducerActorClaim.objects.filter(token__isnull=False, expires_at__lte=Now())
        .order_by("expires_at")
        .values_list("creator_id", flat=True)[:limit]
    )
    due = list(
        ProducerStream.objects.exclude(state="cleaned_up")
        .filter(next_cleanup_at__lte=timezone.now())
        .exclude(creator_id__in=expired)
        .order_by("next_cleanup_at")
        .values_list("creator_id", flat=True)[: max(0, limit - len(expired))]
    )
    for creator_id in expired + due:
        if time.monotonic() >= deadline:
            break
        try:
            with actor_lock(creator_id, recovery=True) as claim:
                stream = (
                    ProducerStream.objects.filter(creator_id=creator_id)
                    .exclude(state="cleaned_up")
                    .first()
                )
                if stream is None:
                    continue
                if claim.reclaimed and stream.state not in (
                    "ending",
                    "ended",
                    "failed",
                ):
                    transition(stream, "ended" if stream.state == "draft" else "ending")
                    hide(stream)
                if stream.token_attempted and stream.state in (
                    "ready",
                    "live",
                    "interrupted",
                ):
                    transition(stream, "ending")
                    hide(stream)
                now = timezone.now()
                stream.next_cleanup_at = now + timedelta(seconds=15)
                _save(stream, update_fields=["next_cleanup_at"])
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
