"""Deterministic PostgreSQL locks across enrolment and credential issuance."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, UTC
from io import StringIO
from threading import Event
from types import SimpleNamespace
import time

import pyotp
import pytest
from django.core.cache import cache
from django.core.management import call_command
from django.db import connections, connection, transaction
from django.utils import timezone
from knox.models import AuthToken
from rest_framework.test import APIClient

from dj.apps.identity.models import AuthContext
from dj.apps.otp.models import OTPSecret
from dj.apps.otp.utils import check_user_totp, TotpGate
from dj.apps.otp.test_token_issuance import SECRET, PASSWORD, enroll, payload


VERIFICATION_TIME = datetime(2030, 1, 1, 12, 0, 15, tzinfo=UTC)


@pytest.fixture(autouse=True)
def clear_cache(mocker):
    mocker.patch('dj.apps.otp.utils.timezone', SimpleNamespace(now=lambda: VERIFICATION_TIME))
    cache.clear()
    yield
    cache.clear()


def wait_for_block(pid):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        with connection.cursor() as cursor:
            cursor.execute('SELECT cardinality(pg_blocking_pids(%s))', [pid])
            if cursor.fetchone()[0]:
                return
        Event().wait(.01)
    pytest.fail('concurrent operation never blocked on PostgreSQL lock')


def worker(fn, pid, started):
    try:
        with connections['default'].cursor() as cursor:
            cursor.execute('SELECT pg_backend_pid()')
            pid.append(cursor.fetchone()[0])
        started.set()
        return fn()
    finally:
        connections.close_all()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('initial', ['absent', 'pending'])
@pytest.mark.parametrize('issuer', ['exchange', 'password', 'otp'])
def test_issuance_waits_for_enrollment_and_fails_closed(
    creator_factory, mocker, initial, issuer,
):
    user = creator_factory(password=PASSWORD)
    if initial == 'pending':
        OTPSecret.objects.create(user=user, secret=SECRET)
    enroller = APIClient()
    enroller.force_login(user)
    client = APIClient()
    if issuer == 'exchange':
        client.force_login(user)
    mocker.patch('dj.apps.g12f.serializers.creator.siteverify', return_value={'success': True})
    entered, release, started = Event(), Event(), Event()
    pid = []

    def activate():
        try:
            with transaction.atomic():
                seed = SECRET
                if initial == 'absent':
                    setup = enroller.post('/api/otp/setup/')
                    assert setup.status_code == 201
                    seed = setup.json()['secret']
                enabled = enroller.post('/api/otp/enable/', {'token': pyotp.TOTP(seed).at(VERIFICATION_TIME)}, format='json')
                assert enabled.status_code == 200, enabled.content
                entered.set()
                assert release.wait(10)
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        enabling = pool.submit(activate)
        assert entered.wait(10)
        def issue():
            if issuer == 'exchange':
                return client.post('/api/token/login/')
            route = '/api/auth/login/' if issuer == 'password' else '/api/otp/login/'
            return client.post(route, payload(user), format='json')
        issuing = pool.submit(worker, issue, pid, started)
        try:
            assert started.wait(10)
            wait_for_block(pid[0])
        finally:
            release.set()
        enabling.result(timeout=10)
        response = issuing.result(timeout=10)
    assert response.status_code == (403 if issuer == 'exchange' else 400), response.content
    assert not AuthToken.objects.filter(user=user).exists()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('initial', ['absent', 'pending'])
def test_password_gate_holds_no_factor_snapshot_until_issuance_ends(creator_factory, initial):
    user = creator_factory(password=PASSWORD)
    if initial == 'pending':
        OTPSecret.objects.create(user=user, secret=SECRET)
    enroller = APIClient()
    enroller.force_login(user)
    gate_done, release, started = Event(), Event(), Event()
    pid = []

    def issue():
        try:
            with transaction.atomic():
                assert check_user_totp(user, None) is TotpGate.NOT_ENROLLED
                gate_done.set()
                assert release.wait(10)
        finally:
            connections.close_all()

    def enable():
        with transaction.atomic():
            seed = SECRET
            if initial == 'absent':
                setup = enroller.post('/api/otp/setup/')
                assert setup.status_code == 201
                seed = setup.json()['secret']
            enabled = enroller.post('/api/otp/enable/', {'token': pyotp.TOTP(seed).at(VERIFICATION_TIME)}, format='json')
            assert enabled.status_code == 200, enabled.content

    with ThreadPoolExecutor(max_workers=2) as pool:
        issuance = pool.submit(issue)
        assert gate_done.wait(10)
        enrollment = pool.submit(worker, enable, pid, started)
        try:
            assert started.wait(10)
            wait_for_block(pid[0])
        finally:
            release.set()
        issuance.result(timeout=10)
        enrollment.result(timeout=10)
    assert OTPSecret.objects.get(user=user).is_active


@pytest.mark.django_db
def test_old_factor_context_cannot_exchange_after_reenrollment(api_client, creator_factory, mocker):
    user = enroll(creator_factory)
    mocker.patch('dj.apps.g12f.serializers.creator.siteverify', return_value={'success': True})
    code = pyotp.TOTP(SECRET).at(VERIFICATION_TIME)
    assert api_client.post('/api/auth/login/', payload(user, code), format='json').status_code == 204
    response = api_client.post('/api/token/login/')
    assert response.status_code == 200
    token_client = APIClient()
    token_client.credentials(HTTP_AUTHORIZATION=f'Token {response.json()["token"]}')
    assert api_client.delete('/api/otp/disable/', {'password': PASSWORD}, format='json').status_code == 200
    cache.clear()
    setup = api_client.post('/api/otp/setup/')
    assert setup.status_code == 201
    cache.clear()
    code = pyotp.TOTP(setup.json()['secret']).at(VERIFICATION_TIME)
    assert api_client.post('/api/otp/enable/', {'token': code}, format='json').status_code == 200
    # Enrolment does not upgrade the old session or the inherited old bearer.
    assert api_client.post('/api/token/login/').status_code == 403
    assert token_client.post('/api/token/login/').status_code == 403
    assert AuthToken.objects.filter(user=user).count() == 1


@pytest.mark.django_db(transaction=True)
def test_concurrent_revocation_batches_are_exact_and_idempotent(creator_factory):
    user = enroll(creator_factory)
    from dj.apps.identity.auth_context import record_login, AMR_PASSWORD
    rows = [AuthToken.objects.create(user)[0] for _ in range(4)]
    contexts = [record_login(None, user, methods=[AMR_PASSWORD], token=t) for t in rows]
    cutoff = timezone.now() - timedelta(minutes=1)
    AuthToken.objects.filter(pk__in=[t.pk for t in rows]).update(created=cutoff - timedelta(seconds=1))
    from threading import Barrier
    barrier = Barrier(2)

    def revoke():
        try:
            barrier.wait(timeout=10)
            output = StringIO()
            call_command('revoke_pre_totp_tokens', before=cutoff.isoformat(), batch_size=2, apply=True, stdout=output)
            return output.getvalue()
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: revoke(), range(2)))
    assert results == ['Retired 2 tokens\n', 'Retired 2 tokens\n']
    assert not AuthToken.objects.filter(user=user).exists()
    assert not AuthContext.objects.filter(pk__in=[c.pk for c in contexts]).exists()
    output = StringIO()
    call_command('revoke_pre_totp_tokens', before=cutoff.isoformat(), batch_size=2, apply=True, stdout=output)
    assert output.getvalue() == 'Retired 0 tokens\n'


@pytest.mark.django_db
def test_old_pod_context_insert_gets_empty_database_binding(creator_factory):
    """Old pods omit the new column while enforcement rolls out."""
    from dj.apps.identity.auth_context import record_login, AMR_PASSWORD
    user = creator_factory()
    token, _ = AuthToken.objects.create(user)
    context = record_login(None, user, methods=[AMR_PASSWORD], token=token)
    with connection.cursor() as cursor:
        cursor.execute('''
            INSERT INTO identity_authcontext
                (credential_kind, credential_hash, creator_id, auth_time, amr,
                 acr, account_epoch, created_at, updated_at, expires_at)
            SELECT credential_kind, repeat('a', 64), creator_id, auth_time, amr,
                   acr, account_epoch, created_at, updated_at, expires_at
            FROM identity_authcontext WHERE id = %s
            RETURNING otp_binding
        ''', [context.pk])
        assert cursor.fetchone() == ('',)
