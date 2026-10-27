"""Filesystem, real entry-point and supervision controls for producer cutover."""
from pathlib import Path
import os
from types import SimpleNamespace

import pytest

from zcashrpc import paymentd_mode as mode
from zcashrpc import creditwatch


@pytest.fixture
def marker(tmp_path, monkeypatch):
    # Exercise actual openat/O_NOFOLLOW/type/content/mode checks without root.
    # Only ownership and ancestor fixture isolation are synthetic.
    parent = tmp_path.resolve() / 'root-state'
    parent.mkdir(mode=0o755)
    leaf = parent / 'ACTIVE'
    original = os.fstat
    owned_inodes = {parent.stat().st_ino}

    def root_fixture(fd):
        value = original(fd)
        permissions = value.st_mode
        if value.st_ino not in owned_inodes and os.path.isdir(f'/dev/fd/{fd}'):
            permissions &= ~0o022
        return SimpleNamespace(st_uid=0, st_gid=0, st_mode=permissions,
                               st_nlink=value.st_nlink, st_dev=value.st_dev, st_ino=value.st_ino)

    monkeypatch.setattr(mode.os, 'fstat', root_fixture)
    monkeypatch.setattr(mode, 'ACTIVE_PATH', leaf)
    monkeypatch.setattr(mode, 'PRODUCER_LOCK', parent / 'PRODUCER_LOCK')
    return leaf, owned_inodes


def write_marker(marker, data=b'paymentd\n', permissions=0o644):
    leaf, inodes = marker
    leaf.write_bytes(data)
    leaf.chmod(permissions)
    inodes.add(leaf.stat().st_ino)
    return leaf




def test_absence_retains_legacy(marker):
    assert mode.buy_producer_mode() == 'legacy'
    marker[0].parent.rmdir()
    assert mode.buy_producer_mode() == 'legacy'


def test_exact_marker_selects_paymentd(marker):
    write_marker(marker)
    assert mode.buy_producer_mode() == 'paymentd'
    with pytest.raises(mode.LegacyProducerDisabled):
        mode.require_legacy_producer()


@pytest.mark.parametrize('data', [b'', b'legacy\n', b'paymentd', b'paymentd\nextra', b'paymentd\x00', b'x' * 1000])
def test_wrong_bytes_fail_closed(marker, data):
    write_marker(marker, data)
    assert mode.buy_producer_mode() == 'invalid'


@pytest.mark.parametrize('permissions', [0o600, 0o664, 0o666, 0o755])
def test_wrong_marker_permissions_fail_closed(marker, permissions):
    write_marker(marker, permissions=permissions)
    assert mode.buy_producer_mode() == 'invalid'


def test_dangling_leaf_is_not_absence(marker):
    marker[0].symlink_to(marker[0].parent / 'missing')
    assert mode.buy_producer_mode() == 'invalid'


def test_fifo_does_not_hang(marker):
    os.mkfifo(marker[0], 0o644)
    assert mode.buy_producer_mode() == 'invalid'


def test_hardlink_matches_receiving_runtime_positive_semantics(marker):
    leaf = write_marker(marker)
    os.link(leaf, leaf.parent / 'second')
    assert mode.buy_producer_mode() == 'paymentd'


def test_writable_parent_with_missing_leaf_is_not_absence(marker):
    marker[0].parent.chmod(0o777)
    assert mode.buy_producer_mode() == 'invalid'


def test_dangling_parent_is_not_absence(marker):
    parent = marker[0].parent
    parent.rmdir()
    parent.symlink_to(parent.parent / 'missing')
    assert mode.buy_producer_mode() == 'invalid'


def test_permission_failure_is_not_absence(marker, monkeypatch):
    original = os.open
    def denied(path, *args, **kwargs):
        if path == 'ACTIVE':
            raise PermissionError('denied')
        return original(path, *args, **kwargs)
    monkeypatch.setattr(mode.os, 'open', denied)
    assert mode.buy_producer_mode() == 'invalid'


@pytest.mark.parametrize('field', ['st_uid', 'st_gid'])
def test_nonroot_owner_refused(marker, monkeypatch, field):
    write_marker(marker)
    original = mode.os.fstat
    def nonroot(fd):
        value = original(fd)
        setattr(value, field, 123)
        return value
    monkeypatch.setattr(mode.os, 'fstat', nonroot)
    assert mode.buy_producer_mode() == 'invalid'


@pytest.mark.parametrize('selection', ['paymentd', 'invalid'])
def test_real_legacy_entrypoints_refuse_before_wallet_or_database(monkeypatch, selection):
    monkeypatch.setattr(mode, 'PRODUCER_LOCK', Path('/__free2z_test_absent_producer_lock/PRODUCER_LOCK'))
    monkeypatch.setattr(mode, 'buy_producer_mode', lambda: selection)
    from dj.apps.g12f.management.commands.credit_creators import Command
    from django.core.management.base import CommandError
    from dj.apps.tuzis.zec import credit_zec_purchase, credit_zec_purchase_instantly
    with pytest.raises(CommandError, match='disabled'):
        Command().handle()
    with pytest.raises(mode.LegacyProducerDisabled):
        credit_zec_purchase(creator=None, txid='x', output_index=0, amount_zec=1,
                            tuzis_per_zec=1)
    with pytest.raises(mode.LegacyProducerDisabled):
        credit_zec_purchase_instantly(amount_zat=1)


def test_mode_specific_heartbeats(tmp_path):
    log = tmp_path / 'log'
    log.write_text('credit_creators: cycle ok - 1 note credited\n'
                   'credit-loop: maintenance cycle ok - wallet synchronized; page funding completed\n')
    assert creditwatch.scan_log(log, 'legacy')[0] == 1
    assert creditwatch.scan_log(log, 'paymentd')[0] == 1
    log.write_text('credit_creators: cycle ok - 1 note credited\n' * 10)
    assert creditwatch.scan_log(log, 'paymentd')[0] == 0


def test_mode_change_rearms_without_old_financial_baseline():
    config = creditwatch.load_config({})
    sample = creditwatch.Sample(now=10000, heartbeats=0, producer_mode='paymentd')
    previous = {'producer_mode': 'legacy', 'heartbeats': 4, 'progress_at': 1,
                'ever_seen': True}
    lines, state, actions = creditwatch.evaluate(sample, previous, config)
    assert actions == []
    assert state['progress_at'] == 10000
    assert not state['ever_seen']
    assert any('armed' in line for line in lines)


def test_unready_watchdog_does_not_restart():
    sample = creditwatch.Sample(now=10000, producer_mode='paymentd', producer_ready=False)
    lines, _, actions = creditwatch.evaluate(sample, {'progress_at': 1, 'ever_seen': True},
                                            creditwatch.load_config({}))
    assert actions == []
    assert not any(line.startswith(creditwatch.CYCLE_SIGNAL) for line in lines)








def test_legacy_command_reaches_wallet_only_in_legacy_mode(monkeypatch):
    monkeypatch.setattr(mode, 'PRODUCER_LOCK', Path('/__free2z_test_absent_producer_lock/PRODUCER_LOCK'))
    monkeypatch.setattr(mode, 'buy_producer_mode', lambda: 'legacy')
    from dj.apps.g12f.management.commands import credit_creators
    def sentinel():
        raise RuntimeError('wallet reached')
    monkeypatch.setattr(credit_creators, 'Client', sentinel)
    with pytest.raises(RuntimeError, match='wallet reached'):
        credit_creators.Command().handle()






def test_stale_maintenance_watchdog_recovers_only_guarded_loop():
    config = creditwatch.Config(stale_seconds=10, restart_window_seconds=1000)
    previous = {'producer_mode': 'paymentd', 'heartbeats': 1, 'progress_at': 1,
                'ever_seen': True}
    sample = creditwatch.Sample(now=100, heartbeats=1, producer_mode='paymentd')
    _, _, actions = creditwatch.evaluate(sample, previous, config)
    assert actions == [config.unit]
    sample.producer_ready = False
    _, _, actions = creditwatch.evaluate(sample, previous, config)
    assert actions == []


@pytest.mark.parametrize('selection', ['paymentd', 'invalid'])
def test_first_maintenance_cycle_wedge_uses_bounded_dependency_recovery(selection):
    config = creditwatch.Config(stale_seconds=10, max_restarts=1,
                               restart_window_seconds=1000,
                               dependency_units=['cloud-sql-proxy.service'])
    previous = {'producer_mode': 'legacy', 'heartbeats': 4, 'progress_at': 1,
                'ever_seen': True}
    sample = creditwatch.Sample(now=100, heartbeats=0, producer_mode=selection)
    _, state, actions = creditwatch.evaluate(sample, previous, config)
    assert actions == [] and state['progress_at'] == 100
    sample.now = 111
    _, state, actions = creditwatch.evaluate(sample, state, config)
    assert actions == [config.unit]
    state.update(restarts=[111], pending_restart_units=[])
    sample.now = 122
    _, _, actions = creditwatch.evaluate(sample, state, config)
    assert actions == ['cloud-sql-proxy.service', config.unit]
    sample.producer_ready = False
    _, _, actions = creditwatch.evaluate(sample, state, config)
    assert actions == []


def make_lock(marker):
    path = mode.PRODUCER_LOCK
    path.write_bytes(b'')
    path.chmod(0o644)
    marker[1].add(path.stat().st_ino)
    return path


def test_paymentd_lease_requires_installed_lock(marker):
    write_marker(marker)
    with pytest.raises(mode.LegacyProducerDisabled, match='lock required'):
        with mode.producer_lease('paymentd'):
            pytest.fail('financial effect ran')
    make_lock(marker)
    with mode.producer_lease('paymentd'):
        pass


@pytest.mark.parametrize('permissions', [0o600, 0o664, 0o666])
def test_malformed_lock_disables_legacy_and_paymentd(marker, permissions):
    make_lock(marker).chmod(permissions)
    for expected in ('legacy', 'paymentd'):
        with pytest.raises(mode.LegacyProducerDisabled):
            with mode.producer_lease(expected):
                pytest.fail('financial effect ran')


def test_dangling_lock_is_not_backwards_compatible_absence(marker):
    mode.PRODUCER_LOCK.symlink_to(mode.PRODUCER_LOCK.parent / 'missing')
    with pytest.raises(mode.LegacyProducerDisabled):
        with mode.producer_lease('legacy'):
            pytest.fail('financial effect ran')


def test_nested_legacy_leases_and_exception_release(marker, monkeypatch):
    make_lock(marker)
    monkeypatch.setattr(mode.os, 'geteuid', lambda: 0)
    with pytest.raises(RuntimeError, match='business error'):
        with mode.producer_lease('legacy'):
            with mode.producer_lease('legacy'):
                raise RuntimeError('business error')
    with mode.producer_lease('legacy', exclusive=True, timeout=0.1):
        pass


def test_old_shared_effect_finishes_before_exclusive_transition(marker, monkeypatch):
    import threading
    make_lock(marker)
    monkeypatch.setattr(mode.os, 'geteuid', lambda: 0)
    entered, transition = threading.Event(), threading.Event()
    failures = []
    def change():
        entered.set()
        try:
            with mode.producer_lease('legacy', exclusive=True, timeout=2):
                transition.set()
        except Exception as exc:
            failures.append(exc)
    with mode.producer_lease('legacy'):
        thread = threading.Thread(target=change)
        thread.start()
        assert entered.wait(1)
        assert not transition.wait(0.1)
    thread.join(3)
    assert not thread.is_alive()
    assert transition.is_set() and not failures


def test_manual_writer_waits_then_rechecks_and_refuses_after_transition(marker, monkeypatch):
    import threading
    make_lock(marker)
    monkeypatch.setattr(mode.os, 'geteuid', lambda: 0)
    starting, finished = threading.Event(), threading.Event()
    effects, errors = [], []
    @mode.legacy_buy_producer
    def financial_effect():
        effects.append('commit')
    def writer():
        starting.set()
        try:
            financial_effect()
        except mode.LegacyProducerDisabled as exc:
            errors.append(exc)
        finally:
            finished.set()
    with mode.producer_lease('legacy', exclusive=True):
        thread = threading.Thread(target=writer)
        thread.start()
        assert starting.wait(1)
        assert not finished.wait(0.1)
        write_marker(marker)
    thread.join(3)
    assert finished.is_set() and not effects and len(errors) == 1


def test_replaced_lock_inode_is_refused_before_effect(marker, monkeypatch):
    import threading
    lock = make_lock(marker)
    monkeypatch.setattr(mode.os, 'geteuid', lambda: 0)
    opened, finished = threading.Event(), threading.Event()
    effects, errors = [], []
    original = mode._root_leaf
    def signal_open(path):
        fd = original(path)
        if path == mode.PRODUCER_LOCK:
            opened.set()
        return fd
    def writer():
        try:
            with mode.producer_lease('legacy', timeout=2):
                effects.append('commit')
        except mode.LegacyProducerDisabled as exc:
            errors.append(exc)
        finally:
            finished.set()
    with pytest.raises(mode.LegacyProducerDisabled, match='inode changed'):
        with mode.producer_lease('legacy', exclusive=True):
            monkeypatch.setattr(mode, '_root_leaf', signal_open)
            thread = threading.Thread(target=writer)
            thread.start()
            assert opened.wait(1)
            replacement = lock.with_name('replacement')
            replacement.write_bytes(b'')
            replacement.chmod(0o644)
            marker[1].add(replacement.stat().st_ino)
            replacement.replace(lock)
    thread.join(3)
    assert finished.is_set() and not effects and len(errors) == 1


def test_bounded_lock_wait_and_unprivileged_transition_refusal(marker, monkeypatch):
    import fcntl
    make_lock(marker)
    monkeypatch.setattr(mode.os, 'geteuid', lambda: 123)
    with pytest.raises(mode.LegacyProducerDisabled, match='require root'):
        with mode.producer_lease('legacy', exclusive=True):
            pass
    fd = os.open(mode.PRODUCER_LOCK, os.O_RDONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(mode.LegacyProducerDisabled, match='deadline'):
            with mode.producer_lease('legacy', timeout=0.05):
                pass
    finally:
        os.close(fd)


def test_dead_process_releases_kernel_lock(marker):
    import subprocess
    import sys
    make_lock(marker)
    child = subprocess.Popen([sys.executable, '-c',
        'import fcntl,sys,time; f=open(sys.argv[1]); fcntl.flock(f,fcntl.LOCK_EX); '
        'print("locked",flush=True); time.sleep(30)', str(mode.PRODUCER_LOCK)],
        stdout=subprocess.PIPE, text=True)
    try:
        assert child.stdout.readline().strip() == 'locked'
        with pytest.raises(mode.LegacyProducerDisabled, match='deadline'):
            with mode.producer_lease('legacy', timeout=0.05):
                pass
        child.terminate()
        child.wait(timeout=3)
        with mode.producer_lease('legacy', timeout=0.1):
            pass
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=3)
        child.stdout.close()


@pytest.mark.parametrize('timeout', [True, 0, -1, float('nan'), float('inf'), None, 301])
def test_invalid_lease_deadlines_refused(marker, timeout):
    with pytest.raises(mode.LegacyProducerDisabled, match='invalid producer lease'):
        with mode.producer_lease('legacy', timeout=timeout):
            pass


def test_invalid_marker_can_be_repaired_only_under_root_exclusive_lease(marker, monkeypatch):
    make_lock(marker)
    write_marker(marker, b'wrong\n')
    monkeypatch.setattr(mode.os, 'geteuid', lambda: 0)
    with pytest.raises(mode.LegacyProducerDisabled):
        with mode.producer_lease('invalid'):
            pass
    with mode.producer_lease('invalid', exclusive=True):
        write_marker(marker)
    with mode.producer_lease('paymentd'):
        pass




@pytest.mark.django_db(transaction=True)
def test_real_command_nested_lease_holds_through_credit_commit(marker, creator_factory, mocker):
    import fcntl
    from decimal import Decimal
    from django.core.management import call_command
    from django.db import transaction
    from dj.apps.events import dispatch
    from dj.apps.tuzis.models import ZecCreditReceipt
    from dj.apps.g12f.test_zec_credit_integrity import FakeWallet, note
    make_lock(marker)
    buyer = creator_factory(username='leasedbuyer', tuzis=Decimal('0'))
    mocker.patch('dj.apps.g12f.management.commands.credit_creators.Client',
                 lambda: FakeWallet([note('ab' * 32, 0.01, buyer.username, output_index=0)]))
    mocker.patch('dj.apps.g12f.management.commands.credit_creators.current_tuzis_per_zec',
                 return_value=Decimal('90000'))
    committed = []
    def commit_observer():
        fd = os.open(mode.PRODUCER_LOCK, os.O_RDONLY)
        try:
            with pytest.raises(BlockingIOError):
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            committed.append(True)
        finally:
            os.close(fd)
    real_event = dispatch.create_durable_event
    def event_and_commit_observer(*args, **kwargs):
        result = real_event(*args, **kwargs)
        transaction.on_commit(commit_observer)
        return result
    mocker.patch.object(dispatch, 'create_durable_event', side_effect=event_and_commit_observer)
    call_command('credit_creators', no_color=True)
    buyer.refresh_from_db()
    assert buyer.tuzis == Decimal('900')
    assert committed == [True]
    assert ZecCreditReceipt.objects.count() == 1
    # Both the nested direct-function lease and command lease have now released.
    fd = os.open(mode.PRODUCER_LOCK, os.O_RDONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    finally:
        os.close(fd)
    call_command('credit_creators', no_color=True)
    buyer.refresh_from_db()
    assert buyer.tuzis == Decimal('900')
    assert ZecCreditReceipt.objects.count() == 1
