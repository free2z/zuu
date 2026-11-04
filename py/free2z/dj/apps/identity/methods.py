"""The ``LoginMethod`` registry and the last-sign-in-method guard.

A Creator can sign in several ways. Today those ways live in five places:

* a password (``Creator.has_usable_password()``);
* ``social.SocialIdentity`` rows (Google, GitHub, X through the modern flow);
* ``zauth.ZcashIdentity`` (at most one per account);
* ``twitter.TwitterProfile``, the legacy X flow, which signs in only while
  ``allow_login`` is set;
* ``identity.WebAuthnCredential``, a passkey, which signs in only
  once the passkey route is enabled on the deployment.

Recovery codes (``identity.RecoveryCode``) are deliberately not a method:
see:data:`NOT_SIGNIN_METHODS`.

Nothing looked at all four together, so the social unlink endpoint let an
account remove its only way in. This module is the one place that knows the
whole set. Each kind is an adapter in an ordered registry, so a later method
(passkeys, ) is a new adapter and not a change to every caller.

Public API, for other apps:

*func:`list_methods` lists every method attached to the account, usable
  or not.
*func:`usable_signin_methods` lists the subset that can complete a sign-in
  right now. It reuses ``ktauth.credentials.identity_can_authenticate`` rather
  than restating the epoch rules, and adds the checks that rule does not make
  (provider configured, legacy ``allow_login``).
*func:`method_of` wraps an identity row as a:class:`LoginMethod`.
*func:`can_remove` is the fast pre-check. It locks the account row and
  answers whether another usable method exists before the removal.
*func:`signin_survives` is the authoritative post-check. A removal path
  calls it after the delete **and** the epoch bump, inside the same
  transaction, and rolls back when it returns False.

Why both. A removal bumps the account epoch, and the bump can change which
of the remaining identities may sign in. With, the bump picks the
oldest stale identity as the passwordless fallback and durably refuses the
rest. If that oldest identity is on an unconfigured provider, the pre-check
counted a survivor that the bump then refused, and nothing works afterwards.
The pre-check cannot predict that selection without restating it, so every
removal path verifies the outcome instead: ``can_remove`` first to fail fast,
then the change, the bump, and ``signin_survives``.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

from django.apps import apps
from django.conf import settings
from django.contrib.auth import get_user_model

#What a refused removal tells the caller. Actionable, and the same for
#every method kind.
LAST_SIGNIN_METHOD_DETAIL = (
    "Set a password or reconnect another login method before removing this one."
)


@dataclass(frozen=True)
class LoginMethod:
    """One way into one account.

    ``kind`` names the adapter (``"password"``, ``"social"``, ``"zcash"``,
    ``"twitter"``, ``"passkey"``). ``pk`` is the backing row's primary key, or ``None`` for
    the password. ``kind`` and ``pk`` together identify the method; the other
    fields are for display.
    """

    kind: str
    pk: Any
    provider: str
    label: str
    instance: Any = field(default=None, compare=False, repr=False, hash=False)

    @property
    def key(self) -> tuple[str, Any]:
        return (self.kind, self.pk)


class LoginMethodAdapter:
    """Base adapter: how to find and judge one kind of method.

    Identity-backed adapters name their model by ``app_label.ModelName`` and
    resolve it through the app registry. They never import it, so this app
    does not depend on another app's module layout. If that app is not
    installed, the adapter contributes no methods. For the guard that is the
    fail-closed direction: fewer usable methods means more refusals.

    ``list(creator, lock=True)`` reads the rows with ``SELECT... FOR
    UPDATE``. The guard uses this so that a survivor it counted cannot be
    deleted or disabled by another transaction before the guard's own
    transaction commits. A write path that does not take the Creator lock
    (the legacy Twitter delete and disable, for example) still blocks on the
    row lock.
    """

    kind: str = ""
    model_label: "str | None" = None

    def model(self):
        if self.model_label is None:
            return None
        try:
            return apps.get_model(self.model_label)
        except LookupError:
            return None

    def handles(self, obj) -> bool:
        model = self.model()
        return model is not None and isinstance(obj, model)

    def rows(self, creator, *, lock: bool = False):
        model = self.model()
        if model is None:
            return []
        queryset = model._default_manager.filter(creator_id=creator.pk)
        if lock:
            queryset = queryset.select_for_update()
        return list(queryset.order_by("pk"))

    def list(self, creator, *, lock: bool = False) -> list[LoginMethod]:
        return [self.wrap(row) for row in self.rows(creator, lock=lock)]

    def wrap(self, obj) -> LoginMethod:
        raise NotImplementedError

    def is_usable(self, creator, method: LoginMethod) -> bool:
        raise NotImplementedError


def _identity_can_authenticate(identity, creator) -> bool:
    # Imported lazily and used as a public function only. The epoch rules
    # belong to ktauth; restating them here would drift.
    from dj.apps.ktauth.credentials import identity_can_authenticate

    return identity_can_authenticate(identity, creator)


def _social_provider_configured(provider: str) -> bool:
    # The social login view answers 503 for a provider without credentials,
    # so an identity for that provider cannot sign in on this deployment.
    # Counting it as a survivor would let the owner remove the method that
    # still works (codex adversarial review).
    from dj.apps.social.clients import configured_providers

    return configured_providers().get(provider) is True


def _legacy_twitter_login_configured() -> bool:
    # The legacy authorize view answers 503 when `TWITTER_CLIENT_ID` is
    # blank, and the callback's token exchange (`twatter.v2.client`) needs
    # `TWITTER_CLIENT_SECRET` as well. Both are read from settings rather
    # than from the twitter app's modules (codex adversarial review).
    return all(
        (getattr(settings, name, "") or "").strip()
        for name in ("TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET")
    )


class PasswordAdapter(LoginMethodAdapter):
    kind = "password"

    def handles(self, obj) -> bool:
        return False

    def list(self, creator, *, lock: bool = False) -> list[LoginMethod]:
        # The password lives on the Creator row. The guard locks that row
        # itself, so ``lock`` needs nothing extra here.
        if not creator.has_usable_password():
            return []
        return [LoginMethod(kind=self.kind, pk=None, provider="password",
                            label="Password", instance=None)]

    def is_usable(self, creator, method: LoginMethod) -> bool:
        return creator.has_usable_password()


class SocialIdentityAdapter(LoginMethodAdapter):
    """Usable when the epoch rules allow it and the provider is configured."""

    kind = "social"
    model_label = "social.SocialIdentity"

    def wrap(self, obj) -> LoginMethod:
        return LoginMethod(kind=self.kind, pk=obj.pk, provider=obj.provider,
                           label=obj.handle or obj.provider_uid, instance=obj)

    def is_usable(self, creator, method: LoginMethod) -> bool:
        if not _social_provider_configured(method.provider):
            return False
        return _identity_can_authenticate(method.instance, creator)


class ZcashIdentityAdapter(LoginMethodAdapter):
    kind = "zcash"
    model_label = "zauth.ZcashIdentity"

    def wrap(self, obj) -> LoginMethod:
        return LoginMethod(kind=self.kind, pk=obj.pk, provider="zcash",
                           label=obj.zcash_address, instance=obj)

    def is_usable(self, creator, method: LoginMethod) -> bool:
        return _identity_can_authenticate(method.instance, creator)


def _passkey_rp_id() -> str:
    """The configured WebAuthn RP id, or "" when passkey sign-in is off.

    Two settings, both read here rather than through ``efm``'s accessors so
    this app stays self-contained:

    * ``IDENTITY_PASSKEY_SIGNIN_ENABLED`` says the passkey sign-in route is
      live on this deployment. This PR ships the model before the route
      , and a method nobody can use must not count as a survivor:
      otherwise the guard would let an account unlink its last working
      method on the strength of a passkey that has nowhere to sign in. The
      endpoint PR turns it on in the same change that adds the route.
    * ``WEBAUTHN_RP_ID`` is the relying party the login ceremony verifies
      against. A passkey created for another RP id is refused by the
      authenticator itself.
    """
    if getattr(settings, "IDENTITY_PASSKEY_SIGNIN_ENABLED", False) is not True:
        return ""
    return (getattr(settings, "WEBAUTHN_RP_ID", "") or "").strip().lower()


class PasskeyAdapter(LoginMethodAdapter):
    """A WebAuthn passkey (``identity.WebAuthnCredential``).

    Usable when all of these hold:

    * passkey sign-in is enabled on this deployment and the credential was
      created for the RP id this deployment verifies against
      (:func:`_passkey_rp_id`);
    * the epoch rule every linked identity follows allows it
      (``identity_can_authenticate``): linked at the account's current
      epoch, or the account has no usable password. A passkey added before
      an ownership event (a password reset, an unlink) may be one an
      attacker planted while holding the account, so it stops signing in
      until the owner re-adds it, exactly like a social identity.
    """

    kind = "passkey"
    model_label = "identity.WebAuthnCredential"

    def wrap(self, obj) -> LoginMethod:
        return LoginMethod(kind=self.kind, pk=obj.pk, provider="passkey",
                           label=obj.name or "Passkey", instance=obj)

    def is_usable(self, creator, method: LoginMethod) -> bool:
        rp_id = _passkey_rp_id()
        if not rp_id or method.instance.rp_id.strip().lower() != rp_id:
            return False
        return _identity_can_authenticate(method.instance, creator)


class TwitterProfileAdapter(LoginMethodAdapter):
    """The legacy X flow.

    It signs in only while ``allow_login`` is set and both
    ``TWITTER_CLIENT_ID`` and ``TWITTER_CLIENT_SECRET`` are configured.
    """

    kind = "twitter"
    model_label = "twitter.TwitterProfile"

    def wrap(self, obj) -> LoginMethod:
        return LoginMethod(kind=self.kind, pk=obj.pk, provider="x",
                           label=obj.username, instance=obj)

    def is_usable(self, creator, method: LoginMethod) -> bool:
        if not method.instance.allow_login:
            return False
        if not _legacy_twitter_login_configured():
            return False
        return _identity_can_authenticate(method.instance, creator)


_REGISTRY: dict[str, LoginMethodAdapter] = {}


def register(adapter: LoginMethodAdapter) -> LoginMethodAdapter:
    """Add a method kind. A duplicate kind is a programming error."""
    if not adapter.kind:
        raise ValueError("a LoginMethodAdapter needs a kind")
    if adapter.kind in _REGISTRY:
        raise ValueError(f"login method kind {adapter.kind!r} is already registered")
    _REGISTRY[adapter.kind] = adapter
    return adapter


def registered_kinds() -> tuple[str, ...]:
    return tuple(_REGISTRY)


for _adapter in (
    PasswordAdapter(),
    SocialIdentityAdapter(),
    ZcashIdentityAdapter(),
    TwitterProfileAdapter(),
    PasskeyAdapter(),
):
    register(_adapter)


#Models in this app that are deliberately NOT sign-in methods, and why.
#``tests/test_app_shape.py`` fails if a model in this app is neither
#handled by an adapter nor listed here, so a new model has to be
#classified on purpose.:func:`method_of` refuses these by name.
NOT_SIGNIN_METHODS = {
    "identity.RecoveryCode": (
        "a recovery code replaces a lost second factor or proves the holder "
        "in the MFA-gated reset; it never signs anyone in by itself"
    ),
    "identity.AuthContext": (
        "records how an existing session or token authenticated; it is not "
        "a credential"
    ),
}


def _adapters() -> Iterable[LoginMethodAdapter]:
    return tuple(_REGISTRY.values())


def list_methods(creator, *, lock: bool = False) -> list[LoginMethod]:
    """Every sign-in method attached to ``creator``, usable or not.

    ``lock=True`` reads the identity rows ``FOR UPDATE``. It must run inside
    ``transaction.atomic``.
    """
    methods: list[LoginMethod] = []
    for adapter in _adapters():
        methods.extend(adapter.list(creator, lock=lock))
    return methods


def usable_signin_methods(creator, *, lock: bool = False) -> list[LoginMethod]:
    """The methods that can complete a sign-in as ``creator`` right now.

    Pass a ``creator`` that was read together with, or after, the rows being
    judged.:func:`can_remove` does that by reading it under a row lock.
    """
    return [
        method for method in list_methods(creator, lock=lock)
        if _REGISTRY[method.kind].is_usable(creator, method)
    ]


def method_of(obj) -> LoginMethod:
    """Wrap an identity row (``SocialIdentity`` and so on) as a method."""
    for adapter in _adapters():
        if adapter.handles(obj):
            return adapter.wrap(obj)
    label = getattr(getattr(obj, "_meta", None), "label", None)
    if label in NOT_SIGNIN_METHODS:
        raise TypeError(
            f"{label} is not a sign-in method: {NOT_SIGNIN_METHODS[label]}"
        )
    raise TypeError(f"{type(obj).__name__} is not a registered login method")


def lock_account(creator):
    """Re-read ``creator`` under ``SELECT... FOR UPDATE``.

    This lock serializes the guard with every other change to the account's
    method set that takes the same lock, including two concurrent unlinks.
    It also serializes the guard with ``ktauth.epoch.bump_account_epoch``,
    which updates this same row. It must run inside ``transaction.atomic``.
    Outside one, Django raises ``TransactionManagementError``, so an unlocked
    check fails loudly rather than racing.
    """
    return (
        get_user_model()._default_manager
        .select_for_update()
        .get(pk=creator.pk)
    )


def can_remove(creator, method: LoginMethod) -> bool:
    """Fast pre-check: does a usable method other than ``method`` exist?

    This is a prediction, not the guarantee. See:func:`signin_survives`,
    which a removal path must also call after its epoch bump.

    This locks the account row, so call it inside the same transaction that
    performs the removal. It re-reads the account and its methods after
    taking the lock, so a concurrent removal that committed first is seen.
    It also locks every identity row it counts, so a survivor cannot be
    deleted or disabled underneath it before this transaction commits, even
    by a path that does not take the account lock.

    Lock order is the account row first, then identity rows. On ``main``
    the legacy Twitter delete and disable paths lock their own row first
    and the account row later, at the epoch bump. If one of them runs
    concurrently with this guard on the same account, Postgres detects the
    deadlock and aborts one of the two transactions. That request fails and
    changes nothing, and the account keeps a way in.  moves those paths
    to account-first locking, which removes the inversion.

    The answer is yes only when some usable method other than ``method``
    exists. That holds even when ``method`` is itself unusable. An account
    with no usable method at all keeps every row it has, because a stale
    identity can still be re-linked from an authenticated session and then
    becomes usable again. Deleting it would lose that path.
    """
    account = lock_account(creator)
    return any(
        other.key != method.key
        for other in usable_signin_methods(account, lock=True)
    )


def signin_survives(creator) -> bool:
    """Authoritative post-check: can the account still sign in?

    Call it inside the removal's transaction, after the delete and after
    ``bump_account_epoch``, and roll the transaction back when it returns
    False. It re-reads the account under its row lock, so it sees the
    post-bump epoch and any fallback decision the bump made.
    """
    account = lock_account(creator)
    return bool(usable_signin_methods(account, lock=True))
