"""``manage.py grant_tuzis`` -- the audited way to grant 2Z.

Real Postgres, real ledger. Each test states the property it pins; the ones
that exist because a management command runs in AUTOCOMMIT (no
``AtomicMiddleware``) are the atomicity and idempotency ones.
"""
import json
from decimal import Decimal
from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from dj.apps.tuzis.models import IdempotencyKey, TuziGrant
from dj.apps.tuzis.management.commands import grant_tuzis as cmd

REASON = "upload smoke tier (#2050)"


def run(*args, **kwargs):
    out = StringIO()
    kwargs.setdefault("operator", "pytest-operator")
    call_command("grant_tuzis", *args, stdout=out, **kwargs)
    return out.getvalue()


def balance(creator):
    creator.refresh_from_db(fields=["tuzis"])
    return creator.tuzis


def log_lines(output):
    return [json.loads(line) for line in output.splitlines()
            if line.startswith("{")]


@pytest.fixture(autouse=True)
def _not_prod(monkeypatch):
    monkeypatch.delenv("NAMESPACE", raising=False)


@pytest.mark.django_db
def test_grant_credits_ledger_and_writes_receipt(creator_factory):
    smoke = creator_factory(username="f2z-smoke", tuzis=Decimal("0"))

    out = run("f2z-smoke", "5", reason=REASON)

    assert balance(smoke) == Decimal("5")
    grant = TuziGrant.objects.get()
    assert grant.creator_id == smoke.pk
    assert grant.username == "f2z-smoke"
    assert grant.amount == Decimal("5")
    assert grant.balance_after == Decimal("5")
    assert grant.reason == REASON
    assert grant.operator == "pytest-operator"
    assert "database=" in grant.environment
    assert grant.idempotency_key == ""
    assert grant.created_at is not None

    # The environment is announced before anything else is printed.
    assert out.splitlines()[0].startswith("grant_tuzis: environment: namespace=")
    [line] = log_lines(out)
    assert line["event"] == "tuzi_grant"
    assert line["outcome"] == "granted"
    assert line["severity"] == "WARNING"
    assert line["amount"] == "5.000"
    assert line["username"] == "f2z-smoke"
    assert line["grant_id"] == grant.pk


@pytest.mark.django_db
def test_grant_adds_to_an_existing_balance_and_matches_username_case_insensitively(
    creator_factory,
):
    smoke = creator_factory(username="f2z-smoke", tuzis=Decimal("2.5"))
    run("F2Z-Smoke", "1.25", reason=REASON)
    assert balance(smoke) == Decimal("3.750")
    assert TuziGrant.objects.get().username == "f2z-smoke"


@pytest.mark.django_db
def test_operator_defaults_to_user_env(creator_factory, monkeypatch):
    creator_factory(username="f2z-smoke", tuzis=Decimal("0"))
    monkeypatch.setenv("USER", "ops-person")
    out = StringIO()
    call_command("grant_tuzis", "f2z-smoke", "1", reason=REASON, stdout=out)
    assert TuziGrant.objects.get().operator == "ops-person"


@pytest.mark.django_db
def test_dry_run_writes_nothing(creator_factory):
    smoke = creator_factory(username="f2z-smoke", tuzis=Decimal("0"))

    out = run("f2z-smoke", "5", reason=REASON, dry_run=True,
              idempotency_key="dry-run-key")

    assert balance(smoke) == Decimal("0")
    assert not TuziGrant.objects.exists()
    assert not IdempotencyKey.objects.exists()
    assert "DRY RUN" in out
    assert [line["outcome"] for line in log_lines(out)] == ["dry_run"]


@pytest.mark.django_db
def test_same_idempotency_key_credits_once(creator_factory):
    smoke = creator_factory(username="f2z-smoke", tuzis=Decimal("0"))

    run("f2z-smoke", "5", reason=REASON, idempotency_key="restore-1")
    second = run("f2z-smoke", "5", reason=REASON, idempotency_key="restore-1")

    assert balance(smoke) == Decimal("5")
    assert TuziGrant.objects.count() == 1
    assert "REPLAY" in second
    assert [line["outcome"] for line in log_lines(second)] == ["replay"]
    record = IdempotencyKey.objects.get(scope="tuzi-grant", key="restore-1")
    assert record.response_status == 200
    assert record.response_body["grant_id"] == TuziGrant.objects.get().pk
    assert TuziGrant.objects.get().idempotency_key == "restore-1"

    # A dry run of the same key reports the replay and still writes nothing.
    dry = run("f2z-smoke", "5", reason=REASON, idempotency_key="restore-1",
              dry_run=True)
    assert "would replay" in dry
    assert balance(smoke) == Decimal("5")


@pytest.mark.django_db
def test_different_keys_each_credit(creator_factory):
    smoke = creator_factory(username="f2z-smoke", tuzis=Decimal("0"))
    run("f2z-smoke", "5", reason=REASON, idempotency_key="restore-1")
    run("f2z-smoke", "5", reason=REASON, idempotency_key="restore-2")
    assert balance(smoke) == Decimal("10")
    assert TuziGrant.objects.count() == 2


@pytest.mark.django_db
def test_reused_key_with_a_different_amount_is_refused(creator_factory):
    smoke = creator_factory(username="f2z-smoke", tuzis=Decimal("0"))
    run("f2z-smoke", "5", reason=REASON, idempotency_key="restore-1")

    with pytest.raises(CommandError, match="different grant"):
        run("f2z-smoke", "50", reason=REASON, idempotency_key="restore-1")

    assert balance(smoke) == Decimal("5")
    assert TuziGrant.objects.count() == 1


@pytest.mark.django_db
def test_a_failed_receipt_rolls_back_the_credit_and_frees_the_key(
    creator_factory, monkeypatch,
):
    """The credit and the receipt are one transaction.

    A management command runs in autocommit, so without the explicit
    ``transaction.atomic()`` the credit would commit on its own and survive a
    failure to write the receipt: a balance change with no provenance.
    """
    smoke = creator_factory(username="f2z-smoke", tuzis=Decimal("0"))

    def boom(**kwargs):
        raise RuntimeError("receipt write failed")

    monkeypatch.setattr(TuziGrant.objects, "create", boom)
    with pytest.raises(RuntimeError, match="receipt write failed"):
        run("f2z-smoke", "5", reason=REASON, idempotency_key="restore-1")

    assert balance(smoke) == Decimal("0")
    assert not IdempotencyKey.objects.filter(key="restore-1").exists()

    #...so the retry with the same key is a fresh grant, not a replay of
    # something that never happened.
    monkeypatch.undo()
    monkeypatch.delenv("NAMESPACE", raising=False)
    run("f2z-smoke", "5", reason=REASON, idempotency_key="restore-1")
    assert balance(smoke) == Decimal("5")


@pytest.mark.django_db
@pytest.mark.parametrize("amount", ["0", "-1", "-0.001", "abc", "NaN", "Infinity", "1.0005"])
def test_refuses_bad_amounts(creator_factory, amount):
    smoke = creator_factory(username="f2z-smoke", tuzis=Decimal("0"))
    with pytest.raises(CommandError):
        run("f2z-smoke", amount, reason=REASON)
    assert balance(smoke) == Decimal("0")
    assert not TuziGrant.objects.exists()


@pytest.mark.django_db
@pytest.mark.parametrize("reason", ["", "short", "  nine c.  "])
def test_refuses_a_short_reason(creator_factory, reason):
    smoke = creator_factory(username="f2z-smoke", tuzis=Decimal("0"))
    with pytest.raises(CommandError, match="at least 10"):
        run("f2z-smoke", "5", reason=reason)
    assert balance(smoke) == Decimal("0")


def test_reason_is_a_required_argument():
    with pytest.raises(CommandError, match="--reason"):
        call_command("grant_tuzis", "f2z-smoke", "5", stdout=StringIO())


@pytest.mark.django_db
def test_large_grant_needs_i_mean_it(creator_factory):
    smoke = creator_factory(username="f2z-smoke", tuzis=Decimal("0"))

    run("f2z-smoke", str(cmd.LARGE_GRANT), reason=REASON)  # the cap itself is fine
    with pytest.raises(CommandError, match="--i-mean-it"):
        run("f2z-smoke", "1000.001", reason=REASON)
    assert balance(smoke) == cmd.LARGE_GRANT

    run("f2z-smoke", "5000", reason=REASON, i_mean_it=True)
    assert balance(smoke) == cmd.LARGE_GRANT + Decimal("5000")


@pytest.mark.django_db
@pytest.mark.parametrize("key", ["", "has space", "x" * 201, "line\nbreak", "tail\n"])
def test_refuses_malformed_idempotency_keys(creator_factory, key):
    smoke = creator_factory(username="f2z-smoke", tuzis=Decimal("0"))
    with pytest.raises(CommandError, match="idempotency-key"):
        run("f2z-smoke", "5", reason=REASON, idempotency_key=key)
    assert balance(smoke) == Decimal("0")


@pytest.mark.django_db
def test_refuses_production_without_allow_prod(creator_factory, monkeypatch):
    smoke = creator_factory(username="f2z-smoke", tuzis=Decimal("0"))
    monkeypatch.setenv("NAMESPACE", "prod")

    with pytest.raises(CommandError, match="--allow-prod"):
        run("f2z-smoke", "5", reason=REASON)
    assert balance(smoke) == Decimal("0")

    run("f2z-smoke", "5", reason=REASON, allow_prod=True)
    assert balance(smoke) == Decimal("5")
    assert "namespace=prod" in TuziGrant.objects.get().environment


def test_a_prod_database_name_is_production_even_without_namespace(monkeypatch):
    from django.db import connection

    monkeypatch.setitem(connection.settings_dict, "NAME", "prod")
    assert cmd.describe_environment()["is_prod"] is True
    monkeypatch.setitem(connection.settings_dict, "NAME", "stage_dbcopy_restore")
    assert cmd.describe_environment()["is_prod"] is False


@pytest.mark.django_db
def test_refuses_unknown_and_deactivated_accounts(creator_factory):
    with pytest.raises(CommandError, match="no account"):
        run("nobody-here", "5", reason=REASON)

    gone = creator_factory(username="gone-one", tuzis=Decimal("0"), is_active=False)
    with pytest.raises(CommandError, match="deactivated"):
        run("gone-one", "5", reason=REASON)
    assert balance(gone) == Decimal("0")
    assert not TuziGrant.objects.exists()


@pytest.mark.django_db
def test_refuses_an_empty_operator(creator_factory):
    creator_factory(username="f2z-smoke", tuzis=Decimal("0"))
    with pytest.raises(CommandError, match="operator"):
        run("f2z-smoke", "5", reason=REASON, operator="   ")
