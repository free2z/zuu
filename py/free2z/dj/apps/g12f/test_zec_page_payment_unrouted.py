""": a ZEC page payment that names no zPage is never silently dropped.

Before  ``credit_pages_unified`` printed ``zPage <id> does not exist``
and moved on: real ZEC received, recorded nowhere, refunded never, and no
alert. Every such note must now end in a durable ``ZecMemoDisposition`` row
(the  queue), a countable structured line and a BLOCKED page, and a
recorded human decision must retire all three.
"""
import codecs
import json
import re
from decimal import Decimal
from pathlib import Path

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from dj.apps.g12f.management.commands.credit_pages_unified import (
    PAGE_PAYMENT_UNROUTED_SIGNAL,
)
from dj.apps.tuzis.models import ZecMemoDisposition

_COMMAND = "dj.apps.g12f.management.commands.credit_pages_unified"
_REPO = Path(__file__).resolve().parents[5]

TXID = "ab" * 32
MISSING_PAGE = "no-such-zpage-2099"


def _hex(text):
    return codecs.encode(text.encode("utf-8"), "hex").decode()


def _memo(payload):
    return _hex(json.dumps(payload))


def _note(memo, *, txid=TXID, amount="0.25000000", pool="sapling",
          output_index=0, **extra):
    note = {
        "txid": txid,
        "amount": float(Decimal(amount)),
        "amountZat": int(Decimal(amount) * 10 ** 8),
        "pool": pool,
        "output_index": output_index,
        "memo": memo,
    }
    note.update(extra)
    return note


class FakeWallet:
    def __init__(self, notes):
        self.notes = notes

    def recieved_by(self, addr):
        return list(self.notes)


@pytest.fixture
def wallet(mocker):
    def install(notes):
        mocker.patch(f"{_COMMAND}.Client", lambda: FakeWallet(notes))

    return install


def _run(capsys):
    call_command("credit_pages_unified", no_color=True)
    return capsys.readouterr().out


def _message_regex(path):
    """The metric's own `jsonPayload.message` regex, as committed."""
    log_filter = json.loads(path.read_text())["filter"]
    match = re.search(r'jsonPayload\.message=~"((?:[^"\\]|\\.)*)"', log_filter)
    assert match, log_filter
    return re.compile(match.group(1).encode().decode("unicode_escape"))


def _counted(out, path):
    regex = _message_regex(path)
    return [line for line in out.splitlines() if regex.search(line)]


def _events(out):
    prefix = f"credit_pages_unified: {PAGE_PAYMENT_UNROUTED_SIGNAL} "
    return [json.loads(line[len(prefix):])
            for line in out.splitlines() if line.startswith(prefix)]






@pytest.mark.django_db
def test_credited_manually_is_refused_for_a_page_observation(wallet, capsys):
    wallet([_note(_memo({"act": "page_fund", "id": MISSING_PAGE}))])
    _run(capsys)
    with pytest.raises(CommandError):
        call_command(
            "dispose_zec_memo", TXID, "--pool", "sapling",
            "--output-index", "0", "--amount-zec", "0.25000000",
            "--decision", "credited_manually", "--reason", "nope",
            "--operator", "ops", "--yes", no_color=True)
    assert ZecMemoDisposition.objects.get().decision is None










@pytest.mark.django_db
def test_a_non_string_page_id_cannot_kill_the_cycle(wallet, capsys):
    wallet([_note(_memo({"act": "page_fund", "id": ["x"]}), txid="cd" * 32),
            _note(_memo({"act": "page_fund", "id": 7}), txid="ef" * 32)])
    out = _run(capsys)
    assert ZecMemoDisposition.objects.count() == 2
    assert "Saw 2 for" in out








@pytest.mark.django_db
def test_an_older_writer_that_omits_the_new_columns_can_still_insert():
    """Deploy safety: prod migrates before the payment host's loop is hand-updated.

    An older credit_creators INSERTs without memo_action/memo_target; the
    columns must carry a database default or that insert is a NOT NULL
    violation for as long as the two are out of step.
    """
    from django.db import connection

    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO tuzis_zecmemodisposition "
            "(created_at, txid, pool, output_index, amount_zec, "
            "classification, operator, reason) "
            "VALUES (now(), %s, 'sapling', 0, 1, 'unparseable_buy_2z', '', '')",
            [TXID])
    row = ZecMemoDisposition.objects.get()
    assert (row.memo_action, row.memo_target) == ("", "")


@pytest.mark.django_db
@pytest.mark.parametrize("act", [[], {}, 7, None])
def test_a_non_string_action_cannot_kill_the_cycle(wallet, capsys, act):
    """`[]`/`{}` are unhashable; `in PAGE_ACTIONS` raised TypeError and
    aborted every cycle on the same note (codex review)."""
    wallet([_note(_memo({"act": act, "id": MISSING_PAGE}), txid="cd" * 32),
            _note(_memo({"act": "page_fund", "id": MISSING_PAGE}))])
    out = _run(capsys)
    assert "Saw 2 for" in out
    # The well-formed note behind it was still recorded.
    assert ZecMemoDisposition.objects.filter(txid=TXID).exists()




@pytest.mark.django_db
def test_refunded_is_refused_for_a_buy_2z_observation():
    """credit_creators does not honour `refunded`, so a parser repair would
    credit a refunded purchase in 2Z as well (codex review)."""
    from dj.apps.tuzis.zec import (
        record_zec_memo_disposition, record_zec_memo_observation,
    )
    record_zec_memo_observation(
        txid=TXID, pool="sapling", output_index=0, amount_zec="0.5")
    with pytest.raises(ValueError):
        record_zec_memo_disposition(
            txid=TXID, pool="sapling", output_index=0, amount_zec="0.5",
            decision=ZecMemoDisposition.REFUNDED, operator="ops",
            reason="refunded")
    assert ZecMemoDisposition.objects.get().decision is None
