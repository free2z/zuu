"""Startup validation of the EFM WebAuthn relying-party configuration.

``webauthn_config`` refuses to serve a request with a missing relying party,
but a 500 in production is a bad place to learn that a deploy shipped without
``WEBAUTHN_RP_ID``. These checks run under ``manage.py check`` — which CI
already runs on every PR, and which Django runs on every ``runserver`` /
management command — so a broken or self-contradictory config is a red build
rather than a passkey that mysteriously stops working.

Registered from ``EfmConfig.ready()``.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from django.conf import settings
from django.core.checks import Error, Warning

from .webauthn_config import (
    EXPECTED_ORIGINS_SETTING,
    RP_ID_SETTING,
    origin_is_valid_for_rp_id,
)

# Hosts where an http:// origin is normal (local development). Anywhere else,
# WebAuthn is a secure-context-only API and http means someone got the
# environment's origins wrong.
_INSECURE_OK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def check_webauthn_relying_party(app_configs, **kwargs):
    errors: list = []

    rp_id = getattr(settings, RP_ID_SETTING, None)
    if not isinstance(rp_id, str) or not rp_id.strip():
        errors.append(
            Error(
                f"{RP_ID_SETTING} is not set.",
                hint=(
                    "Set it to the single domain that owns EFM passkeys "
                    "(e.g. 'free2z.cash'). It is a security binding and must "
                    "not be derived from the request Host header (#985)."
                ),
                id="efm.E001",
            )
        )
        rp_id = ""
    else:
        rp_id = rp_id.strip().lower()
        if "://" in rp_id or "/" in rp_id or ":" in rp_id:
            errors.append(
                Error(
                    f"{RP_ID_SETTING} must be a bare domain, not a URL or "
                    f"host:port (got {rp_id!r}).",
                    hint="For example 'free2z.cash', not 'https://free2z.cash'.",
                    id="efm.E002",
                )
            )

    origins = getattr(settings, EXPECTED_ORIGINS_SETTING, None)
    if isinstance(origins, str):
        errors.append(
            Error(
                f"{EXPECTED_ORIGINS_SETTING} must be a list/tuple, not a "
                f"string (got {origins!r}).",
                id="efm.E003",
            )
        )
        origins = []
    cleaned = [
        o.strip().rstrip("/")
        for o in (origins or [])
        if isinstance(o, str) and o.strip().rstrip("/")
    ]
    if not cleaned:
        errors.append(
            Error(
                f"{EXPECTED_ORIGINS_SETTING} is empty.",
                hint=(
                    "List the full origins (scheme://host[:port]) that EFM "
                    "passkeys may be used from, e.g. "
                    "['https://free2z.cash']."
                ),
                id="efm.E004",
            )
        )

    for origin in cleaned:
        parts = urlsplit(origin)
        if not parts.scheme or not parts.hostname:
            errors.append(
                Error(
                    f"{EXPECTED_ORIGINS_SETTING} entry {origin!r} is not an "
                    "absolute origin.",
                    hint="Use scheme://host[:port], e.g. 'https://free2z.cash'.",
                    id="efm.E005",
                )
            )
            continue
        # py_webauthn compares clientDataJSON's `origin` to these entries by
        # exact string equality, and a browser only ever reports
        # scheme://host[:port] -- never a path, query, fragment or userinfo.
        # So anything richer than an origin is not "slightly wrong", it is a
        # value that can never match, i.e. EFM silently 400s everything. Catch
        # the typo here rather than in a user's browser.
        if parts.path or parts.query or parts.fragment or parts.username:
            errors.append(
                Error(
                    f"{EXPECTED_ORIGINS_SETTING} entry {origin!r} is not a "
                    "bare origin.",
                    hint=(
                        "Browsers report only scheme://host[:port]; a path, "
                        "query, fragment or userinfo can never match, so "
                        "every ceremony would fail. Use "
                        "'https://free2z.cash', not "
                        "'https://free2z.cash/tools/p2pe2e'."
                    ),
                    id="efm.E008",
                )
            )
        # Same reasoning: a browser origin's scheme is http or https. A typo
        # like 'htps://' parses fine and would otherwise only draw the
        # not-https warning below, which `manage.py check` does not fail on.
        if parts.scheme not in ("http", "https"):
            errors.append(
                Error(
                    f"{EXPECTED_ORIGINS_SETTING} entry {origin!r} has scheme "
                    f"{parts.scheme!r}.",
                    hint="A browser origin's scheme is 'http' or 'https'.",
                    id="efm.E009",
                )
            )
        # Same "exact string equality" trap on the port. A browser serializes
        # an origin with the scheme's default port OMITTED, so
        # 'https://free2z.cash:443' matches nothing; and a non-numeric port is
        # not an origin any browser can produce.
        try:
            port = parts.port
        except ValueError:
            errors.append(
                Error(
                    f"{EXPECTED_ORIGINS_SETTING} entry {origin!r} has an "
                    "invalid port.",
                    hint="The port must be numeric, e.g. 'https://localhost:3000'.",
                    id="efm.E010",
                )
            )
            port = None
        if (parts.scheme == "https" and port == 443) or (
            parts.scheme == "http" and port == 80
        ):
            errors.append(
                Error(
                    f"{EXPECTED_ORIGINS_SETTING} entry {origin!r} spells out "
                    "the scheme's default port.",
                    hint=(
                        "Browsers omit the default port when serializing an "
                        "origin, so this entry can never match. Drop the "
                        f"':{port}'."
                    ),
                    id="efm.E011",
                )
            )
        if rp_id and not origin_is_valid_for_rp_id(origin, rp_id):
            errors.append(
                Error(
                    f"{EXPECTED_ORIGINS_SETTING} entry {origin!r} can never "
                    f"satisfy {RP_ID_SETTING}={rp_id!r}.",
                    hint=(
                        "WebAuthn requires the RP ID to equal the origin's "
                        "domain or be a registrable-domain suffix of it. "
                        "Every assertion from this origin would be rejected."
                    ),
                    id="efm.E006",
                )
            )
        if parts.scheme == "http" and (parts.hostname or "").lower() not in _INSECURE_OK_HOSTS:
            errors.append(
                Warning(
                    f"{EXPECTED_ORIGINS_SETTING} entry {origin!r} is not "
                    "https.",
                    hint=(
                        "WebAuthn is a secure-context API; browsers will not "
                        "produce an assertion on this origin outside "
                        "localhost."
                    ),
                    id="efm.W007",
                )
            )

    return errors
