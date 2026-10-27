"""Startup validation of ``CANONICAL_ORIGIN``, which builds Stripe return URLs.

Why this lives here
-------------------
``CANONICAL_ORIGIN`` comes from the per-namespace k8s ConfigMap and is the
fallback base for a Stripe Checkout session's ``success_url`` / ``cancel_url``
(``dj/apps/ztripe/views.py``), used whenever the caller sends no CSRF-trusted
``Origin`` header. Those URLs are string-concatenated with a request path, so a
value carrying a path, a query, a fragment or a stray scheme sends a *paying*
user somewhere that does not exist after they hand over money -- the worst
possible place for a config typo to surface.

Until 's cleanup this was covered by accident: ``dj.apps.efm``'s WebAuthn
relying-party check validated ``WEBAUTHN_EXPECTED_ORIGINS``, which
``prod_settings.py`` defaults to ``[CANONICAL_ORIGIN]``. Taking EFM offline
unregistered that check, so the money path lost a guard it never knew it had.
This is that guard, stated directly and owned by the app that depends on it --
which also means it no longer disappears if the WebAuthn settings are ever
tidied away.

Registered from ``ZtripeConfig.ready()``, so it runs under ``manage.py check``
(CI on every PR, and the management commands the deploy runs) with whatever
settings module that process loaded.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from django.conf import settings
from django.core.checks import Error

from .return_origin import (
    NativeReturnOriginInvalid,
    validated_native_return_origin,
)

SETTING = "CANONICAL_ORIGIN"

# Plain http is normal in local development and nowhere else.
_INSECURE_OK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def check_canonical_origin(app_configs, **kwargs):
    errors: list = []

    origin = getattr(settings, SETTING, None)
    if not isinstance(origin, str) or not origin.strip():
        return [
            Error(
                f"{SETTING} is not set.",
                hint=(
                    "It is the base of Stripe's success_url/cancel_url. Set it "
                    "to this namespace's canonical origin, e.g. "
                    "'https://free2z.cash'."
                ),
                id="ztripe.E001",
            )
        ]

    # Deliberately NOT stripped before validation. `views.py` uses the setting
    # verbatim, and settings.py only rstrips '/', so a ConfigMap value with a
    # stray space really does reach Stripe as
    # 'https://free2z.cash /checkout'. Validating a cleaned-up copy would
    # certify a value the runtime never sees.
    if origin != origin.strip():
        errors.append(
            Error(
                f"{SETTING}={origin!r} has leading or trailing whitespace.",
                hint=(
                    "The value is used verbatim to build Stripe return URLs; "
                    "nothing strips it at runtime, so the URL sent to Stripe "
                    "would be malformed."
                ),
                id="ztripe.E007",
            )
        )

    parts = urlsplit(origin)

    if not parts.scheme or not parts.hostname:
        errors.append(
            Error(
                f"{SETTING}={origin!r} is not an absolute origin.",
                hint="Use scheme://host[:port], e.g. 'https://free2z.cash'.",
                id="ztripe.E002",
            )
        )
        # Every rule below is about the parts of an origin; without a scheme
        # and host there is nothing left to say that is not noise.
        return errors

    # `success_url` is built as f"{CANONICAL_ORIGIN}{path}" where `path` always
    # starts with "/". Anything past the authority therefore lands in the
    # middle of the URL and silently redirects the payer somewhere else.
    if parts.path or parts.query or parts.fragment or parts.username:
        errors.append(
            Error(
                f"{SETTING}={origin!r} is not a bare origin.",
                hint=(
                    "Stripe return URLs are built by concatenating a request "
                    "path onto this value, so a path, query, fragment or "
                    "userinfo sends the payer to the wrong URL after checkout. "
                    "Use 'https://free2z.cash', not "
                    "'https://free2z.cash/app'."
                ),
                id="ztripe.E003",
            )
        )

    if parts.scheme not in ("http", "https"):
        errors.append(
            Error(
                f"{SETTING}={origin!r} has scheme {parts.scheme!r}.",
                hint="A browser-reachable origin's scheme is 'http' or 'https'.",
                id="ztripe.E004",
            )
        )

    try:
        parts.port
    except ValueError:
        errors.append(
            Error(
                f"{SETTING}={origin!r} has an invalid port.",
                hint="The port must be numeric, e.g. 'http://localhost:3000'.",
                id="ztripe.E005",
            )
        )

    if (
        parts.scheme == "http"
        and (parts.hostname or "").lower() not in _INSECURE_OK_HOSTS
    ):
        errors.append(
            Error(
                f"{SETTING}={origin!r} is not https.",
                hint=(
                    "Redirecting a payer back over plain http off localhost is "
                    "a downgrade in the middle of a payment flow."
                ),
                id="ztripe.E006",
            )
        )

    return errors


def check_native_return_cache(app_configs, **kwargs):
    """Production native-return admission requires shared atomic Redis."""
    if getattr(settings, "DEBUG", False):
        return []
    backend = settings.CACHES.get("default", {}).get("BACKEND")
    if backend == "django_redis.cache.RedisCache":
        return []
    return [
        Error(
            "Native Stripe return admission has no shared atomic Redis cache.",
            hint=(
                "Configure CACHES['default'] with django_redis.cache.RedisCache; "
                "the bounded Stripe lookup fails closed without atomic Lua "
                "admission."
            ),
            id="ztripe.E008",
        )
    ]


def check_native_return_origin(app_configs, **kwargs):
    """Issuance must target the host-wide no-log callback boundary."""
    try:
        validated_native_return_origin()
    except NativeReturnOriginInvalid as exc:
        return [
            Error(
                "Native Stripe return origin is not safely isolated.",
                hint=str(exc),
                id="ztripe.E009",
            )
        ]
    return []
