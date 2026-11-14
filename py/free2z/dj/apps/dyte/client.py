import base64
import json
import os
import re
import uuid
import threading
import requests
from requests.adapters import HTTPAdapter
from django.core.cache import cache
from django.core.cache import caches

from django.conf import settings

from dj.apps.g12f.branding import default_logo_url
from dj.apps.g12f.models import Creator
from .models import CreatorMeeting

import logging

logger = logging.getLogger(__name__)


# Reuse TCP/TLS connections without transport retries. Later polls can retry
# failed reads; provider Retry-After headers must not extend a request's wait.
_SESSION_LOCAL = threading.local()


def _session():
    """Return a connection-pooled session owned by the current worker thread."""
    session = getattr(_SESSION_LOCAL, "session", None)
    if session is None:
        session = requests.Session()
        # Do not let ambient .netrc credentials replace the explicit Bearer
        # header, or import workstation proxy credentials into provider calls.
        session.trust_env = False
        # CI selects these public CA paths before starting clients. Honor only
        # certificate trust, without restoring ambient netrc/proxy credentials.
        session.verify = (os.environ.get('REQUESTS_CA_BUNDLE')
                          or os.environ.get('CURL_CA_BUNDLE') or True)
        session.mount("https://", HTTPAdapter(
            pool_connections=20,
            pool_maxsize=50,
            max_retries=0,
        ))
        _SESSION_LOCAL.session = session
    return session


class _ThreadLocalSessionProxy:
    def request(self, method, *args, **kwargs):
        return getattr(self, method.lower())(*args, **kwargs)

    def put(self, *args, **kwargs):
        return _session().put(*args, **kwargs)

    def get(self, *args, **kwargs):
        return _session().get(*args, **kwargs)

    def post(self, *args, **kwargs):
        return _session().post(*args, **kwargs)

    def delete(self, *args, **kwargs):
        return _session().delete(*args, **kwargs)


# Keep the established patch seam while routing real requests to thread-local
# Sessions (requests.Session itself is not documented as thread-safe).
_SESSION = _ThreadLocalSessionProxy()
PARTICIPANT_COUNT_TTL = 12
PARTICIPANT_COUNT_STALE_TTL = 300
_COUNT_LOCKS_GUARD = threading.Lock()
_COUNT_LOCKS = {}


def _count_lock(key):
    with _COUNT_LOCKS_GUARD:
        return _COUNT_LOCKS.setdefault(key, threading.Lock())


def _count_cache_keys(meeting_id):
    return (
        f"dyte:participants:v2:recent:{meeting_id}",
        f"dyte:participants:v2:last-known:{meeting_id}",
    )


def _count_generation_key(meeting_id):
    return f"dyte:participants:v2:generation:{meeting_id}:current"


def _count_sequence_key():
    return "dyte:participants:v2:generation:sequence"


_COUNT_BEGIN_LUA = """
local generation = redis.call('INCR', KEYS[1])
redis.call('SET', KEYS[2], tostring(generation) .. ':' .. ARGV[1], 'EX', ARGV[2])
return generation
"""
_COUNT_WRITE_LUA = """
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[4])
return 1
"""


def _raw_redis():
    backend = cache
    if backend.__class__.__module__ == 'django.utils.connection':
        backend = caches['default']
    client = getattr(backend, 'client', None)
    get_client = getattr(client, 'get_client', None)
    return get_client(write=True) if get_client is not None else None


def _cache_key(key):
    return cache.make_key(key) if hasattr(cache, 'make_key') else key


def _count_generation(meeting_id):
    """Allocate a never-reused Redis generation and its unique probe token."""
    token = uuid.uuid4().hex
    current_key = _count_generation_key(meeting_id)
    redis = _raw_redis()
    if redis is not None:
        generation = redis.eval(
            _COUNT_BEGIN_LUA, 2, _cache_key(_count_sequence_key()),
            _cache_key(current_key), token, PARTICIPANT_COUNT_STALE_TTL,
        )
        return f"{generation}:{token}"
    # The declared non-production backend is LocMemCache: one process and
    # _count_lock serializes its entire miss/probe/write path. Never expire or
    # recycle its counter while that process is alive.
    key = _count_sequence_key()
    with _COUNT_LOCKS_GUARD:
        generation = getattr(_count_generation, '_local', {})
        value = generation.get(key, 0) + 1
        generation[key] = value
        _count_generation._local = generation
    try:
        cache.set(
            current_key, f"{value}:{token}",
            PARTICIPANT_COUNT_STALE_TTL,
        )
    except Exception:
        logger.warning("participant count generation unavailable", exc_info=True)
        return None
    return f"{value}:{token}"


def _write_count_if_current(meeting_id, generation, count):
    """Atomically fence and write both count snapshots."""
    if generation is None:
        return
    recent_key, stale_key = _count_cache_keys(meeting_id)
    redis = _raw_redis()
    if redis is not None:
        redis.eval(
            _COUNT_WRITE_LUA, 3,
            _cache_key(_count_generation_key(meeting_id)),
            _cache_key(recent_key), _cache_key(stale_key), generation,
            count, PARTICIPANT_COUNT_TTL, PARTICIPANT_COUNT_STALE_TTL,
        )
        return
    # LocMemCache is explicitly process-local. The caller still owns its
    # per-meeting process lock here, so this two-key fallback cannot race or
    # outlive an expiring distributed lease. Unknown backends fail closed.
    backend = caches['default'] if cache.__class__.__module__ == 'django.utils.connection' else cache
    if backend.__class__.__module__.endswith('.locmem'):
        if cache.get(_count_generation_key(meeting_id)) != generation:
            return
        cache.set(recent_key, count, PARTICIPANT_COUNT_TTL)
        cache.set(stale_key, count, PARTICIPANT_COUNT_STALE_TTL)


def _timeout():
    """The (connect, read) tuple every outbound provider call must carry.

    Read from settings at CALL time, not import time, so an operator can
    change it with an env var + restart and so `override_settings` works in
    tests. `requests` has no default timeout at all: without this a provider
    that accepts the TCP connection and then never answers pins the calling
    thread for the life of the process -- a gunicorn worker on the join
    path, and the whole catch-all `default` procrastinate lane on the
    sweep path.
    """
    return (
        settings.DYTE_CONNECT_TIMEOUT_SECONDS,
        settings.DYTE_READ_TIMEOUT_SECONDS,
    )


class ProviderError(requests.RequestException):
    """Safe typed boundary: no provider body, request, or secret in diagnostics.

    ``status`` is the provider's HTTP status (0 when no response was received
    or the request was never sent) and ``provider_code`` the provider's own
    numeric error code when its error envelope carried one. Both are plain
    integers, so they are safe to print; nothing else from the response is
    kept.
    """

    def __init__(self, *, status=None, provider_code=None):
        super().__init__(type(self).__name__)
        self.status = status
        self.provider_code = provider_code


class ProviderAuthError(ProviderError):
    pass


class ProviderNotFoundError(ProviderError):
    pass


class ProviderRateLimitError(ProviderError):
    pass


class ProviderUnavailableError(ProviderError):
    pass


class ProviderInvalidResponse(ProviderError):
    pass


class ProviderRejectedError(ProviderError):
    """Definitive request rejection, unlike an ambiguous transport failure."""


def _uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except ValueError:
        return False


class ProviderResponse:
    """Validated adapter for shipping callers that consume json/data."""

    def __init__(self, body, status):
        self._body = body
        self.status_code = status

    def json(self):
        return self._body


# --------------------------------------------------------------------------- #
# Credential modes
# --------------------------------------------------------------------------- #
#: Cloudflare's account/app-scoped control plane (Bearer API token).
AUTH_MODE_V4 = 'v4'
#: Legacy Dyte-compatible control plane (HTTP Basic org id + org API key).
AUTH_MODE_V2 = 'v2'
AUTH_MODES = (AUTH_MODE_V4, AUTH_MODE_V2)
CONFIGURED_MODES = ('auto',) + AUTH_MODES
V4_API_ROOT = 'https://api.cloudflare.com/client/v4'

#: ``jsonPayload.event`` of every failed provider request. An alerting
#: contract (production log-based alerting) -- do not rename it or its fields.
PROVIDER_FAILURE_EVENT = 'rtk_provider_request_failed'
#: ``jsonPayload.event`` of the once-per-process credential-mode line.
MODE_SELECTED_EVENT = 'rtk_api_mode_selected'

_V4_ACCOUNT = re.compile(r'[a-fA-F0-9]{32}')
_V4_APP = re.compile(r'[a-zA-Z0-9-]+')
_V2_BASE = re.compile(r'https://[A-Za-z0-9.-]+(:[0-9]{1,5})?')
_PATH = re.compile(r'[a-zA-Z0-9_/-]+')


def _present(*values):
    return all(isinstance(v, str) and v.strip() for v in values)


def _header_safe(*values):
    return all(isinstance(v, str) and not any(c in v for c in '\r\n\0')
               for v in values)


def v4_settings_present():
    return _present(getattr(settings, 'RTK_ACCOUNT_ID', ''),
                    getattr(settings, 'RTK_APP_ID', ''),
                    getattr(settings, 'RTK_API_TOKEN', ''))


def v2_settings_present():
    return _present(getattr(settings, 'DYTE_ORG', ''),
                    getattr(settings, 'DYTE_KEY', ''))


def configured_mode():
    """``RTK_API_MODE`` normalised; an unknown value degrades to ``auto``."""
    value = str(getattr(settings, 'RTK_API_MODE', 'auto') or 'auto').strip().lower()
    return value if value in CONFIGURED_MODES else 'auto'


def resolve_auth_mode(mode=None, *, v4_present=None):
    """The concrete mode (``v4``/``v2``) a client configured with ``mode`` uses.

    ``auto`` selects v4 only when every v4 value is present, so deploying this
    code with only the legacy DYTE_ORG/DYTE_KEY secret changes nothing, and
    adding the three RTK_* v4 keys is the whole cut-over.
    """
    mode = configured_mode() if mode is None else str(mode).strip().lower()
    if mode in AUTH_MODES:
        return mode
    if v4_present is None:
        v4_present = v4_settings_present()
    return AUTH_MODE_V4 if v4_present else AUTH_MODE_V2


def mode_report():
    """Secret-free description of the configured credential mode."""
    raw = str(getattr(settings, 'RTK_API_MODE', 'auto') or 'auto').strip().lower()
    auth_mode = resolve_auth_mode()
    v4 = v4_settings_present()
    v2 = v2_settings_present()
    return {
        'configured_mode': raw if raw in CONFIGURED_MODES else 'invalid',
        'auth_mode': auth_mode,
        'v4_credentials_present': v4,
        'v2_credentials_present': v2,
        'credentials_present': v4 if auth_mode == AUTH_MODE_V4 else v2,
    }


def log_auth_mode(log=None):
    """Emit the one-line ``rtk_api_mode_selected`` record; return the report.

    WARNING when the selected mode has no credentials or RTK_API_MODE is not
    a recognised value, INFO otherwise. Never includes a credential value.
    """
    log = log or logger
    report = mode_report()
    healthy = report['credentials_present'] and report['configured_mode'] != 'invalid'
    payload = {
        'severity': 'INFO' if healthy else 'WARNING',
        'message': (
            f"RealtimeKit API mode {report['auth_mode']} "
            f"(RTK_API_MODE={report['configured_mode']}, credentials "
            f"{'present' if report['credentials_present'] else 'MISSING'})"
        ),
        'event': MODE_SELECTED_EVENT,
        **report,
    }
    log.log(logging.INFO if healthy else logging.WARNING,
            json.dumps(payload, separators=(',', ':')))
    return report


def operation_for(method, path):
    """A fixed operation name for a control-plane request (log vocabulary)."""
    method = str(method).upper()
    parts = str(path).strip('/').split('/')
    head, n = parts[0], len(parts)
    if head == 'meetings':
        if n == 1:
            return 'create_meeting' if method == 'POST' else 'list_meetings'
        if n == 2:
            return 'get_meeting'
        if parts[2] == 'active-session':
            if n == 3:
                return 'active_session'
            if parts[3] == 'kick':
                return 'kick_participants'
        if parts[2] == 'participants':
            if n == 3:
                return 'add_participant' if method == 'POST' else 'list_participants'
            return 'delete_participant' if method == 'DELETE' else 'get_participant'
    if head == 'recordings':
        if n == 1:
            return 'start_recording' if method == 'POST' else 'list_recordings'
        if parts[1] == 'active-recording':
            return 'active_recording'
        return 'update_recording' if method == 'PUT' else 'get_recording'
    if head == 'presets':
        return 'list_presets' if n == 1 else 'get_preset'
    return 'other'


#: Operations whose 404 is a documented, expected answer ("no session is
#: running", "already gone") that the caller then confirms against the
#: meeting itself. Those 404s are not provider failures and are not logged
#: as such -- an idle room answers active-session with 404 on every poll.
_EXPECTED_404 = frozenset({
    'active_session', 'kick_participants', 'delete_participant',
    'active_recording',
})


def _provider_code(response):
    """The provider's numeric error code, if its envelope has one.

    v2 answers ``{"success": false, "error": {"code": 401, ...}}``; the
    Cloudflare v4 envelope is ``{"errors": [{"code": 10000, ...}]}``. Only an
    integer is ever returned, so nothing provider-authored reaches a log.
    """
    try:
        body = response.json()
    except Exception:  # noqa: BLE001 -- classification must never raise
        return None
    if not isinstance(body, dict):
        return None
    candidates = []
    error = body.get('error')
    if isinstance(error, dict):
        candidates.append(error.get('code'))
    errors = body.get('errors')
    if isinstance(errors, list) and errors and isinstance(errors[0], dict):
        candidates.append(errors[0].get('code'))
    for code in candidates:
        if isinstance(code, int) and not isinstance(code, bool):
            return code
    return None


def report_provider_failure(operation, status, auth_mode, *, reason,
                            provider_code=None, log=None):
    """Emit the ``rtk_provider_request_failed`` structured record.

    One line of JSON as the log message, the same mechanism as
    ``ai_providers_configured``: the root handler's default ``%(message)s``
    on web pods and ``WorkerRootJSONFormatter`` (which passes a structured
    line through untouched) on worker pods both put a line that is entirely
    JSON on stdout, which GKE promotes to ``jsonPayload`` with this
    ``severity``. ERROR for a credential failure (401/403, or credentials
    missing), WARNING for everything else. Fields are integers or fixed
    vocabulary only -- never a body, header, URL, token or provider text.
    """
    credential_failure = status in (401, 403) or reason == 'not_configured'
    severity = 'ERROR' if credential_failure else 'WARNING'
    payload = {
        'severity': severity,
        'message': (
            f'RealtimeKit {operation} failed: status={status} '
            f'auth_mode={auth_mode} reason={reason}'
        ),
        'event': PROVIDER_FAILURE_EVENT,
        'operation': operation,
        'status': int(status),
        'auth_mode': auth_mode,
        'reason': reason,
    }
    if provider_code is not None:
        payload['provider_code'] = provider_code
    (log or logger).log(
        logging.ERROR if credential_failure else logging.WARNING,
        json.dumps(payload, separators=(',', ':')),
    )


_STATUS_ERRORS = {401: ProviderAuthError, 403: ProviderAuthError,
                  404: ProviderNotFoundError, 429: ProviderRateLimitError}


class DyteClient(object):
    """RealtimeKit control-plane client, v4 Bearer or legacy v2 Basic.

    With no arguments every value comes from settings and the mode from
    ``RTK_API_MODE`` (see settings.py). Passing explicit v4 values
    (``account_id``/``app_id``/``api_token``) implies v4; passing explicit v2
    values (``org``/``key``/``base_url``) implies v2; ``mode`` overrides both.
    The mode is fixed at construction.
    """

    def __init__(self, *, transport=None, mode=None, account_id=None,
                 app_id=None, api_token=None, org=None, key=None,
                 base_url=None):
        self.transport = transport or _SESSION
        self.account_id = settings.RTK_ACCOUNT_ID if account_id is None else account_id
        self.app_id = settings.RTK_APP_ID if app_id is None else app_id
        self.api_token = settings.RTK_API_TOKEN if api_token is None else api_token
        self.org = settings.DYTE_ORG if org is None else org
        self.key = settings.DYTE_KEY if key is None else key
        self.base_url = settings.RTK_API_BASE_URL if base_url is None else base_url
        if mode is None:
            if any(v is not None for v in (account_id, app_id, api_token)):
                mode = AUTH_MODE_V4
            elif any(v is not None for v in (org, key, base_url)):
                mode = AUTH_MODE_V2
        self.auth_mode = resolve_auth_mode(mode, v4_present=_present(
            self.account_id, self.app_id, self.api_token))

    def _endpoint(self, path):
        """(url, headers) for ``path``, or None when credentials are unusable."""
        if self.auth_mode == AUTH_MODE_V4:
            if (not isinstance(self.account_id, str)
                    or not _V4_ACCOUNT.fullmatch(self.account_id)
                    or not isinstance(self.app_id, str)
                    or not _V4_APP.fullmatch(self.app_id)
                    or not _present(self.api_token)
                    or not _header_safe(self.api_token)):
                return None
            return (
                f'{V4_API_ROOT}/accounts/{self.account_id}'
                f'/realtime/kit/{self.app_id}/{path}',
                {'Authorization': f'Bearer {self.api_token}',
                 'Content-Type': 'application/json'},
            )
        base = self.base_url.rstrip('/') if isinstance(self.base_url, str) else ''
        if (not _V2_BASE.fullmatch(base) or not _present(self.org, self.key)
                or not _header_safe(self.org, self.key) or ':' in self.org):
            return None
        basic = base64.b64encode(f'{self.org}:{self.key}'.encode()).decode('ascii')
        return (
            f'{base}/v2/{path}',
            {'Authorization': f'Basic {basic}',
             'Content-Type': 'application/json'},
        )

    def _fail(self, error, operation, status, *, reason, provider_code=None):
        """Report a failed provider operation and return its typed error."""
        report_provider_failure(operation, status, self.auth_mode,
                                reason=reason, provider_code=provider_code)
        return error(status=status, provider_code=provider_code)

    def request(self, method, path, *, payload=None, params=None, timeout=None,
                allow_ack=False, operation=None):
        operation = operation or operation_for(method, path)
        if not isinstance(path, str) or not _PATH.fullmatch(path):
            raise self._fail(ProviderInvalidResponse, operation, 0,
                             reason='invalid_request')
        endpoint = self._endpoint(path)
        if endpoint is None:
            raise self._fail(ProviderAuthError, operation, 0,
                             reason='not_configured')
        url, headers = endpoint
        try:
            response = self.transport.request(
                method, url, headers=headers, json=payload, params=params,
                timeout=timeout or _timeout(), allow_redirects=False,
            )
        except requests.RequestException:
            raise self._fail(ProviderUnavailableError, operation, 0,
                             reason='transport') from None
        status = response.status_code
        if isinstance(status, bool) or not isinstance(status, int):
            raise self._fail(ProviderInvalidResponse, operation, 0,
                             reason='invalid_response')
        if not 200 <= status < 300:
            code = _provider_code(response)
            error = _STATUS_ERRORS.get(status)
            if error is None:
                error = (ProviderUnavailableError
                         if status >= 500 or 300 <= status < 400
                         else ProviderRejectedError)
            if status == 404 and operation in _EXPECTED_404:
                raise error(status=status, provider_code=code)
            raise self._fail(error, operation, status, reason='http_status',
                             provider_code=code)
        try:
            body = response.json()
        except (ValueError, TypeError):
            raise self._fail(ProviderInvalidResponse, operation, status,
                             reason='invalid_response') from None
        if (not isinstance(body, dict) or body.get('success') is not True
                or 'error' in body or body.get('errors')):
            raise self._fail(ProviderInvalidResponse, operation, status,
                             reason='invalid_response')
        if allow_ack and 'data' not in body:
            # Documented mutation acknowledgements have optional data. Read
            # operations and token/meeting creation still require their data.
            body = {**body, 'data': {}}
        if (not isinstance(body.get('data'), (dict, list))
                or (allow_ack and not isinstance(body.get('data'), dict))):
            raise self._fail(ProviderInvalidResponse, operation, status,
                             reason='invalid_response')
        return ProviderResponse(body, status)

    def webhook_public_key(self):
        operation = 'webhook_keys'
        try:
            response = self.transport.get(
                settings.RTK_WEBHOOK_KEY_URL, allow_redirects=False,
                timeout=(settings.DYTE_CONNECT_TIMEOUT_SECONDS,
                         settings.DYTE_KEY_FETCH_TIMEOUT_SECONDS),
            )
        except requests.RequestException:
            raise self._fail(ProviderUnavailableError, operation, 0,
                             reason='transport') from None
        status = response.status_code
        if status != 200:
            raise self._fail(
                ProviderUnavailableError, operation,
                status if isinstance(status, int) and not isinstance(status, bool) else 0,
                reason='http_status', provider_code=_provider_code(response))
        try:
            body = response.json()
        except (ValueError, TypeError, requests.RequestException):
            raise self._fail(ProviderInvalidResponse, operation, status,
                             reason='invalid_response') from None
        data = body.get('data') if isinstance(body, dict) else None
        key = data.get('publicKey') if isinstance(data, dict) else None
        if (not isinstance(body, dict) or body.get('success') is not True
                or not isinstance(key, str) or not key.strip()):
            raise self._fail(ProviderInvalidResponse, operation, status,
                             reason='invalid_response')
        return key

    def _invalid(self, response, operation):
        """A 2xx whose consumed data is unusable: report and return the error."""
        return self._fail(ProviderInvalidResponse, operation,
                          getattr(response, 'status_code', 0) or 0,
                          reason='invalid_response')

    def _meeting(self, response, operation='get_meeting'):
        data = response.json()['data']
        if not isinstance(data, dict) or not _uuid(data.get('id')):
            raise self._invalid(response, operation)
        return response

    def list_meetings(self, *, per_page=1):
        """One read-only page of the app's meetings (credential probe)."""
        return self.request('GET', 'meetings',
                            params={'page_no': 1, 'per_page': per_page})

    def get_participants_count(self, meeting_id) -> int:
        # A 404 alone does not distinguish an idle room from a missing app.
        try:
            response = self.request('GET', f'meetings/{meeting_id}/active-session')
        except ProviderNotFoundError:
            self._meeting(self.request('GET', f'meetings/{meeting_id}'))
            return 0
        data = response.json()['data']
        count = data.get('live_participants') if isinstance(data, dict) else None
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise self._invalid(response, 'active_session')
        return count

    def get_cached_participants_count(self, meeting_id) -> int:
        """Return a short-cached count, retaining the last result on failure."""
        recent_key, stale_key = _count_cache_keys(meeting_id)
        try:
            cached = cache.get(recent_key)
        except Exception:
            logger.warning("participant count cache read failed", exc_info=True)
            cached = None
        if cached is not None:
            return cached
        # Coalesce misses in this process. Separate workers may still probe
        # concurrently; the shared generation fences their cache writes below.
        with _count_lock(meeting_id):
            try:
                cached = cache.get(recent_key)
            except Exception:
                cached = None
            if cached is not None:
                return cached
            try:
                generation = _count_generation(meeting_id)
            except Exception:
                logger.warning("participant count generation unavailable", exc_info=True)
                generation = None
            try:
                count = self.get_participants_count(meeting_id)
            except Exception:
                try:
                    stale = cache.get(stale_key)
                except Exception:
                    logger.warning("stale participant count cache read failed", exc_info=True)
                    stale = None
                if stale is not None:
                    return stale
                raise
            try:
                _write_count_if_current(meeting_id, generation, count)
            except Exception:
                logger.warning("participant count cache write failed", exc_info=True)
            return count

    def create_meeting(self, title):
        return self._meeting(
            self.request('POST', 'meetings', payload={'title': title}),
            'create_meeting')

    def kick_participants(self, meeting_id, participant_ids):
        ids = [str(pid) for pid in participant_ids if pid]
        if not ids:
            return True
        try:
            self.request('POST', f'meetings/{meeting_id}/active-session/kick',
                         payload={'participant_ids': ids}, allow_ack=True)
            return True
        except ProviderNotFoundError:
            try:
                self._meeting(self.request('GET', f'meetings/{meeting_id}'))
                return True
            except ProviderError:
                return False
        except ProviderError:
            return False

    def retire_participant(self, meeting_id: str, participant_id: str) -> bool:
        """Take a previous host off the air for good.

        Kick FIRST, then delete -- the order Cloudflare documents: kicking
        disconnects a peer that is connected right now, deleting the
        participant revokes its token so it cannot (re)join. Deleting first
        could leave the kick resolving nothing (404) while a live connection
        survives. True only when both are confirmed (404 = already gone).
        """
        # A host_... value is our custom_participant_id, NOT RealtimeKit's
        # provider participant UUID. Resolve it through the documented list
        # endpoint before calling kick/delete (which require provider ID).
        if str(participant_id).startswith('host_'):
            resolved = self._provider_id_for_custom_participant(
                meeting_id, str(participant_id),
            )
            if resolved is None:
                # A pre-mint obligation can outlive the request that minted
                # it. An empty list is only a snapshot: the provider may
                # finish an already accepted add request after this lookup.
                # Keep retrying until the participant appears and is retired.
                return False
            if resolved is False:
                return False
            # A custom ID is not unique at the provider. Retire every match
            # found in the complete listing; success requires each one gone.
            retired = True
            for provider_id in resolved:
                if not self._retire_provider_participant(meeting_id, provider_id):
                    retired = False
            return retired
        return self._retire_provider_participant(meeting_id, participant_id)

    def _retire_provider_participant(self, meeting_id, participant_id):
        kicked = self.kick_participants(meeting_id, [participant_id])
        if not kicked:
            return False
        try:
            self.request('DELETE', f'meetings/{meeting_id}/participants/{participant_id}', allow_ack=True)
            return True
        except ProviderNotFoundError:
            try:
                self._meeting(self.request('GET', f'meetings/{meeting_id}'))
                return True
            except ProviderError:
                return False
        except ProviderError:
            return False

    def _provider_id_for_custom_participant(self, meeting_id, custom_id):
        page_no = 1
        matches = []
        try:
            while page_no <= 20:
                response = self.request('GET', f'meetings/{meeting_id}/participants',
                                        params={'page_no': page_no, 'per_page': 100})
                payload = response.json()
                data = payload['data']
                if not isinstance(data, list):
                    return False
                for participant in data:
                    if not isinstance(participant, dict):
                        return False
                    provider_id = participant.get('id')
                    participant_custom_id = participant.get(
                        'custom_participant_id',
                    )
                    if (not isinstance(provider_id, str) or not provider_id
                            or ('custom_participant_id' not in participant)
                            or (participant_custom_id is not None
                                and not isinstance(participant_custom_id, str))):
                        return False
                    if participant_custom_id == custom_id:
                        matches.append(provider_id)
                if len(data) < 100:
                    return matches or None
                page_no += 1
        except ProviderError as exc:
            logger.warning(
                "resolve participant id failed meeting=%s: %s",
                meeting_id, type(exc).__name__,
            )
        # Reaching the page cap without exhausting the provider's list is an
        # unresolved lookup, not evidence that this participant is absent.
        return False

    def add_participant(
        self, creator: Creator, meeting_id: str, *, role: str = None,
        custom_participant_id: str = None, cm: CreatorMeeting = None,
    ) -> ProviderResponse:
        if cm is None:
            cm = CreatorMeeting.objects.select_related('creator').get(meeting_id=meeting_id)

        logger.info("meeting owner id=%s, participant=%s", cm.creator_id, creator.username)

        # RealtimeKit fetches participant pictures in the browser. Legacy
        # free2z.com URLs redirect across origins and fail CSP/CORS on the
        # canonical site. Use this deployment's origin and existing paths.
        picture_path = default_logo_url()
        if not creator.is_authenticated:
            username = f"Guest {uuid.uuid4()}"
        else:
            username = creator.username
            if creator.avatar_image:
                picture_path = creator.avatar_image.get_thumbnail() or picture_path
        picture_url = f"{settings.CANONICAL_ORIGIN.rstrip('/')}{picture_path}"

        # The caller knows whether this is a host start or a viewer join, and
        # that is authoritative: the creator opening their own public stream
        # page must get the participant preset, never the host one, or it
        # publishes into its own live broadcast. The username
        # inference survives only for callers that do not say.
        if role is None:
            role = 'host' if cm.creator.username == creator.username else 'viewer'
        if role not in ('host', 'viewer'):
            raise ValueError('role must be host or viewer')

        if role == 'host':
            logger.info("creator is joining their own meeting")
            preset = "webinar1"
        else:
            logger.info("participant is joining someone else's meeting")
            preset = "webinar-participant"

        payload = {
            "name": username,
            "picture": picture_url,
            "preset_name": preset,
            "custom_participant_id": custom_participant_id or username,
        }
        response = self.request('POST', f'meetings/{meeting_id}/participants', payload=payload)
        data = response.json()['data']
        if (not isinstance(data, dict) or not _uuid(data.get('id'))
                or not isinstance(data.get('token'), str) or not data['token'].strip()):
            raise self._invalid(response, 'add_participant')
        return response
