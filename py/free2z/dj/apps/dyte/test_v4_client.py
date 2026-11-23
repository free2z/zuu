"""Injected v4 control-plane tests; no network or live credentials."""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests

from .client import (
    DyteClient, ProviderAuthError, ProviderNotFoundError, ProviderRateLimitError,
    ProviderUnavailableError, ProviderInvalidResponse, ProviderRejectedError,
)

ROOM = '182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e'
SECRET = 'participant-token-and-api-secret'


def response(status=200, data=None, **body):
    return SimpleNamespace(status_code=status, json=lambda: {
        'success': True, 'data': {} if data is None else data, **body,
    })


def client(*responses):
    transport = Mock()
    transport.request.side_effect = responses
    return DyteClient(transport=transport, account_id='a' * 32,
                      app_id=ROOM, api_token=SECRET), transport


def test_create_payload_and_deadlines(settings):
    settings.DYTE_CONNECT_TIMEOUT_SECONDS = 1.25
    settings.DYTE_READ_TIMEOUT_SECONDS = 4.5
    dc, transport = client(response(data={'id': ROOM}))
    assert dc.create_meeting('creator').json()['data']['id'] == ROOM
    args, kwargs = transport.request.call_args
    assert args == ('POST', f'https://api.cloudflare.com/client/v4/accounts/{"a" * 32}/realtime/kit/{ROOM}/meetings')
    assert kwargs == dict(json={'title': 'creator'}, params=None,
                          headers={'Authorization': f'Bearer {SECRET}', 'Content-Type': 'application/json'},
                          timeout=(1.25, 4.5), allow_redirects=False)


@pytest.mark.parametrize('status,error', [(401, ProviderAuthError), (403, ProviderAuthError),
    (404, ProviderNotFoundError), (429, ProviderRateLimitError),
    (500, ProviderUnavailableError), (302, ProviderUnavailableError), (400, ProviderRejectedError)])
def test_status_and_secrecy(status, error, caplog):
    dc, _ = client(response(status, {'token': SECRET}, error={'message': SECRET}))
    with pytest.raises(error) as caught:
        dc.create_meeting('creator')
    assert SECRET not in str(caught.value) + repr(caught.value) + caplog.text
    assert caught.value.request is None and caught.value.response is None


@pytest.mark.parametrize('failure', [requests.ConnectTimeout(SECRET), requests.ReadTimeout(SECRET), requests.ConnectionError(SECRET)])
def test_transport_failure(failure, caplog):
    dc, _ = client(failure)
    with pytest.raises(ProviderUnavailableError) as caught:
        dc.create_meeting('creator')
    assert caught.value.__suppress_context__
    assert SECRET not in str(caught.value) + caplog.text


@pytest.mark.parametrize('body', [[], {}, {'success': 1, 'data': {}},
    {'success': False, 'data': {}}, {'success': True, 'data': None},
    {'success': True, 'data': {'id': 'bad'}},
    {'success': True, 'data': {'id': ROOM}, 'error': {'message': SECRET}}])
def test_invalid_envelope(body):
    dc, _ = client(SimpleNamespace(status_code=200, json=lambda: body))
    with pytest.raises(ProviderInvalidResponse):
        dc.create_meeting('creator')


def test_invalid_json():
    dc, _ = client(SimpleNamespace(status_code=200, json=Mock(side_effect=ValueError(SECRET))))
    with pytest.raises(ProviderInvalidResponse):
        dc.create_meeting('creator')


def test_idle_requires_confirmed_meeting():
    dc, transport = client(response(404), response(data={'id': ROOM}))
    assert dc.get_participants_count(ROOM) == 0
    assert transport.request.call_count == 2
    dc, _ = client(response(404), response(404))
    with pytest.raises(ProviderNotFoundError):
        dc.get_participants_count(ROOM)


@pytest.mark.parametrize('count', [True, -1, '3', None])
def test_invalid_count(count):
    dc, _ = client(response(data={'live_participants': count}))
    with pytest.raises(ProviderInvalidResponse):
        dc.get_participants_count(ROOM)


@pytest.mark.parametrize('role,preset', [('host', 'webinar1'), ('viewer', 'webinar-participant')])
def test_participant_payload(role, preset, settings):
    settings.CANONICAL_ORIGIN = 'https://stage.example'
    creator = SimpleNamespace(is_authenticated=True, username='owner', avatar_image=None)
    cm = SimpleNamespace(creator=creator, creator_id=1)
    dc, transport = client(response(data={'id': ROOM, 'token': SECRET}))
    assert dc.add_participant(creator, ROOM, role=role, custom_participant_id='host_claim', cm=cm).json()['data']['token'] == SECRET
    payload = transport.request.call_args.kwargs['json']
    assert payload['preset_name'] == preset
    assert payload['custom_participant_id'] == 'host_claim'
    assert payload['name'] == 'owner'
    assert payload['picture'].startswith('https://stage.example/')


def test_retirement_order():
    dc, transport = client(response(), response())
    assert dc.retire_participant(ROOM, ROOM)
    calls = transport.request.call_args_list
    assert calls[0].args[0] == 'POST' and calls[0].args[1].endswith('/active-session/kick')
    assert calls[0].kwargs['json'] == {'participant_ids': [ROOM]}
    assert calls[1].args[0] == 'DELETE' and calls[1].args[1].endswith('/participants/' + ROOM)


def test_missing_config():
    dc, transport = client()
    dc.account_id = ''
    with pytest.raises(ProviderAuthError):
        dc.create_meeting('creator')
    transport.request.assert_not_called()


def test_recording_transport_payload_keeps_short_deadline():
    dc, transport = client(response(data={'id': ROOM}))
    payload = {'meeting_id': ROOM, 'url': 'https://stage.example/tools/recording/index.html', 'max_seconds': 14400}
    dc.request('POST', 'recordings', payload=payload, timeout=(2, 3))
    assert transport.request.call_args.args[1].endswith('/recordings')
    assert transport.request.call_args.kwargs['json'] == payload
    assert transport.request.call_args.kwargs['timeout'] == (2, 3)


def test_public_signing_key_fetch_has_no_credential(settings):
    dc, transport = client()
    transport.get.return_value = response(data={'publicKey': 'test-public-key'})
    assert dc.webhook_public_key() == 'test-public-key'
    args, kwargs = transport.get.call_args
    assert args == ('https://api.realtime.cloudflare.com/.well-known/webhooks.json',)
    assert 'headers' not in kwargs and 'auth' not in kwargs
    assert kwargs['allow_redirects'] is False
    assert kwargs['timeout'] == (settings.DYTE_CONNECT_TIMEOUT_SECONDS, settings.DYTE_KEY_FETCH_TIMEOUT_SECONDS)


def test_retirement_does_not_confirm_a_missing_app_as_retired():
    dc, _ = client(response(404), response(404))
    assert dc.kick_participants(ROOM, [ROOM]) is False
    dc, _ = client(response(404), response(data={'id': ROOM}))
    assert dc.kick_participants(ROOM, [ROOM]) is True


def test_documented_optional_delete_acknowledgement():
    dc, _ = client(response(), SimpleNamespace(status_code=200, json=lambda: {'success': True}))
    assert dc.retire_participant(ROOM, ROOM)
    dc, _ = client(SimpleNamespace(status_code=200, json=lambda: {'success': True}))
    with pytest.raises(ProviderInvalidResponse):
        dc.create_meeting('creator')


def test_pooled_session_does_not_import_ambient_auth(monkeypatch):
    import threading
    from . import client as module
    monkeypatch.setattr(module, '_SESSION_LOCAL', threading.local())
    session = module._session()
    try:
        assert session.trust_env is False
        assert session.auth is None
        assert 'Authorization' not in session.headers
    finally:
        session.close()


@pytest.mark.parametrize('data', [None, [], 'unexpected'])
def test_malformed_mutation_acknowledgement_is_not_retirement(data):
    dc, _ = client(SimpleNamespace(status_code=200, json=lambda: {'success': True, 'data': data}))
    assert dc.kick_participants(ROOM, [ROOM]) is False


@pytest.mark.parametrize('body', [
    [], None, 'short-secret', 17, True, {},
    {'success': True}, {'success': True, 'data': None},
    {'success': True, 'data': []}, {'success': True, 'data': {}},
    {'success': True, 'data': {'publicKey': None}},
    {'success': True, 'data': {'publicKey': ''}},
    {'success': False, 'data': {'publicKey': 'short-secret'}},
])
def test_public_key_malformed_shapes_are_typed_and_safe(body, caplog):
    import logging
    dc, transport = client()
    transport.get.return_value = SimpleNamespace(status_code=200, json=lambda: body)
    with pytest.raises(ProviderInvalidResponse):
        try:
            dc.webhook_public_key()
        except ProviderInvalidResponse:
            logging.getLogger(__name__).exception('Public key unavailable')
            raise
    assert 'short-secret' not in caplog.text
    assert SECRET not in caplog.text


@pytest.mark.parametrize('requests_ca,curl_ca,expected', [
    ('requests.pem', 'curl.pem', 'requests.pem'),
    ('', 'curl.pem', 'curl.pem'), ('', '', True),
])
def test_selected_ci_ca_reaches_adapter_without_ambient_auth(
    monkeypatch, tmp_path, requests_ca, curl_ca, expected,
):
    import threading
    from requests.adapters import BaseAdapter
    from . import client as module

    monkeypatch.setenv('REQUESTS_CA_BUNDLE', requests_ca)
    monkeypatch.setenv('CURL_CA_BUNDLE', curl_ca)
    monkeypatch.setenv('HTTPS_PROXY', 'http://proxy-user:proxy-secret@proxy.invalid')
    netrc = tmp_path / 'netrc'
    netrc.write_text('machine trust.invalid login ambient-user password ambient-secret\n')
    monkeypatch.setenv('NETRC', str(netrc))
    monkeypatch.setattr(module, '_SESSION_LOCAL', threading.local())
    sent = []

    class NoNetworkAdapter(BaseAdapter):
        def send(self, request, **kwargs):
            sent.append((request, kwargs))
            response = requests.Response()
            response.status_code = 200
            response._content = b'{}'
            return response

        def close(self):
            pass

    session = module._session()
    session.mount('https://', NoNetworkAdapter())
    try:
        session.get('https://trust.invalid/', headers={'Authorization': 'Bearer explicit-token'})
        request, options = sent[0]
        assert request.headers['Authorization'] == 'Bearer explicit-token'
        assert options['verify'] == expected
        assert options['proxies'] == {}
        assert 'Proxy-Authorization' not in request.headers
    finally:
        session.close()
