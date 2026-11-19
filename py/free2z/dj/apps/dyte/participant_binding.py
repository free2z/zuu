"""Bind provider participants to server-authorized actors, never display names."""
from dataclasses import dataclass
import uuid

from django.conf import settings
from django.db import DatabaseError, transaction

from .client import AUTH_MODE_V4, DyteClient, ProviderInvalidResponse, resolve_auth_mode
from .models import ProviderParticipantBinding


class ParticipantIdentityUnproven(Exception):
    """Retry without claiming a delivery or guessing a financial actor."""


@dataclass(frozen=True)
class ParticipantIdentity:
    participant_id: uuid.UUID
    role: str
    actor_id: int | None
    start_claim: uuid.UUID | None = None
    bound: bool = False


def current_provider_app_id():
    """Use the same effective app/organization as the control-plane client."""
    value = settings.RTK_APP_ID if resolve_auth_mode() == AUTH_MODE_V4 else settings.DYTE_ORG
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError, AttributeError) as exc:
        raise ParticipantIdentityUnproven('provider_app_identity_unavailable') from exc


def bind_participant(*, meeting_id, participant_id, creator_id, actor_id,
        role, custom_id, start_claim=None):
    try:
        if (not isinstance(meeting_id, (str, uuid.UUID)) or not 1 <= len(str(meeting_id)) <= 64
                or not isinstance(participant_id, (str, uuid.UUID)) or not 1 <= len(str(participant_id)) <= 128):
            raise ValueError('missing provider identity')
        key = {'app_id': current_provider_app_id(),
            'meeting_id': str(meeting_id), 'participant_id': str(participant_id)}
    except (ValueError, TypeError, AttributeError) as exc:
        raise ProviderInvalidResponse() from exc
    values = {'creator_id': creator_id, 'actor_id': actor_id, 'role': role,
        'custom_participant_id': custom_id, 'start_claim': start_claim}
    try:
        with transaction.atomic():
            binding, created = ProviderParticipantBinding.objects.get_or_create(**key, defaults=values)
            if not created and any(getattr(binding, field) != value for field, value in values.items()):
                raise ParticipantIdentityUnproven('provider_participant_binding_conflict')
    except DatabaseError as exc:
        raise ParticipantIdentityUnproven('provider_participant_binding_unavailable') from exc
    return binding


def resolve_participant(event_data, cm):
    """Read the signed callback's exact session/peer before acquiring DB locks."""
    participant = event_data.participant
    evidence = DyteClient().get_session_participant(event_data.meeting.sessionId, participant.peerId)
    if evidence['custom_participant_id'] != participant.customParticipantId:
        raise ParticipantIdentityUnproven('provider_participant_evidence_mismatch')
    canonical = evidence['user_id']
    binding = ProviderParticipantBinding.objects.filter(
        app_id=current_provider_app_id(), meeting_id=event_data.meeting.id,
        participant_id=canonical).first()
    if binding is not None:
        if (binding.creator_id != cm.creator_id
                or binding.custom_participant_id != participant.customParticipantId
                or binding.role != evidence['role']):
            raise ParticipantIdentityUnproven('provider_participant_binding_mismatch')
        return ParticipantIdentity(canonical, binding.role, binding.actor_id, binding.start_claim, True)
    # Pre-binding host tokens may leave without becoming a financial actor.
    # Their provider role cannot establish a new host-start generation.
    if evidence['role'] == 'host':
        known = str(canonical) == cm.host_participant_id or any(
            row.get('participant_id') == str(canonical)
            and row.get('meeting_id') == str(event_data.meeting.id)
            for row in cm.host_evictions)
        if not known:
            raise ParticipantIdentityUnproven('legacy_host_binding_unavailable')
        return ParticipantIdentity(canonical, 'host', cm.creator_id)
    identity = participant.customParticipantId
    if identity.startswith(('host_', 'ea_', 'pc_', 'ph_')):
        raise ParticipantIdentityUnproven('legacy_participant_identity_ambiguous')
    # The compatibility path keeps the existing ordinary username semantics.
    # New mints always carry the durable actor binding above, including guests.
    from dj.apps.g12f.models import Creator
    actor_id = Creator.objects.filter(username=identity).values_list('pk', flat=True).first()
    if actor_id is None and cm.meeting_type == 'ppv':
        raise ParticipantIdentityUnproven('legacy_participant_actor_unavailable')
    return ParticipantIdentity(canonical, 'viewer', actor_id)
