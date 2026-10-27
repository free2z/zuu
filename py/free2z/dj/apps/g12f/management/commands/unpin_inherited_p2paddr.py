"""Un-pin profile addresses the new-UI editor copied onto zPages.

    python manage.py unpin_inherited_p2paddr                    # dry run
    python manage.py unpin_inherited_p2paddr --execute
    python manage.py unpin_inherited_p2paddr --since 2026-07-14 --execute

The bug
-------
Until  the new-UI editor hydrated its Zcash address field from the read
representation's ``p2paddr`` -- the EFFECTIVE address, i.e. the page's own
address or, when it has none, the creator's profile address -- and saved it
back. Opening and saving an article that inherited the profile address
therefore wrote a copy of that address into ``zPage.p2paddr``, and a later
profile address change (a retired or compromised wallet) no longer reached
the article.

What this does
--------------
Clears ``zPage.p2paddr`` back to ``""`` (inherit) for pages whose own address
is **byte-identical to their creator's current profile address** and which
were last written **on or after** ``--since``.

Why that is safe to run
-----------------------
**It moves no money today.** Every selected row's effective address is the
same before and after: the page's copy and the profile address are equal, and
an empty page address falls back to exactly that profile address. The only
behavioural change is the future one the creator almost certainly wanted --
the page follows the profile when the profile changes.

**It is conservative about deliberate choices.** A creator who typed their
profile address into the page on purpose is indistinguishable from the bug in
the database: nothing records which client last wrote a row. ``--since``
therefore defaults to the day the new-UI editor reached ``main``, so the command only touches rows the buggy path could have
written. The classic React editor has blanked a page address equal to the
creator's since 2023 (``ts/react/free2z/src/EditPage.tsx``), so a classic save
in that window could not have produced such a row either.

**It never touches a page whose address differs from the profile.** A pinned
copy whose creator has ALREADY rotated their profile address now looks like a
deliberate override and is out of scope: clearing it would move support to a
different wallet, which is a decision for the creator, not a backfill.

**Each page is a compare-and-swap in its own short transaction** (see
``_clear_one``), so a creator who changes their page address after the
selection -- even one whose save is in flight when the command reaches their
row -- is not un-pinned from a stale reading, and the command never holds one
lock while waiting for another. A row that stays busy past
``--lock-timeout-ms`` is skipped and reported, not waited on forever.
``updated_at`` is left alone: this is not an edit by the creator. (``p2paddr`` is part of the zPage ETag, so
an editor tab that is open across the run gets an honest 412 and reloads.)

Idempotent: a cleared page leaves the selection, so a second run does nothing.
"""
import datetime

from django.core.management.base import BaseCommand, CommandError
from django.db import OperationalError, connection, transaction
from django.db.models import F
from django.utils import timezone

from dj.apps.g12f.models import Creator, zPage

#SQLSTATE ``lock_not_available``: ``lock_timeout`` expired.
LOCK_NOT_AVAILABLE = "55P03"

#merged the new UI into main on this day; the editor that pins the
#effective address shipped with it.
NEW_UI_EDITOR_SINCE = datetime.date(2026, 7, 14)


def pinned_copies(since: datetime.datetime):
    """Pages whose own address is a copy of the creator's current one."""
    return (
        zPage.objects
        .exclude(p2paddr="")
        .filter(p2paddr=F("creator__p2paddr"), updated_at__gte=since)
    )


class Command(BaseCommand):
    help = (
        "Clear zPage.p2paddr where it is a copy of the creator's current "
        "profile address written since the new-UI editor shipped (#2061). "
        "Dry run unless --execute."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--since",
            default=NEW_UI_EDITOR_SINCE.isoformat(),
            help=(
                "Only pages last written on or after this date (YYYY-MM-DD, "
                f"UTC). Default {NEW_UI_EDITOR_SINCE.isoformat()}."
            ),
        )
        parser.add_argument(
            "--lock-timeout-ms",
            type=int,
            default=5000,
            help="How long to wait for one busy page row before skipping it.",
        )
        parser.add_argument(
            "--execute",
            action="store_true",
            help="Write. Without it, report what would change and exit.",
        )

    def handle(self, *args, since, execute, lock_timeout_ms, **options):
        try:
            day = datetime.date.fromisoformat(since)
        except ValueError as exc:
            raise CommandError(f"--since must be YYYY-MM-DD: {exc}") from exc
        since_dt = datetime.datetime.combine(
            day, datetime.time.min, tzinfo=datetime.timezone.utc,
        )

        rows = list(
            pinned_copies(since_dt)
            .order_by("updated_at")
            .values_list("id", "creator_id", "updated_at")
        )
        creators = {creator_id for _, creator_id, _ in rows}
        self.stdout.write(
            f"{len(rows)} page(s) across {len(creators)} creator(s) carry a "
            f"copy of their creator's current address, written since "
            f"{day.isoformat()}."
        )
        for page_id, creator_id, updated_at in rows:
            self.stdout.write(
                f"  page {page_id}  creator {creator_id}  "
                f"updated {timezone.localtime(updated_at, datetime.timezone.utc):%Y-%m-%d}"
            )

        if not execute:
            self.stdout.write("Dry run: nothing written. Re-run with --execute.")
            return

        cleared = skipped = 0
        for page_id, creator_id, _ in rows:
            outcome = self._clear_one(page_id, creator_id, since_dt, lock_timeout_ms)
            cleared += outcome == "cleared"
            if outcome == "locked":
                skipped += 1
                self.stdout.write(
                    f"  page {page_id}: row busy for {lock_timeout_ms} ms, "
                    "skipped -- re-run to retry"
                )
        self.stdout.write(
            f"Cleared {cleared} page address(es). Skipped {skipped} busy page(s)."
        )

    @staticmethod
    def _clear_one(page_id, creator_id, since_dt, lock_timeout_ms) -> str:
        """Compare-and-swap ONE page, in its own short transaction.

        Not ``pinned_copies(...).update()``: that compiles to ``UPDATE...
        WHERE id IN (SELECT... JOIN creator...)``, whose comparison runs in
        the subquery's snapshot, so a deliberate new page address committed
        while the UPDATE waited on the row lock was erased (codex review).

        Here the page's expected value is a literal in the UPDATE's own WHERE
        (``p2paddr = <creator's address, read now>``). Postgres re-evaluates
        that against the committed row after any lock wait, so a page that
        moved to another address is left alone.

        One statement, one row lock, per transaction: the command never holds
        a lock while waiting for another, so it cannot join a deadlock with
        the ledger's creator-then-page or page-then-creator orders, and it
        never makes unrelated creators' writes queue behind a slow row. The
        creator row is read, not locked -- if the profile address changes in
        the same instant, the page ends up inheriting the NEW profile address,
        which is exactly what running a moment later would have done.
        ``lock_timeout`` bounds the wait; a busy row is skipped and reported.
        """
        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    # SET takes no bind parameters; int() makes this safe.
                    cursor.execute(
                        f"SET LOCAL lock_timeout = '{int(lock_timeout_ms)}ms'"
                    )
                address = (
                    Creator.objects.filter(pk=creator_id)
                    .values_list("p2paddr", flat=True)
                    .first()
                )
                if not address:
                    return "changed"
                updated = zPage.objects.filter(
                    pk=page_id, p2paddr=address, updated_at__gte=since_dt,
                ).update(p2paddr="")
        except OperationalError as exc:
            cause = exc.__cause__
            # psycopg 3 names it `sqlstate`, psycopg2 `pgcode`.
            code = getattr(cause, "sqlstate", None) or getattr(cause, "pgcode", None)
            if code == LOCK_NOT_AVAILABLE:
                return "locked"
            raise
        return "cleared" if updated else "changed"
