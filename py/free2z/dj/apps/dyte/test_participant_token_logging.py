"""Provider-controlled content must not escape through logs or exceptions."""
import logging
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests

from .client import DyteClient, ProviderError

TOKEN = 'eyJhbGciOiJIUzI1NiJ9.private-participant-token.sig'
ROOM = '11111111-2222-3333-4444-555555555555'


@pytest.mark.parametrize('status', [200, 400, 401, 403, 404, 429, 500])
@pytest.mark.parametrize('message', [TOKEN, f'failed with {TOKEN}',
    {'nested': {'authToken': TOKEN}}, ['opaque-secret'], 'short-secret'])
def test_participant_response_secrecy(status, message, caplog):
    body = {'success': status == 200, 'data': {'id': ROOM, 'token': TOKEN}}
    if status in (400, 401, 403, 404, 429, 500):
        body['error'] = {'message': message, 'details': {'token': TOKEN}}
    response = SimpleNamespace(status_code=status, json=lambda: body)
    transport = Mock(request=Mock(return_value=response))
    dc = DyteClient(transport=transport)
    creator = SimpleNamespace(is_authenticated=True, username='viewer', avatar_image=None)
    cm = SimpleNamespace(creator_id=1, creator=creator)
    with caplog.at_level(logging.DEBUG):
        if status == 200:
            assert dc.add_participant(creator, ROOM, role='viewer', cm=cm).json()['data']['token'] == TOKEN
        else:
            with pytest.raises(ProviderError) as caught:
                dc.add_participant(creator, ROOM, role='viewer', cm=cm)
            assert TOKEN not in str(caught.value)
            assert 'short-secret' not in str(caught.value)
    assert TOKEN not in caplog.text
    assert 'test-only-api-token' not in caplog.text
    assert 'short-secret' not in caplog.text


@pytest.mark.parametrize('secret', ['s3', 'a-b', '秘密', TOKEN])
@pytest.mark.parametrize('operation', ['create', 'host', 'viewer'])
@pytest.mark.parametrize('failure', ['http', 'transport', 'json', 'list', 'null', 'scalar', 'missing-token'])
def test_all_client_call_paths_keep_secrets_out_of_logged_tracebacks(
    secret, operation, failure, caplog,
):
    import requests
    response = SimpleNamespace(status_code=200, json=lambda: {'success': True, 'data': {}})
    transport = Mock()
    transport.request.return_value = response
    if failure == 'http':
        response.status_code = 400
        response.json = lambda: {'success': False, 'error': {'message': secret}, 'data': {'token': secret}}
    elif failure == 'transport':
        transport.request.side_effect = requests.ConnectionError(f'Bearer {secret}')
    elif failure == 'json':
        response.json = Mock(side_effect=ValueError(f'invalid JSON containing {secret}'))
    else:
        body = {'list': [secret], 'null': None, 'scalar': secret,
                'missing-token': {'success': True, 'data': {'token': secret}}}[failure]
        response.json = lambda: body
    dc = DyteClient(transport=transport, api_token=secret)
    creator = SimpleNamespace(is_authenticated=True, username='viewer', avatar_image=None)
    cm = SimpleNamespace(creator_id=1, creator=creator)
    logger = logging.getLogger('rtk.safe.caller')
    with caplog.at_level(logging.DEBUG):
        with pytest.raises(ProviderError):
            try:
                if operation == 'create':
                    dc.create_meeting('creator')
                else:
                    dc.add_participant(creator, ROOM, role=operation, cm=cm)
            except ProviderError:
                # Exercise the actual traceback formatting used by callers,
                # including suppressed transport/JSON exception contexts.
                logger.exception('Provider operation failed')
                raise
    assert secret not in caplog.text
    assert 'Traceback (most recent call last)' in caplog.text


@pytest.mark.django_db
@pytest.mark.parametrize('role', ['host', 'viewer'])
@pytest.mark.parametrize('failure', ['transport', 'http', 'json', 'malformed'])
@pytest.mark.parametrize('secret', ['a-b', TOKEN])
def test_shipping_join_failures_do_not_log_provider_secrets(
    role, failure, secret, caplog, mocker, creator_factory, api_client, settings,
):
    from decimal import Decimal
    from .models import CreatorMeeting
    settings.DYTE_HOST_EVICTION_JOBS_ENABLED = True
    host = creator_factory(username='log-host', tuzis=Decimal('1000'))
    viewer = creator_factory(username='log-viewer')
    CreatorMeeting.objects.create(creator=host, meeting_id=ROOM, meeting_type='broadcast',
                                  is_public=True, live_now=True)
    transport = Mock()
    if failure == 'transport':
        transport.request.side_effect = requests.ConnectionError(secret)
    else:
        response = SimpleNamespace(status_code=400 if failure == 'http' else 200,
                                   json=lambda: {'success': False, 'error': {'message': secret}, 'data': {'token': secret}})
        if failure == 'json':
            response.json = Mock(side_effect=ValueError(secret))
        elif failure == 'malformed':
            response.json = lambda: [secret]
        transport.request.return_value = response
    dc = DyteClient(transport=transport, api_token=secret)
    mocker.patch('dj.apps.dyte.views.DyteClient', return_value=dc)
    api_client.force_authenticate(host if role == 'host' else viewer)
    with caplog.at_level(logging.DEBUG):
        result = api_client.post('/api/dyte/log-host/broadcast', {'role': role}, format='json')
    assert result.status_code == 503
    assert secret not in caplog.text


@pytest.mark.django_db
@pytest.mark.parametrize('secret', ['a-b', TOKEN])
@pytest.mark.parametrize('outcome', ['success', 'http', 'transport', 'json', 'malformed'])
def test_shipping_create_meeting_has_safe_logs(outcome, secret, creator_factory, caplog):
    caplog.set_level(logging.DEBUG)
    from .models import CreatorMeeting
    from .views import _create_meeting
    creator = creator_factory(username='log-create')
    cm = CreatorMeeting.objects.create(creator=creator, meeting_type='broadcast', is_public=True)
    transport = Mock()
    response = SimpleNamespace(status_code=200, json=lambda: {'success': True, 'data': {'id': ROOM, 'token': secret}})
    transport.request.return_value = response
    if outcome == 'transport':
        transport.request.side_effect = requests.ConnectionError(secret)
    elif outcome == 'http':
        response.status_code = 400
        response.json = lambda: {'success': False, 'error': {'message': secret}, 'data': {'token': secret}}
    elif outcome == 'json':
        response.json = Mock(side_effect=ValueError(secret))
    elif outcome == 'malformed':
        response.json = lambda: [secret]
    dc = DyteClient(transport=transport)
    if outcome == 'success':
        assert _create_meeting(cm, dc).meeting_id == ROOM
    else:
        with pytest.raises(ProviderError):
            try:
                _create_meeting(cm, dc)
            except ProviderError:
                logging.getLogger('rtk.safe.caller').exception('Meeting creation failed')
                raise
    assert secret not in caplog.text
