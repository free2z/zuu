"""Isolated callback process: no API mint routes or worker initialization."""
import os

from .webhook_reader import READER_ROLE, READER_SETTINGS, validate_reader_contract

validate_reader_contract()
if os.environ.get('FREE2Z_PROCESS_ROLE') != READER_ROLE:
    raise RuntimeError('RealtimeKit reader process role is required')
os.environ.pop('PROCRASTINATE_WORKER_POOL_SIZE', None)
os.environ['DJANGO_SETTINGS_MODULE'] = READER_SETTINGS

from django.core.wsgi import get_wsgi_application  # noqa: E402

application = get_wsgi_application()
