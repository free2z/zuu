import math
import os
import re
import sys
from pathlib import Path


from corsheaders.defaults import default_headers
from django.core.exceptions import ImproperlyConfigured
from django.core.management.utils import get_random_secret_key

from dj.util.mimetypes_registry import register_mime_types

# MUST run before anything can call mimetypes.guess_type(), which is what
# django-storages uses — and the ONLY thing it uses — to set the GCS blob
# content_type, i.e. the Content-Type nginx serves from /uploadz/
# (storages/backends/gcloud.py:45 and:209, pinned 1.14.6; no
# GS_OBJECT_PARAMETERS is set below). Settings are imported during
# django.setup() before the app registry is populated, so this precedes every
# model, storage backend, view, worker and management command.
#
# Without it the served Content-Type is whatever the interpreter's built-in
# table plus the base image's /etc/mime.types happen to say, which on the
# python:3.10-bullseye image pinned at the time meant.webp -> None (288
# objects, plus every generated thumbnail and image variant, served as
# application/octet-stream) and.m4a -> audio/mpeg (wrong). The registry keeps
# that answer independent of the base image (python:3.12-bookworm since ).
# See dj/util/mimetypes_registry.py and.
# dj.util imports nothing from Django, so this cannot raise AppRegistryNotReady.
register_mime_types()

# Build paths inside the project like this: BASE_DIR / 'subdir'.
# py/dj/free2z
BASE_DIR = Path(__file__).resolve().parent

# py/dj/free2z/static
STATIC_ROOT = f"{BASE_DIR}/static"


def _positive_float_env(name: str, default: float) -> float:
    """Read a finite, strictly-positive float from the environment.

    Tuning knobs must never be able to take the fleet down or silently void
    themselves. A missing, malformed, non-positive, infinite or NaN value
    falls back to `default` and says so on stderr (this runs at import time,
    before logging is configured). NaN matters specifically: `float("nan")`
    parses fine but makes every `x < LIMIT` comparison False, which would
    quietly disable a guard expressed that way.
    """
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = None
    if value is None or not math.isfinite(value) or value <= 0:
        print(
            f"[settings] {name}={raw!r} is not a finite positive number; "
            f"falling back to {default}",
            file=sys.stderr,
        )
        return default
    return value


def _boolean_env(name: str, default: bool = False) -> bool:
    """Read a boolean feature switch, failing safely on malformed values."""
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    print(
        f"[settings] {name}={raw!r} is not a boolean; "
        f"falling back to {default}",
        file=sys.stderr,
    )
    return default


def _strict_boolean_env(name: str, default: bool = False) -> bool:
    """Read an operational switch and reject malformed deployment config."""
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ImproperlyConfigured(f"{name} must be a boolean")


def _choice_env(name: str, choices: set[str], default=None):
    """Read, normalize, and startup-validate a deployment enum."""
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    value = raw.strip().lower()
    if value == "unset":
        return default
    if value not in choices:
        raise ImproperlyConfigured(
            f"{name} must be one of {', '.join(sorted(choices))}"
        )
    return value

def _int_env(name: str, default: int, minimum: int = 0) -> int:
    """Read a non-negative integer knob; malformed values fall back loudly."""
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        value = None
    if value is None or value < minimum:
        print(
            f"[settings] {name}={raw!r} is not an integer >= {minimum}; "
            f"falling back to {default}",
            file=sys.stderr,
        )
        return default
    return value


def _lenient_choice_env(name: str, choices: set[str], default: str) -> str:
    """Like ``_choice_env`` but a typo falls back to ``default`` (fail SAFE,
    not fail-to-boot): used for feature switches whose safe state is the
    default, where taking the whole fleet down over a typo is the larger
    blast radius."""
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    value = raw.strip().lower()
    if value not in choices:
        print(
            f"[settings] {name}={raw!r} is not one of "
            f"{', '.join(sorted(choices))}; falling back to {default}",
            file=sys.stderr,
        )
        return default
    return value


# Quick-start development settings - unsuitable for production
# See https://docs.djangoproject.com/en/3.2/howto/deployment/checklist/

SECRET_KEY = os.environ.get('SECRET_KEY', get_random_secret_key())
# True when SECRET_KEY above is the per-process random fallback rather than a
# configured value. Every pod then has a DIFFERENT key, so anything keyed on
# it is unverifiable on the next pod and gone on the next restart. Code that
# persists a SECRET_KEY-keyed value (dj.apps.identity.recovery) refuses to
# run while this is set, rather than minting codes nobody can redeem.
SECRET_KEY_IS_EPHEMERAL = not os.environ.get('SECRET_KEY')

OPENAI_IMAGE_MODEL = os.environ.get(
    "OPENAI_IMAGE_MODEL", "gpt-image-2-2026-04-21"
)
# fal is advertised as an explicit creator choice only when its policy
# switch, secret, endpoint, approved tariff and UTC-day spend cap are configured.
FAL_API_KEY = os.environ.get("FAL_API_KEY", "")
FAL_IMAGE_ENABLED = _boolean_env("FAL_IMAGE_ENABLED", False)
FAL_IMAGE_MODEL_VERSION = os.environ.get(
    "FAL_IMAGE_MODEL_VERSION", "FLUX.1 [schnell]",
)
FAL_IMAGE_APPROVED_PRICE_USD = os.environ.get(
    "FAL_IMAGE_APPROVED_PRICE_USD", "",
)
FAL_IMAGE_DAILY_BUDGET_USD = os.environ.get(
    "FAL_IMAGE_DAILY_BUDGET_USD", "",
)
# Bound one account's spend, including refunded moderation and uncertain calls.
FAL_IMAGE_ACCOUNT_DAILY_BUDGET_USD = os.environ.get(
    "FAL_IMAGE_ACCOUNT_DAILY_BUDGET_USD", "0.06",
)

# SECURITY WARNING: don't run with debug turned on in production!
DEBUG = True

ALLOWED_HOSTS = []

INTERNAL_IPS = [
    '127.0.0.1',
]

ASGI_APPLICATION = 'dj.free2z.asgi.application'

AUTH_USER_MODEL = 'g12f.Creator'

INSTALLED_APPS = [
    # Key-transparency handle authority (docs/free2z/messaging/KT.md in free2z/zuu). NO
    # models and NO migrations -- it is listed because its AppConfig fetches
    # the Ed25519 issuing key once at boot. See dj/apps/ktauth/__init__.py for
    # the trust model.
    #
    # FIRST, and the position is load-bearing. `get_commands()`
    # iterates `reversed(apps.get_app_configs())` and lets later `update()`
    # calls win, so a management command defined in two apps resolves to the
    # one EARLIEST in this list. `ktauth` overrides `changepassword` -- an
    # operator replacing a password from the shell is the same
    # account-ownership event as one replaced through the API, and the counter
    # has to move for it -- and `django.contrib.auth` would otherwise win.
    # The app carries no templates and no static files, so being first shadows
    # nothing; `ready()` order is irrelevant because Django runs every app's
    # `ready()` only after the whole registry is populated.
    'dj.apps.ktauth',
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
    'dj.apps.economy',
    'corsheaders',
    'rest_framework',
    # `rest_framework.authtoken` is deliberately NOT installed. It
    # issued a permanent key on every login until  and authenticated
    # nothing; g12f migration 0113 purges the rows it left in
    # `authtoken_token` and drops that table's FK to Creator, so an account
    # delete can no longer trip over a row Django does not know about. The
    # empty table itself is dropped in a later release  -- the
    # previous release (what a rollout or a rollback runs) still reads it.
    'dj_rest_auth',
    'drf_spectacular',
    # django-oauth-toolkit (sdk-v1 I3). Every one of its models is
    # SWAPPED into dj.apps.oidc (OAUTH2_PROVIDER_*_MODEL below), so its own
    # migrations create no table here; it is installed for the migration
    # graph, the validator/server machinery and the admin. Its URLconf and
    # templates are deliberately NOT mounted: the endpoints are DRF views in
    # dj.apps.oidc so they appear in f2z.yaml.
    'oauth2_provider',
    'dbbackup',
    'knox',
    'django_filters',
    'taggit',
    # Postgres-native task queue (image variants, ). Must appear
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
    'dj.apps.social',
    # Sign-in method registry and last-method guard. No models; it
    # reads zauth/social/twitter through the app registry.
    'dj.apps.identity',
    # The OIDC identity provider (sdk-v1 I3): registered apps, grants,
    # ES256 JWT access tokens, refresh-token families. Self-contained; the
    # only foreign keys are to the user model.
    'dj.apps.oidc',
    'dj.apps.zuuli',
    # E2EE messaging handles: the stored account -> handle binding that
    # dj.apps.ktauth vouches for (free2z/zuu#1022, workstream 7).
    'dj.apps.handles',
    # The 2Z money paths (donate/subscribe views) have always lived here; the
    # app was only missing from INSTALLED_APPS because it had no models. It
    # has one now: tuzis.models.IdempotencyKey.
    'dj.apps.tuzis',
    # The 2Z double-entry ledger ( Pillar 2, docs/tuzis/ledger-v2.md).
    # Self-contained: tables + SQL functions in the `ledger` schema. Migration
    # L1  creates them; nothing calls them until the dual-write release.
    'dj.apps.ledger',
    # Purchase intents ( Pillar 2, PU1 ): PurchaseIntent +
    # PurchaseReceipt and the SDK's POST/GET /api/sdk/v1/purchases. Card
    # only for now; the credit is still posted by dj.apps.ztripe.fulfillment.
    'dj.apps.purchases',
    # Paid requests to start an e2e2z encrypted chat (free2z/zuu#1022,
    # workstream 6). Its task module defines e2ee.send_chat_request_email.
    'dj.apps.e2ee',
    # Procrastinate queue observability: the periodic health sweep
    # and the job_health management command. Must come after
    # procrastinate.contrib.django.
    'dj.apps.jobs',
    'dj.apps.exports',
]

# Worker containers set this hook together with
# PROCRASTINATE_WORKER_POOL_SIZE. It leaves web/API processes on Django's
# normal connector while bounding each worker's Procrastinate metadata pool
# to its actual task concurrency.
PROCRASTINATE_ON_APP_READY = 'dj.apps.jobs.procrastinate_pool.configure'

MIDDLEWARE = [
    # Host-level boundary for Stripe's signed native return URLs. This is the
    # only middleware allowed ahead of the health probe: it reads no database,
    # auth, session, or URLconf state and uses the routed Host plus proxy-aware
    # scheme while deliberately ignoring untrusted X-Forwarded-Host.
    # Requests for any other path on the dedicated callback host get a private
    # 404 before /api/healthz or CommonMiddleware can answer/redirect them.
    'dj.apps.ztripe.middleware.NativeCheckoutReturnBoundaryMiddleware',
    # MUST STAY AHEAD OF EVERY GENERAL MIDDLEWARE. It answers GET /api/healthz
    # for the kubelet. The callback boundary above has the same no-DB/no-auth
    # construction and passes every non-callback Host straight through.
    # startupProbes on free2z-gunicorn and free2z-daphne
    # (k8s/free2z/deployment.yaml) and for the Cloud Monitoring uptime
    # checks (monitoring/uptime-checks/), and the
    # position is what makes that work: kubelet sends `Host: <pod-ip>`, which
    # is not in ALLOWED_HOSTS and can never be, so any middleware below
    # SecurityMiddleware/CommonMiddleware would see the request only after
    # request.get_host() had already turned it into a 400. Moving this down
    # the list makes every probe in production fail while every test that
    # uses `testserver` keeps passing. See dj/apps/health/middleware.py.
    'dj.apps.health.middleware.HealthCheckMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
    # Wraps CorsMiddleware: no Allow-Credentials under /api/sdk/v1/.
    'dj.apps.oidc.cors.SdkCorsWithoutCredentialsMiddleware',
    'corsheaders.middleware.CorsMiddleware',
    #one structured WARNING line (event=write_rejected) per 4xx on a
    # write under /api/ or /uploads/ -- route pattern, status, field names and
    # DRF error codes, never values. Below AuthenticationMiddleware so it can
    # read the user; outside AtomicMiddleware so it sees the final response.
    'dj.util.rejected_writes.RejectedWriteLogMiddleware',
    # 'debug_toolbar.middleware.DebugToolbarMiddleware',
    # TODO: this will be fine for now but eventually we may want to
    # be more specific for performance reasons.
    'dj.util.middleware.AtomicMiddleware',
    'dj.util.middleware.ExceptionMiddleware',
    # LAST, i.e. INNERMOST, deliberately. It reads a 404 that the view
    # layer has already produced and turns `/{username}/` -- the shape a
    # shared link actually carries -- into a 301 onto the slashless URL the
    # crawler prerender tier serves.
    #
    # Innermost means its RESPONSE phase runs BEFORE CommonMiddleware's, not
    # after; do not read this position as "APPEND_SLASH gets first refusal",
    # because it does not. The two simply cannot contend: APPEND_SLASH acts
    # only on a path that does NOT end in `/`, and this one acts only on a
    # path that does. What the position actually buys is the smallest possible
    # surface -- it never sees a request that HealthCheckMiddleware, the
    # Stripe callback boundary, ALLOWED_HOSTS or CSRF already answered.
    #
    # It is a middleware rather than a URL pattern because a registered
    # pattern makes `is_valid_path("<anything>/")` true, which is exactly what
    # CommonMiddleware asks before applying APPEND_SLASH -- so every slashless
    # URL that does not resolve would start redirecting instead of 404ing,
    # `/api/<unmatched>` included. Measured, not theorised; see the module
    # docstring.
    'dj.apps.g12f.middleware.CrawlerTrailingSlashMiddleware',
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
CORS_ALLOW_HEADERS = (
    *default_headers,
    # Response-shape negotiation for new Svelte readers. Django defaults to
    # legacy content URLs so an already-loaded classic bundle stays compatible
    # across a backend rollout; new readers explicitly request canonical URLs.
    "x-free2z-canonical-content-url",
    "x-free2z-source-language",
    # Double-charge protection on the 2Z credit paths. corsheaders'
    # default_headers does NOT include it, so without this line the preflight
    # for a cross-origin POST carrying Idempotency-Key is rejected and a
    # browser client physically cannot send the header -- the protection would
    # be documented (issue  F8) but unreachable from the web. Same-origin
    # callers were unaffected, which is why this went unnoticed.
    "idempotency-key",
    # The retirement half of that protection. A browser holding a
    # pre- non-UUID subscribe key can no longer send it as
    # Idempotency-Key, and hands it over here so the server can replay the
    # receipt it may already have. Exactly the same preflight trap as the
    # line above: omit it and a cross-origin subscribe silently loses the
    # only evidence that the earlier charge happened, which is a second month
    # off the fan's balance.
    "x-superseded-idempotency-key",
    # Optimistic-concurrency precondition on zPage writes. Exactly the
    # same trap as idempotency-key above: corsheaders' default_headers does not
    # include it, so without this line a cross-origin PUT carrying If-Match
    # fails preflight and the browser client silently falls back to
    # last-write-wins -- the protection documented in f2z.yaml, unreachable
    # from anything but a same-origin page. (codex adversarial review.)
    "if-match",
    # Legacy chat receipt discriminator. The classic chat client retries a
    # completed request with the original model id so a model change cannot
    # turn a lost response into a second charge; registered cross-origin
    # browser clients need the header allowed by preflight too.
    "x-ai-generation-model",
    # Its create-only twin on variant writes, `If-None-Match: *`. The
    # same preflight trap: without it a cross-origin client starting a new
    # translation cannot send the header and silently gets create-or-replace.
    "if-none-match",
    # Actor and receipt preconditions on paid AI requests. corsheaders' default
    # list omits both, so a cross-origin browser cannot send the account guard
    # (or the image replay-only guard) unless each is explicitly allowed here.
    "x-expected-actor",
    "x-require-existing-receipt",
)
CORS_EXPOSE_HEADERS = [
    "Set-Cookie",
    # And the other half: a cross-origin reader cannot see a response header
    # that is not exposed, so without this it could never obtain the validator
    # it is supposed to send back.
    "ETag",
    # The SDK's polling and 429 hint: a browser app on a registered
    # origin cannot read it unless it is exposed.
    "Retry-After",
]

# Public ZUULI release compatibility policy. Keep this as the single source of
# truth for every app platform; the endpoint copies only its explicitly
# allowlisted fields, so secrets and unrelated settings cannot leak through it.
# StoreKit and Play Billing stay disabled until their receipt verification,
# idempotent crediting, refund, and revocation paths land under issue.
_ZUULI_ZCASH_NETWORK = _choice_env(
    "ZUULI_ZCASH_NETWORK", {"mainnet", "testnet", "regtest"}
)
_ZUULI_MAINTENANCE_ENABLED = _strict_boolean_env(
    "ZUULI_MAINTENANCE_ENABLED"
)
# Fail closed across the manual Ingress rollout. Enabling this before the exact
# protected routes are live would expose signed return credentials to GCLB logs
# and put Stripe latency back on the main API worker pool.
ZUULI_NATIVE_CHECKOUT_ENABLED = _strict_boolean_env(
    "ZUULI_NATIVE_CHECKOUT_ENABLED"
)
ZUULI_SOCIAL_AUTH_ENABLED = _strict_boolean_env(
    "ZUULI_SOCIAL_AUTH_ENABLED"
)

ZUULI_RELEASE_POLICY = {
    "contract_version": 1,
    "maintenance": {
        "enabled": _ZUULI_MAINTENANCE_ENABLED,
        "message": (
            "ZUULI is temporarily unavailable."
            if _ZUULI_MAINTENANCE_ENABLED
            else None
        ),
    },
    "platforms": {
        platform: {
            # 0.0.0 keeps the pre-store deployment non-bricking. Raising this
            # is startup-rejected until the platform has a download URL.
            "minimum_supported": "0.0.0",
            "current_recommended": "0.0.0",
            "download_url": None,
        }
        for platform in ("ios", "android", "macos", "linux")
    },
    "capabilities": {
        "auth": {
            "password": True,
            # The deployed verifier currently reconstructs mainnet addresses.
            "zcash": _ZUULI_ZCASH_NETWORK == "mainnet",
            # Provider credentials are deployment-specific. Do not advertise
            # social auth until an operator has verified at least one provider
            # in that environment and explicitly enables the aggregate flag.
            "social": ZUULI_SOCIAL_AUTH_ENABLED,
        },
        "wallet": {
            "zcash_login": _ZUULI_ZCASH_NETWORK == "mainnet",
            "zec_pricing": True,
        },
        "commerce": {
            "two_z_ledger": True,
            # The ZEC credit loop is external to this deployment and has no
            # health proof yet, so never advertise this irreversible path.
            "zec_purchase": False,
            "storekit": False,
            "play_billing": False,
        },
    },
    "public_config": {
        "api_base_path": "/api/",
        "openapi_path": "/api/schema/",
        # Null means clients MUST NOT enable a wallet/payment network from this
        # contract. Stage/test/prod each opt in explicitly after their receiver,
        # credit loop, and balance database are proven to match.
        "zcash_network": _ZUULI_ZCASH_NETWORK,
    },
    "cache_max_age_seconds": 300,
}

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

# Server-generated checkout URLs need a public base even for clients that do
# not send an Origin header. Production replaces this with the per-namespace
# value from k8s/free2z/config.yaml; local development stays on the UI port.
CANONICAL_ORIGIN = os.environ.get(
    'CANONICAL_ORIGIN', 'http://localhost:3000'
).rstrip('/')
# Stripe's signed mobile-return query credentials use a dedicated hostname
# whose entire GCLB backend disables request logging. Production supplies the
# namespace-specific host from the ConfigMap. Local development shares its
# ordinary origin because there is no load-balancer security boundary.
ZUULI_NATIVE_CHECKOUT_RETURN_ORIGIN = os.environ.get(
    'ZUULI_NATIVE_CHECKOUT_RETURN_ORIGIN', CANONICAL_ORIGIN
).rstrip('/')

# --------------------------------------------------------------------------
# The OIDC identity provider (sdk-v1 I3; contract: zuu docs/free2z/sdk/spec/
# oidc.md). django-oauth-toolkit with every model swapped into dj.apps.oidc.
# --------------------------------------------------------------------------
OAUTH2_PROVIDER_APPLICATION_MODEL = 'oidc.F2ZApplication'
OAUTH2_PROVIDER_GRANT_MODEL = 'oidc.AuthorizationCode'
OAUTH2_PROVIDER_ACCESS_TOKEN_MODEL = 'oidc.AccessToken'
OAUTH2_PROVIDER_REFRESH_TOKEN_MODEL = 'oidc.RefreshToken'
OAUTH2_PROVIDER_ID_TOKEN_MODEL = 'oidc.IDToken'
# Swapped too, although no device grant exists here: it keeps every table of
# the provider under `oidc_*` and lets django-oauth-toolkit's own migrations
# create nothing in this database.
OAUTH2_PROVIDER_DEVICE_GRANT_MODEL = 'oidc.DeviceGrant'

# The issuer (`iss`) every token carries and every resource server compares
# by exact string. CANONICAL_ORIGIN is https://free2z.cash in prod_settings;
# here it is the local dev origin, so a token minted locally is refused by a
# resource server configured for prod, which is the right direction.
OIDC_ISSUER = os.environ.get('OIDC_ISSUER', '').rstrip('/') or CANONICAL_ORIGIN

# Signing keys, PEM text from the environment (owner-provisioned, Secret
# Manager -> env). Several PEM blocks may be concatenated: the FIRST is the
# active key, the rest are retired keys still published in the JWKS so a
# resource server can verify a token minted just before a rotation (spec
# §6.1: at least 24 hours). `manage.py oidc_rotate_keys` produces a new block.
#
# When both are empty, dj.apps.oidc.keys generates a per-process pair IF
# OIDC_ALLOW_GENERATED_KEYS is True -- dev and pytest -- and REFUSES otherwise:
# prod_settings sets it False, so a production pod with no key fails
# `manage.py check` (and so `migrate`, and so the deploy) with a message that
# names the variables, rather than minting tokens nobody else can verify.
OIDC_ES256_PRIVATE_KEYS = os.environ.get('OIDC_ES256_PRIVATE_KEYS', '')
OIDC_RS256_PRIVATE_KEYS = os.environ.get('OIDC_RS256_PRIVATE_KEYS', '')
OIDC_ALLOW_GENERATED_KEYS = True

# Where the account epoch and grant generation are published for resource
# servers (the AI gateway): the shared Redis behind CACHES['default'] in
# prod, under `<namespace>:aep:<sub>` and `<namespace>:agen:<client_id>:
# <sub>`. Namespaced by DBNAME like every other shared-Redis key here so
# stage and prod cannot read each other's epochs.
OIDC_EPOCH_REDIS_NAMESPACE = os.environ.get('DBNAME', 'free2z')
# Published entries expire after one access-token lifetime. A resource
# server that misses one fails closed and asks the internal epoch endpoint
# (which reads the row), so the TTL is what bounds how long a publication
# that never landed can leave a stale counter readable: at most as long as
# the token it would wrongly admit. Not a memory setting.
OIDC_EPOCH_REDIS_TTL_SECONDS = 300
# The periodic sweep of expired codes/tokens (dj.apps.oidc.tasks). Hourly at
#17, off the top of the hour that every other cron here shares. Revoked
# refresh tokens -- the reuse evidence -- are kept 30 days regardless.
OIDC_TOKEN_SWEEP_CRON = os.environ.get("OIDC_TOKEN_SWEEP_CRON", "17 * * * *")
# Shared secret the gateway presents to GET /api/oauth/internal/epoch/<sub>.
# Empty = the endpoint answers 503 and nothing else; it never falls open.
OIDC_INTERNAL_API_TOKEN = os.environ.get('OIDC_INTERNAL_API_TOKEN', '')

# Enable only after verifying that the deployed AI gateway uses the cap-enforcing
# L2 ledger. The SDK grant endpoint also verifies exact projection and cutover state.
from .sdk_activation import sdk_ai_grants_enforced
SDK_AI_GRANTS_ENFORCED = sdk_ai_grants_enforced(os.environ)

OAUTH2_PROVIDER = {
    'OIDC_ENABLED': True,
    'OIDC_ISS_ENDPOINT': OIDC_ISSUER,
    'OAUTH2_VALIDATOR_CLASS': 'dj.apps.oidc.validators.F2ZOAuth2Validator',
    'SCOPES': {
        'openid': 'Sign you in and identify your account',
        'profile': 'Your username, display name and avatar',
        'email': 'Your email address',
        'offline_access': 'Stay signed in (a refresh token)',
        'balance:read': 'Read your 2Z balance',
        'purchase:create': 'Start 2Z purchases on your behalf',
        'ai:invoke': 'Call AI through the gateway, paid from your 2Z',
    },
    'DEFAULT_SCOPES': [],
    # Spec §6/§7/§8/§9.2, in seconds.
    'ACCESS_TOKEN_EXPIRE_SECONDS': 300,
    'ID_TOKEN_EXPIRE_SECONDS': 3600,
    'AUTHORIZATION_CODE_EXPIRE_SECONDS': 60,
    'REFRESH_TOKEN_EXPIRE_SECONDS': 30 * 24 * 3600,
    'ROTATE_REFRESH_TOKEN': True,
    'REFRESH_TOKEN_GRACE_PERIOD_SECONDS': 60,
    'REFRESH_TOKEN_REUSE_PROTECTION': True,
    # The access token is an ES256 JWT (RFC 9068); the refresh token stays
    # an opaque random string. The second entry is load-bearing: oauthlib
    # falls back to the ACCESS token generator for refresh tokens when none
    # is set, which would hand out a signed JWT as a refresh token.
    'ACCESS_TOKEN_GENERATOR': 'dj.apps.oidc.tokens.generate_access_token',
    'REFRESH_TOKEN_GENERATOR': 'oauthlib.oauth2.rfc6749.tokens.random_token_generator',
    'PKCE_REQUIRED': True,
    'ALLOWED_REDIRECT_URI_SCHEMES': ['https', 'http'],
    'ALLOW_URI_WILDCARDS': False,
    'ALLOW_LOCALHOST_LOOPBACK': False,
    'OIDC_RESPONSE_TYPES_SUPPORTED': ['code'],
    'OIDC_TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED': [
        'none', 'client_secret_basic', 'client_secret_post',
    ],
    'OAUTH2_RESPONSE_TYPES_SUPPORTED': ['code'],
    'OAUTH2_GRANT_TYPES_SUPPORTED': ['authorization_code', 'refresh_token'],
    # RFC 9700 gates, all ON except token hashing: hashed-at-rest refresh
    # tokens are incompatible with the 60 s rotation grace the spec requires
    # (django-oauth-toolkit check E001), so refresh tokens are stored as
    # issued. The database is already the store of every session key hash
    # and every Knox digest; this is one more row class to protect.
    'COMPLIANT_BCP_RFC9700_IMPLICIT_GRANT': True,
    'COMPLIANT_BCP_RFC9700_PASSWORD_GRANT': True,
    'COMPLIANT_BCP_RFC9700_PKCE_METHOD': True,
    'COMPLIANT_BCP_RFC9700_ACCESS_TOKEN_TRANSPORT': True,
    'COMPLIANT_BCP_RFC9700_AUTHZ_RESPONSE_ISS': True,
    'COMPLIANT_BCP_RFC9700_TOKEN_STORAGE': False,
    'COMPLIANT_BCP_RFC9700_REFRESH_TOKEN': True,
    'COMPLIANT_BCP_RFC9700_REDIRECT_URI_SCHEME': False,  # loopback needs http
    'COMPLIANT_BCP_RFC9700_REDIRECT_URI_MATCHING': True,
    'COMPLIANT_BCP_RFC9700_PKCE_REQUIRED': True,
    'APPLICATION_ADMIN_CLASS': 'dj.apps.oidc.admin.F2ZApplicationAdmin',
}

# ---------------------------------------------------------------------------
# zPage variant dual write ( M3)
# ---------------------------------------------------------------------------
# ON by default: every write to the legacy content shape (zPage's own columns,
# ZPageTranslation rows) also writes the matching ZPageVariant row, so the two
# shapes are in step before M5 flips reads over.
#
# THIS SWITCH IS INERT WHILE ZPAGE_VARIANT_READS IS ON, WHICH IT IS IN
# PRODUCTION. It used to say "nothing reads the variant table yet, so
# turning this off degrades nothing a user can see", and that was true right
# up until reads flipped. It is not true now: with reads on the mirror is the
# only path from a creator's write to a reader's screen, so turning it off
# does not stop a redundant copy, it serves every reader the pre-edit article
# while every write still returns 200 and nothing logs. The M2 backfill does
# not undo that -- it POPULATES missing rows, and these rows exist and are
# stale. `variants.dual_write_enabled()` therefore ignores this value whenever
# ZPAGE_VARIANT_READS is true, and that function is where the reasoning lives.
# Ignoring it is announced, not silent: WARNING in the pod logs on the first
# mirrored write, plus g12f.W001 under `manage.py check`.
#
# It is kept, not deleted, because it is still exactly the escape hatch it was
# designed to be in the documented rollback state (ZPAGE_VARIANT_READS back to
# "false"), and that state has to stay reachable until  M6 finishes and
# the legacy shape stops being written at all.
ZPAGE_VARIANT_DUAL_WRITE = _boolean_env('ZPAGE_VARIANT_DUAL_WRITE', True)

# ---------------------------------------------------------------------------
# zPage variant reads ( M5)
# ---------------------------------------------------------------------------
# OFF by default, and it must stay off until a corpus is proven clean. This is
# the switch that makes ZPageVariant the table a reader's bytes come from:
# the article page, the crawler card tier, sitemap alternates, search indexing,
# related pages, series, the zPage API and the variants API all resolve out of
# the variant rows instead of `zPage`'s own columns plus ZPageTranslation.
#
# Nothing about what a reader SEES is supposed to change. Under dual write
# (ZPAGE_VARIANT_DUAL_WRITE, above) the two shapes hold the same bytes, so the
# flip is a change of source, not of content -- which is exactly why the parity
# suite (dj/apps/g12f/test_zpage_variant_reads.py) asserts every resolved field
# byte-identical in both states rather than asserting the new behaviour.
#
# PRE-FLIGHT, in this order, and none of the steps is optional:
#
#   1. python manage.py reconcile_zpage_variants                  # measure
#   2. python manage.py reconcile_zpage_variants --repair
#   3. python manage.py reconcile_zpage_variants --fail-on-drift  # the gate
#   4. only now set ZPAGE_VARIANT_READS=true in k8s/free2z/config.yaml
#      and `kubectl rollout restart` the deployments + the worker.
#
# Step 3 is the gate because the M2 backfill POPULATES, it does not REPAIR:
# migrations run before pods roll, so old pods write the legacy shape with no
# mirror for the length of a rollout, and a re-run of the backfill skips every
# (zpage, language) pair that already exists. See the module docstring of
# dj/apps/g12f/management/commands/reconcile_zpage_variants.py.
#
# What a reader sees if this is flipped on a corpus with drift:
#   * diverged variant  -> the variant's (stale/wrong) text, not the legacy text
#   * missing translation variant -> the source language, as a fallback
#   * orphan variant    -> a translation the creator deleted, back from the dead
#   * missing SOURCE variant -> the legacy columns, plus a logged ERROR. A
#     missing row never blanks an article; see localization._variant_candidates.
# None of those is a paywall or draft bypass: redaction and draft filtering sit
# outside resolution and are asserted in both flag states by the parity suite.
#
# Rolling back is setting it to false and restarting. Dual write never stopped,
# so the legacy shape is still current and no data is lost in either direction.
# That promise is what makes the rollback lossless, and it is why
# ZPAGE_VARIANT_DUAL_WRITE is IGNORED -- not refused; nothing here can refuse a
# ConfigMap value -- while this is on: the two switches are not independent,
# and the combination "read variants, do not write them" is the one state in
# which a creator's write reaches nobody. Ignoring it is not silent: a false
# value read while this is on logs a WARNING from
# variants.dual_write_enabled() and is reported by manage.py check
# (dj/apps/g12f/checks.py, g12f.W001), so an operator who edits the ConfigMap,
# restarts, and sees no change can find out why.  M6
# is what ends this arrangement -- once the legacy shape stops being written,
# flipping this back becomes lossy and this comment has to change with it.
ZPAGE_VARIANT_READS = _boolean_env('ZPAGE_VARIANT_READS', False)

# ---------------------------------------------------------------------------
# WebAuthn relying party (EFM passkeys, dj/apps/efm)
# ---------------------------------------------------------------------------
# These three settings ARE the security binding a passkey is verified against
# before its public key is written to the database. They used to be computed
# from the incoming request -- `request.get_host()` for the RP ID and
# `request.build_absolute_uri('/')` for the origin -- which let the `Host`
# header pick the relying party. ALLOWED_HOSTS bounded it, but in
# production that list is wildcards across four domains, so the RP ID was not
# a constant and a passkey registered on one hostname silently failed on
# another.
#
# WebAuthn credentials are scoped to exactly ONE registrable domain; that is a
# protocol constraint, not something server code can widen. So we pick one
# domain (production: the canonical free2z.cash, see prod_settings.py) and any
# request arriving on another host verifies against that same RP -- the
# browser will simply not offer a passkey there, which is the honest outcome
# rather than minting credentials that only work on whichever hostname the
# user happened to use.
#
# There is deliberately no request-derived fallback: a blank value raises
# ImproperlyConfigured (dj/apps/efm/webauthn_config.py).
#
# NOTE: dj.apps.efm is currently OFFLINE -- no URLconf or ASGI router reaches
# it, so nothing reads these settings in a deployed process and the efm system
# check that used to validate them is no longer registered. They are kept, not
# live. See dj/apps/efm/__init__.py; anyone re-routing the app must re-register
# that check in the same commit.
#
# Defaults here are the LOCAL DEVELOPMENT values (the React dev server on
#3000 with Django on:8000); prod_settings.py recomputes them from the
# namespace's CANONICAL_ORIGIN.
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

# Account passkeys (dj.apps.identity, ). The WebAuthnCredential table
# ships before the passkey sign-in route, and the last-sign-in-method guard
# (dj.apps.identity.methods) must not count a passkey as a way in while no
# route can use it. The PR that adds the route sets this to True in the same
# change. A literal, not an environment variable: whether a route exists is
# a property of the code, not of the deployment.
IDENTITY_PASSKEY_SIGNIN_ENABLED = False

AUTHENTICATION_BACKENDS = [
    "django.contrib.auth.backends.ModelBackend",
]

# Temporary v1/v2 challenge-store rollout policy. These independent, strict
# controls make the authority transition safe during an ordinary rolling
# Deployment: first stop requiring the mirror while every pod still writes it,
# then stop writing only after every consumer is PostgreSQL-only. Both default
# ON and the production Deployment pins the initial phase to literal ``true``.
# Follow the exact A -> B -> C sequence in
# docs/security/zcash-auth-admission.md. Never roll back to v1 until one full
# CHALLENGE_TTL_SECONDS (currently 300 seconds) after the last mirror-writing
# pod drained. Malformed values and the locally unsafe false/true combination
# abort settings import instead of splitting issuance and login authority.
ZCASH_CHALLENGE_LEGACY_MIRROR_WRITES_ENABLED = _strict_boolean_env(
    "ZCASH_CHALLENGE_LEGACY_MIRROR_WRITES_ENABLED",
    True,
)
ZCASH_CHALLENGE_LEGACY_MIRROR_REQUIRED = _strict_boolean_env(
    "ZCASH_CHALLENGE_LEGACY_MIRROR_REQUIRED",
    True,
)
if (
    ZCASH_CHALLENGE_LEGACY_MIRROR_REQUIRED
    and not ZCASH_CHALLENGE_LEGACY_MIRROR_WRITES_ENABLED
):
    raise ImproperlyConfigured(
        "ZCASH_CHALLENGE_LEGACY_MIRROR_REQUIRED cannot be true when "
        "ZCASH_CHALLENGE_LEGACY_MIRROR_WRITES_ENABLED is false"
    )

# Atomic fixed-minute admission for Zcash challenge issuance. The temporary
# rollout mirror is bounded by the same admission before its exact address slot
# is written.
# The endpoint-specific proxy identity in zauth/admission.py first verifies
# nginx's overwritten socket peer against Google's GFE request ranges, then
# selects GCLB's second-from-right XFF element and ignores the attacker prefix.
# IPv4 identities stay host-specific, IPv4-mapped IPv6 folds into the same IPv4
# identity, and native IPv6 is grouped at /64 before hashing to prevent privacy-
# address rotation from allocating fresh buckets. Lua charges that authoritative
# client before parsing/validating the address;
# only a checksum-valid address can create its separate key. One source can
# therefore create at most 30 address keys per minute. There is deliberately
# no unauthenticated global bucket: any such bucket is a cheap, sustained
# Zcash-authentication kill switch.
ZCASH_CHALLENGE_ADMISSION_LIMITS = {
    "window_seconds": 60,
    "client": 30,
    "address": 5,
}
# Login admission is a separate client-only scope, charged before body parsing,
# durable claiming, or secp256k1 recovery. A client can accumulate proofs over
# the five-minute challenge lifetime, but can spend at most 30 verification
# attempts in one minute. Thirty permits ordinary retries and shared egress
# bursts while bounding CPU on the single-worker deployment. Challenge and
# login traffic cannot spend each other's budget.
ZCASH_LOGIN_ADMISSION_LIMITS = {
    "window_seconds": 60,
    "client": 30,
}
# Scope only the new Zcash-auth admission keys by the operator-selected
# database environment. admission.py hashes this value before every key is
# built, so even an accidentally huge value cannot create huge Redis keys. Do
# not use a global django-redis KEY_PREFIX here: changing that would split
# established cache/OAuth namespaces during a mixed-version rollout.
ZCASH_AUTH_ADMISSION_NAMESPACE = os.environ.get("DBNAME", "free2z")
# The cache backend is a declared part of this deployment's topology, not an
# implicit default.  Leaving CACHES unset makes Django synthesize a
# LocMemCache -- the right backend for this module, arrived at the wrong way,
# because nothing in the tree then states what the cache IS.   read that
# absence as "the Zcash challenge store has no shared backend", which is not
# what is deployed: prod_settings points CACHES at the shared Redis
# (Memorystore, the same instance CHANNEL_LAYERS uses) for every non-LOCALDEV
# environment, and dj/apps/zauth/challenges.py refuses a LocMemCache there via
# ZCASH_CHALLENGE_ALLOW_LOCAL_CACHE below.  State the base choice explicitly so
# the pair reads as one decision instead of one setting and one silence.
#
# This module is the local-development and pytest module, where a
# process-local cache is deliberate: there is exactly one process, so a
# writer and a reader of the same key are the same process, and the zauth
# legacy-mirror path takes its LocMemCache branch (a read-back under a
# process lock) for the write acknowledgement RedisCache gets from the server.
#
# Do NOT "upgrade" this to django.core.cache.backends.db.DatabaseCache.  That
# backend needs a createcachetable-managed table that no migration here
# creates and no deploy step runs, so the first cache.get() against a fresh
# database would raise ProgrammingError; it would also put every DRF throttle
# read on the same connection the request is already using.  LocMemCache is
# what every cache user in this repo is tested against.
#
# LOCATION names the process-local store rather than sharing Django's unnamed
# default.  MAX_ENTRIES stays at Django's 300 (CULL_FREQUENCY 3): a dev box
# that exceeds it culls a third of its throttle history, which makes a limit
# looser, never stricter, and prod does not use this backend at all.
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "free2z-local-default",
        "TIMEOUT": 300,
    },
}

# The base settings are also the local-development and pytest settings, where
# the process-local cache declared above is intentional.  This explicit switch
# is preferable to checking DEBUG: pytest-django forces DEBUG=False while it
# runs, and DEBUG is not a cache-topology guarantee.  prod_settings overrides
# this to False so an accidental production LocMem cache fails closed instead
# of multiplying every admission limit by the number of workers.
ZCASH_CHALLENGE_ALLOW_LOCAL_CACHE = True
# Native Checkout return admission has the same cache-topology requirement:
# local development and pytest serialize LocMem access, while prod_settings
# disables this escape hatch so every replica shares one atomic Redis limit.
NATIVE_RETURN_ALLOW_LOCAL_CACHE = True
# Namespace native-return admission by the configured database environment.
# Deployments sharing a Redis database must not consume one another's owner
# or provider budgets.
# django-redis's OPTIONS["PREFIX"] is not its top-level KEY_PREFIX and therefore
# does not provide this isolation. native_return.py hashes this value before it
# reaches Redis, keeping even a misconfigured huge value out of cache keys.
NATIVE_RETURN_ADMISSION_NAMESPACE = os.environ.get("DBNAME", "free2z")
# At most one callback worker may wait on Stripe across the whole environment.
# The eight-second Redis lease exceeds the six-second hard wall-clock deadline.
# A live request releases its unique token after lookup; TTL handles crashes.
# One active slot deliberately preserves a worker even when a rollout,
# disruption, or node failure leaves only one two-worker callback replica.
NATIVE_RETURN_PROVIDER_SLOTS = 1
NATIVE_RETURN_PROVIDER_LEASE_SECONDS = 8
# Local development and tests do not traverse the production GCLB -> exact
# nginx location -> Django path, so they may explicitly use REMOTE_ADDR.  Prod
# disables this: missing or malformed GCLB XFF topology must fail closed, never
# silently collapse all callers onto nginx/pod REMOTE_ADDR.
ZCASH_AUTH_ALLOW_REMOTE_ADDR_FALLBACK = True

REST_FRAMEWORK = {
    'DEFAULT_SCHEMA_CLASS': 'drf_spectacular.openapi.AutoSchema',
    'DEFAULT_PAGINATION_CLASS': 'dj.free2z.pagination.Free2zPagination',
    'PAGE_SIZE': 12,
    # nginx normalizes the client address and sends exactly one XFF value on
    # ordinary Django API locations. Keep DRF aligned with that one proxy hop;
    # the Zcash exact locations intentionally preserve their raw GCLB suffix
    # for their endpoint-specific admission parser.
    'NUM_PROXIES': 1,
    'DEFAULT_FILTER_BACKENDS': [
        'django_filters.rest_framework.DjangoFilterBackend',
    ],
    # There are exactly TWO credentials that make a caller authenticated: a
    # session cookie and a Knox token. Both are minted by a deliberate login
    # endpoint, so a request either presents something a login handed out or it
    # is anonymous.
    #
    # Note what that does NOT say. `/api/auth/login/` is the only issuer that
    # runs `CreatorLoginSerializer.validate()` (the sole reCAPTCHA check, see
    #, ); alternate session/token issuers use the shared TOTP gate
    # covered by. This default list only describes how an already-issued
    # credential authenticates a request; it does not enforce that issuance
    # check itself.
    #
    # `BasicAuthentication` used to be in this list, which meant EVERY DRF view
    # in the project also accepted `Authorization: Basic base64(user:password)`
    # -- a second front door that reached the same views with no CAPTCHA, no
    # throttle scope of its own, and, decisively, NO TOTP. A user who had gone
    # to the trouble of enrolling MFA was still one leaked password away from a
    # fully authenticated API session, which is the entire thing MFA is for.
    # It also reached `POST /api/otp/setup/`, which handed back the account's
    # active TOTP seed and turned that leaked password into a permanent
    # second-factor compromise.
    #
    # Do NOT add it back globally. Nothing in this repo consumed it: the SPA
    # uses the session cookie, the SSR pod calls public reads anonymously, and
    # machine clients (ZUULI, third parties) use Knox tokens (`/api/token/login/`,
    # social and Zcash login); `/api/auth/login/` sets a session only. `dj/apps/test_authentication_inventory.py` fails if
    # any reachable view -- global default or per-view override -- reintroduces
    # password-in-a-header authentication.
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'rest_framework.authentication.SessionAuthentication',
        # NOT `knox.auth.TokenAuthentication`: the subclass adds the
        # use-time account-epoch check that refuses a bearer token the
        # account has outlived. Everything else is knox's.
        'dj.apps.ktauth.authentication.AccountEpochTokenAuthentication',
        # The third credential: an OAuth 2.0 access token issued by
        # dj.apps.oidc -- `Authorization: Bearer <ES256 JWT>`. It is DEFAULT-
        # DENY: a view that does not declare `required_scopes` refuses every
        # OAuth token with 401, so listing the class globally opens nothing by
        # itself; each view that accepts third-party apps opts in by naming
        # the scopes it needs (dj/apps/test_permission_inventory.py pins the
        # set). Knox's prefix is `Token`, so the two never see each other's
        # credential.
        'dj.apps.oidc.authentication.OAuth2JWTAuthentication',
    ],
    # Fail CLOSED. DRF's own default is `AllowAny`, which means any view that
    # forgets `permission_classes` is anonymously reachable — that fail-open
    # default was the systemic root cause behind the missing-auth 500s fixed
    # in .
    #
    # Every DRF view reachable from the URLconf must therefore declare
    # `permission_classes` EXPLICITLY, including the public ones
    # (`AllowAny` / `IsAuthenticatedOrReadOnly`). That is enforced by
    # dj/apps/test_permission_inventory.py, which walks the live URLconf and
    # fails if any view falls through to this default. Do not delete that test
    # it is the only thing standing between a new view and a silent
    # authentication regression in either direction.
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.IsAuthenticated',
    ],
    "EXCEPTION_HANDLER": "dj.apps.g12f.views.exception_handler.custom_exception_handler",
    # Only the *authenticated* throttle is global. Nothing IP-keyed may go in
    # this list: the SvelteKit SSR pod fetches the public reads (/api/zpage/,
    # /api/creator/, /api/comments/, /api/tagging/autocomplete,
    # /api/get-type/)
    # server-to-server with no X-Forwarded-For, so *every* anonymous page view
    # of the site arrives from one IP and would share one bucket.
    # `/api/get-type/` is the expensive exception: its Svelte caller uses a
    # bounded per-client token bucket keyed by an ingress-overwritten identity
    # after a creator 404 and before the legacy type resolver. Keeping real
    # creator profiles outside that small bucket matters because SvelteKit
    # hover-preloads them. Do not replace it with a backend anon throttle that
    # sees only the SSR pod. Direct browser/API calls are independently bounded
    # by the exact `/api/get-type/<id>` nginx location; the classic root router
    # checks the creator endpoint first, so ordinary profiles do not spend it.
    #
    # That excludes AnonRateThrottle and — note — DRF's stock UserRateThrottle,
    # which quietly falls back to the client IP for unauthenticated requests.
    # AuthenticatedUserRateThrottle is UserRateThrottle without that fallback.
    #
    # The one anonymous throttle that IS global, DefaultAnonRateThrottle
    # ('anon-default' below), is safe for exactly that reason: it never keys
    # a request whose client identity is a cluster-internal address
    # (API_INTERNAL_SOURCE_NETWORKS), which is what every SSR, prerender and
    # sidecar fetch resolves to after nginx's realip normalization. It is the
    # backstop for views with no scoped list; views that name a scoped list
    # in dj/free2z/throttling.py (POLLING_/LOGIN_PATH_/LINK_LANDING_...)
    # replace this default and keep their own budget.
    'DEFAULT_THROTTLE_CLASSES': [
        'dj.free2z.throttling.DefaultAnonRateThrottle',
        'dj.free2z.throttling.AuthenticatedUserRateThrottle',
    ],
    # Two things about the units, because "N/minute" reads like a smooth rate
    # and is not one. DRF's SimpleRateThrottle is a sliding *window*, not a
    # token bucket: "N/minute" permits N requests back to back and then refuses
    # until the oldest ages out of the 60s window. So each number below is a
    # burst allowance first and an average second — sized to clear legitimate
    # use, not to shape traffic.
    #
    # And these ceilings are EXACT AND GLOBAL in production, not per-process:
    # prod_settings points the cache at a shared Redis, so every worker on
    # every pod increments the same counter. (Dev and CI fall back to
    # LocMemCache, where counters are per-process and therefore looser — the
    # environment where the limits bite hardest is production, so tune against
    # the Redis numbers.)
    'DEFAULT_THROTTLE_RATES': {
        # Private moderation intake, including invalid targets and retries.
        'report_intake': '30/minute',
        # Per logged-in user, across all their tabs and devices. The SPA's
        # burstiest screens (editor autosave + comment polling) are an order of
        # magnitude under this; it exists to stop a runaway client or a stolen
        # token, not to shape normal traffic.
        'user': '1200/minute',
        # Session creation is a human gesture and occupies a sync worker while
        # Stripe answers. This endpoint-local, fail-closed bucket prevents one
        # authenticated buyer from consuming the API fleet during an outage.
        'stripe-checkout': '6/minute',
        # SDK purchase intents from an OAuth app: one bucket per (app, user),
        # so an app cannot spend its user's `stripe-checkout` budget.
        'sdk-purchase': '6/minute',
        # POST /api/sdk/v1/calls/{id}/report, per (app, user). A brake only:
        # stored reports are capped at 30 per account per hour in Postgres.
        'sdk-report': '30/minute',

        # ---- Per-IP scopes  --------------------------------------
        # DRF's anon cache key is throttle_<scope>_<ident> — no view
        # component — so a scope IS a shared per-IP budget, and the noisiest
        # endpoint in a scope dictates the rate every other endpoint in it
        # must tolerate. One 'anon' scope therefore meant background
        # live-status polling spent the budget that gated sign-in, signup and
        # password reset: behind a CGNAT/office egress, unrelated visitors
        # browsing the homepage could 429 registration for the whole network.
        # Splitting by traffic *shape* is what lets the recovery number be
        # tight without the polling number having to be.
        #
        # The scope names describe the *traffic*, not the view. 'anon-login'
        # holds SignUpView because /api/start/ is what both UIs POST on every
        # sign-in attempt; read its entry before assuming otherwise.
        #
        # Which class maps to which scope: dj/free2z/throttling.py. The full
        # view-to-scope inventory (including the deliberate no-throttle
        # entries) is pinned in dj/apps/test_throttling.py.

        # The GLOBAL anonymous default: every anonymous request to a view
        # that names no scoped list of its own, keyed per public client
        # (IPv6 grouped per /64). Cluster-internal sources -- the SvelteKit
        # SSR pod above all -- are never keyed, so this cannot put the
        # signed-out site in one bucket.
        #
        # 600/minute = 10 req/s per client address. Browser-direct anonymous
        # API traffic is light: page data for SSR routes is fetched by the SSR
        # pod (unkeyed), so a visitor's own browser makes a handful of API
        # calls per navigation, and the machine-paced reads have 'anon-poll'.
        # A shared office/CGNAT egress of ~20 visitors browsing at a brisk
        # 30 calls/minute each fits with 2x headroom. It is a brake on a
        # single source driving the single-worker API pods, not traffic
        # shaping; the volumetric control is the edge (nginx limit_req).
        'anon-default': '600/minute',

        # Search-query embedding admission (dj.apps.search.drf_filters).
        # NOT request throttles: when one of these is spent, ?search= is
        # answered from Postgres full text instead of a paid embedding call,
        # so nothing here ever answers 429. A repeated query is served from
        # the embedding cache and spends none of them.
        #
        # Per anonymous public client (IPv6 /64). A person runs a search on
        # submit, not per keystroke; 20 fresh queries a minute is far above
        # one searcher and still a 20x brake on a scripted source.
        'search-embed-anon': '20/minute',
        # Per logged-in account.
        'search-embed-user': '30/minute',
        # ONE shared budget for cluster-internal callers: SSR-rendered
        # profile searches (/<username>?search=) reach the API from the SSR
        # pod with no per-visitor identity, so they cannot be keyed per
        # client. Exhausting it degrades those renders to full text.
        'search-embed-internal': '60/minute',
        # Fleet-wide ceiling on query embeddings, across every caller and
        # pod (the counter lives in the shared Redis). It bounds provider
        # calls and worker time spent waiting on them whatever the identity
        # mix -- address rotation included -- and it keeps search from
        # spending the OpenAI rate limit the indexer shares.
        'search-embed-global': '120/minute',

        # Storytime generation (text and image), per logged-in account.
        # Every request is a paid provider call made while holding a sync
        # worker; the 1200/minute 'user' ceiling is far above any person
        # composing a story. Exported as STORYTIME_GENERATION_THROTTLES for
        # the Storytime views to adopt.
        'storytime-generate': '10/minute',

        # Machine-paced public reads: live-status, the public meeting list,
        # DyteMeeting GET. Unchanged at the value  measured for exactly
        # this consumer — 8 CreatorCards polling every 15s is ~32 req/min per
        # browser, so 1200 clears ~37 concurrent browsers behind one egress
        # (~150 at the typical 8 req/min). It is not raised here: isolating
        # the bucket is this change, retuning it is not, and these calls fan
        # out to a paid third-party API.
        'anon-poll': '1200/minute',

        # Anonymous broadcast joins create a participant through the paid
        # meeting provider and mint a token that can incur creator-funded
        # viewing fees. They therefore cannot share the 1200/minute polling
        # allowance on the same DyteMeeting URL. 60/minute permits one new
        # guest each second from a shared office/CGNAT egress (or 30 guests
        # each retrying once) while applying a 20x brake to naive participant
        # creation floods. Like every IP throttle here it remains bypassable
        # when an attacker rotates actual source addresses, but caller-supplied
        # XFF prefixes no longer change the client identity.
        'anon-broadcast-join': '60/minute',

        # THE SIGN-IN PATH. Today that is /api/start/ (SignUpView) alone, and
        # the name is not a mistake: both front ends implement one combined
        # "log in or create account" button that POSTs /api/start/ FIRST on
        # every authentication attempt, falling through to /api/auth/login/
        # only when signup says the user already exists (svelte
        # lib/stores/auth.ts login(); react CreatorLoginModal handleCreate()).
        # So the legitimate load here is EVERY SIGN-IN ON THE SITE plus every
        # mistyped-password retry — not the rate of registrations. An earlier
        # revision of this scope was sized as "a person registers once in a
        # lifetime" and set to 60/minute; that model was simply wrong, and the
        # number it produced would have blocked sign-in, not signup.
        #
        # It blocks sign-in rather than degrading, too: 429 is not in the
        # clients' fallback list [400, 401, 403, 409, 422], so neither UI ever
        # reaches /api/auth/login/ after one. Svelte throws a generic
        # "Authentication failed"; React snackbars the raw throttle payload.
        # A drained bucket here is therefore a sign-in outage for existing
        # accounts on that egress — 's user-facing failure from the other
        # direction. That asymmetry (an outage for a whole network vs. a
        # weakened defence-in-depth layer) is why this number is generous.
        #
        # 600/minute = 10 req/s. The arithmetic, in one place:
        #
        #   worst realistic LEGITIMATE burst behind one egress
        #     = a synchronised sign-in event (classroom / workshop /
        #       conference): ~200 people signing in over ~2 minutes at
        #       ~1.5 attempts each
        #     = ~150 sign-in ATTEMPTS in a sliding minute
        #   requests per attempt: NOT the same for every client —
        #     * classic React: 2  (/api/start/, then /api/auth/login/)
        #     * Svelte sign-up: 2  (same two, via authStore.signup())
        #     * Svelte LOG-IN:  1  (UnifiedAuthModal calls loginOnly(), which
        #                          POSTs /api/auth/login/ directly with a
        #                          fresh token; tests/browser/auth-mfa.spec.ts
        #                          asserts /api/start/ is never requested)
        #   floor = 150 x max(2) = 300 req/min;  600 keeps the 2x headroom.
        #
        # RAISED FROM 300 TO 600 BY  because /api/auth/login/ joined this
        # scope, the same shape as 'anon-link' going 120 -> 240 in.
        # Leaving it at 300 would have met the classic client's floor with
        # ZERO headroom — a number nobody chose, arrived at by adding an
        # endpoint rather than by tuning a rate.
        #
        # BE PRECISE ABOUT WHAT THIS COSTS, because an earlier draft of this
        # comment overclaimed and the codex review of  caught it: since a
        # Svelte log-in spends only ONE request, a single source gets up to
        # 600 password attempts per minute here, not 300. The two numbers
        # differ because the floor is set by the noisiest legitimate client
        # and the ceiling is reached by the cheapest attacking one.
        #
        # Why not a tighter, "anti-stuffing" number: a 429 here does not
        # degrade, it blocks. 429 is not in either client's fallback list
        # [400, 401, 403, 409, 422], so a drained bucket is a sign-in outage
        # for every account behind that egress — a whole office, campus or
        # CGNAT range. The asymmetry (outage for a network vs. a weakened
        # defence-in-depth layer) is why this number is generous, and it is
        # why the credential-stuffing control is the SINGLE-USE reCAPTCHA
        # grant from  (dj/apps/g12f/captcha.py), not this rate. Per-IP
        # limits cannot be the stuffing control in any case: a botnet rotates
        # real source addresses, which is the one thing normalization cannot
        # take away.
        #
        # What this DOES buy, stated honestly: it bounds a single-source
        # attacker to 300 password guesses per minute per IP instead of
        # unbounded, which is what turns "run it from one VPS overnight" into
        # "rent a botnet". nginx discards caller-supplied XFF prefixes and the
        # shared DRF setting selects its single normalized value, so a caller
        # cannot mint fresh buckets by changing an XFF prefix — but it can
        # still rotate its actual source address.
        #
        # It remains a 2x brake versus the 1200 that  had to loosen the
        # shared bucket to, and — the actual fix — polling no longer spends
        # any of it. Not a brake on username enumeration via /api/start/'s
        # "user already exists" error either (600/min is 864k/day; plenty for
        # an enumerator). reCAPTCHA is the control there.
        'anon-login': '600/minute',

        # ACCOUNT RECOVERY: forgot-password request + reset-token consume.
        # Split from the sign-in path in review of  for the reason this
        # whole section exists — the noisiest endpoint in a scope sets the
        # floor, and /api/start/ fires on every sign-in while these two fire
        # when somebody forgets a password. That is one to two orders of
        # magnitude apart, so sharing a bucket would have forced this rate up
        # to the sign-in rate for no reason.
        #
        # 60/minute clears ~20 people behind one egress each making 3 attempts
        # inside the same sliding minute. A network where 20 people forget
        # their password in the same minute is not a thing, so the headroom is
        # large; it stays tight because nothing legitimate here bursts. It
        # also sits behind independent, non-IP-keyed controls: the
        # 3-mails-per-address-per-24h cap in send_password_reset_email, and
        # single-use expiring tokens on the consume half.
        #
        # These two share one counter on purpose: same shape, same order of
        # magnitude. Splitting further would not bound abuse, because both are
        # unauthenticated POSTs charged before validation, so either can drain
        # whichever bucket it is in — a per-endpoint scope just moves the
        # drain, it does not stop it.
        #
        # And note what the number means for abuse: tightening the old shared
        # 1200 to 60 does make DELIBERATE denial of this bucket cheaper. It is
        # not the step that makes it *possible* — 1200/minute is 20 req/s
        # from one host, already free — but the normalized API identity now
        # rejects forged XFF prefixes. What moves is the brake on the
        # unsophisticated abuse that does not rotate its actual source address,
        # which is what  had to loosen to 1200 as an interim and what this
        # restores.
        #
        #  DID NOT PUT PASSWORD LOGIN HERE, and must not: credential
        # stuffing is machine-paced and would be the drainable endpoint in a
        # bucket that also gates account recovery. /api/auth/login/ is on
        # 'anon-login' above with LOGIN_PATH_THROTTLES — the same scope as
        # /api/start/, not a third one of its own, because both UIs hit
        # /api/start/ immediately before it on every attempt and a separate
        # 'anon-login-2' would leave the real per-IP sign-in ceiling at
        # min(the two rates), a careful number silently overridden by a bucket
        # nobody tuned. One dance, one budget, sized for 2 requests per
        # attempt.
        'anon-recovery': '60/minute',

        # One-shot landings from an email we sent: confirm and opt-out. Higher
        # than 'anon-recovery' because arrival is paced by mail delivery, not
        # by a person deciding to act — a send to a large corporate domain
        # produces a genuine synchronized burst from one egress, and a 429
        # on an unsubscribe link is a CAN-SPAM problem. 120/min = 2/s is meaningless
        # as a guessing budget against the single-use tokens these carry.
        #
        # Honest limitation: every endpoint in a scope can drain it, including
        # these two — a tokenless GET /api/emails/confirm is charged before
        # the handler rejects it. Scoping bounds *which* features a drained
        # bucket takes down, it cannot stop the bucket being drained; the
        # normalized client identity from  determines who shares it. What
        # the grouping rule
        # does buy is not adding endpoints whose traffic is driven by a third
        # party or a timer, since those raise the floor for everyone.
        # (The codex review of  caught the Twitter OAuth start endpoint
        # sitting here for exactly that reason; it now has its own scope.)
        #
        # RAISED FROM 120 TO 240 BY, and the factor is exactly 2 on
        # purpose. Both landings became GET (render the page) + POST (the
        # button), so one human completing one link now spends TWO requests
        # from this bucket instead of one. Leaving 120 would have quietly
        # halved the real per-IP ceiling to 60 completed unsubscribes/minute —
        # the same "one dance, one budget; size it for the requests per
        # attempt, not per attempt" reasoning spelled out for 'anon-recovery'
        # above. The guessing-budget argument is unchanged: 4/s against a
        # 64-byte urlsafe token is still meaningless.
        'anon-link': '240/minute',

        # ---- The OIDC provider  -----------------------------------
        # Both fail CLOSED (FailClosedAuthThrottleMixin): a code, a refresh
        # token and a client secret are credentials, and an unmetered
        # guessing lane during a Redis outage is the  trade we refused.
        #
        # 'anon-oidc-authorize' paces the consent step, which a person drives
        # from a browser and which is answered without a database write on
        # GET. 'anon-oidc-token' paces the token endpoint, where the load is
        # machines: every signed-in device refreshes a 5-minute access token,
        # so an office or CGNAT egress with 1000 devices makes ~200 refreshes
        # a minute and must not be starved. A refresh replay from a stolen
        # token is caught by the family check inside the endpoint, not by
        # this ceiling; the ceiling is against brute force on codes and
        # secrets, which are 128+ bits and not brute-forceable at any rate a
        # sliding window can distinguish. Separate scopes, per: the
        # human-paced and the machine-paced traffic must not share a bucket.
        'anon-oidc-authorize': '120/minute',
        'anon-oidc-token': '600/minute',
        # Signed Checkout return URLs are replayable for their bounded lifetime
        # and success performs one Stripe lookup with five-second network-
        # inactivity and six-second total wall-clock bounds on a single sync
        # Gunicorn worker in the isolated callback pool. This keys valid
        # state to its signed owner across cookies and IPs; one atomic Redis Lua
        # operation admits at most six starts per fixed minute across replicas.
        # Isolate it from email/auth callback budgets.
        'anon-checkout-return': '6/minute',

        # Anonymous endpoints that spend somebody else's API quota: the
        # Twitter OAuth v1 request-token + callback pair. Alone in its scope
        # because request-token is an unauthenticated POST needing no token or
        # state, so it is the one endpoint here an attacker can fire at will.
        #
        # 30/min = 15 complete OAuth dances per minute from one egress, for an
        # action a user performs approximately once in the life of an account.
        # Tighter than 'anon-link' because a 429 here is a retryable hiccup in
        # a flow the user is actively driving, whereas the thing on the other
        # side of the limit is a third-party quota we do not control.
        'anon-oauth': '30/minute',

        # OAuth authorization starts mint a 10-minute state key in Redis.
        # Keep them isolated from the legacy Twitter API-quota bucket so a
        # scripted key-allocation flood cannot 429 a provider callback.
        'anon-oauth-state': '60/minute',

        # Social OAuth COMPLETION: the ZUULI mobile relay and
        # POST /api/auth/social/{provider}/, which issues a knox token. One
        # bucket for the two legs of one sign-in, separate from the start
        # bucket above so draining either cannot strand the other.
        #
        # 600/minute, the same number and the same sizing model as
        # 'anon-login': a synchronised sign-in event behind one egress
        # (~150 attempts in a sliding minute) at up to two requests each
        # (mobile: relay + login POST; web: the POST only) = a 300 floor,
        # with 2x headroom. A 429 here strands a sign-in that is already out
        # at the provider -- recoverable only by retrying before the state
        # expires -- so this must be generous, not tight.
        #
        # It is deliberately NOT derived from the start rate. An earlier
        # draft set 2 x 'anon-oauth-state' = 120 on the theory that
        # completions cannot outrun starts; the codex review of  showed
        # that is false. A state lives STATE_TTL_SECONDS (600s), so returns
        # from up to eleven start-minutes can land in one completion minute
        # (the true per-minute bound is 2 x 60 x 11 = 1320), and completions
        # are grouped per IPv6 /64 while starts are per address. 600 is the
        # sign-in model's number, not a bound derived from the start bucket.
        #
        # What it buys: an unbounded lane of anonymous POSTs to a
        # credential-issuing endpoint becomes 10/s per source. It is not the
        # control on the credential itself -- that is the single-use,
        # 192-bit `state` the view checks before any provider call, and a
        # malformed relay callback is not charged at all (it is rejected
        # before Redis; see OAuthCompletionAnonRateThrottle).
        'anon-oauth-complete': '600/minute',

        # Credential-stuffing brake on the OTP login/enable views. One second
        # is the window, so this one really is a per-request pacer.
        'brute': '1/second',

        # Key-transparency handle assertions (dj.apps.ktauth). Per logged-in
        # account, never per IP -- the view is IsAuthenticated and
        # HandleAssertionRateThrottle refuses to fall back to an address.
        #
        # An assertion is minted when a DEVICE ENROLLS. A person adds a phone,
        # adds a laptop, replaces a phone: a handful of times in the life of an
        # account, each one a deliberate gesture in front of a UI. There is no
        # legitimate burst and no timer driving it, so this is sized for
        # retries, not for throughput -- 10/hour covers a client retrying a
        # failed enrollment several times, plus enrolling a second device in
        # the same sitting, and nothing beyond that. Each request costs an
        # Ed25519 signature over a claim about an identity key; the reason to
        # keep the number small is what the output IS, not what it costs.
        #
        # Tightest scope in this table on purpose. Unlike the anon scopes
        # above, one view owns this bucket outright, so raising it cannot
        # starve anything else -- and a 429 here delays one enrollment for one
        # account rather than blocking a flow.
        'kt-assertion': '10/hour',

        # Messaging-handle claims (dj.apps.handles). Per account, never per IP.
        # A successful claim happens once in an account's life; the rest of
        # the budget is for "taken" answers while a person tries names. Small
        # because each refusal also answers "is this handle held", and
        # handles, like usernames, are public -- the bound is on the rate of
        # asking, not on the answer being secret.
        'e2ee-handle-claim': '20/hour',

        # Backstop ONLY. No view uses scope 'anon' any more, and
        # test_no_view_uses_the_shared_anon_scope fails in CI if one does —
        # sharing this bucket is the  bug. It stays configured because
        # DRF's stock AnonRateThrottle hard-codes scope='anon', so a class
        # pulled in from DRF or a third-party package with no rate here would
        # raise ImproperlyConfigured (a 500) on every request to its view.
        # Degrading to a tight rate beats degrading to an outage.
        'anon': '60/minute',
    },
}

# Client identities that are the cluster itself rather than a visitor.
# DefaultAnonRateThrottle never keys these, and search-embedding admission
# gives them one shared budget instead of a per-client one.
#
# Why an address range is a sound signal here: nginx's realip trusts
# X-Forwarded-For only from Google's GFE ranges (and the load balancers'
# own addresses), recursively, and every ordinary /api/ location then
# OVERWRITES X-Forwarded-For with the result. A request from the internet
# therefore resolves to the public address Google saw; nothing a caller sends
# can make it resolve to one of these. A request that resolves to one of
# these came from inside the cluster -- the SvelteKit SSR pod's sidecar,
# prerender, a Job -- or from loopback in local development.
#
# RFC 1918, RFC 6598 shared space (GKE accepts it for pod ranges),
# loopback, link-local and IPv6 unique-local. Overridable as a
# comma-separated CIDR list; a malformed entry fails at startup.
API_INTERNAL_SOURCE_NETWORKS = [
    entry.strip()
    for entry in os.environ.get(
        "API_INTERNAL_SOURCE_NETWORKS",
        "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,"
        "127.0.0.0/8,169.254.0.0/16,::1/128,fc00::/7,fe80::/10",
    ).split(",")
    if entry.strip()
]

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

# --------------------------------------------------------------------------
# Key-transparency handle authority (dj.apps.ktauth).
#
# Three values, all environment-driven, none of them secret. The issuing key
# itself is NEVER a setting and never an environment variable: only the Secret
# Manager resource name is configured here, and the key material is fetched at
# boot and held in memory. See dj/apps/ktauth/signing.py.
#
# Every one of these defaults to empty/absent on purpose. An unconfigured
# deployment -- CI, a local checkout, any environment that is not running a
# directory -- must not accidentally issue assertions signed by nothing; the
# endpoint answers 503 with a bounded reason code and the rest of the platform
# is unaffected.
# --------------------------------------------------------------------------

#Secret Manager version resource name for the Ed25519 issuing key, e.g.
#``projects/<project>/secrets/<secret>/versions/latest``. Empty means this
#deployment is not a handle authority.
#
#SET IT ON THE API SERVER WORKLOAD ONLY. The app's AppConfig.ready() runs in
#every Django process -- workers, cron, migrate -- and fetches the key when
#this is set, so a deployment-wide value puts an offline-forgeable handle
#authority seed in the memory of every workload sharing the service account.
#Pair it with a secretmanager.secretAccessor binding scoped to that one
#workload's service account. No manifest sets this today.
KT_AUTHORITY_SECRET_NAME = os.environ.get("KT_AUTHORITY_SECRET_NAME", "")

# ---- Encrypted chat requests (dj.apps.e2ee, free2z/zuu#1022) ---------------
#Whole 2Z charged to the sender and credited to the recipient for one chat
#request. Served by GET /api/e2ee/chat-requests/price/; clients never send
#an amount. A change here applies to the next request; an idempotent replay
#still reports what its original request charged.
E2EE_CHAT_REQUEST_COST = 1
#Kill switch for NEW chat requests (default on). Off: the POST answers 503
#`chat_requests_disabled` before claiming a key or moving 2Z (a completed
#request still replays), and the price endpoint reports `enabled: false`.
E2EE_CHAT_REQUESTS_ENABLED = _strict_boolean_env(
    "E2EE_CHAT_REQUESTS_ENABLED", default=True,
)
#Per-sender ceilings, counted exactly from ChatRequest rows under the
#sender's row lock (dj/apps/e2ee/views.py:check_rate_limit), so they hold
#across every pod. Sized for a person reaching out to a few people, not for
#bulk outreach: every request mails and notifies someone.
E2EE_CHAT_REQUEST_SENDER_HOURLY_LIMIT = 10
E2EE_CHAT_REQUEST_SENDER_DAILY_LIMIT = 30
E2EE_CHAT_REQUEST_PAIR_DAILY_LIMIT = 3
#Origin of the Contract B link (``/bridge/e2e2z/chat/#peer=<handle>``).
#Deliberately NOT CANONICAL_ORIGIN: the e2e2z App Link is verified for
#free2z.com, and the contract names that host.
E2EE_CHAT_LINK_ORIGIN = os.environ.get(
    "E2EE_CHAT_LINK_ORIGIN", "https://free2z.com",
)

#The log this authority issues for (``KT.md`` §6.1), 64 hex characters. An
#assertion naming one log says nothing about a handle on another, so an
#unset or malformed value is a refusal to issue rather than a default.
#
#Resolved per deployment from the public table in dj/free2z/kt_logs.py,
#keyed by the NAMESPACE the ConfigMap sets (prod / stage / test). An explicit
#KT_LOG_ID_HEX environment variable overrides it. With no NAMESPACE in the
#environment (a local checkout, CI) it stays empty.
from dj.free2z.kt_logs import resolve_kt_log_id_hex  # noqa: E402

KT_LOG_ID_HEX = resolve_kt_log_id_hex(
    os.environ.get("NAMESPACE"), os.environ.get("KT_LOG_ID_HEX", "")
)

#Validity window to sign, in milliseconds. Clamped by the app to the
#verifier's own cap (15 minutes, f2z_authority::DEFAULT_MAX_VALIDITY_MS),
#which the log enforces independently of whatever is set here.
#
#Parsed defensively, and NOT with a bare int(): this line runs while Django
#imports its settings, which is before gunicorn, Daphne, the workers, cron,
#migrations and every management command exist. A ConfigMap substitution that
#comes through empty, or somebody writing "300s", would then stop the entire
#deployment from starting over a value that only one endpoint reads -- the
#exact global fail-closed this app is built to avoid. A bad value degrades to
#the default here and is clamped again in dj/apps/ktauth/signing.py.
try:
    KT_ASSERTION_TTL_MS = int(os.environ.get("KT_ASSERTION_TTL_MS") or 300000)
except (TypeError, ValueError):
    KT_ASSERTION_TTL_MS = 300000

SPECTACULAR_SETTINGS = {
    # ends up as filename
    'TITLE': 'f2z',
    # The scope sentence is deliberate: a reader must not mistake this
    # spec's coverage for "every URL the server answers", and must not be told
    # it is complete when it is not. It covers the DRF surface, which is
    # everything drf-spectacular can see. The same deployment also serves SSR
    # crawler HTML, RSS feeds, nginx auth subrequests, health probes and the
    # Stripe webhook (whose contract is Stripe's), plus a short backlog of
    # hand-written JSON views that ought to be here and are not.
    # dj/apps/test_spec_coverage.py holds the enumerated list and fails if it
    # grows.
    'DESCRIPTION': (
        'Free2z is a tool for content and peer-2-peer giving that does not '
        'compromise on privacy. This is the Django REST Framework API '
        'contract and the source of the generated clients. It does not cover '
        'the non-API surfaces of the same deployment (server-rendered pages, '
        'RSS feeds, storage auth subrequests, health probes, the Stripe '
        'webhook), nor a short, enumerated backlog of hand-written JSON '
        'endpoints not yet ported to DRF.'
    ),
    'VERSION': '0.1.0',
    # Pinned to what drf-spectacular auto-detected until: the common
    # prefix of every routed DRF path. Operation ids and tags are derived
    # from the path AFTER this prefix, so leaving it to auto-detection means
    # the first DRF view mounted outside /api/ (a /.well-known route, say)
    # silently renames every operation and tag in f2z.yaml and, with them,
    # every function in the generated client.
    'SCHEMA_PATH_PREFIX': r'/api/',
    # 'SERVE_INCLUDE_SCHEMA': False,
    # OTHER SETTINGS
    # Must mirror REST_FRAMEWORK['DEFAULT_AUTHENTICATION_CLASSES']: this list
    # is what drf-spectacular publishes as `securitySchemes` in f2z.yaml, so
    # leaving `BasicAuthentication` here would keep advertising `basicAuth` to
    # every generated client after the server stopped honouring it.
    'AUTHENTICATION_WHITELIST': [
        "rest_framework.authentication.SessionAuthentication",
        "dj.apps.ktauth.authentication.AccountEpochTokenAuthentication",
        # Published as the `oauth2Jwt` scheme, and attached ONLY to operations
        # that declare `required_scopes` (dj.apps.oidc.authentication.
        # OAuth2JWTScheme) -- advertising it on an operation that refuses
        # OAuth tokens would be the basicAuth lie of  again.
        "dj.apps.oidc.authentication.OAuth2JWTAuthentication",
    ],
    # These are PUBLIC enum components whose names predate this setting.
    # Introducing a second field with the same choices makes drf-spectacular
    # namespace both enums by component, silently renaming the existing one and
    # breaking every external client that regenerates against the spec.
    # Pinning the old names keeps the published names stable; new enums
    # namespace themselves as they should.
    'ENUM_NAME_OVERRIDES': {
        'StatusEnum': ('queued', 'delivered', 'refunded'),
        # dj.apps.g12f.account_deletion.BLOCKERS: a named enum rather than
        # the generic `BlockersEnum` drf-spectacular would otherwise derive.
        'AccountDeletionBlockerEnum': (
            'earnings_owed', 'app_has_users', 'staff_account'),
        'MeetingTypeEnum': (
            ('private', 'Private'),
            ('broadcast', 'Broadcast'),
            ('ppv', 'Pay Per View'),
            ('subscribers-only', 'Subscribers Only'),
        ),
        # dj.apps.e2ee's recipient handle state. Pinned so a later
        # `handle_status` field elsewhere cannot rename it under clients.
        'MessagingHandleStatusEnum': ('bound', 'unclaimed'),
        # The public stream types. The broadcaster-seat serializers
        # added more fields with these choices; without the pin
        # drf-spectacular renames the existing enum to a hash-suffixed name
        # under the generated client.
        'PublicMeetingListMeetingTypeEnum': (
            'broadcast', 'ppv', 'subscribers-only'),
        # The live-stream entitlement error's `action` field predates the
        # OIDC consent step's `action` field; without these two pins
        # drf-spectacular namespaces BOTH by their serializer, renaming the
        # existing `ActionEnum` under the generated client.
        'ActionEnum': ('stream_join',),
        # Every 402's `code`. The second-page refusal  reuses the
        # InsufficientFundsError contract; without the pin the shared choice
        # set is renamed to a hash-suffixed enum under the generated client.
        'InsufficientFundsErrorCodeEnum': ('insufficient_funds',),
        'OidcAuthorizeActionEnum': ('login', 'consent', 'approve', 'redirect'),
        # The comments client imports this generated name. Keep it stable if
        # another field later reuses the same access choices.
        'ThreadAccessEnum': (
            ('public', 'Public thread'),
            ('members', 'Members thread'),
            ('private', 'Private thread'),
        ),
        # `/api/emails/recovery-status`. Without these pins
        # drf-spectacular names the two enums after their FIELDS -- `RiskEnum`
        # and `NextStepEnum` -- which are generic enough that the next
        # serializer anywhere in the project with a `risk` or a `next_step`
        # choice field collides with them and renames one under the generated
        # TypeScript client. The recovery prompt imports these names.
        'AccountRecoveryRiskEnum': (
            'none', 'no_recovery', 'no_credentials',
        ),
        # An override only binds when its value tuple matches the field's
        # choices EXACTLY. Adding `resend_email` to the serializer without
        # adding it here silently unbound this entry: spectacular fell back to
        # naming the component after the field (`NextStepEnum`), the generated
        # client exported that instead, and every consistency check stayed
        # green because the spec and the client agreed with each other -- just
        # not with the name this entry promises. Caught by the second codex
        # adversarial round. `make openapi` after any change to the choices,
        # and check the emitted component name.
        'AccountRecoveryNextStepEnum': (
            'add_email', 'confirm_email', 'resend_email', 'replace_email',
        ),
        # The purchase intents API  has a `platform` field too. Without
        # this pin spectacular namespaces BOTH `platform` enums by serializer
        # and renames the ZUULI client-decision `PlatformEnum` under the
        # generated client. Pin the existing one, name the new ones.
        'PlatformEnum': ('ios', 'android', 'macos', 'linux'),
        'PurchasePlatformEnum': ('desktop', 'ios', 'android', 'web'),
        'PurchaseRailEnum': ('card', 'zcash', 'apple_iap', 'google_iap'),
        'PurchaseIntentStatusEnum': (
            'created', 'pending', 'paid', 'credited', 'expired', 'failed',
            'refunded', 'partially_refunded', 'disputed', 'clawed_back',
        ),
    },

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
    # 'zooko', 'skyl'... hrm... should squat some or...
]


# dj-rest-auth 3.x+ resolves serializer and behavior settings for its mounted
# endpoints from this dictionary. The pre-3.x REST_AUTH_SERIALIZERS name is
# silently ignored, so keep each custom serializer used by those endpoints here
# instead of allowing a security-sensitive endpoint to fall back to dj-rest-auth's
# default implementation.
REST_AUTH = {
    # /api/auth/login/
    'LOGIN_SERIALIZER': 'dj.apps.g12f.serializers.creator.CreatorLoginSerializer',
    # 'TOKEN_SERIALIZER': 'path.to.custom.TokenSerializer',
    # JWT_SERIALIZER - response serializer when REST_AUTH['USE_JWT'] is True;
    # default value dj_rest_auth.serializers.JWTSerializer
    # JWT_TOKEN_CLAIMS_SERIALIZER - A custom JWT Claim serializer. Default is rest_framework_simplejwt.serializers.TokenObtainPairSerializer
    # 'USER_DETAILS_SERIALIZER': 'dj.apps.g12f.serializers.creator.CreatorProfileDetailsSerializer',
    # PASSWORD_RESET_SERIALIZER - serializer class in dj_rest_auth.views.PasswordResetView, default value dj_rest_auth.serializers.PasswordResetSerializer
    # PASSWORD_RESET_CONFIRM_SERIALIZER - serializer class in dj_rest_auth.views.PasswordResetConfirmView, default value dj_rest_auth.serializers.PasswordResetConfirmSerializer
    'PASSWORD_CHANGE_SERIALIZER': (
        'dj.apps.g12f.serializers.creator.CreatorPasswordChangeSerializer'
    ),
    'LOGOUT_ON_PASSWORD_CHANGE': False,
    #/api/auth/login/ establishes the Django SESSION and nothing else.
    # dj-rest-auth's default TOKEN_MODEL is `rest_framework.authtoken`'s Token,
    # which LoginView minted with get_or_create on every login: a permanent,
    # never-rotating key per account that nothing authenticates with. None
    # stops that; the view then answers 204 with the session cookie, which is
    # all the SPA ever used. Bearer clients get Knox tokens from
    # /api/token/login/. None is also REQUIRED: the app is no
    # longer installed, and dj_rest_auth raises ImproperlyConfigured at import
    # if TOKEN_MODEL still names its Token.
    'TOKEN_MODEL': None,
    # Explicit because it is now the ONLY thing login does: with TOKEN_MODEL
    # None and USE_JWT off, SESSION_LOGIN False would make dj-rest-auth raise
    # ImproperlyConfigured at import.
    'SESSION_LOGIN': True,
}
# TODO: JWT settings belong inside REST_AUTH when JWT support is enabled.

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

DB_CONNECT_TIMEOUT_SECONDS = 5

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
            # Bound a failed Cloud SQL/Auth Proxy connection attempt. Without
            # this, /api/readyz and ordinary requests can sit in psycopg for
            # the driver's unbounded default while consuming the sync worker's slot.
            'OPTIONS': {'connect_timeout': DB_CONNECT_TIMEOUT_SECONDS},
        },
    }

# Deterministic OpenAPI generation (see bin/gen-openapi.sh).
#
# The canonical spec (f2z.yaml) must describe the PRODUCTION API, which runs on
# PostgreSQL. DRF's ModelSerializer derives integer field bounds from
# connection.ops.integer_field_range(), which is DB-backend dependent: PostgreSQL
# bounds IntegerField to int32 (-2147483648..2147483647) while SQLite reports
# (None, None), so drf-spectacular falls back to int64. Generating the spec
# against the default sqlite backend therefore yields a spuriously different spec
# (int64) from what CI produces against Postgres (int32), forcing hand-edits.
#
# Force the Postgres backend whenever the spec is being generated so the output is
# byte-for-byte identical everywhere (local == CI), regardless of DBHOST or which
# database is installed. No server is required: spectacular only introspects the
# URLconf and serializers; it never opens a connection.
if os.environ.get("OPENAPI_GEN"):
    DATABASES['default']['ENGINE'] = 'django.db.backends.postgresql'

# Persistent database connections.
#
# Django's default CONN_MAX_AGE is 0, which means a brand-new connection is
# opened and torn down for *every single request*. In production that is a full
# TCP + TLS + Postgres auth handshake through the Cloud SQL proxy before any
# request does real work — pure, constant latency on every endpoint. The proxy
# sidecar logs confirm it: a continuous stream of `New connection for
# "free2z:us-east1:free2z"` / `Client closed local connection`, several per
# second.
#
# CONN_HEALTH_CHECKS is mandatory whenever CONN_MAX_AGE > 0: without it, a
# pooled connection that the proxy or the server has already dropped raises
# InterfaceError/OperationalError the next time it is reused. With it, Django
# pings the connection at the start of each request and transparently reconnects.
#
# Persistent connections multiply: every process that serves requests keeps its
# own connection open, so `CONN_MAX_AGE` is a per-process cost. It is therefore
# overridable per-container via the CONN_MAX_AGE env var, so processes with
# unbounded thread fan-out (daphne/Channels gives each concurrent consumer its
# own `database_sync_to_async` thread, hence its own connection) can opt out by
# setting CONN_MAX_AGE=0.
CONN_MAX_AGE = int(os.environ.get("CONN_MAX_AGE", "60"))
CONN_HEALTH_CHECKS = True

# Only PostgreSQL: the local/dev sqlite path keeps Django's default behaviour
# (a file-backed sqlite connection held open across requests invites spurious
# "database is locked" errors and buys nothing — there is no handshake to skip).
#
# PgBouncer transaction pooling (docs/tuzis/ledger-v2.md §12). Nothing
# here deploys a pooler; these make Django correct behind one, and are safe
# (and in force) on a direct connection today. prod_settings.py replaces
# DATABASES wholesale and re-applies both by name.
#
# DB_DISABLE_SERVER_SIDE_CURSORS: QuerySet.iterator() otherwise DECLAREs a
#   server-side cursor -- WITH HOLD in autocommit -- and fetches from it in
#   later statements, which a transaction-mode pooler may route to a different
#   backend ("cursor... does not exist"). The price is that.iterator() now
#   receives its whole result set on the first fetch; a loop over rows that
#   carry article bodies pages instead: dj.util.keyset.keyset_iterator
#   (score_pages), or ids-then-pk (the publication exporter). test_pgbouncer_settings.py pins
#   both the setting and that no cursor is declared.
# DB_PREPARE_THRESHOLD: psycopg 3 server-side prepares a statement after five
#   executions by default, and a prepared statement lives on ONE backend.
#   Django 5.2 already passes None for psycopg 3 unless OPTIONS says otherwise;
#   stating it pins that against a Django default change, and procrastinate's
#   worker pool inherits it through connector_params() (procrastinate_pool).
DB_DISABLE_SERVER_SIDE_CURSORS = True
DB_PREPARE_THRESHOLD = None
for _db_config in DATABASES.values():
    if 'postgresql' in _db_config['ENGINE']:
        _db_config['CONN_MAX_AGE'] = CONN_MAX_AGE
        _db_config['CONN_HEALTH_CHECKS'] = CONN_HEALTH_CHECKS
        _db_config['DISABLE_SERVER_SIDE_CURSORS'] = (
            DB_DISABLE_SERVER_SIDE_CURSORS
        )
        _db_config.setdefault('OPTIONS', {})['prepare_threshold'] = (
            DB_PREPARE_THRESHOLD
        )

# django-dbbackup 5.x removed the standalone DBBACKUP_STORAGE /
# DBBACKUP_STORAGE_OPTIONS settings — they now RAISE a RuntimeError if present.
# The backup storage backend is configured via the STORAGES["dbbackup"] alias
# instead (see the STORAGES dict below). The equivalent config lives there,
# preserving the prior behavior: FileSystemStorage rooted at "./".


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

# MATCHES prod_settings.py deliberately ( Phase 4). This used to be
# '/static/', which is the ONE prefix Django must never claim here: in the
# deployed edge config `location ^~ /static/` roots at `/base/build/`, the
# classic CRA build. So any absolute URL Django built from STATIC_URL under
# these settings — e.g. dj.apps.g12f.branding.default_logo_url() rendered into
# a social card or a RealtimeKit participant picture — pointed into a tree that
# has never contained Django's collected static files, and that Phase 4 deletes
# outright. `manage.py runserver` serves STATIC_URL wherever it is pointed, so
# nothing local depends on the old value; keeping the two settings modules
# identical here removes a dev/prod divergence rather than adding one.
STATIC_URL = '/djstatic/'

# Default primary key field type
# https://docs.djangoproject.com/en/3.2/ref/settings/#default-auto-field

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

RECAPTCHA_SECRET_KEY = os.environ.get("RECAPTCHA_SECRET_KEY", "")

# Google's siteverify, called synchronously on /api/start/ and
# /api/auth/login/. Each pod runs ONE sync gunicorn worker, so
# this call used to be able to hold the pod's only worker for as long as Google
# (or a black hole in front of it) chose: `requests` has no default timeout.
# siteverify normally answers in well under a second. (connect, read) of
# (3.05, 5) bounds one leg at ~8s, and the sign-up dance's two legs at ~16s --
# inside the browser's 30s bound on an auth write, so the user
# gets our clean 503 rather than a client-side abort. See
# dj.apps.g12f.captcha.siteverify for the fail-closed handling.
RECAPTCHA_SITEVERIFY_URL = "https://www.google.com/recaptcha/api/siteverify"
RECAPTCHA_SITEVERIFY_TIMEOUT = (
    _positive_float_env("RECAPTCHA_SITEVERIFY_CONNECT_TIMEOUT_SECONDS", 3.05),
    _positive_float_env("RECAPTCHA_SITEVERIFY_READ_TIMEOUT_SECONDS", 5.0),
)

# How long after a grant-writing pod first serves traffic before 's
# single-use reCAPTCHA enforcement starts refusing duplicates. Named here
# rather than left as a bare module constant so it can be raised without a
# code change if `terminationGracePeriodSeconds` in
# k8s/free2z/deployment.yaml grows, or if a LATE manual rollback of  is
# ever planned (see the constant's docstring for that residual case).
#
# Unset means dj.apps.g12f.captcha.CAPTCHA_GRANT_MIXED_FLEET_SECONDS (1800),
# which is derived from that manifest's 600-second drain window. Do not lower
# it below the time a 5-replica rolling deploy can keep an old pod alive:
# during that window an old pod redeems a CAPTCHA without writing a grant, and
# a new pod serving the next leg would refuse a correct password.
CAPTCHA_GRANT_MIXED_FLEET_SECONDS = int(
    os.environ.get("CAPTCHA_GRANT_MIXED_FLEET_SECONDS", 1800)
)

# Deployments can share a Redis database, and
# django-redis's OPTIONS["PREFIX"] is NOT its top-level KEY_PREFIX, so it
# provides no isolation whatsoever (see NATIVE_RETURN_ADMISSION_NAMESPACE
# above, which exists for exactly this reason). Every captcha-grant key must
# therefore carry the operator-selected database environment itself.
#
# The arming stamp is the one that hurts. It has NO expiry by design, so a
# single stage or test CAPTCHA would otherwise write
# `captcha-grant:writer-since` days before  reaches production -- and
# production would then start refusing duplicates from the first second of its
# own rolling deploy, which is the precise failure the window exists to
# prevent. Correct credentials, "Invalid captcha", every probe green. (Found
# by the codex adversarial review of.) The grant and probe keys are
# namespaced for the same reason one layer down: one environment must not be
# able to spend or satisfy another's grants.
CAPTCHA_GRANT_NAMESPACE = os.environ.get("DBNAME", "free2z")

#  -- every newly created account (except Zcash wallet sign-in, which has
# no CAPTCHA; see dj.apps.tuzis.welcome) starts with this many 2Z, a welcome
# grant from `sys:promo` with a TuziGrant receipt, issued once per account in
# the sign-up transaction (dj.apps.tuzis.welcome). 2Z are platform credits,
# not money; the owner accepted the bot-signup exposure (10 2Z = $0.10 per
# account, behind the sign-up reCAPTCHA). 0 disables the grant. Whole 2Z only.
# A value above WELCOME_GRANT_MAX_2Z is treated as a typo (an extra zero mints
# that on EVERY sign-up) and falls back to the default, loudly, rather than
# failing the boot -- the same fail-safe shape as `_int_env`. Raising it past
# the ceiling is a code change, on purpose.
WELCOME_GRANT_DEFAULT_2Z = 10
WELCOME_GRANT_MAX_2Z = 1000
WELCOME_GRANT_2Z = _int_env("WELCOME_GRANT_2Z", WELCOME_GRANT_DEFAULT_2Z, minimum=0)
if WELCOME_GRANT_2Z > WELCOME_GRANT_MAX_2Z:
    print(
        f"[settings] WELCOME_GRANT_2Z={WELCOME_GRANT_2Z} is above "
        f"{WELCOME_GRANT_MAX_2Z}; falling back to {WELCOME_GRANT_DEFAULT_2Z}",
        file=sys.stderr,
    )
    WELCOME_GRANT_2Z = WELCOME_GRANT_DEFAULT_2Z

#  -- username of the deployment smoke-test account permitted to log
# in without passing reCAPTCHA. Read from the free2z ConfigMap. Empty by
# default; the value shipped in k8s/free2z/config.yaml is inert outside the
# stage namespace because CreatorLoginSerializer additionally requires
# NAMESPACE == 'stage'. Fail closed on every other environment.
SMOKE_TEST_ACCOUNT_USERNAME = os.environ.get("SMOKE_TEST_ACCOUNT_USERNAME", "")

DYTE_KEY = os.environ.get("DYTE_KEY", "")
DYTE_ORG = os.environ.get("DYTE_ORG", "")
# Cloudflare RealtimeKit REST API (Dyte migration). Same endpoints, schemas,
# and basic auth (org id + API key) as api.dyte.io — only the base URL changed.
# Override with RTK_API_BASE_URL=https://api.dyte.io to roll back during the
# transition window.
RTK_API_BASE_URL = os.environ.get(
    "RTK_API_BASE_URL", "https://api.realtime.cloudflare.com")

# Webhook public-key fetch (dyte.views.get_or_load_dyte_public_key).
#
# The key is fetched lazily from the provider's /.well-known/webhooks.json on
# the first webhook delivery and then cached in-process. Two guards, because
# the endpoint that triggers this fetch is UNAUTHENTICATED by nature (it is
# the signature check itself, so it cannot be behind the signature check):
#
# DYTE_KEY_FETCH_TIMEOUT_SECONDS -- an unresponsive provider must not pin a
#   sync gunicorn worker forever. `requests` has NO default timeout.
# DYTE_KEY_FETCH_RETRY_SECONDS -- how long a FAILED fetch is remembered. While
#   the key is unavailable every delivery would otherwise re-trigger an
#   outbound GET, so anyone POSTing the webhook path in a loop could drive
#   unbounded outbound requests from the cluster. Negative-caching the failure
#   caps that at one outbound request per interval.
#
# DYTE_KEY_CACHE_SECONDS -- how long a SUCCESSFUL fetch is trusted. The cache
#   used to be unbounded, so a worker that loaded the key once kept it for its
#   whole lifetime; if the provider rotated its signing key, that worker would
#   reject every genuine delivery until it happened to restart. A TTL bounds
#   that blindness to one interval.
#
# All three have safe defaults; none needs to be set to deploy. They are read
# through _positive_float_env so a typo'd or nonsensical value (garbage, 0,
# negative, inf, NaN) degrades to the default with a loud warning instead of
# either bricking every pod at import time or -- worse, in the NaN case --
# silently disabling the guard it configures.
DYTE_KEY_FETCH_TIMEOUT_SECONDS = _positive_float_env(
    "DYTE_KEY_FETCH_TIMEOUT_SECONDS", 5.0)
DYTE_KEY_FETCH_RETRY_SECONDS = _positive_float_env(
    "DYTE_KEY_FETCH_RETRY_SECONDS", 30.0)
DYTE_KEY_CACHE_SECONDS = _positive_float_env(
    "DYTE_KEY_CACHE_SECONDS", 3600.0)
# Stay below RealtimeKit's three-second webhook response deadline. An
# ambiguous timeout is safe because the recording consumer deduplicates the
# propagated provider UUID.
DYTE_PUBSUB_PUBLISH_TIMEOUT_SECONDS = min(
    _positive_float_env("DYTE_PUBSUB_PUBLISH_TIMEOUT_SECONDS", 2.0), 2.0)

# Recording download-URL allowlist (dyte.recording / dyte_download_upload).
#
# The recording pipeline fetches `downloadUrl` from the (signed) webhook and
# saves the bytes as a creator-owned file. A valid signature proves the message
# is from the provider, NOT that a provider-relayed URL is safe for an
# in-cluster GET -- so the sink allowlists the host, closing the SSRF. This is
# the list of permitted host suffixes.
#
# Default = where RealtimeKit/Dyte actually stores recordings. Recordings use
# AWS storage (see DyteClient.create_meeting's storage_config and the
# `*.amazonaws.com` entry already in the app CSP), so S3 presigned URLs are the
# live case; the rest cover the provider's own domains and Cloudflare R2 for
# the post-migration path. Overridable via the DYTE_RECORDING_ALLOWED_HOSTS env
# var (comma separated) so ops can adjust WITHOUT a code deploy -- getting this
# wrong stops recordings, and recordings must keep working, so it is a config
# knob, not a hardcode. Empty items are ignored; an all-empty override falls
# back to the default rather than allowing everything (that would re-open the
# SSRF).
_DYTE_RECORDING_ALLOWED_HOSTS_DEFAULT = [
    "amazonaws.com",            # S3 presigned URLs -- the current live storage
    "cloudflarestorage.com",    # Cloudflare R2 (post-migration path)
    "realtime.cloudflare.com",  # provider API/storage origin
    "dyte.io",
    "dyte.in",
]
DYTE_RECORDING_ALLOWED_HOSTS = [
    h.strip().lower().lstrip(".")
    for h in os.environ.get("DYTE_RECORDING_ALLOWED_HOSTS", "").split(",")
    if h.strip().strip(".")
] or list(_DYTE_RECORDING_ALLOWED_HOSTS_DEFAULT)

# Recording download fetch guardrails (dyte_download_upload). Bounded read time
# and size so a hostile or degenerate download cannot pin the subscriber or
# exhaust its memory. Overridable; safe defaults.
DYTE_RECORDING_DOWNLOAD_TIMEOUT_SECONDS = _positive_float_env(
    "DYTE_RECORDING_DOWNLOAD_TIMEOUT_SECONDS", 30.0)
# Requests' timeout is a per-socket-inactivity limit, not an end-to-end limit.
# This wall-clock cap prevents a server that drips bytes from occupying a
# subscriber callback indefinitely.
DYTE_RECORDING_TOTAL_TIMEOUT_SECONDS = _positive_float_env(
    "DYTE_RECORDING_TOTAL_TIMEOUT_SECONDS", 15 * 60.0)
# A crashed worker leaves an incomplete receipt. Redelivery can take it over
# after this lease; keep it comfortably above the total download cap and the
# expected object-storage upload time.
DYTE_RECORDING_LEASE_SECONDS = max(
    _positive_float_env("DYTE_RECORDING_LEASE_SECONDS", 30 * 60.0),
    DYTE_RECORDING_TOTAL_TIMEOUT_SECONDS + 15 * 60.0,
)
# Temporary legacy/current source aliases exist only to bridge messages queued
# across this deployment. Never let a path-based heuristic suppress unrelated
# future recording UUIDs forever; even an override is capped at seven days.
DYTE_RECORDING_TRANSITION_ALIAS_SECONDS = min(
    _positive_float_env(
        "DYTE_RECORDING_TRANSITION_ALIAS_SECONDS", 24 * 60 * 60.0),
    7 * 24 * 60 * 60.0,
)
DYTE_RECORDING_MAX_BYTES = max(1, int(_positive_float_env(
    "DYTE_RECORDING_MAX_BYTES", 2 * 1024 * 1024 * 1024)))  # 2 GiB (bounds disk)
# In-memory threshold before the download spills to a disk temp file. Keeps
# peak RAM bounded well under the subscriber pod's 512Mi/2Gi limit regardless
# of recording size (the download uses SpooledTemporaryFile).
DYTE_RECORDING_SPOOL_MAX_BYTES = max(1, int(_positive_float_env(
    "DYTE_RECORDING_SPOOL_MAX_BYTES", 64 * 1024 * 1024)))  # 64 MiB
# A 403/404 can mean the provider has not finished copying the object. Once
# the subscriber's short in-process retry is exhausted, recovery is handed to
# the durable Postgres-backed Procrastinate queue. These are deliberately
# bounded: the URL is a short-lived capability and an endlessly retried row
# would hide a provider contract failure rather than make it recoverable.
DYTE_RECORDING_RECOVERY_CRON = os.environ.get(
    "DYTE_RECORDING_RECOVERY_CRON", "*/5 * * * *")
DYTE_RECORDING_RECOVERY_MAX_ATTEMPTS = max(1, int(_positive_float_env(
    "DYTE_RECORDING_RECOVERY_MAX_ATTEMPTS", 12)))
DYTE_RECORDING_RECOVERY_MAX_AGE_SECONDS = max(60, int(_positive_float_env(
    "DYTE_RECORDING_RECOVERY_MAX_AGE_SECONDS", 6 * 60 * 60)))
DYTE_RECORDING_RECOVERY_BATCH_SIZE = max(1, int(_positive_float_env(
    "DYTE_RECORDING_RECOVERY_BATCH_SIZE", 100)))

# Cron for dyte.reconcile_create_unknowns. The schema release registers that
# task as an inert, UNSCHEDULED no-op (see dj/apps/dyte/tasks.py for why a
# schedule must not ship in the same release as the name); the lifecycle
# release attaches @app.periodic on this cron with the bounded implementation.
DYTE_CREATE_RECONCILIATION_CRON = os.environ.get(
    "DYTE_CREATE_RECONCILIATION_CRON", "*/5 * * * *")
DYTE_RECORDING_STUCK_AFTER_SECONDS = max(60, int(_positive_float_env(
    "DYTE_RECORDING_STUCK_AFTER_SECONDS", 60 * 60)))

# Live-meeting self-heal (dyte.sweep_live_meetings periodic task).
#
# Since the Dyte -> Cloudflare RealtimeKit migration the meeting.ended
# webhook is delayed/lost, so CreatorMeeting.live_now was never cleared and
# stale rooms stuck on the public "live now" list forever. Instead of probing
# the provider on every public read (an N+1 that slows reads), a procrastinate
# periodic worker probes the provider's active-session endpoint and keeps
# live_now truthful in the DB, so the public read stays a single indexed query.
#
# DYTE_LIVE_SWEEP_CRON: procrastinate cron for the sweep. The optional 6th
#   column is seconds, so "* * * * * */30" would run every 30 seconds. Once a
#   minute is plenty: the sweep is the only thing that clears a room, and the
#   grace window (60s) already means a clear can't happen faster than that
#   anyway — twice-a-minute probing of every live room bought nothing and
#   doubled the outbound HTTPS calls to the provider.
DYTE_LIVE_SWEEP_CRON = os.environ.get(
    "DYTE_LIVE_SWEEP_CRON", "* * * * *")
# DYTE_LIVE_LAST_SEEN_TTL_SECONDS: the public list only shows live rooms whose
#   presence was confirmed within this window. Must comfortably exceed the
#   sweep interval so a healthy live room is never dropped between sweeps; it
#   only hides rooms if the worker stalls. Go-live stamps last_seen_at=now so
#   a just-started room is always inside the window before the first sweep.
DYTE_LIVE_LAST_SEEN_TTL_SECONDS = int(
    os.environ.get("DYTE_LIVE_LAST_SEEN_TTL_SECONDS", "300"))
# DYTE_LIVE_SWEEP_GRACE_SECONDS: the sweep will not clear a room whose
#   last_seen_at is newer than this, so a room that just went live (creator's
#   client still connecting, provider still reporting 0) is not flipped off
#   before it can report presence. This only delays a real clear by at most
#   this grace, never prevents it.
DYTE_LIVE_SWEEP_GRACE_SECONDS = int(
    os.environ.get("DYTE_LIVE_SWEEP_GRACE_SECONDS", "60"))
# DYTE_LIVE_STALE_CLEAR_SECONDS: safety valve. If the provider probe *fails*
#   (network, 5xx, auth) we can't confirm a zero — but a room whose presence
#   was last confirmed longer ago than this is cleared anyway. Without it, a
#   provider outage pins live_now=True forever. Well above the TTL above so it
#   only ever fires on genuinely dead rooms; rooms already drop off the public
#   list at the TTL, this is what actually fixes the DB.
DYTE_LIVE_STALE_CLEAR_SECONDS = int(
    os.environ.get("DYTE_LIVE_STALE_CLEAR_SECONDS", "900"))
# DYTE_LIVE_SWEEP_BUDGET_SECONDS: wall clock for one dyte.sweep_live_meetings
#   tick. The sweep is periodic on DYTE_LIVE_SWEEP_CRON (every minute), so a
#   run that outlives its own cron overlaps its successor and, worse, is the
#   thing that pins the catch-all `default` worker: every other default /
#   images / billing-fallback job queues behind it. 45s keeps a tick strictly
#   inside its minute. Rooms not reached are SKIPPED, not failed: the next
#   tick probes them, and the ordering below makes that fair.
#
#   THIS NUMBER IS A CAPACITY DECISION, and it is coupled to the two above.
#   A sweep can start about BUDGET / probe_latency probes per tick, so a
#   room's presence is refreshed roughly every
#       rooms x probe_latency / BUDGET   minutes,
#   and that must stay under DYTE_LIVE_LAST_SEEN_TTL_SECONDS (300s) or a
#   room with people in it drops off the public list between refreshes.
#   At 45s and a 12s provider, that is comfortable to ~18 live rooms and
#   marginal beyond it -- raise the budget (a longer cron with it), or the
#   TTL, when the fleet outgrows that. The sweep says when: `skipped` is on
#   the summary line and a tick that skips anything logs at WARNING.
DYTE_LIVE_SWEEP_BUDGET_SECONDS = _positive_float_env(
    "DYTE_LIVE_SWEEP_BUDGET_SECONDS", 45.0)

# Outbound HTTP bounds for the RealtimeKit (ex-Dyte) REST client
# (dj.apps.dyte.client.DyteClient).
#
# `requests` has NO default timeout, so a black-holed socket -- an accepted
# TCP connection that never answers -- pins the calling thread FOREVER. In a
# gunicorn worker that is one lost request; in the procrastinate `default`
# worker it is the whole lane, and the reclaimer cannot rescue it either
# (dyte.sweep_live_meetings is classified NEVER precisely because there was
# no number to derive a threshold from).
#
# Split connect/read because they fail differently: a connect that has not
# completed in 5s is a routing/DNS problem and retrying is cheap, while a
# provider that accepted the connection may legitimately take a few seconds
# to answer. Note `requests` applies the READ timeout per socket read, not to
# the whole response, so the true per-call bound is only ~20s for the small
# JSON bodies this client exchanges -- which is the case here (a participant
# count, a meeting id, a join token), and is why the sweep ALSO has its own
# wall clock above rather than trusting arithmetic over these two numbers.
DYTE_CONNECT_TIMEOUT_SECONDS = _positive_float_env(
    "DYTE_CONNECT_TIMEOUT_SECONDS", 5.0)
DYTE_READ_TIMEOUT_SECONDS = _positive_float_env(
    "DYTE_READ_TIMEOUT_SECONDS", 15.0)

# GCS storages
# https://github.com/jschneier/django-storages
# https://github.com/jschneier/django-storages/blob/master/storages/backends/gcloud.py
# https://django-storages.readthedocs.io/en/latest/backends/gcloud.html
# STORAGES replaces the removed DEFAULT_FILE_STORAGE/STATICFILES_STORAGE
# settings (removed in Django 5.1).
STORAGES = {
    "default": {
        # GoogleCloudStorage whose uploads are create-only
        # (if_generation_match=0), so two writers racing for one free name
        # cannot replace each other's bytes.
        "BACKEND": "dj.apps.uploads.storage.CreateOnlyGoogleCloudStorage",
    },
    "staticfiles": {
        "BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage",
    },
    # django-dbbackup 5.x reads its backup storage backend from this alias
    # (the old DBBACKUP_STORAGE / DBBACKUP_STORAGE_OPTIONS settings were removed
    # and now raise). location "./" preserves the pre-5.x behavior so the
    # cloudbuild-dbcopy pipeline's `dbbackup -o db.psql.bin` writes db.psql.bin
    # into the working dir (py/dj/free2z), where the subsequent pg_restore reads it.
    "dbbackup": {
        "BACKEND": "django.core.files.storage.FileSystemStorage",
        "OPTIONS": {"location": "./"},
    },
    "exports": {
        "BACKEND": os.environ.get(
            "EXPORT_STORAGE_BACKEND",
            "django.core.files.storage.FileSystemStorage"
            if os.environ.get("EXPORT_STORAGE_LOCATION")
            else "storages.backends.gcloud.GoogleCloudStorage",
        ),
        "OPTIONS": {
            "bucket_name": os.environ.get("GS_BUCKET_NAME", ""),
            "file_overwrite": False,
            "querystring_auth": False,
            "location": os.environ.get("EXPORT_STORAGE_LOCATION", "publication_exports"),
        }
        if not os.environ.get("EXPORT_STORAGE_LOCATION")
        else {
            "location": os.environ.get("EXPORT_STORAGE_LOCATION", str(BASE_DIR / "export_archives")),
        },
    },
}
PUBLICATION_EXPORT_SWEEP_CRON = os.environ.get(
    "PUBLICATION_EXPORT_SWEEP_CRON", "*/30 * * * *"
)
# Publication export operational bounds and rolling deployment protection
EXPORT_MAX_ARCHIVE_BYTES = int(
    os.environ.get("EXPORT_MAX_ARCHIVE_BYTES", str(1 * 1024 * 1024 * 1024))  # 1 GiB default
)
EXPORT_MAX_ACTIVE_JOBS = int(
    os.environ.get("EXPORT_MAX_ACTIVE_JOBS", "4")  # Maximum globally active (queued/running) jobs
)
EXPORT_MAX_DURATION_SECONDS = int(
    os.environ.get("EXPORT_MAX_DURATION_SECONDS", str(30 * 60))  # 30 minutes default
)
EXPORT_TASK_ROLLOUT_DELAY_SECONDS = int(
    os.environ.get("EXPORT_TASK_ROLLOUT_DELAY_SECONDS", "300")  # 300s rollout delay
)
# EXPORT_CLEANUP_BATCH: how many export rows one exports.cleanup_expired_exports
#   tick may touch. The sweep does one remote storage delete per expired
#   archive plus one per stray file, and had NO cap on either loop: a backlog
#   of N archives is N sequential round trips to GCS on the catch-all
#   `default` worker, holding the lane for as long as that takes. Capping the
#   tick at 200 makes the worst case a bounded number of deletes; the
#   remainder is reported (and logged) so a backlog is visible rather than
#   silently absorbed, and the next tick 30 minutes later takes the next 200.
EXPORT_CLEANUP_BATCH = max(1, int(
    os.environ.get("EXPORT_CLEANUP_BATCH", "200")
))
JOB_HEALTH_EXPORTS_OVERDUE_SECONDS = int(
    os.environ.get(
        "JOB_HEALTH_EXPORTS_OVERDUE_SECONDS",
        str(EXPORT_MAX_DURATION_SECONDS * EXPORT_MAX_ACTIVE_JOBS),
    )
)
GS_BUCKET_NAME = os.environ.get("GS_BUCKET_NAME", "")
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
PROJECT_ID = os.environ.get("PROJECT_ID", "local-free2z")

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

# Where django_redis logs the exceptions it SWALLOWS.
#
# prod sets IGNORE_EXCEPTIONS: True, so an ordinary Redis outage is absorbed
# inside django_redis and never reaches FailOpenThrottleMixin: cache.get()
# returns its default, the failed cache.set() is discarded, and every DRF
# throttle then reads an empty history and allows the request. This log record
# is the ONLY trace that rate limiting has stopped happening, which makes it an
# alerting contract rather than a debugging convenience -- it is counted by
# monitoring/log-metrics/redis-ignored-exceptions.json.
#
# Naming the logger (django_redis defaults it to its own __name__) is what lets
# LOGGING below give it a formatter that emits ONE line of JSON. The default
# formatter would print the message and then the traceback, and the GKE logging
# agent ingests those as separate entries -- a metric filter cannot match a
# field in one entry and a frame in another.
DJANGO_REDIS_LOGGER = 'dj.free2z.cache'

#Cloud Logging jsonPayload.event for that record. Contract with
#monitoring/log-metrics/redis-ignored-exceptions.json; renaming it silently
#blinds the alert.
CACHE_ERROR_IGNORED_EVENT = 'django_redis_ignored_exception'

# Every logger under this name is procrastinate's OWN, not ours -- worker.py
# does `logging.getLogger(__name__)` per module (`procrastinate.worker`,
# `procrastinate.periodic`,...), so configuring the common ancestor with
# propagate=False catches the whole library in one place.: without this,
# every plain-text line procrastinate logs -- including the ~1,765/30d
# `... ended with status: Success` lines logged at INFO -- arrives in Cloud
# Logging at severity ERROR, because the root handler's plain `%(message)s`
# formatter produces unstructured text on stderr and GKE's logging agent then
# classifies by STREAM rather than by the Python level that actually produced
# it. See RawLoggerJSONFormatter's docstring in log_json.py for the full
# mechanism. Nothing in monitoring/ filters on severity today (grepped
# monitoring/log-metrics/*.json and monitoring/alert-policies/*.json for a
# `severity=` predicate in a `filter`/`conditionMatchedLog.filter` -- none
# exist; every worker-related metric matches `jsonPayload.event` from OUR OWN
# `emit_json_line` calls instead, e.g. procrastinate-failed-recent.json), so
# this fix cannot blind an alert that depends on the current miscategorisation.
PROCRASTINATE_LOGGER = 'procrastinate'

#Django's `django.request` logger (log_response) writes `Not Found: /x`
# for every 4xx and `Internal Server Error: /x` + traceback for every 5xx. It
# used to fall through to the plain root handler -> stderr -> graded ERROR by
# GKE, so ~436 expected 4xx an hour sat next to the real 500s in every
# severity>=ERROR query. DjangoRequestJSONFormatter grades 4xx INFO (a rejected
# WRITE already has its own WARNING, event=write_rejected) and keeps 5xx ERROR
# with the traceback in `message` so Error Reporting still groups them.
# propagate=False for the same reason as the loggers below. Django's DEFAULT
# 'django' logger also has mail_admins, which this bypasses; ADMINS is unset
# here, so that handler never sent anything. Nothing in monitoring/ matches the
# old `Not Found:`/`Internal Server Error:` text (grepped at ).
DJANGO_REQUEST_LOGGER = 'django.request'

#`dj.apps.search.tasks` logs `index_zpage: indexed zPage N` at INFO for
# every successful index job. It fell through to the plain root handler ->
# stderr -> graded ERROR by GKE, so during the 2026-09-28/30 model-retirement
# outage the successes sat in every `severity>=ERROR` query next to the real
# 404s. RawLoggerJSONFormatter emits the record's OWN level. Scoped to the
# tasks MODULE, not `dj.apps.search`: reconcile_multilingual_search logs a
# pre-serialised JSON string as its message, and the policies
# search-multilingual-reconciliation-{failed,never-ran} match
# `jsonPayload.event` on it -- wrapping that line would nest it inside
# `message` and blind both. Nothing in monitoring/ matches the index_zpage
# lines (grepped at ).
SEARCH_TASKS_LOGGER = 'dj.apps.search.tasks'

# Worker deployments opt in via their shared pod templates. This keeps the
# root stream structured for application loggers that do not have a dedicated
# logger configuration, without changing the web/cron/migration log format.
WORKER_ROOT_LOG_JSON = os.environ.get('FREE2Z_WORKER_LOG_JSON') == 'true'

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    #procrastinate's periodic-task/blueprint registration lines are
    # dropped in one-shot `manage.py <command>` processes (the payment host's credit
    # loop runs two every cycle). Servers and workers keep them. See
    # dj/free2z/process_role.py.
    'filters': {
        'one_shot_startup_noise': {
            '()': 'dj.free2z.process_role.OneShotStartupNoiseFilter',
        },
    },
    'formatters': {
        'cache_error_ignored': {
            '()': 'dj.free2z.log_json.SingleLineJSONFormatter',
            'event': CACHE_ERROR_IGNORED_EVENT,
        },
        'procrastinate_worker': {
            '()': 'dj.free2z.log_json.RawLoggerJSONFormatter',
        },
        'worker_root': {
            '()': 'dj.free2z.log_json.WorkerRootJSONFormatter',
            'event': 'worker_app_log',
        },
        'django_request': {
            '()': 'dj.free2z.log_json.DjangoRequestJSONFormatter',
        },
        'search_tasks': {
            '()': 'dj.free2z.log_json.RawLoggerJSONFormatter',
            'event': 'search_index_zpage',
        },
    },
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler',
            **({'formatter': 'worker_root'} if WORKER_ROOT_LOG_JSON else {}),
        },
        'cache_error_ignored_console': {
            'class': 'logging.StreamHandler',
            'formatter': 'cache_error_ignored',
        },
        'procrastinate_worker_console': {
            'class': 'logging.StreamHandler',
            'formatter': 'procrastinate_worker',
            'filters': ['one_shot_startup_noise'],
        },
        'django_request_console': {
            'class': 'logging.StreamHandler',
            'formatter': 'django_request',
        },
        'search_tasks_console': {
            'class': 'logging.StreamHandler',
            'formatter': 'search_tasks',
        },
    },
    'loggers': {
        # propagate False so the plain root handler does not also print the
        # traceback: two records for one event would make the count ambiguous.
        DJANGO_REDIS_LOGGER: {
            'handlers': ['cache_error_ignored_console'],
            'level': 'INFO',
            'propagate': False,
        },
        # propagate False for the same reason -- otherwise every record would
        # ALSO reach 'root' -> 'console' as a second, unstructured entry.
        PROCRASTINATE_LOGGER: {
            'handlers': ['procrastinate_worker_console'],
            'level': 'INFO',
            'propagate': False,
        },
        DJANGO_REQUEST_LOGGER: {
            'handlers': ['django_request_console'],
            'level': 'INFO',
            'propagate': False,
        },
        SEARCH_TASKS_LOGGER: {
            'handlers': ['search_tasks_console'],
            'level': 'INFO',
            'propagate': False,
        },
    },
    'root': {
        'handlers': ['console'],
        'level': 'INFO',
    },
}

# ---------------------------------------------------------------------------
# Procrastinate job-queue health  -- dj.apps.jobs
#
# UNITS: every *_SECONDS value below is SECONDS. Every threshold that is
# not suffixed _SECONDS is a COUNT OF JOBS over the failure window, never
# a rate. A seconds/milliseconds or count/rate mixup here is the failure
# mode that has burned this repo before -- keep the suffixes honest.
#
# WHAT "FAILED" MEANS: procrastinate only writes status='failed' once the
# task's retry strategy declines another attempt (a retryable failure goes
# back to 'todo' with a deferred_for_retry event). So every count below is
# already "retries exhausted" -- transient blips never reach it. That is
# what makes a threshold of 1 on billing defensible rather than noisy.
# ---------------------------------------------------------------------------

# Upload blob deletion is an outbox-backed worker task.  This is only the
# missed-on_commit backstop; normal deletes enqueue immediately after commit.
UPLOAD_BLOB_DELETION_SWEEP_CRON = os.environ.get(
    "UPLOAD_BLOB_DELETION_SWEEP_CRON", "*/5 * * * *")
# Give the worker rollout time to learn new task names before a new web pod's
# first cleanup job becomes claimable. All timeout values here are seconds.
UPLOAD_BLOB_DELETION_ROLLOUT_DELAY_SECONDS = int(os.environ.get(
    "UPLOAD_BLOB_DELETION_ROLLOUT_DELAY_SECONDS", "300"))
# An old worker that claims the new task name fails it terminally, because its
# task registry has no retry policy for that name. Reconsider retained rows
# after 15 minutes (twice the rollout delay), rather than waiting a day; the
# sweep still caps each pass at 100 low-priority jobs.
UPLOAD_BLOB_DELETION_REENQUEUE_AFTER_SECONDS = int(os.environ.get(
    "UPLOAD_BLOB_DELETION_REENQUEUE_AFTER_SECONDS", "900"))
UPLOAD_BLOB_DELETE_REQUEST_TIMEOUT_SECONDS = float(os.environ.get(
    "UPLOAD_BLOB_DELETE_REQUEST_TIMEOUT_SECONDS", "10"))
UPLOAD_BLOB_DELETE_RETRY_TIMEOUT_SECONDS = float(os.environ.get(
    "UPLOAD_BLOB_DELETE_RETRY_TIMEOUT_SECONDS", "30"))

# Cron for the sweep, in procrastinate's format (optional 6th column is
# seconds). Every 5 minutes: the sweep is a handful of aggregate queries,
# and 5m bounds how long a wedged billing queue stays unreported. It also
# sets the floor for the metric-absence alert -- see monitoring/.
JOB_HEALTH_SWEEP_CRON = os.environ.get("JOB_HEALTH_SWEEP_CRON", "*/5 * * * *")

# Look-back window for "recent" failures. 3600s = 1 hour. Long enough that
# a failure is still reported on several consecutive sweeps (so one dropped
# log line cannot lose the alert), short enough that an incident that was
# fixed an hour ago stops paging on its own.
JOB_HEALTH_FAILURE_WINDOW_SECONDS = int(
    os.environ.get("JOB_HEALTH_FAILURE_WINDOW_SECONDS", 3600))

# Queues treated as money paths. Everything about them is stricter.
#
# `translation` ( P8) is one: a creator has already been debited by the
# time the job exists, so a job that reaches status='failed' is 2Z held with
# nothing delivered. The task refunds inline for every failure it can observe
# and never raises for those, so a TERMINAL failure here means something the
# task could not see -- an unknown task name on an old worker after a rolling
# deploy, or the database going away mid-delivery. Both hold money until the
# 90-minute reaper sweep, and both deserve the same threshold-of-one that
# `billing` gets.
JOB_HEALTH_BILLING_QUEUES = [
    q for q in os.environ.get(
        "JOB_HEALTH_BILLING_QUEUES", "billing,translation").split(",")
    if q.strip()
]

# Translation indexing has a rollout-specific task contract: an old worker
# rejects it instead of silently indexing canonical content. One such terminal
# failure means a language variant is missing from search, so alert at one.
JOB_HEALTH_CRITICAL_QUEUES = [
    q for q in os.environ.get(
        "JOB_HEALTH_CRITICAL_QUEUES", "search-multilingual"
    ).split(",") if q.strip()
]

# Terminal failures per queue per window that trip an alert.
#
#   billing = 1: g12f.renew_subscription is the only task on this queue.
#     Its steady-state terminal-failure rate is ZERO by construction --
#     every non-charging outcome (cancelled, lapsed, not due, fan short of
#     tuzis) is an explicit early return, not an exception. So a single
#     failed billing job is a subscription that did not renew and a creator
#     who did not get paid. There is no "acceptable" number above zero.
#
#   everything else = 5: images/search jobs can fail terminally for
#     per-item reasons that are nobody's emergency (one corrupt upload, one
#     page whose content trips a provider content filter). Those produce
#     ones and twos. Five terminal failures within an hour, AFTER retries,
#     is not per-item bad luck -- it is a revoked API key, a storage
#     outage, or a bad deploy. Set at 5 rather than 2 specifically to keep
#     a single bad file from paging anyone.
JOB_HEALTH_BILLING_FAILED_THRESHOLD = int(
    os.environ.get("JOB_HEALTH_BILLING_FAILED_THRESHOLD", 1))

# Translations we SOLD and then refunded, per window. Not a Procrastinate
# failure count: `translate_zpage` refunds every failure it can observe and
# returns normally, so those jobs end `succeeded` and the threshold above never
# sees them. `dj.apps.jobs.health` reads them from the charge rows instead
# (`charges.recent_refunds`), excluding the failures the buyer caused.
#
#   3 of any code: one refund is a hard article or one bad generation, and the
#     creator already got every 2Z back. Three in an hour is a pattern -- on
#     2026-09-18 it was six of thirteen runs inside thirteen minutes (model
#     output rejected as `markup_not_in_source` / `output_truncated`), and
#     nothing said so.
#   1 of a code in JOB_HEALTH_TRANSLATION_REFUND_ALERT_AT_ONE: `provider_error`
#     is the provider call itself failing -- a revoked or expired key, an
#     outage, a quota. It is never per-article bad luck, and every translation
#     after it will fail the same way.
JOB_HEALTH_TRANSLATION_REFUND_THRESHOLD = int(
    os.environ.get("JOB_HEALTH_TRANSLATION_REFUND_THRESHOLD", 3))
JOB_HEALTH_TRANSLATION_REFUND_ALERT_AT_ONE = [
    code.strip() for code in os.environ.get(
        "JOB_HEALTH_TRANSLATION_REFUND_ALERT_AT_ONE", "provider_error"
    ).split(",") if code.strip()
]
JOB_HEALTH_FAILED_THRESHOLD = int(
    os.environ.get("JOB_HEALTH_FAILED_THRESHOLD", 5))

# How long a RUNNABLE job may sit unstarted before the queue counts as
# backed up. Measured from max(scheduled_at, deferred) -- a renewal job
# scheduled 30 days out is NOT overdue, and conflating the two would page
# permanently.
#
#   billing = 300s (5m): a renewal fires at expires-24h, so five minutes of
#     lateness costs nothing directly -- but the whole point of the event
#     based design is exact-time execution, and 5m late means the worker is
#     not draining. It is well above the 5m sweep interval's jitter... which
#     is exactly why it is 300 and not 60: a job deferred just after one
#     sweep is legitimately up to 5 minutes old when the next sweep sees it
#     only if the worker is not running, since a healthy worker starts it in
#     under a second via LISTEN/NOTIFY.
#   default = 900s (15m): images and search jobs are enqueued from user
#     actions and complete in seconds; 15 minutes is 3 consecutive sweeps of
#     a queue that is not draining.
JOB_HEALTH_BILLING_OVERDUE_SECONDS = int(
    os.environ.get("JOB_HEALTH_BILLING_OVERDUE_SECONDS", 300))
#   translation = DERIVED from the queue model, not a number here.
#     `translation` is billing-class for FAILURES (threshold one) but not for
#     lateness: a creator can now queue several documents at once, and a full
#     platform queue of Q jobs on a lane of C slots legitimately holds its
#     oldest runnable job for up to ceil(Q / C) - 1 documents of the 15-minute
#     budget. The threshold is that plus one document of margin --
#     `charges.translation_overdue_threshold_seconds()`, 4500s at both the old
#     one slot (Q = 5) and 's four (Q = 20) -- so a healthy full queue
#     never pages and a lane that has stopped draining does. Set the variable
#     below only to override it. (A waiting job is no longer refunded at
#     `charges.abandoned_after()`; the reaper leaves `todo` work alone until
#     `abandoned_hard_after()`, so this alert is what reports a stalled lane.)
JOB_HEALTH_TRANSLATION_OVERDUE_SECONDS = (
    int(os.environ["JOB_HEALTH_TRANSLATION_OVERDUE_SECONDS"])
    if os.environ.get("JOB_HEALTH_TRANSLATION_OVERDUE_SECONDS")
    else None
)

# Seconds without a `started` event while translation work remains queued
# before the throughput alert fires. Translation jobs can legitimately run for
# up to 15 minutes, so 20 minutes allows one full task budget plus one sweep
# interval of slack without waiting for the hour-scale backlog alert.
JOB_HEALTH_TRANSLATION_NO_START_SECONDS = int(
    os.environ.get("JOB_HEALTH_TRANSLATION_NO_START_SECONDS", 1200))

# THE source of truth for how many `translation` jobs run at once.
# Translation admission and backlog bounds derive from this concurrency.
# The deployment's worker concurrency must match this value and
# charges.DEFAULT_LANE_CONCURRENCY. At the default of 4, the platform queue
# cap is 20, the per-account cap is 10, and the backlog threshold is 4500s.
# Web and worker processes must receive the same value; changing only the
# worker's environment would leave admission limits inconsistent.
ZPAGE_TRANSLATION_LANE_CONCURRENCY = int(
    os.environ.get("ZPAGE_TRANSLATION_LANE_CONCURRENCY", 4))
JOB_HEALTH_OVERDUE_SECONDS = int(
    os.environ.get("JOB_HEALTH_OVERDUE_SECONDS", 900))

# Health reports keep the longest doing age as a metric. Paging requires an
# orphaned job that survived ten sweeps or a live job beyond its health-only
# runtime budget; NEVER policies remain non-reclaimable either way.
JOB_HEALTH_STUCK_DOING_SECONDS = int(
    os.environ.get("JOB_HEALTH_STUCK_DOING_SECONDS", 3600))  # legacy metric marker
JOB_HEALTH_STUCK_ORPHANED_SECONDS = int(
    os.environ.get("JOB_HEALTH_STUCK_ORPHANED_SECONDS", 600))

# --- lease-based automatic reclaim of stalled jobs  ------------------
# A normal orphan must meet both independent liveness signals: a missing/stale
# lease and a stale/missing Procrastinate worker, plus this minimum age. The
# lease timeout remains 180s because  requires it to outlast Cloud SQL
# failover and the beater handoff; lowering it to the former 60s suggestion
# could fence every healthy worker during a routine failover.
JOB_RECLAIM_MIN_AGE_SECONDS = int(
    os.environ.get("JOB_RECLAIM_MIN_AGE_SECONDS", 120))
JOB_RECLAIM_WORKER_HEARTBEAT_SECONDS = int(
    os.environ.get("JOB_RECLAIM_WORKER_HEARTBEAT_SECONDS", 60))

# Deprecated compatibility knob. Ordinary orphan recovery uses the task runtime
# plus margin, floored at JOB_RECLAIM_MIN_AGE_SECONDS. A matching durable
# abandonment marker can bypass that runtime wait. Read the old env var for
# compatibility with older settings consumers during rollout.
JOB_RECLAIM_STALLED_AFTER_SECONDS = int(
    os.environ.get("JOB_RECLAIM_STALLED_AFTER_SECONDS", 900))

# The task registry continues to own retry allowance and max-runtime metadata.
JOB_RECLAIM_BUDGET_MARGIN_SECONDS = int(
    os.environ.get("JOB_RECLAIM_BUDGET_MARGIN_SECONDS", 300))
JOB_RECLAIM_MAX_RECLAIMS = int(
    os.environ.get("JOB_RECLAIM_MAX_RECLAIMS", 3))
_JOB_RECLAIM_EXCLUDED_QUEUES_ENV = os.environ.get(
    "JOB_RECLAIM_EXCLUDED_QUEUES")
JOB_RECLAIM_EXCLUDED_QUEUES = tuple(
    q.strip()
    for q in (_JOB_RECLAIM_EXCLUDED_QUEUES_ENV or "exports").split(",")
    if q.strip()
)
# The default protects the export lane from ordinary/ambiguous requeues.
# An exact attempt/token-scoped `before_body` lease phase is safe to recover
# through that default; an operator who explicitly excludes a queue still wins.
JOB_RECLAIM_OPERATOR_EXCLUDED_QUEUES = tuple(
    q.strip()
    for q in (_JOB_RECLAIM_EXCLUDED_QUEUES_ENV or "").split(",")
    if q.strip()
)
JOB_RECLAIM_SWEEP_TIMEOUT_SECONDS = int(
    os.environ.get("JOB_RECLAIM_SWEEP_TIMEOUT_SECONDS", 240))
# Each production-pool row transaction is separately bounded. This is shorter
# than the sweep timeout because one blocked status write must not pin the
# worker's shared Procrastinate pool for the entire sweep.
JOB_RECLAIM_ROW_TIMEOUT_SECONDS = int(
    os.environ.get("JOB_RECLAIM_ROW_TIMEOUT_SECONDS", 10))
JOB_RECLAIM_SWEEP_CRON = os.environ.get(
    "JOB_RECLAIM_SWEEP_CRON", "* * * * *")

# ---------------------------------------------------------------------------
# Job leases  -- dj.apps.jobs.lease
#
# Every job a worker runs holds a row in `jobs_joblease`, beaten every
# JOB_LEASE_BEAT_SECONDS from one daemon thread per worker process, on its own
# short-lived psycopg connection (never a Django ORM connection). A lease that
# stops beating is what "the worker is gone" MEANS to the reclaimer;
# a lease the reclaimer deleted is a FENCE, and the run that held it ends
# `failed` rather than `succeeded`. See the module docstring.
#
# PROCRASTINATE_WORKER_DEFAULTS is read by procrastinate's Django contrib
# (`contrib/django/apps.py:44`) and applied to Worker.__init__ -- these are
# NOT CLI flags (`cli.py:272-332`), so this setting is the only place they can
# be set. Web processes construct the same App but never run a worker, so the
# middleware is worker-only by construction. The import below is safe at
# settings time: dj.apps.jobs.lease has no models and touches nothing Django
# until a job actually runs.
#
#   update_heartbeat_interval  SECONDS between procrastinate worker heartbeats
#                              (its default, restated so it is pinned).
#   stalled_worker_timeout     SECONDS without a heartbeat before a peer's
#                              startup prune deletes a worker row -- raised
#                              from 30 so one lagged beat during a rolling
#                              deploy does not orphan a live worker's jobs.
#   task_middleware            the lease, one middleware per task kind.
#
# test_lease.py asserts all three, so a settings edit cannot silently drop one.
# ---------------------------------------------------------------------------
from dj.apps.jobs.lease import (  # noqa: E402
    LEASE_MIDDLEWARE,
    QUEUE_PAUSE_MIDDLEWARE,
)

PROCRASTINATE_WORKER_DEFAULTS = {
    "update_heartbeat_interval": 10,
    "stalled_worker_timeout": 60,
    "task_middleware": list(QUEUE_PAUSE_MIDDLEWARE + LEASE_MIDDLEWARE),
}

# SECONDS between lease beats. 15s: twelve beats inside JOB_LEASE_STALE_SECONDS,
# so one dropped beat -- or a whole failover's worth -- is not a death sentence.
JOB_LEASE_BEAT_SECONDS = float(os.environ.get("JOB_LEASE_BEAT_SECONDS", "15"))

# SECONDS without a beat before the reclaimer  may treat a lease as
# SILENT and fence it. This is the reclaimer's number, declared here so the
# two sides cannot drift:  reads it, it does not restate it.
#
# It must outlive a Cloud SQL failover. A beat that cannot run is not a fence
# on the worker side (dj/apps/jobs/lease.py, "the silence threshold is a
# number") -- but it is not a beat either, and the failure is whole-batch and
# process-wide: a database unreachable for F seconds leaves EVERY lease on
# EVERY worker un-beaten for F + one beat interval + one hand-off, and
# procrastinate's own worker heartbeat (a database write too) goes silent at
# Retain 's 180s lease-stale budget: it covers the 90s Cloud SQL failover
# allowance, beats, and a handoff. Lowering it to the issue's old 60s literal
# could replay provider work while a healthy worker is recovering its lease.
JOB_LEASE_STALE_SECONDS = float(os.environ.get("JOB_LEASE_STALE_SECONDS", "180"))

# SECONDS between re-probes for the lease table while it does not exist (it
# is created by jobs/0004_joblease, so this only matters when an image outruns
# its migrations). While it is missing jobs run unleased and the middleware
# logs `procrastinate_lease_disabled reason=table_missing` once; the next
# probe after the table appears picks it up with no worker restart.
JOB_LEASE_TABLE_RECHECK_SECONDS = float(
    os.environ.get("JOB_LEASE_TABLE_RECHECK_SECONDS", "60"))

# SECONDS. statement_timeout AND lock_timeout on every lease connection (the
# INSERT, each beat, the DELETE). Django's connect_timeout bounds the
# handshake only: a lease row locked by someone else's open transaction must
# fail the statement -- logged, retried next beat -- rather than wedge the one
# beat thread (and with it every lease in the process) or the task slot that
# is waiting on its INSERT. 5s is many times a local UPDATE and well inside
# one beat interval.
JOB_LEASE_STATEMENT_TIMEOUT_SECONDS = float(
    os.environ.get("JOB_LEASE_STATEMENT_TIMEOUT_SECONDS", "5"))

# The operator escape hatch: JOB_LEASE_ENABLED=false makes the middleware a
# pass-through with no deploy. Leaves procrastinate's heartbeat untouched.
JOB_LEASE_ENABLED = os.environ.get(
    "JOB_LEASE_ENABLED", "true").strip().lower() not in ("0", "false", "no")

# The middleware is INERT until the reclaimer reads leases
# (dj.apps.jobs.reclaim.READS_LEASES, set by ): every fence it can raise
# ends in "the reclaimer will find it", and until one does, a run that failed
# closed on a healthy worker would sit in `doing` with nothing to find it.
# This flag runs the leases without that reclaimer -- the beats and fences
# are written and enforced, recovery is job_stuck at 3600s -- for an operator
# who wants the signal visible before  lands. The tests set it.
JOB_LEASE_WITHOUT_RECLAIMER = os.environ.get(
    "JOB_LEASE_WITHOUT_RECLAIMER", "false").strip().lower() in (
        "1", "true", "yes")

# --------------------------------------------------------------------------
# Pub/Sub transactional outbox. Units: SECONDS, except BATCH_SIZE
# (a count of outbox ROWS per relay pass).
# --------------------------------------------------------------------------
# How often the durability backstop runs. This is the interval by which a
# message can be late when the producer's on_commit defer never happened
# (process killed between COMMIT and the callback), so it also sets the floor
# of PUBSUB_OUTBOX_STALE_SECONDS below: a stale threshold shorter than the
# sweep interval would page for rows the sweep has not had a chance at yet.
PUBSUB_OUTBOX_SWEEP_CRON = os.environ.get(
    "PUBSUB_OUTBOX_SWEEP_CRON", "*/2 * * * *")
# Rows per pass. The relay re-defers itself while more are due, so this
# bounds one job's runtime, not the drain.
PUBSUB_OUTBOX_BATCH_SIZE = int(
    os.environ.get("PUBSUB_OUTBOX_BATCH_SIZE", 100))
# Wait on one publish future. Deliberately far larger than the webhook path's
# 2s cap (DYTE_PUBSUB_PUBLISH_TIMEOUT_SECONDS above) because this runs on a
# queue worker with NO open database transaction and no HTTP client waiting:
# the reason that number had to be small no longer applies.
PUBSUB_OUTBOX_PUBLISH_TIMEOUT_SECONDS = float(
    os.environ.get("PUBSUB_OUTBOX_PUBLISH_TIMEOUT_SECONDS", 30.0))
# SECONDS of wall clock one relay pass may spend publishing before it stops
# starting new publishes, hands the rest of its batch back un-attempted and
# re-defers. This is the bound that matters, NOT PUBSUB_OUTBOX_BATCH_SIZE:
# 100 rows x a 30s publish timeout is 3000s, and the worker that carries the
# `default` queue (image-variant-worker) runs at concurrency 1 across seven
# queues -- so an unbounded pass turns a Pub/Sub slowdown into a 50-minute
# outage of image variants, search indexing, translation, the health sweep
# and the stalled-job reclaimer. A healthy publish is milliseconds; this
# never fires in the good case.
#
# 45, not something larger, because the worst-case PASS is this budget plus
# one row's worst case (30s publish wait + 2 x 20s of bounded topic admin =
# 70s), and that total must stay under PUBSUB_OUTBOX_SWEEP_CRON's 120s
# period. Otherwise every slow sweep leaves the next one queued behind it and
# the shared worker falls progressively further behind images, search and
# translation. The sweep also takes its own queueing_lock, so at most one is
# ever pending; the two together are what bound the pile-up.
PUBSUB_OUTBOX_DRAIN_BUDGET_SECONDS = float(
    os.environ.get("PUBSUB_OUTBOX_DRAIN_BUDGET_SECONDS", 45.0))
# First retry delay after a publish FAILS (applied at settle time, when the
# row is known not to be in flight any more). Must exceed
# PUBSUB_OUTBOX_PUBLISH_TIMEOUT_SECONDS.
#
# It is NOT the claim lease. The lease is DRAIN_BUDGET + ROW_WORST_CASE
# (`outbox.LEASE_SECONDS`), where ROW_WORST_CASE is the publish wait plus two
# bounded topic-admin calls: 45 + (30 + 2 x 20) = **115s** with these
# defaults. Only the FIRST row of a batch starts its publish at the claim
# timestamp, so a 60s lease let the periodic sweep, which runs every 2
# minutes, claim a row a slow pass was still publishing. Raising
# PUBSUB_OUTBOX_DRAIN_BUDGET_SECONDS raises the lease one-for-one, and the
# whole pass -- claim, client construction and every publish -- must still
# fit inside it; `drain` measures its budget from the claim for that reason.
PUBSUB_OUTBOX_RETRY_BASE_SECONDS = float(
    os.environ.get("PUBSUB_OUTBOX_RETRY_BASE_SECONDS", 60.0))
# Backoff ceiling: 1 hour. There is no attempt cap on purpose -- giving up
# would silently break the promise the outbox row represents.
PUBSUB_OUTBOX_RETRY_MAX_SECONDS = float(
    os.environ.get("PUBSUB_OUTBOX_RETRY_MAX_SECONDS", 3600.0))
# An unpublished row older than this is a backlog, not in-flight work, and
# raises jsonPayload.alert="outbox_backlog" (monitoring/log-metrics/
# pubsub-outbox-backlog.json). 600s = 10 minutes: 5 sweeps and several
# backoff rungs, so a single transient Pub/Sub blip never pages.
PUBSUB_OUTBOX_STALE_SECONDS = int(
    os.environ.get("PUBSUB_OUTBOX_STALE_SECONDS", 600))
# Settle margin after the drain budget plus one row's worst-case publish/admin
# work. This covers the successful published_at UPDATE and transaction cleanup;
# it is not another publish budget and is intentionally small.
PUBSUB_OUTBOX_LEASE_SETTLE_MARGIN_SECONDS = float(
    os.environ.get("PUBSUB_OUTBOX_LEASE_SETTLE_MARGIN_SECONDS", 5.0))
# Published rows without a dedup key contain message payload history, including
# comment bodies and expired recording URLs. Keep that history for 30 days.
# Keyed published rows are retained indefinitely so a duplicate producer cannot
# reopen its idempotency window after the cleanup sweep.
PUBSUB_OUTBOX_PUBLISHED_RETENTION_DAYS = int(
    os.environ.get("PUBSUB_OUTBOX_PUBLISHED_RETENTION_DAYS", 30))
# One bounded delete per two-minute sweep; the batch size bounds rows returned
# and deleted, while the timeout bounds database scan time because published_at
# is not indexed. A historical backlog is drained over several short
# transactions rather than one large DELETE.
PUBSUB_OUTBOX_PRUNE_BATCH_SIZE = int(
    os.environ.get("PUBSUB_OUTBOX_PRUNE_BATCH_SIZE", 1000))
PUBSUB_OUTBOX_PRUNE_STATEMENT_TIMEOUT_SECONDS = float(
    os.environ.get("PUBSUB_OUTBOX_PRUNE_STATEMENT_TIMEOUT_SECONDS", 1.0))
PUBSUB_OUTBOX_PRUNE_LOCK_TIMEOUT_SECONDS = float(
    os.environ.get("PUBSUB_OUTBOX_PRUNE_LOCK_TIMEOUT_SECONDS", 0.1))

STRIPE_PUBLISHABLE_KEY = os.environ.get("STRIPE_PUBLISHABLE_KEY", "")
STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_SIGNING_SECRET = os.environ.get("STRIPE_SIGNING_SECRET", "")
# Checkout creation and fulfillment both fail closed until these server-owned
# identities are set exactly. The account ID is not secret, but it must be
# deployed alongside the matching credential rather than inferred from a
# client-provided Session or webhook field.
STRIPE_EXPECTED_ACCOUNT_ID = os.environ.get("STRIPE_EXPECTED_ACCOUNT_ID", "")
STRIPE_EXPECTED_LIVEMODE = os.environ.get("STRIPE_EXPECTED_LIVEMODE", "")
#. Stripe `evt_` ids of rejected checkout fulfillments that were settled
# OUTSIDE this system (typically refunded in the Stripe Dashboard), so the
# hourly `reconcile_stripe_fulfillment` stops paging on them. Nothing here
# records a refund, and age alone must never read as recovery, so this is the
# only way an uncredited rejection leaves the page besides being credited.
# Comma-separated; set it in the ConfigMap through a reviewed PR that names
# the refund.
STRIPE_FULFILLMENT_SETTLED_EVENT_IDS = frozenset(
    event_id.strip()
    for event_id in os.environ.get(
        "STRIPE_FULFILLMENT_SETTLED_EVENT_IDS", ""
    ).split(",")
    if event_id.strip()
)
# New exact checkout remains unavailable until an operator has provisioned the
# account-bound webhook contract, delivered a provider test event, and then
# explicitly activates the staged rollout.
STRIPE_CHECKOUT_ENABLED = os.environ.get("STRIPE_CHECKOUT_ENABLED", "false")
STRIPE_WEBHOOK_ENDPOINT_ID = os.environ.get("STRIPE_WEBHOOK_ENDPOINT_ID", "")
# Provider-authenticated refunds/disputes are observed and reconciled against
# original issuance receipts, but financial mutation stays explicitly off
# until a separately reviewed operator activation.
STRIPE_FINANCIAL_RECONCILIATION_ENABLED = os.environ.get(
    "STRIPE_FINANCIAL_RECONCILIATION_ENABLED", "false"
).lower() == "true"


_STRIPE_CHECKOUT_HOST_PATTERN = re.compile(
    r"(?=.{1,253}\Z)"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    r"(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+"
)


def _parse_stripe_checkout_allowed_hosts(raw):
    """Parse an exact DNS-host allowlist, defaulting only when unset."""
    if raw is None:
        return frozenset({"checkout.stripe.com"})

    hosts = []
    for entry in raw.split(","):
        host = entry.strip().lower()
        if not host or not _STRIPE_CHECKOUT_HOST_PATTERN.fullmatch(host):
            print(
                "[settings] STRIPE_CHECKOUT_ALLOWED_HOSTS must contain only "
                "comma-separated exact DNS hostnames without empty entries, "
                "schemes, ports, paths, userinfo, or wildcards; disabling Stripe "
                "Checkout",
                file=sys.stderr,
            )
            return frozenset()
        hosts.append(host)
    return frozenset(hosts)


# Stripe normally hosts Checkout at checkout.stripe.com, but an account can
# opt into a custom Checkout domain. Keep redirects fail-closed while allowing
# that deployment choice to be made explicitly, before the Dashboard setting
# changes. Entries are exact hostnames (no schemes, ports, paths, or wildcards).
STRIPE_CHECKOUT_ALLOWED_HOSTS = _parse_stripe_checkout_allowed_hosts(
    os.environ.get("STRIPE_CHECKOUT_ALLOWED_HOSTS")
)

# Multi-provider AI backend (see f2z/ai/providers.py). Each provider's client is
# constructed lazily from these keys; an unset key only fails when that provider
# is actually used.
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
XAI_API_KEY = os.environ.get("XAI_API_KEY", "")
MOONSHOT_API_KEY = os.environ.get("MOONSHOT_API_KEY", "")

# ---------------------------------------------------------------------------
# Signed AI catalogue, GET /api/ai/catalog/v1 (dj.apps.pricing.catalog)
# ---------------------------------------------------------------------------
#The catalogue key: the 32-byte Ed25519 SEED as 64 hex characters.
#Owner-provisioned, never committed. Empty (the default everywhere today)
#makes the endpoint answer 404 `catalog_not_provisioned` -- it never
#serves an unsigned or test-signed catalogue. Put it on the API-server
#container only (a container-scoped `valueFrom.secretKeyRef`), not in the
#shared `free2z` Secret every workload loads, so workers, cron and Daphne
#never hold a key that can set every AI price.
AI_CATALOG_SIGNING_KEY = os.environ.get("AI_CATALOG_SIGNING_KEY", "")
#The id the gateway's trusted-key list names that key by (rotation = two
#trusted ids at once). Required with the key.
AI_CATALOG_KEY_ID = os.environ.get("AI_CATALOG_KEY_ID", "")
#Allow the PUBLIC RFC 8032 test key. False in every deployed settings
#module; pytest_settings turns it on.
AI_CATALOG_ALLOW_TEST_KEY = False

# ---------------------------------------------------------------------------
# @F2ZP2P announcements
# ---------------------------------------------------------------------------
# One generated post (copy + image + canonical link) per zPage first
# publication and per new public comment, through the durable ledger in
# dj.apps.twitter.announcements and the `social` Procrastinate queue.
#
# F2ZP2P_ANNOUNCEMENTS -- the kill switch. The CODE default is "off", so any
# process that never receives the ConfigMap (a Job, a shell, a new
# Deployment) records and posts nothing (docs/agent-operations.md §5).
#   off      record nothing, post nothing. Rows already queued are
#            suppressed ("disabled") when their job runs, so flipping back
#            on never replays a backlog built up while it was off.
#   dry_run  record, re-check visibility, apply the caps, render the
#            DETERMINISTIC TEMPLATE only -- no LLM, no image, no X call.
#   live     the full pipeline. Only honoured when NAMESPACE equals
#            F2ZP2P_LIVE_NAMESPACE; everywhere else "live" behaves as
#            dry_run, so a ConfigMap shared by stage/test/prod can never make
#            stage post to the real account.
# Read by BOTH the web pods (enqueue) and the worker (execution); a change
# needs a rollout restart of both, and -- being ConfigMap-delivered -- is not
# reverted by `rollout undo`.
F2ZP2P_ANNOUNCEMENTS = _lenient_choice_env(
    "F2ZP2P_ANNOUNCEMENTS", {"off", "dry_run", "live"}, "off",
)
F2ZP2P_LIVE_NAMESPACE = os.environ.get("F2ZP2P_LIVE_NAMESPACE", "prod")
# SPEND BUDGET. X API is pay-per-use: a post that contains a URL costs
# $0.20, a plain post $0.015, a media request ~$0.005 (docs.x.com pricing,
# console as of 2026-09-17; the console is authoritative). A post that would
# exceed any cap is SUPPRESSED ("rate_capped" / "daily_capped" /
# "author_rate_capped"), not delayed: a comment flood must not turn into a
# queue that drains into the account (and the bill) for hours. Counted over
# the trailing hour / 24 hours, across rows that are generating or reached
# the provider. Worst case at the defaults: 30 linked posts/day ~= $6.15/day.
F2ZP2P_HOURLY_CAP = _int_env("F2ZP2P_HOURLY_CAP", 6, minimum=0)
F2ZP2P_DAILY_CAP = _int_env("F2ZP2P_DAILY_CAP", 30, minimum=0)
F2ZP2P_AUTHOR_HOURLY_CAP = _int_env("F2ZP2P_AUTHOR_HOURLY_CAP", 2, minimum=0)
# Whether COMMENT announcements carry the free2z.cash link. zPage
# announcements always do (the link is the point). Without it a comment post
# costs $0.015 instead of $0.20 -- an owner cost/traffic decision.
F2ZP2P_COMMENT_LINKS = _boolean_env("F2ZP2P_COMMENT_LINKS", True)
# Unit prices used only for the estimated-spend log fields (USD).
F2ZP2P_COST_POST_WITH_URL_USD = _positive_float_env(
    "F2ZP2P_COST_POST_WITH_URL_USD", 0.20,
)
F2ZP2P_COST_POST_USD = _positive_float_env("F2ZP2P_COST_POST_USD", 0.015)
F2ZP2P_COST_MEDIA_USD = _positive_float_env("F2ZP2P_COST_MEDIA_USD", 0.005)
# An event older than this when its job runs is suppressed ("stale"): after
# an outage nothing is backfilled without an explicit operator retry.
F2ZP2P_MAX_AGE_SECONDS = _int_env(
    "F2ZP2P_MAX_AGE_SECONDS", 6 * 60 * 60, minimum=60,
)
# Bounded retry ladder for 429 / 503 / connection failures.
F2ZP2P_MAX_ATTEMPTS = _int_env("F2ZP2P_MAX_ATTEMPTS", 6, minimum=1)
# Paid image generations per announcement, across ALL its retries (a
# generated image is cached on the row and re-uploaded, so this only matters
# when generation itself fails or times out). 0 = never generate.
F2ZP2P_MAX_IMAGE_GENERATIONS = _int_env(
    "F2ZP2P_MAX_IMAGE_GENERATIONS", 2, minimum=0,
)
# After a 401/402/403 from X, stop calling it for this long (every new event
# fails fast as "provider_paused" and is retained for an operator retry).
F2ZP2P_PROVIDER_PAUSE_SECONDS = _int_env(
    "F2ZP2P_PROVIDER_PAUSE_SECONDS", 30 * 60, minimum=0,
)
# Copy generation (Claude). Missing ANTHROPIC_API_KEY -> template copy.
F2ZP2P_COPY_MODEL = os.environ.get("F2ZP2P_COPY_MODEL", "claude-opus-5")
F2ZP2P_COPY_TIMEOUT_SECONDS = _int_env(
    "F2ZP2P_COPY_TIMEOUT_SECONDS", 25, minimum=1,
)
# Image generation (OpenAI, the same OPENAI_IMAGE_MODEL the image endpoint
# uses). False -> skip straight to the zPage OG card / text-only post.
F2ZP2P_IMAGE_ENABLED = _boolean_env("F2ZP2P_IMAGE_ENABLED", True)
F2ZP2P_IMAGE_QUALITY = _lenient_choice_env(
    "F2ZP2P_IMAGE_QUALITY", {"low", "medium", "high"}, "low",
)
F2ZP2P_IMAGE_TIMEOUT_SECONDS = _int_env(
    "F2ZP2P_IMAGE_TIMEOUT_SECONDS", 60, minimum=1,
)
F2ZP2P_SWEEP_CRON = os.environ.get("F2ZP2P_SWEEP_CRON", "*/10 * * * *")

# Model used by the OpenAI-only moderation/tagging utilities.
DEFAULT_UTILITY_MODEL = os.environ.get("DEFAULT_UTILITY_MODEL", "gpt-4o")

# Model for every single-prompt OpenAI text call: search summaries
# (search.index_zpage), storytime pages and the legacy flat-priced
# /api/openai/prompt. They all hard-coded gpt-3.5-turbo-instruct until OpenAI
# retired it (2026-09-28, ); see f2z.ai.providers.prompt_completion_model.
# An env var so the next retirement is a ConfigMap change, not a deploy.
# Non-reasoning chat models only: the callers' max-token budgets are sized for
# visible output, which a reasoning model would spend on hidden reasoning.
# COST: storytime and /api/openai/prompt charge a flat 1 2Z ($0.01) on this
# model, bounded to 4,096 tokens (f2z.ai.providers.FLAT_PRICE_CONTEXT_TOKENS).
# gpt-4o-mini's worst case is ~$0.0025; gpt-4o's is ~$0.04, a loss on every
# long reply. Check that arithmetic before overriding.
PROMPT_COMPLETION_MODEL = os.environ.get("PROMPT_COMPLETION_MODEL", "gpt-4o-mini")

# Bounds on the OpenAI calls made by the search indexing tasks
# (dj.apps.search.helpers -> search.index_zpage / index_multilingual_zpage).
#
# Those two tasks used the openai SDK's implicit module-level client, whose
# defaults are timeout=600s and max_retries=2 -- so ONE index job's worst case
# was 2 calls x 3 attempts x 600s = 3600s. That is where the 3600 in
# jobs/reclaim_policy.py came from, and it is above
# JOB_HEALTH_STUCK_DOING_SECONDS, i.e. a stalled index job PAGES before
# anything can heal it.
#
# 60s x 3 attempts x 2 calls = 360s worst case, comfortably under the
# reclaimer's 900s floor. 60s is generous for a 150-token completion and a
# single 1536-dim embedding (both are normally sub-second); max_retries stays
# at the SDK default of 2 because the failures this lane actually sees are
# 429s and transient 5xx, which retrying is the correct response to. Note
# search/tasks.py:INDEX_RETRY (4 attempts) is a SEPARATE, outer budget and is
# deliberately unchanged.
SEARCH_OPENAI_TIMEOUT_SECONDS = _positive_float_env(
    "SEARCH_OPENAI_TIMEOUT_SECONDS", 60.0)
SEARCH_OPENAI_MAX_RETRIES = max(0, int(
    os.environ.get("SEARCH_OPENAI_MAX_RETRIES", "2")
))

# The ONE search OpenAI call that runs inside a web request: embedding the
# user's query in VectorSearchFilter. A single short embedding is
# normally well under a second; 8s read + 3.05s connect, no SDK retry, and a
# failure falls back to full-text search rather than an error.
SEARCH_QUERY_EMBED_TIMEOUT_SECONDS = _positive_float_env(
    "SEARCH_QUERY_EMBED_TIMEOUT_SECONDS", 8.0)

# The search query is whitespace-normalized and cut to this many characters
# before it is embedded or handed to Postgres full text. A search box query
# is a few words; the cap bounds provider input and tsquery parsing per
# request, whatever fits in a URL.
SEARCH_QUERY_MAX_CHARS = _int_env("SEARCH_QUERY_MAX_CHARS", 256, minimum=1)

# How long a query's embedding is reused from the cache. Pagination and
# repeat searches re-send the same query; each reuse is one provider call
# and one admission unit not spent. Kept short because every distinct query
# holds ~6 KB (1536 float32) in the shared Redis: at the
# 'search-embed-global' ceiling of 120/minute, one hour is at most ~7,200
# entries (~44 MB) for the duration of a flood.
SEARCH_QUERY_EMBEDDING_CACHE_SECONDS = _int_env(
    "SEARCH_QUERY_EMBEDDING_CACHE_SECONDS", 3600, minimum=0)

# Web-request OpenAI calls outside search: the legacy completion view,
# the AI image view, and storytime. Each pod runs one sync gunicorn worker
#  and nginx gives up on the upstream at 200s (proxy_read_timeout).
# These calls make exactly ONE attempt (max_retries=0, see
# f2z.openai.util.get_web_request_openai_client), so 5s connect + 90s read
# is the whole provider budget.
#
# Not even /api/openai/image retries, although it forwards an Idempotency-Key
# ( review follow-up, declined): the SDK honours a server Retry-After of
# up to 120s (openai/_constants.py MAX_RETRY_AFTER_DELAY), so one retry cannot
# be bounded under nginx's 200s, and nothing documents that OpenAI dedupes
# image generations on that header, so retrying a timed-out generation may
# bill twice. A retry there needs a manual, deadline-aware loop limited to
# failures known to be unbilled (e.g. 429). It is not the SDK's max_retries.
OPENAI_WEB_REQUEST_TIMEOUT_SECONDS = _positive_float_env(
    "OPENAI_WEB_REQUEST_TIMEOUT_SECONDS", 90.0)
# Fetching a generated image by URL (storytime, GenericFile.create_from_prompt)
# from OpenAI's CDN.
OPENAI_IMAGE_DOWNLOAD_TIMEOUT_SECONDS = _positive_float_env(
    "OPENAI_IMAGE_DOWNLOAD_TIMEOUT_SECONDS", 30.0)

# --------------------------------------------------------------------------
# zPage AI tag suggestions. See dj/apps/tagging/services.py for why
# this job is not on the metered AIModel/spend-ceiling path and what bounds it
# instead. Every one of these is an env var so the cost knobs can be turned in
# an incident without a deploy.
# --------------------------------------------------------------------------
#The `zpage-tag` subscriber's model. Deliberately NOT DEFAULT_UTILITY_MODEL:
#the old code spent gpt-4o on a job whose whole output is a dozen words, on
#every PAGE_UPDATE for an untagged page.
TAGGING_MODEL = os.environ.get("TAGGING_MODEL", "gpt-4o-mini")
#Hard bound on how much article text one tagging prompt may carry, and --
#because the content digest hashes the truncated text -- also the point past
#which an edit does not trigger a new pass.
TAGGING_MAX_CHARS = int(os.environ.get("TAGGING_MAX_CHARS", "4000"))
#Below this, a page is not worth a completion.
TAGGING_MIN_CHARS = int(os.environ.get("TAGGING_MIN_CHARS", "120"))
#THE DEBOUNCE. The content digest alone does not cap spend: the editor
#autosaves every few seconds and every save is a different digest, so a
#digest-only gate buys a completion per keystroke batch. At most one pass per
#page per this many seconds, whatever the edit pattern. 0 disables it.
TAGGING_MIN_INTERVAL_SECONDS = int(
    os.environ.get("TAGGING_MIN_INTERVAL_SECONDS", "900"))
#THE LIFETIME CAP. The debounce bounds the rate; this bounds the total, so an
#article edited daily for a year cannot become the platform's largest OpenAI
#line item. 0 disables it.
TAGGING_MAX_RUNS_PER_PAGE = int(
    os.environ.get("TAGGING_MAX_RUNS_PER_PAGE", "8"))
#: a published page with ZERO tags gets the pass's output applied to
#`zpage.tags` (recorded as TagSuggestion "auto_applied"); any creator tag keeps
#it suggestion-only. False restores pure  suggestion-first. Read by the
#`zpage-tag` subscriber and the `autotag_untagged_zpages` backfill -- a
#ConfigMap flip needs a `rollout restart deployment/zpage-tag` (see
#docs/agent-operations.md §4).
TAGGING_AUTO_APPLY_BLANK = _boolean_env("TAGGING_AUTO_APPLY_BLANK", True)

# Broad vs narrow tags, derived from corpus frequency. "Broad" is the
# top TAG_BREADTH_PERCENTILE of tags by number of published zPages carrying
# them -- a percentile rather than an absolute count, so it keeps meaning the
# same thing as the corpus grows.
TAG_BREADTH_PERCENTILE = float(os.environ.get("TAG_BREADTH_PERCENTILE", "0.10"))
#The threshold is two grouped queries over the taggit join table. Cached so
#it is not paid per request; the cost of being an hour stale is that a tag
#sitting exactly on the boundary may render in the other group.
TAG_BREADTH_CACHE_SECONDS = int(
    os.environ.get("TAG_BREADTH_CACHE_SECONDS", "3600"))

# Which providers automatic language detection may send creator content to
# ( M4; see f2z/ai/language.py:allowed_providers).
#
# This is set EXPLICITLY rather than left absent, and the difference matters.
# Absent means "any provider that has an API key" -- and detection is
# automatic and silent, unlike interactive chat where the user picks the
# vendor. It selects the *cheapest callable* model, so the day someone adds a
# Moonshot or xAI key for an opt-in chat feature, the first ~4000 characters of
# every unpublished draft on the platform would start going to that vendor as a
# side effect of an unrelated change, with no creator action and no review.
#
# Pinning it to the one provider prod is guaranteed to have a key for makes
# that a deliberate decision instead of an accident. It is a no-op today
# (OPENAI_API_KEY is the only key set in prod). Add a provider here when the
# owner decides that vendor may receive every creator's drafts. Setting it to
# an empty list disables detection entirely, which is the incident switch.
LANGUAGE_DETECTION_PROVIDERS = [
    p.strip() for p in os.environ.get(
        "LANGUAGE_DETECTION_PROVIDERS", "openai"
    ).split(",") if p.strip()
]

# Multi-provider social login (dj.apps.social). Each provider's OAuth client is
# constructed LAZILY from these keys (default ""); an unset pair only means that
# provider is "not configured" (its endpoints 503) -- it NEVER blocks boot. X
# reuses the existing OAuth2 twitter credentials.
TWITTER_CLIENT_ID = os.environ.get("TWITTER_CLIENT_ID", "")
TWITTER_CLIENT_SECRET = os.environ.get("TWITTER_CLIENT_SECRET", "")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
GITHUB_CLIENT_ID = os.environ.get("GITHUB_CLIENT_ID", "")
GITHUB_CLIENT_SECRET = os.environ.get("GITHUB_CLIENT_SECRET", "")

# Providers redirect mobile authorization to this owned HTTPS endpoint. It
# consumes the provider-facing state and relays only to ZUULI's fixed private
# scheme; operators must register this exact URI with X/Google for each env.
ZUULI_MOBILE_OAUTH_PROVIDER_REDIRECT_URI = os.environ.get(
    "ZUULI_MOBILE_OAUTH_PROVIDER_REDIRECT_URI", "",
)

# Extra web origins the social OAuth redirect_uri is allowed to point at, on top
# of CORS_ORIGIN_WHITELIST. Native callbacks are separately restricted to the
# canonical ZUULI mobile URI or 127.0.0.1 + ephemeral port + 128-bit path nonce;
# see dj.apps.social.views.is_allowed_redirect_uri.
# Enable each provider only AFTER registering the exact first-party web
# callback https://<web-origin>/oauth/reauth-callback in its provider console.
# Existing native credentials alone do not prove this callback is registered.
SOCIAL_WEB_REAUTH_PROVIDERS = frozenset(
    p.strip() for p in os.environ.get("SOCIAL_WEB_REAUTH_PROVIDERS", "").split(",")
    if p.strip() in {"google", "github", "twitter"}
)

SOCIAL_REDIRECT_URI_ALLOWLIST = [
    o for o in os.environ.get("SOCIAL_REDIRECT_URI_ALLOWLIST", "").split(",")
    if o.strip()
]

# sendgrid_backend.SendgridBackend with its provider call BOUNDED.
# The stock backend builds a python_http_client.Client whose timeout defaults
# to None, i.e. urllib blocks forever -- and password-reset / verification
# mail is sent inline, inside a web request, on a pod with one sync worker
#. EMAIL_SEND_TIMEOUT_SECONDS is a per-socket-operation bound; SendGrid's
# v3 mail send normally answers in well under a second.
EMAIL_BACKEND = "dj.apps.emails.backends.BoundedSendgridBackend"
EMAIL_SEND_TIMEOUT_SECONDS = _positive_float_env(
    "EMAIL_SEND_TIMEOUT_SECONDS", 10.0)

# THE one From address for every message we send. Until  this literal was
# copied into three call sites (two in emails/views.py, one in e2ee/tasks.py),
# one of them still carrying a "Replace with your actual sender email"
# placeholder comment.
#
# THE MAIL DOMAIN IS free2z.com. THE WEB DOMAIN IS free2z.cash. THAT IS
# DELIBERATE -- DO NOT HARMONISE THEM.
#
#   * free2z.cash is the product: it is what CANONICAL_ORIGIN points at and
#     what every link inside these messages points at. It has NO SendGrid
#     domain authentication, and its SPF record
#     ("v=spf1 include:spf.efwd.registrar-servers.com ~all") does not include
#     sendgrid.net. Sending from @free2z.cash fails DKIM alignment outright.
#   * free2z.com is the mail domain. It is what  set up SendGrid domain
#     authentication for: s1/s2._domainkey CNAMEs to sendgrid.net,
#     "include:sendgrid.net" in its SPF, and
#     "v=DMARC1; p=none; rua=...; fo=1" at _dmarc.free2z.com.
#
# DMARC alignment is a property of the From: DOMAIN, so moving this address to
# the web domain would break deliverability for whichever mail type was
# edited, with a successful send and no error anywhere. dj.apps.emails.sender
# enforces the domain and dj.apps.emails.checks turns a violation into a red
# `manage.py check` -- read that module before changing this value.
#
# The default is the value that was hardcoded, so this is a no-op until
# someone deliberately sets the environment variable. Whether transactional
# mail should come from a person or a role address (noreply@ / hello@) is an
# open product decision: a role address needs the mailbox to actually
# exist so bounces and replies land somewhere.
DEFAULT_FROM_EMAIL = os.environ.get(
    "DEFAULT_FROM_EMAIL", "skylar@free2z.com"
).strip()

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
