"""Integrity of the ZEC -> 2Z crediting loop.

2Z are platform credits. ZEC is the crypto that arrives on chain. These tests
are about the seam between them, which is a management command -- and a
management command runs in AUTOCOMMIT. `AtomicMiddleware` only wraps HTTP
writes, so nothing here gets atomicity for free; every guarantee asserted below
comes from an explicit `transaction.atomic()` in `dj.apps.tuzis.zec`.

The database is REAL Postgres (project rule). Nothing about a transaction
boundary can be tested against a mock, because the thing under test *is* the
database's behaviour.

Each test names the production line it fails without. The four that matter:

* `test_a_crash_after_the_receipt_rolls_back_the_whole_credit` -- delete the
  `with transaction.atomic():` in `credit_zec_purchase` and it fails: the
  receipt survives a crash, the buyer is never credited, and no later cycle
  will retry because the receipt says "done".
* `test_two_notes_of_one_transaction_are_both_credited` -- revert the receipt
  identity to the bare txid and it fails: the second payer gets nothing.
* `test_pricing_outage_credits_nothing_and_exits_non_zero` -- restore the
  `return` in the `PricingUnavailable` handler and it fails: the cycle looks
  successful.
* `test_heartbeat_matches_the_log_metric_exactly_once` -- rename either the
  line or the metric regex and it fails, instead of leaving a green, enabled,
  permanently un-fireable alert policy.

Four more were added after the codex adversarial review found the fixes had
each opened a new hole. Every one of them is a way a payment goes uncredited
(or double-credited) with every signal green, so they are not optional extras:

* `test_a_backfilled_receipt_claims_every_index_of_its_transaction`
* `test_two_equal_value_notes_with_no_index_block_instead_of_under_crediting`
* `test_a_dummy_wallet_never_heartbeats`
* `test_the_audit_sees_a_partial_loss_not_just_a_total_one`
"""
import codecs
import json
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest
from django.core.management import call_command

from dj.apps.events.models import Event
from dj.apps.g12f.models.transaction import Transaction
from dj.apps.g12f.management.commands.credit_creators import (
    PURCHASE_ACTION)
from dj.apps.g12f.management.commands import audit_zec_credits as _audit
from dj.apps.tuzis import zec
from dj.apps.tuzis.models import ZecCreditReceipt

_COMMAND = "dj.apps.g12f.management.commands.credit_creators"

_REPO_ROOT = Path(__file__).resolve().parents[5]

RATE = Decimal("90000.0000")


def _metric_pattern(path):
    """The regex, straight out of the log-metric definition.

    Read rather than retyped, on purpose. A retyped copy drifts silently and
    the metric it is meant to pin stops matching anything.
    """
    metric = json.loads(path.read_text())
    match = re.search(r'jsonPayload\.message=~"([^"]+)"', metric["filter"])
    assert match, metric["filter"]
    return re.compile(match.group(1))


def _matching_lines(out, pattern):
    return [line for line in out.splitlines() if pattern.fullmatch(line)]


def _memo_hex(payload):
    return codecs.encode(json.dumps(payload).encode("ascii"), "hex").decode()


def note(txid, amount, username, output_index=None, action="buy_2z",
         pool=None):
    """One received note as the wallet clients report them."""
    row = {
        "txid": txid,
        "amount": amount,
        "amountZat": int(Decimal(str(amount)) * 10 ** 8),
        "memo": _memo_hex({"act": action, "id": username}),
    }
    if output_index is not None:
        row["output_index"] = output_index
    if pool is not None:
        row["pool"] = pool
    return row


class FakeWallet:
    """Stands in for the wallet client only. The database is not faked."""

    def __init__(self, notes, pending=None):
        self._notes = notes
        # 's held notes: seen by the wallet, not yet buried deep enough.
        self.pending_notes = list(pending or [])

    def recieved_by(self, addr):
        return list(self._notes)


@pytest.fixture
def wallet(mocker):
    """Install a wallet returning `notes`; returns the installer."""
    def install(notes, pending=None):
        mocker.patch(
            f"{_COMMAND}.Client", lambda: FakeWallet(notes, pending))
    return install


@pytest.fixture(autouse=True)
def fixed_rate(mocker):
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)


def balance(creator):
    creator.refresh_from_db(fields=["tuzis"])
    return creator.tuzis


# --------------------------------------------------------------------------
# (a) -- the receipt and the credit are one atomic unit
# --------------------------------------------------------------------------



@pytest.mark.django_db
def test_credit_zec_purchase_is_all_or_nothing(creator_factory, mocker):
    """The same guarantee at the unit boundary, without the command."""
    buyer = creator_factory(username="unitbuyer", tuzis=Decimal("0"))
    mocker.patch(
        "dj.apps.events.dispatch.create_durable_event",
        side_effect=RuntimeError("boom"))

    with pytest.raises(RuntimeError):
        zec.credit_zec_purchase(
            creator=buyer, txid="bb" * 32, output_index=0,
            amount_zec=Decimal("1.00000000"), tuzis_per_zec=RATE)

    assert ZecCreditReceipt.objects.count() == 0
    assert balance(buyer) == Decimal("0")
    assert Transaction.objects.count() == 0




# --------------------------------------------------------------------------
# (b) -- one transaction, several outputs
# --------------------------------------------------------------------------



@pytest.mark.django_db
def test_the_first_payers_record_is_never_overwritten(
        creator_factory, wallet, capsys):
    """g12f.Transaction holds one note per txid, and that is now harmless.

    Its primary key is the bare txid, so the second note has nowhere to go.
    The old code wrote it anyway with an unconditional `save()`, replacing the
    first payer's `creator`, `memo` and `action`. Now the record write is a
    savepoint that may fail, the first row is left exactly as it was, and both
    credits still land.
    """
    first = creator_factory(username="recordone", tuzis=Decimal("0"))
    second = creator_factory(username="recordtwo", tuzis=Decimal("0"))
    txid = "ee" * 32
    wallet([
        note(txid, 0.1, "recordone", output_index=0),
        note(txid, 0.2, "recordtwo", output_index=1),
    ])

    call_command("credit_creators", no_color=True)

    row = Transaction.objects.get(txid=txid)
    assert row.creator_id == first.pk, (
        "the second note overwrote the first payer's record")
    assert row.amount == Decimal("0.10000000")
    assert balance(second) == Decimal("18000.000"), (
        "a record-keeping conflict must never block a credit")
    assert "already holds another note" in capsys.readouterr().out








def test_note_output_index_prefers_a_real_index_over_zero():
    assert zec.note_output_index({"output_index": 3}) == 3
    assert zec.note_output_index({"outindex": 2}) == 2      # zcashd RPC
    assert zec.note_output_index({}) == 0                   # conservative
    assert zec.note_output_index({"output_index": None}) == 0
    assert zec.note_output_index({"output_index": "nope"}) == 0


# --------------------------------------------------------------------------
#  -- a pricing outage must not look like a successful cycle
# --------------------------------------------------------------------------





# --------------------------------------------------------------------------
#  -- the heartbeat is a contract with the log-based metric
# --------------------------------------------------------------------------







# --------------------------------------------------------------------------
# The backfill that keeps the first post-deploy cycle from re-crediting
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_a_backfilled_receipt_stops_a_historical_purchase_re_crediting(
        creator_factory, wallet, capsys):
    """Migration tuzis/0003 is what makes the first new cycle safe.

    Simulated here rather than run as a migration: the pre- world is a
    `g12f.Transaction` row with no receipt, which is exactly what the migration
    finds. Without the backfill the new code sees no receipt and credits every
    historical purchase a second time.
    """
    buyer = creator_factory(username="historical", tuzis=Decimal("0"))
    txid = "cd" * 32
    Transaction.objects.create(
        txid=txid, creator=buyer, amount=Decimal("1.00000000"),
        action="buy_2z")
    ZecCreditReceipt.objects.create(
        txid=txid, output_index=0, creator=buyer,
        amount_zec=Decimal("1.00000000"), backfilled=True)

    wallet([note(txid, 1.0, "historical", output_index=0)])
    call_command("credit_creators", no_color=True)

    assert balance(buyer) == Decimal("0"), (
        "a historical purchase was credited a second time")
    assert ZecCreditReceipt.objects.count() == 1
    assert "CREDITING BLOCKED" not in capsys.readouterr().out


@pytest.mark.django_db
def test_the_migration_backfill_covers_every_historical_purchase(
        creator_factory, wallet, capsys):
    """Run migration tuzis/0003's own backfill function against real rows.

    The test above proves the code respects a receipt; this one proves the
    migration actually creates them. Both are needed: a correct reader of an
    empty table still re-credits everybody.
    """
    import importlib

    from django.apps import apps as global_apps

    migration = importlib.import_module(
        "dj.apps.tuzis.migrations.0003_zeccreditreceipt")

    buyer = creator_factory(username="backfilled", tuzis=Decimal("0"))
    for i in range(3):
        Transaction.objects.create(
            txid=f"{i:064x}", creator=buyer, amount=Decimal("1.00000000"),
            action="buy_2z")
    # Page funding is not a 2Z purchase and must not get a receipt.
    Transaction.objects.create(
        txid="f" * 64, amount=Decimal("1.00000000"), action="page_fund")

    migration.backfill_receipts(global_apps, None)

    receipts = ZecCreditReceipt.objects.all()
    assert receipts.count() == 3
    assert all(r.backfilled and r.output_index == 0 for r in receipts)
    assert all(r.tuzis_credited is None for r in receipts), (
        "a backfilled receipt must not claim a 2Z amount nobody recorded")
    assert not ZecCreditReceipt.objects.filter(txid="f" * 64).exists()

    # The whole point: the first post-deploy cycle credits nothing.
    wallet([note(f"{0:064x}", 1.0, "backfilled", output_index=0)])
    call_command("credit_creators", no_color=True)
    assert balance(buyer) == Decimal("0")
    capsys.readouterr()

    # And the reverse removes exactly what it added.
    migration.drop_backfilled_receipts(global_apps, None)
    assert ZecCreditReceipt.objects.count() == 0


@pytest.mark.django_db
def test_a_non_duplicate_integrity_error_is_not_reported_as_idempotent(
        creator_factory, mocker):
    """Only a duplicate receipt means "already credited".

    Every other IntegrityError -- a violated foreign key, a check constraint
    -- must propagate. Swallowing one as an idempotent no-op reintroduces the
    exact silent under-credit this module exists to remove.
    """
    from django.db import IntegrityError

    buyer = creator_factory(username="fkbuyer", tuzis=Decimal("0"))
    mocker.patch.object(
        ZecCreditReceipt.objects, "create",
        side_effect=IntegrityError("creator_id violates foreign key"))

    with pytest.raises(IntegrityError):
        zec.credit_zec_purchase(
            creator=buyer, txid="ac" * 32, output_index=0,
            amount_zec=Decimal("1.00000000"), tuzis_per_zec=RATE)

    assert balance(buyer) == Decimal("0")


@pytest.mark.django_db
def test_a_backfilled_receipt_claims_every_index_of_its_transaction(
        creator_factory, wallet, capsys):
    """The migration had to GUESS output_index=0 for history. Contain it.

    The pre- schema discarded the index, so a backfilled receipt says
    `(txid, 0)` whatever the note's real index was. The first time the fixed
    adapter reports a real index -- 2, say -- `(txid, 2)` would find no
    receipt and credit that historical purchase AGAIN, at today's rate,
    across every old row in a single cycle. Found by the codex adversarial
    review. A backfilled receipt therefore claims the whole transaction.
    """
    buyer = creator_factory(username="realindex", tuzis=Decimal("0"))
    txid = "de" * 32
    ZecCreditReceipt.objects.create(
        txid=txid, output_index=0, creator=buyer,
        amount_zec=Decimal("1.00000000"), backfilled=True)

    # Same historical note, now reported with its REAL index.
    wallet([note(txid, 1.0, "realindex", output_index=2)])
    call_command("credit_creators", no_color=True)

    assert balance(buyer) == Decimal("0"), (
        "a historical purchase was re-credited once the wallet started "
        "reporting real output indices")
    assert ZecCreditReceipt.objects.count() == 1
    assert "CREDITING BLOCKED" not in capsys.readouterr().out


@pytest.mark.django_db
def test_a_non_backfilled_receipt_claims_only_its_own_note(
        creator_factory, wallet, capsys):
    """The txid-wide claim must NOT leak to receipts written by new code.

    A receipt this code wrote knows its real index, so it must not block the
    other outputs of the same transaction -- that would silently reintroduce
    the multi-output bug in the other direction.
    """
    first = creator_factory(username="liveone", tuzis=Decimal("0"))
    second = creator_factory(username="livetwo", tuzis=Decimal("0"))
    txid = "ef" * 32
    wallet([note(txid, 0.1, "liveone", output_index=0)])
    call_command("credit_creators", no_color=True)

    wallet([note(txid, 0.2, "livetwo", output_index=1)])
    call_command("credit_creators", no_color=True)

    assert balance(first) == Decimal("9000.000")
    assert balance(second) == Decimal("18000.000")
    assert "CREDITING BLOCKED" not in capsys.readouterr().out


@pytest.mark.django_db
def test_the_audit_sees_a_partial_loss_not_just_a_total_one(
        creator_factory, capsys):
    """A buyer whose FIRST purchase credited and whose SECOND was eaten.

    The earlier revision only flagged creators with ZERO BOUGHT_TUZI events,
    so this creator looked clean and the command exited 0 -- an operator could
    run the reconciliation and be told nothing was wrong. Found by the codex
    adversarial review.
    """
    buyer = creator_factory(username="partialloss", tuzis=Decimal("0"))
    for i in range(2):
        Transaction.objects.create(
            txid=f"{i:064x}", creator=buyer, amount=Decimal("1.00000000"),
            action="buy_2z")
    Event.objects.create(
        read=False, type="BOUGHT_TUZI", amount=Decimal("1"),
        receiving_user=buyer, payee=buyer)

    with pytest.raises(SystemExit) as exit_info:
        call_command("audit_zec_credits")

    assert exit_info.value.code == 1
    out = capsys.readouterr().out
    assert "SUSPECT" in out
    assert "zec_purchases=2 bought_tuzi_events=1" in out


@pytest.mark.django_db
def test_the_audit_exits_0_only_when_every_purchase_has_a_real_receipt(
        creator_factory, capsys):
    """Exit 0 must mean something stronger than "the counts balance".

    BOUGHT_TUZI events are also emitted by the Stripe path and carry no txid,
    so a balanced count proves nothing about a particular note. Only a receipt
    this code wrote, with a recorded 2Z amount, does. Found by the codex
    adversarial review.
    """
    buyer = creator_factory(username="cleanhistory", tuzis=Decimal("0"))
    Transaction.objects.create(
        txid="1" * 64, creator=buyer, amount=Decimal("1.00000000"),
        action="buy_2z")
    Event.objects.create(
        read=False, type="BOUGHT_TUZI", amount=1,
        receiving_user=buyer, payee=buyer)

    # Counts balance, but nothing proves THIS note was credited.
    with pytest.raises(SystemExit) as unverified:
        call_command("audit_zec_credits")
    assert unverified.value.code == 2
    assert "SUSPECT" not in capsys.readouterr().out

    ZecCreditReceipt.objects.create(
        txid="1" * 64, output_index=0, creator=buyer,
        amount_zec=Decimal("1.00000000"),
        tuzis_credited=Decimal("90000.000"))

    call_command("audit_zec_credits")   # no SystemExit
    assert "SUSPECT" not in capsys.readouterr().out


@pytest.mark.django_db
def test_a_stripe_event_cannot_mask_a_lost_zec_credit(
        creator_factory, capsys):
    """Two ZEC purchases, one lost, plus a Stripe purchase = balanced counts.

    The per-creator count says two events for two purchases and finds no
    suspect. Exit 0 would tell an operator history is reconciled. It is not.
    """
    buyer = creator_factory(username="maskedloss", tuzis=Decimal("0"))
    for i in range(2):
        Transaction.objects.create(
            txid=f"{i:064x}", creator=buyer, amount=Decimal("1.00000000"),
            action="buy_2z")
    for _ in range(2):   # one ZEC credit + one Stripe credit
        Event.objects.create(
            read=False, type="BOUGHT_TUZI", amount=1,
            receiving_user=buyer, payee=buyer)

    with pytest.raises(SystemExit) as exit_info:
        call_command("audit_zec_credits")

    assert exit_info.value.code == 2, (
        "a balanced count was reported as a reconciled history")


# --------------------------------------------------------------------------
# Second codex pass -- each of these is a payment lost or doubled
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_a_payment_credited_during_the_rollout_gap_is_not_credited_twice(
        creator_factory, wallet, capsys):
    """The migration is a SNAPSHOT; the VM is updated by hand, later.

    `the deployment checkout` on the payment host is an unpacked tarball, not a git checkout, so the old
    loop keeps running for an unbounded window after Cloud Build applies
    `tuzis/0003`. Every payment it credits in that window has a
    `g12f.Transaction` row and no receipt. Without a live legacy check, the
    new code credits all of them a SECOND time. Found by the codex
    adversarial review.
    """
    buyer = creator_factory(username="gapbuyer", tuzis=Decimal("0"))
    txid = "1a" * 32
    # Exactly what the old loop leaves behind: a row, no receipt.
    Transaction.objects.create(
        txid=txid, creator=buyer, amount=Decimal("1.00000000"),
        action="buy_2z")

    wallet([note(txid, 1.0, "gapbuyer", output_index=0, pool="sapling")])
    call_command("credit_creators", no_color=True)

    assert balance(buyer) == Decimal("0"), (
        "a payment the old loop already credited was credited again")
    adopted = ZecCreditReceipt.objects.get(txid=txid)
    assert adopted.backfilled, (
        "the adopted claim must be flagged like a migration backfill so "
        "audit_zec_credits can still question whether 2Z ever arrived")
    assert "CREDITING BLOCKED" not in capsys.readouterr().out


@pytest.mark.django_db
def test_the_legacy_claim_does_not_block_the_new_codes_own_outputs(
        creator_factory, wallet, capsys):
    """The live legacy check must not swallow output 1 of a fresh payment.

    The new code writes a `g12f.Transaction` row too. If the legacy rule fired
    on any such row, the row written for output 0 would block output 1 of the
    same transaction and quietly reinstate (b).
    """
    first = creator_factory(username="gapone", tuzis=Decimal("0"))
    second = creator_factory(username="gaptwo", tuzis=Decimal("0"))
    txid = "1b" * 32
    wallet([
        note(txid, 0.1, "gapone", output_index=0, pool="sapling"),
        note(txid, 0.2, "gaptwo", output_index=1, pool="sapling"),
    ])

    call_command("credit_creators", no_color=True)

    assert balance(first) == Decimal("9000.000")
    assert balance(second) == Decimal("18000.000")
    assert "CREDITING BLOCKED" not in capsys.readouterr().out




def test_note_pool_defaults_to_empty_rather_than_guessing():
    assert zec.note_pool({"pool": "orchard"}) == "orchard"
    assert zec.note_pool({}) == ""
    assert zec.note_pool({"pool": None}) == ""




@pytest.mark.django_db
def test_one_poisoned_note_does_not_wedge_the_page_funding_command(
        creator_factory, mocker, capsys):
    """`credit_pages_unified` must survive a duplicate primary key.

    `Transaction`'s primary key is the bare txid and `credit_creators` writes
    to the same table, so a transaction carrying both a buy_2z memo and a page
    memo makes the page command's get_or_create raise. It used to kill the
    command outright. Found by the codex adversarial review.
    """
    from dj.apps.g12f.models import zPage

    creator = creator_factory(username="pageowner")
    page = zPage.objects.create(
        creator=creator, title="t", free2zaddr="pageaddr1")
    txid = "1e" * 32
    # A buy_2z row already owns this primary key with no zpage.
    Transaction.objects.create(
        txid=txid, creator=creator, amount=Decimal("1.00000000"),
        action="buy_2z")

    page_note = {
        "txid": txid,
        "amount": 1.0,
        "amountZat": 10 ** 8,
        "memo": _memo_hex({"act": "page_fund", "id": page.free2zaddr}),
    }
    mocker.patch(
        "dj.apps.g12f.management.commands.credit_pages_unified.Client",
        lambda: FakeWallet([page_note]))

    call_command("credit_pages_unified", no_color=True)   # must not raise

    assert "could not be recorded" in capsys.readouterr().out




@pytest.mark.django_db
def test_a_purchase_beyond_int32_credits_and_records_the_exact_amount(
        creator_factory, wallet, capsys):
    """`Event.amount` was an IntegerField -- int32 in Postgres.

    Past roughly 2.1e9 2Z the notification insert overflowed with DataError
    and used to roll back an otherwise correct credit, failing identically on
    every retry (found by the codex adversarial review); the fix clamped the
    notification to 2_147_483_647. the column carries the
    ledger's own precision, so the credit still lands AND the audit row says
    what the ledger says.
    """
    from dj.apps.events.models import Event as EventModel

    whale = creator_factory(username="megawhale", tuzis=Decimal("0"))
    # 90000 2Z/ZEC * 30000 ZEC = 2.7e9 2Z, past int32.
    wallet([note("2b" * 32, 30000.0, "megawhale", output_index=0,
                 pool="sapling")])

    call_command("credit_creators", no_color=True)

    assert balance(whale) == Decimal("2700000000.000")
    event = EventModel.objects.get(type="BOUGHT_TUZI")
    assert event.amount == Decimal("2700000000.000"), (
        "the notification disagrees with the ledger")
    assert "CREDITING BLOCKED" not in capsys.readouterr().out




# --------------------------------------------------------------------------
#  -- live pricing is contractual, and an unreadable memo leaves a trace
# --------------------------------------------------------------------------

def _command_source():
    """The credit_creators source, read from this repo's checkout."""
    return (_REPO_ROOT / "py" / "free2z" / "dj" / "apps" / "g12f" / "management"
            / "commands" / "credit_creators.py").read_text()


@pytest.mark.django_db
def test_the_crediting_rate_is_never_a_hardcoded_literal(
        creator_factory, wallet, mocker):
    """Crediting must use the current rate, not a source-code constant.

    Behavioural half -- mock the LIVE rate at 70000 and require the credit to
    equal mocked-rate * amount (to_tuzis() quantizes to the column's 0.001
    exponent: 70000 * 0.1 ZEC is exactly 7000.000). If any literal ever
    becomes the rate source again, the balance will not match.
    Source-scan half -- line-anchored defense-in-depth only: it rejects a
    numeric literal assigned to a *_PER_ZEC constant on a SINGLE LINE, in
    either the plain (`TUZIS_PER_ZEC =...`) or annotated
    (`TUZIS_PER_ZEC: Decimal =...`) form. Multiline literals, renamed
    constants or env fallbacks would escape it entirely; the behavioural
    half is the real guard for anything subtler. It checks the command
    actually calls current_tuzis_per_zec().
    """
    buyer = creator_factory(username="liveprice", tuzis=Decimal("0"))
    wallet([note("2d" * 32, 0.1, "liveprice", output_index=0)])

    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec",
                 return_value=Decimal("70000"))
    call_command("credit_creators", no_color=True)

    assert balance(buyer) == Decimal("7000.000"), (
        "the credit did not come from current_tuzis_per_zec(); a "
        "hardcoded rate has become the source again (#1402)")

    source = _command_source()
    assert "current_tuzis_per_zec()" in source, (
        "the command no longer consults live pricing")
    offenders = [
        line for line in source.splitlines()
        if re.search(r"(?im)^\s*TUZIS?_PER_ZEC\b\s*[:=].*[0-9]", line)
    ]
    assert not offenders, (
        f"a numeric literal is assigned to a rate constant (#1402): "
        f"{offenders}")








# --------------------------------------------------------------------------
#  x  -- a pricing outage must not blind the double-spend watchdog
# --------------------------------------------------------------------------



# --------------------------------------------------------------------------
#  x  -- ONE decoder, and the held-note pass really uses it
# --------------------------------------------------------------------------



# --------------------------------------------------------------------------
#  -- an ABSENT memo is not an unreadable one, and the trace is bounded
# --------------------------------------------------------------------------
#
# Both found by the codex adversarial review of the trace above. The receive
# address is public and the wallet re-reports EVERY historical note on every
# 90-second scan, so anything printed per-note is printed per-note *per cycle,
# forever* -- and the first revision printed it for notes that were perfectly
# ordinary.







@pytest.mark.django_db
def test_two_unreadable_notes_of_one_transaction_are_told_apart(
        creator_factory, wallet, capsys):
    """The trace must identify the NOTE, not just the transaction.

    Everywhere else in this command the safe identity is
    ``(txid, pool, output_index)`` -- (b) exists because the bare txid
    collapsed two payments into one. A diagnostic keyed on the txid alone
    reintroduces exactly that ambiguity at the moment a human is trying to
    act: one transaction with two malformed purchase memos for two different
    buyers prints two identical lines, and the operator cannot tell which note
    to credit or which receipt key to write. (Found by the codex adversarial
    review.)

    Negative control: reduce ``note_id`` to the txid and this fails -- the two
    lines become byte-identical.
    """
    holder = creator_factory(username="twobadnotes", tuzis=Decimal("5"))
    txid = "7b" * 32
    wallet([
        {"txid": txid, "amount": 0.5, "amountZat": 50000000,
         "output_index": 0, "pool": "sapling",
         "memo": codecs.encode(b'{"act": "buy_2z" trunc a', "hex").decode()},
        {"txid": txid, "amount": 0.5, "amountZat": 50000000,
         "output_index": 1, "pool": "orchard",
         "memo": codecs.encode(b'{"act": "buy_2z" trunc b', "hex").decode()},
    ])

    call_command("credit_creators", no_color=True)

    out = capsys.readouterr().out
    lines = [line for line in out.splitlines()
             if txid in line and "does not parse" in line]
    assert len(lines) == 2, f"expected both notes named; stdout:\n{out}"
    assert len(set(lines)) == 2, (
        "the two notes printed identical lines, so an operator cannot tell "
        "which one to credit:\n" + "\n".join(lines))
    for pool, index in (("sapling", "0"), ("orchard", "1")):
        assert any(pool in line and f":{index}" in line for line in lines), (
            f"no line identifies the {pool} note at index {index}:\n"
            + "\n".join(lines))
    assert balance(holder) == Decimal("5")




@pytest.mark.django_db
def test_a_purchase_memo_corrupted_into_invalid_hex_still_pages(
        creator_factory, wallet, capsys):
    """: the classifier must not lose a purchase to a bad nibble.

    When the hex does not decode there are no decoded bytes to search, and
    searching the HEX TEXT for the plaintext word `buy_2z` can never match --
    a real purchase memo corrupted in transit was filed as generic garbage,
    capped, and paged nobody. The hex encoding of the action
    (`6275795f327a`) survives in the field, so that is what identifies it.
    (Found by the codex adversarial review.)

    Negative control: search only `raw_memo` and this test fails -- the note
    is classified as noise and no BLOCKED line is printed.
    """
    holder = creator_factory(username="corrupthex", tuzis=Decimal("5"))
    txid = "6a" * 32
    intact = _memo_hex({"act": "buy_2z", "id": "corrupthex"})
    assert PURCHASE_ACTION.encode().hex() in intact
    # A single odd character: the field no longer decodes as hex at all, but
    # the action is still plainly legible in it.
    wallet([{
        "txid": txid, "amount": 0.5, "amountZat": 50000000,
        "output_index": 0, "pool": "sapling", "memo": intact + "z",
    }])

    call_command("credit_creators", no_color=True)

    out = capsys.readouterr().out
    named = [line for line in out.splitlines()
             if txid in line and "does not parse" in line]
    assert named, (
        f"a corrupted purchase memo was filed as generic noise, so it is "
        f"capped alongside strangers' garbage instead of being called out as "
        f"very likely a purchase; stdout:\n{out}")
    assert balance(holder) == Decimal("5")


# --------------------------------------------------------------------------
# Settlement spread is applied once; the estimate buffer is display-only.
# --------------------------------------------------------------------------



# --------------------------------------------------------------------------
#  -- `TUZI_PER_ZEC` is expunged, repo-wide, and no *_PER_ZEC constant
# may ever again be a bare number
# --------------------------------------------------------------------------
#
# The behavioural test above pins the ONE call site we know about. These two
# pin the shape of the bug so it cannot reappear somewhere else. The defect
# was never "credit_creators is wrong"; it was "a rate lived in a constant",
# and a constant can be reintroduced in any file, in either language.
#
# Scope: source files under version control, both Python and the two TypeScript
# trees. `git ls-files` is deliberate -- it excludes node_modules, build output
# and anything untracked, so the scan cannot be slowed down or fooled by a
# checkout's local debris.

# Directories that hold source we care about. `docs/` is excluded on purpose:
# writing the incident up by name is exactly what documentation is for.
#
# WHAT CI ACTUALLY GUARANTEES, since a guard is only as good as its trigger
# (raised by the codex adversarial review). This test runs in the `backend`
# job, which fires for `py/*` and `monitoring/*`; the node copy runs in `ui`,
# which fires for both `ts/*` trees. So `py`, `monitoring` and `ts` are
# genuinely gated. `bin` and `zcash` are scanned opportunistically -- a
# `zcash/`-only commit runs NEITHER job, so a rate constant added there and
# hand-copied to the payment host would not be caught by the gate. `zcash/pipeline` is
# the wallet reader, not a pricing path, which is why this is a documented
# limit rather than a widened CI filter on a money PR; widening it belongs
# with the  VM-deployment work, where the manual copy is the real hole.
# `.jsx`/`.cjs` already exist in the tracked UI trees and were unscanned
# (codex adversarial review), so the "repo-wide" claim was not true.
_SCANNED_SUFFIXES = (
    ".py", ".pyi", ".sh",
    ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
    ".svelte",
)

# The two scan tests quote the dead name in order to assert its absence, so
# they must not scan themselves or each other. (Found by the negative control:
# the node copy was untracked when this was first written, and turned the whole
# suite red the moment it was committed.)
_SCANNERS = (
    "py/free2z/dj/apps/g12f/test_zec_credit_integrity.py",
    "ts/svelte/free2z/tests/zec-rate-constants.test.mjs",
)

# The dead identifier, standing alone. Not preceded/followed by another
# uppercase-identifier character, so a derived, clearly-scoped constant such as
# the UI's display-only ``BOOTSTRAP_TUZIS_PER_ZEC`` is not caught -- and the
# lowercase ``tuzis_per_zec`` (the live pricing function, its kwarg and the
# receipt column) is not caught either, since those are the fix, not the bug.
_DEAD_NAME = re.compile(r"(?<![A-Z0-9_])TUZIS?_PER_ZEC(?![A-Z0-9_])")

# ANY uppercase `*_PER_ZEC` constant whose entire right-hand side is a number.
# This is the actual shape of  (`TUZI_PER_ZEC: int = 2500`) and it stays
# lethal under a rename -- `FALLBACK_TUZI_PER_ZEC = 2500` is caught too.
# A derived value (`Math.round(...)`, `current_tuzis_per_zec()`) is not.
_LITERAL_RATE = re.compile(
    r"^\s*(?:export\s+)?(?:const\s+|let\s+|var\s+)?"
    r"[A-Z0-9_]*_PER_ZEC\b"
    r"\s*(?::[^=]*)?=\s*"
    r"[-+]?[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][-+]?[0-9]+)?"
    r"\s*[;,]?\s*(?:(?://|#).*)?$"
)

# The same bug in idiomatic lowercase Python, which the uppercase pattern
# above misses entirely. The shape that matters is a
# `PricingUnavailable` fallback -- `tuzis_per_zec = Decimal("2500")` -- which
# would leave every happy-path test green and only bite during an exchange
# outage, i.e. the moment nobody is watching. (Found by the codex adversarial
# review.) `Decimal(...)` and a quoted number are both accepted RHS shapes;
# anything derived (`Decimal(tuzis_per_zec)`, `snapshot.tuzis_per_zec`) is not.
_LITERAL_RATE_LOWER = re.compile(
    r"^\s*[a-z0-9_]*_per_zec\b"
    r"\s*(?::[^=]*)?=\s*"
    r"(?:Decimal\s*\(\s*)?"
    r"['\"]?[-+]?[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][-+]?[0-9]+)?['\"]?"
    r"\s*\)?\s*[,;]?\s*(?:#.*)?$"
)

#...but only in production code. A test fixture pinning a rate is the whole
# point of a test fixture, and flagging those is how a guard gets deleted.
_TEST_FILE_MARKERS = ("test_", "/tests/", "conftest", ".test.", "factories")


def _is_test_source(name: str) -> bool:
    base = name.rsplit("/", 1)[-1]
    return base.startswith("test_") or any(
        marker in name for marker in _TEST_FILE_MARKERS)








@pytest.mark.parametrize("line", [
    "TUZI_PER_ZEC: int = 2500",
    "TUZI_PER_ZEC = 2500",
    "    TUZIS_PER_ZEC = 75_263",
    "export const FALLBACK_TUZI_PER_ZEC = 45000;",
    "const RATE_PER_ZEC = 2500  # noqa",
    "TUZI_PER_ZEC = 2.5e3",
    # The lowercase outage-fallback shape, which is the one that would ship.
    '            tuzis_per_zec = Decimal("2500")',
    "        tuzis_per_zec = 2500",
    "    rate_per_zec = Decimal('75263.00')  # last known good",
])
def test_the_rate_constant_scanners_actually_fire(line):
    """The positive control for the two scanners above.

    A scan test that matches nothing passes just as green whether or not its
    regex works, which is the dominant defect class in this repo. Each line
    here is a way  could ship again; at least one scanner must catch it.
    """
    assert (_DEAD_NAME.search(line) or _LITERAL_RATE.match(line)
            or _LITERAL_RATE_LOWER.match(line)), line


@pytest.mark.parametrize("line", [
    "export const BOOTSTRAP_TUZIS_PER_ZEC = Math.round(BOOTSTRAP_ZEC_USD * 2);",
    "            tuzis_per_zec=tuzis_per_zec,",
    "            tuzis_per_zec = current_tuzis_per_zec()",
    "    return snapshot.tuzis_per_zec",
    "    tuzis_per_zec = Decimal(tuzis_per_zec)",
    "        tuzis_per_zec=constants.tuzis_per_zec(result.zec_usd, spread),",
])
def test_the_rate_constant_scanners_do_not_fire_on_the_fix(line):
    """The negative control: the live-pricing path must not trip the scanners.

    A guard that flags the correct code gets disabled by the next person who
    hits it, and then it guards nothing.
    """
    assert not _DEAD_NAME.search(line), line
    assert not _LITERAL_RATE.match(line), line
    assert not _LITERAL_RATE_LOWER.match(line), line


# --------------------------------------------------------------------------
#  -- the three ways `audit_zec_credits`'s join lies
#
# The first revision reported 20 creators / 55 notes / 15.23 ZEC against
# production and exited 1 ("a definite shortfall"). All 20 were false
# positives. Each test below is one of the mechanisms, and each fails against
# the pre- command: it raises SystemExit(1) and prints SUSPECT.
#
# The fourth is the control that matters more than the other three: narrowing
# exit 1 must not make a real, current loss invisible.
# --------------------------------------------------------------------------

_EPOCH = _audit.BOUGHT_TUZI_EPOCH
# The instant `g12f/0075` ran in production, stamped onto all 809 rows that
# already existed. The exact value is incidental -- what the command keys on
# is that two rows share it.
_SCHEMA_BACKFILL = datetime(2023, 11, 28, 5, 21, 58, 14142, tzinfo=timezone.utc)
# `creator_factory` stamps `date_joined` with "now", so a back-dated purchase
# on a fresh account looks RE-POINTED and is dropped for that reason. Any test
# that is about datability rather than re-pointing must pin an old account, or
# it passes for the wrong reason -- the failure mode this repo calls a test
# that cannot fail.
_ANCIENT = datetime(2021, 1, 1, tzinfo=timezone.utc)


def _purchase(creator, txid, amount="1.00000000", created_at=None):
    """A `buy_2z` row, optionally back-dated.

    `created_at` is `auto_now_add`, so it can only be set with an UPDATE --
    which is also exactly how the two artefacts under test came to exist.
    """
    tx = Transaction.objects.create(
        txid=txid, creator=creator, amount=Decimal(amount), action="buy_2z")
    if created_at is not None:
        Transaction.objects.filter(pk=tx.pk).update(created_at=created_at)
        tx.refresh_from_db()
    return tx


@pytest.mark.django_db
def test_a_purchase_older_than_the_event_stream_is_not_a_shortfall(
        creator_factory, capsys):
    """BOUGHT_TUZI did not exist until 2023-07-05; the loop dates from 2022-11.

    Eight months of correctly-credited purchases have zero events *by
    construction*. Counting events against them manufactures a shortfall that
    never happened, and in production that is most of the 55 notes.
    """
    buyer = creator_factory(
        username="preepoch", tuzis=Decimal("0"), date_joined=_ANCIENT)
    _purchase(buyer, "a1" * 32,
              created_at=_EPOCH - timedelta(days=120))

    with pytest.raises(SystemExit) as exit_info:
        call_command("audit_zec_credits")

    assert exit_info.value.code == 2, (
        "a purchase that predates the event stream was reported as a "
        "definite shortfall")
    assert "SUSPECT" not in capsys.readouterr().out


@pytest.mark.django_db
def test_a_schema_backfilled_timestamp_is_not_a_purchase_date(
        creator_factory, capsys):
    """`created_at` came from an AddField default, not from an INSERT.

    `g12f/0075` added the column with `auto_now_add=True` and a one-off
    `default=timezone.now`, so every pre-existing row carries the single
    instant the migration ran -- which the audit then printed as `seen=`,
    making 55 notes look like they all arrived on 2023-11-28. It is a lower
    bound on the row's existence and nothing more.

    KNOWN LIMIT: the detector is "a timestamp two or more rows share", so a
    table in which exactly one row was backfilled looks datable. Production
    has 809 rows on one value; a single-row table is not a case worth more
    machinery.
    """
    buyer = creator_factory(
        username="stamped", tuzis=Decimal("0"), date_joined=_ANCIENT)
    for i in range(2):
        _purchase(buyer, f"b{i}" + "1" * 62, created_at=_SCHEMA_BACKFILL)

    with pytest.raises(SystemExit) as exit_info:
        call_command("audit_zec_credits")

    out = capsys.readouterr().out
    assert exit_info.value.code == 2, (
        "a migration's own timestamp was read as a purchase date and "
        "reported as a definite shortfall")
    assert "SUSPECT" not in out
    assert "undatable" in out


@pytest.mark.django_db
def test_a_row_charged_to_an_account_younger_than_itself_is_reported(
        creator_factory, capsys):
    """The pre- loop rewrote `Transaction.creator` on every cycle.

    `transaction.creator = creator; transaction.save()` ran for every
    historical note on every 90-second scan, re-resolving the memo's username.
    When a username changes hands the whole history migrates to the new
    account while the BOUGHT_TUZI events stay with the account that was
    actually paid, so the join is wrong on BOTH sides.

    The row cannot legitimately predate the account: the loop resolves the
    Creator before writing the row. That makes this proof, not a heuristic --
    and it is how creator 1295 (`ZFAVClub`, joined 2024-05-05) was found
    holding nine notes whose 2Z went to creator 570.
    """
    late = creator_factory(
        username="tookthename", tuzis=Decimal("0"),
        date_joined=datetime(2024, 5, 5, tzinfo=timezone.utc))
    _purchase(late, "c1" * 32,
              created_at=datetime(2024, 3, 16, tzinfo=timezone.utc))

    with pytest.raises(SystemExit) as exit_info:
        call_command("audit_zec_credits")

    out = capsys.readouterr().out
    assert exit_info.value.code == 2, (
        "a re-pointed note was reported as a definite shortfall against a "
        "creator who never bought it")
    assert "RE-POINTED" in out
    assert "SUSPECT" not in out


@pytest.mark.django_db
def test_a_loss_today_is_still_a_definite_shortfall(
        creator_factory, capsys):
    """THE CONTROL. Narrowing exit 1 must not make a real loss invisible.

    A note eaten by 's crash window today has a real `created_at` after
    the epoch and an untouched creator FK, so none of the three exemptions
    applies to it -- even in the same database as rows that qualify for all
    three.
    """
    lost = creator_factory(username="losttoday", tuzis=Decimal("0"))
    _purchase(lost, "d1" * 32)                      # datable, no event

    old = creator_factory(
        username="oldbuyer", tuzis=Decimal("0"), date_joined=_ANCIENT)
    _purchase(old, "d2" * 32, created_at=_EPOCH - timedelta(days=30))

    moved = creator_factory(
        username="movedname", tuzis=Decimal("0"),
        date_joined=datetime(2024, 5, 5, tzinfo=timezone.utc))
    _purchase(moved, "d3" * 32,
              created_at=datetime(2024, 3, 16, tzinfo=timezone.utc))

    with pytest.raises(SystemExit) as exit_info:
        call_command("audit_zec_credits")

    out = capsys.readouterr().out
    assert exit_info.value.code == 1, (
        "a note lost today was downgraded to 'cannot be verified' by the "
        "#1410 exemptions")
    assert f"SUSPECT creator={lost.pk} " in out
    assert f"SUSPECT creator={old.pk} " not in out
    assert f"SUSPECT creator={moved.pk} " not in out


@pytest.mark.django_db
def test_one_inherited_note_does_not_excuse_a_later_loss_on_the_same_account(
        creator_factory, capsys):
    """Exempt the ROW, never the creator. (codex adversarial review.)

    An account can inherit an old note through username reuse AND then lose a
    purchase of its own to the crash window. The first cut exempted any
    creator with re-pointing evidence, so the second, genuine loss was never
    counted -- a real shortfall made invisible by the fix for a false one.
    Removing only the re-pointed row leaves both sides sound, because a
    re-point moves the row and never the events.
    """
    heir = creator_factory(
        username="inheritor", tuzis=Decimal("0"),
        date_joined=datetime(2024, 5, 5, tzinfo=timezone.utc))
    _purchase(heir, "f1" * 32,                       # inherited, re-pointed
              created_at=datetime(2024, 3, 16, tzinfo=timezone.utc))
    _purchase(heir, "f2" * 32)                       # its own, datable, lost

    with pytest.raises(SystemExit) as exit_info:
        call_command("audit_zec_credits")

    out = capsys.readouterr().out
    assert exit_info.value.code == 1, (
        "a genuine loss was excused because the same account had also "
        "inherited a re-pointed note")
    assert f"SUSPECT creator={heir.pk} zec_purchases=1 " in out, (
        "the inherited note must not be counted against this account either")
    assert "RE-POINTED" in out


@pytest.mark.django_db
def test_an_undatable_sibling_does_not_delete_a_loss_from_the_report(
        creator_factory, capsys):
    """The undecidable middle is reported, not dropped. (codex review.)

    One credited purchase carrying the schema-backfill timestamp plus one
    later purchase lost in the crash window is ONE datable purchase and ONE
    event: balanced, so no SUSPECT -- and the buyer is short. Which of the two
    notes is short cannot be decided from the database, so the creator has to
    stay in the output as POSSIBLE rather than vanish from it.
    """
    buyer = creator_factory(
        username="halfhidden", tuzis=Decimal("0"), date_joined=_ANCIENT)
    for i in range(2):     # two rows share the instant => schema backfill
        _purchase(buyer, f"9{i}" + "a" * 62, created_at=_SCHEMA_BACKFILL)
    _purchase(buyer, "9c" * 32)                      # datable, lost
    Event.objects.create(                            # covers ONE of the three
        read=False, type="BOUGHT_TUZI", amount=1,
        receiving_user=buyer, payee=buyer)

    with pytest.raises(SystemExit) as exit_info:
        call_command("audit_zec_credits")

    out = capsys.readouterr().out
    assert exit_info.value.code == 2
    assert "SUSPECT" not in out, (
        "one datable purchase against one event is not a definite shortfall")
    assert f"POSSIBLE creator={buyer.pk} zec_purchases=3 " in out, (
        "a creator who is short once undatable notes are counted was dropped "
        "from the report entirely")
    assert "9c" * 32 in out, (
        "the datable note -- the one that may actually be unpaid -- was left "
        "out of the listing an operator is told to reconcile")


@pytest.mark.django_db
def test_a_listed_note_names_the_username_its_memo_asked_for(
        creator_factory, capsys):
    """`created_at < date_joined` proves a re-point; its absence proves none.

    An account OLDER than the note it inherited leaves no trace in this table
    at all, so a SUSPECT line can still be a re-point nobody can see. The memo
    is immutable and names who the buyer asked to be credited, so it is
    printed whenever it disagrees with the FK -- the operator resolves
    ownership by hand, and the command never implies it did that for them.
    (Found by the codex adversarial review.)
    """
    old_account = creator_factory(
        username="tookitover", tuzis=Decimal("0"),
        date_joined=datetime(2022, 1, 1, tzinfo=timezone.utc))
    tx = _purchase(old_account, "aa" * 32)
    Transaction.objects.filter(pk=tx.pk).update(
        memo_plain='{"act":"buy_2z","id":"someoneelse"}')

    with pytest.raises(SystemExit) as exit_info:
        call_command("audit_zec_credits")

    out = capsys.readouterr().out
    assert exit_info.value.code == 1
    assert "MEMO-NAMES='someoneelse' (not this account)" in out
    assert "RE-POINTED" not in out, (
        "this re-point is invisible to the date check, which is the point")


@pytest.mark.django_db
def test_an_account_holding_more_events_than_notes_is_named(
        creator_factory, capsys):
    """A re-point leaves the event behind on the account it came FROM.

    That surplus event can cover a genuine later loss on the same account, and
    this table cannot say where a re-pointed note came from -- so the account
    is named rather than the masking being left implicit. It is how creator
    570 was found holding seven BOUGHT_TUZI events and no notes at all.
    (Second codex pass.)
    """
    stranded = creator_factory(
        username="strandedevents", tuzis=Decimal("0"), date_joined=_ANCIENT)
    _purchase(stranded, "b7" * 32)
    for _ in range(3):
        Event.objects.create(
            read=False, type="BOUGHT_TUZI", amount=1,
            receiving_user=stranded, payee=stranded)

    with pytest.raises(SystemExit):
        call_command("audit_zec_credits")

    out = capsys.readouterr().out
    assert (f"EXCESS-EVENTS creator={stranded.pk} ('strandedevents') holds 3 "
            f"BOUGHT_TUZI event(s) against 1 buy_2z note(s)") in out


@pytest.mark.django_db
def test_a_definite_shortfall_does_not_authorise_crediting_anybody(
        creator_factory, capsys):
    """A missing event is not proof the 2Z were never issued.

    Before  `ledger.credit` and `Event.objects.create` were separate
    autocommit statements, so a crash BETWEEN them leaves a buyer who WAS paid
    and has no event -- indistinguishable, in this table, from one who was
    not. Crediting on that evidence creates 2Z and pays the purchase twice, so
    the report has to say so where the operator reads it, not only in a
    docstring. (Second codex pass.)
    """
    buyer = creator_factory(username="ambiguous", tuzis=Decimal("0"))
    _purchase(buyer, "c7" * 32)

    with pytest.raises(SystemExit) as exit_info:
        call_command("audit_zec_credits")

    out = capsys.readouterr().out
    assert exit_info.value.code == 1
    assert "WHAT A MISSING EVENT IS NOT" in out
    assert "never on its own a reason to credit" in out


@pytest.mark.django_db
def test_a_balanced_count_still_names_every_unverified_note(
        creator_factory, capsys):
    """The per-creator listings are triage; they cannot be complete.

    One stale event left behind by a re-point, plus one purchase lost in the
    crash window, is one note and one event: balanced. That creator is in
    neither listing and the buyer is never named. Events carry no txid, so no
    arrangement of counts closes that hole -- the complete set has to be
    reachable from the report itself. (Third codex pass.)
    """
    hidden = creator_factory(
        username="exactlybalanced", tuzis=Decimal("0"), date_joined=_ANCIENT)
    _purchase(hidden, "d7" * 32)
    Event.objects.create(          # the stale event, from a note now re-pointed
        read=False, type="BOUGHT_TUZI", amount=1,
        receiving_user=hidden, payee=hidden)

    with pytest.raises(SystemExit) as exit_info:
        call_command("audit_zec_credits")
    out = capsys.readouterr().out
    assert exit_info.value.code == 2
    assert "SUSPECT" not in out and "POSSIBLE" not in out
    assert "--show-unverified for all of them" in out
    assert "Only the wallet is complete." in out, (
        "the report claims a completeness g12f.Transaction cannot deliver: "
        "until #1132 it was keyed on the bare txid, so a second note of a "
        "multi-output transaction may have left no row at all")
    assert "d7" * 32 not in out, "precondition: triage does not name it"

    with pytest.raises(SystemExit):
        call_command("audit_zec_credits", show_unverified=True)
    listed = capsys.readouterr().out
    assert f"UNVERIFIED {'d7' * 32}" in listed, (
        "the wider listing does not name the note that a balanced count "
        "hides")


@pytest.mark.django_db
def test_an_edited_date_joined_withholds_the_claim_and_nothing_else(
        creator_factory, capsys):
    """`date_joined` is editable in the admin, so it is a signal, not a proof.

    Staff correcting or importing an account can give it a `date_joined` later
    than one of its own legitimate purchases. If that purchase really was lost
    in the crash window, dropping the row outright would delete a real loss
    from the report. Withholding only the DEFINITE claim costs nothing: the
    note is still counted, still listed, still reconciled.
    """
    corrected = creator_factory(
        username="datefixed", tuzis=Decimal("0"),
        date_joined=datetime(2025, 1, 1, tzinfo=timezone.utc))
    _purchase(corrected, "e7" * 32,
              created_at=datetime(2024, 6, 1, tzinfo=timezone.utc))

    with pytest.raises(SystemExit) as exit_info:
        call_command("audit_zec_credits")

    out = capsys.readouterr().out
    assert exit_info.value.code == 2, (
        "a row this command cannot vouch for was reported as definite")
    assert f"POSSIBLE creator={corrected.pk} zec_purchases=1 " in out, (
        "the note was dropped from the report instead of being downgraded")
    assert "e7" * 32 in out
    assert "RE-POINTED" in out


@pytest.mark.django_db
def test_a_verified_note_is_not_reopened_by_an_edited_date_joined(
        creator_factory, capsys):
    """Exit 0 has to stay reachable, or the command manufactures false work.

    A note with a receipt THIS code wrote, carrying a recorded 2Z amount, is
    positively verified. `date_joined` being corrected afterwards makes the
    re-point signal fire, but it cannot un-verify a receipt -- and forcing
    exit 2 on it would mean the audit never goes green again while inventing
    permanent operational work. (Fourth codex pass.)
    """
    buyer = creator_factory(
        username="verifiedlate", tuzis=Decimal("0"),
        date_joined=datetime(2025, 1, 1, tzinfo=timezone.utc))
    txid = "f9" * 32
    _purchase(buyer, txid,
              created_at=datetime(2024, 6, 1, tzinfo=timezone.utc))
    ZecCreditReceipt.objects.create(
        txid=txid, output_index=0, creator=buyer,
        amount_zec=Decimal("1.00000000"),
        tuzis_credited=Decimal("90000.000"))
    Event.objects.create(
        read=False, type="BOUGHT_TUZI", amount=1,
        receiving_user=buyer, payee=buyer)

    call_command("audit_zec_credits")     # no SystemExit

    out = capsys.readouterr().out
    assert "RE-POINTED" in out, (
        "the signal must still be reported; only the exit code changes")
    assert "SUSPECT" not in out and "POSSIBLE" not in out


def test_the_epoch_is_not_derived_from_the_data_it_judges():
    """A data-derived epoch would move to cover the loss it is meant to find.

    `min(Event.created_at)` looks like the obvious way to learn when the event
    stream starts. It is circular: if every BOUGHT_TUZI event were ever lost,
    a derived epoch would slide forward past every purchase and the audit
    would go quiet about exactly the catastrophe it exists to detect. So the
    constant is READ OFF production once and pinned; the source must not
    compute it from the table it judges.
    """
    assert _audit.BOUGHT_TUZI_EPOCH == datetime(
        2023, 7, 5, 1, 38, 5, tzinfo=timezone.utc), (
        "the epoch must be the first BOUGHT_TUZI event OBSERVED in "
        "production, not the author time of the commit that added the "
        "event -- code cannot emit before it ships")

    source = Path(_audit.__file__).read_text()
    epoch_assignment = re.search(
        r"^BOUGHT_TUZI_EPOCH\s*=\s*(.+)$", source, re.MULTILINE)
    assert epoch_assignment, "BOUGHT_TUZI_EPOCH is no longer a module constant"
    assert "Event" not in epoch_assignment.group(1), (
        "the epoch is being derived from the events it is used to audit")
