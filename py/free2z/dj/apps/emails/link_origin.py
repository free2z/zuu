"""The one origin every outbound email link is built from.

Why this module exists
----------------------
Until  every link we mailed was assembled from the *incoming request*::

    send_password_reset_email(email_obj, request.get_host())
    ...
    reset_link = f"https://{host}/reset-password?token={reset_token.token}"

``request.get_host()`` is bounded only by ``ALLOWED_HOSTS``, and in production
that list is a set of wildcards (``.free2z.com``, ``.free2z.cash``,
``.free2give.xyz``, ``.googleusercontent.com`` — see ``prod_settings.py``)
while ``k8s/free2z/ingress.yaml`` has a host-agnostic ``defaultBackend``, so
any ``Host`` value matching one of those wildcards reaches Django.

That made the password-reset path an account-takeover vector, not a cosmetic
issue: an attacker POSTs the reset endpoint with
``Host: <attacker>.googleusercontent.com`` — a domain that exists precisely to
serve third-party content — and the *victim* receives genuine, correctly
authenticated mail from us containing

    https://<attacker>.googleusercontent.com/reset-password?token=<LIVE TOKEN>

Clicking it hands a valid account-recovery token to the attacker, with the
phishing link delivered by our own mail server. The confirmation and
unsubscribe links had the same shape with lower impact (a confirmation token,
and an opt-out link that leaks the address token).

This is the same class as  F6 — the ``Host`` header choosing the WebAuthn
relying party — fixed in  for WebAuthn only. This module applies the same
rule to mail: **the origin is configuration; no request ever touches it.**

Why ``CANONICAL_ORIGIN``
------------------------
It already exists, it is already the single public origin of the namespace
(``https://free2z.cash`` in prod, ``https://stage.free2z.cash`` /
``https://test.free2z.cash`` in the others — ``k8s/free2z/config.yaml``), it is
already what ``WEBAUTHN_RP_ID`` and the Stripe return URLs derive from, and
nginx 301s ``free2z.com`` / ``free2give.xyz`` to it. Adding a second knob would
just be a second knob to forget.

Failing loudly
--------------
There is deliberately **no fallback** to a request-derived value. A missing or
malformed setting raises ``ImproperlyConfigured`` — the reset endpoint already
logs-and-swallows send failures to avoid an enumeration oracle, so the failure
surfaces in logs rather than as a 500, and the Django system check in
``dj.apps.emails.checks`` catches it at ``manage.py check`` / startup time,
which is where it should actually be caught. Quietly reverting to
``request.get_host()`` when the config is absent would reintroduce the entire
bug at exactly the moment nobody is looking.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

EMAIL_LINK_ORIGIN_SETTING = "CANONICAL_ORIGIN"


def _describe_problem(value) -> str | None:
    """Why ``value`` cannot be used as an email link origin, or ``None``.

    Shared by:func:`get_email_link_origin` and the system check so the
    request path and the deploy-time check can never disagree about what
    counts as valid.
    """
    if not isinstance(value, str) or not value.strip():
        return "is not set"

    origin = value.strip().rstrip("/")
    parts = urlsplit(origin)

    if parts.scheme not in ("http", "https"):
        return f"is not an http(s) URL (got {origin!r})"
    if not parts.hostname:
        return f"has no host (got {origin!r})"
    if parts.path or parts.query or parts.fragment or parts.username:
        # A path/query/fragment would be silently concatenated ahead of the
        # link's own path and produce a URL that 404s for every recipient.
        return f"is not a bare origin — scheme://host[:port] only (got {origin!r})"
    try:
        parts.port
    except ValueError:
        return f"has a non-numeric port (got {origin!r})"
    return None


def get_email_link_origin() -> str:
    """Origin (``scheme://host[:port]``, no trailing slash) for emailed links.

    Raises ``ImproperlyConfigured`` if unset or malformed — never falls back
    to anything derived from the request.
    """
    value = getattr(settings, EMAIL_LINK_ORIGIN_SETTING, None)
    problem = _describe_problem(value)
    if problem is not None:
        raise ImproperlyConfigured(
            f"{EMAIL_LINK_ORIGIN_SETTING} {problem}. Every link we email "
            "(password reset, address confirmation, unsubscribe) is built "
            "from it, so mail cannot be sent until it names this "
            "environment's public origin, e.g. 'https://free2z.cash'. It "
            "must never be derived from the request's Host header — see "
            "#1016."
        )
    return value.strip().rstrip("/")
