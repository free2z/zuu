"""Identity models: passkeys, recovery codes and per-credential auth context.

Migration I2 of  Pillar 1. Models and model-level primitives
only; the register/login endpoints, step-up and the UI are follow-up PRs.

Why these live in ``identity`` and not in ``otp``
-------------------------------------------------
``otp`` is a legacy app with views, serializers and a single ``OTPSecret``
table keyed on a ``user`` column. ``identity`` is the app  builds to be
self-contained and movable, and it already owns the ``LoginMethod`` registry
that has to judge a passkey. Putting the passkey in ``otp`` would make the
registry reach into ``otp`` for a sign-in method, and put a new, movable
design inside an app nobody intends to move. The only foreign key here is to
``settings.AUTH_USER_MODEL``; nothing references ``otp``, ``knox`` or
``django_session`` by table, so moving the app means moving three tables.

Mixed-fleet safety
------------------
The migration only creates three new tables. Pods running the previous
release have no model for them and never read or write them, so the
rollout window has nothing to disagree about, and a code rollback leaves
three unused tables behind rather than a broken schema.
"""
from __future__ import annotations

import hashlib
from datetime import timedelta

from django.conf import settings
from django.db import models
from django.db.models import F, Q
from django.db.models.functions import Length
from django.db.models.lookups import GreaterThanOrEqual, LessThanOrEqual
from django.utils import timezone


# --------------------------------------------------------------------------- #
# Passkeys
# --------------------------------------------------------------------------- #
#WebAuthn §5.1: a credential id is at most 1023 bytes, and §13.4.1 wants at
#least 16 bytes of entropy from the authenticator.
CREDENTIAL_ID_MIN_BYTES = 16
CREDENTIAL_ID_MAX_BYTES = 1023


class WebAuthnCredential(models.Model):
    """One passkey (WebAuthn public-key credential) bound to one account.

    It is a sign-in method, registered as the ``passkey`` kind in
    :mod:`dj.apps.identity.methods`. What makes one *usable* is decided
    there, not here.

    Fields map one to one onto what ``webauthn==3.0.0``'s
    ``verify_registration_response`` returns (see
    :meth:`from_verified_registration`), plus what the relying party has to
    remember itself: which RP id the credential is scoped to, when in
    ownership-event terms it was linked, and when it was last used.
    """

    creator = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="webauthn_credentials",
    )
    #The raw credential id. Bytes, not base64url text: an assertion is
    #looked up by the bytes the authenticator returned, and a text column
    #would make padding and alphabet a second, silent identity.
    credential_id = models.BinaryField(
        max_length=CREDENTIAL_ID_MAX_BYTES,
        unique=True,
        editable=False,
    )
    #COSE_Key bytes, exactly as ``credential_public_key`` from webauthn.
    public_key = models.BinaryField(editable=False)
    sign_count = models.PositiveBigIntegerField(default=0)
    #``AuthenticatorTransport`` values the browser reported ("internal",
    #"hybrid",...). A hint for ``allowCredentials``, never trusted.
    transports = models.JSONField(default=list, blank=True)
    #The authenticator model, as reported. Empty when the attestation
    #carried none (``"none"`` attestation zeroes it).
    aaguid = models.UUIDField(null=True, blank=True)
    #The WebAuthn relying-party id the credential was created for. A
    #passkey is scoped to its RP id by the authenticator, so after an RP
    #id change it cannot sign in, however current its epoch.
    rp_id = models.CharField(max_length=253)
    name = models.CharField(max_length=64, blank=True)
    #Whether the authenticator verified the user (PIN, biometric) at
    #registration. Informational; step-up judges UV per assertion.
    user_verified = models.BooleanField(default=False)
    #``credential_device_type == multi_device`` (a synced passkey).
    backup_eligible = models.BooleanField(default=False)
    #``credential_backed_up`` as last reported.
    backed_up = models.BooleanField(default=False)
    #``Creator.kt_account_epoch`` when the passkey was added, read from the
    #authenticated request's own user (``ktauth.credentials`` module
    #docstring). The same rule as every other linked identity applies:
    #after an ownership event it stops signing in, unless the account has
    #no usable password (``identity_can_authenticate``).
    linked_at_epoch = models.PositiveIntegerField()
    fallback_rejected_at_epoch = models.PositiveIntegerField(
        null=True,
        blank=True,
        editable=False,
        help_text=(
            "Account epoch at which this passkey was rejected as a "
            "passwordless fallback. Explicit re-registration clears it."
        ),
    )
    created_at = models.DateTimeField(auto_now_add=True)
    last_used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = "Passkey"
        constraints = [
            models.CheckConstraint(
                condition=Q(
                    GreaterThanOrEqual(Length("credential_id"),
                                       CREDENTIAL_ID_MIN_BYTES),
                    LessThanOrEqual(Length("credential_id"),
                                    CREDENTIAL_ID_MAX_BYTES),
                ),
                name="identity_webauthn_credential_id_length",
            ),
            models.CheckConstraint(
                condition=~Q(rp_id=""),
                name="identity_webauthn_rp_id_present",
            ),
            models.CheckConstraint(
                condition=Q(linked_at_epoch__gte=1),
                name="identity_webauthn_linked_at_epoch_positive",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.creator_id} <- passkey {self.name or self.pk}"

    @property
    def label(self) -> str:
        return self.name or "Passkey"

    @classmethod
    def from_verified_registration(
        cls, creator, verification, *, rp_id: str, linked_at_epoch: int,
        name: str = "", transports=(),
    ) -> "WebAuthnCredential":
        """An unsaved credential from webauthn's ``VerifiedRegistration``.

        The one place the library's result is mapped onto columns, so the
        registration endpoint cannot get a field subtly wrong.
        ``linked_at_epoch`` must come from the authenticated request's own
        user, not from a fresh read (see ``ktauth.credentials``).
        """
        device_type = getattr(verification.credential_device_type, "value",
                              verification.credential_device_type)
        return cls(
            creator=creator,
            credential_id=bytes(verification.credential_id),
            public_key=bytes(verification.credential_public_key),
            sign_count=verification.sign_count,
            aaguid=_nonzero_uuid(verification.aaguid),
            rp_id=rp_id,
            name=name,
            transports=[getattr(t, "value", t) for t in transports],
            user_verified=bool(verification.user_verified),
            backup_eligible=device_type == "multi_device",
            backed_up=bool(verification.credential_backed_up),
            linked_at_epoch=linked_at_epoch,
        )

    def record_use(self, new_sign_count: int, *, backed_up=None) -> bool:
        """Advance the signature counter after a verified assertion.

        One conditional ``UPDATE``, so two concurrent assertions cannot both
        move the counter from the same value. It refuses (returns False,
        writes nothing) when the counter did not increase, which WebAuthn
        §6.1.1 treats as a sign of a cloned authenticator. The exception is
        an authenticator that does not implement a counter at all: it
        reports 0 every time, and 0 after a stored 0 is accepted.
        """
        values = {"sign_count": new_sign_count, "last_used_at": timezone.now()}
        if backed_up is not None:
            values["backed_up"] = bool(backed_up)
        rows = type(self)._default_manager.filter(pk=self.pk)
        if new_sign_count == 0:
            rows = rows.filter(sign_count=0)
        else:
            rows = rows.filter(sign_count__lt=new_sign_count)
        updated = rows.update(**values)
        if updated:
            for field, value in values.items():
                setattr(self, field, value)
        return bool(updated)


def _nonzero_uuid(value):
    if not value:
        return None
    text = str(value)
    if text.replace("-", "").strip("0") == "":
        return None
    return text


# --------------------------------------------------------------------------- #
# Recovery codes
# --------------------------------------------------------------------------- #
class RecoveryCode(models.Model):
    """One single-use account recovery code, stored as a keyed hash.

    **Not a sign-in method.** A recovery code stands in for a lost second
    factor (and, in the MFA-gated reset flow, proves the account holder);
    it never signs anyone in by itself.:mod:`dj.apps.identity.methods`
    declares that explicitly, and its tests fail if any model in this app is
    neither a method nor declared as not one.

    Generation, hashing and single-use spending live in
    :mod:`dj.apps.identity.recovery`. The hash is an HMAC, not a password
    hash; the reason is in that module's docstring.
    """

    creator = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="recovery_codes",
    )
    #Hex HMAC-SHA256 of the account id and the normalized code.
    digest = models.CharField(max_length=64, editable=False)
    #``Creator.kt_account_epoch`` when the set was issued. A code is
    #spendable only while this equals the account's current epoch, so an
    #ownership event (a password reset, an unlink) retires every set
    #issued before it; see:mod:`dj.apps.identity.recovery`.
    issued_at_epoch = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)
    used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["creator", "digest"],
                name="identity_recoverycode_creator_digest_unique",
            ),
            models.CheckConstraint(
                condition=Q(digest__regex=r"^[0-9a-f]{64}$"),
                name="identity_recoverycode_digest_is_sha256_hex",
            ),
        ]

    def __str__(self) -> str:
        state = "used" if self.used_at else "unused"
        return f"recovery code {self.pk} for {self.creator_id} ({state})"


# --------------------------------------------------------------------------- #
# AuthContext
# --------------------------------------------------------------------------- #
#How long an AuthContext is kept at most, whatever the credential's own
#expiry. Django's default ``SESSION_COOKIE_AGE`` (two weeks); a Knox token
#lives ten hours. A context that outlives its row's ``expires_at`` reads
#as absent, which a step-up check treats as "authenticate again".
AUTH_CONTEXT_MAX_AGE = timedelta(days=14)


def credential_hash(kind: str, key: str) -> str:
    """The lookup key for an AuthContext row.

    SHA-256 of ``"<kind>:<key>"``. A Django session key is itself a bearer
    credential, so this table never stores one: it stores a one-way hash,
    and a leak of this table alone signs nobody in. A Knox token is
    identified by its digest (the ``AuthToken`` primary key), hashed the
    same way for uniformity.
    """
    if kind not in AuthContext.Kind.values:
        raise ValueError(f"unknown credential kind {kind!r}")
    if not key:
        raise ValueError("a credential key is required")
    return hashlib.sha256(f"{kind}:{key}".encode()).hexdigest()


class AuthContextQuerySet(models.QuerySet):
    def live(self, now=None):
        return self.filter(expires_at__gt=now or timezone.now())

    def purge_expired(self, now=None, batch_size: int = 1000) -> int:
        """Delete up to ``batch_size`` expired rows; return how many.

        Bounded so a sweep never holds a long lock; a periodic job calls it
        until it returns 0. Expired rows are already inert (every read goes
        through:meth:`live`), so how often it runs is a storage question,
        not a security one.
        """
        now = now or timezone.now()
        ids = list(
            self.filter(expires_at__lte=now)
            .order_by("expires_at")
            .values_list("pk", flat=True)[:batch_size]
        )
        if not ids:
            return 0
        # Re-checked in the DELETE: a `record()` that renewed one of these
        # rows since the SELECT must not lose its live context (codex review).
        deleted, _ = self.model._default_manager.filter(
            pk__in=ids, expires_at__lte=now,
        ).delete()
        return deleted


class AuthContextManager(models.Manager.from_queryset(AuthContextQuerySet)):
    def record(self, creator, *, kind: str, key: str, auth_time, amr,
               acr: str = "", account_epoch: int, credential_expires_at):
        """Create or replace the context for one credential.

        ``account_epoch`` must be the epoch the authentication itself was
        validated against (the same rule as ``issue_bearer_token``).
        ``credential_expires_at`` is the session's or token's own expiry
        (``None`` for a Knox token without one); the row keeps the earlier
        of it and ``auth_time + AUTH_CONTEXT_MAX_AGE``.
        """
        # A Knox token created with no TTL has ``expiry=None``: it never
        # expires, so the cap alone bounds the context.
        cap = auth_time + AUTH_CONTEXT_MAX_AGE
        expires_at = cap if credential_expires_at is None else min(
            credential_expires_at, cap)
        amr = sorted({str(m) for m in amr})
        obj, _ = self.update_or_create(
            credential_kind=kind,
            credential_hash=credential_hash(kind, key),
            defaults={
                "creator": creator,
                "auth_time": auth_time,
                "amr": amr,
                "acr": acr,
                "account_epoch": account_epoch,
                "expires_at": expires_at,
            },
        )
        return obj

    def current(self, creator, *, kind: str, key: str, now=None):
        """The live context for this credential and account, or ``None``.

        The account's epoch is read from its row, never from the caller's
        instance, so a context minted before an ownership event is refused
        even when the caller's copy of the account is itself stale.
        """
        from django.contrib.auth import get_user_model

        epoch = (
            get_user_model()._default_manager.filter(pk=creator.pk)
            .values_list("kt_account_epoch", flat=True).first()
        )
        if epoch is None:
            return None
        return (
            self.live(now)
            .filter(
                creator_id=creator.pk,
                credential_kind=kind,
                credential_hash=credential_hash(kind, key),
                account_epoch=epoch,
            )
            .first()
        )

    def forget(self, *, kind: str, key: str) -> int:
        """Delete the context for one credential (logout)."""
        deleted, _ = self.filter(
            credential_kind=kind, credential_hash=credential_hash(kind, key),
        ).delete()
        return deleted


class AuthContext(models.Model):
    """How and when the holder of one session or token last authenticated.

    One row per credential: a Django session or a Knox token. It carries
    the OIDC ``auth_time``, ``amr`` (RFC 8176 method references) and
    ``acr``. The step-up check (``auth_context.require_recent_auth``) reads
    it to decide whether the request's credential authenticated recently
    enough, and with strong enough methods.

    A row is honoured only while all three hold, and each is checked by
    :meth:`AuthContextManager.current`:

    * ``expires_at`` is in the future (retention bound, below);
    * ``account_epoch`` equals the account's current epoch, so an ownership
      event makes every older context inert even before its credential is
      swept;
    * it belongs to the account asking.

    Retention: ``expires_at`` is the credential's own expiry, capped at
    ``auth_time + AUTH_CONTEXT_MAX_AGE``. A context never outlives its
    credential, and a credential that outlives its context simply has to
    authenticate again for step-up, which is the fail-closed direction.
    Expired rows are removed in batches by ``purge_expired``; the periodic
    ``oidc.sweep_tokens`` job calls it after this table's initial release,
    following "register first, produce second". A logout deletes its
    row through:meth:`AuthContextManager.forget`.
    """

    class Kind(models.TextChoices):
        SESSION = "session", "Django session"
        KNOX = "knox", "Knox token"

    creator = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="auth_contexts",
    )
    credential_kind = models.CharField(max_length=8, choices=Kind.choices)
    credential_hash = models.CharField(max_length=64, editable=False)
    auth_time = models.DateTimeField()
    amr = models.JSONField(default=list, blank=True)
    acr = models.CharField(max_length=64, blank=True)
    account_epoch = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    expires_at = models.DateTimeField()

    objects = AuthContextManager()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["credential_kind", "credential_hash"],
                name="identity_authcontext_credential_unique",
            ),
            models.CheckConstraint(
                condition=Q(credential_kind__in=["session", "knox"]),
                name="identity_authcontext_kind_known",
            ),
            models.CheckConstraint(
                condition=Q(credential_hash__regex=r"^[0-9a-f]{64}$"),
                name="identity_authcontext_hash_is_sha256_hex",
            ),
            models.CheckConstraint(
                condition=Q(expires_at__gt=F("auth_time")),
                name="identity_authcontext_expires_after_auth",
            ),
        ]
        indexes = [
            models.Index(fields=["expires_at"], name="identity_authctx_expires"),
        ]

    def __str__(self) -> str:
        return f"{self.credential_kind} auth context for {self.creator_id}"
