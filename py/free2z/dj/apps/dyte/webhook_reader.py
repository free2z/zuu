"""Capability and identity proof for an isolated RealtimeKit callback reader."""
from functools import wraps
from importlib.util import find_spec
import os

READER_PROTOCOL = 1
READER_ROLE = 'rtk-webhook-reader'
READER_URLCONF = 'dj.apps.dyte.webhook_urls'
READER_SETTINGS = 'dj.apps.dyte.webhook_settings'


def validate_reader_contract():
    """Selected-image preflight; imports no application models or services."""
    for module in (READER_URLCONF, READER_SETTINGS, 'dj.apps.dyte.webhook_wsgi'):
        if find_spec(module) is None:
            raise RuntimeError('RealtimeKit reader capability is incomplete')
    return {'reader_protocol': READER_PROTOCOL, 'role': READER_ROLE,
        'wsgi_module': 'dj.apps.dyte.webhook_wsgi:application'}


def reader_probe(view):
    """Intercept GET before DRF authentication, signature or application work."""
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        if request.method != 'GET':
            return view(request, *args, **kwargs)
        from django.conf import settings
        from django.http import HttpResponseNotAllowed, JsonResponse
        if (not getattr(settings, 'RTK_WEBHOOK_READER', False)
                or settings.ROOT_URLCONF != READER_URLCONF
                or os.environ.get('FREE2Z_PROCESS_ROLE') != READER_ROLE):
            return HttpResponseNotAllowed(['POST'])
        response = JsonResponse({'ok': True,
            'commit': os.environ.get('BUILD_SHA') or 'dev',
            'deployment_commit': os.environ.get('DEPLOYMENT_SHA') or 'dev',
            'release_id': os.environ.get('APP_RELEASE_ID') or 'dev',
            'reader_protocol': READER_PROTOCOL, 'role': READER_ROLE})
        response['Cache-Control'] = 'no-store'
        return response
    # A probe must not open an ATOMIC_REQUESTS transaction before this wrapper.
    wrapped._non_atomic_requests = {*getattr(view, '_non_atomic_requests', set()), 'default'}
    return wrapped
