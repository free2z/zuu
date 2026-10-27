import os
import sys
from urllib.parse import urlsplit

from django.core.exceptions import ImproperlyConfigured

from . import db_pooler
from .channel_layer_config import (
    CHANNEL_REDIS_HOST,
    CHANNEL_REDIS_PORT,
    redis_channel_layer_config,
)
from .settings import *

ALLOWED_HOSTS = [
    '.free2z.com',
    '.free2z.cash',
    '.free2give.xyz',
    'localhost',
    '127.0.0.1',
    '.googleusercontent.com',
]

# Used only when a non-browser client omits Origin. Kubernetes supplies the
# namespace-specific value; the fallback keeps production return URLs public
# even during maintenance commands or a manually launched container.
CANONICAL_ORIGIN = os.environ.get(
    'CANONICAL_ORIGIN', 'https://free2z.cash'
).rstrip('/')
ZUULI_NATIVE_CHECKOUT_RETURN_ORIGIN = os.environ.get(
    'ZUULI_NATIVE_CHECKOUT_RETURN_ORIGIN',
    'https://checkout-return.free2z.cash',
).rstrip('/')

# ---------------------------------------------------------------------------
# WebAuthn relying party (EFM passkeys) -- see the long note in settings.py.
# ---------------------------------------------------------------------------
# settings.py defaults these to the local dev values, so they MUST be
# recomputed here from this namespace's CANONICAL_ORIGIN or every deployed
# environment would advertise rp_id='localhost'.
#
# CANONICAL_ORIGIN is already the one canonical host per namespace
# (https://free2z.cash in prod, https://stage.free2z.cash / test. / new. in
# the others -- k8s/free2z/config.yaml), and nginx 301s free2z.com and
# free2give.xyz to it (k8s/free2z/nginx.conf:39). Deriving from it means the
# RP ID follows the deploy target without a second knob to forget, while still
# being pure configuration -- no request ever touches it. Both are overridable
# by env var for the case where the two must diverge.
#
# ONE domain only. A passkey registered under this RP ID will not verify under
# any other registrable domain, and no server-side change can make it: WebAuthn
# scopes credentials to a single RP. Reaching the site on a non-canonical host
# therefore means the browser offers no passkey -- visibly nothing to use,
# rather than a credential that silently works only sometimes.
_WEBAUTHN_CANONICAL_HOST = (urlsplit(CANONICAL_ORIGIN).hostname or '').lower()
# Intentionally no `or 'free2z.cash'` fallback: a CANONICAL_ORIGIN we could not
# parse must surface as a failed system check, not as a guessed relying party.
WEBAUTHN_RP_ID = (
    os.environ.get('WEBAUTHN_RP_ID', '').strip().lower()
    or _WEBAUTHN_CANONICAL_HOST
)
WEBAUTHN_EXPECTED_ORIGINS = [
    o.strip().rstrip('/')
    for o in os.environ.get('WEBAUTHN_EXPECTED_ORIGINS', '').split(',')
    if o.strip().rstrip('/')
] or [
    # Exactly one entry: the ingress serves no `www.` or other alias for this
    # namespace (k8s/free2z/ingress.yaml lists only %{PREFIX}free2z.cash /
    #.com / free2give.xyz, and the latter two 301 to the canonical host), so
    # anything more would be an origin no browser can actually be on.
    CANONICAL_ORIGIN,
]

STATIC_URL = '/djstatic/'
STATIC_ROOT = os.environ.get("STATIC_ROOT", os.path.join(os.path.dirname(__file__), "static"))
if not os.environ.get("LOCALDEV"):
    DEBUG = False
    # Public deployments are HTTPS-only. Bind cookies at issuance even when
    # Django sees an internal HTTP proxy hop; a redirect cannot protect a
    # cookie the browser has already sent over plaintext HTTP.
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    # A deployed pod signs OIDC tokens with the owner-provisioned keys or
    # not at all: a generated key would mint tokens no other pod and
    # no resource server can verify, silently. dj.apps.oidc.checks turns the
    # absence into a red `manage.py check`, which `migrate` runs.
    OIDC_ALLOW_GENERATED_KEYS = False

# PgBouncer  is deployed DARK: HOST stays DBHOST (sql-proxy-service)
# unless this pod's namespace is listed in DB_POOLER_NAMESPACES, and
# `manage.py migrate` is always direct. dj/free2z/db_pooler.py has the rules;
# docs/k8s/pgbouncer.md has the cutover. PORT is 5432 either way: the
# pgbouncer Service maps 5432 to PgBouncer's 6432.
try:
    DB_ROUTE = db_pooler.resolve(os.environ, sys.argv)
except db_pooler.PoolerConfigError as exc:
    raise ImproperlyConfigured(f"database pooler: {exc}") from exc

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': os.environ.get("DBNAME", "dbname"),
        'USER': os.environ.get("DBUSER", "dbuser"),
        'PASSWORD': os.environ["DBPASS"],
        'HOST': DB_ROUTE.host,
        'PORT': "5432",
        # Keep failed Cloud SQL/Auth Proxy connection attempts from occupying
        # every gunicorn thread during a dependency outage. This module
        # replaces DATABASES wholesale, so it must repeat the driver option
        # rather than relying on settings.py's development branch.
        #
        # prepare_threshold / DISABLE_SERVER_SIDE_CURSORS: PgBouncer
        # transaction-pooling prerequisites  -- see settings.py.
        'OPTIONS': {
            'connect_timeout': DB_CONNECT_TIMEOUT_SECONDS,  # noqa: F405
            'prepare_threshold': DB_PREPARE_THRESHOLD,  # noqa: F405
        },
        'DISABLE_SERVER_SIDE_CURSORS': DB_DISABLE_SERVER_SIDE_CURSORS,  # noqa: F405
        # This module *replaces* DATABASES wholesale, so the persistent-connection
        # config from settings.py has to be re-applied here or it would be silently
        # dropped in production — exactly where it matters. See the long comment in
        # settings.py; CONN_MAX_AGE is env-overridable per container (daphne sets 0).
        # noqa F405 is line-scoped on purpose: `from.settings import *` hides
        # these two from ruff, but exempting the whole module would silence the
        # only undefined-name diagnostic available here — a misspelled setting
        # in a future branch would then crash every new pod at import time with
        # a green gate. Both names are defined in settings.py (verified).
        'CONN_MAX_AGE': CONN_MAX_AGE,  # noqa: F405
        'CONN_HEALTH_CHECKS': CONN_HEALTH_CHECKS,  # noqa: F405
    },
}

if os.environ.get("LOCALDEV"):
    CSRF_TRUSTED_ORIGINS = [
        'http://localhost:3000',
        'https://localhost:3000',
        'http://localhost:8000',
        'https://localhost:8000',
        'http://127.0.0.1:3000',
        'https://127.0.0.1:3000',
        'https://127.0.0.1:8000',
        'http://127.0.0.1:8000',
        'https://test.free2z.com',
    ]
else:
    # Browser form actions handled by SvelteKit forward the browser's exact
    # public origin through the authenticated server-to-server bridge. The
    # bridge has its own exact allowlist and the nginx sidecar deliberately
    # routes to Django as secure localhost, so Django must trust the same
    # finite set of deployed origins. Do not replace these with '*' or a
    # subdomain wildcard: a compromised unrelated subdomain must not become a
    # trusted CSRF origin.
    CSRF_TRUSTED_ORIGINS = [
        'https://free2z.cash',
        'https://free2z.com',
        'https://free2give.xyz',
        'https://stage.free2z.cash',
        'https://stage.free2z.com',
        'https://stage.free2give.xyz',
        'https://test.free2z.cash',
        'https://test.free2z.com',
        'https://test.free2give.xyz',
        'https://new.free2z.cash',
        'https://new.free2z.com',
        'https://new.free2give.xyz',
    ]

if not os.environ.get("LOCALDEV"):
    ZCASH_CHALLENGE_ALLOW_LOCAL_CACHE = False
    NATIVE_RETURN_ALLOW_LOCAL_CACHE = False
    ZCASH_AUTH_ALLOW_REMOTE_ADDR_FALLBACK = False
    CHANNEL_LAYERS = {
        'default': redis_channel_layer_config(
            # test, stage, prod
            prefix=os.getenv('DBNAME', 'test'),
        ),
    }
    #. redis-py's socket_timeout and socket_connect_timeout both default
    # to None, and django_redis passes nothing unless told to -- so a Redis
    # that accepts the connection and then goes silent blocked EVERY API
    # request forever (the throttles read this cache on each one), on a pod
    # with one sync worker. IGNORE_EXCEPTIONS cannot help with a hang:
    # there is no exception to ignore until something times out. Every command
    # issued through these aliases is a sub-millisecond GET/SET/INCR or a tiny
    # Lua script (no BLPOP or other blocking command -- checked), so 2s/3s is
    # generous; on expiry "default" fails open as documented below and
    # "stripe_checkout_admission" refuses. Same shape as the channel layer's
    # CHANNEL_REDIS_SOCKET_* bounds (dj/free2z/channel_layer_config.py).
    CACHE_REDIS_SOCKET_OPTIONS = {
        "SOCKET_CONNECT_TIMEOUT": 2,
        "SOCKET_TIMEOUT": 3,
    }
    CACHES = {
        "default": {
            "BACKEND": "django_redis.cache.RedisCache",
            "LOCATION": (
                f"redis://{CHANNEL_REDIS_HOST}:{CHANNEL_REDIS_PORT}/1"
            ),  # Redis server and database number
            "OPTIONS": {
                "CLIENT_CLASS": "django_redis.client.DefaultClient",
                "PREFIX": os.getenv('DBNAME', 'test'),  # Using the same prefix as for CHANNEL_LAYERS
                # This cache is now on the path of EVERY API request: DRF's
                # throttles do a cache.get()+cache.set() per request.
                # django_redis defaults IGNORE_EXCEPTIONS to False, which would
                # turn a Redis blip at the configured address above into a 500
                # across the whole API rather than a degraded feature.
                #
                # Failing open is the correct direction for every current user
                # of this cache, which was checked rather than assumed:
                #   - throttling      -> no rate limiting (degraded, not down)
                #   - zauth admission -> bypasses django-redis and both atomic
                #                        limiters raise 503 on raw Redis errors
                #   - zauth v1 bridge -> bypasses django-redis and requires a
                #                        write/consume acknowledgement or 503
                #   - zauth replay    -> PostgreSQL uniqueness is authoritative;
                #                        Redis loss cannot reopen a used token
                #   - social OAuth    -> pop_state() returns None, callback is
                #                        REFUSED (fails closed, safe)
                #   - pricing lock    -> cache.add() falsy, refresh is skipped
                #                        (stale price, no thundering herd)
                #   - reset-email cap -> per-address cap not applied; the
                #                        PasswordResetToken row is still needed
                # No cache user turns a swallowed error into an auth bypass.
                #
                # ONE user of this cache fails CLOSED, opposite every entry
                # above, and it is here so that is a decision rather than an
                # incident discovery:
                #   - TOTP attempt    -> claim_totp_attempt() (dj.apps.otp.utils)
                #     counter            is the bounded-guess counter on every
                #                        TOTP gate. IGNORE_EXCEPTIONS makes
                #                        add()/incr() return None instead of
                #                        raising, the helper cannot tell an
                #                        unlimited guessing lane from a working
                #                        one, so it returns None and each caller
                #                        answers 503.
                # Failing closed is right for a rate limiter -- swallowing the
                # error would hand an attacker unlimited six-digit guesses --
                # but state the cost plainly: while Redis is down, every
                # MFA-enrolled account is refused password change, password
                # reset, and social/Zcash/Twitter sign-in.
                #
                # And that assumption has MOVED, on purpose: the
                # credential throttles (sign-in, signup, reset, OTP, OAuth
                # starts) count in "auth_throttle" below, which does not
                # swallow errors, and they answer 503 when it is down. A
                # Redis outage is therefore a full password/OTP/OAuth sign-in
                # outage -- chosen over an unmetered guessing lane (epic
                # ). Session and Knox traffic still fails open here.
                "IGNORE_EXCEPTIONS": True,
                **CACHE_REDIS_SOCKET_OPTIONS,
            }
        },
        "stripe_checkout_admission": {
            "BACKEND": "django_redis.cache.RedisCache",
            "LOCATION": (
                f"redis://{CHANNEL_REDIS_HOST}:{CHANNEL_REDIS_PORT}/1"
            ),
            "KEY_PREFIX": os.getenv('DBNAME', 'test'),
            "OPTIONS": {
                "CLIENT_CLASS": "django_redis.client.DefaultClient",
                # The broad API throttle fails open; a financial provider
                # admission bucket must instead refuse before a Stripe call.
                "IGNORE_EXCEPTIONS": False,
                **CACHE_REDIS_SOCKET_OPTIONS,
            },
        },
        #the credential throttles' counters (dj.free2z.throttling.
        # FailClosedAuthThrottleMixin). Same Redis and key namespace shape as
        # the Stripe alias above, and for the same reason: an error must
        # REACH the throttle so it can refuse with 503. On "default" it is
        # swallowed and the throttle reads an empty history -- fail-open by
        # construction, whatever the throttle class says. The socket bounds
        # turn a silent Redis into a 503 within ~3s rather than a hung worker.
        # Pinned by dj/apps/test_auth_throttle_fail_closed.py.
        "auth_throttle": {
            "BACKEND": "django_redis.cache.RedisCache",
            "LOCATION": (
                f"redis://{CHANNEL_REDIS_HOST}:{CHANNEL_REDIS_PORT}/1"
            ),
            "KEY_PREFIX": os.getenv('DBNAME', 'test'),
            "OPTIONS": {
                "CLIENT_CLASS": "django_redis.client.DefaultClient",
                "IGNORE_EXCEPTIONS": False,
                **CACHE_REDIS_SOCKET_OPTIONS,
            },
        },
    }
    # Swallowed cache errors must still be visible; otherwise a Redis outage
    # degrades rate limiting silently and nobody finds out until the bill.
    #
    # This is now an alerting contract, not just a courtesy. Because
    # IGNORE_EXCEPTIONS is True above, an ordinary Redis outage is absorbed
    # HERE and never reaches FailOpenThrottleMixin, so the log line django_redis
    # emits under this flag is the only trace that every throttle is reading an
    # empty history. settings.DJANGO_REDIS_LOGGER + LOGGING format that record
    # as one JSON line, monitoring/log-metrics/redis-ignored-exceptions.json
    # counts it, and monitoring/alert-policies/throttle-fail-open.json pages on
    # it. Turning this off blinds that condition.
    DJANGO_REDIS_LOG_IGNORED_EXCEPTIONS = True

DBBACKUP_CONNECTORS = {
    'default': {
        'USER': 'dbuser',
        'PASSWORD': os.environ["DBPASS"],
    }
}

USE_X_FORWARDED_HOST = True
SENDGRID_SANDBOX_MODE_IN_DEBUG = False
