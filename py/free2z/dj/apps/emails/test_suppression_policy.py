"""Consent remains effective across recovery mail and account-lock races."""
import logging
import threading
from datetime import timedelta

import pytest
from django.core import mail
from django.db import close_old_connections, connection, connections, transaction
from django.utils import timezone

from dj.apps.emails.models import Email, OptOutEmail, PasswordResetToken
from dj.apps.emails.views import send_confirmation_email, send_password_reset_email
from dj.apps.g12f.models import Creator


def make_email(user, address, confirmed):
    return Email.objects.create(
        user=user, email=address, token="sensitive-token", expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now() if confirmed else None,
    )


@pytest.mark.django_db
@pytest.mark.parametrize("confirmed", [False, True])
def test_recovery_mail_suppression_has_no_address_or_token_in_log(creator_factory, caplog, confirmed):
    address = make_email(creator_factory(), "private-address@example.com", confirmed)
    OptOutEmail.objects.create(email=address.email)
    with caplog.at_level(logging.INFO, logger="dj.apps.emails.views"):
        assert send_confirmation_email(address) is False
        assert send_password_reset_email(address) is None
    assert not mail.outbox
    assert not PasswordResetToken.objects.filter(email=address).exists()
    assert "confirmation_email_suppressed_opt_out" in caplog.text
    assert "password_reset_email_suppressed_opt_out" in caplog.text
    assert address.email not in caplog.text
    assert address.token not in caplog.text


@pytest.mark.django_db(transaction=True)
def test_reset_waiting_for_account_lock_observes_committed_suppression(creator_factory, monkeypatch):
    if connection.vendor != "postgresql":
        pytest.skip("requires PostgreSQL row locks")
    from dj.apps.emails import views

    user = creator_factory()
    address = make_email(user, "locked@example.com", True)
    checked = threading.Event()
    errors = []
    original = views.is_suppressed

    def observed_check(value):
        result = original(value)
        checked.set()
        return result

    monkeypatch.setattr(views, "is_suppressed", observed_check)

    def issue():
        close_old_connections()
        try:
            loaded = Email.objects.select_related("user").get(pk=address.pk)
            send_password_reset_email(loaded)
        except Exception as exc:
            errors.append(exc)
        finally:
            connections.close_all()

    with transaction.atomic():
        Creator.objects.select_for_update().get(pk=user.pk)
        thread = threading.Thread(target=issue)
        thread.start()
        assert checked.wait(10), "sender did not reach the first suppression check"
        OptOutEmail.objects.create(email=address.email)
    thread.join(10)
    assert not thread.is_alive()
    assert not errors
    assert not PasswordResetToken.objects.filter(email_id=address.pk).exists()
    assert not mail.outbox


@pytest.mark.django_db
def test_confirmation_does_not_send_a_replaced_or_revoked_snapshot(creator_factory):
    user = creator_factory()
    address = make_email(user, "old@example.com", False)
    Email.objects.filter(pk=address.pk).update(email="new@example.com")
    assert send_confirmation_email(address) is False
    assert not mail.outbox
    Email.objects.filter(pk=address.pk).update(email=address.email)
    Creator.objects.filter(pk=user.pk).update(kt_account_epoch=user.kt_account_epoch + 1)
    assert send_confirmation_email(address) is False
    assert not mail.outbox


@pytest.mark.django_db
def test_reset_rejects_a_stale_account_epoch(creator_factory):
    user = creator_factory()
    address = make_email(user, "old-epoch@example.com", True)
    Creator.objects.filter(pk=user.pk).update(kt_account_epoch=user.kt_account_epoch + 1)
    assert send_password_reset_email(address) is None
    assert not PasswordResetToken.objects.filter(email=address).exists()
    assert not mail.outbox


@pytest.mark.django_db(transaction=True)
def test_late_failed_provider_result_cannot_restore_removed_recovery_address(creator_factory, monkeypatch):
    if connection.vendor != "postgresql":
        pytest.skip("requires PostgreSQL transactions")
    user = creator_factory()
    address = make_email(user, "removed@example.com", True)
    entered = threading.Event()
    finish = threading.Event()
    errors = []

    def blocked_send(_message):
        entered.set()
        assert finish.wait(10)
        raise RuntimeError("provider refused")

    monkeypatch.setattr("dj.apps.emails.views._bounded_recovery_send", blocked_send)

    def issue():
        close_old_connections()
        try:
            loaded = Email.objects.select_related("user").get(pk=address.pk)
            send_password_reset_email(loaded)
        except RuntimeError as exc:
            errors.append(str(exc))
        finally:
            connections.close_all()

    mutation_done = threading.Event()

    def unsubscribe():
        close_old_connections()
        try:
            with transaction.atomic():
                Creator.objects.select_for_update().get(pk=user.pk)
                Email.objects.select_for_update().get(pk=address.pk).delete()
                OptOutEmail.objects.create(email=address.email)
        finally:
            mutation_done.set()
            connections.close_all()

    thread = threading.Thread(target=issue)
    thread.start()
    mutation = None
    try:
        assert entered.wait(10), "provider was not reached"
        mutation = threading.Thread(target=unsubscribe)
        mutation.start()
        assert not mutation_done.wait(0.3), "mutation crossed an in-flight provider gate"
    finally:
        finish.set()
        thread.join(10)
        if mutation:
            mutation.join(10)
    assert mutation_done.is_set()

    assert not thread.is_alive()
    assert errors == ["provider refused"]
    assert not Email.objects.filter(user_id=user.pk).exists()
    assert OptOutEmail.objects.filter(email=address.email).exists()
    assert not PasswordResetToken.objects.exists()


@pytest.mark.django_db
def test_account_keep_notification_honors_suppression_without_sensitive_log(creator_factory, caplog):
    from dj.apps.g12f.account_deletion import _notify_cancelled

    address = make_email(creator_factory(), "notice@example.com", True)
    OptOutEmail.objects.create(email=address.email)
    with caplog.at_level(logging.INFO, logger="dj.apps.g12f.account_deletion"):
        _notify_cancelled(address.user_id)
    assert "account_keep_email_suppressed_opt_out" in caplog.text
    assert address.email not in caplog.text
    assert address.token not in caplog.text
    assert not mail.outbox


@pytest.mark.django_db
def test_shared_policy_matches_old_replica_ledger_query():
    from dj.apps.emails.suppression import is_suppressed, suppressed_addresses

    OptOutEmail.objects.create(email="opted-out@example.com")
    for address in ("opted-out@example.com", "normal@example.com"):
        old_result = OptOutEmail.objects.filter(email=address).exists()
        assert is_suppressed(address) == old_result
        assert (address in suppressed_addresses().values_list("email", flat=True)) == old_result


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('kind', ['confirmation', 'reset'])
@pytest.mark.parametrize('change', ['optout', 'remove', 'epoch'])
def test_committed_change_wins_before_recovery_provider_start(
    creator_factory, monkeypatch, kind, change, caplog,
):
    if connection.vendor != 'postgresql':
        pytest.skip('requires PostgreSQL row locks')
    from dj.apps.emails import views

    user = creator_factory()
    address = make_email(user, 'gate@example.com', kind == 'reset')
    checked = threading.Event()
    provider = threading.Event()
    original = views.is_suppressed
    errors = []

    def observed(value):
        result = original(value)
        checked.set()
        return result

    def send(_message):
        provider.set()
        return 1

    monkeypatch.setattr(views, 'is_suppressed', observed)
    monkeypatch.setattr(views, '_bounded_recovery_send', send)
    caplog.set_level(logging.INFO, logger='dj.apps.emails.views')
    snapshot = Email.objects.select_related('user').get(pk=address.pk)

    def issue():
        close_old_connections()
        try:
            (views.send_confirmation_email if kind == 'confirmation'
             else views.send_password_reset_email)(snapshot)
        except Exception as exc:
            errors.append(exc)
        finally:
            connections.close_all()

    with transaction.atomic():
        locked_user = Creator.objects.select_for_update().get(pk=user.pk)
        Email.objects.select_for_update().get(pk=address.pk)
        worker = threading.Thread(target=issue)
        worker.start()
        assert checked.wait(10)
        if change == 'optout':
            OptOutEmail.objects.create(email=address.email)
        elif change == 'remove':
            Email.objects.filter(pk=address.pk).delete()
        else:
            locked_user.kt_account_epoch += 1
            locked_user.save(update_fields=['kt_account_epoch'])
    worker.join(10)
    assert not worker.is_alive()
    assert not errors
    assert not provider.is_set()
    assert not PasswordResetToken.objects.filter(email_id=address.pk, used=False).exists()
    if change == 'optout':
        assert 'suppressed_opt_out' in caplog.text
        assert address.email not in caplog.text
        assert address.token not in caplog.text


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('kind', ['confirmation', 'reset'])
@pytest.mark.parametrize('change', ['optout', 'remove', 'epoch'])
def test_mutation_waits_for_provider_start_gate(creator_factory, monkeypatch, kind, change):
    if connection.vendor != 'postgresql':
        pytest.skip('requires PostgreSQL advisory locks')
    from dj.apps.emails import views

    user = creator_factory()
    address = make_email(user, 'admin-gate@example.com', kind == 'reset')
    entered = threading.Event()
    release = threading.Event()
    inserted = threading.Event()
    errors = []

    def send(_message):
        entered.set()
        assert release.wait(10)
        return 1

    monkeypatch.setattr(views, '_bounded_recovery_send', send)
    snapshot = Email.objects.select_related('user').get(pk=address.pk)

    def issue():
        close_old_connections()
        try:
            (views.send_confirmation_email if kind == 'confirmation'
             else views.send_password_reset_email)(snapshot)
        except Exception as exc:
            errors.append(exc)
        finally:
            connections.close_all()

    def insert():
        close_old_connections()
        try:
            if change == 'optout':
                # Staff insertion takes the address gate without account locks.
                OptOutEmail.objects.create(email=address.email)
            else:
                with transaction.atomic():
                    locked_user = Creator.objects.select_for_update().get(pk=user.pk)
                    locked_email = Email.objects.select_for_update().get(pk=address.pk)
                    if change == 'remove':
                        locked_email.delete()
                    else:
                        locked_user.kt_account_epoch += 1
                        locked_user.save(update_fields=['kt_account_epoch'])
            inserted.set()
        except Exception as exc:
            errors.append(exc)
        finally:
            connections.close_all()

    worker = threading.Thread(target=issue)
    worker.start()
    other = None
    try:
        assert entered.wait(10)
        other = threading.Thread(target=insert)
        other.start()
        assert not inserted.wait(0.3)
    finally:
        release.set()
        worker.join(10)
        if other:
            other.join(10)
    assert not worker.is_alive()
    assert inserted.is_set()
    assert not errors


class DelayedProviderBackend:
    """Child-only backend: a killed process cannot write the final marker."""
    def __init__(self, **kwargs):
        pass

    def send_messages(self, messages):
        import os
        import time
        from pathlib import Path

        Path(os.environ['RECOVERY_TEST_STARTED']).write_text('started')
        time.sleep(6)
        Path(os.environ['RECOVERY_TEST_FINISHED']).write_text('finished')
        return len(messages)


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('kind', ['confirmation', 'reset'])
def test_provider_deadline_releases_locks_and_preserves_ambiguous_reset(
    creator_factory, monkeypatch, settings, kind, tmp_path,
):
    import time
    from dj.apps.emails import views

    settings.EMAIL_SEND_TIMEOUT_SECONDS = 3
    settings.EMAIL_BACKEND = 'dj.apps.emails.test_suppression_policy.DelayedProviderBackend'
    started = tmp_path / 'started'
    finished = tmp_path / 'finished'
    monkeypatch.setenv('RECOVERY_TEST_STARTED', str(started))
    monkeypatch.setenv('RECOVERY_TEST_FINISHED', str(finished))
    user = creator_factory()
    address = make_email(user, 'timeout@example.com', kind == 'reset')
    before = time.monotonic()
    with pytest.raises(TimeoutError):
        (views.send_confirmation_email if kind == 'confirmation'
         else views.send_password_reset_email)(address)
    assert time.monotonic() - before < 5
    assert started.exists(), 'the provider process never reached the backend'
    if kind == 'reset':
        assert PasswordResetToken.objects.filter(email=address, used=False).exists()
    OptOutEmail.objects.create(email=address.email)
    time.sleep(3.5)
    assert not finished.exists(), 'the killed worker continued after the gate was released'


@pytest.mark.django_db(transaction=True)
def test_legacy_unlocked_sender_does_not_establish_mixed_fleet_guarantee(creator_factory):
    if connection.vendor != 'postgresql':
        pytest.skip('requires PostgreSQL transactions')
    address = make_email(creator_factory(), 'legacy@example.com', True)
    provider_started = threading.Event()
    release = threading.Event()

    def legacy_sender():
        close_old_connections()
        try:
            assert not OptOutEmail.objects.filter(email=address.email).exists()
            provider_started.set()
            release.wait(5)
        finally:
            connections.close_all()

    worker = threading.Thread(target=legacy_sender)
    worker.start()
    try:
        assert provider_started.wait(5)
        # Old code doesn't acquire the address lock: this insert commits while
        # its invocation remains live. A source test cannot prove pod drain.
        OptOutEmail.objects.create(email=address.email)
        assert worker.is_alive()
    finally:
        release.set()
        worker.join(5)
    assert not worker.is_alive()


@pytest.mark.django_db(transaction=True)
def test_real_provider_process_holds_gate_against_global_optout(
    creator_factory, settings, monkeypatch, tmp_path,
):
    import time
    from pathlib import Path
    from dj.apps.emails import views

    if connection.vendor != 'postgresql':
        pytest.skip('requires PostgreSQL advisory locks')
    settings.EMAIL_SEND_TIMEOUT_SECONDS = 15
    settings.EMAIL_BACKEND = 'dj.apps.emails.test_suppression_policy.DelayedProviderBackend'
    started = tmp_path / 'started'
    finished = tmp_path / 'finished'
    monkeypatch.setenv('RECOVERY_TEST_STARTED', str(started))
    monkeypatch.setenv('RECOVERY_TEST_FINISHED', str(finished))
    address = make_email(creator_factory(), 'process-gate@example.com', True)
    inserted = threading.Event()
    errors = []

    def issue():
        close_old_connections()
        try:
            views.send_password_reset_email(Email.objects.select_related('user').get(pk=address.pk))
        except Exception as exc:
            errors.append(exc)
        finally:
            connections.close_all()

    def insert():
        close_old_connections()
        try:
            OptOutEmail.objects.create(email=address.email)
            inserted.set()
        except Exception as exc:
            errors.append(exc)
        finally:
            connections.close_all()

    sender = threading.Thread(target=issue)
    sender.start()
    other = None
    try:
        deadline = time.monotonic() + 10
        while not Path(started).exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert started.exists(), 'provider process never started'
        other = threading.Thread(target=insert)
        other.start()
        assert not inserted.wait(0.3)
        sender.join(12)
        other.join(12)
        assert finished.exists()
        assert inserted.is_set()
        assert not errors
    finally:
        sender.join(20)
        if other:
            other.join(20)
    assert not sender.is_alive()
    assert other is not None and not other.is_alive()


@pytest.mark.django_db
def test_bulk_insertion_uses_policy_and_address_rewrites_are_rejected():
    from dj.apps.emails.suppression import is_suppressed

    OptOutEmail.objects.bulk_create([OptOutEmail(email='bulk@example.com')])
    assert is_suppressed('bulk@example.com')
    with pytest.raises(ValueError):
        OptOutEmail.objects.filter(email='bulk@example.com').update(email='other@example.com')
    row = OptOutEmail.objects.get(email='bulk@example.com')
    row.email = 'other@example.com'
    with pytest.raises(ValueError):
        row.save()
    assert is_suppressed('bulk@example.com')
    assert not is_suppressed('other@example.com')


@pytest.mark.django_db
def test_bulk_methods_accept_positional_and_keyword_batch_sizes():
    rows = OptOutEmail.objects.bulk_create([OptOutEmail(email='a@example.com')], 1)
    rows += OptOutEmail.objects.bulk_create([OptOutEmail(email='b@example.com')], batch_size=1)
    for row in rows:
        row.link_token = f'link-{row.pk}'
    assert OptOutEmail.objects.bulk_update(rows, ['link_token'], 1) == 2
    assert OptOutEmail.objects.bulk_update(rows, ['link_token'], batch_size=1) == 2
    with pytest.raises(ValueError):
        OptOutEmail.objects.bulk_update(rows, ['email'], 1)


class ParentDeathBackend:
    def __init__(self, **kwargs):
        import os
        import time
        from pathlib import Path
        Path(os.environ['RECOVERY_BOOT_MARKER']).write_text('boot')
        time.sleep(4)

    def send_messages(self, messages):
        import os
        from pathlib import Path
        Path(os.environ['RECOVERY_SEND_MARKER']).write_text('sent')
        return len(messages)


@pytest.mark.django_db(transaction=True)
def test_parent_death_kills_bootstrapping_provider_before_gate_release(creator_factory, tmp_path, monkeypatch):
    import os
    import subprocess
    import sys
    import time

    if not sys.platform.startswith('linux') or connection.vendor != 'postgresql':
        pytest.skip('Linux parent-death signal and PostgreSQL required')
    address = make_email(creator_factory(), 'parent-death@example.com', True)
    boot, sent = tmp_path / 'boot', tmp_path / 'sent'
    env = os.environ.copy()
    env.update(RECOVERY_BOOT_MARKER=str(boot), RECOVERY_SEND_MARKER=str(sent),
               DBNAME=connection.settings_dict['NAME'])
    code = '''
import django
django.setup()
from django.conf import settings
from dj.apps.emails.models import Email
from dj.apps.emails.views import send_password_reset_email
settings.EMAIL_BACKEND = "dj.apps.emails.test_suppression_policy.ParentDeathBackend"
settings.EMAIL_SEND_TIMEOUT_SECONDS = 15
send_password_reset_email(Email.objects.select_related("user").get(pk=int(__import__("sys").argv[1])))
'''
    parent = subprocess.Popen([sys.executable, '-c', code, str(address.pk)], env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 10
        while not boot.exists() and parent.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        assert boot.exists(), 'provider did not reach bootstrap'
        parent.kill()
        parent.wait(timeout=5)
        OptOutEmail.objects.create(email=address.email)
        time.sleep(4.5)
        assert not sent.exists(), 'orphan provider started after the gate owner died'
    finally:
        if parent.poll() is None:
            parent.kill()
            parent.wait(timeout=5)


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('lock_kind', ['account', 'address'])
def test_held_recovery_gate_is_bounded_and_reset_response_remains_generic(
    creator_factory, api_client, mocker, lock_kind,
):
    import time
    from rest_framework.test import APIClient
    from dj.apps.emails.suppression import lock_addresses
    from dj.apps.emails import views
    if connection.vendor != 'postgresql':
        pytest.skip('requires PostgreSQL locks')
    address = make_email(creator_factory(), 'busy-gate@example.com', True)
    held, release = threading.Event(), threading.Event()
    errors = []

    def hold():
        close_old_connections()
        try:
            with transaction.atomic():
                if lock_kind == 'account':
                    Creator.objects.select_for_update().get(pk=address.user_id)
                else:
                    lock_addresses([address.email])
                held.set()
                assert release.wait(20)
        except Exception as exc:
            errors.append(exc)
        finally:
            connections.close_all()

    worker = threading.Thread(target=hold)
    worker.start()
    send = mocker.spy(views, '_bounded_recovery_send')
    try:
        assert held.wait(5)
        before = time.monotonic()
        response = api_client.post('/api/emails/reset-password', {'email': address.email}, format='json')
        assert time.monotonic() - before < 10
        unknown = APIClient().post('/api/emails/reset-password', {'email': 'unknown@example.com'}, format='json')
        assert response.status_code == unknown.status_code == 200
        assert response.content == unknown.content
        assert all(call.args[0] is None for call in send.call_args_list)
        assert not PasswordResetToken.objects.filter(email=address, used=False).exists()
    finally:
        release.set()
        worker.join(10)
    assert not worker.is_alive()
    assert not errors
    # Use real backend after release; retry can reach the provider again.
    mocker.stop(send)
    retry = APIClient().post('/api/emails/reset-password', {'email': address.email}, format='json')
    assert retry.status_code == 200
    assert PasswordResetToken.objects.filter(email=address, used=False).exists()


@pytest.mark.django_db(transaction=True)
def test_recovery_timeout_settings_do_not_leak_from_nested_transaction():
    from dj.apps.emails.views import _bounded_recovery_transaction
    if connection.vendor != 'postgresql':
        pytest.skip('requires PostgreSQL local settings')
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL lock_timeout = '9s'")
            cursor.execute("SET LOCAL statement_timeout = '19s'")
        with _bounded_recovery_transaction():
            with connection.cursor() as cursor:
                cursor.execute("SELECT current_setting('lock_timeout'), current_setting('statement_timeout')")
                assert cursor.fetchone() == ('2s', '5s')
        with pytest.raises(RuntimeError):
            with _bounded_recovery_transaction():
                raise RuntimeError('rollback')
        with connection.cursor() as cursor:
            cursor.execute("SELECT current_setting('lock_timeout'), current_setting('statement_timeout')")
            assert cursor.fetchone() == ('9s', '19s')
