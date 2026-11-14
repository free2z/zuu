"""Dual-mode credentials (v4 Bearer / legacy v2 Basic) and the failure-log
contract that alerting depends on. Injected transports only; no network."""
import base64
import json
import logging
from io import StringIO
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests
from django.core.management import call_command

from . import client as module
from .client import (
    DyteClient, ProviderAuthError, ProviderNotFoundError,
    ProviderUnavailableError, ProviderInvalidResponse, PROVIDER_FAILURE_EVENT,
    MODE_SELECTED_EVENT, log_auth_mode, operation_for, resolve_auth_mode,
)

ROOM = '182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e'
ORG = '7dba0970-3d0b-45e4-97dc-17029162fcc5'
V2_KEY = 'legacy-org-api-key-value'
V4_TOKEN = 'test-only-api-token'


def response(status=200, data=None, **body):
    return SimpleNamespace(status_code=status, json=lambda: {
        'success': 200 <= status < 300, 'data': {} if data is None else data,
        **body,
    })


def transport(*responses):
    t = Mock()
    t.request.side_effect = responses
    return t


def events(caplog, event=PROVIDER_FAILURE_EVENT):
    out = []
    for record in caplog.records:
        try:
            payload = json.loads(record.getMessage())
        except ValueError:
            continue
        if isinstance(payload, dict) and payload.get('event') == event:
            out.append((record, payload))
    return out


@pytest.fixture
def legacy_only(settings):
    settings.RTK_API_MODE = 'auto'
    settings.RTK_ACCOUNT_ID = ''
    settings.RTK_APP_ID = ''
    settings.RTK_API_TOKEN = ''
    settings.DYTE_ORG = ORG
    settings.DYTE_KEY = V2_KEY
    settings.RTK_API_BASE_URL = 'https://api.realtime.cloudflare.com'


# --------------------------------------------------------------------------- #
# Mode selection
# --------------------------------------------------------------------------- #
def test_auto_prefers_v4_when_all_three_values_present(settings):
    settings.DYTE_ORG, settings.DYTE_KEY = ORG, V2_KEY
    assert DyteClient().auth_mode == 'v4'


@pytest.mark.parametrize('missing', ['RTK_ACCOUNT_ID', 'RTK_APP_ID', 'RTK_API_TOKEN'])
def test_auto_falls_back_to_v2_when_any_v4_value_missing(settings, legacy_only, missing):
    settings.RTK_ACCOUNT_ID, settings.RTK_APP_ID = 'a' * 32, ROOM
    settings.RTK_API_TOKEN = V4_TOKEN
    setattr(settings, missing, '')
    assert DyteClient().auth_mode == 'v2'


def test_old_secret_only_is_unchanged_v2_behaviour(legacy_only):
    t = transport(response(data={'id': ROOM}))
    DyteClient(transport=t).create_meeting('creator')
    args, kwargs = t.request.call_args
    assert args == ('POST', 'https://api.realtime.cloudflare.com/v2/meetings')
    expected = base64.b64encode(f'{ORG}:{V2_KEY}'.encode()).decode()
    assert kwargs['headers'] == {'Authorization': f'Basic {expected}',
                                 'Content-Type': 'application/json'}
    assert kwargs['json'] == {'title': 'creator'}
    assert kwargs['allow_redirects'] is False


def test_v2_base_url_override_is_honoured(legacy_only, settings):
    settings.RTK_API_BASE_URL = 'https://api.dyte.io/'
    t = transport(response(data={'id': ROOM}))
    DyteClient(transport=t).create_meeting('creator')
    assert t.request.call_args.args[1] == 'https://api.dyte.io/v2/meetings'


@pytest.mark.parametrize('base', ['http://api.dyte.io', 'https://x/y', '', 'ftp://a'])
def test_v2_rejects_unsafe_base_url_without_sending(legacy_only, settings, base):
    settings.RTK_API_BASE_URL = base
    t = transport()
    with pytest.raises(ProviderAuthError):
        DyteClient(transport=t).create_meeting('creator')
    t.request.assert_not_called()


def test_forced_v2_ignores_present_v4_values(settings):
    settings.RTK_API_MODE = 'v2'
    settings.DYTE_ORG, settings.DYTE_KEY = ORG, V2_KEY
    t = transport(response(data={'id': ROOM}))
    dc = DyteClient(transport=t)
    assert dc.auth_mode == 'v2'
    dc.create_meeting('creator')
    assert t.request.call_args.args[1].endswith('/v2/meetings')


def test_forced_v4_without_v4_values_fails_closed(legacy_only, settings, caplog):
    settings.RTK_API_MODE = 'v4'
    t = transport()
    dc = DyteClient(transport=t)
    assert dc.auth_mode == 'v4'
    with pytest.raises(ProviderAuthError) as caught:
        dc.create_meeting('creator')
    t.request.assert_not_called()
    assert caught.value.status == 0
    [(record, payload)] = events(caplog)
    assert record.levelno == logging.ERROR
    assert payload['reason'] == 'not_configured' and payload['auth_mode'] == 'v4'


@pytest.mark.parametrize('value', ['V4 ', 'v4'])
def test_mode_value_is_case_and_space_insensitive(settings, value):
    settings.RTK_API_MODE = value
    assert resolve_auth_mode() == 'v4'


def test_unknown_mode_degrades_to_auto_and_is_reported(settings, caplog):
    settings.RTK_API_MODE = 'v3'
    assert resolve_auth_mode() == 'v4'
    report = log_auth_mode()
    assert report['configured_mode'] == 'invalid'
    [(record, payload)] = events(caplog, MODE_SELECTED_EVENT)
    assert record.levelno == logging.WARNING and payload['severity'] == 'WARNING'


def test_explicit_constructor_values_imply_their_mode(legacy_only):
    assert DyteClient(account_id='a' * 32, app_id=ROOM, api_token='t').auth_mode == 'v4'
    assert DyteClient(org=ORG, key=V2_KEY).auth_mode == 'v2'


def test_mode_is_fixed_at_construction(settings):
    t = transport()
    dc = DyteClient(transport=t)
    dc.account_id = ''
    with pytest.raises(ProviderAuthError):
        dc.create_meeting('creator')
    t.request.assert_not_called()


@pytest.mark.parametrize('org,key', [('', V2_KEY), (ORG, ''), ('a:b', V2_KEY),
                                     (ORG, 'k\r\nX-Evil: 1')])
def test_v2_unusable_credentials_fail_closed(legacy_only, settings, org, key):
    settings.DYTE_ORG, settings.DYTE_KEY = org, key
    t = transport()
    with pytest.raises(ProviderAuthError):
        DyteClient(transport=t).create_meeting('creator')
    t.request.assert_not_called()


def test_same_relative_paths_in_both_modes(legacy_only):
    """The v4 routes are the v2 routes under /accounts/{a}/realtime/kit/{app}."""
    v2 = transport(response(), response())
    v4 = transport(response(), response())
    DyteClient(transport=v2).retire_participant(ROOM, ROOM)
    DyteClient(transport=v4, account_id='a' * 32, app_id=ORG,
               api_token=V4_TOKEN).retire_participant(ROOM, ROOM)
    v2_paths = [c.args[1].split('/v2/', 1)[1] for c in v2.request.call_args_list]
    v4_paths = [c.args[1].split(f'/realtime/kit/{ORG}/', 1)[1]
                for c in v4.request.call_args_list]
    assert v2_paths == v4_paths == [
        f'meetings/{ROOM}/active-session/kick', f'meetings/{ROOM}/participants/{ROOM}']


def test_v2_idle_room_still_reads_zero(legacy_only):
    t = transport(response(404, error={'code': 404}), response(data={'id': ROOM}))
    assert DyteClient(transport=t).get_participants_count(ROOM) == 0


# --------------------------------------------------------------------------- #
# rtk_provider_request_failed -- the alerting contract
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize('mode', ['v4', 'v2'])
@pytest.mark.parametrize('status,level', [(401, logging.ERROR), (403, logging.ERROR),
                                          (400, logging.WARNING), (404, logging.WARNING),
                                          (429, logging.WARNING), (500, logging.WARNING),
                                          (302, logging.WARNING)])
def test_failure_event_schema(settings, legacy_only, caplog, mode, status, level):
    settings.RTK_API_MODE = mode
    settings.RTK_ACCOUNT_ID, settings.RTK_APP_ID = 'a' * 32, ROOM
    settings.RTK_API_TOKEN = V4_TOKEN
    body = SimpleNamespace(status_code=status, json=lambda: {
        'success': False, 'error': {'code': status, 'message': 'secret-prose ' + V2_KEY},
        'errors': [{'code': 10000, 'message': V4_TOKEN}]})
    with caplog.at_level(logging.DEBUG):
        with pytest.raises(module.ProviderError) as caught:
            DyteClient(transport=transport(body)).create_meeting('creator')
    assert caught.value.status == status
    [(record, payload)] = events(caplog)
    assert record.levelno == level
    assert record.name == 'dj.apps.dyte.client'
    assert payload == {
        'severity': logging.getLevelName(level),
        'message': payload['message'],
        'event': 'rtk_provider_request_failed',
        'operation': 'create_meeting',
        'status': status,
        'auth_mode': mode,
        'reason': 'http_status',
        'provider_code': status,
    }
    for secret in (V2_KEY, V4_TOKEN, 'secret-prose', ORG,
                   base64.b64encode(f'{ORG}:{V2_KEY}'.encode()).decode()):
        assert secret not in caplog.text
    # One physical line of JSON: what GKE promotes to jsonPayload.
    assert '\n' not in record.getMessage()


def test_v4_envelope_provider_code(caplog):
    body = SimpleNamespace(status_code=403, json=lambda: {
        'success': False, 'errors': [{'code': 10000, 'message': 'Authentication error'}]})
    with pytest.raises(ProviderAuthError):
        DyteClient(transport=transport(body)).create_meeting('creator')
    [(_, payload)] = events(caplog)
    assert payload['provider_code'] == 10000


@pytest.mark.parametrize('code', ['401', True, None, {'x': 1}, 'eyJ.secret.sig'])
def test_non_integer_provider_code_is_omitted(caplog, code):
    body = SimpleNamespace(status_code=401, json=lambda: {'error': {'code': code}})
    with pytest.raises(ProviderAuthError):
        DyteClient(transport=transport(body)).create_meeting('creator')
    [(_, payload)] = events(caplog)
    assert 'provider_code' not in payload


def test_non_json_error_body_still_reports(caplog):
    body = SimpleNamespace(status_code=502, json=Mock(side_effect=ValueError('<html>')))
    with pytest.raises(ProviderUnavailableError):
        DyteClient(transport=transport(body)).create_meeting('creator')
    [(record, payload)] = events(caplog)
    assert payload['status'] == 502 and record.levelno == logging.WARNING
    assert 'provider_code' not in payload


def test_transport_error_reports_status_zero(caplog):
    with pytest.raises(ProviderUnavailableError):
        DyteClient(transport=transport(requests.ConnectTimeout(V4_TOKEN))).add_participant(
            SimpleNamespace(is_authenticated=True, username='u', avatar_image=None), ROOM,
            role='viewer', cm=SimpleNamespace(creator_id=1, creator=SimpleNamespace(username='o')))
    [(record, payload)] = events(caplog)
    assert (payload['operation'], payload['status'], payload['reason']) == (
        'add_participant', 0, 'transport')
    assert record.levelno == logging.WARNING
    assert V4_TOKEN not in caplog.text


def test_invalid_2xx_envelope_reports_its_status(caplog):
    body = SimpleNamespace(status_code=200, json=lambda: {'success': True, 'data': {'id': 'x'}})
    with pytest.raises(ProviderInvalidResponse):
        DyteClient(transport=transport(body)).create_meeting('creator')
    [(_, payload)] = events(caplog)
    assert (payload['operation'], payload['status'], payload['reason']) == (
        'create_meeting', 200, 'invalid_response')


def test_expected_idle_404_is_not_a_failure_event(caplog):
    t = transport(response(404), response(data={'id': ROOM}))
    assert DyteClient(transport=t).get_participants_count(ROOM) == 0
    assert events(caplog) == []


def test_confirmation_404_after_idle_404_is_reported(caplog):
    t = transport(response(404), response(404))
    with pytest.raises(ProviderNotFoundError):
        DyteClient(transport=t).get_participants_count(ROOM)
    [(_, payload)] = events(caplog)
    assert (payload['operation'], payload['status']) == ('get_meeting', 404)


def test_webhook_key_failure_is_reported(caplog):
    t = Mock()
    t.get.return_value = SimpleNamespace(status_code=503, json=lambda: {})
    with pytest.raises(ProviderUnavailableError):
        DyteClient(transport=t).webhook_public_key()
    [(_, payload)] = events(caplog)
    assert (payload['operation'], payload['status']) == ('webhook_keys', 503)


@pytest.mark.parametrize('method,path,operation', [
    ('POST', 'meetings', 'create_meeting'),
    ('GET', 'meetings', 'list_meetings'),
    ('GET', f'meetings/{ROOM}', 'get_meeting'),
    ('GET', f'meetings/{ROOM}/active-session', 'active_session'),
    ('POST', f'meetings/{ROOM}/active-session/kick', 'kick_participants'),
    ('POST', f'meetings/{ROOM}/participants', 'add_participant'),
    ('GET', f'meetings/{ROOM}/participants', 'list_participants'),
    ('DELETE', f'meetings/{ROOM}/participants/{ROOM}', 'delete_participant'),
    ('POST', 'recordings', 'start_recording'),
    ('GET', f'recordings/active-recording/{ROOM}', 'active_recording'),
    ('GET', f'recordings/{ROOM}', 'get_recording'),
    ('PUT', f'recordings/{ROOM}', 'update_recording'),
    ('GET', 'presets', 'list_presets'),
    ('GET', f'presets/{ROOM}', 'get_preset'),
    ('GET', 'sessions', 'other'),
])
def test_operation_vocabulary(method, path, operation):
    assert operation_for(method, path) == operation


# --------------------------------------------------------------------------- #
# Startup line and the credential-check command
# --------------------------------------------------------------------------- #
def test_startup_line_has_no_secret_values(settings, caplog):
    settings.DYTE_ORG, settings.DYTE_KEY = ORG, V2_KEY
    report = log_auth_mode()
    assert report == {'configured_mode': 'auto', 'auth_mode': 'v4',
                      'v4_credentials_present': True, 'v2_credentials_present': True,
                      'credentials_present': True}
    [(record, payload)] = events(caplog, MODE_SELECTED_EVENT)
    assert record.levelno == logging.INFO and payload['severity'] == 'INFO'
    for secret in (V4_TOKEN, V2_KEY, ORG, ROOM, 'a' * 32):
        assert secret not in caplog.text


def _run_check(monkeypatch, responses, *args):
    t = transport(*responses)
    monkeypatch.setattr(module, '_SESSION', t)
    out = StringIO()
    code = 0
    try:
        call_command('rtk_check_credentials', *args, stdout=out)
    except SystemExit as exc:
        code = exc.code
    return code, json.loads(out.getvalue()), t


def test_check_credentials_success_v4(monkeypatch):
    code, report, t = _run_check(monkeypatch, [response(data=[])])
    assert code == 0
    assert report['ok'] is True and report['status'] == 200
    assert report['auth_mode'] == 'v4' and report['operation'] == 'list_meetings'
    args, kwargs = t.request.call_args
    assert args[0] == 'GET' and args[1].endswith(f'/realtime/kit/{ROOM}/meetings')
    assert kwargs['params'] == {'page_no': 1, 'per_page': 1}
    assert kwargs['json'] is None


def test_check_credentials_401_v2_exits_nonzero_without_secrets(monkeypatch, legacy_only, caplog):
    code, report, t = _run_check(monkeypatch, [SimpleNamespace(
        status_code=401, json=lambda: {'success': False, 'error': {
            'code': 401, 'message': f'Basic auth failed for org: {ORG}'}})])
    assert code == 1
    assert report['ok'] is False and report['status'] == 401
    assert report['auth_mode'] == 'v2' and report['provider_code'] == 401
    assert report['error'] == 'ProviderAuthError'
    assert t.request.call_args.args[1] == 'https://api.realtime.cloudflare.com/v2/meetings'
    assert ORG not in json.dumps(report) and V2_KEY not in json.dumps(report)
    assert ORG not in caplog.text


def test_check_credentials_can_probe_v4_while_running_v2(monkeypatch, settings):
    settings.RTK_API_MODE = 'v2'
    settings.DYTE_ORG, settings.DYTE_KEY = ORG, V2_KEY
    code, report, t = _run_check(monkeypatch, [response(data=[])], '--mode', 'v4')
    assert code == 0 and report['auth_mode'] == 'v4'
    assert report['requested_mode'] == 'v4'
    assert t.request.call_args.args[1].startswith('https://api.cloudflare.com/client/v4/')
