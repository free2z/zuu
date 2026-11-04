"""Grant 2Z platform credits to one account, with a reason and a receipt.

2Z are platform credits, never money. This mints spendable platform balance;
it moves no ZEC and no card funds. It exists because the only way to hand an
account 2Z used to be calling ``dj.apps.tuzis.ledger.credit`` from a Django
shell: no reason, no operator, no record that it ever happened.

Every grant:

* credits through ``ledger.credit`` (``tuzis`` is ``LEDGER_ONLY_FIELDS``; a raw
  UPDATE or an admin edit is never the answer), via
  :func:`dj.apps.tuzis.grants.issue_grant` -- the same path the sign-up
  welcome grant takes;
* writes a:class:`~dj.apps.tuzis.models.TuziGrant` receipt in the SAME
  explicit ``transaction.atomic()`` as the credit. A management command gets
  none of ``AtomicMiddleware``'s wrapping -- it runs in autocommit -- so
  without the explicit block a crash between the two statements would leave a
  balance change with no receipt;
* prints the environment it believes it is in BEFORE doing anything, and
  emits one loud single-line JSON log record (``event: tuzi_grant``) after.

Refusals: an amount <= 0 or with more precision than the ledger stores, a
reason shorter than 10 characters, an empty operator, a grant above
``LARGE_GRANT`` without ``--i-mean-it``, and any grant against production
(``NAMESPACE=prod`` or database ``prod``) without ``--allow-prod``.

``--idempotency-key`` makes a retry safe: it reuses the shared
``IdempotencyKey`` table (scope ``tuzi-grant``) exactly as the paid HTTP routes
do. The same key with the same amount replays the original receipt and credits
nothing; the same key with a different amount is refused. A receipt that some
other path wrote for this account under the same key counts too: re-running a
failed sign-up welcome grant by hand with the ``--idempotency-key`` from its
``welcome_grant_failed`` log line replays (or refuses) instead of paying twice if
the original landed after all.

``--dry-run`` validates everything, prints what it would do, and writes
nothing -- not the credit, not the receipt, not an idempotency claim.

Example::

    manage.py grant_tuzis f2z-smoke 5 --reason "upload smoke tier " \\
        --operator dbcopy --idempotency-key dbcopy-stage-20260923T120000Z
"""
import getpass
import json
import os
import re
from decimal import Decimal

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from dj.apps.tuzis import ledger
from dj.apps.tuzis.grants import (
    GLOBAL_KEY_PREFIX,
    PROD_NAMES,
    AlreadyGranted,
    describe_environment,
    issue_grant,
)
from dj.apps.tuzis.models import (
    DuplicateRequest,
    IdempotencyConflict,
    IdempotencyKey,
    TuziGrant,
    claim,
    fingerprint,
    release,
)

IDEMPOTENCY_SCOPE = "tuzi-grant"
MIN_REASON_CHARS = 10
#Grants above this need ``--i-mean-it``. The smoke persona needs 5; a support
#make-good is tens. A four-digit grant is far more likely a typo (an extra
#zero, a cents/2Z mixup) than an intent.
LARGE_GRANT = Decimal("1000")
_KEY_RE = re.compile(r"[A-Za-z0-9._:-]{1,200}")

# `describe_environment` and `PROD_NAMES` moved to dj.apps.tuzis.grants
#  so the welcome grant records its environment the same way; they are
# re-exported here for callers and tests that import them from the command.
__all__ = ["Command", "describe_environment", "PROD_NAMES", "LARGE_GRANT"]


def _os_user():
    try:
        return getpass.getuser()
    except Exception:
        return ""


class Command(BaseCommand):
    help = (
        "Grant 2Z platform credits to one account through the ledger, with a "
        "required reason and an audit receipt (TuziGrant)"
    )

    def add_arguments(self, parser):
        parser.add_argument("username", help="Account to credit (exact, case-insensitive).")
        parser.add_argument("amount", help="2Z to grant; positive, at most 3 decimals.")
        parser.add_argument(
            "--reason", required=True,
            help=f"Why (at least {MIN_REASON_CHARS} characters). Stored on the receipt.",
        )
        parser.add_argument(
            "--operator", default=None,
            help="Who is issuing this grant (defaults to $USER / the OS user).",
        )
        parser.add_argument(
            "--idempotency-key", default=None,
            help="Makes a retry safe: the same key never credits twice.",
        )
        parser.add_argument(
            "--dry-run", action="store_true",
            help="Validate and print; write nothing.",
        )
        parser.add_argument(
            "--i-mean-it", action="store_true", dest="i_mean_it",
            help=f"Required for a grant above {LARGE_GRANT} 2Z.",
        )
        parser.add_argument(
            "--allow-prod", action="store_true",
            help="Required when the target is production.",
        )

    def handle(self, *args, **options):
        env = describe_environment()
        # First line of output, whatever happens next: an operator who ran
        # this against the wrong database learns it before anything is
        # written, and the build log of a scripted caller records it.
        self.stdout.write(f"grant_tuzis: environment: {env['summary']}")

        username = (options["username"] or "").strip()
        reason = (options["reason"] or "").strip()
        operator = (
            options["operator"] if options["operator"] is not None
            else (os.environ.get("USER") or _os_user())
        ).strip()
        key = options["idempotency_key"]
        dry_run = options["dry_run"]

        amount = self._parse_amount(options["amount"])
        if amount > LARGE_GRANT and not options["i_mean_it"]:
            raise CommandError(
                f"refusing a grant of {amount} 2Z: anything above {LARGE_GRANT} "
                "requires --i-mean-it"
            )
        if len(reason) < MIN_REASON_CHARS:
            raise CommandError(
                f"--reason must be at least {MIN_REASON_CHARS} characters; "
                "it is the only record of why this balance changed"
            )
        if not operator:
            raise CommandError("--operator is empty and no $USER is set")
        if len(operator) > TuziGrant._meta.get_field("operator").max_length:
            raise CommandError("--operator is too long")
        if key is not None and not _KEY_RE.fullmatch(key):
            raise CommandError(
                "--idempotency-key must be 1-200 characters of [A-Za-z0-9._:-]"
            )
        if env["is_prod"] and not options["allow_prod"]:
            raise CommandError(
                f"refusing to grant 2Z in production ({env['summary']}) "
                "without --allow-prod"
            )

        creator = self._resolve(username)
        request_hash = fingerprint(
            {"creator_id": creator.pk, "amount": str(amount)})

        if dry_run:
            self._dry_run(creator, amount, reason, operator, key, request_hash, env)
            return

        record = None
        if key is not None:
            try:
                record = claim(
                    IDEMPOTENCY_SCOPE, creator, key, request_hash=request_hash)
            except IdempotencyConflict:
                raise CommandError(
                    f"--idempotency-key {key!r} was already used for a "
                    f"different grant to {creator.username}; refusing"
                )
            except DuplicateRequest as dup:
                if dup.in_flight:
                    raise CommandError(
                        f"--idempotency-key {key!r} is claimed by a grant "
                        "that is still running (or died less than 15 minutes "
                        "ago); nothing credited, retry later"
                    )
                body = dup.record.response_body or {}
                self.stdout.write(
                    f"grant_tuzis: REPLAY: key {key!r} already granted "
                    f"{body.get('amount')} 2Z to {creator.username} "
                    f"(receipt {body.get('grant_id')}); nothing credited"
                )
                self._log("replay", creator, amount, reason, operator, key, env,
                          grant_id=body.get("grant_id"))
                return

        replayed = False
        try:
            with transaction.atomic():
                # `issue_grant` (dj.apps.tuzis.grants) writes the receipt, the
                # credit (`sys:promo -> user`, keyed on the receipt) and the
                # balance the credit reported, all or nothing. The
                # IdempotencyKey claim (`tuzi-grant` scope) stays the outer
                # exactly-once marker for a re-run of this command; the
                # receipt check inside `issue_grant` is the one that also
                # covers a grant some OTHER path wrote under the same key --
                # the welcome grant's `welcome-grant:<id>`.
                try:
                    grant, balance = issue_grant(
                        creator, amount,
                        reason=reason,
                        operator=operator,
                        environment=env["summary"],
                        idempotency_key=key or "",
                    )
                except AlreadyGranted as already:
                    grant = already.grant
                    if grant.creator_id != creator.pk:
                        # A global `welcome-grant:` key (dj.apps.tuzis.grants):
                        # this external identity was already welcomed on a
                        # different account it has since been unlinked from.
                        raise CommandError(
                            f"--idempotency-key {key!r} already granted "
                            f"{grant.amount} 2Z to a different account "
                            f"({grant.username}, receipt TuziGrant #{grant.pk}); "
                            "a welcome key pays one account, ever; refusing"
                        )
                    if grant.amount != amount:
                        raise CommandError(
                            f"--idempotency-key {key!r} already granted "
                            f"{grant.amount} 2Z to {creator.username} "
                            f"(receipt TuziGrant #{grant.pk}); refusing a "
                            f"different amount ({amount})"
                        )
                    balance = grant.balance_after
                    replayed = True
                if record is not None:
                    # Inside the same transaction as the credit: that is the
                    # invariant that makes IdempotencyKey's stale takeover
                    # safe (see STALE_CLAIM in dj.apps.tuzis.models).
                    record.finish(200, {
                        "grant_id": grant.pk,
                        "amount": str(grant.amount),
                        "balance_after": str(grant.balance_after),
                    })
        except BaseException:
            release(record)
            raise

        if replayed:
            self.stdout.write(
                f"grant_tuzis: REPLAY: key {key!r} already granted "
                f"{grant.amount} 2Z to {creator.username} "
                f"(receipt {grant.pk}); nothing credited"
            )
            self._log("replay", creator, amount, reason, operator, key, env,
                      grant_id=grant.pk)
            return

        self._log("granted", creator, amount, reason, operator, key, env,
                  grant_id=grant.pk, balance_after=str(balance))
        self.stdout.write(self.style.SUCCESS(
            f"grant_tuzis: GRANTED {amount} 2Z to {creator.username} "
            f"(balance now {balance}; receipt TuziGrant #{grant.pk})"
        ))

    # -- helpers -----------------------------------------------------------

    def _parse_amount(self, raw):
        try:
            exact = Decimal(str(raw).strip())
            amount = ledger.to_tuzis(exact)
        except (ArithmeticError, ValueError):
            raise CommandError(f"not a valid 2Z amount: {raw!r}")
        if not exact.is_finite() or amount <= 0:
            raise CommandError(f"refusing a grant of {raw!r}: the amount must be positive")
        if amount != exact:
            raise CommandError(
                f"refusing {raw!r}: the ledger stores 3 decimal places and "
                "would round it"
            )
        return amount

    def _resolve(self, username):
        from dj.apps.g12f.models import Creator

        # _base_manager: never let a default-manager filter turn "this account
        # is deactivated" into the less accurate "no such account".
        matches = list(
            Creator._base_manager.filter(username__iexact=username)[:2])
        if not matches:
            raise CommandError(f"no account named {username!r}")
        if len(matches) > 1:
            raise CommandError(
                f"{username!r} matches more than one account case-insensitively; "
                "refusing to guess"
            )
        creator = matches[0]
        if not creator.is_active:
            raise CommandError(
                f"{creator.username!r} is deactivated; refusing to grant"
            )
        return creator

    def _dry_run(self, creator, amount, reason, operator, key, request_hash, env):
        note = ""
        if key is not None:
            existing = IdempotencyKey.objects.filter(
                scope=IDEMPOTENCY_SCOPE, user=creator, key=key).first()
            receipts = TuziGrant.objects.filter(idempotency_key=key)
            if not key.startswith(GLOBAL_KEY_PREFIX):
                receipts = receipts.filter(creator=creator)
            receipt = receipts.order_by("pk").first()
            if existing is None and receipt is not None:
                # Written by another path under this key (the sign-up
                # welcome grant, ): issue_grant would find it.
                verdict = (
                    "would refuse: a different account"
                    if receipt.creator_id != creator.pk
                    else "would replay, credit nothing" if receipt.amount == amount
                    else "would refuse: different amount"
                )
                note = (
                    f"; key {key!r} already granted {receipt.amount} 2Z by "
                    f"receipt TuziGrant #{receipt.pk} ({verdict})"
                )
            elif existing is None:
                note = f"; key {key!r} is unused"
            elif existing.request_hash != request_hash:
                note = f"; key {key!r} was used for a DIFFERENT grant (would refuse)"
            elif existing.response_status is None:
                note = f"; key {key!r} is claimed by a running grant (would refuse)"
            else:
                note = f"; key {key!r} already granted (would replay, credit nothing)"
        self._log("dry_run", creator, amount, reason, operator, key, env)
        self.stdout.write(
            f"grant_tuzis: DRY RUN: would grant {amount} 2Z to "
            f"{creator.username} (balance {creator.tuzis}) by {operator}: "
            f"{reason!r}{note}. Nothing written."
        )

    def _log(self, outcome, creator, amount, reason, operator, key, env, **extra):
        payload = {
            "severity": "WARNING",
            "event": "tuzi_grant",
            "message": (
                f"grant_tuzis: {outcome} {amount} 2Z to {creator.username} "
                f"by {operator} in {env['database']}"
            ),
            "outcome": outcome,
            "username": creator.username,
            "creator_id": creator.pk,
            "amount": str(amount),
            "reason": reason[:400],
            "operator": operator,
            "idempotency_key": key,
            "namespace": env["namespace"],
            "database": env["database"],
            **extra,
        }
        # One line, entirely JSON, on stdout: Cloud Logging promotes that to
        # jsonPayload (see dj.free2z.log_json), so a grant is queryable by
        # `jsonPayload.event="tuzi_grant"` wherever this runs.
        self.stdout.write(json.dumps(payload, sort_keys=True, default=str))
