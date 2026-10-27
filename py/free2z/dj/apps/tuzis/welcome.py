"""The sign-up welcome grant: every new account starts with 2Z.

Owner decision (2026-10-16): every newly created account starts with
``settings.WELCOME_GRANT_2Z`` (default 10) 2Z, granted from ``sys:promo``
through the same audited path as ``manage.py grant_tuzis``
(:func:`dj.apps.tuzis.grants.issue_grant`): a
:class:`~dj.apps.tuzis.models.TuziGrant` receipt and a ``ledger.credit`` in
one transaction. 2Z are platform credits, never money.

Where it is called, and why there and not a signal
--------------------------------------------------
:func:`welcome_new_account` is called by each code path that creates an
account for a person signing up, right after the account row (and its
identity row) exists, inside the SAME transaction that creates the account:

* password sign-up -- ``SignUpView.create`` (``POST /api/start/``; this is
  also the sign-up the SDK/OIDC sign-in sheet uses);
* OAuth2 social sign-up -- ``SocialLoginView.post``
  (``POST /api/auth/social/<provider>/``: Google, X, and every provider in
  ``dj.apps.social``);
* X/Twitter web sign-in -- ``TwitterCallbackView.handle_new_twitter_user``.

Zcash wallet sign-in (``dj.apps.zauth``) is DELIBERATELY EXEMPT: it has no
CAPTCHA and a fresh keypair costs nothing, so a per-account grant there would
be a faucet, while the accepted bot-signup exposure is premised on the sign-up
reCAPTCHA.

``test_welcome_grant.py::test_every_account_insert_site_is_a_welcome_site``
parses every non-test module under ``py/dj`` and fails if a place that
inserts a ``Creator`` is neither on that list nor an explicit, reasoned
exemption, so a new sign-up path cannot ship without deciding whether it
grants.

A ``post_save`` receiver was rejected: it also fires for test fixtures,
``createsuperuser``, the staff ``CreatorAdmin`` add form and one-off
scripts, none of which is a person signing up, and it would grant in the
middle of ``Creator.save()`` before the sign-up path has written the identity
row. An explicit call at four sites is greppable and its exemptions are
written down.

Exactly once
------------
For a password sign-up the idempotency key is ``welcome-grant:<account id>``.
For a federated sign-up (social, X) it is ``welcome-grant:<provider>:<hash of
the provider uid>`` (:func:`identity_welcome_key`) and is checked across all
accounts, because an identity can be unlinked and used to provision a new
account. Either way the key is both the receipt's ``idempotency_key`` --
checked under the account's row lock by ``issue_grant`` before anything is
written -- and the ledger operation key, which the ledger itself refuses to
post twice. Because the grant commits or
rolls back WITH the account, a sign-up that fails and is retried creates a
new account (new id, one grant) and leaves nothing behind for the old one.
Signing in to an existing account never reaches this code at all.

Never breaks sign-up
--------------------
The grant runs in its own savepoint. Any exception rolls back only the grant,
emits one ``jsonPayload.event="welcome_grant_failed"`` line (matched by the
log-based alert ``monitoring/alert-policies/welcome-grant-failed.json``,
``ticket`` tier) and returns; the account is still created. The repair is in the alert's runbook:
``manage.py grant_tuzis <username> <amount> --idempotency-key <the
idempotency_key from the log line>``, which cannot pay twice (see
:mod:`dj.apps.tuzis.grants`).
"""
import hashlib
import json
import logging
import sys

from django.conf import settings
from django.db import transaction

from dj.apps.tuzis import ledger
from dj.apps.tuzis.grants import (
    GLOBAL_KEY_PREFIX,
    AlreadyGranted,
    describe_environment,
    issue_grant,
)
from dj.free2z.log_json import (
    REPORTED_ERROR_EVENT_TYPE,
    bounded,
    reported_error_message,
)

logger = logging.getLogger(__name__)

#Global keys: one grant per key across all accounts (see grants.py).
WELCOME_KEY_PREFIX = GLOBAL_KEY_PREFIX
WELCOME_OPERATOR = "system:welcome-grant"
WELCOME_REASON = "welcome grant: every new account starts with 2Z (#2698)"
GRANTED_EVENT = "welcome_grant"
FAILED_EVENT = "welcome_grant_failed"


def welcome_key(creator_pk) -> str:
    """The exactly-once key for one password account's welcome grant."""
    return f"{WELCOME_KEY_PREFIX}{int(creator_pk)}"


def identity_welcome_key(kind: str, uid) -> str:
    """The exactly-once key for an EXTERNAL identity's welcome grant.

    A federated identity can be unlinked and then used to provision a brand
    new account (set a password, unlink, sign in again: codex review of
    ). Keyed on the account id, every round would be a fresh grant -- a
    repeatable faucet from one Google login. So a federated sign-up is keyed
    on the provider identity instead, and that key is checked across ALL
    accounts: one welcome grant per identity, ever. ``kind`` is ``x`` for
    both the social X provider and the legacy X callback -- they share X's
    numeric user id, so one X account is one grant whichever door it used.
    The uid is hashed: bounded, opaque in logs, and inside grant_tuzis's
    ``--idempotency-key`` alphabet for the repair runbook.
    """
    digest = hashlib.sha256(str(uid).encode("utf-8")).hexdigest()[:40]
    return f"{WELCOME_KEY_PREFIX}{kind}:{digest}"


def grant_welcome(creator, *, path: str, identity_key: str | None = None):
    """Grant the welcome 2Z to ``creator`` once. Raises on failure.

    Returns the new:class:`TuziGrant`, or ``None`` when the grant is
    disabled (``WELCOME_GRANT_2Z`` is 0), this account already has its
    welcome grant, or (``identity_key``) the external identity it signed up
    with already earned one on some other account. ``path`` names the
    sign-up path, for the log line only.
    """
    amount = ledger.to_tuzis(settings.WELCOME_GRANT_2Z)
    if amount <= 0:
        return None
    key = identity_key or welcome_key(creator.pk)
    try:
        grant, balance = issue_grant(
            creator, amount,
            reason=WELCOME_REASON,
            operator=WELCOME_OPERATOR,
            environment=describe_environment()["summary"],
            idempotency_key=key,
        )
    except AlreadyGranted as already:
        # A ``welcome-grant:`` key is global (dj.apps.tuzis.grants): the
        # identity may have earned its grant on ANOTHER account it was later
        # unlinked from. Say so; it is the faucet attempt, or a re-sign-up.
        if already.grant.creator_id != creator.pk:
            _emit(logging.INFO, {
                "severity": "INFO",
                "event": GRANTED_EVENT,
                "message": (
                    f"welcome grant: skipped for account {creator.pk} ({path}); "
                    "this identity was already welcomed on another account"
                ),
                "outcome": "identity_already_welcomed",
                "creator_id": creator.pk,
                "idempotency_key": key,
                "path": path,
            })
        return None
    _emit(logging.INFO, {
        "severity": "INFO",
        "event": GRANTED_EVENT,
        "message": f"welcome grant: {amount} 2Z to account {creator.pk} ({path})",
        "outcome": "granted",
        "creator_id": creator.pk,
        "idempotency_key": key,
        "amount": str(amount),
        "balance_after": str(balance),
        "grant_id": grant.pk,
        "path": path,
    })
    return grant


def welcome_new_account(creator, *, path: str, identity_key: str | None = None):
    """Call where a sign-up path has just created ``creator``. Never raises.

    Must run inside the transaction that created the account (every caller
    is: ``AtomicMiddleware`` for the POST paths, an explicit
    ``transaction.atomic()`` for the X callback).
    A failure rolls back the grant's savepoint only, is logged as
    ``welcome_grant_failed``, and sign-up continues.
    """
    try:
        with transaction.atomic():
            return grant_welcome(creator, path=path, identity_key=identity_key)
    except Exception:  # noqa: BLE001 - a failed welcome grant never fails sign-up
        _emit(logging.ERROR, {
            "severity": "ERROR",
            "@type": REPORTED_ERROR_EVENT_TYPE,
            "event": FAILED_EVENT,
            "message": reported_error_message(
                f"welcome grant failed for account {creator.pk} ({path}); "
                "sign-up continued without it",
                sys.exc_info(),
            ),
            "outcome": "failed",
            "creator_id": creator.pk,
            "amount": bounded(getattr(settings, "WELCOME_GRANT_2Z", None)),
            "idempotency_key": identity_key or welcome_key(creator.pk),
            "error_type": type(sys.exc_info()[1]).__name__,
            "path": path,
        })
        return None


def _emit(level, payload) -> None:
    # One line, entirely JSON: Cloud Logging promotes it to jsonPayload, which
    # is what the log-based metric filters on (see dj.free2z.log_json).
    logger.log(level, json.dumps(payload, sort_keys=True, default=str))
