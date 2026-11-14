"""Public password-to-session-to-Knox negative controls on real PostgreSQL.

There is no reusable password preauth challenge in this API: password and
OTP are submitted together. Failed attempts create neither session nor token;
the accepted session is the sole exchange authority, bound to its user/epoch.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from io import StringIO
from threading import Barrier
from types import SimpleNamespace

import pyotp
import pytest
from django.core.cache import cache
from django.core.management import call_command
from django.db import connection, connections
from django.utils import timezone
from knox.models import AuthToken
from rest_framework.test import APIClient

from dj.apps.identity.auth_context import AMR_PASSWORD, record_login
from dj.apps.identity.models import AuthContext
from dj.apps.otp.models import OTPSecret

PASSWORD = 'correct-password'
SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'


@pytest.fixture(autouse=True)
def login_boundaries(mocker):
    cache.clear()
    mocker.patch('dj.apps.g12f.serializers.creator.siteverify', return_value={'success': True})
    # Every thread sees one exact verification instant; never sleep across steps.
    now = timezone.now().replace(microsecond=0)
    mocker.patch('dj.apps.otp.utils.timezone', SimpleNamespace(now=lambda: now))
    yield now
    cache.clear()


def payload(user, code=None):
    data = dict(username=user.username, password=PASSWORD, captcha_result='fixture')
    if code is not None:
        data['otp_token'] = code
    return data


def enroll(creator_factory):
    user = creator_factory(password=PASSWORD)
    OTPSecret.objects.create(user=user, secret=SECRET, is_active=True)
    return user


@pytest.mark.django_db
@pytest.mark.parametrize('url', ['/api/token/login/', '/api/auth/login',
                                 '/api/auth/login/', '/api/otp/login/'])
def test_direct_basic_password_never_issues_token(api_client, creator_factory, url):
    user = enroll(creator_factory)
    header = base64.b64encode(f'{user.username}:{PASSWORD}'.encode()).decode()
    api_client.credentials(HTTP_AUTHORIZATION=f'Basic {header}')
    response = api_client.post(url, payload(user), format='json')
    assert response.status_code in (400, 401, 403), response.content
    assert AuthToken.objects.filter(user=user).count() == 0
    assert not api_client.session.get('_auth_user_id')
    assert api_client.get('/api/auth/user/').status_code in (401, 403)


@pytest.mark.django_db
@pytest.mark.parametrize('bad_code', [None, '000000', 'expired', 'other-user'])
def test_refused_proofs_leave_no_exchange_authority(
    api_client, creator_factory, login_boundaries, bad_code,
):
    user = enroll(creator_factory)
    if bad_code == 'expired':
        bad_code = pyotp.TOTP(SECRET).at(login_boundaries - timedelta(seconds=60))
    elif bad_code == 'other-user':
        other = creator_factory()
        seed = pyotp.random_base32()
        OTPSecret.objects.create(user=other, secret=seed, is_active=True)
        bad_code = pyotp.TOTP(seed).at(login_boundaries)
    response = api_client.post('/api/auth/login/', payload(user, bad_code), format='json')
    assert response.status_code == 400, response.content
    assert not api_client.session.get('_auth_user_id')
    assert api_client.post('/api/token/login/').status_code in (401, 403)
    assert not AuthToken.objects.filter(user=user).exists()


@pytest.mark.django_db
def test_atomic_login_exchange_and_replay(api_client, creator_factory, login_boundaries):
    user = enroll(creator_factory)
    code = pyotp.TOTP(SECRET).at(login_boundaries)
    assert api_client.post('/api/auth/login/', payload(user, code), format='json').status_code == 204
    assert AuthToken.objects.filter(user=user).count() == 0
    response = api_client.post('/api/token/login/')
    assert response.status_code == 200, response.content
    assert AuthToken.objects.filter(user=user).count() == 1
    bearer = APIClient()
    bearer.credentials(HTTP_AUTHORIZATION=f'Token {response.json()["token"]}')
    assert bearer.get('/api/auth/user/').status_code == 200
    loser = APIClient()
    assert loser.post('/api/auth/login/', payload(user, code), format='json').status_code == 400
    assert loser.post('/api/token/login/').status_code in (401, 403)
    assert AuthToken.objects.filter(user=user).count() == 1


@pytest.mark.django_db
@pytest.mark.parametrize('proof', ['missing', 'password', 'expired', 'cross-user', 'stale-epoch'])
def test_unproved_session_cannot_exchange(api_client, creator_factory, proof):
    user = enroll(creator_factory)
    api_client.force_login(user)
    if proof != 'missing':
        session = api_client.session
        subject = creator_factory() if proof == 'cross-user' else user
        context = record_login(SimpleNamespace(session=session), subject,
                               methods=[AMR_PASSWORD],
                               second_factor='otp' if proof != 'password' else None)
        from django.conf import settings
        api_client.cookies[settings.SESSION_COOKIE_NAME] = session.session_key
        if proof == 'stale-epoch':
            AuthContext.objects.filter(pk=context.pk).update(account_epoch=0)
        if proof == 'expired':
            AuthContext.objects.filter(pk=context.pk).update(auth_time=timezone.now() - timedelta(days=1), expires_at=timezone.now() - timedelta(seconds=1))
    assert api_client.post('/api/token/login/').status_code == 403
    assert not AuthToken.objects.filter(user=user).exists()


@pytest.mark.django_db(transaction=True)
def test_concurrent_public_completions_issue_exactly_one_token(creator_factory, login_boundaries):
    assert connection.vendor == 'postgresql'
    user = enroll(creator_factory)
    data = payload(user, pyotp.TOTP(SECRET).at(login_boundaries))
    barrier = Barrier(2)

    def complete(index):
        try:
            client = APIClient(REMOTE_ADDR=f'192.0.2.{index + 1}')
            barrier.wait(timeout=10)
            response = client.post('/api/auth/login/', data, format='json')
            exchange = client.post('/api/token/login/')
            if exchange.status_code == 200:
                bearer = APIClient()
                bearer.credentials(HTTP_AUTHORIZATION=f'Token {exchange.json()["token"]}')
                assert bearer.get('/api/auth/user/').status_code == 200
            return response.status_code, exchange.status_code
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(complete, range(2)))
    assert sorted(r[0] for r in results) == [204, 400], results
    assert sum(r[1] == 200 for r in results) == 1, results
    assert AuthToken.objects.filter(user=user).count() == 1


@pytest.mark.django_db
def test_rollout_revocation_is_bounded_idempotent_and_preserves_other_tokens(creator_factory):
    user = enroll(creator_factory)
    other = creator_factory()
    epoch = user.kt_account_epoch
    issued = [AuthToken.objects.create(user) for _ in range(2)]
    old = [row for row, raw in issued]
    bearer = APIClient()
    bearer.credentials(HTTP_AUTHORIZATION=f'Token {issued[0][1]}')
    assert bearer.get('/api/auth/user/').status_code == 200
    assert bearer.post('/api/token/login/').status_code == 403
    keep, _ = AuthToken.objects.create(user)
    unrelated, _ = AuthToken.objects.create(other)
    cutoff = timezone.now() - timedelta(hours=1)
    AuthToken.objects.filter(pk__in=[t.pk for t in old]).update(created=cutoff - timedelta(seconds=1))
    def run(apply=False):
        out = StringIO()
        call_command('revoke_pre_totp_tokens', before=cutoff.isoformat(), batch_size=1,
                     apply=apply, stdout=out)
        return out.getvalue()
    assert 'Would retire 1' in run()
    assert AuthToken.objects.count() == 4
    assert 'Retired 1' in run(True)
    assert 'Retired 1' in run(True)
    assert 'Retired 0' in run(True)
    assert bearer.get('/api/auth/user/').status_code in (401, 403)
    assert set(AuthToken.objects.values_list('pk', flat=True)) == {keep.pk, unrelated.pk}
    user.refresh_from_db()
    assert user.kt_account_epoch == epoch


@pytest.mark.django_db
@pytest.mark.parametrize('state', ['inactive', 'scheduled'])
def test_account_state_blocks_password_and_token(api_client, creator_factory, login_boundaries, state):
    user = enroll(creator_factory)
    # An inactive account cannot use an otherwise correct password and OTP.
    from dj.apps.g12f.models import Creator
    updates = {'is_active': False}
    if state == 'scheduled':
        updates['deletion_requested_at'] = timezone.now()
    Creator.objects.filter(pk=user.pk).update(**updates)
    response = api_client.post('/api/auth/login/', payload(user, pyotp.TOTP(SECRET).at(login_boundaries)), format='json')
    assert response.status_code in (400, 403, 409), response.content
    assert not api_client.session.get('_auth_user_id')
    assert api_client.post('/api/token/login/').status_code in (401, 403)
    assert not AuthToken.objects.filter(user=user).exists()


@pytest.mark.django_db
def test_account_attempt_budget_cannot_be_reset_with_new_client(creator_factory, login_boundaries):
    user = enroll(creator_factory)
    for index in range(5):
        client = APIClient(REMOTE_ADDR=f'192.0.2.{index + 1}')
        response = client.post('/api/auth/login/', payload(user, 'invalid'), format='json')
        assert response.status_code == 400
    client = APIClient(REMOTE_ADDR='192.0.2.100')
    response = client.post('/api/auth/login/', payload(user, pyotp.TOTP(SECRET).at(login_boundaries)), format='json')
    assert response.status_code == 400
    assert not client.session.get('_auth_user_id')
    assert not AuthToken.objects.filter(user=user).exists()


@pytest.mark.django_db
def test_counter_outage_fails_closed(api_client, creator_factory, login_boundaries, mocker):
    user = enroll(creator_factory)
    mocker.patch('dj.apps.otp.utils.claim_totp_attempt', return_value=None)
    response = api_client.post('/api/auth/login/', payload(user, pyotp.TOTP(SECRET).at(login_boundaries)), format='json')
    assert response.status_code == 400
    assert not api_client.session.get('_auth_user_id')
    assert not AuthToken.objects.filter(user=user).exists()


@pytest.mark.django_db
def test_failed_session_issuance_rolls_back_otp_consume(api_client, creator_factory, login_boundaries, mocker):
    user = enroll(creator_factory)
    data = payload(user, pyotp.TOTP(SECRET).at(login_boundaries))
    record = mocker.patch('dj.apps.g12f.views.creator.record_login', side_effect=RuntimeError('issuance failed'))
    with pytest.raises(RuntimeError, match='issuance failed'):
        api_client.post('/api/auth/login/', data, format='json')
    assert OTPSecret.objects.get(user=user).last_used_at is None
    assert not AuthToken.objects.filter(user=user).exists()
    record.side_effect = None


@pytest.mark.django_db
def test_failed_exchange_does_not_leave_a_token(api_client, creator_factory, login_boundaries, mocker):
    user = enroll(creator_factory)
    assert api_client.post('/api/auth/login/', payload(user, pyotp.TOTP(SECRET).at(login_boundaries)), format='json').status_code == 204
    mocker.patch('dj.free2z.urls.LoginView.get_post_response_data', side_effect=RuntimeError('exchange failed'))
    with pytest.raises(RuntimeError, match='exchange failed'):
        api_client.post('/api/token/login/')
    assert not AuthToken.objects.filter(user=user).exists()
    assert not AuthContext.objects.filter(creator=user, credential_kind=AuthContext.Kind.KNOX).exists()


@pytest.mark.django_db
@pytest.mark.parametrize('before,size', [('not-a-date', 1), ('2035-01-01T00:00:00Z', 1),
                                         ('2020-01-01T00:00:00', 1), ('2020-01-01T00:00:00Z', 0)])
def test_rollout_rejects_unsafe_bounds(before, size):
    from django.core.management.base import CommandError
    with pytest.raises(CommandError):
        call_command('revoke_pre_totp_tokens', before=before, batch_size=size, apply=True)


@pytest.mark.django_db
def test_rollout_forgets_only_retired_token_contexts(creator_factory):
    user = enroll(creator_factory)
    old, _ = AuthToken.objects.create(user)
    keep, _ = AuthToken.objects.create(user)
    contexts = [record_login(None, user, methods=[AMR_PASSWORD], token=t) for t in (old, keep)]
    cutoff = timezone.now() - timedelta(minutes=1)
    AuthToken.objects.filter(pk=old.pk).update(created=cutoff - timedelta(seconds=1))
    call_command('revoke_pre_totp_tokens', before=cutoff.isoformat(), apply=True, stdout=StringIO())
    assert not AuthContext.objects.filter(pk=contexts[0].pk).exists()
    assert AuthContext.objects.filter(pk=contexts[1].pk).exists()
