import os
from pathlib import Path

from django.core.management.utils import get_random_secret_key

# Build paths inside the project like this: BASE_DIR / 'subdir'.
BASE_DIR = Path(__file__).resolve().parent
STATIC_ROOT = f"{BASE_DIR}/static"
SECRET_KEY = os.environ.get('SECRET_KEY', get_random_secret_key())
# SECURITY WARNING: don't run with debug turned on in production!
DEBUG = True

ALLOWED_HOSTS = []

INTERNAL_IPS = [
    '127.0.0.1',
]

ASGI_APPLICATION = 'dj.proj.free2z.asgi.application'

INSTALLED_APPS = [
    'daphne',
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'django_extensions',
    'channels',
    'corsheaders',
    'dj.apps.efm',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
    'corsheaders.middleware.CorsMiddleware',
]

AUTHENTICATION_BACKENDS = [
    "django.contrib.auth.backends.ModelBackend",
]

# WebAuthn relying party for dj.apps.efm, which this standalone project
# installs above. The relying-party ID and expected origins are the binding a
# passkey is verified against before its public key is written, so they are
# configuration and there is no request-derived fallback.
#
# NOTE: dj.apps.efm is currently OFFLINE -- this project's URLconf and ASGI
# router no longer reach it, so nothing reads these settings and the efm
# system check that used to validate them is no longer registered. They are
# kept, not live. See dj/apps/efm/__init__.py; anyone re-routing the app must
# re-register that check in the same commit.
#
# These are the local-development values -- the React dev server on:3000
# talking to Django on:8000; override for any real deployment.
WEBAUTHN_RP_ID = os.environ.get('WEBAUTHN_RP_ID', '').strip().lower() or 'localhost'
WEBAUTHN_RP_NAME = os.environ.get('WEBAUTHN_RP_NAME', '').strip() or 'Free2Z EFM'
WEBAUTHN_EXPECTED_ORIGINS = [
    o.strip().rstrip('/')
    for o in os.environ.get('WEBAUTHN_EXPECTED_ORIGINS', '').split(',')
    if o.strip().rstrip('/')
] or [
    'https://localhost:3000',
    'http://localhost:3000',
    'http://localhost:8000',
    'https://localhost:8000',
]

# Override in production
CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels.layers.InMemoryChannelLayer"
    }
}

ROOT_URLCONF = 'dj.proj.free2z.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'dj.proj.free2z.wsgi.application'

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': BASE_DIR / 'db.sqlite3',
    }
}

AUTH_PASSWORD_VALIDATORS = [
    {
        'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator',
    },
]

LANGUAGE_CODE = 'en-us'

TIME_ZONE = 'UTC'

USE_I18N = True

USE_TZ = True

STATIC_URL = '/static/'
