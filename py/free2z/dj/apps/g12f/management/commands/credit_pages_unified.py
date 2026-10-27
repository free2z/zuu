"""
Go through transactions to unified address and credit pages.

Every note whose memo is a page instruction ends in a recorded outcome
: either a ``g12f.Transaction`` on the page it names, or -- when the
page does not exist, or the memo visibly names a page action but cannot be
read -- a durable ``tuzis.ZecMemoDisposition`` row (the  queue, cleared
with ``manage.py dispose_zec_memo``), one structured ``ZEC PAGE PAYMENT
UNROUTED`` line per note, and one aggregate ``CREDITING BLOCKED`` line per
cycle. Before  a payment to a mistyped or deleted zPage was a bare
``print`` and then nothing: real ZEC received, never recorded, never
refunded, and nobody told.
"""
import json
import codecs
from decimal import Decimal
from django.core.management.base import BaseCommand
from django.db import transaction as db_transaction

from zcashrpc.client import Client
from dj.apps.g12f.management.commands.credit_creators import (
    MEMO_FIRST_NON_TEXT_BYTE, _names_a_purchase, carries_no_value,
    memo_is_absent,
)
from dj.apps.g12f.models.comment import PageComment
from dj.apps.g12f.models.transaction import Transaction
from dj.apps.g12f.models import zPage
from dj.apps.tuzis.models import ZecMemoDisposition
from dj.apps.tuzis.zec import (
    CREDIT_BLOCKED_SIGNAL, ZecMemoDispositionConflict,
    ZecMemoDispositionIdentityError, canonical_disposition_note,
    disposition_amount_from_tx, record_zec_memo_observation,
)

# Counted by monitoring/log-metrics/zec-credit-blocked.json, which watches
# BOTH credit commands. A page-funding note we could not record is real ZEC
# that never reached the page's total, so it pages rather than scrolling past.
BLOCKED = "credit_pages_unified: " + CREDIT_BLOCKED_SIGNAL + " - {reason}"

#. One structured line per unroutable page note per cycle, counted by
# monitoring/log-metrics/zec-page-payment-unrouted.json and alerted on by
# monitoring/alert-policies/zec-page-payment-unrouted.json. The `*_SIGNAL`
# naming is load-bearing: py/gcp/tests/test_alert_policy_contract.py fails if
# a signal the code emits is watched by no policy.
#
# The JSON carries the note identity, amount, classification and action --
# enough to find the row -- and deliberately NOT the page id or any other
# memo text: that is sender-chosen, and it lives in the database row rather
# than in a log line ( made the same call for buy_2z memos).
PAGE_PAYMENT_UNROUTED_SIGNAL = "ZEC PAGE PAYMENT UNROUTED"
UNROUTED = "credit_pages_unified: " + PAGE_PAYMENT_UNROUTED_SIGNAL + " {event}"

# The memo actions that are instructions to THIS command. A JSON memo with no
# `act` has always been treated as `page_fund`, but it only counts as a page
# payment we failed to route when it also names an `id`: the receive address
# is public, and an arbitrary JSON memo from a stranger is not a lost page
# payment.
PAGE_ACTIONS = frozenset(
    ("page_fund", "page_comment", "page_defund", "page_decomment"))
DEFAULT_ACTION = "page_fund"

# Same reasoning as credit_creators' MAX_UNREADABLE_PURCHASE_LINES: every
# historical note is re-reported on every cycle, so the per-note trace is
# capped. The rows are the complete queue, and the aggregate BLOCKED line
# carries the true count.
MAX_UNROUTED_LINES = 100


def extract_json(text):
    start = text.find('{')
    end = text.rfind('}') + 1
    return text[start:end]


def _names_a_page_action(raw_memo, memo) -> bool:
    """Does this unreadable memo still visibly name a page action?

    The page counterpart of ``credit_creators._names_a_purchase``:
    the decoded bytes, the hex text itself (for a memo whose hex did not
    decode), and the field as plain text. Never raises -- it only classifies.
    """
    try:
        text = memo.decode("utf-8", "ignore") if isinstance(
            memo, (bytes, bytearray)) else str(memo)
    except Exception:
        text = ""
    lowered = text.lower()
    for action in PAGE_ACTIONS:
        needle = action.encode()
        if raw_memo is not None and needle in raw_memo:
            return True
        if needle.hex() in lowered or action in text:
            return True
    return False


def page_instruction(json_memo):
    """The page action if this parsed memo is a page instruction, else None.

    ``None`` for anything else -- a ``buy_2z`` purchase (credit_creators'
    business), an unknown action, or JSON that names no page at all.
    """
    if not isinstance(json_memo, dict):
        return None
    if "act" in json_memo:
        action = json_memo["act"]
        # Sender-chosen JSON: `[]` or `{}` is unhashable, and a TypeError
        # here would abort every cycle on the same note forever. (Found by
        # the codex adversarial review.)
        if not isinstance(action, str):
            return None
        return action if action in PAGE_ACTIONS else None
    return DEFAULT_ACTION if "id" in json_memo else None


def _refunded(tx) -> bool:
    """Has an operator recorded that this exact note was refunded?

    Rows only ever exist under the strict canonical identity, so a note the
    wallet cannot identify exactly cannot have one.
    """
    try:
        txid, pool, index = canonical_disposition_note(tx)
    except ValueError:
        return False
    return ZecMemoDisposition.objects.filter(
        txid=txid, pool=pool, output_index=index,
        decision=ZecMemoDisposition.REFUNDED,
    ).exists()


def _decode(memo):
    """``(raw_memo, json_memo, ascii_memo, why_unreadable)`` for one memo.

    ``json_memo`` is None when the memo is absent or unreadable;
    ``why_unreadable`` is None unless the memo is present but cannot be read
    as a JSON object. Mirrors credit_creators.read_memo's classification.
    """
    try:
        raw_memo = codecs.decode(memo, 'hex')
    except Exception:
        return None, None, None, "not valid hex"
    if memo_is_absent(raw_memo):
        return raw_memo, None, None, None
    if raw_memo[0] >= MEMO_FIRST_NON_TEXT_BYTE:
        return raw_memo, None, None, "a reserved non-text memo format"
    try:
        ascii_memo = raw_memo.decode().replace("\x00", "")
    except Exception:
        return raw_memo, None, None, "not valid UTF-8"
    try:
        json_memo = json.loads(extract_json(ascii_memo))
    except Exception:
        return raw_memo, None, ascii_memo, "not JSON"
    if not isinstance(json_memo, dict):
        return raw_memo, None, ascii_memo, "not a JSON object"
    return raw_memo, json_memo, ascii_memo, None


class Command(BaseCommand):
    help = 'Syncs txs from node to db'

    def handle(self, *args, **kwargs):
        z = Client()

        # TODO: make dynamic instead of hardcoded
        # addr = "zs16d60pj9ws682ewchraejujscf4crsuatyc83gzwnlgzzyphc3ydhynqv9p40gygnts83cfy5q23"
        # addr = "zs1wkh9qdpznatw07gfv3xf0ewed0hhqp9vjt02kcmckz7jfxet7ld3ujldzlcke8a5fympvvndp39"
        addr = "zs1lm4vumxdpuz08w237n0lpxz490uq5nxasz6mql555f96hql4h7kc3ucf2a42j7mp0slck2uvjjk"

        num_transactions = 0
        total_z2z = 0

        # Unroutable page notes this cycle, by outcome. See _unroutable().
        self.unrouted = 0
        self.unidentifiable = 0
        self.conflicts = 0
        self.zero_value = 0

        # Could be 2 during interim
        # for address in Address.objects.filter(is_current=True):
        for tx in z.recieved_by(addr):
            amount = Decimal(tx['amount']).quantize(
                Decimal("1.00001000"))

            num_transactions += 1
            total_z2z += amount

            try:
                memo = tx['memo']
            except KeyError:
                # Was a bare `print` with no `continue`, so the next line read
                # whatever `memo` the PREVIOUS iteration left bound -- or
                # raised UnboundLocalError on the first note. Same shape as
                #a swallowed error that misattributes a payment.
                print("No memo, no problem")
                continue

            raw_memo, json_memo, ascii_memo, unreadable = _decode(memo)
            if unreadable is not None:
                # An unreadable memo is credit_creators' trace to give
                #, and the address is public, so most of them page
                # nobody. The exception is one that still visibly names a
                # page action: that is a page payment we cannot route
                #, exactly as a malformed memo naming buy_2z is a
                # purchase we cannot credit. A memo naming BOTH belongs to
                # credit_creators' buy_2z queue, so one note never carries two
                # competing observations.
                if (_names_a_page_action(raw_memo, memo)
                        and not _names_a_purchase(raw_memo, memo)):
                    self._unroutable(
                        tx, amount, ZecMemoDisposition.UNPARSEABLE_PAGE_MEMO,
                        action="", target="", why=unreadable)
                continue
            if json_memo is None:
                # No memo at all: a plain tip, not a page instruction.
                continue

            pid = json_memo.get('id')
            action = json_memo.get('act', DEFAULT_ACTION)
            try:
                if not isinstance(pid, str):
                    # A number, a list, null: no zPage has that address, and
                    # handing it to the ORM can raise something other than
                    # DoesNotExist and kill the whole cycle.
                    raise zPage.DoesNotExist
                zpage = zPage.objects.get(free2zaddr=pid)
            except zPage.DoesNotExist:
                instruction = page_instruction(json_memo)
                if instruction is None:
                    # Not a page instruction -- a buy_2z purchase, most
                    # often, which used to print a misleading "zPage
                    # <username> does not exist" on every cycle.
                    continue
                self._unroutable(
                    tx, amount, ZecMemoDisposition.PAGE_TARGET_NOT_FOUND,
                    action=instruction,
                    target="" if pid is None else str(pid),
                    why="names a zPage that does not exist")
                continue

            if _refunded(tx):
                # The payer got this ZEC back. If the page it named appears
                # later (restored, or created with that id) the note must not
                # then count toward the page's total as well. (Found by the
                # codex adversarial review.)
                continue

            print(f"ACTION={action}")

            # ONE transaction for the row, the comment and the cached
            # totals. A management command runs in autocommit --
            # AtomicMiddleware only wraps HTTP writes -- so without this
            # every statement below commits on its own and a crash in the
            # middle leaves a funded page whose cached total never moved.
            # No 2Z are issued here; this path only records on-chain page
            # funding and comments.
            #
            # One poisoned note must not wedge the loop. `Transaction`'s
            # primary key is the bare txid and `credit_creators` writes to the
            # same table, so a transaction carrying BOTH a buy_2z memo and a
            # page memo makes this get_or_create raise a duplicate key. That
            # used to kill the command, restart the unit every five cycles,
            # and page nobody -- `credit_creators` had already printed its
            # heartbeat by then. (Found by the codex adversarial review.)
            try:
                self._record(tx, zpage, amount=amount,
                             ascii_memo=ascii_memo, action=action,
                             json_memo=json_memo)
            except Exception as exc:
                # Continue rather than die -- one poisoned note must not wedge
                # the loop -- but PAGE, because this is a permanent loss of
                # real page funding that no later scan repairs. An earlier
                # revision printed a plain line, which traded a loud crash for
                # a silent loss. (Found by the codex adversarial review.)
                print(BLOCKED.format(reason=(
                    f"{tx['txid']} funds zPage '{pid}' with {amount} ZEC and "
                    f"could not be recorded: {exc!r}"
                )))
                continue

        if self.unrouted:
            # Clearable, like credit_creators' malformed-buy_2z line: a
            # disposition row retires its note on the next scan.
            print(BLOCKED.format(reason=(
                f"{self.unrouted} page payment note(s) name a zPage that "
                f"does not exist or cannot be read, and have no disposition; "
                f"list them with `manage.py dispose_zec_memo`, then refund or "
                f"record each one"
            )))
        if self.unidentifiable or self.conflicts:
            print(BLOCKED.format(reason=(
                f"{self.unidentifiable + self.conflicts} unroutable page "
                f"payment note(s) could not be durably identified or "
                f"reconciled; fix the wallet adapter or review the "
                f"conflicting audit row"
            )))
        if self.zero_value:
            print(f"{self.zero_value} zero-value note(s) carried an "
                  f"unroutable page memo; no ZEC arrived, nothing to refund")

        print(f"Saw {num_transactions} for {total_z2z}")

    def _unroutable(self, tx, amount, classification, *, action, target,
                    why):
        """Durably record one page note that cannot be routed.

        Mirrors credit_creators' malformed-buy_2z path: the row is
        written BEFORE the capped log line, so the database is the complete
        queue; a resolved row is silent; and an identity the wallet cannot
        state exactly is never guessed into a row -- it stays BLOCKED.
        """
        if carries_no_value(tx, amount):
            # No ZEC arrived, and the table cannot hold a zero amount: a page
            # armed on one could never be cleared, and anyone who knows the
            # public address could arm it on purpose.
            self.zero_value += 1
            return
        try:
            txid, pool, index = canonical_disposition_note(tx)
            row = record_zec_memo_observation(
                txid=txid, pool=pool, output_index=index,
                amount_zec=disposition_amount_from_tx(tx),
                classification=classification,
                memo_action=action, memo_target=target,
            )
        except (ZecMemoDispositionIdentityError, ValueError):
            self.unidentifiable += 1
            if self.unidentifiable <= MAX_UNROUTED_LINES:
                print("unroutable page payment note has an unusable wallet "
                      "identity or amount; fix the wallet adapter before it "
                      "can be dispositioned")
            return
        except ZecMemoDispositionConflict:
            self.conflicts += 1
            if self.conflicts <= MAX_UNROUTED_LINES:
                print("unroutable page payment note conflicts with its "
                      "durable first observation; review the wallet adapter "
                      "and audit row")
            return

        if row.decision is not None:
            return
        self.unrouted += 1
        if self.unrouted <= MAX_UNROUTED_LINES:
            print(UNROUTED.format(event=json.dumps({
                "event": "zec_page_payment_unrouted",
                "classification": classification,
                "txid": txid,
                "pool": pool,
                "output_index": index,
                "amount_zec": f"{row.amount_zec:f}",
                "action": action,
                "why": why,
            }, sort_keys=True)))

    def _record(self, tx, zpage, amount, ascii_memo, action, json_memo):
        """Store one on-chain page-funding note. Issues no 2Z."""
        with db_transaction.atomic():
            transaction, created = Transaction.objects.get_or_create(
                zpage=zpage,
                txid=tx['txid'],
                amount=amount,
            )
            transaction.memo = tx['memo']
            transaction.memo_plain = ascii_memo
            transaction.action = action
            transaction.save()

            if action in ["page_comment", "page_decomment"]:
                # Savepoint: a duplicate comment must not roll back the
                # transaction row it hangs off. A bare `except` inside an
                # atomic block without one poisons the whole transaction.
                try:
                    with db_transaction.atomic():
                        PageComment.objects.get_or_create(
                            zpage=zpage,
                            tx=transaction,
                            comment=json_memo.get("comment", ""),
                        )
                except Exception as exc:
                    print(f"NO COMMENT: {exc!r}")

            # cache_total may update timestamp?
            # no need to call it if we didn't create a new transaction?
            # but, in the early days we would just call this all the time
            # to pick up any changes to the creator/pages and rescore them
            # meh, I think it's fine.
            if created:
                # page_fund and page_defund are baked in here
                zpage.cache_total()
                zpage.creator.cache_total()
