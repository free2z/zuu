"""Real PostgreSQL capture progress while settlement waits for final proof."""
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal

import psycopg
import pytest
from django.db import close_old_connections, connection, transaction

from dj.apps.economy import captured_notes as notes, services as money
from dj.apps.economy.models import CapturedZecNote, FundingReservation
from dj.apps.economy.tests.test_concurrency import isolated_epoch  # noqa: F401
from dj.apps.economy.tests.test_foundation import activate_for_test
from dj.apps.economy.tests.test_integration import original_zec_intent, raw_for_intent
from dj.apps.g12f.models import Creator
from dj.apps.purchases.models import PurchaseIntent
from dj.apps.purchases.services import expire_if_due
from dj.apps.tuzis.models import ZecCreditReceipt

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.ledger_drift_expected]


def coordinates(intent, tx):
    return dict(txid=tx * 64, pool='ironwood', output_index=0,
        amount_zatoshi=int(Decimal(intent.quote['amount_zec']) * 100_000_000),
        memo_hex=intent.rail_data['memo'].encode().ljust(512, b'\0').hex(),
        source={'source_kind': 'verified-wallet', 'source_reference': f'wallet:{tx}'})


def evidence(reference, **extra):
    return {'source_reference': 'verified-wallet', 'confirmation_reference': reference, **extra}


def independent(function):
    close_old_connections()
    try:
        return function()
    finally:
        connection.close()


def test_serial_fact_lane_passes_a_payment_in_final_financial_proof(creator_factory):
    actors = [creator_factory(tuzis=0) for _ in range(2)]
    with transaction.atomic():
        activate_for_test()
    first, second = [original_zec_intent(actor) for actor in actors]
    raw = raw_for_intent(first, tx='a')  # Raw committed; metadata still false.
    observed = evidence('confirmed:1')
    notes.record_note_observation(note_id=raw.pk, confirmations=3, evidence=observed)
    proof_entered, finish_proof = threading.Event(), threading.Event()

    def settle():
        with transaction.atomic():
            result = notes.process_captured_zec_note(note_id=raw.pk, confirmations=3, evidence=observed)
            assert result.credited
            proof_entered.set()
            assert finish_proof.wait(10), 'test final proof deadline'
        return result

    def capture_serially():
        # One consumer processes A then B, without parallel escape.
        repeat = notes.ingest_zec_note(adopt_existing=False, **coordinates(first, 'a'))
        notes.record_note_observation(note_id=repeat.pk, confirmations=4, evidence=evidence('confirmed:2'))
        other = notes.ingest_zec_note(adopt_existing=False, **coordinates(second, 'b'))
        notes.record_note_observation(note_id=other.pk, confirmations=0, evidence=evidence('observed:1'))
        return other.pk

    with ThreadPoolExecutor(max_workers=2) as workers:
        financial = workers.submit(independent, settle)
        try:
            assert proof_entered.wait(5)
            other_id = workers.submit(independent, capture_serially).result(timeout=2)
            assert not financial.done()
            other = CapturedZecNote.objects.get(pk=other_id)
            assert other.dispositions.filter(evidence__confirmation_reference='observed:1').exists()
            assert Creator.objects.get(pk=actors[0].pk).tuzis == 0
            assert Creator.objects.get(pk=actors[1].pk).tuzis == 0
        finally:
            finish_proof.set()
        assert financial.result(timeout=5).credited
    assert Creator.objects.get(pk=actors[0].pk).tuzis == 100
    assert FundingReservation.objects.get(pk=second.quote['funding_reservation_id']).state == 'reserved'
    raw.refresh_from_db()
    assert raw.first_seen_at < other.first_seen_at


def test_skipped_intent_metadata_preserves_expiry_and_capacity(creator_factory):
    actor = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    intent = original_zec_intent(actor)
    raw = raw_for_intent(intent, tx='c')
    original_time = raw.first_seen_at
    PurchaseIntent.objects.filter(pk=intent.pk).update(expires_at=original_time + timedelta(microseconds=1))
    with psycopg.connect(**connection.get_connection_params()) as blocker:
        blocker.execute('SELECT id FROM purchases_purchaseintent WHERE id=%s FOR UPDATE', [intent.pk])
        with ThreadPoolExecutor(max_workers=1) as workers:
            replay = workers.submit(independent,
                lambda: notes.ingest_zec_note(adopt_existing=False, **coordinates(intent, 'c')))
            assert replay.result(timeout=2).pk == raw.pk
        assert not PurchaseIntent.objects.get(pk=intent.pk).rail_data['payment_observed']
    intent.refresh_from_db()
    assert expire_if_due(intent).status == 'pending'
    assert FundingReservation.objects.get(pk=intent.quote['funding_reservation_id']).state == 'reserved'
    intent.refresh_from_db()
    assert intent.rail_data['payment_observed'] is False
    raw.refresh_from_db()
    assert raw.first_seen_at == original_time
    confirmed = evidence('confirmed:expiry')
    notes.record_note_observation(note_id=raw.pk, confirmations=3, evidence=confirmed)
    assert notes.process_captured_zec_note(note_id=raw.pk, confirmations=3, evidence=confirmed).credited


def test_revocation_waits_for_financial_commit_and_sets_brake(creator_factory):
    actor = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    intent = original_zec_intent(actor)
    raw = raw_for_intent(intent, tx='d')
    confirmed = evidence('confirmed:revocation')
    notes.record_note_observation(note_id=raw.pk, confirmations=3, evidence=confirmed)
    proof_entered, finish_proof, revoke_started = threading.Event(), threading.Event(), threading.Event()

    def settle():
        with transaction.atomic():
            result = notes.process_captured_zec_note(note_id=raw.pk, confirmations=3, evidence=confirmed)
            proof_entered.set()
            assert finish_proof.wait(10)
        return result

    def revoke():
        revoke_started.set()
        return notes.record_note_observation(note_id=raw.pk, confirmations=0,
            evidence=evidence('revoked:1', revoked=True, revocation_revision_reference='revision:1'))

    with ThreadPoolExecutor(max_workers=2) as workers:
        financial = workers.submit(independent, settle)
        try:
            assert proof_entered.wait(5)
            revoked = workers.submit(independent, revoke)
            assert revoke_started.wait(5)
            with pytest.raises(TimeoutError):
                revoked.result(timeout=.2)
            assert not raw.dispositions.filter(kind='revoked').exists()
        finally:
            finish_proof.set()
        assert financial.result(timeout=5).credited
        assert revoked.result(timeout=5).kind == 'revoked'
    receipt = ZecCreditReceipt.objects.get(txid=raw.txid)
    assert receipt.vanished_at is not None and receipt.vanish_resolved_at is None
    from dj.apps.tuzis.zec import unresolved_unbacked_credits
    assert unresolved_unbacked_credits().filter(pk=receipt.pk).exists()
    assert Creator.objects.get(pk=actor.pk).tuzis == 100


def test_fact_capture_defers_exact_legacy_adoption_without_new_issuance(creator_factory):
    from dj.apps.ledger import api
    from dj.apps.ledger.models import Transfer
    actor = creator_factory(tuzis=0)
    receipt = ZecCreditReceipt.objects.create(txid='e' * 64, pool='ironwood', output_index=0,
        creator=actor, amount_zec=Decimal('.00909007'), tuzis_credited=Decimal('998.493'),
        tuzis_per_zec=Decimal('109844.35'))
    api.credit_purchase(actor.pk, 998493, 'zec', 'zec_receipt', str(receipt.pk), 'fact-adoption-original')
    transfers = Transfer.objects.count()
    raw = notes.ingest_zec_note(adopt_existing=False, txid=receipt.txid, pool=receipt.pool,
        output_index=0, amount_zatoshi=909007, memo_hex='ff' + '00' * 511,
        source={'source_kind': 'wallet', 'source_reference': 'fact-adoption'})
    assert not raw.dispositions.filter(kind='legacy_issued').exists()
    adopted = notes.adopt_existing_issuance(note_id=raw.pk)
    assert adopted.receipt_id == receipt.pk and adopted.actor_id == actor.pk
    assert Transfer.objects.count() == transfers
    assert Creator.objects.get(pk=actor.pk).tuzis == Decimal('998.493')


def test_hydration_replay_does_not_wait_and_conflicting_bytes_refuse(creator_factory):
    actor = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    intent = original_zec_intent(actor)
    args = coordinates(intent, 'f')
    raw = notes.ingest_zec_note(adopt_existing=False, **dict(args, memo_hex=None,
        source=dict(args['source'], memo_available=False)))
    notes.ingest_zec_note(adopt_existing=False, **args)
    with psycopg.connect(**connection.get_connection_params()) as blocker:
        blocker.execute('SELECT id FROM purchases_purchaseintent WHERE id=%s FOR UPDATE', [intent.pk])
        with ThreadPoolExecutor(max_workers=1) as workers:
            assert workers.submit(independent,
                lambda: notes.ingest_zec_note(adopt_existing=False, **args)).result(timeout=2).pk == raw.pk
    with pytest.raises(money.IdempotencyConflict, match='hydration_changed'):
        notes.ingest_zec_note(adopt_existing=False, **dict(args, memo_hex='00' * 512))
    with pytest.raises(money.IdempotencyConflict, match='identity_changed'):
        notes.ingest_zec_note(adopt_existing=False, **dict(args, amount_zatoshi=args['amount_zatoshi'] + 1))


def test_hydration_after_retired_quote_release_credits_actual_note(creator_factory):
    actor = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    intent = original_zec_intent(actor)
    args = coordinates(intent, '1')
    raw = notes.ingest_zec_note(adopt_existing=False, **dict(args, memo_hex=None,
        source=dict(args['source'], memo_available=False)))
    first_seen = raw.first_seen_at
    PurchaseIntent.objects.filter(pk=intent.pk).update(expires_at=first_seen + timedelta(microseconds=1))
    intent.refresh_from_db()
    assert expire_if_due(intent).status == 'expired'
    assert FundingReservation.objects.get(pk=intent.quote['funding_reservation_id']).state == 'released'
    notes.ingest_zec_note(adopt_existing=False, **args)
    confirmed = evidence('confirmed:late-hydration')
    notes.record_note_observation(note_id=raw.pk, confirmations=3, evidence=confirmed)
    result = notes.process_captured_zec_note(note_id=raw.pk, confirmations=3, evidence=confirmed)
    assert result.credited and result.status == 'issued'
    # The pre-existing expiry release stays released; durable note/observation
    # records own the manual claim. Hydration cannot resurrect that capacity.
    assert FundingReservation.objects.get(pk=intent.quote['funding_reservation_id']).state == 'released'
    assert raw.dispositions.filter(kind='issued').exists()
    assert Creator.objects.get(pk=actor.pk).tuzis == 100
    raw.refresh_from_db()
    assert raw.first_seen_at == first_seen and raw.memo_hex is None


@pytest.mark.parametrize('backfilled,pool', [(True, 'ironwood'), (False, '')])
def test_ambiguous_legacy_receipts_never_adopt_or_issue(creator_factory, backfilled, pool):
    actor = creator_factory(tuzis=0)
    ZecCreditReceipt.objects.create(txid='2' * 64, pool=pool, output_index=0, creator=actor,
        amount_zec=Decimal('.00909007'), tuzis_credited=Decimal('998.493'),
        tuzis_per_zec=Decimal('109844.35'), backfilled=backfilled)
    with transaction.atomic():
        activate_for_test()
    raw = notes.ingest_zec_note(adopt_existing=False, txid='2' * 64, pool='ironwood',
        output_index=0, amount_zatoshi=909007, memo_hex='00' * 512,
        source={'source_kind': 'wallet', 'source_reference': 'ambiguous-control'})
    assert notes.adopt_existing_issuance(note_id=raw.pk) is None
    observed = evidence('confirmed:ambiguous')
    notes.record_note_observation(note_id=raw.pk, confirmations=3, evidence=observed)
    result = notes.process_captured_zec_note(note_id=raw.pk, confirmations=3, evidence=observed)
    assert not result.credited and result.reason == 'ambiguous_existing_issuance'
    assert Creator.objects.get(pk=actor.pk).tuzis == 0


@pytest.mark.parametrize('policy_version', [0, 1])
def test_fact_api_uses_actual_restricted_login_and_preserves_sql_guards(policy_version):
    """Fact writes work without any grant to financial functions or accounts."""
    import uuid
    from django.db import DatabaseError
    from dj.apps.economy.models import EconomicPolicy
    EconomicPolicy.objects.get_or_create(pk=True)
    if policy_version:
        with transaction.atomic():
            activate_for_test()
    EconomicPolicy.objects.filter(pk=True).update(fenced=True)
    params = connection.get_connection_params()
    role = 'fact_capture_' + uuid.uuid4().hex
    password = uuid.uuid4().hex
    with psycopg.connect(**params, autocommit=True) as owner:
        from psycopg import sql
        owner.execute(sql.SQL('CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD {}').format(
            sql.Identifier(role), sql.Literal(password)))
        owner.execute(sql.SQL('GRANT USAGE ON SCHEMA public TO {}').format(sql.Identifier(role)))
        owner.execute(sql.SQL('GRANT SELECT ON economy_capturedzecnote, economy_zecnotedisposition, '
            'tuzis_idempotencykey, purchases_purchaseintent TO {}').format(sql.Identifier(role)))
        owner.execute(sql.SQL('GRANT INSERT ON economy_capturedzecnote, economy_zecnotedisposition TO {}').format(sql.Identifier(role)))
        owner.execute(sql.SQL('GRANT UPDATE ON purchases_purchaseintent TO {}').format(sql.Identifier(role)))
        sequence = owner.execute("SELECT pg_get_serial_sequence('economy_zecnotedisposition','id')").fetchone()[0]
        owner.execute(sql.SQL('GRANT USAGE ON SEQUENCE {} TO {}').format(
            sql.Identifier(*sequence.split('.')), sql.Identifier(role)))
    old_user, old_password = connection.settings_dict['USER'], connection.settings_dict['PASSWORD']
    connection.close()
    try:
        connection.settings_dict['USER'] = role
        connection.settings_dict['PASSWORD'] = password
        with connection.cursor() as cursor:
            cursor.execute('SELECT session_user')
            assert cursor.fetchone()[0] == role  # LOGIN, not owner SET ROLE.
        raw = notes.ingest_zec_note(adopt_existing=False, txid='3' * 64, pool='sapling',
            output_index=0, amount_zatoshi=1, memo_hex='ff' + '00' * 511,
            source={'source_kind': 'wallet', 'source_reference': 'restricted-login'})
        assert notes.record_note_observation(note_id=raw.pk, confirmations=1,
            evidence=evidence('observed:restricted')).kind == 'observed'
        with pytest.raises(DatabaseError, match='permission denied'), transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute('SELECT ledger.uuid_v7()')
        with pytest.raises(DatabaseError, match='raw memo plaintext'), transaction.atomic():
            CapturedZecNote.objects.create(txid='4' * 64, pool='sapling', output_index=0,
                amount_zatoshi=1, memo_hex='00' * 512, memo_plain='invented',
                source={'source_kind': 'wallet', 'source_reference': 'forged-plaintext'}, source_digest='a' * 64)
    finally:
        connection.close()
        connection.settings_dict['USER'] = old_user
        connection.settings_dict['PASSWORD'] = old_password
        with psycopg.connect(**params, autocommit=True) as owner:
            owner.execute(sql.SQL('DROP OWNED BY {}').format(sql.Identifier(role)))
            owner.execute(sql.SQL('DROP ROLE {}').format(sql.Identifier(role)))
