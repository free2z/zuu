"""Recording, reading and forgetting a credential's AuthContext.

:class:`~dj.apps.identity.models.AuthContext`  says how and when the
holder of one Django session or one Knox token last authenticated. This
module is the one place that writes it at sign-in, so OIDC ``max_age``,
``prompt=login``, ``acr_values`` and the spend-cap step-up have something
to read.

The rule
--------
**Every code path that creates a session (``django.contrib.auth.login``) or
mints a Knox token calls:func:`record_login`**, with the methods the
request actually proved. ``dj/apps/identity/tests/test_login_inventory.py``
fails if a new one does not.

``amr`` values (RFC 8176, plus federation in the ``fed:<provider>`` form):

==========================  ==============================================
path                        ``amr``
==========================  ==============================================
password                    ``pwd``
password + TOTP             ``pwd otp mfa``
social / legacy X           ``fed:<provider>`` (``fed:twitter`` for legacy)
Zcash wallet signature      ``zec``
any of the above + TOTP     ``... otp mfa``
==========================  ==============================================

``acr`` is ``urn:f2z:acr:mfa`` when a second factor was verified in the
same request, else ``urn:f2z:acr:1fa`` (the OIDC contract's values,
``dj.apps.oidc.scopes``; a test pins that they agree).

A credential minted FROM another credential is not an authentication.
``/api/token/login/`` exchanges a session (or a token) for a Knox token, and
the new token inherits the presenting credential's context instead of
getting a fresh one (:data:`INHERIT`); otherwise any session, however old,
could mint a token with ``auth_time`` = now and defeat every ``max_age``.
A presenting credential with no context passes on none, which is the
fail-closed direction.

Keying
------
A session context is keyed to a newly rotated session key. Django keeps
the key on same-user login, so:func:`record_login` explicitly rotates it
after fresh proof and retires the old context. It runs after ``login()``. A Knox
context is keyed to the token's digest. Neither key is stored; see
:func:`~dj.apps.identity.models.credential_hash`.

Forgetting
----------
Django's ``logout()`` sends ``user_logged_out`` before it flushes the
session;:func:`forget_on_logout` (connected in ``IdentityConfig.ready``)
deletes the context of whatever credential the request presented. Knox's
logout views send the same signal, but only after deleting the token row,
which clears the instance's primary key -- its digest -- so
``dj/free2z/urls.py``'s two knox logout views forget explicitly
(:func:`forget_request_credentials` before the delete,
:func:`forget_all_tokens` for ``logoutall``). An ownership event needs
nothing here: ``current()`` refuses a context minted under an older
``kt_account_epoch``.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Iterable

from django.utils import timezone
from rest_framework.exceptions import APIException

from .models import AuthContext

logger = logging.getLogger(__name__)

#RFC 8176 method references used at sign-in.
AMR_PASSWORD = "pwd"
AMR_OTP = "otp"
AMR_MFA = "mfa"
#Not an RFC 8176 value (the registry has none for a wallet signature);
#RFC 8176 §1 allows values outside the registry.
AMR_ZCASH = "zec"
#The second factors a login can report. A passkey (``hwk``) joins this
#when its login route ships.
SECOND_FACTORS = frozenset({AMR_OTP})

#The OIDC contract's ``acr`` values (``dj.apps.oidc.scopes``). Restated,
#not imported, because this app does not import other apps' modules; a
#test pins the two copies together.
ACR_1FA = "urn:f2z:acr:1fa"
ACR_MFA = "urn:f2z:acr:mfa"


def federated(provider: str) -> str:
    """The ``amr`` value for a federated sign-in: ``fed:<provider>``."""
    provider = (provider or "").strip().lower()
    if not provider:
        raise ValueError("a federated sign-in names its provider")
    return f"fed:{provider}"


class _Inherit:
    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "INHERIT"


#``methods=INHERIT``: the credential being minted was obtained by
#presenting another credential, and carries that one's context.
INHERIT = _Inherit()


def current_auth_context(request):
    """The context of the credential this request presented, or ``None``.

    The credential actually accepted by authentication is used. A Knox
    token never borrows a browser session's freshness. ``None`` means "the
    platform does not know when this credential authenticated", and every
    reader treats that as "authenticate again".
    """
    user = getattr(request, "user", None)
    if user is None or not user.is_authenticated:
        return None
    digest = _knox_digest(getattr(request, "auth", None))
    if digest:
        return AuthContext.objects.current(
            user, kind=AuthContext.Kind.KNOX, key=digest)
    session = getattr(request, "session", None)
    key = getattr(session, "session_key", None)
    if key:
        return AuthContext.objects.current(
            user, kind=AuthContext.Kind.SESSION, key=key)
    return None


def record_login(request, user, *, methods, second_factor=None, token=None,
                 account_epoch=None, auth_time: datetime | None = None):
    """Record how ``user`` just signed in, for the credential just issued.

    ``methods`` is what the request proved (``[AMR_PASSWORD]``,
    ``[federated("google")]``, ``[AMR_ZCASH]``), or:data:`INHERIT` for a
    credential exchange. An empty ``methods`` records nothing: the caller
    issued a credential without proving anything fresh (a passwordless
    account setting its first password), so the credential has no context.

    ``second_factor`` is the factor verified in the same request (``"otp"``)
    or ``None``. It adds ``<factor>`` and ``mfa`` to ``amr`` and raises
    ``acr`` to:data:`ACR_MFA`.

    ``token`` is the Knox ``AuthToken`` instance when a token was minted;
    otherwise the context is keyed to ``request.session``, which must
    already be the post-``login()`` session. ``account_epoch`` must be the
    epoch the authentication was validated against (the same value the
    token was stamped with); it defaults to ``user.kt_account_epoch`` of the
    instance that was signed in.

    Returns the ``AuthContext`` written, or ``None``.
    """
    amr = None if methods is INHERIT else _amr(methods, second_factor)
    if methods is not INHERIT and not amr:
        return None
    if methods is INHERIT and second_factor is not None:
        raise ValueError("an inherited context cannot add a factor")
    if token is not None:
        kind = AuthContext.Kind.KNOX
        key = _knox_digest(token)
        if not key:
            raise ValueError("a Knox token without a digest cannot be recorded")
        expires = getattr(token, "expiry", None)
    else:
        kind = AuthContext.Kind.SESSION
        session = getattr(request, "session", None)
        if session is None:
            raise ValueError("a session login needs the request's session")
        if methods is not INHERIT:
            # Same-user Django login keeps the session key. Fresh proof must
            # never upgrade a copied stale cookie alongside the owner's.
            old_key = session.session_key
            session.cycle_key()
            if old_key:
                AuthContext.objects.forget(kind=kind, key=old_key)
        elif not session.session_key:
            session.save()
        key = session.session_key
        expires = session.get_expiry_date()

    epoch = account_epoch if account_epoch is not None else user.kt_account_epoch

    if methods is INHERIT:
        if second_factor is not None:
            raise ValueError("an inherited context cannot add a factor")
        source = current_auth_context(request) if request is not None else None
        if source is None or source.creator_id != user.pk:
            return None
        if source.account_epoch != epoch:
            # The presenting credential authenticated under a different
            # epoch than the one the new credential was stamped with: an
            # ownership event raced the exchange. Pass nothing on.
            return None
        return AuthContext.objects.record(
            user, kind=kind, key=key, auth_time=source.auth_time,
            amr=source.amr, acr=source.acr, account_epoch=epoch,
            credential_expires_at=expires,
        )

    return AuthContext.objects.record(
        user, kind=kind, key=key,
        auth_time=auth_time or timezone.now(),
        amr=amr,
        acr=ACR_MFA if second_factor else ACR_1FA,
        account_epoch=epoch,
        credential_expires_at=expires,
    )


def forget_request_credentials(request) -> int:
    """Delete the context of every credential ``request`` presented."""
    forgotten = 0
    session = getattr(request, "session", None)
    key = getattr(session, "session_key", None)
    if key:
        forgotten += AuthContext.objects.forget(
            kind=AuthContext.Kind.SESSION, key=key)
    digest = _knox_digest(getattr(request, "auth", None))
    if digest:
        forgotten += AuthContext.objects.forget(
            kind=AuthContext.Kind.KNOX, key=digest)
    return forgotten


def forget_all_tokens(user) -> int:
    """Delete every Knox-token context of ``user`` (``logoutall``)."""
    deleted, _ = AuthContext.objects.filter(
        creator_id=user.pk, credential_kind=AuthContext.Kind.KNOX,
    ).delete()
    return deleted


def forget_on_logout(sender, request=None, user=None, **kwargs):
    """``user_logged_out`` receiver: a logout forgets its credential's context.

    Django's ``logout()`` sends the signal BEFORE it flushes the session, so
    the session key is still readable here. Knox sends it AFTER deleting the
    token, whose digest (its primary key) is then gone from the instance;
    the knox logout views forget before the delete instead.
    """
    if request is None:
        return
    forget_request_credentials(request)


def _amr(methods: Iterable[str], second_factor) -> list[str]:
    if isinstance(methods, str):
        raise TypeError("methods is a list of amr values, not one string")
    amr = {str(m) for m in methods if m}
    if not amr:
        if second_factor:
            raise ValueError("a second factor needs a first one")
        return []
    if second_factor:
        if second_factor not in SECOND_FACTORS:
            raise ValueError(f"unknown second factor {second_factor!r}")
        amr |= {second_factor, AMR_MFA}
    return sorted(amr)


def _knox_digest(token) -> str | None:
    digest = getattr(token, "digest", None)
    return digest if isinstance(digest, str) and digest else None


class RecentAuthenticationRequired(APIException):
    """A link must prove an already-established account credential first."""

    max_age = 300
    status_code = 401
    auth_header = 'Bearer error="insufficient_user_authentication", max_age="300"'

    def __init__(self, detail: str = "Sign in again before linking a sign-in method."):
        self.detail = {
            "code": "insufficient_user_authentication",
            "detail": detail,
            "max_age": self.max_age,
        }

    def response(self):
        # JsonResponse works for both legacy Django callbacks and DRF views.
        from django.http import JsonResponse

        response = JsonResponse(self.detail, status=self.status_code)
        response["WWW-Authenticate"] = self.auth_header
        return response


def require_recent_auth(request, *, detail: str | None = None):
    """Fail closed before adding/reactivating an identity.

    The proposed identity's provider/wallet proof cannot satisfy this gate:
    only the caller's previously recorded account authentication can. This
    must run before mutation, including legacy orphan-profile adoption.
    ``detail`` replaces the human sentence for a caller that is not linking
    (account deletion); the machine-readable ``code`` never changes.
    """
    context = current_auth_context(request)
    if context is not None:
        age = (timezone.now() - context.auth_time).total_seconds()
        if 0 <= age <= RecentAuthenticationRequired.max_age:
            return
    raise RecentAuthenticationRequired(detail) if detail else RecentAuthenticationRequired()


def record_existing_session_reauth(request, user, *, methods, second_factor=None,
                                   account_epoch=None):
    """Refresh the same browser's session after proving an existing identity.

    Social and wallet endpoints return Knox tokens, but browsers may keep
    sending their older session cookie (SessionAuthentication runs first).
    Without this, social-only and wallet-only users can never step up.
    A token-only caller must not create a new browser session here.
    """
    from django.contrib.auth import SESSION_KEY

    session = getattr(request, "session", None)
    if session is not None and session.get(SESSION_KEY) == str(user.pk):
        record_login(request, user, methods=methods, second_factor=second_factor,
                     account_epoch=account_epoch)
