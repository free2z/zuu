"""System checks: a deployment that cannot sign tokens says so, loudly.

Two severities on purpose. ``manage.py check`` -- which ``migrate`` runs,
and ``migrate`` is the Cloud Build step ``APPLY`` waits on -- gets a
**Warning**: a deployment whose owner has not yet provisioned
``OIDC_ES256_PRIVATE_KEYS`` / ``OIDC_RS256_PRIVATE_KEYS`` must not have every
deploy, hotfixes included, wedged behind a feature nothing calls yet (the
lesson of the credit-code drift gate). ``manage.py check --deploy`` gets an
**Error**, so the readiness review that runs it cannot pass with the
provider unsigned. At runtime the endpoints that need a key answer ``503``
(``server_error`` / ``signing keys unavailable``) and log at ERROR on every
attempt, which is the clear error the missing key deserves rather than a
generated key that mints tokens nobody else can verify.

In the base settings (dev, pytest) generated keys are allowed and both
checks are silent.
"""
from django.conf import settings
from django.core import checks

from .keys import SigningKeysUnavailable, load_keyring

HINT_KEYS = (
    "Provide PEM private keys in OIDC_ES256_PRIVATE_KEYS and "
    "OIDC_RS256_PRIVATE_KEYS (Secret Manager -> env). "
    "`manage.py oidc_rotate_keys --alg all` prints new blocks."
)


def _signing_key_problem():
    try:
        load_keyring()
    except SigningKeysUnavailable as exc:
        return str(exc)
    return None


def _issuer_problem():
    if getattr(settings, "OIDC_ALLOW_GENERATED_KEYS", False):
        return None
    issuer = getattr(settings, "OIDC_ISSUER", "")
    if not issuer.startswith("https://") or issuer.endswith("/"):
        return (
            f"OIDC_ISSUER must be an https origin with no trailing slash "
            f"in a deployment, got {issuer!r}"
        )
    return None


@checks.register(checks.Tags.security)
def check_signing_keys(app_configs, **kwargs):
    problem = _signing_key_problem()
    if problem is None:
        return []
    return [checks.Warning(
        f"OIDC signing keys are not usable: {problem}. The OIDC endpoints "
        "answer 503 until they are.",
        hint=HINT_KEYS, id="oidc.W001",
    )]


@checks.register(checks.Tags.security, deploy=True)
def check_signing_keys_deploy(app_configs, **kwargs):
    problem = _signing_key_problem()
    if problem is None:
        return []
    return [checks.Error(
        f"OIDC signing keys are not usable: {problem}",
        hint=HINT_KEYS, id="oidc.E001",
    )]


@checks.register(checks.Tags.security)
def check_issuer(app_configs, **kwargs):
    problem = _issuer_problem()
    if problem is None:
        return []
    return [checks.Warning(
        problem, hint="Set OIDC_ISSUER (or CANONICAL_ORIGIN) to https://free2z.cash.",
        id="oidc.W002",
    )]


@checks.register(checks.Tags.security, deploy=True)
def check_issuer_deploy(app_configs, **kwargs):
    problem = _issuer_problem()
    if problem is None:
        return []
    return [checks.Error(
        problem, hint="Set OIDC_ISSUER (or CANONICAL_ORIGIN) to https://free2z.cash.",
        id="oidc.E002",
    )]
