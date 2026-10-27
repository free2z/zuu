"""Durable, non-financial dispositions for malformed ``buy_2z`` memos."""
import codecs
import json
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

import pytest
from django.contrib import admin
from django.core.management import call_command
from django.core.management.base import CommandError

from dj.apps.events.models import Event
from dj.apps.g12f.management.commands.credit_creators import (
    PURCHASE_ACTION,
)
from dj.apps.tuzis.admin import ZecMemoDispositionAdmin
from dj.apps.tuzis.models import ZecCreditReceipt, ZecMemoDisposition
from dj.apps.tuzis.zec import (
    DISPOSITION_POOLS,
    ZecMemoDispositionConflict,
    canonical_disposition_note,
    record_zec_memo_disposition,
    record_zec_memo_observation,
)
from zcashrpc.wallet_sqlite_client import Client as WalletSQLiteClient


_COMMAND = "dj.apps.g12f.management.commands.credit_creators"
RATE = Decimal("90000.0000")


def test_wallet_adapter_pools_are_dispositionable():
    """Every wallet pool can be durably identified if its memo is malformed."""
    adapter_pools = {pool for _table, _index, pool in WalletSQLiteClient._POOLS}
    assert adapter_pools <= DISPOSITION_POOLS


def _memo_hex(payload):
    return codecs.encode(json.dumps(payload).encode("ascii"), "hex").decode()


def _malformed_purchase_memo(username="buyer"):
    return codecs.encode(
        f'{{"act": "{PURCHASE_ACTION}", "id": "{username}"'.encode(
            "ascii"
        ),
        "hex",
    ).decode()


def _note(txid, amount="0.50000000", *, pool="sapling", output_index=0,
          memo=None):
    return {
        "txid": txid,
        "amount": float(Decimal(amount)),
        "amountZat": int(Decimal(amount) * 10 ** 8),
        "pool": pool,
        "output_index": output_index,
        "memo": memo or _malformed_purchase_memo(),
    }


class FakeWallet:
    dummy = False
    pending_notes = []

    def __init__(self, notes):
        self.notes = notes

    def recieved_by(self, addr):
        return list(self.notes)


@pytest.fixture
def wallet(mocker):
    def install(notes):
        mocker.patch(f"{_COMMAND}.Client", lambda: FakeWallet(notes))

    return install


@pytest.fixture(autouse=True)
def fixed_rate(mocker):
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)


def _balance(creator):
    creator.refresh_from_db(fields=["tuzis"])
    return creator.tuzis


def _record(txid, *, pool="sapling", output_index=0,
            amount="0.50000000", decision="ignore", reason="reviewed",
            operator="ops", yes=True):
    args = [
        txid,
        "--pool", pool,
        "--output-index", str(output_index),
        "--amount-zec", amount,
        "--decision", decision,
        "--reason", reason,
        "--operator", operator,
    ]

    if yes:
        args.append("--yes")
    call_command("dispose_zec_memo", *args, no_color=True)


@pytest.mark.django_db
@pytest.mark.parametrize(
    "decision", [
        ZecMemoDisposition.NOT_PURCHASE,
        ZecMemoDisposition.IGNORE,
    ],
)
def test_disposition_clears_the_page_without_becoming_money(
        creator_factory, wallet, capsys, decision):
    """A handled note leaves the signal, but never creates financial state."""
    buyer = creator_factory(username="buyer", tuzis=Decimal("5"))
    txid = "a1" * 32
    wallet([_note(txid)])

    call_command("credit_creators", no_color=True)
    first = capsys.readouterr().out
    assert "CREDITING BLOCKED" in first
    assert "cycle ok" in first
    assert not ZecCreditReceipt.objects.exists()
    assert _balance(buyer) == Decimal("5")

    _record(txid, decision=decision)
    command_output = capsys.readouterr().out
    assert "no 2Z were issued or changed" in command_output
    assert ZecCreditReceipt.objects.count() == 0
    assert not Event.objects.filter(type="BOUGHT_TUZI").exists()

    wallet([_note(txid)])
    call_command("credit_creators", no_color=True)
    second = capsys.readouterr().out
    assert txid not in second
    assert "CREDITING BLOCKED" not in second
    assert "credit_creators: cycle ok" in second
    assert _balance(buyer) == Decimal("5")

    disposition = ZecMemoDisposition.objects.get()
    assert disposition.txid == txid
    assert disposition.pool == "sapling"
    assert disposition.output_index == 0
    assert disposition.amount_zec == Decimal("0.50000000")
    assert disposition.classification == "unparseable_buy_2z"
    assert disposition.decision == decision
    assert disposition.operator == "ops"
    assert disposition.reason == "reviewed"


@pytest.mark.django_db
def test_same_transaction_pool_and_output_keys_are_independent(
        wallet, capsys):
    """Sapling/Orchard and pool-local output indices never collapse."""
    txid = "b2" * 32
    notes = [
        _note(txid, pool="sapling", output_index=0,
              memo=_malformed_purchase_memo("first")),
        _note(txid, pool="orchard", output_index=0,
              memo=_malformed_purchase_memo("second")),
        _note(txid, pool="sapling", output_index=1,
              memo=_malformed_purchase_memo("third")),
    ]
    wallet(notes)

    call_command("credit_creators", no_color=True)
    capsys.readouterr()
    _record(txid, pool="sapling", output_index=0)
    capsys.readouterr()
    call_command("credit_creators", no_color=True)
    out = capsys.readouterr().out

    assert "sapling:0" not in out
    assert "orchard:0" in out
    assert "sapling:1" in out
    assert ZecMemoDisposition.objects.count() == 3
    assert ZecMemoDisposition.objects.filter(decision__isnull=True).count() == 2
    assert "CREDITING BLOCKED" in out


@pytest.mark.django_db
def test_repeating_the_same_record_is_idempotent_but_a_change_is_refused(
        capsys):
    txid = "c3" * 32

    record_zec_memo_observation(
        txid=txid, pool="sapling", output_index=0,
        amount_zec=Decimal("0.50000000"))
    _record(txid, decision="ignore", reason="same decision")
    capsys.readouterr()
    _record(txid, decision="ignore", reason="same decision")
    repeated = capsys.readouterr().out
    assert "ALREADY RECORDED" in repeated
    assert ZecMemoDisposition.objects.count() == 1

    with pytest.raises(CommandError, match="already has decision"):
        _record(txid, decision="not_purchase", reason="different decision")
    assert ZecMemoDisposition.objects.get().decision == "ignore"
    assert ZecMemoDisposition.objects.get().reason == "same decision"


@pytest.mark.django_db
def test_disposition_requires_exact_positive_zec_units_and_dry_run_writes_nothing(
        capsys):
    txid = "d4" * 32
    record_zec_memo_observation(
        txid=txid, pool="sapling", output_index=0,
        amount_zec=Decimal("0.00000001"))
    _record(txid, amount="0.00000001", yes=False)
    dry_run = capsys.readouterr().out
    assert "WOULD RECORD" in dry_run
    assert "0.00000001" in dry_run
    assert ZecMemoDisposition.objects.get().decision is None

    with pytest.raises(CommandError, match="at most 8 decimal places"):
        _record(txid, amount="0.000000001")
    assert ZecMemoDisposition.objects.get().decision is None


@pytest.mark.django_db
def test_operator_cannot_preseed_an_unobserved_note():
    with pytest.raises(CommandError, match="has not been observed"):
        _record("f6" * 32)
    assert not ZecMemoDisposition.objects.exists()


@pytest.mark.django_db
def test_observations_are_durable_beyond_log_cap_and_paginated(
        wallet, capsys):
    notes = [_note(f"{index:064x}") for index in range(105)]
    wallet(notes)

    call_command("credit_creators", no_color=True)
    first = capsys.readouterr().out
    assert "105 unparseable buy_2z note(s)" in first
    assert first.count("carries 0.50000000 ZEC") == 100
    assert ZecMemoDisposition.objects.filter(decision__isnull=True).count() == 105

    first_seen = ZecMemoDisposition.objects.get(txid="0" * 64).created_at
    call_command("credit_creators", no_color=True)
    capsys.readouterr()
    assert ZecMemoDisposition.objects.filter(decision__isnull=True).count() == 105
    assert ZecMemoDisposition.objects.get(txid="0" * 64).created_at == first_seen

    call_command(
        "dispose_zec_memo", "--limit", "2",
        "--offset", "103", no_color=True,
    )
    listed = capsys.readouterr().out
    assert "Showing 104-105 of 105" in listed
    assert ("0000000000000000000000000000000000000000000000000000000000000068"
            in listed)

    _record("0" * 62 + "68")
    capsys.readouterr()
    assert ZecMemoDisposition.objects.filter(decision__isnull=True).count() == 104


def test_disposition_identity_requires_explicit_supported_aliases():
    assert canonical_disposition_note({
        "txid": "AB" * 32, "note_pool": "orchard", "outindex": 2,
    }) == ("ab" * 32, "orchard", 2)
    assert canonical_disposition_note({
        "txid": "cd" * 32, "pool": "sapling", "output_index": 0,
    }) == ("cd" * 32, "sapling", 0)

    with pytest.raises(ValueError, match="output index"):
        canonical_disposition_note({
            "txid": "ef" * 32, "pool": "sapling",
        })
    with pytest.raises(ValueError, match="output index"):
        canonical_disposition_note({
            "txid": "ef" * 32, "pool": "sapling", "output_index": 0.0,
        })


@pytest.mark.django_db
def test_missing_index_cannot_be_suppressed_by_resolved_index_zero(
        wallet, capsys):
    txid = "12" * 32
    indexed = _note(txid, output_index=0)
    wallet([indexed])
    call_command("credit_creators", no_color=True)
    capsys.readouterr()
    _record(txid)
    capsys.readouterr()

    missing_index = _note(txid)
    del missing_index["output_index"]
    wallet([missing_index])
    call_command("credit_creators", no_color=True)
    out = capsys.readouterr().out
    assert "unusable wallet identity" in out
    assert "CREDITING BLOCKED" in out
    assert "cycle ok" in out
    assert ZecMemoDisposition.objects.count() == 1


@pytest.mark.django_db
def test_bad_amount_or_identity_fails_closed_without_raw_payload(
        wallet, capsys):
    invalid_amount = _note("34" * 32)
    invalid_amount["amountZat"] = "not-an-integer"
    invalid_identity = _note("not-a-transaction-id")
    wallet([invalid_amount, invalid_identity])

    # A corrupt authoritative amount is a wallet adapter failure, not a
    # successfully scanned cycle with a usable display-float substitute.
    with pytest.raises(CommandError, match='could not be credited'):
        call_command("credit_creators", no_color=True)
    out = capsys.readouterr().out
    assert "CREDITING BLOCKED" in out
    assert "cycle ok" not in out
    assert "not-an-integer" not in out
    assert "buyer" not in out
    assert not ZecMemoDisposition.objects.exists()
    assert not ZecCreditReceipt.objects.exists()


def test_native_zatoshis_override_rounded_display_float():
    from dj.apps.g12f.management.commands.credit_creators import parse_amount
    assert parse_amount({'amount': 20999999.12345678, 'amountZat': 2099999912345679}) == Decimal('20999999.12345679')
    assert parse_amount({'amount': '0.00000001'}) == Decimal('0.00000001')


@pytest.mark.parametrize('invalid', [True, '1', None, -1, 2100000000000001])
def test_invalid_native_amount_cannot_fall_back_to_display_value(invalid):
    from dj.apps.g12f.management.commands.credit_creators import parse_amount
    assert parse_amount({'amount': 1.0, 'amountZat': invalid}) is None


@pytest.mark.django_db
def test_zero_value_malformed_purchase_memo_never_arms_an_unclearable_page(
        wallet, capsys):
    """A 0-value note moved no ZEC; it cannot be dispositioned, so no page.

    A zero-valued shielded output carrying a memo is valid on chain and the
    public receive address accepts it. A disposition row requires a positive
    amount, so paging on one would open a CRITICAL incident that no operator
    action can ever close. A 1-zatoshi note, by contrast, is real money and
    must still page -- and be clearable.
    """
    zero = _note("a0" * 32)
    zero["amount"] = 0.0
    zero["amountZat"] = 0
    dust = _note("a1" * 32, amount="0.00000001")
    wallet([zero])

    call_command("credit_creators", no_color=True)
    out = capsys.readouterr().out
    assert "CREDITING BLOCKED" not in out
    assert "no ZEC arrived" in out
    assert "cycle ok" in out
    assert not ZecMemoDisposition.objects.exists()
    assert not ZecCreditReceipt.objects.exists()

    wallet([zero, dust])
    call_command("credit_creators", no_color=True)
    out = capsys.readouterr().out
    assert "CREDITING BLOCKED" in out
    row = ZecMemoDisposition.objects.get()
    assert row.txid == "a1" * 32
    _record("a1" * 32, amount="0.00000001")
    capsys.readouterr()
    call_command("credit_creators", no_color=True)
    assert "CREDITING BLOCKED" not in capsys.readouterr().out


@pytest.mark.django_db
def test_helper_refuses_credited_manually_without_a_receipt():
    """The write helper holds the receipt invariant even without the command."""
    txid = "a2" * 32
    record_zec_memo_observation(
        txid=txid, pool="sapling", output_index=0,
        amount_zec=Decimal("0.50000000"))
    with pytest.raises(ValueError, match="canonical same-note"):
        record_zec_memo_disposition(
            txid=txid, pool="sapling", output_index=0,
            amount_zec=Decimal("0.50000000"),
            decision=ZecMemoDisposition.CREDITED_MANUALLY,
            operator="ops", reason="bypassing the command")
    assert ZecMemoDisposition.objects.get().decision is None


@pytest.mark.django_db
def test_non_indexed_same_amount_notes_never_share_a_disposition(
        wallet, capsys):
    """A synthetic index zero cannot retire two distinct malformed notes."""
    txid = "45" * 32
    notes = [
        _note(txid, output_index=0, memo=_malformed_purchase_memo("first")),
        _note(txid, output_index=0, memo=_malformed_purchase_memo("second")),
    ]
    for note in notes:
        note["output_index_reliable"] = False
    wallet(notes)

    call_command("credit_creators", no_color=True)
    out = capsys.readouterr().out

    assert "could not be durably identified" in out
    assert "CREDITING BLOCKED" in out
    assert "cycle ok" in out
    assert not ZecMemoDisposition.objects.exists()

    # Once the adapter reports real pool-local indices, both observations get
    # independent durable identities even though their amounts still match.
    for index, note in enumerate(notes):
        note["output_index"] = index
        note["output_index_reliable"] = True
    wallet(notes)
    call_command("credit_creators", no_color=True)
    capsys.readouterr()
    assert set(ZecMemoDisposition.objects.values_list("output_index", flat=True)) == {0, 1}


@pytest.mark.django_db
def test_resolution_does_not_suppress_later_parseable_purchase(
        creator_factory, wallet, capsys):
    buyer = creator_factory(username="buyer", tuzis=Decimal("0"))
    txid = "56" * 32
    malformed = _note(txid)
    wallet([malformed])
    call_command("credit_creators", no_color=True)
    capsys.readouterr()
    with pytest.raises(CommandError, match="canonical same-note"):
        _record(txid, decision="credited_manually")
    capsys.readouterr()

    wallet([_note(
        txid, memo=_memo_hex({"act": PURCHASE_ACTION, "id": "buyer"}),
    )])
    call_command("credit_creators", no_color=True)
    out = capsys.readouterr().out
    assert "ACTION=buy_2z" in out
    assert ZecCreditReceipt.objects.count() == 1
    assert _balance(buyer) > 0


@pytest.mark.django_db
@pytest.mark.parametrize(
    "receipt_changes", [
        {"amount_zec": Decimal("0.40000000")},
        {"pool": "orchard"},
        {"output_index": 1},
        {"backfilled": True},
    ],
)
def test_credited_manually_requires_exact_non_backfilled_receipt(
        creator_factory, receipt_changes):
    """A near-match receipt cannot authorize an audit-only disposition."""
    buyer = creator_factory(username="receipt-proof-buyer", tuzis=Decimal("0"))
    txid = "9b" * 32
    record_zec_memo_observation(
        txid=txid, pool="sapling", output_index=0,
        amount_zec=Decimal("0.50000000"))
    receipt = dict(
        txid=txid,
        pool="sapling",
        output_index=0,
        creator=buyer,
        amount_zec=Decimal("0.50000000"),
        tuzis_credited=Decimal("45000.000"),
        tuzis_per_zec=RATE,
        backfilled=False,
    )
    receipt.update(receipt_changes)
    ZecCreditReceipt.objects.create(**receipt)

    with pytest.raises(CommandError, match="canonical same-note"):
        _record(txid, decision="credited_manually")
    assert ZecMemoDisposition.objects.get().decision is None


@pytest.mark.django_db
def test_exact_receipt_makes_manual_disposition_idempotent_and_blocks_recredit(
        creator_factory, wallet, capsys):
    """A proven manual credit can be recorded and replayed without reissue."""
    buyer = creator_factory(username="manual-proof-buyer", tuzis=Decimal("7"))
    txid = "9c" * 32
    wallet([_note(txid)])
    call_command("credit_creators", no_color=True)
    capsys.readouterr()
    ZecCreditReceipt.objects.create(
        txid=txid,
        pool="sapling",
        output_index=0,
        creator=buyer,
        amount_zec=Decimal("0.50000000"),
        tuzis_credited=Decimal("45000.000"),
        tuzis_per_zec=RATE,
        backfilled=False,
    )

    _record(txid, decision="credited_manually")
    _record(txid, decision="credited_manually")
    assert ZecMemoDisposition.objects.get().decision == "credited_manually"
    before = _balance(buyer)

    wallet([_note(
        txid, memo=_memo_hex({"act": PURCHASE_ACTION, "id": buyer.username}),
    )])
    call_command("credit_creators", no_color=True)
    capsys.readouterr()
    assert ZecCreditReceipt.objects.count() == 1
    assert _balance(buyer) == before


@pytest.mark.django_db(transaction=True)
def test_two_database_connections_have_one_observation_and_one_resolution():
    txid = "78" * 32

    def observe():
        from django.db import close_old_connections, connection
        close_old_connections()
        try:
            return record_zec_memo_observation(
                txid=txid, pool="sapling", output_index=0,
                amount_zec=Decimal("0.50000000"))
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        observed = list(pool.map(lambda _unused: observe(), range(2)))
    assert len(observed) == 2
    assert ZecMemoDisposition.objects.count() == 1

    def resolve(decision):
        from django.db import close_old_connections, connection
        close_old_connections()
        try:
            return record_zec_memo_disposition(
                txid=txid, pool="sapling", output_index=0,
                amount_zec=Decimal("0.50000000"), decision=decision,
                operator=decision, reason=f"reason-{decision}")
        except Exception as exc:  # assert the authoritative result below
            return exc
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        resolved = list(pool.map(resolve, ("ignore", "not_purchase")))
    assert sum(isinstance(result, tuple) and result[1] for result in resolved) == 1
    assert sum(isinstance(result, ZecMemoDispositionConflict) for result in resolved) == 1
    row = ZecMemoDisposition.objects.get()
    assert row.decision in {"ignore", "not_purchase"}
    assert row.operator == row.decision
    assert row.reason == f"reason-{row.decision}"


@pytest.mark.django_db
def test_empty_purchase_identity_pages_without_crediting(
        creator_factory, wallet, capsys):
    """A malformed recipient identity is never treated as a credit target."""
    creator = creator_factory(username="not-the-empty-identity",
                              tuzis=Decimal("5"))
    txid = "e5" * 32
    wallet([_note(
        txid,
        memo=_memo_hex({"act": PURCHASE_ACTION, "id": ""}),
    )])

    call_command("credit_creators", no_color=True)
    out = capsys.readouterr().out
    assert "missing or invalid recipient identity" in out
    assert "CREDITING BLOCKED" in out
    assert not ZecCreditReceipt.objects.exists()
    assert _balance(creator) == Decimal("5")


def test_disposition_admin_is_read_only():
    model_admin = ZecMemoDispositionAdmin(ZecMemoDisposition, admin.site)
    assert model_admin.has_add_permission(None) is False
    assert model_admin.has_change_permission(None) is False
    assert model_admin.has_delete_permission(None) is False
