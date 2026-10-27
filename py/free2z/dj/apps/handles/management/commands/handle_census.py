"""``manage.py handle_census`` -- what the handle migration did, or will do.

READ-ONLY BY DEFAULT. The default run executes inside a PostgreSQL
``READ ONLY`` transaction, so it cannot write even by mistake, and prints only
counts. Safe to run against a staging copy; against production it is still
only ``SELECT``s, but run it as a detached Job, never through ``kubectl exec``
(``docs/agent-operations.md``).

Output
------

Counts only, unless ``--show-groups``. The groups listing prints account id,
username, join date and active flag for each case-variant group -- the same
fields the Django admin's Creator list already shows to staff -- and nothing
else: no email, no name, no IP. It goes to stdout, never to the application
log.

* ``accounts``: total, active.
* ``eligibility``: eligible after ASCII lowercasing, and ineligible split by
  the client's reason codes (``punctuation``, ``non-ascii``, ``too-long``), each
  with its active count. Plus eligible usernames that are reserved words.
* ``username_case_groups``: groups of usernames equal under PostgreSQL
  ``LOWER()`` -- the rule the new unique index uses -- the accounts in them,
  the largest group, and how many groups' earliest account (the one that keeps
  the name and the handle) is inactive. That last number is the one to read
  before trusting "earliest-created wins".
* ``handle_collision_groups``: the same, restricted to eligible usernames:
  the groups where a real account is left without its handle.
* ``handles`` (only once the table exists): rows by status and source,
  eligible accounts without a handle, and rows still exempt from the
  username index (``username_ci_legacy`` equal to the username).
* ``plan``: what ``reserve_username_handles`` would do right now.

``--apply`` runs that reservation for real (idempotent, the same function
migration 0002 ran). It exists to pick up accounts created by pods on the
previous release while the migration was deploying; it never changes a
username and never touches an existing handle.
"""

import json
from collections import Counter

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import connection, transaction
from django.db.models import Count, F, Min
from django.db.models.functions import Lower

from dj.apps.handles import policy
from dj.apps.handles.reservation import reserve_username_handles


class Command(BaseCommand):
    help = (
        "Messaging-handle census: username eligibility, case-variant groups "
        "and handle bindings. Read-only unless --apply."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--json", action="store_true", help="Emit one JSON document."
        )
        parser.add_argument(
            "--show-groups",
            action="store_true",
            help=(
                "List each case-variant username group (id, username, "
                "date_joined, is_active). Staff-visible fields only."
            ),
        )
        parser.add_argument(
            "--apply",
            action="store_true",
            help=(
                "Reserve handles for eligible accounts that have none "
                "(idempotent). Without this flag nothing is written."
            ),
        )

    def handle(self, *args, **options):
        if options["apply"]:
            report = self._census(show_groups=options["show_groups"])
            with transaction.atomic():
                report["applied"] = self._reserve().as_dict()
        else:
            with transaction.atomic():
                if connection.vendor == "postgresql":
                    with connection.cursor() as cursor:
                        cursor.execute("SET TRANSACTION READ ONLY")
                report = self._census(show_groups=options["show_groups"])
                report["plan"] = self._plan()

        if options["json"]:
            self.stdout.write(json.dumps(report, indent=2, sort_keys=True))
        else:
            self._print(report)

    # ------------------------------------------------------------------

    def _census(self, *, show_groups):
        Creator = get_user_model()
        accounts = Creator._default_manager.all()

        eligibility = Counter()
        eligibility_active = Counter()
        reserved_words = 0
        for username, is_active in accounts.values_list(
            "username", "is_active"
        ).iterator(chunk_size=5000):
            candidate, reason = policy.eligibility(username)
            key = "eligible" if candidate is not None else reason
            eligibility[key] += 1
            if is_active:
                eligibility_active[key] += 1
            if candidate is not None and policy.is_reserved(candidate):
                reserved_words += 1

        report = {
            "accounts": {
                "total": accounts.count(),
                "active": accounts.filter(is_active=True).count(),
            },
            "eligibility": {
                key: {"total": eligibility[key], "active": eligibility_active[key]}
                for key in (
                    "eligible",
                    policy.REASON_PUNCTUATION,
                    policy.REASON_NON_ASCII,
                    policy.REASON_TOO_LONG,
                )
            },
            "eligible_but_reserved_word": reserved_words,
            "username_case_groups": self._groups(accounts, eligible_only=False),
            "handle_collision_groups": self._groups(accounts, eligible_only=True),
        }
        if show_groups:
            report["groups"] = self._group_listing(accounts)
        if self._handles_table_exists():
            report["handles"] = self._handles_summary(accounts)
        return report

    def _groups(self, accounts, *, eligible_only):
        folded = accounts.annotate(folded=Lower("username"))
        if eligible_only:
            folded = folded.filter(folded__regex=r"^[a-z0-9_]{1,30}$")
        groups = (
            folded.values("folded")
            .annotate(n=Count("pk"), first_joined=Min("date_joined"))
            .filter(n__gt=1)
        )
        sizes = [g["n"] for g in groups]
        inactive_winner = 0
        for group in groups:
            winner = (
                folded.filter(folded=group["folded"])
                .order_by("date_joined", "pk")
                .values_list("is_active", flat=True)
                .first()
            )
            if not winner:
                inactive_winner += 1
        return {
            "groups": len(sizes),
            "accounts": sum(sizes),
            "accounts_left_without_the_name": sum(sizes) - len(sizes),
            "largest": max(sizes, default=0),
            "groups_whose_earliest_account_is_inactive": inactive_winner,
        }

    def _group_listing(self, accounts):
        folded = accounts.annotate(folded=Lower("username"))
        keys = (
            folded.values("folded")
            .annotate(n=Count("pk"))
            .filter(n__gt=1)
            .values_list("folded", flat=True)
        )
        listing = []
        for key in sorted(keys):
            members = folded.filter(folded=key).order_by("date_joined", "pk")
            listing.append([
                {
                    "id": m.pk,
                    "username": m.username,
                    "date_joined": m.date_joined.isoformat(),
                    "is_active": m.is_active,
                    "keeps_name": index == 0,
                }
                for index, m in enumerate(members.only(
                    "pk", "username", "date_joined", "is_active"
                ))
            ])
        return listing

    @staticmethod
    def _handles_table_exists():
        from dj.apps.handles.models import MessagingHandle

        return (
            MessagingHandle._meta.db_table
            in connection.introspection.table_names()
        )

    def _handles_summary(self, accounts):
        from dj.apps.handles.models import MessagingHandle

        rows = MessagingHandle.objects.all()
        by = Counter(rows.values_list("status", "source"))
        bound_users = rows.filter(status="bound").values("user_id")
        without = 0
        for username in accounts.exclude(pk__in=bound_users).values_list(
            "username", flat=True
        ).iterator(chunk_size=5000):
            if policy.eligibility(username)[0] is not None:
                without += 1
        summary = {
            "rows": {f"{status}/{source}": n for (status, source), n in sorted(by.items())},
            "accounts_bound": rows.filter(status="bound").count(),
            "eligible_accounts_without_a_handle": without,
        }
        if any(f.name == "username_ci_legacy" for f in accounts.model._meta.fields):
            summary["username_ci_legacy"] = accounts.filter(
                username_ci_legacy=F("username")
            ).count()
        return summary

    def _reserve(self, *, dry_run=False):
        from dj.apps.handles.models import MessagingHandle

        return reserve_username_handles(
            get_user_model(), MessagingHandle, dry_run=dry_run
        )

    def _plan(self):
        """What --apply would do, computed with reads only."""
        if not self._handles_table_exists():
            return "handles table not migrated yet"
        return self._reserve(dry_run=True).as_dict()

    def _print(self, report, indent=0):
        pad = "  " * indent
        for key, value in report.items():
            if isinstance(value, dict):
                self.stdout.write(f"{pad}{key}:")
                self._print(value, indent + 1)
            elif isinstance(value, list):
                self.stdout.write(f"{pad}{key}: {len(value)}")
                for group in value:
                    self.stdout.write(f"{pad}  - " + "; ".join(
                        f"{m['id']} {m['username']!r} {m['date_joined']}"
                        f"{'' if m['is_active'] else ' inactive'}"
                        f"{' KEEPS' if m['keeps_name'] else ''}"
                        for m in group
                    ))
            else:
                self.stdout.write(f"{pad}{key}: {value}")
