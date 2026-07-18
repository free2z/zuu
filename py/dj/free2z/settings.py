import os
from pathlib import Path

from django.core.management.utils import get_random_secret_key

# Build paths inside the project like this: BASE_DIR / 'subdir'.
# py/dj/free2z
BASE_DIR = Path(__file__).resolve().parent

# py/dj/free2z/static
STATIC_ROOT = f"{BASE_DIR}/static"

# Quick-start development settings - unsuitable for production
# See https://docs.djangoproject.com/en/3.2/howto/deployment/checklist/

SECRET_KEY = os.environ.get('SECRET_KEY', get_random_secret_key())

# SECURITY WARNING: don't run with debug turned on in production!
DEBUG = True

ALLOWED_HOSTS = []

INTERNAL_IPS = [
    '127.0.0.1',
]

ASGI_APPLICATION = 'dj.free2z.asgi.application'

AUTH_USER_MODEL = 'g12f.Creator'

INSTALLED_APPS = [
    'daphne',
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'django.contrib.postgres',
    'django_extensions',
    'channels',
    'django_countries',

    'dj.apps.g12f',
    'corsheaders',
    'rest_framework',
    'rest_framework.authtoken',
    'dj_rest_auth',
    'drf_spectacular',
    'dbbackup',
    'knox',
    'django_filters',
    'taggit',
    # Postgres-native task queue (image variants, #590). Must appear
    # before the dj.apps that define tasks so its app registry is ready
    # first (see procrastinate.contrib.django docs).
    'procrastinate.contrib.django',
    # 'debug_toolbar',

    'dj.apps.dyte',
    'dj.apps.uploads',
    'dj.apps.comments',
    'dj.apps.twitter',
    'dj.apps.storytime',
    'dj.apps.openai',
    'dj.apps.events',
    'dj.apps.ztripe',
    'dj.apps.feeds',
    'dj.apps.tagging',
    'dj.apps.emails',
    'dj.apps.kyc',
    'dj.apps.otp',
    'dj.apps.tax',
    'dj.apps.search',
    'dj.apps.efm',
    'dj.apps.pricing',
    'dj.apps.zauth',
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
    # 'debug_toolbar.middleware.DebugToolbarMiddleware',
    # TODO: this will be fine for now but eventually we may want to
    # be more specific for performance reasons.
    'dj.util.middleware.AtomicMiddleware',
    'dj.util.middleware.ExceptionMiddleware',
]

CORS_ORIGIN_WHITELIST = [
    'https://free2z.com',
    'https://free2z.cash',
    'https://free2give.xyz',
    'http://localhost:3000',
    'http://localhost:8000',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:8000',
    # ZUULI desktop client's Vite dev server (browser-based dev).
    # The packaged Tauri app uses tauri-plugin-http (native HTTP, not
    # subject to browser CORS), so no tauri:// origin is needed here.
    'http://localhost:1423',
    'http://127.0.0.1:1423',
]

CORS_ALLOW_CREDENTIALS = True
CORS_EXPOSE_HEADERS = ["Set-Cookie"]

# Override in production
CSRF_TRUSTED_ORIGINS = [
    'http://localhost:3000',
    'https://localhost:3000',
    'http://localhost:8000',
    'https://localhost:8000',
    'http://127.0.0.1:3000',
    'https://127.0.0.1:3000',
    'https://127.0.0.1:8000',
    'http://127.0.0.1:8000',
]

AUTHENTICATION_BACKENDS = [
    "django.contrib.auth.backends.ModelBackend",
]

REST_FRAMEWORK = {
    'DEFAULT_SCHEMA_CLASS': 'drf_spectacular.openapi.AutoSchema',
    'DEFAULT_PAGINATION_CLASS': 'dj.free2z.pagination.Free2zPagination',
    'PAGE_SIZE': 12,
    'DEFAULT_FILTER_BACKENDS': [
        'django_filters.rest_framework.DjangoFilterBackend',
    ],
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'rest_framework.authentication.SessionAuthentication',
        'rest_framework.authentication.BasicAuthentication',
        'knox.auth.TokenAuthentication',
    ],
    "EXCEPTION_HANDLER": "dj.apps.g12f.views.exception_handler.custom_exception_handler",
    'DEFAULT_THROTTLE_CLASSES': [
        # 'rest_framework.throttling.AnonRateThrottle',
        # 'rest_framework.throttling.UserRateThrottle',
    ],
    'DEFAULT_THROTTLE_RATES': {
        # 'anon': '50/second',
        # 'user': '100/second',
        'brute': '1/second'
    },
}

SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels.layers.InMemoryChannelLayer"
    }
}

REST_KNOX = {
    # 'SECURE_HASH_ALGORITHM': 'cryptography.hazmat.primitives.hashes.SHA512',
    # 'AUTH_TOKEN_CHARACTER_LENGTH': 64,
    # 'TOKEN_TTL': timedelta(hours=10),
    # 'USER_SERIALIZER': 'knox.serializers.UserSerializer',
    'TOKEN_LIMIT_PER_USER': 5,
    # 'AUTO_REFRESH': False,
    # 'EXPIRY_DATETIME_FORMAT': api_settings.DATETME_FORMAT,
}

SPECTACULAR_SETTINGS = {
    # ends up as filename
    'TITLE': 'f2z',
    'DESCRIPTION': 'Free2z is a tool for content and peer-2-peer giving that does not compromise on privacy',
    'VERSION': '0.1.0',
    # 'SERVE_INCLUDE_SCHEMA': False,
    # OTHER SETTINGS
    'AUTHENTICATION_WHITELIST': [
        "rest_framework.authentication.SessionAuthentication",
        "rest_framework.authentication.BasicAuthentication",
        "knox.auth.TokenAuthentication",
    ],

}


ACCOUNT_EMAIL_VERIFICATION = False
ACCOUNT_EMAIL_REQUIRED = False
ACCOUNT_USERNAME_REQUIRED = True
ACCOUNT_SESSION_REMEMBER = True
ACCOUNT_AUTHENTICATION_METHOD = 'username'
# TODO: we could make optional email nullable+unique later and
# allow using email as username
# ACCOUNT_UNIQUE_EMAIL = True
ACCOUNT_USERNAME_BLACKLIST = [
    # 'zooko', 'skyl' ... hrm ... should squat some or ...
]


REST_AUTH_SERIALIZERS = {
    # /api/auth/login/
    'LOGIN_SERIALIZER': 'dj.apps.g12f.serializers.creator.CreatorLoginSerializer',
    # 'TOKEN_SERIALIZER': 'path.to.custom.TokenSerializer',
    # JWT_SERIALIZER - (Using REST_USE_JWT=True) response for successful authentication in dj_rest_auth.views.LoginView, default value dj_rest_auth.serializers.JWTSerializer
    # JWT_TOKEN_CLAIMS_SERIALIZER - A custom JWT Claim serializer. Default is rest_framework_simplejwt.serializers.TokenObtainPairSerializer
    # 'USER_DETAILS_SERIALIZER': 'dj.apps.g12f.serializers.creator.CreatorProfileDetailsSerializer',
    # PASSWORD_RESET_SERIALIZER - serializer class in dj_rest_auth.views.PasswordResetView, default value dj_rest_auth.serializers.PasswordResetSerializer
    # PASSWORD_RESET_CONFIRM_SERIALIZER - serializer class in dj_rest_auth.views.PasswordResetConfirmView, default value dj_rest_auth.serializers.PasswordResetConfirmSerializer
    # PASSWORD_CHANGE_SERIALIZER - serializer class in dj_rest_auth.views.PasswordChangeView, default value dj_rest_auth.serializers.PasswordChangeSerializer
}
LOGOUT_ON_PASSWORD_CHANGE = False
# TODO: JWT
# REST_USE_JWT = True
# JWT_AUTH_COOKIE = 'jwt-auth'

ROOT_URLCONF = 'dj.free2z.urls'

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

WSGI_APPLICATION = 'dj.free2z.wsgi.application'


# Database
# https://docs.djangoproject.com/en/3.2/ref/settings/#databases

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': BASE_DIR / 'db.sqlite3',
    }
}

# Real Postgres when DBHOST is set (same env vars prod_settings.py uses).
# CI and local test runs set these; tests never run against sqlite.
if os.environ.get("DBHOST"):
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.postgresql',
            'NAME': os.environ.get("DBNAME", "free2z"),
            'USER': os.environ.get("DBUSER", "free2z"),
            'PASSWORD': os.environ.get("DBPASS", ""),
            'HOST': os.environ["DBHOST"],
            'PORT': os.environ.get("DBPORT", "5432"),
        },
    }

DBBACKUP_STORAGE = 'django.core.files.storage.FileSystemStorage'
DBBACKUP_STORAGE_OPTIONS = {'location': './'}


# Password validation
# https://docs.djangoproject.com/en/3.2/ref/settings/#auth-password-validators

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


# Internationalization
# https://docs.djangoproject.com/en/3.2/topics/i18n/

LANGUAGE_CODE = 'en-us'

TIME_ZONE = 'UTC'

USE_I18N = True

USE_TZ = True


# Static files (CSS, JavaScript, Images)
# https://docs.djangoproject.com/en/3.2/howto/static-files/

STATIC_URL = '/static/'

# Default primary key field type
# https://docs.djangoproject.com/en/3.2/ref/settings/#default-auto-field

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

RECAPTCHA_SECRET_KEY = os.environ.get("RECAPTCHA_SECRET_KEY", "")

DYTE_KEY = os.environ.get("DYTE_KEY", "")
DYTE_ORG = os.environ.get("DYTE_ORG", "")
# Cloudflare RealtimeKit REST API (Dyte migration). Same endpoints, schemas,
# and basic auth (org id + API key) as api.dyte.io — only the base URL changed.
# Override with RTK_API_BASE_URL=https://api.dyte.io to roll back during the
# transition window.
RTK_API_BASE_URL = os.environ.get(
    "RTK_API_BASE_URL", "https://api.realtime.cloudflare.com")

# GCS storages
# https://github.com/jschneier/django-storages
# https://github.com/jschneier/django-storages/blob/master/storages/backends/gcloud.py
# https://django-storages.readthedocs.io/en/latest/backends/gcloud.html
# STORAGES replaces the removed DEFAULT_FILE_STORAGE/STATICFILES_STORAGE
# settings (removed in Django 5.1).
STORAGES = {
    "default": {
        "BACKEND": "storages.backends.gcloud.GoogleCloudStorage",
    },
    "staticfiles": {
        "BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage",
    },
}
GS_BUCKET_NAME = 'free2z-uploads'
GS_FILE_OVERWRITE = False
# GS_IS_GZIPPED = True
# GZIP_CONTENT_TYPES = [
#     "text/css", text/javascript, application/javascript,
#     "application/x-javascript", image/svg+xml, ]
# https://cloud.google.com/storage/docs/access-control/lists#predefined-acl
# GS_DEFAULT_ACL = "private"
# FILE_UPLOAD_MAX_MEMORY_SIZE = 1024 * 1024 * 10  # 10MB
# 2621440
# FILE_UPLOAD_MAX_MEMORY_SIZE = 1024 * 1024 * 2.5  # 2MB

NAMESPACE = os.environ.get("NAMESPACE", "test")
PROJECT_ID = "free2z"

PUBSUB = {
    "NEW_COMMENT": {
        "topic": f"projects/{PROJECT_ID}/topics/comments-{NAMESPACE}",
        "TWEET": f"projects/{PROJECT_ID}/subscriptions/tweetcomments-{NAMESPACE}",
        "AISCORE": f"projects/{PROJECT_ID}/subscriptions/aiscorecomments-{NAMESPACE}",
        "TAG_COMMENTS": f"projects/{PROJECT_ID}/subscriptions/tagcomments-{NAMESPACE}",
    },
    "DYTE_VIDEO_READY": {
        "topic": f"projects/{PROJECT_ID}/topics/dyte-video-ready-{NAMESPACE}",
        "DLUP": f"projects/{PROJECT_ID}/subscriptions/dlup-{NAMESPACE}",
    },
    "NEW_EVENT": {
        "topic": f"projects/{PROJECT_ID}/topics/events-{NAMESPACE}",
        "SOCKET": f"projects/{PROJECT_ID}/subscriptions/events-socket-{NAMESPACE}",
    },
    "PAGE_UPDATE": {
        "topic": f"projects/{PROJECT_ID}/topics/page-update-{NAMESPACE}",
        # "TWEET": f"projects/{PROJECT_ID}/subscriptions/page-update-tweet-{NAMESPACE}",
        # "AITAG": f"projects/{PROJECT_ID}/subscriptions/page-update-aitag-{NAMESPACE}",
        "AIDESCRIBE": f"projects/{PROJECT_ID}/subscriptions/page-update-aidescribe-{NAMESPACE}",
        "NOTIFY": f"projects/{PROJECT_ID}/subscriptions/page-update-notify-{NAMESPACE}",
        "TAG_ZPAGE": f"projects/{PROJECT_ID}/subscriptions/page-update-tagzpage-{NAMESPACE}",
    },
}

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler',
        },
    },
    'root': {
        'handlers': ['console'],
        'level': 'INFO',
    },
}

STRIPE_PUBLISHABLE_KEY = os.environ.get("STRIPE_PUBLISHABLE_KEY", "")
STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_SIGNING_SECRET = os.environ.get("STRIPE_SIGNING_SECRET", "")

EMAIL_BACKEND = "sendgrid_backend.SendgridBackend"
# https://app.sendgrid.com/settings/api_keys
SENDGRID_API_KEY = os.environ.get("SENDGRID_API_KEY", "")
SENDGRID_SANDBOX_MODE_IN_DEBUG = True
SENDGRID_TRACK_EMAIL_OPENS = False
SENDGRID_TRACK_CLICKS_HTML = False
SENDGRID_TRACK_CLICKS_PLAIN = False

# DJANGO DEBUG TOOLBAR
if os.getenv('ENABLE_DEBUG_TOOLBAR', False):
    INSTALLED_APPS += ['debug_toolbar']
    MIDDLEWARE += ['debug_toolbar.middleware.DebugToolbarMiddleware']
