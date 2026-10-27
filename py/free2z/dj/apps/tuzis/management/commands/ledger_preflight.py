"""Prove, as the connected role, that the 2Z ledger can serve money paths.

Run by the Cloud Build ``migrate`` step right after ``manage.py migrate``
, so a failure aborts the release BEFORE ``bazel-apply`` rolls a pod.

WHY. Since the dual-write release every spend, credit, transfer and
reservation in the product is a call to a ``ledger.*`` SQL function. L1
 ``REVOKE``d ``EXECUTE`` on all of them from ``PUBLIC``: only their
owner -- the role that ran the migration -- may execute them. If the role
the app pods connect as is not that owner, nothing fails at migrate time
and nothing fails at startup; the first vote after the rollout is a 500,
and so is every one after it. This command asks Postgres the exact
question, as the role it is connected as, and refuses with a message that
names the function.

READ-ONLY: three catalog queries and two ``SELECT count(*)``. It executes
no ledger function (that would move nothing, but the point is to prove the
privilege, not to exercise it).

Exit 0: every function the wrappers call is executable by ``current_user``,
the ``sys:*`` rows are all present, ``ledger_config`` has its one row.
Nonzero (``CommandError``) with the first failing condition spelled out.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError
from django.db import connection

from dj.apps.ledger.system_accounts import SYSTEM_ACCOUNTS

#Every ``ledger.*`` function ``dj.apps.ledger.api`` calls directly (the
#rest are called from inside these, as their SECURITY DEFINER owner, and
#need no grant to the caller). Kept in step by
#``tuzis/test_ledger_preflight.py``, which reads ``api.py``.
WRAPPER_FUNCTIONS = (
    "lock_creator", "lock_account", "sys", "ensure_account", "debt",
    "post_transfer", "credit_with_repay",
    "spend", "spend_up_to", "transfer_users",
    "credit_user", "credit_purchase",
    "clawback", "refund_purchase", "restore_purchase",
)


def check() -> list[str]:
    """Every failing condition, as one line each; empty means go."""
    problems = []
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_user")
        role = cursor.fetchone()[0]
        cursor.execute(
            "SELECT p.proname, has_function_privilege(current_user, p.oid, 'EXECUTE') "
            "  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
            " WHERE n.nspname = 'ledger' ORDER BY 1"
        )
        found = dict(cursor.fetchall())
        for name in WRAPPER_FUNCTIONS:
            if name not in found:
                problems.append(f"ledger.{name} does not exist (has the ledger migration run?)")
            elif not found[name]:
                problems.append(
                    f"role {role!r} cannot EXECUTE ledger.{name}: L1 revoked it from PUBLIC, so the "
                    "app must connect as the function owner (the role that ran the migration) or be "
                    "GRANTed EXECUTE explicitly"
                )
        cursor.execute("SELECT key FROM ledger_account WHERE journal_only ORDER BY key")
        present = {row[0] for row in cursor.fetchall()}
        for key, _kind in SYSTEM_ACCOUNTS:
            if key not in present:
                problems.append(f"system account {key} is missing from ledger_account")
        cursor.execute("SELECT count(*) FROM ledger_config")
        if cursor.fetchone()[0] != 1:
            problems.append("ledger_config does not have exactly one row")
    return problems


class Command(BaseCommand):
    help = (
        "Refuse the deploy if the connected role cannot execute the ledger.* "
        "functions every money path needs, or the seed rows are missing (#2220)."
    )

    def handle(self, *args, **options):
        problems = check()
        with connection.cursor() as cursor:
            cursor.execute("SELECT current_user")
            role = cursor.fetchone()[0]
        if problems:
            raise CommandError(
                "ledger_preflight: refusing to roll pods -- every 2Z money path would 500:\n  "
                + "\n  ".join(problems)
            )
        self.stdout.write(self.style.SUCCESS(
            f"ledger_preflight: OK as {role!r}: {len(WRAPPER_FUNCTIONS)} ledger functions "
            f"executable, {len(SYSTEM_ACCOUNTS)} system accounts, ledger_config present"
        ))
