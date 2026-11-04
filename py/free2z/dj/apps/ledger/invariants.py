"""The L1 reconciliation invariants, as SQL (docs/tuzis/ledger-v2.md §11).

R1  every maintained account: ``balance == Σ credits − Σ debits`` over the journal
R2  every ``user`` account: ``g12f_creator.tuzis * 1000 == balance``
R3  ``Σ balance`` over ALL accounts == 0, journal-only balances recomputed
    from the journal (and written back as the informational value)

These are the three that exist before L2; ``reconcile_ledger`` (the
dual-write release) runs them on a schedule and records
``ledger_reconcile_run`` rows. Here they are plain functions so the L1
tests can assert them after every write. Each returns the drift as a list
of ``(account key, expected, actual)`` -- empty means the invariant holds.
Archive checkpoints (``archived_balance``) do not exist yet: every
partition is hot at L1, so the sums run over the whole journal.
"""
from __future__ import annotations

from django.db import connection

_JOURNAL = """
    SELECT a.id, a.key, a.kind, a.journal_only, a.balance,
           coalesce(c.total, 0) - coalesce(d.total, 0) AS journal
      FROM ledger_account a
      LEFT JOIN (SELECT credit_account_id AS id, sum(amount) AS total
                   FROM ledger_transfer GROUP BY credit_account_id) c ON c.id = a.id
      LEFT JOIN (SELECT debit_account_id AS id, sum(amount) AS total
                   FROM ledger_transfer GROUP BY debit_account_id) d ON d.id = a.id
"""


def r1_maintained_balance_equals_journal() -> list[tuple[str, int, int]]:
    with connection.cursor() as cursor:
        cursor.execute(
            f"SELECT key, journal, balance FROM ({_JOURNAL}) j "
            "WHERE NOT journal_only AND journal <> balance ORDER BY key"
        )
        return [(k, int(e), int(a)) for k, e, a in cursor.fetchall()]


def r2_tuzis_projection_equals_balance() -> list[tuple[str, int, int]]:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT a.key, (c.tuzis * 1000)::bigint, a.balance "
            "  FROM ledger_account a JOIN g12f_creator c ON c.id = a.owner_id "
            " WHERE a.kind = 'user' AND (c.tuzis * 1000)::bigint <> a.balance ORDER BY a.key"
        )
        return [(k, int(e), int(a)) for k, e, a in cursor.fetchall()]


def r3_all_accounts_sum_to_zero(*, write_back: bool = False) -> int:
    """``Σ`` maintained balances ``+ Σ`` journal-only journal balances.

    With ``write_back`` the journal-only accounts' informational ``balance``
    column is refreshed from the journal, as ``reconcile_ledger`` will.
    """
    with connection.cursor() as cursor:
        if write_back:
            cursor.execute(
                f"UPDATE ledger_account a SET balance = j.journal, updated_at = now() "
                f"  FROM ({_JOURNAL}) j WHERE j.id = a.id AND a.journal_only AND a.balance <> j.journal"
            )
        cursor.execute(
            f"SELECT coalesce(sum(CASE WHEN journal_only THEN journal ELSE balance END), 0) "
            f"  FROM ({_JOURNAL}) j"
        )
        return int(cursor.fetchone()[0])


def check_all() -> dict:
    """Every L1 invariant at once; ``{'R1': [...], 'R2': [...], 'R3': int}``."""
    return {
        "R1": r1_maintained_balance_equals_journal(),
        "R2": r2_tuzis_projection_equals_balance(),
        "R3": r3_all_accounts_sum_to_zero(),
    }


def assert_all() -> None:
    result = check_all()
    assert result["R1"] == [], f"R1 drift (balance != journal): {result['R1']}"
    assert result["R2"] == [], f"R2 drift (tuzis*1000 != balance): {result['R2']}"
    assert result["R3"] == 0, f"R3 drift (sum over all accounts): {result['R3']}"


def r4_held_equals_open_holds():
    with connection.cursor() as cursor:
        cursor.execute('SELECT a.key,coalesce(h.amount,0),a.held FROM ledger_account a '
                       'LEFT JOIN (SELECT account_id,sum(amount) AS amount FROM ledger_hold GROUP BY account_id) h '
                       'ON h.account_id=a.id WHERE a.held<>coalesce(h.amount,0) ORDER BY a.key')
        return cursor.fetchall()


def r5_spend_windows_equal_holds_and_usage():
    with connection.cursor() as cursor:
        cursor.execute('''SELECT * FROM (WITH expected AS (
            SELECT app_id,account_id,window_start,sum(held) AS held,sum(spent) AS spent FROM (
                SELECT app_id,account_id,window_start,amount AS held,0 AS spent FROM ledger_hold WHERE window_start IS NOT NULL
                UNION ALL
                SELECT app_id,account_id,window_start,0,charged FROM ledger_ai_usage WHERE window_start IS NOT NULL
            ) entries GROUP BY app_id,account_id,window_start
        ) SELECT coalesce(e.app_id,w.app_id),coalesce(e.account_id,w.account_id),coalesce(e.window_start,w.window_start),
                 coalesce(e.held,0),coalesce(w.held_m2z,0),coalesce(e.spent,0),coalesce(w.spent_m2z,0)
          FROM expected e FULL JOIN ledger_spend_window w USING(app_id,account_id,window_start)
          WHERE coalesce(e.held,0)<>coalesce(w.held_m2z,0) OR coalesce(e.spent,0)<>coalesce(w.spent_m2z,0)) AS drift''')
        return cursor.fetchall()


def r6_usage_receipts_and_splits():
    with connection.cursor() as cursor:
        cursor.execute('''SELECT u.hold_id FROM ledger_ai_usage u
            LEFT JOIN ledger_transfer t ON t.id=u.transfer_id
            WHERE u.charged<>u.provider_m2z+u.developer_m2z+u.platform_m2z
               OR u.priced<>u.charged+u.shortfall
               OR (u.outcome='settled' AND u.charged>0 AND
                   (t.id IS NULL OR t.amount<>u.charged OR t.code<>'ai_settle'))
            UNION SELECT hold_id FROM ledger_ai_usage GROUP BY hold_id HAVING count(*)<>1''')
        return [row[0] for row in cursor.fetchall()]


def r7_clearing_equals_queued_and_pending():
    """One snapshot: journal/queue equality and an age alarm for both phases."""
    with connection.cursor() as cursor:
        cursor.execute('''SELECT * FROM (WITH journal AS (
            SELECT coalesce(sum(CASE WHEN credit_account_id=ledger.sys('sys:ai_clearing')
                                     THEN amount ELSE -amount END),0) AS amount
            FROM ledger_transfer WHERE debit_account_id=ledger.sys('sys:ai_clearing')
                                    OR credit_account_id=ledger.sys('sys:ai_clearing')
        ), pending AS (
            SELECT provider_m2z+developer_m2z+platform_m2z AS amount,created_at FROM ledger_ai_split_queue
            UNION ALL SELECT amount_m2z,created_at FROM ledger_dev_markup_pending
        ) SELECT j.amount,coalesce(sum(p.amount),0),
                 coalesce(min(p.created_at)<statement_timestamp()-interval '5 minutes',false)
          FROM journal j LEFT JOIN pending p ON true GROUP BY j.amount) AS totals''')
        journal, pending, stale = cursor.fetchone()
        return int(journal), int(pending), stale


def assert_l2():
    assert not r4_held_equals_open_holds(), 'R4 held counter drift'
    assert not r5_spend_windows_equal_holds_and_usage(), 'R5 spend window drift'
    assert not r6_usage_receipts_and_splits(), 'R6 receipt or split drift'
    journal, pending, stale = r7_clearing_equals_queued_and_pending()
    assert journal == pending, f'R7 clearing drift: {journal} != {pending}'
    assert not stale, 'R7 queue or pending credit older than five minutes'
