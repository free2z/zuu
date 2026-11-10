"""Storage and rollout behavior for provider-generated meeting IDs."""
import uuid
from decimal import Decimal

import pytest
from django.db import IntegrityError, connection, transaction
from django.db.migrations.exceptions import IrreversibleError
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.loader import MigrationLoader
from django.utils import timezone

from dj.apps.dyte.models import (
    BROADCAST,
    SUBSCRIBERS_ONLY,
    LIFECYCLE_CREATE_UNKNOWN,
    CreatorMeeting,
    ProviderRoomCleanup,
)

pytestmark = pytest.mark.django_db

OLD_SCHEMA = ("dyte", "0017_merge_host_start_zero_probe")
NEW_SCHEMA = ("dyte", "0018_nullable_creator_meeting_id")


class _ProviderResponse:
    status_code = 200
    text = "ok"

    def __init__(self, payload):
        self.payload = payload

    def json(self):
        return self.payload


def test_pending_rows_use_null_and_real_room_ids_remain_unique(creator_factory):
    first = creator_factory()
    second = creator_factory()

    first_pending = CreatorMeeting.objects.create(creator=first)
    second_pending = CreatorMeeting.objects.create(creator=second)

    assert first_pending.meeting_id is None
    assert second_pending.meeting_id is None
    assert not first_pending.meeting_id and not second_pending.meeting_id
    assert not first_pending.live_now and not second_pending.live_now
    assert CreatorMeeting.objects.filter(meeting_id__isnull=True).count() == 2

    room_id = f"provider-room-{uuid.uuid4()}"
    CreatorMeeting.objects.create(creator=creator_factory(), meeting_id=room_id)
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            CreatorMeeting.objects.create(
                creator=creator_factory(), meeting_id=room_id,
            )


def test_retained_legacy_blank_does_not_block_another_creators_host_start(
    api_client, creator_factory, mocker, settings,
):
    """Exercise get_or_create and provider I/O with an old empty-string row."""
    settings.DYTE_HOST_EVICTION_JOBS_ENABLED = True
    failed_creator = creator_factory(tuzis=Decimal("1000"))
    next_creator = creator_factory(tuzis=Decimal("1000"))

    provider = mocker.MagicMock()
    provider.create_meeting.return_value = _ProviderResponse(
        {"data": {"id": f"room-{uuid.uuid4()}"}},
    )
    provider.add_participant.return_value = _ProviderResponse(
        {"data": {"token": "host-token"}},
    )
    mocker.patch("dj.apps.dyte.views.DyteClient", return_value=provider)
    mocker.patch("dj.apps.dyte.client.DyteClient", return_value=provider)

    def start(creator):
        api_client.force_authenticate(user=creator)
        return api_client.post(
            f"/api/dyte/{creator.username}/{BROADCAST}",
            {"role": "host", "host_session": str(uuid.uuid4())},
            format="json",
        )

    failed_row = CreatorMeeting.objects.create(creator=failed_creator)
    assert failed_row.meeting_id is None

    # Simulate a row produced by the previous release. Keep it in place: a
    # new producer must be able to insert its own row alongside the legacy ''
    # value, without waiting for migration or deleting pending state.
    CreatorMeeting.objects.filter(pk=failed_row.pk).update(meeting_id="")
    legacy_row = CreatorMeeting.objects.get(pk=failed_row.pk)

    response = start(next_creator)

    assert response.status_code == 200, response.data
    legacy_row.refresh_from_db()
    assert legacy_row.meeting_id == ""
    new_row = CreatorMeeting.objects.get(creator=next_creator)
    assert new_row.meeting_id == response.data["meeting_id"]
    assert new_row.meeting_id
    assert provider.create_meeting.call_count == 1
    assert provider.add_participant.call_count == 1
    assert provider.add_participant.call_args.args[1] == new_row.meeting_id


@pytest.mark.django_db(transaction=True)
def test_migration_normalizes_only_blank_id_and_preserves_lifecycle_and_cleanup(
    creator_factory,
):
    """Normalize the legacy sentinel without losing either row's evidence."""
    creator = creator_factory(username=f"dyte-migration-{uuid.uuid4().hex[:8]}")
    executor = MigrationExecutor(connection)
    executor.migrate([OLD_SCHEMA])
    old_apps = MigrationExecutor(connection).loader.project_state([OLD_SCHEMA]).apps
    OldCreatorMeeting = old_apps.get_model("dyte", "CreatorMeeting")
    OldProviderRoomCleanup = old_apps.get_model("dyte", "ProviderRoomCleanup")

    pending_claim = uuid.uuid4()
    pending_start = uuid.uuid4()
    blank_pk = OldCreatorMeeting.objects.create(
        creator_id=creator.pk,
        meeting_id="",
        meeting_type=BROADCAST,
        lifecycle_state=LIFECYCLE_CREATE_UNKNOWN,
        create_unknown_title="title preserved for reconciliation",
        host_start_claim=pending_claim,
        host_start_claim_at=timezone.now(),
        provider_room_cleanup_claimed=True,
        host_evictions=[{"meeting_id": "", "participant_id": "host-old"}],
    ).pk
    real_id = f"existing-provider-room-{uuid.uuid4()}"
    real_session = uuid.uuid4()
    real_pk = OldCreatorMeeting.objects.create(
        creator_id=creator.pk,
        meeting_id=real_id,
        meeting_type=SUBSCRIBERS_ONLY,
        lifecycle_state="live",
        live_now=True,
        provider_session_id=real_session,
    ).pk
    cleanup_id = OldProviderRoomCleanup.objects.create(
        creator_meeting_id=blank_pk,
        creator_id=creator.pk,
        meeting_type=BROADCAST,
        provider_title="title preserved for reconciliation",
        start_id=pending_start,
        status="manual_review",
        last_error="create response was lost",
    ).pk

    try:
        MigrationExecutor(connection).migrate([NEW_SCHEMA])

        blank = CreatorMeeting.objects.get(pk=blank_pk)
        real = CreatorMeeting.objects.get(pk=real_pk)
        cleanup = ProviderRoomCleanup.objects.get(pk=cleanup_id)
        assert blank.meeting_id is None
        # Prior readers' `if not cm.meeting_id` checks continue to recognize
        # both NULL and the old empty-string sentinel as pending.
        assert not blank.meeting_id
        assert blank.lifecycle_state == LIFECYCLE_CREATE_UNKNOWN
        assert blank.create_unknown_title == "title preserved for reconciliation"
        assert blank.host_start_claim == pending_claim
        assert blank.provider_room_cleanup_claimed is True
        assert blank.host_evictions == [
            {"meeting_id": "", "participant_id": "host-old"},
        ]
        assert real.meeting_id == real_id
        assert real.provider_session_id == real_session
        assert real.lifecycle_state == "live"
        assert real.live_now is True
        assert cleanup.creator_meeting_id == blank_pk
        assert cleanup.provider_meeting_id is None
        assert cleanup.start_id == pending_start
        assert cleanup.status == "manual_review"
        assert cleanup.last_error == "create response was lost"

        # Reverse must fail before it changes the nullable schema or data.
        with pytest.raises(IrreversibleError):
            MigrationExecutor(connection).migrate([OLD_SCHEMA])
        assert CreatorMeeting.objects.get(pk=blank_pk).meeting_id is None
        assert CreatorMeeting.objects.get(pk=real_pk).meeting_id == real_id
    finally:
        MigrationExecutor(connection).migrate(
            MigrationLoader(connection).graph.leaf_nodes(),
        )
