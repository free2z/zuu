"""Production database configuration with a callback-only HTTP surface."""
from dj.free2z.prod_settings import *  # noqa: F403
from .webhook_reader import READER_URLCONF

ROOT_URLCONF = READER_URLCONF
RTK_WEBHOOK_READER = True
DEBUG = False
MIDDLEWARE = [
    'dj.apps.health.middleware.HealthCheckMiddleware',
    'django.middleware.security.SecurityMiddleware',
]
REST_FRAMEWORK = {**REST_FRAMEWORK, 'DEFAULT_AUTHENTICATION_CLASSES': []}  # noqa: F405
