"""Racing tests: lock order, the conditional CAS and idempotency under real
parallel transactions (design §4.3, §6). Every guarantee here is a Postgres
guarantee, so every test runs two real connections against the real database.

Mechanics (as in ``tuzis/test_money_atomicity.py``):

* ``transaction=True`` is mandatory -- the default test transaction never
  commits, so a second connection could not see the fixtures.
* Each worker thread closes its own connection.
* A ``Barrier`` lines the threads up on the critical section.

Every positive test has a NEGATIVE CONTROL that shows the harness can see
the failure it claims to exclude: a copy of the function with the lock
order inverted deadlocks (40P01); an unkeyed operation is posted twice; an
account opened without the creator lock gets a stale opening balance.
"""
import threading
import time
from decimal import Decimal

import pytest
from django.db import OperationalError, connection, transaction

from dj.apps.ledger import api, invariants
from dj.apps.tuzis.ledger import lock_in_order

from .conftest import account, balance_of, function_def, key, one, sql, transfers, tuzis_of

pytestmark = pytest.mark.django_db(transaction=True)

DEADLOCK_DETECTED = "40P01"


def run_concurrently(*fns, stagger=0.0):
    """Run each ``fn`` in its own thread, released together by a barrier;
    ``stagger`` delays thread i by ``i * stagger`` seconds after release so
    an ordering can be forced. Returns results or exceptions in order."""
    barrier = threading.Barrier(len(fns))
    results = [None] * len(fns)

    def worker(i, fn):
        try:
            barrier.wait(timeout=10)
            if stagger:
                time.sleep(i * stagger)
            results[i] = fn()
        except Exception as exc:   # asserted on by the caller
            results[i] = exc
        finally:
            connection.close()

    threads = [threading.Thread(target=worker, args=(i, fn)) for i, fn in enumerate(fns)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    for t in threads:
        assert not t.is_alive(), "worker thread wedged"
    return results


def sqlstate(exc):
    cause = exc.__cause__
    return getattr(cause, "sqlstate", None) or getattr(cause, "pgcode", None)


def python_locks_creator_then(creator, fn, hold_for=0.5):
    """A Django money path: ``lock_in_order`` (creator row, FOR NO KEY
    UPDATE) at the top of the request transaction, other work, then a
    ledger function -- which must find the same row already held."""
    def run():
        with transaction.atomic():
            lock_in_order(creator)
            time.sleep(hold_for)
            return fn()
    return run


def install_inverted_spend():
    """A copy of ``ledger.spend`` that takes the ACCOUNT lock before the
    creator lock -- the inversion §6 forbids. Built from the live body so
    the control tracks the real function."""
    defn = function_def("spend")
    lock1 = "SELECT * INTO cr FROM ledger.lock_creator(p_user_id);"
    assert defn.count(lock1) == 1, "the creator lock line moved; update this control"
    prelock = ("SELECT * INTO a FROM public.ledger_account x WHERE x.key = 'user:' || p_user_id "
               "FOR NO KEY UPDATE;\n    ")
    inverted = defn.replace("FUNCTION ledger.spend(", "FUNCTION ledger.spend_inverted(", 1)
    inverted = inverted.replace(lock1, prelock + lock1, 1)
    sql(inverted)


def install_inverted_transfer():
    defn = function_def("transfer_users")
    assert defn.count("IF p_from < p_to THEN") == 2, "the pk-order branches moved; update this control"
    inverted = defn.replace("FUNCTION ledger.transfer_users(", "FUNCTION ledger.transfer_users_inverted(", 1)
    inverted = inverted.replace("IF p_from < p_to THEN", "IF p_from > p_to THEN")
    sql(inverted)


# Every compound function: (name, identity arguments, the line its claim
# block starts on, the line the creator locks start on). The claim-first
# control below moves the block from the former to just before the latter.
COMPOUND = {
    "credit_user": ("bigint, bigint, text, text, text, text, text",
                    "    SELECT * INTO cl FROM ledger.claim(p_idem);",
                    "    SELECT * INTO cr FROM ledger.lock_creator(p_user_id);"),
    "credit_purchase": ("bigint, bigint, text, text, text, text",
                        "    SELECT * INTO cl FROM ledger.claim(p_idem);",
                        "    SELECT * INTO cr FROM ledger.lock_creator(p_user_id);"),
    "clawback": ("bigint, bigint, text, text, text, text, text, text, boolean",
                 "    IF p_idem IS NOT NULL THEN\n        SELECT * INTO cl FROM ledger.claim(p_idem);",
                 "    SELECT * INTO cr FROM ledger.lock_creator(p_user_id);"),
    "refund_purchase": ("bigint, text, text, bigint, text, text, boolean",
                        "    SELECT * INTO cl FROM ledger.claim(p_idem);",
                        "    SELECT * INTO cr FROM ledger.lock_creator(p_user_id);"),
    "restore_purchase": ("bigint, text, text, bigint, text",
                         "    SELECT * INTO cl FROM ledger.claim(p_idem);",
                         "    SELECT * INTO cr FROM ledger.lock_creator(p_user_id);"),
    "transfer_users": ("bigint, bigint, bigint, text, text, text",
                       "    SELECT * INTO cl FROM ledger.claim(p_idem);",
                       "    IF p_from < p_to THEN"),
}


def install_claim_first(name):
    """A copy of a compound function that claims its idempotency key BEFORE
    the creator locks -- the design's original "class 0" order, which the
    codex review of  showed deadlocks against a Django caller that
    already holds the creator row. Built from the live body so the control
    tracks the real function."""
    _args, claim_marker, lock_marker = COMPOUND[name]
    defn = function_def(name)
    claim_start = defn.index(claim_marker)
    claim_end = defn.index("\n    END IF;\n", claim_start) + len("\n    END IF;\n")
    block = defn[claim_start:claim_end]
    without = defn[:claim_start] + defn[claim_end:]
    at = without.index(lock_marker)
    claim_first = without[:at] + block.lstrip(" ") + "    " + without[at:].lstrip(" ")
    # The replay branch reads `a`/`af` from the row, which is fine unlocked here.
    sql(claim_first.replace(f"FUNCTION ledger.{name}(", f"FUNCTION ledger.{name}_claim_first(", 1))


@pytest.fixture
def drop_controls():
    yield
    sql("DROP FUNCTION IF EXISTS ledger.spend_inverted(bigint, bigint, text, text, text)")
    sql("DROP FUNCTION IF EXISTS ledger.transfer_users_inverted(bigint, bigint, bigint, text, text, text)")
    for name, (args, _c, _l) in COMPOUND.items():
        sql(f"DROP FUNCTION IF EXISTS ledger.{name}_claim_first({args})")


# ------------------------------------------------------------- overspend


def test_two_full_balance_spends_serialize_on_the_creator_lock_and_exactly_one_posts(creator_factory):
    """`spend`'s admission check runs under the creator + account locks, so
    the loser sees the winner's committed balance and answers `insufficient`."""
    creator = creator_factory(tuzis=Decimal("100"))

    def spend():
        return api.spend(creator.pk, 100000, "page_vote")

    results = run_concurrently(spend, spend)
    assert not any(isinstance(r, Exception) for r in results), results
    assert sorted(r.status for r in results) == ["insufficient", "posted"], results
    assert balance_of(f"user:{creator.pk}") == 0 and tuzis_of(creator) == Decimal("0")
    invariants.assert_all()


def test_the_post_transfer_cas_alone_refuses_the_second_overdraw(creator_factory):
    """§4.3's conditional UPDATE, with NO caller locks at all: Postgres takes
    the row lock and re-evaluates `balance - held >= amount` against the
    newest committed row (READ COMMITTED EvalPlanQual), so two unlocked
    posts that together overdraw cannot both match."""
    creator = creator_factory(tuzis=Decimal("100"))
    acct = api.ensure_account(creator.pk)
    sink = one("SELECT ledger.sys('sys:platform_revenue')")[0]

    def post_it():
        return one("SELECT status FROM ledger.post_transfer(%s, %s, 100000, 'spend', 'race', '', NULL, NULL)",
                   [acct, sink])[0]

    results = run_concurrently(post_it, post_it)
    assert sorted(results) == ["insufficient", "posted"], results
    assert balance_of(f"user:{creator.pk}") == 0 and tuzis_of(creator) == Decimal("0")
    invariants.assert_all()


# ------------------------------------------------------------- lock order


def test_a_python_creator_lock_then_spend_does_not_deadlock_a_concurrent_spend(creator_factory):
    """The §6 rule in action: the SQL function locks the creator row first,
    so a Django caller that already holds it and a concurrent bare call
    serialize on the same row and never form a cycle."""
    creator = creator_factory(tuzis=Decimal("10"))
    api.ensure_account(creator.pk)

    def bare():
        return api.spend(creator.pk, 1000, "comment")

    results = run_concurrently(
        python_locks_creator_then(creator, lambda: api.spend(creator.pk, 2000, "page_vote")),
        bare, stagger=0.15,
    )
    assert not any(isinstance(r, Exception) for r in results), results
    assert [r.status for r in results] == ["posted", "posted"]
    assert balance_of(f"user:{creator.pk}") == 7000 and tuzis_of(creator) == Decimal("7")
    invariants.assert_all()


def test_negative_control_the_inverted_lock_order_deadlocks(creator_factory, drop_controls):
    creator = creator_factory(tuzis=Decimal("10"))
    api.ensure_account(creator.pk)
    install_inverted_spend()

    def bare():
        return one("SELECT * FROM ledger.spend_inverted(%s, 1000, 'comment')", [creator.pk])

    results = run_concurrently(
        python_locks_creator_then(
            creator, lambda: one("SELECT * FROM ledger.spend_inverted(%s, 2000, 'page_vote')", [creator.pk])),
        bare, stagger=0.15,
    )
    errors = [r for r in results if isinstance(r, OperationalError)]
    assert len(errors) == 1 and sqlstate(errors[0]) == DEADLOCK_DETECTED, results


def test_opposite_direction_transfers_do_not_deadlock(creator_factory):
    a = creator_factory(tuzis=Decimal("10"))
    b = creator_factory(tuzis=Decimal("10"))
    assert a.pk < b.pk

    results = run_concurrently(
        python_locks_creator_then(a, lambda: api.transfer_users(a.pk, b.pk, 3000, "donation", "", key())),
        lambda: api.transfer_users(b.pk, a.pk, 1000, "donation", "", key()),
        stagger=0.15,
    )
    assert not any(isinstance(r, Exception) for r in results), results
    assert [r.status for r in results] == ["posted", "posted"]
    assert balance_of(f"user:{a.pk}") == 8000 and balance_of(f"user:{b.pk}") == 12000
    invariants.assert_all()


def test_negative_control_a_transfer_that_locks_out_of_pk_order_deadlocks(creator_factory, drop_controls):
    a = creator_factory(tuzis=Decimal("10"))
    b = creator_factory(tuzis=Decimal("10"))
    assert a.pk < b.pk
    install_inverted_transfer()

    results = run_concurrently(
        python_locks_creator_then(a, lambda: api.transfer_users(a.pk, b.pk, 3000, "donation", "", key())),
        lambda: one("SELECT * FROM ledger.transfer_users_inverted(%s, %s, 1000, 'donation', '', %s)",
                    [a.pk, b.pk, key()]),
        stagger=0.15,
    )
    errors = [r for r in results if isinstance(r, OperationalError)]
    assert len(errors) == 1 and sqlstate(errors[0]) == DEADLOCK_DETECTED, results


# ------------------------------------------------------------- ensure_account


def test_two_concurrent_opens_produce_one_account_and_one_opening_transfer(creator_factory):
    creator = creator_factory(tuzis=Decimal("42"))

    def open_it():
        return api.ensure_account(creator.pk)

    results = run_concurrently(open_it, open_it)
    assert not any(isinstance(r, Exception) for r in results), results
    assert results[0] == results[1]
    assert len(transfers(code="opening")) == 1
    assert account(f"user:{creator.pk}")[1] == 42000
    invariants.assert_all()


def test_the_creator_lock_makes_the_opening_balance_consistent_with_a_concurrent_writer(creator_factory):
    """A legacy writer (an old pod) holds the creator row while moving
    tuzis. ``ensure_account`` under the creator lock waits for it and opens
    with the committed balance; without the lock (negative control) it opens
    with the stale one and R2 is broken the moment the writer commits."""
    def legacy_writer(creator):
        def run():
            with transaction.atomic():
                lock_in_order(creator)
                sql("UPDATE g12f_creator SET tuzis = tuzis + 50 WHERE id = %s", [creator.pk])
                time.sleep(0.5)
        return run

    locked = creator_factory(tuzis=Decimal("10"))
    results = run_concurrently(legacy_writer(locked), lambda: api.ensure_account(locked.pk), stagger=0.15)
    assert not any(isinstance(r, Exception) for r in results), results
    assert account(f"user:{locked.pk}")[1] == 60000
    assert invariants.r2_tuzis_projection_equals_balance() == []

    unlocked = creator_factory(tuzis=Decimal("10"))

    def open_without_the_lock():
        return one("SELECT ledger.ensure_account(%s)", [unlocked.pk])[0]

    results = run_concurrently(legacy_writer(unlocked), open_without_the_lock, stagger=0.15)
    assert not any(isinstance(r, Exception) for r in results), results
    assert account(f"user:{unlocked.pk}")[1] == 10000, "opened from the stale value"
    assert invariants.r2_tuzis_projection_equals_balance() == [(f"user:{unlocked.pk}", 60000, 10000)]


# ------------------------------------------------------------- idempotency


def test_a_keyed_spend_raced_with_itself_posts_once(creator_factory):
    creator = creator_factory(tuzis=Decimal("10"))
    k = key("spend")

    def spend():
        return api.spend(creator.pk, 3000, "translation", "p1", idem=k)

    results = run_concurrently(spend, spend)
    assert not any(isinstance(r, Exception) for r in results), results
    assert sorted(r.status for r in results) == ["posted", "replayed"]
    assert results[0].transfer_id == results[1].transfer_id
    assert balance_of(f"user:{creator.pk}") == 7000
    invariants.assert_all()


def test_negative_control_an_unkeyed_spend_raced_with_itself_posts_twice(creator_factory):
    creator = creator_factory(tuzis=Decimal("10"))

    def spend():
        return api.spend(creator.pk, 3000, "translation", "p1")

    results = run_concurrently(spend, spend)
    assert [r.status for r in results] == ["posted", "posted"]
    assert balance_of(f"user:{creator.pk}") == 4000


def test_a_compound_credit_raced_with_itself_credits_once(creator_factory):
    """The class-0 claim (§6): the loser blocks on the key's primary key
    until the winner commits, then reads the winner's split."""
    creator = creator_factory(tuzis=Decimal("0"))
    k = key("stripe")

    def purchase():
        return api.credit_purchase(creator.pk, 5000, "stripe", "stripe_transaction", "pi_race", k)

    results = run_concurrently(purchase, purchase)
    assert not any(isinstance(r, Exception) for r in results), results
    assert sorted(r.status for r in results) == ["posted", "replayed"]
    assert results[0].transfer_id == results[1].transfer_id
    assert balance_of(f"user:{creator.pk}") == 5000 and tuzis_of(creator) == Decimal("5")
    assert one("SELECT count(*) FROM ledger_purchase_refund")[0] == 1
    invariants.assert_all()


def test_a_duplicate_compound_op_against_a_caller_holding_the_creator_lock_does_not_deadlock(creator_factory):
    """Codex finding on: the claim is taken AFTER the creator locks so
    that request A (``lock_in_order`` first, then ``transfer_users(K)``) and
    a concurrent bare ``transfer_users(K)`` serialize on the creator row --
    one posts, the other replays -- instead of forming a cycle between the
    key row and the creator row."""
    a = creator_factory(tuzis=Decimal("10"))
    b = creator_factory(tuzis=Decimal("0"))
    k = key("donation")

    def bare():
        return api.transfer_users(a.pk, b.pk, 4000, "donation", "intent", k)

    results = run_concurrently(
        python_locks_creator_then(a, lambda: api.transfer_users(a.pk, b.pk, 4000, "donation", "intent", k)),
        bare, stagger=0.15,
    )
    assert not any(isinstance(r, Exception) for r in results), results
    assert [r.status for r in results] == ["posted", "replayed"]
    assert results[0].transfer_id == results[1].transfer_id
    assert balance_of(f"user:{a.pk}") == 6000 and balance_of(f"user:{b.pk}") == 4000
    invariants.assert_all()


def _compound_call(name, a, b, k):
    """A valid keyed call of each compound function for creator ``a``."""
    calls = {
        "credit_user": ("(%s, 1000, 'sys:promo', 'grant', 'tuzi_grant', '1', %s)", [a.pk, k]),
        "credit_purchase": ("(%s, 1000, 'stripe', 'stripe_transaction', 'pi_cf', %s)", [a.pk, k]),
        "clawback": ("(%s, 1000, 'sys:clearing_stripe', 'clawback', 'r', 'stripe_transaction', 'pi_cf', %s, false)",
                     [a.pk, k]),
        "refund_purchase": ("(%s, 'stripe_transaction', 'pi_cf', 500, 'r', %s, false)", [a.pk, k]),
        "restore_purchase": ("(%s, 'stripe_transaction', 'pi_cf', 0, %s)", [a.pk, k]),
        "transfer_users": ("(%s, %s, 1000, 'donation', 'intent', %s)", [a.pk, b.pk, k]),
    }
    args, params = calls[name]
    return args, params


@pytest.mark.parametrize("name", sorted(COMPOUND))
def test_every_compound_function_survives_a_duplicate_against_a_lock_holding_caller(name, creator_factory):
    a = creator_factory(tuzis=Decimal("10"))
    b = creator_factory(tuzis=Decimal("0"))
    if name in ("refund_purchase", "restore_purchase"):
        api.credit_purchase(a.pk, 5000, "stripe", "stripe_transaction", "pi_cf", key())
    if name == "restore_purchase":
        api.refund_purchase(a.pk, "stripe_transaction", "pi_cf", 2000, "r", key())
    k = key(name)
    args, params = _compound_call(name, a, b, k)

    def call():
        return one(f"SELECT status FROM ledger.{name}{args}", params)[0]

    results = run_concurrently(python_locks_creator_then(a, call), call, stagger=0.15)
    assert not any(isinstance(r, Exception) for r in results), results
    assert results == ["posted", "replayed"], results
    invariants.assert_all()


@pytest.mark.parametrize("name", sorted(COMPOUND))
def test_negative_control_claiming_before_the_locks_deadlocks(name, creator_factory, drop_controls):
    a = creator_factory(tuzis=Decimal("10"))
    b = creator_factory(tuzis=Decimal("0"))
    if name in ("refund_purchase", "restore_purchase"):
        api.credit_purchase(a.pk, 5000, "stripe", "stripe_transaction", "pi_cf", key())
    if name == "restore_purchase":
        api.refund_purchase(a.pk, "stripe_transaction", "pi_cf", 2000, "r", key())
    install_claim_first(name)
    k = key(name)
    args, params = _compound_call(name, a, b, k)

    def call():
        return one(f"SELECT status FROM ledger.{name}_claim_first{args}", params)[0]

    results = run_concurrently(python_locks_creator_then(a, call), call, stagger=0.15)
    errors = [r for r in results if isinstance(r, OperationalError)]
    assert len(errors) == 1 and sqlstate(errors[0]) == DEADLOCK_DETECTED, results


def test_negative_control_two_keys_two_credits(creator_factory):
    creator = creator_factory(tuzis=Decimal("0"))

    def grant(n):
        return lambda: api.credit_user(creator.pk, 5000, "sys:promo", "grant", "tuzi_grant", str(n), key("grant"))

    results = run_concurrently(grant(1), grant(2))
    assert [r.status for r in results] == ["posted", "posted"]
    assert balance_of(f"user:{creator.pk}") == 10000
