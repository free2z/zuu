"""Explicit native exec/FIFO + real isolated PostgreSQL financial boundaries.

Run with PAYMENTD_NATIVE_BRIDGE_TEST=1. Host/node proof IO and root UID metadata
are test fixtures; the real shared lease, SQL, commit, journal and exec run.
"""
import fcntl
import json
import os
from pathlib import Path
import signal
import shutil
import stat
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from django.db import connection, transaction

from dj.apps.economy.models import CapturedZecNote
from dj.apps.economy.tests.test_foundation import activate_for_test
from dj.apps.economy.tests.test_integration import original_zec_intent, reset_isolated_policy  # noqa: F401
from dj.apps.g12f.test_paymentd_credit import Verifier, phase
from dj.apps.g12f.test_paymentd_protocol import event
from dj.apps.tuzis.models import ZecCreditReceipt

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.skipif(
    os.environ.get('PAYMENTD_NATIVE_BRIDGE_TEST') != '1',
    reason='explicit isolated PostgreSQL/native delivery integration invocation required')]


def _wait(path, child, seconds=15):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if path.exists():
            return
        assert child.poll() is None, 'owned financial child exited before proof barrier'
        time.sleep(.01)
    raise AssertionError('owned financial child missed bounded proof barrier')


def _exclusive_available(path):
    with path.open('rb') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        return True


def _wait_exclusive_available(path, seconds=2):
    # killpg schedules termination; it does not await kernel fd teardown.
    # A mode transition still cannot enter while the real flock is held.
    deadline = time.monotonic() + seconds
    while not _exclusive_available(path):
        remaining = deadline - time.monotonic()
        assert remaining > 0, 'terminated financial hook retained producer lease'
        time.sleep(min(.01, remaining))


def test_producer_lease_wait_accepts_bounded_real_fd_teardown(tmp_path):
    path = tmp_path / 'lock'
    path.touch()
    with path.open('rb') as holder:
        fcntl.flock(holder, fcntl.LOCK_SH)
        assert not _exclusive_available(path)

        def delayed_teardown():
            time.sleep(.05)
            fcntl.flock(holder, fcntl.LOCK_UN)

        with ThreadPoolExecutor(max_workers=1) as pool:
            teardown = pool.submit(delayed_teardown)
            _wait_exclusive_available(path)
            teardown.result(timeout=1)
    assert _exclusive_available(path)


def test_producer_lease_wait_rejects_a_still_live_holder(tmp_path):
    path = tmp_path / 'lock'
    path.touch()
    with path.open('rb') as holder:
        fcntl.flock(holder, fcntl.LOCK_SH)
        with pytest.raises(AssertionError, match='retained producer lease'):
            _wait_exclusive_available(path, seconds=.025)
        assert not _exclusive_available(path)


def native_child(case_path, role):
    """Test-only child entry: never selected by a production command/config."""
    from zcashrpc import paymentd_mode as mode
    from dj.apps.g12f import paymentd_credit as adapter
    from dj.apps.g12f.paymentd_protocol import decode_event
    case = json.loads(Path(case_path).read_text())
    root = Path(case['root'])
    mode.ACTIVE_PATH = root / 'ACTIVE'
    mode.PRODUCER_LOCK = root / 'PRODUCER_LOCK'
    original = os.fstat

    def root_metadata(fd):
        # Ordinary private temp files exercise real openat/no-follow/flock.
        # Only OS ownership metadata is synthetic; no production override exists.
        value = list(original(fd))
        value[4] = value[5] = 0
        if stat.S_ISDIR(value[0]):
            value[0] &= ~0o022
        return os.stat_result(value)

    mode.os.fstat = root_metadata
    adapter.require_runtime = lambda **kwargs: None

    class ProofBarrier(Verifier):
        def verify(self, received):
            proof = super().verify(received)
            proof.receiver_in_scope = received['payment']['recipient_hex'] != case.get('out_of_scope_receiver')
            if role == 'settle' and self.calls == 2 and not case.get('skip_proof_barrier'):
                assert not _exclusive_available(mode.PRODUCER_LOCK)

                def committed():
                    assert not _exclusive_available(mode.PRODUCER_LOCK)
                    (root / 'commit-with-lease').write_text('real DB COMMIT under child lease')

                transaction.on_commit(committed)
                if case.get('spawn_descendant'):
                    subprocess.Popen([sys.executable, '-c',
                        'import pathlib,sys,time;time.sleep(8);pathlib.Path(sys.argv[1]).touch()',
                        str(root / 'descendant-survived')],
                        stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                (root / 'proof-entered').write_text(str(os.getpid()))
                end = time.monotonic() + 30
                while not (root / 'release-proof').exists():
                    if time.monotonic() > end:
                        raise TimeoutError('bounded test proof barrier')
                    time.sleep(.01)
            return proof

    received = decode_event(sys.stdin.buffer.read(16385))
    result = adapter.handle_event(received, ProofBarrier(1 if received['kind'] == 'payment.observed' else 3), role=role)
    if case.get('record_outcomes'):
        with (root / 'outcomes.jsonl').open('a') as outcomes:
            outcomes.write(json.dumps({'role': role, 'status': result.status,
                                       'newly_issued': result.newly_issued}) + '\n')


@pytest.fixture
def native_case(tmp_path):
    root = tmp_path.resolve() / 'root-state'
    root.mkdir(mode=0o755)
    for name, content in [('ACTIVE', b'paymentd\n'), ('PRODUCER_LOCK', b'')]:
        path = root / name
        path.write_bytes(content)
        path.chmod(0o644)
    cfg = connection.settings_dict
    # These are only this test owner's isolated DB coordinates, not host secrets.
    values = {'DBHOST': cfg['HOST'], 'DBPORT': str(cfg['PORT']), 'DBNAME': cfg['NAME'],
              'DBUSER': cfg['USER'], 'DBPASS': cfg['PASSWORD'], 'DJANGO_SETTINGS_MODULE': 'pytest_settings'}
    # The real native runner clears the environment. Restore only this fixture's
    # pg_config directory for Homebrew libpq discovery, plus fixed system tools.
    pg_config = shutil.which('pg_config')
    values['PATH'] = (str(Path(pg_config).resolve().parent) + os.pathsep if pg_config else '') + '/usr/bin:/bin'
    case = root / 'case.json'
    case.write_text(json.dumps({'root': str(root), 'environment': values}))
    case.chmod(0o600)
    driver = root / 'driver.py'
    driver.write_text(
        'import json,os,sys\n'
        f'sys.path.insert(0,{str(Path(__file__).resolve().parents[3])!r})\n'
        'os.environ.update(json.load(open(sys.argv[1]))["environment"])\n'
        'try:\n'
        ' import django;django.setup()\n'
        ' from dj.apps.g12f.test_paymentd_native_credit import native_child\n'
        ' native_child(sys.argv[1],sys.argv[2])\n'
        'except BaseException:\n'
        ' import pathlib,traceback\n'
        ' with pathlib.Path(sys.argv[1]).with_name("driver-error.log").open("a") as log: traceback.print_exc(file=log)\n'
        ' raise\n')
    return root, case, driver


def _financial_child(native_case, payment):
    root, case, driver = native_case
    process = subprocess.Popen([sys.executable, str(driver), str(case), 'settle'],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        start_new_session=True)
    process.stdin.write(json.dumps(payment).encode())
    process.stdin.close()
    return process


def _stop_owned(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
    if process.stderr:
        process.stderr.close()


def _payment(intent, tx):
    from decimal import Decimal
    e = event()
    e['payment']['txid'] = tx * 64
    e['payment']['id'] = f"main:{tx * 64}:ironwood:0"
    e['payment']['value_zatoshis'] = int(Decimal(intent.quote['amount_zec']) * 100_000_000)
    e['payment']['memo_hex'] = intent.rail_data['memo'].encode().ljust(512, b'\0').hex()
    return phase(e, 'confirmed')


def test_native_unconfigured_receiver_quarantines_and_both_fifos_progress(native_case, creator_factory):
    from dj.apps.events.models import Event
    first, second = [creator_factory(tuzis=0) for _ in range(2)]
    with transaction.atomic():
        activate_for_test()
    a, b = [_payment(original_zec_intent(actor), tx) for actor,tx in [(first,'a'),(second,'b')]]
    a['payment']['recipient_hex']='f'*86
    b['block_height']=a['block_height']+1;b['block_hash']='d'*64
    root, case, driver = native_case
    repository=Path(__file__).resolve().parents[5]
    for role in ['capture','settle']:
        next_b=phase(b,'observed') if role=='capture' else b
        values=json.loads(case.read_text())
        completed=root/f'fifo-{role}-complete'
        values.update(events=[a,next_b],argv=[sys.executable,str(driver),str(case),role],
            completed=str(completed),out_of_scope_receiver=a['payment']['recipient_hex'],skip_proof_barrier=True)
        case.write_text(json.dumps(values))
        delivered=subprocess.run(['cargo','test','--locked','--test','financial_delivery',
            'serial_native_financial_capture','--','--ignored','--exact'],
            cwd=repository/'rs/zcash-payment-hooks',env=dict(os.environ,PAYMENTD_NATIVE_BRIDGE_CASE=str(case),CARGO_BUILD_JOBS='2'),
            timeout=25,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        errors=root/'driver-error.log'
        assert delivered.returncode==0,(delivered.stdout+delivered.stderr).decode()+(errors.read_text() if errors.exists() else '')
        assert completed.exists()
        assert CapturedZecNote.objects.filter(txid='b'*64).exists()
    first.refresh_from_db();second.refresh_from_db()
    assert first.tuzis==0 and second.tuzis==100
    assert ZecCreditReceipt.objects.count()==1
    assert ZecCreditReceipt.objects.get().txid=='b'*64
    assert Event.objects.filter(type='BOUGHT_TUZI').count()==1
    quarantined=CapturedZecNote.objects.get(txid='a'*64)
    assert quarantined.dispositions.filter(kind='pending_resolution',evidence__reason='receiver_scope_unconfigured').exists()


def test_native_inactive_buyer_is_manual_and_next_settlement_fifo_payment_issues(native_case, creator_factory):
    from dj.apps.events.models import Event
    from dj.apps.economy.captured_notes import capture_wallet_note
    from dj.apps.g12f.test_paymentd_credit import wallet_note
    first,second=[creator_factory(tuzis=0) for _ in range(2)]
    with transaction.atomic(): activate_for_test()
    a,b=[_payment(original_zec_intent(actor),tx) for actor,tx in [(first,'a'),(second,'b')]]
    first.is_active=False;first.save(update_fields=['is_active'])
    b['block_height']=a['block_height']+1;b['block_hash']='d'*64
    root,case,driver=native_case
    completed=root/'inactive-fifo-complete'
    values=json.loads(case.read_text())
    values.update(events=[a,b],argv=[sys.executable,str(driver),str(case),'settle'],
        completed=str(completed),skip_proof_barrier=True)
    case.write_text(json.dumps(values))
    repository=Path(__file__).resolve().parents[5]
    delivered=subprocess.run(['cargo','test','--locked','--test','financial_delivery',
        'serial_native_financial_capture','--','--ignored','--exact'],
        cwd=repository/'rs/zcash-payment-hooks',env=dict(os.environ,PAYMENTD_NATIVE_BRIDGE_CASE=str(case),CARGO_BUILD_JOBS='2'),
        timeout=25,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    errors=root/'driver-error.log'
    assert delivered.returncode==0,(delivered.stdout+delivered.stderr).decode()+(errors.read_text() if errors.exists() else '')
    assert completed.exists()
    first.refresh_from_db();second.refresh_from_db()
    assert first.tuzis==0 and second.tuzis==100
    assert ZecCreditReceipt.objects.count()==1 and ZecCreditReceipt.objects.get().txid=='b'*64
    assert Event.objects.filter(type='BOUGHT_TUZI').count()==1
    held=CapturedZecNote.objects.get(txid='a'*64)
    assert held.dispositions.filter(kind='pending_resolution',evidence__reason='inactive_funding_actor').exists()
    first.is_active=True;first.save(update_fields=['is_active'])
    result=capture_wallet_note(wallet_note(a))
    assert result.status=='pending_resolution' and result.reason=='inactive_funding_actor'
    first.refresh_from_db();assert first.tuzis==0
    assert ZecCreditReceipt.objects.count()==1 and Event.objects.filter(type='BOUGHT_TUZI').count()==1



def test_native_nonstandard_json_memo_is_retained_and_acks_before_next_payment(native_case, creator_factory):
    """Malformed financial instructions cannot starve the real serial FIFO."""
    from dj.apps.events.models import Event
    first, second = [creator_factory(tuzis=0) for _ in range(2)]
    with transaction.atomic():
        activate_for_test()
    a, b = [_payment(original_zec_intent(actor), tx) for actor, tx in [(first, 'a'), (second, 'b')]]
    malformed = ('{"act":"buy_2z","id":"' + first.username + '","promo":NaN}').encode()
    a['payment']['memo_hex'] = malformed.ljust(512, b'\0').hex()
    b['block_height'] = a['block_height'] + 1
    b['block_hash'] = 'd' * 64
    root, case, driver = native_case
    completed = root / 'malformed-memo-fifo-complete'
    values = json.loads(case.read_text())
    values.update(events=[a, b], argv=[sys.executable, str(driver), str(case), 'settle'],
        completed=str(completed), skip_proof_barrier=True)
    case.write_text(json.dumps(values))
    repository = Path(__file__).resolve().parents[5]
    delivered = subprocess.run(['cargo', 'test', '--locked', '--test', 'financial_delivery',
        'serial_native_financial_capture', '--', '--ignored', '--exact'],
        cwd=repository / 'rs/zcash-payment-hooks', env=dict(os.environ,
            PAYMENTD_NATIVE_BRIDGE_CASE=str(case), CARGO_BUILD_JOBS='2'),
        timeout=25, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    errors = root / 'driver-error.log'
    assert delivered.returncode == 0, (delivered.stdout + delivered.stderr).decode() + (errors.read_text() if errors.exists() else '')
    assert completed.exists()
    first.refresh_from_db()
    second.refresh_from_db()
    assert first.tuzis == 0 and second.tuzis == 100
    raw = CapturedZecNote.objects.get(txid='a' * 64)
    assert bytes.fromhex(raw.memo_hex) == malformed.ljust(512, b'\0')
    assert CapturedZecNote.objects.filter(txid='b' * 64).exists()
    assert ZecCreditReceipt.objects.count() == 1
    assert ZecCreditReceipt.objects.get().txid == 'b' * 64
    assert Event.objects.filter(type='BOUGHT_TUZI').count() == 1

def test_native_serial_confirmed_a_then_observed_b_during_a_financial_commit(native_case, creator_factory):
    from dj.apps.events.models import Event
    from dj.apps.ledger.models import Transfer
    first, second = [creator_factory(tuzis=0) for _ in range(2)]
    with transaction.atomic():
        activate_for_test()
    intent_a, intent_b = [original_zec_intent(actor) for actor in (first, second)]
    a, b = _payment(intent_a, 'a'), _payment(intent_b, 'b')
    b['block_height'] = a['block_height'] + 1
    b['block_hash'] = 'd' * 64
    b = phase(b, 'observed')
    # Existing raw A with metadata false is intentional: its duplicate must
    # avoid the same intent lock now held by final financial proof.
    from dj.apps.economy.tests.test_integration import raw_for_intent
    raw_for_intent(intent_a, tx='a')
    root, case, driver = native_case
    child = _financial_child(native_case, a)
    transition = ThreadPoolExecutor(max_workers=1)
    try:
        _wait(root / 'proof-entered', child)
        assert not _exclusive_available(root / 'PRODUCER_LOCK')
        assert not ZecCreditReceipt.objects.exists()
        case_data = json.loads(case.read_text())
        case_data.update(events=[a, b], argv=[sys.executable, str(driver), str(case), 'capture'],
                         completed=str(root / 'native-fifo-complete'))
        case.write_text(json.dumps(case_data))
        repository = Path(__file__).resolve().parents[5]
        env = dict(os.environ, PAYMENTD_NATIVE_BRIDGE_CASE=str(case), CARGO_BUILD_JOBS='2')
        # Explicitly runs the otherwise ignored real Rust journal/exec harness.
        delivered = subprocess.run(['cargo', 'test', '--locked', '--test', 'financial_delivery',
            'serial_native_financial_capture', '--', '--ignored', '--exact'],
            cwd=repository / 'rs/zcash-payment-hooks', env=env, timeout=25,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        errors = root / 'driver-error.log'
        assert delivered.returncode == 0, (delivered.stdout + delivered.stderr).decode() + (errors.read_text() if errors.exists() else '')
        assert (root / 'native-fifo-complete').exists() and child.poll() is None
        note_b = CapturedZecNote.objects.get(txid='b' * 64)
        from dj.apps.purchases.models import PurchaseIntent
        PurchaseIntent.objects.filter(pk=intent_b.pk).update(expires_at=note_b.first_seen_at + timedelta(microseconds=1))
        intent_b.refresh_from_db()
        from dj.apps.purchases.services import expire_if_due
        assert expire_if_due(intent_b).status == 'pending'
        assert not ZecCreditReceipt.objects.exists()
        assert not Event.objects.filter(type='BOUGHT_TUZI').exists()
        before = Transfer.objects.count()

        def exclusive_transition():
            from django.db import close_old_connections
            close_old_connections()
            try:
                with (root / 'PRODUCER_LOCK').open('rb') as fd:
                    fcntl.flock(fd,fcntl.LOCK_EX)
                    # The transition may proceed only after real COMMIT, not
                    # when a parent wrapper dies or a SQL function returns.
                    return ZecCreditReceipt.objects.count()
            finally:
                connection.close()

        waiting = transition.submit(exclusive_transition)
        with pytest.raises(TimeoutError):
            waiting.result(timeout=.2)
        (root / 'release-proof').touch()
        assert child.wait(timeout=5) == 0, child.stderr.read().decode()
        assert waiting.result(timeout=5)==1
        assert (root / 'commit-with-lease').exists()
        assert _exclusive_available(root / 'PRODUCER_LOCK')
        assert ZecCreditReceipt.objects.count() == 1
        assert Event.objects.filter(type='BOUGHT_TUZI').count() == 1
        assert Transfer.objects.count() == before + 1
        first.refresh_from_db();second.refresh_from_db()
        assert first.tuzis == 100 and second.tuzis == 0
        assert note_b.dispositions.filter(evidence__confirmation_reference__endswith=':observed').exists()
    finally:
        (root / 'release-proof').touch()
        _stop_owned(child)
        transition.shutdown(wait=True)


def test_financial_child_kill_releases_lease_and_rolls_back_uncommitted_credit(native_case, creator_factory):
    from dj.apps.events.models import Event
    actor = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    payment = _payment(original_zec_intent(actor), 'e')
    root, _, _ = native_case
    child = _financial_child(native_case, payment)
    try:
        _wait(root / 'proof-entered', child)
        assert not _exclusive_available(root / 'PRODUCER_LOCK')
        assert not ZecCreditReceipt.objects.exists()
        _stop_owned(child)
        assert _exclusive_available(root / 'PRODUCER_LOCK')
        assert CapturedZecNote.objects.count() == 1
        assert not ZecCreditReceipt.objects.exists()
        assert not Event.objects.filter(type='BOUGHT_TUZI').exists()
        assert not (root / 'commit-with-lease').exists()
        actor.refresh_from_db();assert actor.tuzis == 0
    finally:
        _stop_owned(child)


def test_native_timeout_kills_financial_child_and_descendant_without_commit(native_case, creator_factory):
    from dj.apps.events.models import Event
    actor = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    payment = _payment(original_zec_intent(actor), 'f')
    root, case, driver = native_case
    case_data = json.loads(case.read_text())
    case_data.update(events=[payment], argv=[sys.executable,str(driver),str(case),'settle'],
        completed=str(root / 'native-timeout-complete'),spawn_descendant=True)
    case.write_text(json.dumps(case_data))
    repository=Path(__file__).resolve().parents[5]
    command=['cargo','test','--locked','--test','financial_delivery',
        'native_financial_timeout','--','--ignored','--exact']
    native = subprocess.Popen(command,cwd=repository/'rs/zcash-payment-hooks',
        env=dict(os.environ,PAYMENTD_NATIVE_BRIDGE_CASE=str(case),CARGO_BUILD_JOBS='2'),
        stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,start_new_session=True)
    try:
        _wait(root/'proof-entered',native)
        assert not _exclusive_available(root/'PRODUCER_LOCK')
        assert native.wait(timeout=15)==0,native.stderr.read().decode()
        assert (root/'native-timeout-complete').exists()
        _wait_exclusive_available(root/'PRODUCER_LOCK')
        assert CapturedZecNote.objects.count()==1 and not ZecCreditReceipt.objects.exists()
        assert not Event.objects.filter(type='BOUGHT_TUZI').exists()
        time.sleep(8)
        assert not (root/'descendant-survived').exists()
        assert not (root/'commit-with-lease').exists()
        actor.refresh_from_db();assert actor.tuzis==0
    finally:
        _stop_owned(native)


def test_observation_handoff_preserves_legacy_issued_reorg_lineage(native_case, creator_factory):
    """New consumer IDs must see a revoke missed by the legacy producer."""
    from decimal import Decimal
    from dj.apps.events.models import Event
    from dj.apps.ledger import api
    from dj.apps.ledger.models import Transfer
    from dj.apps.economy.models import ZecNoteDisposition
    from dj.apps.g12f.test_paymentd_credit import backend_status

    actor = creator_factory(tuzis=0)
    original = phase(event(), 'confirmed')
    receipt = ZecCreditReceipt.objects.create(
        txid=original['payment']['txid'], pool=original['payment']['pool'],
        output_index=original['payment']['output_index'], creator=actor,
        amount_zec=Decimal(original['payment']['value_zatoshis']) / 100_000_000,
        tuzis_credited=Decimal('998.493'))
    api.credit_purchase(actor.pk, 998493, 'zec', 'zec_receipt', str(receipt.pk),
                        'handoff-legacy-issued-control')
    with transaction.atomic():
        activate_for_test()
    before_transfers = Transfer.objects.count()
    before_events = Event.objects.filter(type='BOUGHT_TUZI').count()
    assert not CapturedZecNote.objects.exists()
    root, case, driver = native_case
    repository = Path(__file__).resolve().parents[5]
    for role in ['capture', 'settle']:
        values = json.loads(case.read_text())
        completed = root / f'reorg-handoff-{role}-complete'
        values.update(events=[original], observation_reorg=True,
                      argv=[sys.executable, str(driver), str(case), role],
                      completed=str(completed), skip_proof_barrier=True, record_outcomes=True)
        case.write_text(json.dumps(values))
        delivered = subprocess.run(
            ['cargo', 'test', '--locked', '--test', 'financial_delivery',
             'serial_native_financial_capture', '--', '--ignored', '--exact'],
            cwd=repository / 'rs/zcash-payment-hooks',
            env=dict(os.environ, PAYMENTD_NATIVE_BRIDGE_CASE=str(case), CARGO_BUILD_JOBS='2'),
            timeout=25, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        errors = root / 'driver-error.log'
        assert delivered.returncode == 0, (delivered.stdout + delivered.stderr).decode() + (
            errors.read_text() if errors.exists() else '')
        assert completed.exists()
    note = CapturedZecNote.objects.get()
    assert note.dispositions.filter(kind='revoked').exists()
    assert ZecNoteDisposition.objects.filter(note=note, kind='legacy_issued', receipt=receipt).exists()
    outcomes = [json.loads(line) for line in (root / 'outcomes.jsonl').read_text().splitlines()]
    assert len(outcomes) == 4
    assert outcomes[-1] == {'role': 'settle', 'status': 'issued_under_review', 'newly_issued': False}
    assert all(not outcome['newly_issued'] for outcome in outcomes)
    actor.refresh_from_db()
    assert actor.tuzis == Decimal('998.493')
    assert ZecCreditReceipt.objects.count() == 1 and Transfer.objects.count() == before_transfers
    assert Event.objects.filter(type='BOUGHT_TUZI').count() == before_events
    status = backend_status()
    assert status['issued_under_review'] == 1 and status['unresolved_unbacked_credits'] == 1


def test_resolved_legacy_issuance_refuses_handoff_before_any_native_delivery(creator_factory):
    """A delivery-time timestamp cannot prove an old resolved reorg's lineage."""
    from decimal import Decimal
    from django.utils import timezone
    from dj.apps.events.models import Event
    from dj.apps.ledger import api
    from dj.apps.ledger.models import Transfer
    from dj.apps.economy.models import ZecNoteDisposition
    from dj.apps.g12f.management.commands.paymentd_credit_status import (
        handoff_revocation_status, parse_handoff_revocations)

    actor=creator_factory(tuzis=0)
    original=phase(event(),'confirmed')
    payment=original['payment']
    receipt=ZecCreditReceipt.objects.create(txid=payment['txid'],pool=payment['pool'],
        output_index=payment['output_index'],creator=actor,
        amount_zec=Decimal(payment['value_zatoshis'])/100_000_000,
        tuzis_credited=Decimal('998.493'),vanished_at=timezone.now(),
        vanish_resolved_at=timezone.now())
    api.credit_purchase(actor.pk,998493,'zec','zec_receipt',str(receipt.pk),
        'resolved-handoff-legacy-issued-control')
    with transaction.atomic():
        activate_for_test()
    before=(list(ZecCreditReceipt.objects.values()),list(Transfer.objects.values()),
        list(Event.objects.values()),list(CapturedZecNote.objects.values()),
        list(ZecNoteDisposition.objects.values()))
    ref={'network':original['network'],'txid':payment['txid'],'pool':payment['pool'],
        'output_index':payment['output_index'],'event_id':phase(original,'revoked')['event_id'],
        'revision':original['revision'],'journal_sequence':2}
    refs=parse_handoff_revocations(json.dumps({'schema':1,'revocations':[ref]}).encode())
    assert handoff_revocation_status(refs)=={
        'schema':1,'checked_revocations':1,'already_resolved_legacy_receipts':1,'ready':False}
    after=(list(ZecCreditReceipt.objects.values()),list(Transfer.objects.values()),
        list(Event.objects.values()),list(CapturedZecNote.objects.values()),
        list(ZecNoteDisposition.objects.values()))
    assert after==before
    actor.refresh_from_db()
    assert actor.tuzis==Decimal('998.493')
    assert not CapturedZecNote.objects.exists()
