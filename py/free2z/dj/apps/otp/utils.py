import binascii
import enum
import logging

from django.db import transaction
from django.utils import timezone

from django.core.cache import cache
import pyotp

from .models import OTPSecret


INVALID_OTP_TOKEN_MESSAGE = "Invalid OTP token."
TOTP_ATTEMPT_LIMIT = 5
TOTP_ATTEMPT_TTL_SECONDS = 300

logger = logging.getLogger(__name__)

# RFC 6238 section 5.2: the verifier MUST reject a second successful
# verification of the same code within one time step. We implement this as a
# hard rejection with NO grace period: once a code has been consumed, that
# step is dead for every consumer, even if the retry arrives milliseconds
# later. The consumed step is recorded on OTPSecret.last_used_at and compared
# by time step -- derived from the live PyOTP object's own interval, never a
# disconnected hard-coded constant.


def generate_secret():
    """
    Generates a secure random base32-encoded secret key for TOTP authentication.
    """
    return pyotp.random_base32()


def _verify_token_stateless(secret, token, for_time=None):
    """
    Stateless TOTP check. Does NOT consume the code -- use verify_user_totp()
    or consume_token() wherever a successful verification grants access, so
    the code is burned exactly once.

    Private by name on purpose ( review): a stateless check is the
    wrong tool for granting access, and 's credential issuers all go
    through the consuming verify_user_totp(), so nothing outside this module
    should be reaching for it.

    Fails closed on a malformed stored secret or request value rather than
    turning an authentication attempt into a 500.

    :param secret: The user's secret key (base32 encoded).
    :param token: The OTP token to verify.
    :param for_time: Verify against this instant instead of the wall clock.
        consume_token() always passes the instant it captured, so the step it
        burns is provably the step that was verified.
    """
    if not isinstance(secret, str) or not isinstance(token, str):
        return False
    try:
        totp = pyotp.TOTP(secret)
        # valid_window MUST stay 0 here: with any wider window a token from
        # an adjacent step verifies while consume_token() burns only the
        # CURRENT step's timecode, leaving the matched step replayable. If a
        # window is ever wanted, consume_token() must burn the matched step,
        # not the current one.
        if for_time is not None:
            return bool(totp.verify(token, for_time=for_time))
        return bool(totp.verify(token))
    except (TypeError, ValueError, binascii.Error):
        return False


def consume_token(otp_secret, token):
    """Verify ``token`` against ``otp_secret`` and burn it on success.

    MUST be called with the OTPSecret row locked (select_for_update) inside
    a transaction, which is what makes the burn atomic across processes:
    two concurrent requests presenting the same valid code serialize on the
    row lock, and only the first sees an unburned step.

    ONE verification instant is captured up front and used for BOTH the
    PyOTP comparison (via ``for_time``) and the consumed-step computation.
    Letting PyOTP read the wall clock independently would let a call that
    crosses a step boundary verify a NEW-step token while stamping the OLD
    step, reopening that new-step token for replay.

    Returns False without writing anything when the code is invalid or when
    the stored last-used step is equal to OR LATER than the accepted step --
    the >= comparison means clock rollback cannot reopen a consumed step.
    """
    verification_time = timezone.now()
    try:
        totp = pyotp.TOTP(otp_secret.secret)
        accepted_step = int(totp.timecode(verification_time))
        last_used_at = otp_secret.last_used_at
        if (
            last_used_at is not None
            and int(totp.timecode(last_used_at)) >= accepted_step
        ):
            # A code was already accepted in this time step. With valid_window=0
            # the only code verifiable right now IS that code, so this is a
            # replay: reject before verifying again.
            return False
        if not _verify_token_stateless(
            otp_secret.secret, token, for_time=verification_time
        ):
            return False
    except (TypeError, ValueError, binascii.Error, OverflowError, OSError):
        # Malformed stored seed or unusable clock/step value: fail closed
        # without writing anything.
        return False
    otp_secret.last_used_at = verification_time
    otp_secret.save(update_fields=['last_used_at'])
    return True


class TotpGate(enum.Enum):
    """How:func:`check_user_totp` answered.

    Three outcomes, not two, because a login has to know WHICH way it
    passed: ``NOT_ENROLLED`` lets the login through without a second factor,
    ``VERIFIED`` means a code was checked and burned, and only the latter
    earns ``otp``/``mfa`` in the session's recorded ``amr``.
    """

    REFUSED = "refused"
    NOT_ENROLLED = "not-enrolled"
    VERIFIED = "verified"

    @property
    def passed(self) -> bool:
        return self is not TotpGate.REFUSED

    @property
    def second_factor(self):
        """The RFC 8176 method this outcome proves, or ``None``."""
        return "otp" if self is TotpGate.VERIFIED else None


def check_user_totp(user, token) -> TotpGate:
    """:func:`verify_user_totp`, saying which way it passed.

    Decided under the same row lock as the consume, so "a code was verified"
    and "the account had an active factor" come from one snapshot: a factor
    disabled concurrently yields ``NOT_ENROLLED``, never a ``VERIFIED`` that
    no code earned.
    """
    if user is None or not getattr(user, 'is_authenticated', False):
        return TotpGate.REFUSED
    with transaction.atomic():
        otp_secret = (
            OTPSecret.objects.select_for_update()
            .filter(user_id=user.pk, is_active=True)
            .first()
        )
        if otp_secret is None:
            return TotpGate.NOT_ENROLLED
        if consume_token(otp_secret, token):
            return TotpGate.VERIFIED
        return TotpGate.REFUSED


def verify_user_totp(user, token):
    """Single-use TOTP gate: verify AND atomically consume ``token``.

    Returns True when ``user`` has NO active TOTP factor, so accounts that
    never enrolled keep their existing flow through any shared gate built on
    this helper. For an enrolled account it returns True exactly once per
    time step: the winning caller burns the code under the row lock, and any
    other presentation of the same step's code -- same route or another
    TOTP-gated route, sequential or concurrent -- is rejected until the next
    step.

    This is the helper credential-issuing flows should call instead of
    stateless checks;  rebased its issuers onto exactly this signature.
    A login that must also know whether a factor was USED calls
    :func:`check_user_totp` instead.
    """
    return check_user_totp(user, token).passed


def has_active_totp(user):
    """Return whether ``user`` has an enrolled, active TOTP factor."""
    if user is None or not getattr(user, "is_authenticated", False):
        return False
    return OTPSecret.objects.filter(
        user_id=user.pk,
        is_active=True,
    ).exists()


def _totp_attempt_key(scope, identifier):
    return f"totp-attempts:{scope}:{identifier}"


def claim_totp_attempt(scope, identifier, timeout):
    """Atomically reserve one bounded TOTP attempt, or return ``None``.

    Returning ``None`` for a counter-store failure lets credential issuers fail
    closed instead of silently turning an unavailable shared cache into an
    unlimited OTP guessing lane.
    """
    key = _totp_attempt_key(scope, identifier)
    try:
        if cache.add(key, 1, timeout=timeout):
            return 1
        return int(cache.incr(key))
    except ValueError:
        # A fixed TTL can expire between add() and incr(). Recreate the key
        # once; any other cache failure is handled below and fails closed.
        try:
            if cache.add(key, 1, timeout=timeout):
                return 1
            return int(cache.incr(key))
        except Exception:
            logger.exception("TOTP attempt counter unavailable")
            return None
    except Exception:
        logger.exception("TOTP attempt counter unavailable")
        return None


def clear_totp_attempt(scope, identifier):
    """Best-effort reset after a successful credential issuance."""
    try:
        cache.delete(_totp_attempt_key(scope, identifier))
    except Exception:
        # The successful TOTP already proved the factor; cleanup failure must
        # not turn a valid login into a 500. The next bounded window expires it.
        logger.warning("TOTP attempt counter cleanup unavailable", exc_info=True)
