"""Committed provider evidence survives financial refusal and has bounded recovery."""
import io
import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from unittest.mock import patch

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError, close_old_connections, connection, transaction
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.dyte.credit_recovery import attempt_observation, recover_credit_observations
from dj.apps.dyte.models import PpvCreditAdmission, PpvCreditDelivery, PpvCreditObservation, WebhookDelivery
from dj.apps.dyte.test_host_seat import provider as provider
from dj.apps.dyte.test_ppv_host_lifecycle import go_live, viewer_join
from dj.apps.dyte.test_webhook_idempotency import _post, keypair as keypair, webhook_boundaries as webhook_boundaries
from dj.apps.economy.models import EconomicPolicy
from dj.apps.economy.tests.test_foundation import activate_for_test, sql
from dj.apps.economy.tests.test_integration import reset_isolated_policy as reset_isolated_policy
from dj.apps.events.models import Event
from dj.apps.jobs.models import OperatorAction, OutboxMessage
from dj.apps.ledger.models import Transfer

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.usefixtures('reset_isolated_policy')]


def credit_cap(amount):
    sql('ALTER TABLE economy_economicpolicy DISABLE TRIGGER economy_policy_guard')
    try:
        EconomicPolicy.objects.update(account_daily_limit_m2z=amount)
    finally:
        sql('ALTER TABLE economy_economicpolicy ENABLE TRIGGER economy_policy_guard')


@pytest.fixture
def refused_delivery(api_client, creator_factory, provider, keypair, settings):
    settings.DYTE_HOST_EVICTION_JOBS_ENABLED = True
    host, viewer = creator_factory(tuzis=1000), creator_factory(tuzis=1000)
    with transaction.atomic():
        activate_for_test()
    _, meeting, _, _ = go_live(api_client, host, provider, keypair)
    assert viewer_join(api_client, viewer, host).status_code == 200
    admission = PpvCreditAdmission.objects.get()
    body = json.dumps({'event':'meeting.participantLeft','meeting':meeting,'participant':{
        'peerId':str(uuid.uuid4()),'userDisplayName':'unnecessary display value',
        'customParticipantId':'pc_'+admission.pk.hex,'joinedAt':admission.admitted_at.isoformat(),
        'leftAt':timezone.now().isoformat()}}).encode()
    event_id = uuid.uuid4()
    before = (Transfer.objects.count(), Event.objects.count(), OutboxMessage.objects.count())
    credit_cap(1_001_000)
    assert not connection.in_atomic_block
    api_client.raise_request_exception = False
    try:
        response = _post(api_client, keypair[0], body, event_id, drain=False)
    finally:
        api_client.raise_request_exception = True
    assert response.status_code == 500
    assert not connection.in_atomic_block
    # Independent connection proves the view committed evidence before failing.
    other = connection.Database.connect(**connection.get_connection_params())
    try:
        with other.cursor() as cursor:
            cursor.execute('SELECT provider_key,evidence,attempts,completed_at FROM dyte_ppvcreditobservation')
            rows = cursor.fetchall()
        assert len(rows) == 1 and rows[0][2:] == (1,None)
    finally:
        other.close()
    observation = PpvCreditObservation.objects.get()
    assert 'unnecessary display value' not in json.dumps(observation.evidence)
    assert not WebhookDelivery.objects.filter(pk=event_id).exists()
    assert not PpvCreditDelivery.objects.exists()
    assert (Transfer.objects.count(), Event.objects.count(), OutboxMessage.objects.count()) == before
    host.refresh_from_db(); viewer.refresh_from_db()
    assert host.tuzis == viewer.tuzis == 1000
    return observation, host, viewer, body, event_id


def ready(observation):
    credit_cap(10_000_000)
    PpvCreditObservation.objects.filter(pk=observation.pk).update(next_retry_at=timezone.now()-timedelta(seconds=1))


def assert_once(observation, host, viewer):
    observation.refresh_from_db(); host.refresh_from_db(); viewer.refresh_from_db()
    assert observation.completed_at is not None
    assert host.tuzis == 1003 and viewer.tuzis == 997
    assert PpvCreditDelivery.objects.count() == 1
    assert WebhookDelivery.objects.filter(pk=observation.evidence['provider_event_id']).count() == 1
    assert Event.objects.filter(type='PAY_PER_VIEW_REVENUE', receiving_user=host, amount=3).count() == 1
    assert Event.objects.filter(type='PAY_PER_VIEW_SPEND', receiving_user=viewer, amount=3).count() == 1
    ids = Event.objects.filter(type__in=['PLATFORM_FEE','PAY_PER_VIEW_SPEND','PAY_PER_VIEW_REVENUE']).values_list('pk',flat=True)
    assert OutboxMessage.objects.filter(dedup_key__in=[f'event:{pk}' for pk in ids]).count() == 3


def test_committed_cap_refusal_recovers_without_provider_callback(refused_delivery, mocker):
    observation, host, viewer, _, _ = refused_delivery
    original = dict(observation.evidence)
    ready(observation)
    provider_read = mocker.patch('dj.apps.dyte.participant_binding.DyteClient', side_effect=AssertionError('no provider recovery read'))
    assert recover_credit_observations() == 1
    assert recover_credit_observations() == 0
    assert_once(observation, host, viewer)
    assert observation.evidence == original
    provider_read.assert_not_called()


def test_callback_and_recovery_race_posts_once(refused_delivery, keypair):
    observation, host, viewer, body, event_id = refused_delivery
    ready(observation)
    barrier = Barrier(2)
    def run(kind):
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            if kind == 'callback':
                return _post(APIClient(),keypair[0],body,uuid.uuid4(),drain=False).status_code
            return 200 if attempt_observation(observation.pk) else 503
        finally:
            connection.close()
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(run,['callback','recovery'])) == [200,200]
    assert_once(observation,host,viewer)
    assert str(observation.evidence['provider_event_id']) == str(event_id)


def test_exhausted_evidence_is_retained_observable_and_explicitly_replayable(refused_delivery, caplog):
    observation, host, viewer, _, _ = refused_delivery
    PpvCreditObservation.objects.filter(pk=observation.pk).update(attempts=11,next_retry_at=timezone.now())
    assert recover_credit_observations() == 1
    observation.refresh_from_db()
    assert observation.attempts == 12 and observation.review_required_at is not None
    assert 'ppv_credit_recovery_required' in caplog.text
    assert recover_credit_observations() == 0
    future = timezone.now() + timedelta(hours=2)
    with patch('dj.apps.dyte.credit_recovery.timezone.now',return_value=future):
        recover_credit_observations()
    assert '"reason": "stuck"' in caplog.text
    before = PpvCreditObservation.objects.values().get(pk=observation.pk)
    output = io.StringIO()
    call_command('ppv_credit_recovery',key=observation.pk,stdout=output)
    assert json.loads(output.getvalue())['executed'] is False
    assert PpvCreditObservation.objects.values().get(pk=observation.pk) == before
    with pytest.raises(CommandError,match='execution requires'):
        call_command('ppv_credit_recovery',key=observation.pk,execute=True,reason='reviewed')
    ready(observation)
    call_command('ppv_credit_recovery',key=observation.pk,execute=True,money=True,
        reason='isolated fixture reviewed',stdout=io.StringIO())
    assert_once(observation,host,viewer)
    assert OperatorAction.objects.filter(verb='ppv_credit_retry',reason__contains=observation.pk).count() == 1


def test_observation_evidence_and_completion_are_guarded(refused_delivery):
    observation, _, _, _, _ = refused_delivery
    for changes in ({'evidence':{}},{'created_at':timezone.now()}, {'completed_at':timezone.now()}):
        with pytest.raises(DatabaseError), transaction.atomic():
            PpvCreditObservation.objects.filter(pk=observation.pk).update(**changes)
    with pytest.raises(DatabaseError,match='retained'), transaction.atomic():
        PpvCreditObservation.objects.filter(pk=observation.pk).delete()
    with pytest.raises(DatabaseError,match='original bound'), transaction.atomic():
        PpvCreditObservation.objects.create(provider_key='a'*64,admission_id=observation.admission_id,
            evidence=dict(observation.evidence,binding_id=99999999))


def test_unsigned_callback_cannot_capture_or_change_recovery(refused_delivery, api_client, mocker):
    from cryptography.hazmat.primitives.asymmetric import rsa
    observation, _, _, body, _ = refused_delivery
    original = PpvCreditObservation.objects.values().get(pk=observation.pk)
    provider_read = mocker.patch('dj.apps.dyte.views.resolve_participant')
    forged = rsa.generate_private_key(public_exponent=65537,key_size=2048)
    assert _post(api_client,forged,body,uuid.uuid4(),drain=False).status_code == 400
    assert PpvCreditObservation.objects.count() == 1
    assert PpvCreditObservation.objects.values().get(pk=observation.pk) == original
    provider_read.assert_not_called()


def test_conflicting_provider_uuid_cannot_claim_another_business_event(refused_delivery):
    observation, host, viewer, _, _ = refused_delivery
    WebhookDelivery.objects.create(provider_event_id=observation.evidence['provider_event_id'],
        endpoint='general',event_type='meeting.participantLeft',payload_sha256='f'*64,business_event_key='f'*64)
    ready(observation)
    assert attempt_observation(observation.pk) is False
    observation.refresh_from_db()
    assert observation.last_error == 'claim_conflict' and observation.completed_at is None
    assert not PpvCreditDelivery.objects.exists()
    host.refresh_from_db(); viewer.refresh_from_db()
    assert host.tuzis == viewer.tuzis == 1000


@pytest.mark.parametrize('failed', ['recording','ppv_credit'])
def test_recovery_branches_continue_independently(mocker, caplog, failed):
    from dj.apps.dyte.tasks import recover_recording_deliveries
    recording = mocker.patch('dj.apps.dyte.tasks._recover_recording_deliveries')
    credit = mocker.patch('dj.apps.dyte.credit_recovery.recover_credit_observations')
    (recording if failed == 'recording' else credit).side_effect = RuntimeError('synthetic recovery failure')
    with pytest.raises(RuntimeError,match='synthetic recovery failure'):
        recover_recording_deliveries(0)
    recording.assert_called_once_with(); credit.assert_called_once_with()
    if failed == 'ppv_credit':
        assert 'ppv_credit_recovery_required' in caplog.text
