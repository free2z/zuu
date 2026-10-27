"""Configuration accessors for the EFM WebAuthn relying party.

Why this module exists
----------------------
Until  the relying-party ID and the expected origin were both computed
from the *incoming request*::

    def get_rp_id(request):
        return request.get_host().split(':')[0]

    origin = request.build_absolute_uri('/').rstrip('/')

Those two values are the security-critical binding a passkey is verified
against immediately before ``Participant.webauthn_public_key`` and
``webauthn_credential_id`` are written to the database. Letting the ``Host``
header choose them meant request metadata shaped what got persisted, which is
exactly the rule  exists to enforce.

The bound was ``ALLOWED_HOSTS``, and in production that list is a set of
wildcards (``.free2z.com``, ``.free2z.cash``, ``.free2give.xyz``,
``.googleusercontent.com`` — see ``prod_settings.py``). So ``rp_id`` was not a
constant, with two concrete consequences:

* a passkey registered while the browser was on one hostname simply fails to
  verify when the same user arrives on another — a silent, confusing breakage
  with no error a user could act on; and
* ``.googleusercontent.com`` put the relying party on a domain we do not
  control end to end.

The relying party is now **configuration**. ``get_rp_id()`` and
``get_expected_origins()`` read settings and never look at the request.

Failing loudly
--------------
There is deliberately **no fallback** to a request-derived value. A blank or
missing setting raises ``ImproperlyConfigured`` on the request (a 500, loud in
logs and alerting). Quietly reverting to ``request.get_host()`` when the config
is absent would reintroduce the whole bug at precisely the moment nobody is
looking.

The rules are also expressed as a Django system check in ``dj.apps.efm.checks``
-- but that check is **not registered** while the app is offline (see
``dj/apps/efm/__init__.py`` and the comment in ``apps.py``). Nothing reaches
the functions below in a deployed process today; re-register the check in the
same commit that re-adds a route.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

RP_ID_SETTING = "WEBAUTHN_RP_ID"
RP_NAME_SETTING = "WEBAUTHN_RP_NAME"
EXPECTED_ORIGINS_SETTING = "WEBAUTHN_EXPECTED_ORIGINS"

DEFAULT_RP_NAME = "Free2Z EFM"


def get_rp_id() -> str:
    """The configured WebAuthn relying-party ID.

    Raises ``ImproperlyConfigured`` if unset or blank — never falls back to
    anything derived from the request.
    """
    rp_id = getattr(settings, RP_ID_SETTING, None)
    if not isinstance(rp_id, str) or not rp_id.strip():
        raise ImproperlyConfigured(
            f"{RP_ID_SETTING} is not configured. WebAuthn registration and "
            "authentication are disabled until it is set to the single "
            "domain that owns EFM passkeys (e.g. 'free2z.cash'). It must "
            "never be derived from the request's Host header — see #985."
        )
    return rp_id.strip().lower()


def get_rp_name() -> str:
    """Human-readable relying-party name shown by the authenticator UI.

    Cosmetic, not a security binding, so this one has a default.
    """
    rp_name = getattr(settings, RP_NAME_SETTING, None)
    if not isinstance(rp_name, str) or not rp_name.strip():
        return DEFAULT_RP_NAME
    return rp_name.strip()


def get_expected_origins() -> list[str]:
    """Origins a WebAuthn assertion is allowed to have been produced on.

    A list, because one relying party can legitimately be reached on several
    origins (``https://free2z.cash`` and ``https://www.free2z.cash``, or the
    http/https pair a local dev server offers). py_webauthn's
    ``expected_origin`` accepts ``str | list[str]`` and requires an exact
    match against one entry, so this widens nothing beyond what is listed.

    Raises ``ImproperlyConfigured`` if unset or empty.
    """
    origins = getattr(settings, EXPECTED_ORIGINS_SETTING, None)
    if isinstance(origins, str):
        # A bare string would "work" (py_webauthn accepts str) but silently
        # means something different from a one-element list to every other
        # reader, so refuse it rather than guess.
        raise ImproperlyConfigured(
            f"{EXPECTED_ORIGINS_SETTING} must be a list/tuple of origins, "
            f"not a string (got {origins!r})."
        )
    cleaned = [
        o.strip().rstrip("/")
        for o in (origins or [])
        if isinstance(o, str) and o.strip().rstrip("/")
    ]
    if not cleaned:
        raise ImproperlyConfigured(
            f"{EXPECTED_ORIGINS_SETTING} is not configured. It must list the "
            "full origins (scheme://host[:port]) that EFM passkeys may be "
            "used from. It must never be derived from the request — see #985."
        )
    return cleaned


def origin_is_valid_for_rp_id(origin: str, rp_id: str) -> bool:
    """Whether ``origin`` could ever satisfy a relying party of ``rp_id``.

    WebAuthn requires the RP ID to equal the origin's effective domain or be a
    registrable-domain suffix of it, so ``free2z.cash`` covers
    ``https://www.free2z.cash`` but never ``https://free2z.com``. Used by the
    system check to catch a mismatched pair at deploy time instead of as an
    unexplained verification failure in a user's browser.
    """
    parts = urlsplit(origin)
    if not parts.scheme or not parts.hostname:
        return False
    host = parts.hostname.lower()
    rp_id = rp_id.lower()
    return host == rp_id or host.endswith("." + rp_id)
