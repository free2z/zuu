"""Retire one unroutable ZEC note after a human decision.

Two kinds of note land in the queue: an unreadable ``buy_2z`` memo seen by
``credit_creators``, and a page memo seen by ``credit_pages_unified``
that names a zPage which does not exist or does not parse. The
listing prints each row's classification and, for page rows, the action and
page id the memo named -- what an operator needs to refund the payer
(``--decision refunded``) or record the funding on the intended page by hand
(``--decision ignore`` with the reference in ``--reason``).

This command is the only supported write path for ``ZecMemoDisposition``.
It records an operator's decision for a specific note, but it does not issue
2Z, alter a balance, create a ``ZecCreditReceipt``, or touch the wallet. A
disposition is an audit and monitoring control, never financial authority.

Examples::

    manage.py dispose_zec_memo TXID --pool sapling --output-index 0 \
        --amount-zec 0.50000000 --decision credited_manually \
        --reason 'Customer was credited through the support ledger' \
        --operator ops --yes

Without ``--yes`` the command only prints the note identity and decision it
would record. A repeated invocation with the exact same arguments is safe; a
different decision or audit data for an existing note is refused.
"""
import getpass
from decimal import Decimal, InvalidOperation

from django.core.management.base import BaseCommand, CommandError

from dj.apps.tuzis.models import ZecCreditReceipt, ZecMemoDisposition
from dj.apps.tuzis.zec import (
    canonical_disposition_note,
    ZecMemoDispositionConflict,
    ZecMemoDispositionNotObserved,
    record_zec_memo_disposition,
)

MAX_LIST_LIMIT = 100


def _os_user():
    try:
        return getpass.getuser()
    except Exception:
        return "unknown"


class Command(BaseCommand):
    help = (
        "Record a human disposition for an unroutable ZEC note (unreadable "
        "buy_2z memo, or a page memo naming no zPage); this does not issue "
        "or reverse any 2Z and moves no ZEC"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "txid", nargs="?",
            help="Display-byte-order 64-hex transaction id. Omit to list "
                 "observed dispositions.",
        )
        parser.add_argument(
            "--pool", default=None, help="Pool name: sapling, orchard, or ironwood.",
        )
        parser.add_argument(
            "--output-index", type=int, default=None,
            help="Explicit pool-local output/action index.",
        )
        parser.add_argument(
            "--amount-zec", dest="amount_zec",
            help="Exact positive on-chain amount in ZEC, up to 8 decimals.",
        )
        parser.add_argument(
            "--decision", choices=[choice[0] for choice in
                                   ZecMemoDisposition.DECISION_CHOICES],
            help="Human decision that retires this note from the signal.",
        )
        parser.add_argument(
            "--reason", default="",
            help="Required audit reason for the decision.",
        )
        parser.add_argument(
            "--operator", default="",
            help="Audit identity (defaults to the OS user).",
        )
        parser.add_argument(
            "--yes", action="store_true",
            help="Actually record the disposition; otherwise do a dry run.",
        )
        parser.add_argument(
            "--all", action="store_true", dest="list_all",
            help="When listing, include already resolved observations.",
        )
        parser.add_argument(
            "--limit", type=int, default=50,
            help=f"Listing page size (1-{MAX_LIST_LIMIT}, default: 50).",
        )
        parser.add_argument(
            "--offset", type=int, default=0,
            help="Number of listing rows to skip (default: 0).",
        )

    def handle(self, *args, **options):
        txid = options["txid"]
        if not txid:
            self._list_dispositions(
                include_resolved=options["list_all"],
                limit=options["limit"], offset=options["offset"],
            )
            return

        pool = options["pool"]
        if pool is None or options["output_index"] is None:
            raise CommandError(
                "--pool and --output-index are required; an observation "
                "cannot use an identity fallback"
            )
        try:
            txid, pool, output_index = canonical_disposition_note({
                "txid": txid,
                "pool": pool,
                "output_index": options["output_index"],
            })
        except ValueError as exc:
            raise CommandError(str(exc)) from exc
        if not options["amount_zec"]:
            raise CommandError("--amount-zec is required when recording a disposition")
        if not options["decision"]:
            raise CommandError(
                "--decision is required when recording a disposition"
            )

        operator = options["operator"] or _os_user()
        reason = options["reason"].strip()
        if not reason:
            raise CommandError("--reason must not be empty")

        try:
            # The helper performs the exact Decimal/8-decimal validation too;
            # doing it for the dry run keeps the preview honest.
            amount_text = options["amount_zec"]
            disposition_amount = _validated_amount(amount_text)
        except ValueError as exc:
            raise CommandError(str(exc)) from exc

        if options["decision"] == ZecMemoDisposition.CREDITED_MANUALLY:
            # A disposition is audit state, never evidence that a balance was
            # changed. Only a canonical receipt for this exact note, amount,
            # and non-backfilled creator can support this decision. Without
            # that proof a later parser repair would send the note through
            # credit_zec_purchase and issue a second credit.
            receipt_exists = ZecCreditReceipt.objects.filter(
                txid=txid,
                pool=pool,
                output_index=output_index,
                amount_zec=disposition_amount,
                creator__isnull=False,
                backfilled=False,
                tuzis_credited__isnull=False,
            ).exists()
            if not receipt_exists:
                raise CommandError(
                    "credited_manually requires a canonical same-note "
                    "ZecCreditReceipt with a non-backfilled creator and "
                    "recorded 2Z amount; no audit disposition was written"
                )

        note = f"{txid}:{pool}:{output_index}"
        if not options["yes"]:
            self.stdout.write(
                f"WOULD RECORD disposition note={note} "
                f"amount_zec={disposition_amount:f} "
                f"decision={options['decision']} operator={operator}"
            )
            self.stdout.write(
                "DRY RUN: nothing was written. Re-run with --yes to record "
                "the audit row."
            )
            return

        try:
            disposition, created = record_zec_memo_disposition(
                txid=txid,
                pool=pool,
                output_index=output_index,
                amount_zec=disposition_amount,
                decision=options["decision"],
                operator=operator,
                reason=reason,
            )
        except (ValueError, ZecMemoDispositionConflict,
                ZecMemoDispositionNotObserved) as exc:
            raise CommandError(str(exc)) from exc

        if created:
            self.stdout.write(
                f"RECORDED disposition note={disposition} "
                f"amount_zec={disposition.amount_zec} "
                f"decision={disposition.decision} operator={disposition.operator}; "
                "no 2Z were issued or changed"
            )
        else:
            self.stdout.write(
                f"ALREADY RECORDED disposition note={disposition} "
                f"decision={disposition.decision}; no 2Z were issued or changed"
            )

    def _list_dispositions(self, *, include_resolved, limit, offset):
        if not 1 <= limit <= MAX_LIST_LIMIT:
            raise CommandError(
                f"--limit must be between 1 and {MAX_LIST_LIMIT}")
        if offset < 0:
            raise CommandError("--offset must be non-negative")
        rows = ZecMemoDisposition.objects.all()
        if not include_resolved:
            rows = rows.filter(decision__isnull=True)
        total = rows.count()
        page = list(rows.order_by("created_at", "id")[offset:offset + limit])
        if not page:
            self.stdout.write(
                f"No {'ZEC memo dispositions' if include_resolved else 'unresolved ZEC memo observations'} "
                f"in page offset={offset} limit={limit} (total={total})."
            )
            return
        self.stdout.write(
            f"Showing {offset + 1}-{offset + len(page)} of {total} "
            f"{'ZEC memo dispositions' if include_resolved else 'unresolved ZEC memo observations'} "
            f"(limit={limit}):"
        )
        for row in page:
            memo = ""
            if row.memo_action or row.memo_target:
                # Sender-chosen text: repr() so a newline or control character
                # in a page id cannot forge a second listing row.
                memo = (f" memo_action={row.memo_action!r} "
                        f"memo_target={row.memo_target!r}")
            self.stdout.write(
                f"  {row} amount_zec={row.amount_zec} "
                f"classification={row.classification}{memo} "
                f"decision={row.decision} operator={row.operator} "
                f"reason={row.reason} created_at={row.created_at.isoformat()}"
            )


def _validated_amount(value):
    # Keep the command's dry-run validation aligned with the write helper
    # without importing Decimal parsing policy into the argument parser.
    try:
        amount = Decimal(str(value))
        quantized = amount.quantize(Decimal("0.00000001"))
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError("amount_zec must be a finite positive ZEC amount")
    if not amount.is_finite() or amount <= 0:
        raise ValueError("amount_zec must be a finite positive ZEC amount")
    if amount != quantized:
        raise ValueError("amount_zec must use at most 8 decimal places")
    return quantized
