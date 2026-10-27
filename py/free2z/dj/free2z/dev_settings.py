"""Local application stack settings for build/free2z/compose.yml."""
from .settings import *  # noqa: F403

ALLOWED_HOSTS = ['localhost', '127.0.0.1', 'backend', 'asgi']
CSRF_TRUSTED_ORIGINS = ['http://localhost:8080', 'http://127.0.0.1:8080']
