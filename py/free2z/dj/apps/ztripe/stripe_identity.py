"""Fail-closed Stripe account and mode identity contracts."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass

from django.conf import settings


STRIPE_CHECKOUT_MODE = 'payment'
STRIPE_API_VERSION = '2026-07-29.dahlia'
_ACCOUNT_ID = re.compile(r'^acct_[A-Za-z0-9]{8,64}$')
_SECRET_KEY = re.compile(r'^(?:sk|rk)_(live|test)_[A-Za-z0-9_]+$')


class StripeIdentityConfigurationError(ValueError):
    """Raised when checkout identity settings cannot establish provider trust."""


#The only namespace allowed to hold live-mode Stripe credentials.
#``settings.NAMESPACE`` comes from the per-namespace free2z ConfigMap
#(``NAMESPACE: "%{DBNAME}"``), which every Django pod -- web, worker and
#CronJob -- loads through ``envFrom``.
PROD_NAMESPACE = 'prod'

#Key prefixes that are live-mode by construction. A ``whsec_`` signing
#secret and a ``we_`` endpoint id carry no mode in their prefix; they are
#treated as live-bound when they sit next to live material (see below).
_LIVE_PREFIXES = ('sk_live_', 'rk_live_', 'pk_live_')

#Event name of the loud, structured refusal. Counted by nothing yet on
#purpose: stage is not paged, but the line is greppable and names only
#setting NAMES, never values.
LIVE_STRIPE_OUTSIDE_PROD_EVENT = 'stripe_live_credentials_outside_prod'

logger = logging.getLogger(__name__)


def live_stripe_credentials_outside_prod() -> tuple[str, ...]:
    """Names of live-mode Stripe settings held by a non-prod namespace.

    Empty in prod, and empty wherever nothing live is configured. Returns
    setting NAMES only; the values never leave this function.

    Live material is: a secret/restricted/publishable key with a ``*_live_``
    prefix, or ``STRIPE_EXPECTED_LIVEMODE=true`` (the operator's own
    declaration that this deployment is live). The signing secret and
    webhook endpoint id have no mode in their prefix, so they are reported as
    live-bound when either of those is present: a ``whsec_`` sitting next to
    a live key belongs to a live endpoint (: stage held prod's).
    """
    if getattr(settings, 'NAMESPACE', None) == PROD_NAMESPACE:
        return ()
    names = set()
    for name in ('STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY'):
        value = getattr(settings, name, '')
        if isinstance(value, str) and value.startswith(_LIVE_PREFIXES):
            names.add(name)
    if getattr(settings, 'STRIPE_EXPECTED_LIVEMODE', '') == 'true':
        names.add('STRIPE_EXPECTED_LIVEMODE')
    if names:
        for name in ('STRIPE_SIGNING_SECRET', 'STRIPE_WEBHOOK_ENDPOINT_ID'):
            if getattr(settings, name, ''):
                names.add(name)
    return tuple(sorted(names))


def log_live_credentials_outside_prod(names, *, where) -> None:
    """One structured ERROR line naming the offending settings, never values."""
    logger.error(json.dumps(
        {
            'event': LIVE_STRIPE_OUTSIDE_PROD_EVENT,
            'namespace': str(getattr(settings, 'NAMESPACE', '')),
            'settings': list(names),
            'checkout': 'refused',
            'where': where,
        },
        separators=(',', ':'),
        sort_keys=True,
    ))


def stripe_checkout_enabled() -> bool:
    """Parse the explicit staged activation switch without truthiness.

    Outside prod, live-mode credentials force this to ``False`` whatever the
    switch says: stage is a DBCOPY of prod, so a live Session created
    there would charge a real card and deliver its fulfillment webhook to
    PROD carrying stage row ids. The refusal is logged loudly; it does not
    raise, so the caller answers its designed "checkout not activated".
    """
    value = settings.STRIPE_CHECKOUT_ENABLED
    if value not in {'true', 'false'}:
        raise StripeIdentityConfigurationError(
            'STRIPE_CHECKOUT_ENABLED must be exactly true or false'
        )
    if value != 'true':
        return False
    live = live_stripe_credentials_outside_prod()
    if live:
        log_live_credentials_outside_prod(live, where='checkout_switch')
        return False
    return True


@dataclass(frozen=True)
class StripeIdentity:
    account_id: str
    mode: str
    livemode: bool


def configured_stripe_identity() -> StripeIdentity:
    """Return the exact server-owned Stripe identity or fail closed.

    The secret is never returned or logged. Its prefix is nevertheless part of
    the proof: a test credential must not be allowed to create a Session an
    operator declared live, or vice versa. A recent, account-bound provider
    delivery recorded by ``webhook_readiness`` proves the credential belongs
    to ``account_id`` without putting provider lookups on the request path.
    """
    account_id = settings.STRIPE_EXPECTED_ACCOUNT_ID
    if not isinstance(account_id, str) or not _ACCOUNT_ID.fullmatch(account_id):
        raise StripeIdentityConfigurationError(
            'STRIPE_EXPECTED_ACCOUNT_ID is not a canonical Stripe account ID'
        )

    raw_livemode = settings.STRIPE_EXPECTED_LIVEMODE
    if raw_livemode not in {'true', 'false'}:
        raise StripeIdentityConfigurationError(
            'STRIPE_EXPECTED_LIVEMODE must be exactly true or false'
        )
    livemode = raw_livemode == 'true'

    secret_key = settings.STRIPE_SECRET_KEY
    match = (
        _SECRET_KEY.fullmatch(secret_key)
        if isinstance(secret_key, str)
        else None
    )
    if match is None or (match.group(1) == 'live') != livemode:
        raise StripeIdentityConfigurationError(
            'STRIPE_SECRET_KEY mode does not match STRIPE_EXPECTED_LIVEMODE'
        )
    return StripeIdentity(
        account_id=account_id,
        mode=STRIPE_CHECKOUT_MODE,
        livemode=livemode,
    )


def provider_proven_legacy_identity(account_id) -> StripeIdentity:
    """Build the staged legacy identity from the current Stripe credential.

    This is deliberately narrower than ``configured_stripe_identity``. It is
    only for settling an already-paid Session while exact checkout remains
    disabled and the new server-owned account setting is not provisioned yet.
    The caller obtains ``account_id`` with a bounded ``Account.retrieve`` using
    the same secret key that re-retrieves the signed event.
    """
    if not isinstance(account_id, str) or not _ACCOUNT_ID.fullmatch(account_id):
        raise StripeIdentityConfigurationError(
            'Stripe credential returned a non-canonical account ID'
        )
    secret_key = settings.STRIPE_SECRET_KEY
    match = (
        _SECRET_KEY.fullmatch(secret_key)
        if isinstance(secret_key, str)
        else None
    )
    if match is None:
        raise StripeIdentityConfigurationError(
            'STRIPE_SECRET_KEY is not a canonical server credential'
        )
    return StripeIdentity(
        account_id=account_id,
        mode=STRIPE_CHECKOUT_MODE,
        livemode=match.group(1) == 'live',
    )


def stripe_boolean(value) -> bool | None:
    """Parse Stripe's signed boolean without truthiness coercion."""
    return value if isinstance(value, bool) else None


def configured_legacy_checkout_cutoff() -> int:
    """Return the first rollout's durable card-v1 Session cutoff.

    The deployment initializer creates this singleton once before any new pod
    rolls. Later deploys may verify it but can never advance it, so a hotfix
    cannot reopen metadata-free fulfillment.
    """
    from .models import StripeCheckoutRollout

    try:
        rollout = StripeCheckoutRollout.objects.get(singleton=1)
    except StripeCheckoutRollout.DoesNotExist as exc:
        raise StripeIdentityConfigurationError(
            'legacy Stripe Session cutoff has not been initialized'
        ) from exc
    timestamp = rollout.legacy_session_created_at_or_before_epoch
    if not isinstance(timestamp, int) or isinstance(timestamp, bool) or timestamp <= 0:
        raise StripeIdentityConfigurationError(
            'legacy Stripe Session cutoff is invalid'
        )
    return timestamp
