"""The scope table (spec §4) and what follows from it.

One module so the audiences a token carries, the scopes that force an
interactive consent, and the discovery document all derive from the same
seven strings.
"""
from __future__ import annotations

SCOPE_OPENID = "openid"
SCOPE_PROFILE = "profile"
SCOPE_EMAIL = "email"
SCOPE_OFFLINE_ACCESS = "offline_access"
SCOPE_BALANCE_READ = "balance:read"
SCOPE_PURCHASE_CREATE = "purchase:create"
SCOPE_AI_INVOKE = "ai:invoke"

#: Every scope the platform sells, in the order discovery lists them.
ALL_SCOPES: tuple[str, ...] = (
    SCOPE_OPENID,
    SCOPE_PROFILE,
    SCOPE_EMAIL,
    SCOPE_OFFLINE_ACCESS,
    SCOPE_BALANCE_READ,
    SCOPE_PURCHASE_CREATE,
    SCOPE_AI_INVOKE,
)

#: Spec §5: a loopback or private-use-scheme client never receives these
#: without the user's explicit act, because any process on the device can
#: claim its redirect. ``prompt=none`` answers ``interaction_required``.
INTERACTIVE_ONLY_SCOPES = frozenset(
    {SCOPE_AI_INVOKE, SCOPE_PURCHASE_CREATE, SCOPE_OFFLINE_ACCESS}
)

#: Token audiences (spec §4, §6.1).
AUD_ID = "f2z-id"
AUD_AI = "f2z-ai"
AUD_API = "f2z-api"

#: Authentication context class references (spec §10).
ACR_1FA = "urn:f2z:acr:1fa"
ACR_MFA = "urn:f2z:acr:mfa"
ACR_VALUES_SUPPORTED = (ACR_1FA, ACR_MFA)

#: The issuer the PUBLISHED contract names. Runtime uses ``settings.OIDC_
#: ISSUER``; this constant exists only so the generated ``f2z.yaml`` (built
#: with the local settings, where CANONICAL_ORIGIN is localhost) still
#: documents the real authorization and token URLs.
PUBLIC_ISSUER = "https://free2z.cash"

#: The platform cap on a developer markup (spec §2, README "v1 numbers").
MARKUP_CAP_BPS = 5000

#: No extra app budget unless the developer suggests one and the user agrees.
#: The prepaid account balance still bounds spending. Existing grants retain
#: their recorded policy; changing this default never rewrites consent.
PLATFORM_DEFAULT_SPEND_CAP_2Z = None
PLATFORM_DEFAULT_CAP_PERIOD = "month"


def scope_list(value) -> list[str]:
    """A scope string (or list) as an ordered list without duplicates."""
    if value is None:
        return []
    if isinstance(value, str):
        parts = value.split()
    else:
        parts = [str(p) for p in value]
    seen: list[str] = []
    for part in parts:
        if part and part not in seen:
            seen.append(part)
    return seen


def scope_string(scopes) -> str:
    return " ".join(scope_list(scopes))


def audiences_for(scopes) -> list[str]:
    """Spec §6.1: always a list, ``f2z-id`` always in it."""
    granted = set(scope_list(scopes))
    audiences = [AUD_ID]
    if SCOPE_AI_INVOKE in granted:
        audiences.append(AUD_AI)
    if granted & {SCOPE_BALANCE_READ, SCOPE_PURCHASE_CREATE, SCOPE_AI_INVOKE}:
        audiences.append(AUD_API)
    return audiences
