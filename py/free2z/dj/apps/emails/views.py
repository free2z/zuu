import hashlib
import logging
import re
import secrets
import threading
from collections import namedtuple
from datetime import timedelta
from urllib.parse import quote

from django.utils import timezone
from django.core.mail import EmailMultiAlternatives
from django.http import HttpResponse, HttpResponseRedirect
from django.template.loader import render_to_string
from django.shortcuts import redirect, render
from django.contrib.auth import authenticate, login
from django.core.mail import send_mail
from django.conf import settings
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.contrib.auth.password_validation import validate_password
from django.db import IntegrityError, transaction
from django.db.models import F

from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from rest_framework.request import Request
from rest_framework.permissions import AllowAny, IsAuthenticated

from dj.free2z.throttling import (
    ACCOUNT_RECOVERY_THROTTLES, LINK_LANDING_THROTTLES,
)
from dj.apps.emails.backends import delivery_outcome_unknown
from dj.apps.g12f.models import Creator
from dj.apps.identity.auth_context import require_recent_auth, RecentAuthenticationRequired
from dj.apps.identity.auth_context import AMR_PASSWORD, record_login
from dj.apps.ktauth.epoch import (
    EVENT_PASSWORD_CHANGE,
    EVENT_PASSWORD_RESET,
    EVENT_RECOVERY_ADDRESS_CHANGE,
    bump_account_epoch,
)
from dj.apps.otp.utils import (
    INVALID_OTP_TOKEN_MESSAGE,
    TOTP_ATTEMPT_LIMIT,
    TOTP_ATTEMPT_TTL_SECONDS,
    claim_totp_attempt,
    clear_totp_attempt,
    check_user_totp,
    has_active_totp,
)

from .link_origin import get_email_link_origin
from .sender import get_email_sender
from .models import Email, OptOutEmail, PasswordResetToken
from .serializers import EmailSerializer, ChangePasswordSerializer
from .confirmation_limits import (
    USER_LIMITED as CONFIRMATION_MAIL_USER_LIMITED,
    RECIPIENT_LIMITED as CONFIRMATION_MAIL_RECIPIENT_LIMITED,
    ConfirmationMailThrottled,
    ConfirmationMailAdmissionUnavailable,
    claim_confirmation_account_attempt,
    claim_confirmation_recipient,
    release_confirmation_recipient,
)

logger = logging.getLogger(__name__)

RESET_EMAIL_LIMIT = 3
RESET_EMAIL_PERIOD_SECONDS = 86400
PASSWORD_RESET_MFA_ATTEMPT_LIMIT = 5
PASSWORD_RESET_MFA_ATTEMPT_TTL_SECONDS = 86400


class ConfirmationMailErrorSerializer(serializers.Serializer):
    detail = serializers.CharField()


class AddEmailResponseSerializer(serializers.Serializer):
    email = serializers.EmailField()
    confirmed_at = serializers.DateTimeField(allow_null=True)


class AddEmailValidationErrorSerializer(serializers.Serializer):
    email = serializers.ListField(child=serializers.CharField(), required=False)

_RESET_EMAIL_CLAIM_SCRIPT = """
local current = redis.call('GET', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
current = tonumber(current)
if not current or ttl < 0 then
    redis.call('SET', KEYS[1], 1, 'PX', ARGV[1])
    return 1
end
if current >= tonumber(ARGV[2]) then
    return 0
end
redis.call('INCR', KEYS[1])
return 1
"""

_RESET_EMAIL_REFUND_SCRIPT = """
local current = redis.call('GET', KEYS[1])
if not current then
    return 0
end
local ttl = redis.call('PTTL', KEYS[1])
current = tonumber(current)
if not current or current <= 0 or ttl < 0 then
    redis.call('DEL', KEYS[1])
    return 0
end
return redis.call('DECR', KEYS[1])
"""

# The production backend is Redis, where the refund uses the Lua script above.
# Keep a process-local guard for the non-Redis development/test backends so the
# fallback's get/decr pair cannot race with another thread in this process.
_RESET_EMAIL_REFUND_LOCK = threading.Lock()

# Keep an ambiguous Redis result distinct from a confirmed quota claim: it must
# never be "refunded", since doing so could decrement somebody else's valid
# claim. Issuance falls back to counting durable reset-token rows while holding
# the account lock, so a cache outage does not remove the per-address ceiling.
_UNTRACKED_RESET_EMAIL_QUOTA = object()


def calculate_expiration():
    # Set the expiration time to 1 hour from now
    return timezone.now() + timedelta(hours=1)


def generate_token():
    # Generate a secure random token
    return secrets.token_urlsafe(64)


#The exact body an RFC 8058 mail client POSTs to a List-Unsubscribe URL.
ONE_CLICK_FIELD = 'List-Unsubscribe'
ONE_CLICK_VALUE = 'One-Click'

CONFIRM_LANDING_TEMPLATE = 'emails/confirm_landing.html'
OPT_OUT_LANDING_TEMPLATE = 'emails/opt_out_landing.html'


def build_confirm_url(email_instance):
    """Absolute confirmation-landing URL for an outgoing message.

    The origin is configuration (``get_email_link_origin``), never the
    request's ``Host`` header — see ``link_origin`` and. These functions
    deliberately take **no host argument**: there is no parameter for a caller
    to accidentally wire back up to ``request.get_host()``.
    """
    return (
        f"{get_email_link_origin()}/api/emails/confirm"
        f"?token={quote(email_instance.token, safe='')}"
    )


#The legacy shape -- ``/api/emails/opt-out/<address>?token=<token>`` -- is
#still accepted, and must stay accepted until at least this date.
#
#Every message sent before the switch carries that URL, and it is sitting in
#inboxes right now. Dropping it turns those links into 404s, which means the
#recipient cannot unsubscribe by clicking -- a one-click-unsubscribe
#(RFC 8058) and CAN-SPAM problem, and a strictly worse bug than the one this
#change fixes. A year is chosen because mail is kept and re-read on an annual
#cycle at the outside, and because the compatibility branch is ten lines that
#cost nothing to keep. Removing it is a deliberate PR, tracked separately;
#nothing here fails the gate on the date, because a time bomb in CI breaks
#everyone's build for a cleanup nobody scheduled.
OPT_OUT_LEGACY_URL_SUPPORTED_UNTIL = '2027-08-18'

#ROLLOUT NOTE, for whoever changes this URL shape next (codex review, ).
#
#The compatibility window above runs one way only. Old links keep working on
#new pods; NEW links do not work on old pods, and a rolling update runs both
#at once. During the minutes a deploy takes, a message sent by a new replica
#carries a token-only URL that an old replica answers with a 404.
#
#Accepted here, deliberately, because the exposure is small and self-healing:
#the recipient must click the *unsubscribe* link (not the confirmation one)
#inside the rollout window AND be balanced onto an old replica, and the link
#is not damaged -- the same URL works once the rollout finishes. The 404 page
#also tells them to reply to any message.
#
#A bigger or more permanent shape change should not copy this. The
#zero-window shape is two releases: teach every replica to ACCEPT the new
#form first, then a second release that starts EMITTING it. That is cheap
#when planned and impossible to retrofit once the emitting code is live.
#
#The derived credential (`opt_out_link_token`) is the same size of change and
#takes the same small window: a link a new replica mails during the rollout
#is a 404 on an old replica until the rollout finishes, and then works. Every
#link mailed before it keeps working on both.


#Domain separation for the unsubscribe credential (see `opt_out_link_token`).
_OPT_OUT_LINK_PURPOSE = b'free2z/emails/opt-out-link/v1\x00'
#`<Email.pk>-<64 hex>`: at most 84 characters, so never an 86-character
#`secrets.token_urlsafe(64)` value. A candidate that matches the shape but no
#row's digest simply falls through to the older readings.
_OPT_OUT_LINK_SHAPE = re.compile(r'([1-9][0-9]{0,18})-([0-9a-f]{64})')
_MAX_EMAIL_PK = 2 ** 63 - 1


def _opt_out_link_digest(pk, token):
    return hashlib.sha256(
        _OPT_OUT_LINK_PURPOSE + f'{pk}:{token}'.encode(),
    ).hexdigest()


def opt_out_link_token(email_instance):
    """The single opaque value an unsubscribe URL is built from.

    ``<row id>-<sha256(purpose, row id, Email.token)>``. It is a credential of
    its own, derived from ``Email.token`` but not equal to it: the
    unsubscribe URL travels in a ``List-Unsubscribe`` header and through
    whatever sees an unsubscribe click, and ``Email.token`` is also the
    address's confirmation credential, so the URL must not carry it. The
    digest is one-way, so holding the link does not yield the token, and it is
    still bound to the token: rotating ``Email.token`` (a resend, a new
    address) invalidates every link minted before, exactly as before.

    Deliberately keyed on nothing but the token, not on ``SECRET_KEY``: the
    token is already 512 random bits nobody else holds, and a key rotation
    must not silently break every unsubscribe link sitting in an inbox.

    The row id is there only so the row can be found without storing the
    digest; it says nothing about the address. Deliberately NOT
    ``django.core.signing`` over ``{address, token}``: ``signing.dumps``
    authenticates without encrypting, so its first component decodes back to
    the address.
    """
    return f'{email_instance.pk}-{_opt_out_link_digest(email_instance.pk, email_instance.token)}'


def _resolve_derived_opt_out_link(link):
    """The ``Email`` row an ``opt_out_link_token`` value was minted from."""
    match = _OPT_OUT_LINK_SHAPE.fullmatch(link)
    if match is None or int(match[1]) > _MAX_EMAIL_PK:
        return None
    row = (
        Email.objects.filter(pk=int(match[1]))
        .exclude(token='')
        .values('email', 'token')
        .first()
    )
    if row is None:
        return None
    if not secrets.compare_digest(
        _opt_out_link_digest(int(match[1]), row['token']), match[2],
    ):
        return None
    return row


#What an unsubscribe URL resolved to. ``token_only`` distinguishes the two
#shapes for the handful of places that must behave differently. ``token`` is
#the row's ``Email.token`` the caller re-checks under lock; ``spent`` is what
#``OptOutEmail.link_token`` records so the same URL keeps resolving after the
#row is gone.
ResolvedOptOutLink = namedtuple(
    'ResolvedOptOutLink', 'email token token_only spent',
)


def resolve_opt_out_link(link, fallback_token):
    """Resolve any accepted URL shape to an address + token. Never raises.

    Current shape: ``link`` is ``opt_out_link_token``'s derived credential and
    the row is found by the id it carries, then checked against its digest.

    Earlier token-only shape: ``link`` is the row's ``Email.token`` itself.
    Every message sent before the derived credential carries one of these, so
    it keeps resolving for the same window as the legacy shape below
    (``OPT_OUT_LEGACY_URL_SUPPORTED_UNTIL``). No new message emits it.

    Either way the address is looked up from live ``Email`` rows first, then
    among the spent links recorded on ``OptOutEmail``. That second lookup is
    not a nicety. The write deletes the ``Email`` row, so without it a link
    stops resolving the moment it is used, and both the post-unsubscribe
    redirect and a replayed RFC 8058 one-click POST -- which mail providers do
    send, and which must stay a success -- would answer 404.

    Legacy shape: ``link`` is the address itself (Django has already
    percent-decoded the path segment) and the token arrived separately, in the
    query string or the POST body. An unrecognised value falls through to this
    reading rather than being rejected, because the caller still has to match
    ``(address, token)`` against a real row before anything happens; refusing
    here would only turn every already-delivered link into an error.
    """
    derived = _resolve_derived_opt_out_link(link)
    if derived is not None:
        return ResolvedOptOutLink(
            derived['email'], derived['token'], token_only=True, spent=link,
        )

    live = Email.objects.filter(token=link).exclude(token='').values_list(
        'email', flat=True).first()
    if live is not None:
        return ResolvedOptOutLink(live, link, token_only=True, spent=link)

    spent = OptOutEmail.objects.filter(link_token=link).values_list(
        'email', flat=True).first()
    if spent is not None:
        # The address is already on the do-not-email list, so every caller
        # short-circuits on that before the token is used for anything.
        return ResolvedOptOutLink(spent, link, token_only=True, spent=link)

    return ResolvedOptOutLink(
        link, fallback_token, token_only=False, spent=fallback_token,
    )


def build_opt_out_url(email_instance):
    """Absolute unsubscribe-landing URL for an outgoing message.

    Origin from configuration, as in ``build_confirm_url``.

    Token-only since. The address used to be a path segment, which had
    to be percent-encoded and *still* could not be routed when the local part
    contained ``/`` -- legal under RFC 5321, and a permanent 404 on the
    unsubscribe link for anyone who has one. It was redundant either way: the
    token is the credential, and the view has to look the row up by token
    regardless. Keeping the address out of the URL also keeps it out of access
    logs, ``Referer`` headers and any analytics that sees the landing page.

    The token itself is still in the URL, and has to be -- an emailed
    one-click link has nowhere else to put a credential. What changed is that
    the URL no longer *also* names the person.

    ``quote(safe='')`` is belt and braces: ``secrets.token_urlsafe`` already
    emits only ``[A-Za-z0-9_-]``, so a future change to how the token is
    generated cannot silently start emitting a link that does not route.
    """
    return (
        f"{get_email_link_origin()}/api/emails/opt-out/"
        f"{quote(opt_out_link_token(email_instance), safe='')}"
    )


def unsubscribe_headers(opt_out_url):
    """RFC 2369 + RFC 8058 headers for a message carrying an opt-out link.

    ``List-Unsubscribe-Post`` is the whole point: it promises the mail client
    that a **POST** to that URL unsubscribes, so Gmail/Yahoo's one-click
    button, and any scanner that honours the pair, stop treating the URL as a
    GET to prefetch. The confirmation template already shows the same link in
    the body; the headers give well-behaved clients a way to use it that
    cannot unsubscribe somebody who never clicked.

    NOT for account-recovery mail -- see ``send_password_reset_email``.
    """
    return {
        'List-Unsubscribe': f'<{opt_out_url}>',
        'List-Unsubscribe-Post': f'{ONE_CLICK_FIELD}={ONE_CLICK_VALUE}',
    }


def _private_response(response):
    """These URLs carry a credential and describe one account."""
    response['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response['X-Robots-Tag'] = 'noindex, nofollow'
    return response


def _render_landing(request, template_name, context, status_code=200):
    """A landing page for a link we mailed. Renders; never writes.

    Returns a plain ``HttpResponse`` rather than a DRF ``Response`` on
    purpose: these are pages for a human in a browser, and the project's
    default renderers would otherwise negotiate a browser's ``Accept:
    text/html`` into DRF's Browsable API chrome.
    """
    return _private_response(
        render(request, template_name, context, status=status_code)
    )


def _posted_token(request):
    """The link token from the POST body, falling back to the query string.

    Body first: that is where the landing page's form puts it, and where a
    credential belongs. The query fallback exists for two callers and no
    others -- RFC 8058 one-click unsubscribe, where the provider POSTs a fixed
    body to the URL we published in ``List-Unsubscribe`` so the token can only
    travel in that URL, and anything that already scripted the old query-string
    shape.
    """
    data = request.data if hasattr(request.data, 'get') else {}
    token = data.get('token') or request.query_params.get('token')
    return token if isinstance(token, str) and token else None


def _is_one_click_unsubscribe(request):
    """True for the fixed body an RFC 8058 client sends (and nothing else)."""
    data = request.data if hasattr(request.data, 'get') else {}
    return data.get(ONE_CLICK_FIELD) == ONE_CLICK_VALUE


class SeeOtherRedirect(HttpResponseRedirect):
    """303, so a completed POST is followed with a GET and survives reload."""

    status_code = 303


#Documented once; both link landings share it.
LINK_TOKEN_PARAMETER = OpenApiParameter(
    name='token',
    type=str,
    location=OpenApiParameter.QUERY,
    required=True,
    description=(
        'The single credential for this operation: the per-address token '
        'from the link we emailed.'
    ),
)

#The unsubscribe URL's only path segment. Two accepted shapes, one route.
OPT_OUT_LINK_PARAMETER = OpenApiParameter(
    name='link',
    type=str,
    location=OpenApiParameter.PATH,
    required=True,
    description=(
        'The opaque unsubscribe link token from the message we sent, and the '
        'only credential this operation needs. It is derived one-way from the '
        'per-address token, so it cannot be used to confirm the address; it '
        'is unguessable and carries no information about the address, so the '
        'address never appears in the URL. Links in older messages carry the '
        'per-address token itself here, and keep working.\n\n'
        'DEPRECATED SHAPE, still accepted: legacy messages put the '
        'URL-encoded **email address** in this position and the token in the '
        '`token` query parameter. Those links keep working — they are sitting '
        'in inboxes — and are read as the address whenever the value is not a '
        'valid signed token. Do not build new links in that shape: an address '
        'whose local part contains `/` cannot be routed at all.'
    ),
)

#The query-string token, which only a legacy link needs.
OPT_OUT_LEGACY_TOKEN_PARAMETER = OpenApiParameter(
    name='token',
    type=str,
    location=OpenApiParameter.QUERY,
    required=False,
    description=(
        'Legacy links only: the per-address token, which the deprecated URL '
        'shape carries here instead of in the path. Ignored when the path '
        'segment is a link token.'
    ),
)


def send_confirmation_email(email_instance):
    if OptOutEmail.objects.filter(email=email_instance.email).exists():
        # No address in the line: the log is not where the list is kept.
        logger.info("confirmation_email_suppressed_opt_out")
        return False

    confirmation_url = build_confirm_url(email_instance)
    opt_out_url = build_opt_out_url(email_instance)
    context = {
        'confirmation_url': confirmation_url,
        'opt_out_url': opt_out_url,
        'username': email_instance.user.username,
    }

    email_subject = 'Free2Z Email Confirmation'
    # email_body = render_to_string('emails/email_confirmation.html', context)
    html_email_body = render_to_string('emails/email_confirmation.html', context)
    text_email_body = render_to_string('emails/email_confirmation.txt', context)

    email = EmailMultiAlternatives(
        email_subject,
        text_email_body,
        # One configured sender for every message we send, and it must stay
        # inside the domain SendGrid signs for.
        get_email_sender(),
        [email_instance.email],
        headers=unsubscribe_headers(opt_out_url),
    )
    # email.content_subtype = 'html'  # This is important to send HTML email
    email.attach_alternative(html_email_body, "text/html")
    accepted = email.send()
    if not accepted:
        raise RuntimeError("Confirmation email backend accepted no messages")
    return True


def _release_reset_email_quota(email_address):
    cache_key = f"reset_email_count_v2_{email_address}"

    # django-redis exposes the underlying Redis connection through
    # ``cache.client``. Check the value and decrement in one server-side
    # operation: a plain Redis DECR on an expired/missing key creates ``-1``
    # without a TTL, which would permanently poison this address's quota.
    try:
        redis_client = cache.client.get_client(write=True)
        redis_key = cache.make_key(cache_key)
        redis_client.eval(_RESET_EMAIL_REFUND_SCRIPT, 1, redis_key)
        return
    except (AttributeError, NotImplementedError):
        # LocMemCache and other non-Redis backends have no script interface.
        pass
    except Exception:
        # The script may have run even when its response was lost. Falling back
        # to a second get/decr sequence could therefore refund twice. Leave the
        # claim in place on this ambiguous failure; it expires with the key.
        return

    with _RESET_EMAIL_REFUND_LOCK:
        try:
            current = cache.get(cache_key)
            if current is None:
                return
            if current <= 0:
                cache.delete(cache_key)
                return
            cache.decr(cache_key)
        except (TypeError, ValueError):
            # Missing/expired keys and non-integer legacy values need no
            # cleanup. In particular, never issue DECR after a missing GET.
            return


def _spend_reset_email_quota(email_address):
    """Atomically claim one of the address's reset-email slots."""
    # V2 is intentionally an integer counter. The old key stores a dict and
    # cannot be incremented atomically. In production, one Redis script checks
    # the limit and claims a slot without extending the original TTL.
    cache_key = f"reset_email_count_v2_{email_address}"

    try:
        redis_client = cache.client.get_client(write=True)
        redis_key = cache.make_key(cache_key)
        claimed = redis_client.eval(
            _RESET_EMAIL_CLAIM_SCRIPT,
            1,
            redis_key,
            RESET_EMAIL_PERIOD_SECONDS * 1000,
            RESET_EMAIL_LIMIT,
        )
        return bool(claimed)
    except (AttributeError, NotImplementedError):
        # LocMemCache and other non-Redis development/test backends use the
        # atomic cache primitives below.
        pass
    except Exception:
        # The script may have claimed a slot before the connection lost its
        # response. Allow recovery, but mark the claim as ambiguous so a later
        # delivery failure cannot decrement another request's valid claim.
        return _UNTRACKED_RESET_EMAIL_QUOTA

    try:
        if cache.add(cache_key, 1, timeout=RESET_EMAIL_PERIOD_SECONDS):
            return True
        count = cache.incr(cache_key)
    except ValueError:
        # The key can expire between add() and incr(). Retry the atomic create;
        # if another request wins that race, its count is the first slot.
        try:
            if cache.add(cache_key, 1, timeout=RESET_EMAIL_PERIOD_SECONDS):
                return True
            count = cache.incr(cache_key)
        except ValueError:
            return _UNTRACKED_RESET_EMAIL_QUOTA
        except Exception:
            return _UNTRACKED_RESET_EMAIL_QUOTA
    except Exception:
        return _UNTRACKED_RESET_EMAIL_QUOTA
    # django-redis returns None when configured to ignore a cache outage. Keep
    # account recovery available in that degraded mode; DRF throttling remains.
    if count is None:
        return _UNTRACKED_RESET_EMAIL_QUOTA
    if count <= RESET_EMAIL_LIMIT:
        return True
    # A denied attempt must not permanently consume a slot; otherwise a burst
    # of blocked retries would drive the counter far above the limit and a
    # later delivery failure could not refund its claim.
    _release_reset_email_quota(email_address)
    return False


def send_password_reset_email(email_instance):
    if OptOutEmail.objects.filter(email=email_instance.email).exists():
        logger.info("password_reset_email_suppressed_opt_out")
        return

    # This is the issuance epoch. Capture it before any possible wait on the
    # account lock; if a reset/password change commits before issuance obtains
    # that lock, the hash changes and this stale request must not mint a new
    # post-reset credential.
    loaded_password = email_instance.user.password

    # AtomicMiddleware leaves this endpoint outside its blanket POST
    # transaction. The view path is therefore the outermost transaction: the
    # token row and quota claim commit before template/SMTP work begins, so the
    # account lock is not held while the mail provider is contacted. Keeping a
    # normal atomic block also lets direct maintenance/test callers nest this
    # helper without Django's durable-transaction guard raising.
    quota_claimed = False
    reset_token = None
    try:
        with transaction.atomic():
            current_user = Creator.objects.select_for_update().only('password').get(
                pk=email_instance.user_id
            )
            if not secrets.compare_digest(current_user.password, loaded_password):
                return
            try:
                # RequestResetPasswordView resolved this row before the account
                # lock. Re-lock and re-check the recovery identity so an email
                # address change cannot leave us sending a fresh credential to
                # the old mailbox.
                email_instance = Email.objects.select_for_update().get(
                    pk=email_instance.pk,
                    user_id=current_user.pk,
                    email=email_instance.email,
                    confirmed_at__isnull=False,
                )
            except Email.DoesNotExist:
                return
            quota_claim = _spend_reset_email_quota(email_instance.email)
            if quota_claim is False:
                logger.info("password_reset_email_quota_exhausted")
                return
            if quota_claim is _UNTRACKED_RESET_EMAIL_QUOTA:
                # Redis may be unavailable or may have executed without
                # returning its result. The Creator lock serializes this
                # durable fallback with every other issuance for the account,
                # while failed deliveries delete their unused token rows.
                period_start = timezone.now() - timedelta(
                    seconds=RESET_EMAIL_PERIOD_SECONDS
                )
                issued = PasswordResetToken.objects.filter(
                    email_id=email_instance.pk,
                    created_at__gte=period_start,
                ).count()
                if issued >= RESET_EMAIL_LIMIT:
                    logger.info("password_reset_email_quota_exhausted")
                    return
            # Only a confirmed claim is safe to compensate. An ambiguous
            # claim may or may not exist in Redis; its durable fallback needs
            # no cache compensation.
            quota_claimed = quota_claim is True
            reset_token = PasswordResetToken.objects.create(email=email_instance)
        # Count only attempts that made it through identity, opt-out, quota,
        # and token issuance. This avoids treating unknown or intentionally
        # suppressed addresses as failed delivery.
        logger.info("password_reset_delivery_attempt")
    except Exception:
        # A failed INSERT or transaction commit leaves no deliverable token,
        # but the cache claim happened before the INSERT. Compensate it.
        token_discarded = (
            reset_token is None or _discard_unused_reset_token(reset_token)
        )
        if quota_claimed and token_discarded:
            _release_reset_email_quota(email_instance.email)
        raise

    try:
        # Origin from configuration, never request.get_host(). If it
        # is misconfigured this raises here, inside the try, so the undelivered
        # token is retracted and its quota refunded exactly as a provider
        # failure would be -- a loud, logged failure that strands nobody.
        reset_link = (
            f"{get_email_link_origin()}/reset-password"
            f"?token={reset_token.token}"
        )
        opt_out_url = build_opt_out_url(email_instance)
        context = {
            'reset_url': reset_link,
            'opt_out_url': opt_out_url,
            'username': email_instance.user.username,  # Adjust as per your user model
        }
        email_subject = 'Free2Z Password Reset Request'
        # email_body = render_to_string('emails/email_password_reset.html', context)
        html_email_body = render_to_string('emails/email_password_reset.html', context)
        text_email_body = render_to_string('emails/email_password_reset.txt', context)

        # DELIBERATELY NO List-Unsubscribe HEADERS ON THIS MESSAGE.
        # The codex review of  caught this: unsubscribing deletes the
        # Email row, which cascades the reset token away and puts the address
        # on the do-not-email list, so a mail client's one-click Unsubscribe
        # button sitting next to a password-reset mail is a warning-free
        # ACCOUNT LOCKOUT control -- offered to exactly the person who has
        # already lost their password and therefore cannot follow the landing
        # page's "sign in and add the address again" advice. RFC 8058 and the
        # provider requirements behind it are about subscription mail; account
        # recovery is not that. The visible in-body link stays (it predates
        # this change, takes a deliberate click, and now lands on a page that
        # spells out the consequence); it is only the client-rendered button
        # we decline to advertise here.
        email = EmailMultiAlternatives(
            email_subject,
            text_email_body,
            # Sender from configuration, like the origin above: a
            # From domain outside the one SendGrid signs for is not
            # DMARC-aligned, and fails by silently not arriving. Raising here
            # is deliberate -- it is inside the same try, so the undelivered
            # token is retracted and its quota refunded.
            get_email_sender(),
            [email_instance.email],
            # STILL DELIBERATELY NO headers= ON THIS MESSAGE: see above.
        )
        # email.content_subtype = 'html'  # Important for HTML email
        email.attach_alternative(html_email_body, "text/html")
        accepted = email.send()
        if not accepted:
            # Django's mail API can return zero when a backend silently
            # declines the message. Do not count that as provider acceptance;
            # propagate through the existing token/quota compensation path.
            raise RuntimeError("Password reset email backend accepted no messages")
        # Provider acceptance only; this does not claim inbox delivery.
        logger.info("password_reset_delivery_sent")
    except Exception as exc:
        #the send is now time-bounded, so a response that stalls
        # after SendGrid accepted the message surfaces here as a read timeout.
        # That mail may still arrive; retracting its token would hand the user
        # a dead link and refunding the quota would let delivered mail escape
        # the per-address cap. Keep both and propagate to the view's logger.
        if delivery_outcome_unknown(exc):
            logger.warning(
                "password_reset_email_outcome_unknown: %s; token kept",
                type(exc).__name__,
            )
            raise
        # RequestResetPasswordView deliberately hides provider failures to
        # avoid account enumeration. Do not let that safety property strand a
        # real user for 24 hours: retract the undelivered credential and refund
        # its atomic quota claim before propagating to the view's logger.
        token_discarded = _discard_unused_reset_token(reset_token)
        if quota_claimed and token_discarded:
            _release_reset_email_quota(email_instance.email)
        raise
    return True


def _discard_unused_reset_token(reset_token):
    """Delete an unredeemed token, returning whether it is gone.

    The normal path is one committed row followed by a delivery failure. The
    second branch handles an ambiguous DB commit: if the row was rolled back,
    it is already gone and the quota can still be refunded. A concurrently
    redeemed token is deliberately not refunded.
    """
    try:
        with transaction.atomic():
            deleted, _ = PasswordResetToken.objects.filter(
                pk=reset_token.pk,
                used=False,
            ).delete()
            if deleted:
                return True
            return not PasswordResetToken.objects.filter(
                pk=reset_token.pk,
            ).exists()
    except Exception:
        logger.exception("Could not compensate failed password-reset issuance")
        return False


class PasswordIsSetView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request:Request, *args, **kwargs):
        user = request.user
        return Response({'password_set': user.password_set}, status=status.HTTP_200_OK)


#``next_step`` values for ``RecoveryStatusView``. Named constants because
#the front end branches on them and a typo would branch on nothing.
RECOVERY_NEXT_STEP_ADD_EMAIL = 'add_email'
RECOVERY_NEXT_STEP_CONFIRM_EMAIL = 'confirm_email'
RECOVERY_NEXT_STEP_RESEND_EMAIL = 'resend_email'
RECOVERY_NEXT_STEP_REPLACE_EMAIL = 'replace_email'

#``risk`` values for ``RecoveryStatusView``.
RECOVERY_RISK_NONE = 'none'
RECOVERY_RISK_NO_RECOVERY = 'no_recovery'
RECOVERY_RISK_NO_CREDENTIALS = 'no_credentials'


class RecoveryStatusView(APIView):
    """Can the *caller's own* account be recovered, and if not, what is missing?

    Issue. 1,676 of 1,766 production accounts (95%) have no ``Email`` row
    at all, and 137 of those also carry an unusable (``!``) password -- an X
    link was their only door, and when it broke they had no way back in.
    ``RequestResetPasswordView`` is not at fault: it looks up
    ``Email.objects.get(email=..., confirmed_at__isnull=False)``, finds
    nothing, and returns its anti-enumeration generic 200 without sending. That
    200 is correct and stays. What was missing is that **nothing ever told the
    account holder they had no way back**, so nobody was ever prompted to fix
    it.

    Every capability needed to fix it already existed for an authenticated
    caller -- ``AddEmailView``, ``ResendEmailView``, ``ConfirmEmailView`` and
    ``ChangePasswordView`` (whose serializer already waives ``old_password``
    for an account with an unusable one). This view adds the one thing that did
    not: a single authoritative answer to "does this account have a recovery
    path", so the prompt can exist and so the *rule* for what counts as
    recovery lives on the server rather than being re-derived by each client.

    What counts as recovery
    -----------------------

    **A confirmed email address that we are still allowed to mail.** Nothing
    else. Specifically:

    * A *password* is a door, not a recovery method -- forgetting it is the
      failure this is about.
    * A linked social identity is a door too, and  is the proof that a
      door can break.
    * A confirmed address is sufficient *on its own* even for an account with
      an unusable password, because ``ResetPasswordAPIView`` sets a brand-new
      one; that is why ``can_recover`` does not require ``password_set``.
    * An address on the ``OptOutEmail`` list is **not** a recovery method:
      ``send_password_reset_email`` and ``send_confirmation_email`` both return
      early for one, silently. For a *confirmed* address that gets its own
      flag rather than being folded into anything else. For an unconfirmed
      one it cannot: the caller has not shown the mailbox is theirs, so the
      list's contents are not theirs to read, and the address is reported as
      pending like any other. Such an account sits "pending" with no mail
      arriving; telling the account holder why needs a proof-of-control
      route, not this flag.

    Anti-enumeration
    ----------------

    ``IsAuthenticated``, ``GET`` only, and it reads **no** request input at
    all: not a query parameter, not a body, not a header. It can only ever
    describe ``request.user``, so there is no shape of request that asks it
    about a third party. It deliberately does not return the address itself
    (``EmailStatusView`` already does, for the settings screen) -- keeping the
    payload to booleans means this endpoint adds no new disclosure even if it
    is later reached by a lower-trust caller. Unauthenticated callers get the
    project's standard 401, identical for everyone, which reveals nothing.

    Both status endpoints preserve an unconfirmed address and report pending
    user action independently of confirmation delivery, token expiry and the
    credential epoch. An expired or revoked link needs a resend, but exposing
    that distinction would disclose shared recipient-quota admission through
    another account's Gmail alias. Confirmation itself still requires a live,
    epoch-current token; a suppressed resend never repairs its credentials.

    The operator-side half of  -- how to find and rescue an account that is
    already locked out -- is ``docs/runbooks/account-recovery.md`` and
    ``manage.py recovery_census``, which classifies by this same rule on
    purpose.
    """

    permission_classes = [IsAuthenticated]

    # `description=` deliberately overrides the docstring. drf-spectacular
    # publishes a view's docstring into `f2z.yaml` verbatim, and this one is an
    # internal design record -- production account counts, issue numbers, the
    # reasoning about which other view is wrong. The generated client and the
    # published contract get the contract; the rationale stays in the source.
    @extend_schema(
        summary="Whether the calling account has a working recovery path.",
        description=(
            "Reports, for the authenticated caller and nobody else, whether "
            "this account could get back in after losing access -- and if "
            "not, the single next action that would fix it.\n\n"
            "A confirmed email address that is not on the opt-out list is the "
            "only recovery method. A password is a way IN, not a way BACK, "
            "and is never part of `can_recover`; conversely a confirmed "
            "address is enough on its own, because the reset flow sets a new "
            "password.\n\n"
            "Takes no parameters of any kind: it always describes the "
            "credential-bearing caller, so it cannot be aimed at another "
            "account. Returns no email address."
        ),
        responses=inline_serializer(
            name='RecoveryStatus',
            fields={
                'can_recover': serializers.BooleanField(
                    help_text=(
                        "True when a confirmed, mailable address exists, i.e. "
                        "when /api/emails/reset-password would actually send "
                        "this account a link. Necessary, and -- when "
                        "mfa_required is true -- not sufficient: see that "
                        "field."
                    ),
                ),
                'mfa_required': serializers.BooleanField(
                    help_text=(
                        "An active TOTP factor is enrolled, so redeeming a "
                        "reset link ALSO needs a current authenticator code. "
                        "can_recover cannot account for whether the user "
                        "still has that authenticator -- nothing can -- so a "
                        "client must surface this rather than implying the "
                        "emailed link is the whole story."
                    ),
                ),
                'email_on_file': serializers.BooleanField(
                    help_text=(
                        "An address row exists, in any state. Needed to tell "
                        "'you have no address' apart from 'you have one whose "
                        "confirmation link is dead'."
                    ),
                ),
                'email_confirmed': serializers.BooleanField(
                    help_text="A confirmed address is on file.",
                ),
                'email_pending': serializers.BooleanField(
                    help_text=(
                        "An unconfirmed address is on file and needs user "
                        "action. This does not reveal whether a "
                        "confirmation was sent, whether its token is live, or "
                        "whether the address can be mailed at all; use "
                        "`next_step: resend_email` for a safe retry."
                    ),
                ),
                'email_suppressed': serializers.BooleanField(
                    help_text=(
                        "The confirmed address on file is on the opt-out "
                        "list, so we send it nothing -- neither confirmations "
                        "nor reset links. Always false when no address is on "
                        "file or the address is unconfirmed: suppression is "
                        "reported only for an address the account has shown "
                        "it controls."
                    ),
                ),
                'password_set': serializers.BooleanField(
                    help_text=(
                        "The account has a usable password. Derived from the "
                        "stored hash (has_usable_password()), not from the "
                        "Creator.password_set flag that "
                        "/api/emails/password-is-set reports -- see the view "
                        "docstring for why those two can disagree."
                    ),
                ),
                'risk': serializers.ChoiceField(
                    choices=[
                        RECOVERY_RISK_NONE,
                        RECOVERY_RISK_NO_RECOVERY,
                        RECOVERY_RISK_NO_CREDENTIALS,
                    ],
                    help_text=(
                        "'none' when can_recover. Otherwise "
                        "'no_recovery' if a password still gets the user in, "
                        "and 'no_credentials' when there is no password "
                        "either -- a linked social identity is the only door "
                        "and nothing restores it."
                    ),
                ),
                'next_step': serializers.ChoiceField(
                    choices=[
                        RECOVERY_NEXT_STEP_ADD_EMAIL,
                        RECOVERY_NEXT_STEP_CONFIRM_EMAIL,
                        RECOVERY_NEXT_STEP_RESEND_EMAIL,
                        RECOVERY_NEXT_STEP_REPLACE_EMAIL,
                    ],
                    allow_null=True,
                    help_text=(
                        "The one action that would establish recovery, or "
                        "null when there is nothing to do. 'resend_email' "
                        "means an unconfirmed address is on file; POST "
                        "/api/emails/resend safely issues or refreshes its link "
                        "without revealing whether a prior message was sent. "
                        "'replace_email' means the confirmed address is on the "
                        "opt-out list, where resending sends nothing and only "
                        "a different address helps."
                    ),
                ),
            },
        ),
    )
    def get(self, request: Request, *args, **kwargs):
        email_instance = (
            Email.objects.filter(user_id=request.user.pk)
            .only('email', 'confirmed_at')
            .first()
        )

        email_on_file = email_instance is not None
        if email_instance is None:
            email_confirmed = False
            email_pending = False
            email_suppressed = False
        else:
            email_confirmed = email_instance.confirmed_at is not None
            # Do not expose whether the shared recipient quota allowed a
            # message: another account can attach a Gmail alias and read this
            # status. `email_pending` describes an unconfirmed address that
            # still needs user action, not delivery or token validity. A resend
            # is the same safe next step whether the prior link is live, stale,
            # or was never sent.
            #
            # Suppression is reported for a CONFIRMED address only. Any
            # account can put any address on file unconfirmed, so for one the
            # caller has not proven it controls, the opt-out list is a fact
            # about somebody else's mailbox and this view must not answer it.
            # An unconfirmed suppressed address therefore reads exactly like
            # any other unconfirmed address: pending, resend. The operator
            # census still classifies it truthfully.
            email_suppressed = email_confirmed and OptOutEmail.objects.filter(
                email=email_instance.email,
            ).exists()
            email_pending = not email_confirmed

        # The HASH, not the ``password_set`` flag. They are allowed to
        # disagree and on this platform they demonstrably do: g12f migration
        # 0081 backfilled the flag only for rows whose password was the empty
        # string, so an account made unusable BEFORE the column existed still
        # carries ``password_set=True`` over a ``!``-prefixed hash. The flag is
        # what ``/api/emails/password-is-set`` reports; the hash is what
        # ``ChangePasswordSerializer`` actually branches on when it decides
        # whether ``old_password`` is required. Reporting the flag here would
        # tell a user with no password that they have one and then demand an
        # old password they cannot produce -- a dead end inside the very
        # recovery flow this endpoint exists to unblock.
        password_set = request.user.has_usable_password()
        can_recover = email_confirmed and not email_suppressed

        if can_recover:
            risk = RECOVERY_RISK_NONE
            next_step = None
        else:
            risk = (
                RECOVERY_RISK_NO_RECOVERY
                if password_set
                else RECOVERY_RISK_NO_CREDENTIALS
            )
            if email_suppressed:
                # Resending is a no-op for a suppressed address, so pointing
                # the user at "resend" would be a dead end wearing a button.
                next_step = RECOVERY_NEXT_STEP_REPLACE_EMAIL
            elif email_on_file:
                # Resend is safe whether the link is live, expired, revoked by
                # an ownership event, or was not sent due to a shared quota.
                # `ResendEmailView` rotates the token AND restamps `token_epoch`
                # from `request.user`. Pointing at `add_email` instead would
                # make the user retype an address we already have.
                next_step = RECOVERY_NEXT_STEP_RESEND_EMAIL
            else:
                next_step = RECOVERY_NEXT_STEP_ADD_EMAIL

        return Response({
            'can_recover': can_recover,
            # `ResetPasswordAPIView._verify_reset_totp` demands a current code
            # from an enrolled account, and so do `ChangePasswordView` and the
            # login serializer. An emailed link is therefore only half the
            # story for these users, and `risk: none` on its own reads as
            # "you are fine" to somebody who has lost their authenticator
            # (codex adversarial review, round 2). Reported, never folded into
            # `can_recover`: whether the factor is still in the user's hands
            # is not a fact this server holds.
            'mfa_required': has_active_totp(request.user),
            'email_on_file': email_on_file,
            'email_confirmed': email_confirmed,
            'email_pending': email_pending,
            'email_suppressed': email_suppressed,
            'password_set': password_set,
            'risk': risk,
            'next_step': next_step,
        }, status=status.HTTP_200_OK)


class ResendEmailView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        responses={
            status.HTTP_204_NO_CONTENT: OpenApiResponse(
                description="Confirmation request accepted; no response body."
            ),
            status.HTTP_404_NOT_FOUND: ConfirmationMailErrorSerializer,
            status.HTTP_401_UNAUTHORIZED: ConfirmationMailErrorSerializer,
            status.HTTP_403_FORBIDDEN: ConfirmationMailErrorSerializer,
            status.HTTP_429_TOO_MANY_REQUESTS: ConfirmationMailErrorSerializer,
            status.HTTP_503_SERVICE_UNAVAILABLE: ConfirmationMailErrorSerializer,
        },
    )
    def post(self, request:Request, *args, **kwargs):
        user = request.user
        if not user.is_authenticated:
            return Response(
                {"detail": "User not authenticated."},
                status=status.HTTP_401_UNAUTHORIZED
            )

        recipient_claim_id = None
        try:
            with transaction.atomic():
                try:
                    locked_user = Creator.objects.select_for_update().only('pk').get(
                        pk=user.pk
                    )
                    email_instance = Email.objects.select_for_update().get(
                        user_id=locked_user.pk
                    )
                except (Creator.DoesNotExist, Email.DoesNotExist):
                    return Response(
                        {"detail": "No email address found for this user."},
                        status=status.HTTP_404_NOT_FOUND
                    )

                # one every 5 minutes; the row is locked before this decision
                # and before rotating the token, so AddEmail cannot be
                # overwritten by a stale resend object.
                resend_threshold = timezone.now() - timedelta(minutes=5)
                if email_instance.updated_at > resend_threshold:
                    return Response({
                        "detail": "Confirmation email recently sent. Please try again in a few minutes."
                    }, status=status.HTTP_429_TOO_MANY_REQUESTS)

                # Charge every otherwise valid resend attempt before recipient
                # suppression, so the account budget cannot disclose whether
                # the mailbox is opted out or has reached its shared ceiling.
                if claim_confirmation_account_attempt(locked_user.pk) == CONFIRMATION_MAIL_USER_LIMITED:
                    raise ConfirmationMailThrottled()

                # Check opt-out before token rotation so a no-mail resend does
                # not invalidate a live link. Record the same cooldown as a
                # send so an immediate retry cannot distinguish suppression.
                if OptOutEmail.objects.filter(email=email_instance.email).exists():
                    email_instance.save(update_fields=['updated_at'])
                    return Response(status=status.HTTP_204_NO_CONTENT)

                recipient_claim_id = secrets.token_urlsafe(18)
                if claim_confirmation_recipient(
                    email_instance.email, claim_id=recipient_claim_id,
                ) == CONFIRMATION_MAIL_RECIPIENT_LIMITED:
                    recipient_claim_id = None
                    # This cap is shared across accounts. Keep the response
                    # indistinguishable from an ordinary resend so it reveals
                    # neither recent activity at nor suppression of this mailbox.
                    email_instance.save(update_fields=['updated_at'])
                    return Response(status=status.HTTP_204_NO_CONTENT)

                email_instance.token = generate_token()
                email_instance.expires_at = calculate_expiration()
                #. This route rotates the token but raises no ownership
                # event, so the stamp is simply the caller's own epoch.
                email_instance.token_epoch = request.user.kt_account_epoch
                email_instance.save(update_fields=[
                    'token', 'expires_at', 'token_epoch', 'updated_at',
                ])
        except Exception:
            if recipient_claim_id is not None:
                release_confirmation_recipient(email_instance.email, recipient_claim_id)
            raise

        # The middleware deliberately leaves this endpoint outside its blanket
        # transaction, so the account lock is released before SMTP work.
        try:
            accepted = send_confirmation_email(email_instance)
            if accepted is False and recipient_claim_id is not None:
                release_confirmation_recipient(email_instance.email, recipient_claim_id)
        except Exception as exc:
            if recipient_claim_id is not None and not delivery_outcome_unknown(exc):
                release_confirmation_recipient(email_instance.email, recipient_claim_id)
            raise
        return Response(status=status.HTTP_204_NO_CONTENT)


class AddEmailView(APIView):
    permission_classes = [IsAuthenticated]
    serializer_class = EmailSerializer

    @extend_schema(
        responses={
            status.HTTP_201_CREATED: AddEmailResponseSerializer,
            status.HTTP_400_BAD_REQUEST: AddEmailValidationErrorSerializer,
            status.HTTP_401_UNAUTHORIZED: ConfirmationMailErrorSerializer,
            status.HTTP_403_FORBIDDEN: ConfirmationMailErrorSerializer,
            status.HTTP_429_TOO_MANY_REQUESTS: ConfirmationMailErrorSerializer,
            status.HTTP_503_SERVICE_UNAVAILABLE: ConfirmationMailErrorSerializer,
        },
    )
    def post(self, request: Request, *args, **kwargs):
        serializer = EmailSerializer(data=request.data, context={'request': request})

        if serializer.is_valid():
            new_email = serializer.validated_data['email']
            recipient_claim_id = None
            try:
                with transaction.atomic():
                    # Reset issuance, redemption, password changes, and recovery
                    # address changes all serialize account-first. If issuance
                    # commits first, this change invalidates its token; if this
                    # change commits first, issuance's locked re-check rejects the
                    # stale address.
                    user = Creator.objects.select_for_update().get(pk=request.user.pk)
                    try:
                        email_instance = Email.objects.select_for_update().get(
                            user_id=user.pk
                        )
                        address_changed = email_instance.email != new_email
                        #, and it is narrower than `address_changed` on
                        # purpose (codex adversarial review). A *confirmed*
                        # address is a live recovery principal, and replacing it
                        # revokes that principal's standing ability to take the
                        # account. Replacing an address nobody has confirmed
                        # revokes nothing -- it was never a credential -- and
                        # counting it let an authenticated caller burn the log's
                        # 16-epoch A18b budget with seventeen typos.
                        recovery_revoked = (
                            address_changed
                            and email_instance.confirmed_at is not None
                        )
                    except Email.DoesNotExist:
                        email_instance = Email(user=user)
                        address_changed = True
                        # A first address ADDS a recovery principal. See
                        # `dj.apps.ktauth.epoch` for why additions do not count.
                        recovery_revoked = False

                    if address_changed:
                        try:
                            require_recent_auth(request)
                        except RecentAuthenticationRequired as exc:
                            return exc.response()

                    # Count every otherwise valid issuance attempt before any
                    # recipient-specific suppression. The account's own quota is
                    # therefore independent of whether this address can be mailed.
                    try:
                        account_limited = (
                            claim_confirmation_account_attempt(user.pk)
                            == CONFIRMATION_MAIL_USER_LIMITED
                        )
                    except ConfirmationMailAdmissionUnavailable:
                        if not recovery_revoked:
                            raise
                        # Redis is only a mail-admission dependency. It must
                        # not preserve a compromised recovery principal; the
                        # replacement is committed without an outbound mail.
                        account_limited = True
                    if account_limited and not recovery_revoked:
                        raise ConfirmationMailThrottled()

                    if not address_changed:
                        # The caller's own current address. Nothing to bind,
                        # and nothing to send: `ResendEmailView` is the route
                        # that issues a fresh link, with its own cooldown.
                        return Response(serializer.data, status=status.HTTP_201_CREATED)

                    # Only now -- after the recent sign-in and the caller's own
                    # attempt budget -- is anything about the requested address
                    # looked at. The caller has proven control of nothing yet,
                    # so another account's binding must not change the answer.
                    if not _release_stale_binding_elsewhere(new_email, user.pk):
                        return self._held_elsewhere(
                            serializer, user, email_instance, recovery_revoked,
                        )

                    # Suppression governs delivery, not removal of the old recovery
                    # principal. Otherwise another account can exhaust the owner's
                    # mailbox quota and prevent them undoing a recovery hijack.
                    send_allowed = (
                        not account_limited
                        and not OptOutEmail.objects.filter(email=new_email).exists()
                    )
                    if send_allowed:
                        recipient_claim_id = secrets.token_urlsafe(18)
                        try:
                            send_allowed = claim_confirmation_recipient(
                                new_email, claim_id=recipient_claim_id,
                            ) != CONFIRMATION_MAIL_RECIPIENT_LIMITED
                        except ConfirmationMailAdmissionUnavailable:
                            if not recovery_revoked:
                                raise
                            # Preserve owner control even during a Redis outage;
                            # the new address remains pending until a later resend.
                            send_allowed = False
                        if not send_allowed:
                            recipient_claim_id = None
                    email_instance.email = new_email
                    # Never transfer a link sent to the old mailbox to the new
                    # address. Suppressed replacements have no usable link until
                    # a later permitted resend; they do not mint an unmailed token.
                    email_instance.token = generate_token() if send_allowed else ""
                    # The confirmation window. The pending row itself outlives
                    # it -- nothing deletes it, and a later resend issues a fresh
                    # link and a fresh window -- but once the window has closed
                    # the row no longer reserves the address against another
                    # account (`_release_stale_binding_elsewhere`).
                    email_instance.expires_at = calculate_expiration()
                    #. The epoch this pending confirmation link is valid
                    # for. Taken from `request.user`, which authentication loaded
                    # from the same row that validated THIS caller's credential --
                    # not from the locked row read a moment ago. The difference
                    # matters: if a password change committed while this request
                    # was waiting on the account lock, the locked row already
                    # carries the new epoch, and stamping from it would mint a
                    # confirmation link for a session that has just been evicted.
                    # `+ 1` below because this request may itself be the ownership
                    # event, and the link it is about to MAIL must survive it --
                    # that is the ordering trap `_spend_outstanding_reset_tokens`
                    # records, and the reason the fix is a stamp rather than a
                    # rotation inside the bump.
                    issuing_epoch = request.user.kt_account_epoch
                    email_instance.confirmed_at = None
                    try:
                        # A savepoint, so a concurrent request that bound the
                        # same address between the check above and this write
                        # gets the same answer as one that bound it earlier.
                        with transaction.atomic():
                            email_instance.save()
                    except IntegrityError:
                        if recipient_claim_id is not None:
                            release_confirmation_recipient(new_email, recipient_claim_id)
                            recipient_claim_id = None
                        return self._held_elsewhere(
                            serializer,
                            user,
                            Email.objects.select_for_update().filter(
                                user_id=user.pk,
                            ).first() or Email(user=user),
                            recovery_revoked,
                        )

                    PasswordResetToken.objects.filter(
                        email_id=email_instance.pk,
                        used=False,
                    ).update(used=True)
                    if recovery_revoked:
                        # An account-ownership event: a confirmed recovery
                        # address just lost its standing ability to take the
                        # account. That is how a hijack is undone, and how a live
                        # session is converted into permanent control.
                        bump_account_epoch(
                            user.pk, event=EVENT_RECOVERY_ADDRESS_CHANGE
                        )
                        issuing_epoch += 1
                    # Written after the bump, in the same transaction, so the
                    # link that goes in the mail below is valid at the epoch this
                    # request leaves the account at -- and dead at every later one.
                    Email.objects.filter(pk=email_instance.pk).update(
                        token_epoch=issuing_epoch,
                    )
                    email_instance.token_epoch = issuing_epoch
            except Exception:
                if recipient_claim_id is not None:
                    release_confirmation_recipient(new_email, recipient_claim_id)
                raise
            if send_allowed:
                try:
                    accepted = send_confirmation_email(email_instance)
                    if accepted is False and recipient_claim_id is not None:
                        release_confirmation_recipient(new_email, recipient_claim_id)
                except Exception as exc:
                    if recipient_claim_id is not None and not delivery_outcome_unknown(exc):
                        release_confirmation_recipient(new_email, recipient_claim_id)
                    raise
            return Response(serializer.data, status=status.HTTP_201_CREATED)

        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    @staticmethod
    def _held_elsewhere(serializer, user, email_instance, recovery_revoked):
        """Answer a request for an address another account holds.

        The response is the one a successful request gets, and nothing is
        bound to the requested address or sent to it. The caller's previous
        address is still removed, exactly as a change removes it: a request to
        replace a recovery address must never leave the old one in place
        because of who holds the new one. Called inside the view's
        transaction, with the account row locked.
        """
        if email_instance.pk is not None:
            email_instance.delete()
        if recovery_revoked:
            bump_account_epoch(user.pk, event=EVENT_RECOVERY_ADDRESS_CHANGE)
        return Response(serializer.data, status=status.HTTP_201_CREATED)


def _release_stale_binding_elsewhere(address, user_id):
    """Whether ``address`` is free for ``user_id`` to bind.

    True when no other account holds it, or when the only holder is an
    unconfirmed binding whose confirmation window has closed -- that binding
    proved nothing about the mailbox, so it is removed rather than allowed to
    reserve the address indefinitely. A confirmed binding is never removed,
    nor is an unconfirmed one whose link may still be in use.

    ``skip_locked`` because the other account's writers lock their own
    account row first; waiting on their address row while holding ours could
    deadlock. A row somebody is writing right now is simply treated as held.
    """
    holder = (
        Email.objects.filter(email=address)
        .exclude(user_id=user_id)
        .values('pk', 'confirmed_at', 'expires_at')
        .first()
    )
    if holder is None:
        return True
    if holder['confirmed_at'] is not None or holder['expires_at'] >= timezone.now():
        return False
    stale = (
        Email.objects.select_for_update(skip_locked=True)
        .filter(
            pk=holder['pk'],
            email=address,
            confirmed_at__isnull=True,
            expires_at__lt=timezone.now(),
        )
        .first()
    )
    if stale is None:
        return False
    stale.delete()
    return True


class ConfirmEmailView(APIView):
    # Followed from an email link by a signed-out browser; the expiring token
    # in the link is the credential.
    # 'anon-link', not a credential scope: the arrival rate is set by mail
    # delivery, and a burst of confirmations must not eat the sign-in or
    # account-recovery budget.
    #
    # GET RENDERS, POST WRITES. Mail clients, corporate security
    # scanners and link-preview bots follow URLs in messages; a GET that wrote
    # confirmed a mailbox nobody had opened. The emailed URL is unchanged, so
    # every link already sitting in an inbox still lands here -- it now shows a
    # page with one button, and the button is the write.
    permission_classes = [AllowAny]
    throttle_classes = LINK_LANDING_THROTTLES

    @extend_schema(
        summary='Email-confirmation landing page. Changes nothing.',
        description=(
            'Renders the page the emailed confirmation link points at. This '
            'operation performs no write, so a prefetching mail client or '
            'security scanner cannot confirm an address. The page '
            'contains a form that POSTs to this same URL; that POST is what '
            'confirms.'
        ),
        parameters=[LINK_TOKEN_PARAMETER],
        responses={
            200: OpenApiResponse(
                description='HTML landing page with a confirm button.',
            ),
            400: OpenApiResponse(description='No token in the query string.'),
            404: OpenApiResponse(
                description='HTML page: the token is unknown or expired.',
            ),
        },
    )
    def get(self, request, *args, **kwargs):
        token = request.GET.get('token')
        if not token:
            return _render_landing(
                request, CONFIRM_LANDING_TEMPLATE, {'state': 'missing'}, 400,
            )
        # A read, so that a human with a dead link is told so instead of being
        # handed a button that fails. Deliberately not a lock and not a write.
        #
        # `token_epoch=F('user__kt_account_epoch')` is the  check, and it
        # is one statement -- one snapshot -- on purpose: reading the row and
        # then reading the account would let an ownership event land between
        # them. A row whose stamp is behind the account was minted before an
        # event that evicted whoever asked for it, and it is exactly as dead as
        # an expired one, so it gets the same page. NULL never compares equal,
        # so a row from before the column existed also fails closed (the
        # migration backfills them, so this is belt-and-braces).
        if not Email.objects.filter(
            token=token,
            expires_at__gte=timezone.now(),
            token_epoch=F('user__kt_account_epoch'),
        ).exists():
            return _render_landing(
                request, CONFIRM_LANDING_TEMPLATE, {'state': 'invalid'}, 404,
            )
        return _render_landing(
            request,
            CONFIRM_LANDING_TEMPLATE,
            {'state': 'ready', 'token': token},
        )

    @extend_schema(
        summary='Confirm the email address the token belongs to.',
        description=(
            'The write half of the confirmation link. Submitted by the button '
            'on the landing page above; the token travels in the body, with '
            'the query string accepted as a fallback for callers that already '
            'used the old shape.'
        ),
        parameters=[
            OpenApiParameter(
                name='token',
                type=str,
                location=OpenApiParameter.QUERY,
                required=False,
                description='Fallback for the body field of the same name.',
            ),
        ],
        request=inline_serializer(
            name='EmailConfirmRequest',
            fields={'token': serializers.CharField(required=False)},
        ),
        responses={
            303: OpenApiResponse(description='Confirmed; redirect to /profile.'),
            400: OpenApiResponse(description='No token supplied.'),
            404: OpenApiResponse(
                description='HTML page: the token is unknown or expired.',
            ),
        },
    )
    def post(self, request, *args, **kwargs):
        token = _posted_token(request)
        if not token:
            return _render_landing(
                request, CONFIRM_LANDING_TEMPLATE, {'state': 'missing'}, 400,
            )
        try:
            # Resolve the account without taking an Email lock.  All writers
            # acquire the Creator row first; the transaction below then
            # re-checks the token after that lock, so an address rotation
            # cannot be overwritten by this stale confirmation request.
            email_identity = Email.objects.values('pk', 'user_id').get(
                token=token,
                expires_at__gte=timezone.now(),
            )
        except Email.DoesNotExist:
            return _render_landing(
                request, CONFIRM_LANDING_TEMPLATE, {'state': 'invalid'}, 404,
            )

        with transaction.atomic():
            try:
                account = (
                    Creator.objects.select_for_update()
                    .only('pk', 'kt_account_epoch')
                    .get(pk=email_identity['user_id'])
                )
                email_instance = Email.objects.select_for_update().get(
                    pk=email_identity['pk'],
                    user_id=email_identity['user_id'],
                    token=token,
                    expires_at__gte=timezone.now(),
                    #, re-checked under the account lock rather than
                    # trusted from the unlocked read above. Confirming is the
                    # write that turns a mailbox into the account's recovery
                    # principal, so it is the one that must not run on a stamp
                    # an ownership event has since passed. Under the lock no
                    # bump can commit between this check and the save below.
                    token_epoch=account.kt_account_epoch,
                )
            except (Creator.DoesNotExist, Email.DoesNotExist):
                return _render_landing(
                    request, CONFIRM_LANDING_TEMPLATE, {'state': 'invalid'}, 404,
                )

            # Restrict the write to the confirmation field.  A stale model
            # instance must never restore the address, token, expiry, or any
            # other recovery state changed while this request was waiting.
            email_instance.confirmed_at = timezone.now()
            email_instance.save(update_fields=['confirmed_at'])
        # Same destination as before; 303 rather than 302 because this now
        # follows a POST and the browser must continue with a GET.
        return SeeOtherRedirect('/profile')


class EmailStatusView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, *args, **kwargs):
        user = request.user
        if not user.is_authenticated:
            return Response(
                {"detail": "User not authenticated."},
                status=status.HTTP_401_UNAUTHORIZED
            )

        with transaction.atomic():
            try:
                locked_user = Creator.objects.select_for_update().only('pk').get(
                    pk=user.pk
                )
                email_instance = Email.objects.select_for_update().get(
                    user_id=locked_user.pk
                )
            except (Creator.DoesNotExist, Email.DoesNotExist):
                return Response({
                    "email": None,
                    "confirmed": False,
                    "pending": False,
                    "is_public": False,
                    "get_notifications": False,
                })

            # Token expiry and recipient admission are private issuance state.
            # Keep the address available for a safe resend, including when a
            # shared mailbox limit suppressed issuance of a fresh token.
            data = {
                "email": email_instance.email,
                "confirmed": email_instance.confirmed_at is not None,
                "pending": email_instance.confirmed_at is None,
                "is_public": email_instance.is_public,
                "get_notifications": email_instance.get_notifications,
            }
        return Response(data)


class ToggleEmailPublicView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, *args, **kwargs):
        user = request.user
        if not user.is_authenticated:
            return Response(
                {"detail": "User not authenticated."},
                status=status.HTTP_401_UNAUTHORIZED
            )

        with transaction.atomic():
            try:
                locked_user = Creator.objects.select_for_update().only('pk').get(
                    pk=user.pk
                )
                email_instance = Email.objects.select_for_update().get(
                    user_id=locked_user.pk
                )
            except (Creator.DoesNotExist, Email.DoesNotExist):
                return Response(
                    {"detail": "No email address found for this user."},
                    status=status.HTTP_404_NOT_FOUND
                )

            # Frontend calls this endpoint with the new value of is_public.
            # Narrow the write so a stale object cannot restore recovery data.
            email_instance.is_public = request.data['value']
            email_instance.save(update_fields=['is_public', 'updated_at'])
        return Response(status=status.HTTP_204_NO_CONTENT)


class ToggleEmailNotificationsView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, *args, **kwargs):
        user = request.user
        if not user.is_authenticated:
            return Response(
                {"detail": "User not authenticated."},
                status=status.HTTP_401_UNAUTHORIZED
            )

        with transaction.atomic():
            try:
                locked_user = Creator.objects.select_for_update().only('pk').get(
                    pk=user.pk
                )
                email_instance = Email.objects.select_for_update().get(
                    user_id=locked_user.pk
                )
            except (Creator.DoesNotExist, Email.DoesNotExist):
                return Response(
                    {"detail": "No email address found for this user."},
                    status=status.HTTP_404_NOT_FOUND
                )

            # As above, update only the requested preference and timestamp.
            email_instance.get_notifications = request.data['value']
            email_instance.save(update_fields=['get_notifications', 'updated_at'])
        return Response(status=status.HTTP_204_NO_CONTENT)


class DeleteEmailView(APIView):
    permission_classes = [IsAuthenticated]

    def delete(self, request, *args, **kwargs):
        user = request.user
        if not user.is_authenticated:
            return Response(
                {"detail": "User not authenticated."},
                status=status.HTTP_401_UNAUTHORIZED
            )

        with transaction.atomic():
            try:
                locked_user = Creator.objects.select_for_update().only('pk').get(
                    pk=user.pk
                )
                email_instance = Email.objects.select_for_update().get(
                    user_id=locked_user.pk
                )
            except (Creator.DoesNotExist, Email.DoesNotExist):
                return Response(
                    {"detail": "No email address found for this user."},
                    status=status.HTTP_404_NOT_FOUND
                )
            was_confirmed = email_instance.confirmed_at is not None
            email_instance.delete()
            if was_confirmed:
                # An account-ownership event, and a *deletion* is as
                # much a revocation as a replacement: a confirmed address is a
                # live recovery principal, and this is how an owner evicts one
                # they no longer control. Missed on the first pass -- the
                # docstring in `dj.apps.ktauth.epoch` claimed every removal
                # route counted while this one did not (codex adversarial
                # review). Inside the same transaction as the delete.
                bump_account_epoch(
                    locked_user.pk, event=EVENT_RECOVERY_ADDRESS_CHANGE
                )
        return Response(status=status.HTTP_204_NO_CONTENT)


class OptOutEmailView(APIView):
    # Unsubscribe link in an outgoing email; the per-address token is
    # the credential. Must work for a signed-out recipient (CAN-SPAM) — a
    # 429 here is a compliance problem, so it sits in the roomier
    # 'anon-link' bucket rather than with the auth flows.
    #
    # GET RENDERS, POST WRITES. This is the endpoint the prefetch
    # hazard actually bit: the GET *deleted a row*, so any mail client,
    # corporate link scanner or preview bot that followed the URL in a message
    # unsubscribed a user who never clicked — a reported-in-the-wild failure
    # mode for unsubscribe links. The URL in every already-delivered message is
    # unchanged and still lands here; it now shows one page with one button.
    #
    # One click is still one click: the landing page is a single prominent
    # button, and RFC 8058 clients skip it entirely (see `post`).
    #
    # TOKEN-ONLY URL since. `<link>` used to be the recipient's email
    # address, which put it in access logs, `Referer` headers and any analytics
    # that saw the landing page — and, worse, made the link *unroutable* for an
    # address whose local part contains `/` (legal per RFC 5321). Django's
    # default `str` converter does not match `/`, so those recipients got a
    # permanent 404 on their unsubscribe link and could never click to
    # unsubscribe. The address was redundant anyway: the token is the
    # credential and the row has to be looked up by it regardless.
    #
    # The legacy shape still resolves, deliberately, until at least
    # OPT_OUT_LEGACY_URL_SUPPORTED_UNTIL — those links are in inboxes now.
    permission_classes = [AllowAny]
    throttle_classes = LINK_LANDING_THROTTLES

    @extend_schema(
        summary='Unsubscribe landing page. Changes nothing.',
        description=(
            'Renders the page the emailed unsubscribe link points at. This '
            'operation performs no write, so a prefetching mail client or '
            'security scanner cannot unsubscribe an address. The page contains a '
            'form that POSTs to this same URL; that POST is the unsubscribe.'
        ),
        parameters=[OPT_OUT_LINK_PARAMETER, OPT_OUT_LEGACY_TOKEN_PARAMETER],
        responses={
            200: OpenApiResponse(
                description=(
                    'HTML: either the unsubscribe button, or confirmation that '
                    'this address is already on the do-not-email list.'
                ),
            ),
            404: OpenApiResponse(
                description='HTML page: no address matches this token.',
            ),
        },
    )
    def get(self, request, link, *args, **kwargs):
        email, token, token_only, _spent = resolve_opt_out_link(
            link, request.query_params.get('token'),
        )
        if OptOutEmail.objects.filter(email=email).exists():
            return _render_landing(
                request,
                OPT_OUT_LANDING_TEMPLATE,
                {'state': 'done', 'email': email},
            )

        # A read, so a dead link says so rather than offering a button that
        # fails. Deliberately not a lock and not a write.
        if not token or not Email.objects.filter(
            email=email, token=token,
        ).exists():
            return _render_landing(
                request,
                OPT_OUT_LANDING_TEMPLATE,
                {'state': 'invalid', 'email': email},
                404,
            )
        return _render_landing(
            request,
            OPT_OUT_LANDING_TEMPLATE,
            # The form re-posts the token only for a legacy link, where the URL
            # does not carry it. On a token-only link the credential is already
            # in the path, so there is no reason to render the raw `Email`
            # token into the page as well.
            {'state': 'ready', 'email': email,
             'token': None if token_only else token},
        )

    @extend_schema(
        summary='Unsubscribe this address and delete it from the account.',
        description=(
            'The write half of the unsubscribe link, and the RFC 8058 '
            'one-click target advertised in the outgoing `List-Unsubscribe` / '
            '`List-Unsubscribe-Post` headers. Adds the address to the '
            'do-not-email list and DELETES the account\'s `Email` row, which '
            'is also its password-recovery address.\n\n'
            'The link token in the path is the credential and nothing else is '
            'needed. On a legacy link — the address in the path, no token '
            'there — the token travels in the body when the landing page\'s '
            'button is used, with the query string accepted as a fallback '
            'because an RFC 8058 client POSTs a fixed '
            '`List-Unsubscribe=One-Click` body to the published URL and can '
            'put nothing of its own in it.'
        ),
        parameters=[
            OPT_OUT_LINK_PARAMETER,
            OpenApiParameter(
                name='token',
                type=str,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    'Legacy links only: fallback for the body field of the '
                    'same name. Ignored when the path carries a link token.'
                ),
            ),
        ],
        request=inline_serializer(
            name='EmailOptOutRequest',
            fields={
                'token': serializers.CharField(required=False),
                ONE_CLICK_FIELD: serializers.ChoiceField(
                    choices=[ONE_CLICK_VALUE],
                    required=False,
                    help_text='RFC 8058 one-click marker.',
                ),
            },
        ),
        responses={
            200: OpenApiResponse(
                description=(
                    'RFC 8058 one-click unsubscribe accepted (text/plain), or '
                    'the address was already on the do-not-email list.'
                ),
            ),
            303: OpenApiResponse(
                description=(
                    'Browser flow: unsubscribed, redirect back to the landing '
                    'page so a reload does not re-submit.'
                ),
            ),
            404: OpenApiResponse(
                description='HTML page: no address matches this token.',
            ),
        },
    )
    def post(self, request, link, *args, **kwargs):
        # Parse the body once: `request.data` can raise on a malformed payload,
        # and DRF turns that into the 400 it should be.
        one_click = _is_one_click_unsubscribe(request)
        email, token, _token_only, spent = resolve_opt_out_link(
            link, _posted_token(request),
        )

        if OptOutEmail.objects.filter(email=email).exists():
            # Unchanged short-circuit: already opted out is a success, not an
            # error, and replaying the link must stay harmless.
            return self._done(request, email, one_click)

        # They had the token so they really have access to the email. Resolve
        # the account first, then re-check the locked row so an address change
        # cannot let a stale opt-out delete the new recovery address.
        try:
            email_identity = Email.objects.values('pk', 'user_id').get(
                email=email,
                token=token,
            )
        except Email.DoesNotExist:
            return self._gone_or_not_found(request, email, one_click)

        with transaction.atomic():
            try:
                Creator.objects.select_for_update().only('pk').get(
                    pk=email_identity['user_id']
                )
                email_instance = Email.objects.select_for_update().get(
                    pk=email_identity['pk'],
                    user_id=email_identity['user_id'],
                    email=email,
                    token=token,
                )
            except (Creator.DoesNotExist, Email.DoesNotExist):
                return self._gone_or_not_found(request, email, one_click)

            # Add email to opt-out list and remove the still-matching token.
            #
            # `link_token` records the token being spent right here, in the
            # same transaction as the delete that invalidates it, so the URL
            # the recipient just followed keeps resolving to this address
            # afterwards -- see `resolve_opt_out_link`. Set on creation only:
            # an existing row is somebody's earlier opt-out and its link is
            # not this one's to overwrite.
            OptOutEmail.objects.get_or_create(
                email=email, defaults={'link_token': spent},
            )
            was_confirmed = email_instance.confirmed_at is not None
            owner_id = email_instance.user_id
            email_instance.delete()
            if was_confirmed:
                #, same reasoning as `DeleteEmailView`: an unsubscribe
                # removes the row, so it removes a confirmed address's standing
                # ability to recover the account. Reached by an emailed token
                # rather than a session, which makes it MORE important to count,
                # not less.
                bump_account_epoch(
                    owner_id, event=EVENT_RECOVERY_ADDRESS_CHANGE
                )

        return self._done(request, email, one_click)

    def _done(self, request, email, one_click):
        if one_click:
            # RFC 8058: the provider wants a 2xx, not a redirect chain, and
            # renders nothing. Keep it boring.
            return _private_response(HttpResponse(
                'You have been unsubscribed.\n', content_type='text/plain',
            ))
        # Post/Redirect/Get back to this same landing URL *without* the query
        # string: the token row is gone, and a reload must not re-submit.
        return _private_response(SeeOtherRedirect(request.path))

    def _gone_or_not_found(self, request, email, one_click):
        """Success if a concurrent request already unsubscribed this address.

        The codex review of: two simultaneous one-click POSTs both pass
        the OptOutEmail check, then one wins the account lock, deletes the row
        and returns 200 while the other finds nothing under the lock. Without
        this re-check the loser answers 404 and the mail provider records one
        of two identical unsubscribes as failed. Read Committed means this
        query sees the winner's committed row, because we only get here after
        waiting on the same account lock it held.
        """
        if OptOutEmail.objects.filter(email=email).exists():
            return self._done(request, email, one_click)
        return self._not_found(request, email, one_click)

    def _not_found(self, request, email, one_click):
        if one_click:
            return _private_response(HttpResponse(
                'This unsubscribe link is no longer valid.\n',
                content_type='text/plain',
                status=status.HTTP_404_NOT_FOUND,
            ))
        return _render_landing(
            request,
            OPT_OUT_LANDING_TEMPLATE,
            {'state': 'invalid', 'email': email},
            status.HTTP_404_NOT_FOUND,
        )


class ChangePasswordView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=ChangePasswordSerializer)
    def post(self, request, *args, **kwargs):
        serializer = ChangePasswordSerializer(data=request.data, context={'request': request})
        if serializer.is_valid():
            new_password = serializer.validated_data['new_password']
            password_change_attempt_identifier = None
            with transaction.atomic():
                # Use the same account-first lock as reset issuance and
                # redemption. Re-check the old password on the locked row: the
                # serializer validated request.user, which authentication may
                # have loaded before a concurrent password change committed.
                user = Creator.objects.select_for_update().get(
                    pk=request.user.pk
                )
                proved_password = user.has_usable_password()
                if not proved_password:
                    try:
                        require_recent_auth(request)
                    except RecentAuthenticationRequired as exc:
                        return exc.response()
                if proved_password and not user.check_password(
                    serializer.validated_data.get('old_password')
                ):
                    return Response(
                        {'old_password': ['Incorrect password.']},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                second_factor = None
                if has_active_totp(user):
                    password_change_attempt_identifier = user.pk
                    attempt = claim_totp_attempt(
                        'password-change',
                        password_change_attempt_identifier,
                        TOTP_ATTEMPT_TTL_SECONDS,
                    )
                    if attempt is None:
                        return Response(
                            {'otp_token': [
                                'Password change is temporarily unavailable.'
                            ]},
                            status=status.HTTP_503_SERVICE_UNAVAILABLE,
                        )
                    if attempt > TOTP_ATTEMPT_LIMIT:
                        return Response(
                            {'otp_token': [
                                'Too many password change attempts. Start again.'
                            ]},
                            status=status.HTTP_429_TOO_MANY_REQUESTS,
                        )
                    gate = check_user_totp(
                        user,
                        serializer.validated_data.get('otp_token'),
                    )
                    if not gate.passed:
                        failure_status = (
                            status.HTTP_429_TOO_MANY_REQUESTS
                            if attempt == TOTP_ATTEMPT_LIMIT
                            else status.HTTP_400_BAD_REQUEST
                        )
                        return Response(
                            {'otp_token': [INVALID_OTP_TOKEN_MESSAGE]},
                            status=failure_status,
                        )
                    second_factor = gate.second_factor
                user.set_password(new_password)
                user.save(
                    update_fields=['password', 'password_set', 'updated_at']
                )
                PasswordResetToken.objects.filter(
                    email__user_id=user.pk,
                    used=False,
                ).update(used=True)
                # An account-ownership event. A password change is
                # what somebody does *because* they believe another party has
                # the old one, so any key-transparency assertion minted before
                # it must stop being spendable. Inside the same transaction as
                # the password write, and after it, so a rolled-back change
                # cannot leave an increment behind.
                bump_account_epoch(user.pk, event=EVENT_PASSWORD_CHANGE)

            if password_change_attempt_identifier is not None:
                clear_totp_attempt(
                    'password-change',
                    password_change_attempt_identifier,
                )

            # Re-authenticate and log the user in with the new password
            u = authenticate(username=user.username, password=new_password)
            login(request, u)
            # The new session's AuthContext. The old password was
            # just re-proved, so this is a fresh password sign-in. An account
            # that had NO usable password proved nothing here but holding a
            # session, so its new session gets no context at all (the old
            # one's died with the epoch bump above): step-up asks again.
            record_login(
                request, u,
                methods=[AMR_PASSWORD] if proved_password else [],
                second_factor=second_factor if proved_password else None,
            )

            return Response(status=status.HTTP_200_OK)

        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class RequestResetPasswordView(APIView):
    # Forgot-password: by definition unauthenticated. Anon-throttled —
    # it sends mail and confirms whether an address is registered. On the
    # tight 'anon-recovery' bucket, which nothing machine-paced shares and,
    # since the review of, nothing on the sign-in path shares either —
    # /api/start/ fires on every login attempt and would set the floor here.
    permission_classes = [AllowAny]
    throttle_classes = ACCOUNT_RECOVERY_THROTTLES
    def post(self, request):
        email_address = request.data.get('email')
        if not email_address:
            return Response({"message": "Email is required"}, status=status.HTTP_400_BAD_REQUEST)

        # Anti-enumeration: the response must be identical whether or not the
        # address is registered/confirmed and whether or not sending actually
        # happened (rate-limited, opted-out). Previously an unknown/unconfirmed
        # address got a distinguishable 404 and a throttled send a 406, both of
        # which let an attacker probe which emails have accounts. Always return
        # the same generic 200; do the real work only when we have a match.
        generic_response = Response(
            {"message": "If that email is registered and confirmed, password "
                        "reset instructions have been sent."},
            status=status.HTTP_200_OK,
        )

        try:
            email_obj = Email.objects.get(email=email_address, confirmed_at__isnull=False)
        except Email.DoesNotExist:
            return generic_response

        # The send is synchronous and can raise (SMTP down, template error). If
        # that exception escaped, a *registered* address would 500 while an
        # unknown one returns 200 — reintroducing exactly the enumeration this
        # view is closing. Swallow it so the response is identical either way;
        # the failure is logged for operators. (A residual timing oracle
        # remains because the send blocks the request; moving mail onto a task
        # queue is the real fix — tracked separately.)
        try:
            send_password_reset_email(email_obj)
        except Exception:
            logger.exception("Password reset email send failed for a registered address")
        return generic_response


def _reset_error(message, code, http_status, **extra):
    """One failure of the do-reset-password route.

    ``message`` is the English sentence every existing client already reads;
    ``code`` is a stable, machine-readable reason so a client can say WHICH
    thing went wrong in the reader's own language. Before it existed the
    SvelteKit page could not tell an expired link from a weak password or a
    mistyped authenticator code, and told every one of them "the link may
    have expired — request a new one": a loop of fresh emails that fail the
    same way, on the one path an account without a working password has.
    """
    return Response(
        {'message': message, 'code': code, **extra},
        status=http_status,
    )


class ResetPasswordAPIView(APIView):
    # Consumes the emailed reset token; unauthenticated by definition.
    # Account recovery, so 'anon-recovery' — same bucket as the request half
    # (same shape, same order of magnitude), deliberately isolated from
    # anything a browser polls and from the sign-in path.
    permission_classes = [AllowAny]
    throttle_classes = ACCOUNT_RECOVERY_THROTTLES

    @staticmethod
    def _mfa_attempt_identifier(reset_token):
        # Do not put the bearer reset credential itself in a cache key. The
        # digest still gives every reset token an independent counter without
        # making cache-key dumps another place that stores a live credential.
        return hashlib.sha256(
            str(reset_token.token).encode('ascii'),
        ).hexdigest()

    @classmethod
    def _verify_reset_totp(cls, user, reset_token, otp_token):
        """``(failure response or None, second factor or None)``.

        The second factor is ``"otp"`` only when a code was verified and
        burned here; the new session's AuthContext records it.
        """
        if not has_active_totp(user):
            return None, None

        attempt = claim_totp_attempt(
            'password-reset',
            cls._mfa_attempt_identifier(reset_token),
            PASSWORD_RESET_MFA_ATTEMPT_TTL_SECONDS,
        )
        if attempt is None:
            return _reset_error(
                'Password reset is temporarily unavailable.',
                'unavailable',
                status.HTTP_503_SERVICE_UNAVAILABLE,
            ), None
        if attempt > PASSWORD_RESET_MFA_ATTEMPT_LIMIT:
            return _reset_error(
                'Too many password reset attempts. Start again.',
                'otp_attempts_exhausted',
                status.HTTP_429_TOO_MANY_REQUESTS,
            ), None
        gate = check_user_totp(user, otp_token)
        if not gate.passed:
            # The last allowed wrong code burns this link's MFA budget: the
            # same sentence, but a new link is now the only way forward, so
            # the code says so rather than inviting another doomed retry.
            if attempt == PASSWORD_RESET_MFA_ATTEMPT_LIMIT:
                return _reset_error(
                    INVALID_OTP_TOKEN_MESSAGE,
                    'otp_attempts_exhausted',
                    status.HTTP_429_TOO_MANY_REQUESTS,
                ), None
            return _reset_error(
                INVALID_OTP_TOKEN_MESSAGE,
                'invalid_otp',
                status.HTTP_400_BAD_REQUEST,
            ), None
        return None, gate.second_factor

    @extend_schema(
        request=inline_serializer(
            name="ResetPasswordRequest",
            fields={
                "token": serializers.CharField(write_only=True),
                "password": serializers.CharField(write_only=True),
                "otp_token": serializers.CharField(
                    required=False,
                    write_only=True,
                    max_length=10,
                    help_text=(
                        "Current authenticator code for an account with MFA."
                    ),
                ),
            },
        ),
    )
    def post(self, request):
        token = request.data.get('token')
        new_password = request.data.get('password')
        otp_token = request.data.get('otp_token')

        # Check if token and new password are provided
        if not token or not new_password:
            return _reset_error(
                'Token and new password are required.',
                'missing_fields',
                status.HTTP_400_BAD_REQUEST,
            )

        if otp_token is not None and (
            not isinstance(otp_token, str) or len(otp_token) > 10
        ):
            return _reset_error(
                INVALID_OTP_TOKEN_MESSAGE,
                'invalid_otp',
                status.HTTP_400_BAD_REQUEST,
            )

        # Lock and consume the reset token in the same transaction as the
        # password replacement. Lock the account before its token so requests
        # holding two different reset emails serialize on the same row. A
        # successful reset consumes every outstanding token for that account.
        reset_attempt_identifier = None
        try:
            with transaction.atomic():
                candidate = (
                    PasswordResetToken.objects.select_related('email')
                    .get(token=token, used=False)
                )
                user = Creator.objects.select_for_update().get(
                    pk=candidate.email.user_id
                )
                reset_token = (
                    PasswordResetToken.objects.select_for_update()
                    .get(
                        token=token,
                        used=False,
                        email__user_id=user.pk,
                    )
                )
                if reset_token.is_expired:
                    return _reset_error(
                        'Token has expired.',
                        'token_expired',
                        status.HTTP_400_BAD_REQUEST,
                    )

                # Validate the new password against Django's password policy
                # BEFORE the second factor. The client tells a reader
                # whose password was refused to choose another and try again,
                # which only helps if the refusal spent nothing: checked after
                # the TOTP, a weak password consumed the authenticator code
                # and one of this link's MFA attempts, so the last try could
                # burn the link while being reported as "choose another
                # password". (An already-exhausted budget still answers
                # otp_attempts_exhausted on the next, valid, submission.)
                # The validators disclose nothing a link holder cannot see.
                # ``str(e)`` rendered the Python list repr ("['This password
                # is too common.']"); send the sentences, plus each
                # validator's own code so a client can translate them.
                try:
                    validate_password(new_password, user)
                except ValidationError as e:
                    return _reset_error(
                        ' '.join(e.messages),
                        'password_invalid',
                        status.HTTP_400_BAD_REQUEST,
                        password_errors=[
                            {
                                'code': error.code or 'invalid',
                                'message': message,
                            }
                            for error in e.error_list
                            for message in error.messages
                        ],
                    )

                # The reset token is already a valid recovery credential, but
                # an enrolled account still needs its second factor before we
                # change the password or create the new session below. Keep
                # this check inside the account lock so a failed TOTP attempt
                # leaves both the password and reset token untouched.
                reset_attempt_identifier = self._mfa_attempt_identifier(
                    reset_token,
                )
                mfa_error, second_factor = self._verify_reset_totp(
                    user,
                    reset_token,
                    otp_token,
                )
                if mfa_error is not None:
                    return mfa_error

                user.set_password(new_password)
                user.save(
                    update_fields=['password', 'password_set', 'updated_at']
                )
                # An account-ownership event: account recovery, in the
                # literal sense KT.md 4.5.4 names. Whoever controls the
                # recovery mailbox now controls the account.
                bump_account_epoch(user.pk, event=EVENT_PASSWORD_RESET)
                reset_token.used = True
                reset_token.save(update_fields=['used'])
                PasswordResetToken.objects.filter(
                    email__user_id=user.pk,
                    used=False,
                ).update(used=True)
        except PasswordResetToken.DoesNotExist:
            return _reset_error(
                'Invalid token.',
                'token_invalid',
                status.HTTP_400_BAD_REQUEST,
            )

        clear_totp_attempt('password-reset', reset_attempt_identifier)

        # An account in its deletion grace period: the reset stands (the
        # mailbox proved control), but signing in is "Keep my account?"
        # first, never a session (dj.apps.g12f.account_deletion.login_gate).
        from dj.apps.g12f import account_deletion

        try:
            account_deletion.login_gate(
                type(user)._default_manager.get(pk=user.pk),
                methods=[AMR_PASSWORD], second_factor=second_factor,
                credential="session",
            )
        except account_deletion.DeletionPending as exc:
            return account_deletion.deletion_pending_response(exc)
        except account_deletion.InactiveAccount:
            # Recovery proved mailbox ownership and the password change must
            # commit, while the inactive account must not receive a session.
            # Return the existing reset-without-sign-in contract; raising here
            # would make AtomicMiddleware undo the reset and token consumption.
            return _reset_error(
                'Password reset successful, but this account cannot sign in.',
                'reset_but_not_signed_in',
                status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        # Authenticate and login the user
        user = authenticate(username=user.username, password=new_password)
        if user is not None:
            login(request, user)
            # The new session's AuthContext: the new password (with
            # the TOTP, when one was verified above), under the post-reset
            # epoch `authenticate` just read.
            record_login(
                request, user,
                methods=[AMR_PASSWORD],
                second_factor=second_factor,
            )
            # Here, you can generate and return an auth token if needed
            return Response({'message': 'Password reset successful.'}, status=status.HTTP_200_OK)
        # The password HAS been changed and the link consumed by this point;
        # only the automatic sign-in failed. The client must say so — "the
        # link may have expired" here sent people to request a link for a
        # password they had already set.
        return _reset_error(
            'Password reset failed.',
            'reset_but_not_signed_in',
            status.HTTP_500_INTERNAL_SERVER_ERROR,
        )
