"""Recovery codes: generation, keyed hashing and single-use spending.

Each account gets:data:`RECOVERY_CODE_COUNT` codes at a time. Issuing a new
set replaces the old one. A code is spent by exactly one successful call to
:func:`consume_recovery_code`, including under concurrency.

Why a keyed hash (HMAC-SHA256) and not Django's password hasher
----------------------------------------------------------------
Password hashers (PBKDF2 at Django's default iteration count) exist to make
guessing a *low-entropy, human-chosen* secret expensive. A recovery code is
neither: it is 16 characters of Crockford base32 drawn from ``secrets``, 80
bits, so stretching buys nothing an attacker would notice. What it would
cost us is real:

* **Verification cost.** A salted password hash cannot be looked up, so
  checking one submitted code means hashing it against every unused row of
  the account: up to ten PBKDF2 runs per attempt on a single-worker web pod.
  That turns the recovery endpoint into a CPU amplifier for anyone who can
  submit guesses.
* **Atomic single use.** With a deterministic digest the spend is one
  conditional ``UPDATE... WHERE digest = %s AND used_at IS NULL``, which
  Postgres serialises on the row lock: of two concurrent spends exactly one
  matches. With a salted hash the code must first be *found* in Python and
  then marked, which is the read-then-write race this module exists to rule
  out (see ``tests/test_recovery_codes.py``, which proves that shape double
  spends).

The key is Django's ``SECRET_KEY`` through ``salted_hmac`` with a
purpose-specific salt, so a database leak on its own (a backup, the stage
copy of prod) cannot even test a guess. ``SECRET_KEY_FALLBACKS`` are honoured
on verification, so rotating the key the documented Django way does not
invalidate issued codes; codes issued after the rotation use the new key.
The account id is part of the MAC input, so a digest is meaningless for any
other account.

Refused while ``SECRET_KEY`` is the per-process random fallback
(``settings.SECRET_KEY_IS_EPHEMERAL``): each pod would then mint digests no
other pod, and no later restart, can verify. Both issuing and spending raise
``ImproperlyConfigured`` instead of quietly handing out dead codes.

Codes are bound to the account epoch
------------------------------------
A code is spendable only while its ``issued_at_epoch`` equals the account's
current ``kt_account_epoch``, compared inside the spending ``UPDATE`` itself.
Someone who briefly held the account could otherwise mint a set and keep a
second factor across the owner's password reset. This is the same use-time
rule ``ktauth.credentials`` applies to every other credential, chosen over
deleting codes at bump time for the same reason: a delete is a point-in-time
sweep that a concurrent issue can slip past, while an equality check made
at use cannot be raced.

Issuing is bound the same way from the other side. The set is stamped with
the epoch of the *authentication that asked for it* (``request.user``'s
``kt_account_epoch``, loaded when the request's credential was validated),
never with a fresh read: a request that authenticated before a password
reset and reached this function after it would otherwise mint a set stamped
with the NEW epoch, and turn a revoked session into fresh credentials
(codex adversarial review).:func:`issue_recovery_codes` compares that
epoch with the row under the account lock and raises
:class:`StaleAuthentication`, changing nothing, when they differ.

The cost: every ownership event, including the owner's own password
change, retires the owner's codes too. The flow that performs the event is
expected to offer a fresh set afterwards. There is no exemption for
passwordless accounts, unlike sign-in identities: a recovery code is never
the only way in, so refusing one cannot lock an account out.
"""
from __future__ import annotations

import secrets

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ImproperlyConfigured
from django.db import transaction
from django.db.models import OuterRef, Subquery
from django.utils import timezone
from django.utils.crypto import salted_hmac

from .models import RecoveryCode

RECOVERY_CODE_COUNT = 10

#Crockford base32: no I, L, O or U, so a code read aloud or retyped from
#paper survives the usual confusions (see:func:`normalize_code`).
ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
CODE_LENGTH = 16  # 16 x 5 bits = 80 bits
GROUP = 4

_KEY_SALT = "dj.apps.identity.recovery.RecoveryCode"
_CONFUSABLE = str.maketrans({"I": "1", "L": "1", "O": "0"})


class StaleAuthentication(Exception):
    """The caller authenticated before the account's latest ownership event.

    The endpoint should answer as for any revoked credential: sign in again.
    """


def _require_configured_secret_key() -> None:
    if getattr(settings, "SECRET_KEY_IS_EPHEMERAL", True) is not False:
        raise ImproperlyConfigured(
            "Recovery codes are keyed on SECRET_KEY, and SECRET_KEY is the "
            "per-process random fallback (the SECRET_KEY environment variable "
            "is not set). Codes issued now could not be verified by another "
            "pod or after a restart. Configure SECRET_KEY."
        )


def _current_epoch_of_account():
    """The owning account's epoch, as a subquery of the spending UPDATE."""
    return Subquery(
        get_user_model()._default_manager
        .filter(pk=OuterRef("creator_id"))
        .values("kt_account_epoch")[:1]
    )


def _format(raw: str) -> str:
    return "-".join(raw[i:i + GROUP] for i in range(0, len(raw), GROUP))


def generate_code() -> str:
    """One fresh code, formatted ``XXXX-XXXX-XXXX-XXXX``."""
    return _format("".join(secrets.choice(ALPHABET) for _ in range(CODE_LENGTH)))


def normalize_code(code: str) -> "str | None":
    """Canonical form of a typed code, or ``None`` if it cannot be one.

    Case, spaces and hyphens are ignored, and I/L/O are read as 1/1/0.
    """
    if not isinstance(code, str):
        return None
    cleaned = "".join(code.split()).replace("-", "").upper().translate(_CONFUSABLE)
    if len(cleaned) != CODE_LENGTH or any(c not in ALPHABET for c in cleaned):
        return None
    return cleaned


def _digest(creator_pk, normalized: str, secret) -> str:
    return salted_hmac(
        _KEY_SALT, f"{creator_pk}:{normalized}", secret=secret, algorithm="sha256",
    ).hexdigest()


def code_digest(creator_pk, normalized: str) -> str:
    """The digest a code is stored under, with the current ``SECRET_KEY``."""
    return _digest(creator_pk, normalized, settings.SECRET_KEY)


def _candidate_digests(creator_pk, normalized: str) -> list[str]:
    keys = [settings.SECRET_KEY, *getattr(settings, "SECRET_KEY_FALLBACKS", ())]
    return list(dict.fromkeys(_digest(creator_pk, normalized, k) for k in keys))


def issue_recovery_codes(creator, *, account_epoch: "int | None" = None) -> list[str]:
    """Replace the account's codes with a fresh set and return the plaintext.

    The plaintext exists only in the return value; show it once. Runs under
    the account row lock, so two concurrent regenerations serialise and the
    account ends with exactly one set of:data:`RECOVERY_CODE_COUNT`.

    ``account_epoch`` is the epoch the request authenticated at; it defaults
    to ``creator.kt_account_epoch``, which is that value when ``creator`` is
    ``request.user``. Pass a freshly read account and the check is void, so
    don't. Raises:class:`StaleAuthentication` (nothing changes) when the
    account has moved past it.
    """
    if account_epoch is None:
        account_epoch = creator.kt_account_epoch
    _require_configured_secret_key()
    with transaction.atomic():
        account = (
            get_user_model()._default_manager.select_for_update()
            .only("pk", "kt_account_epoch").get(pk=creator.pk)
        )
        if account.kt_account_epoch != account_epoch:
            raise StaleAuthentication(
                f"authenticated at epoch {account_epoch}, account is at "
                f"{account.kt_account_epoch}"
            )
        RecoveryCode.objects.filter(creator_id=account.pk).delete()
        codes = []
        seen = set()
        while len(codes) < RECOVERY_CODE_COUNT:
            code = generate_code()
            normalized = normalize_code(code)
            if normalized in seen:  # pragma: no cover - 2**-80
                continue
            seen.add(normalized)
            codes.append(code)
        RecoveryCode.objects.bulk_create([
            RecoveryCode(
                creator_id=account.pk,
                digest=code_digest(account.pk, normalize_code(code)),
                issued_at_epoch=account.kt_account_epoch,
            )
            for code in codes
        ])
    return codes


def consume_recovery_code(creator, code: str) -> bool:
    """Spend ``code`` for ``creator``. True exactly once per code.

    A single conditional ``UPDATE``. Under concurrency the second spender
    blocks on the first one's row lock and, once that commits, re-evaluates
    ``used_at IS NULL``, finds it false and matches nothing. If the caller's
    transaction rolls back, the code is unspent again, which is correct: the
    action it paid for did not happen either.
    """
    _require_configured_secret_key()
    normalized = normalize_code(code)
    if normalized is None:
        return False
    spent = RecoveryCode.objects.filter(
        creator_id=creator.pk,
        digest__in=_candidate_digests(creator.pk, normalized),
        used_at__isnull=True,
        # Read from the account row in the same statement: never from the
        # caller's (possibly stale) instance. See "bound to the account
        # epoch" above.
        issued_at_epoch=_current_epoch_of_account(),
    ).update(used_at=timezone.now())
    return spent > 0


def remaining_recovery_codes(creator) -> int:
    """Spendable codes: unused and issued at the account's current epoch."""
    return RecoveryCode.objects.filter(
        creator_id=creator.pk,
        used_at__isnull=True,
        issued_at_epoch=_current_epoch_of_account(),
    ).count()
