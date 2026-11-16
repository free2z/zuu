"""Prospective PPV shares platform credits without creating cash obligations."""
import pytest

from dj.apps.dyte.test_host_seat import _start, provider as provider
from dj.apps.economy.models import CreatorPayable, PayableJournal, ServiceAdmission
from dj.apps.economy.tests.test_foundation import activate_for_test

pytestmark = pytest.mark.django_db


def test_host_can_start_credit_ppv_without_payee_or_compensation_agreement(
        api_client, creator_factory, provider, settings):
    settings.DYTE_HOST_EVICTION_JOBS_ENABLED = True
    host = creator_factory(tuzis=1000)
    activate_for_test()
    response = _start(api_client, host, meeting_type='ppv', price_per_minute='3.00')
    assert response.status_code == 200, response.data
    assert provider.add_participant.call_count == 1
    assert not CreatorPayable.objects.exists()
    assert not ServiceAdmission.objects.exists()
    assert not PayableJournal.objects.exists()

import json
import uuid
from datetime import timedelta
from decimal import Decimal
from django.db import DatabaseError, transaction
from django.utils import timezone
from dj.apps.dyte.models import CreatorMeeting, PpvCreditAdmission, PpvCreditDelivery, WebhookDelivery
from dj.apps.dyte.participant_binding import bind_participant
from dj.apps.dyte.ppv_credits import prepare_credit_admission, settle_credit_delivery
from dj.apps.dyte.test_ppv_host_lifecycle import go_live, viewer_join
from dj.apps.dyte.test_webhook_idempotency import _post, keypair as keypair, webhook_boundaries as webhook_boundaries
from dj.apps.economy.models import EconomicPolicy
from dj.apps.economy.services import EconomicRefusal
from dj.apps.economy.tests.test_foundation import sql
from dj.apps.ledger import api as usage
from dj.apps.ledger.tests.test_spend_and_credit import in_debt


def elapsed_admission(admission, instant):
    """Test DB owner models elapsed service without sleeping or changing shipping clocks."""
    sql('SET CONSTRAINTS ALL IMMEDIATE')
    table = admission._meta.db_table
    trigger = 'dyte_ppv_credit_admission_immutable' if isinstance(admission, PpvCreditAdmission) else 'economy_admission_immutable'
    sql(f'ALTER TABLE {table} DISABLE TRIGGER {trigger}')
    try:
        type(admission).objects.filter(pk=admission.pk).update(admitted_at=instant)
    finally:
        sql(f'ALTER TABLE {table} ENABLE TRIGGER {trigger}')
    admission.refresh_from_db()


def new_admission(host, viewer, meeting, key=None):
    return prepare_credit_admission(host_id=host.pk, viewer_id=viewer.pk,
        meeting_id=meeting.meeting_id, price_per_minute=meeting.price_per_minute,
        idempotency_key=key or uuid.uuid4(), viewer_account_epoch=viewer.kt_account_epoch)


def credit_fixture(factory, *, balance=100, price='1.23'):
    host, viewer = factory(tuzis=0), factory(tuzis=balance)
    with transaction.atomic():
        activate_for_test()
    started = timezone.now() - timedelta(hours=1)
    session = uuid.uuid4()
    meeting = CreatorMeeting.objects.create(creator=host, meeting_id=str(uuid.uuid4()),
        meeting_type='ppv', is_public=True, live_now=True, lifecycle_state='live',
        provider_session_id=session, provider_session_started_at=started,
        host_session_id=uuid.uuid4(), host_session_seen_at=timezone.now(),
        host_peer_id=uuid.uuid4(), host_joined_at=started, host_participant_id='synthetic-host',
        host_presence_participant_id='synthetic-host', host_presence_session_id=session,
        host_presence_session_started_at=started, price_per_minute=price)
    admission = new_admission(host, viewer, meeting)
    elapsed_admission(admission, started)
    binding = bind_participant(meeting_id=meeting.meeting_id, participant_id=str(uuid.uuid4()),
        creator_id=host.pk, actor_id=viewer.pk, role='viewer', custom_id='pc_'+admission.pk.hex)
    return host, viewer, meeting, admission, binding


def evidence_for(admission, binding, *, seconds=61, joined=None):
    key = uuid.uuid4().hex*2
    left = timezone.now()
    joined = joined or left-timedelta(seconds=seconds)
    event = WebhookDelivery.objects.create(provider_event_id=uuid.uuid4(), endpoint='general',
        event_type='meeting.participantLeft', business_event_key=key, payload_sha256=key)
    return key, {'provider_event_id': str(event.pk), 'payload_sha256': key,
        'meeting_id': admission.meeting_id, 'provider_session_id': str(admission.provider_session_id),
        'provider_session_started_at': admission.provider_session_started_at.isoformat(),
        'participant_id': 'pc_'+admission.pk.hex, 'canonical_participant_id': binding.participant_id,
        'binding_id': binding.pk, 'peer_id': str(uuid.uuid4()),
        'joined_at': joined.isoformat(), 'left_at': left.isoformat()}


def settle(admission, binding, **kwargs):
    key, evidence = evidence_for(admission, binding, **kwargs)
    return settle_credit_delivery(admission_id=admission.pk, event_key=key, evidence=evidence), evidence


@pytest.mark.parametrize('seconds,platform,creator', [(1,0,2),(60,0,2),(61,1,3),(120,1,3),(121,1,4)])
def test_actual_credit_settlement_preserves_rounding_and_conservation(creator_factory, seconds, platform, creator):
    host, viewer, _, admission, binding = credit_fixture(creator_factory)
    delivery, evidence = settle(admission, binding, seconds=seconds)
    host.refresh_from_db(); viewer.refresh_from_db()
    assert host.tuzis == creator and viewer.tuzis == 100-platform-creator
    assert delivery.platform_collected_m2z == platform*1000
    assert delivery.creator_collected_m2z == delivery.creator_credited_m2z == creator*1000
    assert delivery.creator_debt_repaid_m2z == 0
    assert not CreatorPayable.objects.exists() and not PayableJournal.objects.exists()
    assert not ServiceAdmission.objects.exists()
    assert settle_credit_delivery(admission_id=admission.pk, event_key=delivery.provider_key, evidence=evidence).pk == delivery.pk
    assert PpvCreditDelivery.objects.count() == 1


@pytest.mark.parametrize('condition,platform,creator', [('partial',1000,1500),('held',1000,500),('frozen',0,0),('debt',0,0)])
def test_actual_credit_settlement_clamps_collectible_balance(creator_factory, condition, platform, creator):
    host, viewer, _, admission, binding = credit_fixture(creator_factory, balance=Decimal('2.5'))
    if condition == 'held':
        sql("UPDATE ledger_account SET held=1000 WHERE owner_id=%s AND kind='user'", [viewer.pk])
    elif condition == 'frozen':
        sql("UPDATE ledger_account SET frozen=true WHERE owner_id=%s AND kind='user'", [viewer.pk])
    elif condition == 'debt':
        in_debt(viewer, 1000)
    delivery, _ = settle(admission, binding)
    assert delivery.platform_collected_m2z == platform
    assert delivery.creator_collected_m2z == creator
    host.refresh_from_db(); assert host.tuzis == Decimal(creator)/1000
    assert not PayableJournal.objects.exists()


def test_host_debt_is_repaid_by_shared_credits(creator_factory):
    host, _, _, admission, binding = credit_fixture(creator_factory)
    in_debt(host, 1500)
    delivery, _ = settle(admission, binding)
    assert delivery.creator_collected_m2z == 3000
    assert delivery.creator_credited_m2z == delivery.creator_debt_repaid_m2z == 1500
    assert delivery.evidence['repay_transfer_id'] is not None
    assert usage.debt_m2z(host.pk) == 0
    host.refresh_from_db(); assert host.tuzis == Decimal('1.5')


def test_recipient_daily_cap_rolls_back_collection_and_delivery(creator_factory):
    host, viewer, _, admission, binding = credit_fixture(creator_factory)
    sql('ALTER TABLE economy_economicpolicy DISABLE TRIGGER economy_policy_guard')
    try:
        EconomicPolicy.objects.update(account_daily_limit_m2z=2000)
    finally:
        sql('ALTER TABLE economy_economicpolicy ENABLE TRIGGER economy_policy_guard')
    with pytest.raises(DatabaseError, match='usage_daily_funding_limit'), transaction.atomic():
        settle(admission, binding)
    host.refresh_from_db(); viewer.refresh_from_db()
    assert host.tuzis == 0 and viewer.tuzis == 100
    assert not PpvCreditDelivery.objects.exists() and not WebhookDelivery.objects.exists()


@pytest.mark.parametrize('field,value', [('live_now',False), ('host_left_at','now'),
    ('host_session_seen_at',None), ('host_start_claim','uuid'), ('host_presence_session_id','uuid')])
def test_credit_admission_keeps_host_presence_guards(creator_factory, field, value):
    host, viewer, meeting, _, _ = credit_fixture(creator_factory)
    value = timezone.now() if value == 'now' else uuid.uuid4() if value == 'uuid' else value
    CreatorMeeting.objects.filter(pk=meeting.pk).update(**{field:value})
    with pytest.raises(EconomicRefusal, match='livestream_offer_unavailable'):
        new_admission(host, viewer, meeting)
    assert PpvCreditAdmission.objects.count() == 1


def test_retry_never_mints_second_credit_admission(creator_factory):
    host, viewer, meeting, admission, _ = credit_fixture(creator_factory)
    with pytest.raises(EconomicRefusal, match='livestream_provider_outcome_unknown'):
        new_admission(host, viewer, meeting, key=admission.idempotency_key)
    assert PpvCreditAdmission.objects.count() == 1


@pytest.mark.parametrize('changed_offer', [False, True])
def test_historical_cash_join_key_cannot_mint_credit_participant(
        api_client, creator_factory, provider, keypair, settings, changed_offer):
    from dj.apps.economy.tests.historical_ppv import prepare_historical_ppv_admission
    from dj.apps.economy.tests.test_integration import service_terms
    settings.DYTE_HOST_EVICTION_JOBS_ENABLED = True
    host, viewer = creator_factory(tuzis=1000), creator_factory(tuzis=1000)
    activate_for_test()
    cm, _, _, _ = go_live(api_client, host, provider, keypair)
    service_terms(host, 'livestream_ppv')
    key = uuid.uuid4()
    cash = prepare_historical_ppv_admission(host_id=host.pk, viewer_id=viewer.pk,
        meeting_id=cm.meeting_id, price_per_minute=cm.price_per_minute,
        idempotency_key=str(key), viewer_account_epoch=viewer.kt_account_epoch)
    original_cash = ServiceAdmission.objects.values().get(pk=cash.pk)
    if changed_offer:
        CreatorMeeting.objects.filter(pk=cm.pk).update(price_per_minute='4.00')
    provider.add_participant.reset_mock()
    api_client.force_authenticate(user=viewer)
    response = api_client.post(f'/api/dyte/{host.username}/ppv', {
        'role':'viewer', 'expected_actor_id':viewer.pk,
        'admission_idempotency_key':str(key)}, format='json')
    assert response.status_code == 409
    assert response.data['code'] == ('livestream_admission_identity_conflict'
        if changed_offer else 'livestream_provider_outcome_unknown')
    provider.add_participant.assert_not_called()
    assert not PpvCreditAdmission.objects.exists()
    assert ServiceAdmission.objects.values().get(pk=cash.pk) == original_cash


def test_direct_credit_admission_cannot_reuse_historical_cash_key(creator_factory):
    host, viewer, meeting, credit, _ = credit_fixture(creator_factory)
    cash = historical_cash(host, viewer, meeting)
    fields = PpvCreditAdmission.objects.values().get(pk=credit.pk)
    fields.update(id=uuid.uuid4(), idempotency_key=uuid.UUID(cash.event_id.rsplit(':',1)[-1]))
    with pytest.raises(DatabaseError, match='key already belongs to historical cash'), transaction.atomic():
        PpvCreditAdmission.objects.create(**fields)
    assert PpvCreditAdmission.objects.count() == 1


def test_signed_delivery_uses_original_bound_credit_actor_after_room_replacement(
        api_client, creator_factory, provider, keypair, settings):
    settings.DYTE_HOST_EVICTION_JOBS_ENABLED = True
    host, viewer = creator_factory(tuzis=1000), creator_factory(tuzis=1000)
    activate_for_test()
    cm, meeting, _, _ = go_live(api_client, host, provider, keypair)
    response = viewer_join(api_client, viewer, host)
    assert response.status_code == 200, response.data
    admission = PpvCreditAdmission.objects.get()
    assert provider.add_participant.call_args.kwargs['custom_participant_id'] == 'pc_'+admission.pk.hex
    CreatorMeeting.objects.filter(pk=cm.pk).update(meeting_id=str(uuid.uuid4()), provider_session_id=uuid.uuid4())
    body = json.dumps({'event':'meeting.participantLeft', 'meeting':meeting,
        'participant':{'peerId':str(uuid.uuid4()),'userDisplayName':'irrelevant',
        'customParticipantId':'pc_'+admission.pk.hex,'joinedAt':admission.admitted_at.isoformat(),
        'leftAt':timezone.now().isoformat()}}).encode()
    event_id = uuid.uuid4()
    assert _post(api_client,keypair[0],body,event_id,drain=False).status_code == 200
    assert _post(api_client,keypair[0],body,event_id,drain=False).status_code == 200
    assert _post(api_client,keypair[0],body,uuid.uuid4(),drain=False).status_code == 200
    host.refresh_from_db(); viewer.refresh_from_db()
    assert host.tuzis == 1003 and viewer.tuzis == 997
    assert PpvCreditDelivery.objects.count() == 1
    from dj.apps.events.models import Event
    assert Event.objects.filter(type='PAY_PER_VIEW_REVENUE', receiving_user=host, amount=3).count() == 1
    assert Event.objects.filter(type='PAY_PER_VIEW_SPEND', receiving_user=viewer, amount=3).count() == 1
    assert not CreatorPayable.objects.exists() and not PayableJournal.objects.exists()


@pytest.mark.parametrize('malformed', ['binding_id','canonical_participant_id','meeting_id','provider_session_id','payload_sha256'])
def test_unproven_credit_delivery_rolls_back_every_ledger_leg(creator_factory, malformed):
    host, viewer, _, admission, binding = credit_fixture(creator_factory)
    key, evidence = evidence_for(admission,binding)
    evidence[malformed] = 999999999 if malformed=='binding_id' else str(uuid.uuid4())
    with pytest.raises(DatabaseError), transaction.atomic():
        settle_credit_delivery(admission_id=admission.pk,event_key=key,evidence=evidence)
    host.refresh_from_db(); viewer.refresh_from_db()
    assert host.tuzis == 0 and viewer.tuzis == 100
    assert not PpvCreditDelivery.objects.exists()


def test_credit_receipts_and_admissions_are_immutable(creator_factory):
    _, _, _, admission, binding = credit_fixture(creator_factory)
    delivery, _ = settle(admission,binding)
    for model, row, changes in [(PpvCreditAdmission,admission,{'price_per_minute':'2.00'}),
            (PpvCreditDelivery,delivery,{'creator_collected_m2z':0})]:
        with pytest.raises(DatabaseError,match='immutable'), transaction.atomic():
            model.objects.filter(pk=row.pk).update(**changes)
        with pytest.raises(DatabaseError,match='immutable'), transaction.atomic():
            sql(f'DELETE FROM {model._meta.db_table} WHERE id=%s', [row.pk])


def historical_cash(host, viewer, meeting):
    from dj.apps.economy.tests.historical_ppv import prepare_historical_ppv_admission
    from dj.apps.economy.tests.test_integration import service_terms
    service_terms(host,'livestream_ppv')
    return prepare_historical_ppv_admission(host_id=host.pk,viewer_id=viewer.pk,
        meeting_id=meeting.meeting_id,price_per_minute=meeting.price_per_minute,
        idempotency_key=str(uuid.uuid4()),viewer_account_epoch=viewer.kt_account_epoch)


@pytest.mark.parametrize('first', ['credit','historical_cash'])
def test_cash_and_credit_overlap_cannot_collect_in_either_arrival_order(creator_factory, first):
    from dj.apps.economy.products import settle_livestream_delivery
    host, viewer, meeting, credit, binding = credit_fixture(creator_factory)
    cash = historical_cash(host,viewer,meeting)
    key, evidence = evidence_for(credit,binding,joined=cash.admitted_at)
    cash_key = uuid.uuid4().hex*2
    cash_event = WebhookDelivery.objects.create(provider_event_id=uuid.uuid4(), endpoint='general',
        event_type='meeting.participantLeft',business_event_key=cash_key,payload_sha256=cash_key)
    cash_evidence = dict(evidence,provider_event_id=str(cash_event.pk),payload_sha256=cash_key,
        participant_id='ea_'+cash.pk.hex)
    def settle_cash():
        return settle_livestream_delivery(admission_id=cash.pk,event_key=cash_key,evidence=cash_evidence)
    def settle_credit():
        return settle_credit_delivery(admission_id=credit.pk,event_key=key,evidence=evidence)
    first_call, second_call = (settle_credit,settle_cash) if first=='credit' else (settle_cash,settle_credit)
    original = first_call()
    with pytest.raises(DatabaseError,match='overlap'), transaction.atomic():
        second_call()
    assert first_call().pk == original.pk
    host.refresh_from_db(); viewer.refresh_from_db()
    assert viewer.tuzis == 98
    assert host.tuzis == (2 if first=='credit' else 0)
    assert PpvCreditDelivery.objects.count() == (first=='credit')
    assert PayableJournal.objects.count() == (first=='historical_cash')


def test_new_cash_ppv_admission_is_refused_without_mutating_historical_receipt(creator_factory):
    from dj.apps.economy import products
    host, viewer, meeting, _, _ = credit_fixture(creator_factory)
    old = historical_cash(host,viewer,meeting)
    original = ServiceAdmission.objects.values().get(pk=old.pk)
    # Reusing old adapters/current contracts cannot create fresh cash claims.
    with pytest.raises(EconomicRefusal,match='compensation_schedule_unavailable'):
        products.prepare_livestream_admission(host_id=host.pk,viewer_id=viewer.pk,
            meeting_id=meeting.meeting_id,price_per_minute=meeting.price_per_minute,
            idempotency_key=str(uuid.uuid4()),viewer_account_epoch=viewer.kt_account_epoch)
    values = {f.attname:getattr(old,f.attname) for f in old._meta.fields}
    values.update(id=uuid.uuid4(),event_id='another-new-cash-join')
    with pytest.raises(DatabaseError,match='new_ppv_requires_credit_admission'), transaction.atomic():
        ServiceAdmission.objects.create(**values)
    assert ServiceAdmission.objects.values().get(pk=old.pk) == original


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('second_kind', ['credit', 'historical_cash'])
def test_concurrent_deliveries_collect_overlap_once(creator_factory, request, second_kind):
    from concurrent.futures import ThreadPoolExecutor
    import threading
    from django.db import close_old_connections, connection
    # Same reset used by the existing real-PG transactional economy suite.
    request.getfixturevalue('reset_isolated_policy')
    host, viewer, meeting, first, binding = credit_fixture(creator_factory)
    second = (new_admission(host,viewer,meeting) if second_kind=='credit'
        else historical_cash(host,viewer,meeting))
    second_binding = bind_participant(meeting_id=meeting.meeting_id,participant_id=str(uuid.uuid4()),
        creator_id=host.pk,actor_id=viewer.pk,role='viewer',custom_id='pc_'+second.pk.hex)
    joined = second.admitted_at
    first_key, first_evidence = evidence_for(first,binding,joined=joined)
    second_key, second_evidence = evidence_for(first,binding,joined=joined)
    second_evidence.update(participant_id=('pc_' if second_kind=='credit' else 'ea_')+second.pk.hex,
        binding_id=second_binding.pk, canonical_participant_id=second_binding.participant_id)
    work = [(first,first_key,first_evidence,'credit'), (second,second_key,second_evidence,second_kind)]
    start = threading.Barrier(2)
    def collect(item):
        close_old_connections()
        try:
            start.wait(timeout=5)
            try:
                from dj.apps.economy.products import settle_livestream_delivery
                function = settle_credit_delivery if item[3]=='credit' else settle_livestream_delivery
                return function(admission_id=item[0].pk,event_key=item[1],evidence=item[2]).pk
            except DatabaseError as exc:
                assert 'overlap' in str(exc)
                return None
        finally:
            connection.close()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(collect,work))
    assert sum(result is not None for result in results) == 1
    host.refresh_from_db(); viewer.refresh_from_db()
    assert viewer.tuzis == 98
    assert host.tuzis == 2 * PpvCreditDelivery.objects.count()
    assert PpvCreditDelivery.objects.count() + PayableJournal.objects.count() == 1


from dj.apps.economy.tests.test_integration import reset_isolated_policy as reset_isolated_policy


@pytest.mark.parametrize('failure', ['recipient_cap','wrong_actor','provider_timeout'])
def test_signed_credit_failure_retains_retry_and_all_original_balances(
        api_client, creator_factory, provider, keypair, settings, mocker, failure):
    import requests
    from dj.apps.events.models import Event
    from dj.apps.ledger.models import Transfer
    settings.DYTE_HOST_EVICTION_JOBS_ENABLED = True
    host, viewer, other = creator_factory(tuzis=1000), creator_factory(tuzis=1000), creator_factory(tuzis=0)
    activate_for_test()
    _, meeting, _, _ = go_live(api_client,host,provider,keypair)
    assert viewer_join(api_client,viewer,host).status_code == 200
    admission = PpvCreditAdmission.objects.get()
    token = 'pc_'+admission.pk.hex
    body = json.dumps({'event':'meeting.participantLeft','meeting':meeting,'participant':{
        'peerId':str(uuid.uuid4()),'userDisplayName':'ignored','customParticipantId':token,
        'joinedAt':admission.admitted_at.isoformat(),'leftAt':timezone.now().isoformat()}}).encode()
    event_id = uuid.uuid4()
    transfers_before = Transfer.objects.count()
    events_before = Event.objects.count()
    if failure=='recipient_cap':
        sql('ALTER TABLE economy_economicpolicy DISABLE TRIGGER economy_policy_guard')
        try:
            EconomicPolicy.objects.update(account_daily_limit_m2z=1_001_000)
        finally:
            sql('ALTER TABLE economy_economicpolicy ENABLE TRIGGER economy_policy_guard')
        with pytest.raises(DatabaseError,match='usage_daily_funding_limit'):
            _post(api_client,keypair[0],body,event_id,drain=False)
    elif failure=='wrong_actor':
        binding = bind_participant(meeting_id=admission.meeting_id,participant_id=str(uuid.uuid4()),
            creator_id=host.pk,actor_id=other.pk,role='viewer',custom_id=token)
        evidence = {'user_id':binding.participant_id,'role':'viewer','custom_participant_id':token}
        assert _post(api_client,keypair[0],body,event_id,drain=False,participant_evidence=evidence).status_code == 503
    else:
        boundary = mocker.patch('dj.apps.dyte.participant_binding.DyteClient')
        boundary.return_value.get_session_participant.side_effect = requests.Timeout('synthetic timeout')
        assert _post(api_client,keypair[0],body,event_id,drain=False,participant_evidence=None).status_code == 503
    host.refresh_from_db(); viewer.refresh_from_db()
    assert host.tuzis == viewer.tuzis == 1000
    assert not WebhookDelivery.objects.filter(pk=event_id).exists()
    assert not PpvCreditDelivery.objects.exists()
    assert Transfer.objects.count() == transfers_before and Event.objects.count() == events_before


def test_credit_receipt_writer_is_not_exposed_to_sdk_role(creator_factory):
    credit_fixture(creator_factory)
    assert sql("SELECT has_function_privilege(ledger.gateway_role_name(), 'economy.settle_ppv_credit_delivery(uuid,text,jsonb)','EXECUTE')")[0][0] is False
    assert sql("SELECT has_function_privilege('public','economy.settle_ppv_credit_delivery(uuid,text,jsonb)','EXECUTE')")[0][0] is False


def test_existing_payee_receives_credit_share_not_new_cash_obligation(
        api_client, creator_factory, provider, keypair, settings):
    from dj.apps.economy.tests.test_products import supplier_contract, publish
    from dj.apps.events.models import Event
    settings.DYTE_HOST_EVICTION_JOBS_ENABLED = True
    host, viewer = creator_factory(tuzis=1000), creator_factory(tuzis=1000)
    activate_for_test(); publish('livestream_ppv'); supplier_contract(host)
    _, meeting, _, _ = go_live(api_client,host,provider,keypair)
    assert viewer_join(api_client,viewer,host).status_code == 200
    token = provider.add_participant.call_args.kwargs['custom_participant_id']
    # This boundary assertion can run against the original source as well:
    # both sources admit an onboarded host, but only credits are the requested outcome.
    admission = (ServiceAdmission if token.startswith('ea_') else PpvCreditAdmission).objects.get()
    body = json.dumps({'event':'meeting.participantLeft','meeting':meeting,'participant':{
        'peerId':str(uuid.uuid4()),'userDisplayName':'ignored','customParticipantId':token,
        'joinedAt':admission.admitted_at.isoformat(),'leftAt':timezone.now().isoformat()}}).encode()
    assert _post(api_client,keypair[0],body,uuid.uuid4(),drain=False).status_code == 200
    host.refresh_from_db(); viewer.refresh_from_db()
    assert host.tuzis == 1003 and viewer.tuzis == 997
    assert not PayableJournal.objects.exists()
    assert CreatorPayable.objects.get(creator=host).balance_nusd == 0
    assert Event.objects.filter(type='PAY_PER_VIEW_REVENUE',receiving_user=host,amount=3).count() == 1


@pytest.mark.parametrize('actor_role', ['host','viewer'])
def test_account_deletion_retains_original_credit_receipts_and_revokes_access(creator_factory, actor_role):
    from dj.apps.g12f.account_deletion import DeletionBlocked, delete_account
    from knox.models import AuthToken
    host, viewer, meeting, admission, binding = credit_fixture(creator_factory)
    delivery, _ = settle(admission,binding)
    actor = host if actor_role=='host' else viewer
    actor.refresh_from_db()
    AuthToken.objects.create(user=actor)
    original_admission = PpvCreditAdmission.objects.values().get(pk=admission.pk)
    original_delivery = PpvCreditDelivery.objects.values().get(pk=delivery.pk)
    balance = actor.tuzis
    if actor_role == 'host':
        with pytest.raises(DeletionBlocked, match='^earnings_owed$'):
            delete_account(actor,confirm_username=actor.username,auth_epoch=actor.kt_account_epoch)
        CreatorMeeting.objects.filter(pk=meeting.pk).update(live_now=False, lifecycle_state='offline')
    delete_account(actor,confirm_username=actor.username,auth_epoch=actor.kt_account_epoch)
    actor.refresh_from_db()
    assert not actor.is_active and actor.deleted_at is not None
    assert not AuthToken.objects.filter(user=actor).exists()
    assert actor.tuzis == balance
    assert PpvCreditAdmission.objects.values().get(pk=admission.pk) == original_admission
    assert PpvCreditDelivery.objects.values().get(pk=delivery.pk) == original_delivery
