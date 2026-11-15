"""Real OAuth/ledger integration; only provider I/O and queue dispatch are faked."""
from datetime import timedelta
from decimal import Decimal
from uuid import uuid4

import pytest
from django.utils import timezone
from rest_framework.exceptions import APIException

from dj.apps.g12f.models import Creator
from dj.apps.oidc.models import MCPAIRequest, MCPAccountGrant
from dj.apps.oidc.tests.test_mcp_connections import issue, link
from dj.apps.openai.models import AIModel, ProviderModel, GenerationResult, GenerationInterrupted
from dj.apps.openai.test_metered_prompt import _model
from dj.apps.tuzis.models import IdempotencyKey
from . import ai
from .test_operations import _hosted_settings, tool  # noqa: F401

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings, monkeypatch):
    settings.MCP_AI_ENABLED = True
    settings.OPENAI_API_KEY = "fixture-key"
    monkeypatch.setattr("dj.apps.oidc.tasks.invoke_mcp_ai.defer", lambda *args, **kwargs: None)


@pytest.fixture
def model():
    AIModel.objects.all().delete()
    ProviderModel.objects.all().delete()
    model = _model(input_price="0.000001", output_price="0.000002", price_checked_at=timezone.now().date())
    ProviderModel.objects.create(provider=model.provider, provider_model_id=model.model, first_seen_at=timezone.now(), last_seen_at=timezone.now(), availability_changed_at=timezone.now())
    return model


@pytest.fixture
def auth(signed_in, user):
    return issue(signed_in, user)[2]["access_token"]


def quoted(auth, user, model):
    return ai.quote(auth, user.username, str(model.pk), "hello", 32)


def queued(auth, user, model):
    quote = quoted(auth, user, model)
    return ai.start(auth, user.username, quote["quote_token"], quote["max_charge_tuzis"], str(uuid4()))


def balance(user):
    return Creator.objects.get(pk=user.pk).tuzis


@pytest.fixture
def generation(monkeypatch):
    calls = []
    def generate(*args, **kwargs):
        calls.append(args)
        return GenerationResult("a useful answer", 10, 2, 2)
    monkeypatch.setattr(ai.native, "generate_reply", generate)
    return calls


def test_fractional_exact_account_receipt_retry_and_wire(auth, user, model, creator_factory, generation):
    target = creator_factory(username="mcpaitarget", tuzis=Decimal("10.000"))
    link(auth, target)
    quote = quoted(auth, target, model)
    assert Decimal(quote["max_charge_tuzis"]) < 1
    before, owner_before = balance(target), balance(user)
    key = str(uuid4())
    accepted = ai.start(auth, target.username, quote["quote_token"], quote["max_charge_tuzis"], key)
    assert ai.start(auth, target.username, quote["quote_token"], quote["max_charge_tuzis"], key)["request_id"] == accepted["request_id"]
    ai.invoke(accepted["request_id"])
    ai.invoke(accepted["request_id"])
    _, result = tool(auth, "free2z_get_ai_request", {"account": target.username, "request_id": accepted["request_id"]})
    assert result["state"] == "completed", result
    receipt = result["receipt"]
    assert receipt["tuzis_charged"] == "0.003"
    assert before - balance(target) == Decimal("0.003") and balance(user) == owner_before
    assert Decimal(receipt["provider_usage_cost_usd"]) == Decimal("0.000014")
    assert len(generation) == 1 and model.get_tuzi_price(10, 2) == 1
    with pytest.raises(APIException):
        ai.get(auth, user.username, accepted["request_id"])


def test_content_grants_cannot_spend(auth, user, model):
    MCPAccountGrant.objects.filter(user=user).update(scope="mcp:read mcp:write mcp:publish mcp:uploads")
    with pytest.raises(APIException):
        quoted(auth, user, model)
    assert not MCPAIRequest.objects.exists()


def test_strict_catalog(auth, user, model):
    assert len(ai.list_models(auth, user.username)["models"]) == 1
    for fields in ({"price_checked_at": None}, {"price_valid_until": timezone.now()-timedelta(seconds=1)}):
        AIModel.objects.filter(pk=model.pk).update(**fields)
        assert not ai.list_models(auth, user.username)["models"]
        with pytest.raises(APIException):
            quoted(auth, user, model)
        AIModel.objects.filter(pk=model.pk).update(price_checked_at=timezone.now().date(), price_valid_until=None)
    ProviderModel.objects.all().delete()
    assert not ai.list_models(auth, user.username)["models"]


@pytest.mark.parametrize("change", ["revoke", "reconsent", "price", "expiry", "disabled", "token"])
def test_dispatch_rechecks_authority(auth, user, model, generation, settings, change):
    before = balance(user)
    row = MCPAIRequest.objects.get(pk=queued(auth, user, model)["request_id"])
    if change == "revoke":
        MCPAccountGrant.objects.filter(pk=row.account_grant_id).update(revoked_at=timezone.now())
    elif change == "reconsent":
        MCPAccountGrant.objects.filter(pk=row.account_grant_id).update(generation=2)
    elif change == "price":
        AIModel.objects.filter(pk=model.pk).update(input_price="0.000003")
    elif change == "expiry":
        MCPAIRequest.objects.filter(pk=row.pk).update(quote_expires_at=timezone.now()-timedelta(seconds=1))
    elif change == "disabled":
        settings.MCP_AI_ENABLED = False
    else:
        row.access_token.delete()
    ai.invoke(row.pk)
    row.refresh_from_db()
    assert row.state == "failed", row.receipt
    assert len(generation) == 0 and balance(user) == before


def test_ceiling_retry_conflict_and_cancellation(auth, user, model, generation):
    quote = quoted(auth, user, model)
    with pytest.raises(APIException):
        ai.start(auth, user.username, quote["quote_token"], "0.000", str(uuid4()))
    key = str(uuid4())
    accepted = ai.start(auth, user.username, quote["quote_token"], quote["max_charge_tuzis"], key)
    other = quoted(auth, user, model)
    with pytest.raises(APIException):
        ai.start(auth, user.username, other["quote_token"], other["max_charge_tuzis"], key)
    assert ai.get(auth, user.username, accepted["request_id"], True)["state"] == "cancelled"
    ai.invoke(accepted["request_id"])
    assert not generation


@pytest.mark.parametrize("interrupted", [True, False])
def test_provider_errors_never_redispatch(auth, user, model, monkeypatch, interrupted):
    accepted = queued(auth, user, model)
    calls = []
    def fail(*args, **kwargs):
        calls.append(1)
        if interrupted:
            raise GenerationInterrupted(TimeoutError("fixture disconnect"), response_text="partial", input_tokens=10, settlement_output_tokens=2, usage=None)
        raise TimeoutError("fixture unknown acceptance")
    monkeypatch.setattr(ai.native, "generate_reply", fail)
    before = balance(user)
    ai.invoke(accepted["request_id"])
    result = ai.get(auth, user.username, accepted["request_id"])
    assert result["state"] == ("failed" if interrupted else "unknown"), result
    if interrupted:
        assert result["receipt"]["tuzis_charged"] == "0.003"
        assert result["receipt"]["input_tokens"] == 10
        assert result["receipt"]["settlement_output_tokens"] == 2
        assert before - balance(user) == Decimal("0.003")
    ai.invoke(accepted["request_id"])
    assert len(calls) == 1


def test_retention_retry_tombstone_and_committed_receipt_recovery(auth, user, model, generation):
    accepted = queued(auth, user, model)
    ai.invoke(accepted["request_id"])
    row = MCPAIRequest.objects.get(pk=accepted["request_id"])
    row.state, row.receipt = "running", {}
    row.save()
    recovered = ai.get(auth, user.username, row.pk)
    assert recovered["state"] == "completed" and recovered["receipt"]["response"] == "a useful answer"
    MCPAIRequest.objects.filter(pk=row.pk).update(content_expires_at=timezone.now()-timedelta(seconds=1))
    ai.purge_content()
    row.refresh_from_db()
    assert row.intent == {} and "response" not in row.receipt and row.content_purged
    native_receipt = IdempotencyKey.objects.get(scope="mcp_ai_prompt", key=str(row.native_key)).response_body
    assert "response" not in native_receipt and native_receipt["tuzis_charged"] == "0.003"
    ai.invoke(row.pk)
    assert len(generation) == 1


def test_disabled_admission(auth, user, model, settings):
    settings.MCP_AI_ENABLED = False
    assert not ai.list_models(auth, user.username)["enabled"]
    with pytest.raises(APIException):
        quoted(auth, user, model)


@pytest.mark.django_db(transaction=True)
def test_reservation_excludes_competing_request_without_locks_across_provider(auth, user, model, creator_factory, monkeypatch):
    from django.db import connection
    ceiling = Decimal(quoted(auth, user, model)["max_charge_tuzis"])
    target = creator_factory(username="singlebudget", tuzis=ceiling)
    link(auth, target)
    first = queued(auth, target, model)["request_id"]
    second = queued(auth, target, model)["request_id"]
    calls = []
    def generate(*args, **kwargs):
        assert not connection.in_atomic_block
        calls.append(1)
        ai.invoke(second)
        denied = MCPAIRequest.objects.get(pk=second)
        assert denied.state == "failed" and denied.receipt["http_status"] == 402
        # Revocation after dispatch cannot erase already-authorized usage.
        MCPAccountGrant.objects.filter(user=target).update(revoked_at=timezone.now())
        return GenerationResult("answer", 10, 2, 2)
    monkeypatch.setattr(ai.native, "generate_reply", generate)
    ai.invoke(first)
    assert len(calls) == 1
    assert ceiling - balance(target) == Decimal("0.003")
    assert MCPAIRequest.objects.get(pk=first).state == "completed"
    with pytest.raises(APIException):
        ai.get(auth, target.username, first)


def test_provider_usage_above_quote_is_clamped_to_fractional_ceiling(auth, user, model, monkeypatch, caplog):
    import json
    accepted = queued(auth, user, model)
    maximum = Decimal(accepted["quote"]["max_charge_tuzis"])
    monkeypatch.setattr(ai.native, "generate_reply", lambda *args, **kwargs: GenerationResult("answer", 10000, 2, 2))
    before = balance(user)
    ai.invoke(accepted["request_id"])
    receipt = ai.get(auth, user.username, accepted["request_id"])["receipt"]
    assert Decimal(receipt["tuzis_charged"]) == before - balance(user) == maximum
    event = next(json.loads(r.message) for r in caplog.records if '"event": "ai_charge_clamped"' in r.message or '"event":"ai_charge_clamped"' in r.message)
    assert Decimal(event["charged_2z"]) == maximum


@pytest.mark.django_db(transaction=True)
def test_real_queue_arguments_commit_and_rollback_with_invocation(auth, user, model, monkeypatch):
    import json
    from django.db import connection, transaction
    monkeypatch.undo()  # Use the registered task's real Django connector.
    quote = quoted(auth, user, model)
    key = str(uuid4())
    quote_id = ai.signing.loads(quote["quote_token"], salt=ai.SALT)
    def jobs():
        with connection.cursor() as cursor:
            cursor.execute("SELECT args FROM procrastinate_jobs WHERE task_name = %s AND args->>'request_id' = %s", ["oidc.invoke_mcp_ai", quote_id])
            return [(json.loads(row[0]),) for row in cursor.fetchall()]
    with pytest.raises(RuntimeError, match="rollback fixture"):
        with transaction.atomic():
            accepted = ai.start(auth, user.username, quote["quote_token"], quote["max_charge_tuzis"], key)
            assert jobs() == [({"request_id": accepted["request_id"]},)]
            raise RuntimeError("rollback fixture")
    assert jobs() == []
    assert MCPAIRequest.objects.get(pk=accepted["request_id"]).state == "quoted"
    accepted = ai.start(auth, user.username, quote["quote_token"], quote["max_charge_tuzis"], key)
    assert jobs() == [({"request_id": accepted["request_id"]},)]
    assert MCPAIRequest.objects.get(pk=accepted["request_id"]).state == "queued"


def test_retention_scrubs_orphaned_native_receipt(auth, user, model, generation):
    accepted = queued(auth, user, model)
    ai.invoke(accepted["request_id"])
    row = MCPAIRequest.objects.get(pk=accepted["request_id"])
    key = row.native_key
    row.delete()
    IdempotencyKey.objects.filter(scope="mcp_ai_prompt", key=str(key)).update(created_at=timezone.now()-timedelta(hours=25))
    ai.purge_content()
    receipt = IdempotencyKey.objects.get(scope="mcp_ai_prompt", key=str(key)).response_body
    assert "response" not in receipt and receipt["tuzis_charged"] == "0.003"


def test_pending_limit_is_account_wide_and_retry_does_not_consume_capacity(auth, signed_in, user, model):
    first = queued(auth, user, model)
    second_connection = issue(signed_in, user)[2]["access_token"]
    second = queued(second_connection, user, model)
    quote = quoted(second_connection, user, model)
    with pytest.raises(APIException) as error:
        ai.start(second_connection, user.username, quote["quote_token"], quote["max_charge_tuzis"], str(uuid4()))
    assert error.value.status_code == 429
    ai.get(auth, user.username, first["request_id"], True)
    assert ai.start(second_connection, user.username, quote["quote_token"], quote["max_charge_tuzis"], str(uuid4()))["state"] == "queued"
    assert MCPAIRequest.objects.get(pk=second["request_id"]).state == "queued"


@pytest.mark.django_db(transaction=True)
def test_settlement_retries_real_creator_lock_contention_without_provider_retry(auth, user, model, monkeypatch):
    import threading
    from django.db import connections, transaction
    accepted = queued(auth, user, model)
    locked, release = threading.Event(), threading.Event()
    def contend():
        try:
            with transaction.atomic():
                Creator.objects.select_for_update().get(pk=user.pk)
                locked.set()
                release.wait(timeout=4)
        finally:
            connections.close_all()
    calls = []
    thread = threading.Thread(target=contend)
    def generate(*args, **kwargs):
        calls.append(1)
        thread.start()
        assert locked.wait(timeout=5)
        return GenerationResult("retained answer", 10, 2, 2)
    monkeypatch.setattr(ai.native, "generate_reply", generate)
    before = balance(user)
    try:
        ai.invoke(accepted["request_id"])
    finally:
        release.set()
        thread.join(timeout=6)
    receipt = ai.get(auth, user.username, accepted["request_id"])["receipt"]
    assert receipt["response"] == "retained answer"
    assert receipt["tuzis_charged"] == "0.003"
    assert before - balance(user) == Decimal("0.003") and len(calls) == 1


@pytest.mark.parametrize("legacy_shape", [False, True])
def test_exhausted_settlement_recovers_charge_before_releasing_answer(auth, user, model, generation, monkeypatch, legacy_shape):
    from django.db import OperationalError
    accepted = queued(auth, user, model)
    original = ai.native.ledger.settle_reservation
    attempts = []
    def fail(*args, **kwargs):
        attempts.append(1)
        cause = Exception("fixture rollback")
        cause.sqlstate = "55P03"
        raise OperationalError("fixture lock timeout") from cause
    monkeypatch.setattr(ai.native.ledger, "settle_reservation", fail)
    before = balance(user)
    assert ai.invoke(accepted["request_id"]) == "settle_pending"
    receipt = ai.get(auth, user.username, accepted["request_id"])["receipt"]
    assert "response" not in receipt and receipt["charge_status"] == "pending"
    assert len(attempts) == 10 and len(generation) == 1
    if legacy_shape:
        row = MCPAIRequest.objects.get(pk=accepted["request_id"])
        row.receipt.pop("_prepared_status")
        row.save(update_fields=["receipt"])
    else:
        from dj.apps.oidc.tasks import invoke_mcp_ai
        def read_failure(*args, **kwargs):
            raise OperationalError("fixture entry connection failure")
        with monkeypatch.context() as entry_patch:
            entry_patch.setattr(MCPAIRequest.objects, "select_for_update", read_failure)
            with pytest.raises(OperationalError):
                invoke_mcp_ai(request_id=accepted["request_id"])
    monkeypatch.setattr(ai.native.ledger, "settle_reservation", original)
    receipt = ai.get(auth, user.username, accepted["request_id"])["receipt"]
    assert receipt["response"] == "a useful answer" and receipt["tuzis_charged"] == "0.003"
    assert before - balance(user) == Decimal("0.003")
    assert ai.invoke(accepted["request_id"]) == "completed" and len(generation) == 1


def test_worker_marks_uncertain_outcome_failed_for_billing_health(auth, user, model, monkeypatch):
    from dj.apps.oidc.tasks import invoke_mcp_ai
    accepted = queued(auth, user, model)
    def timeout(*args, **kwargs):
        raise TimeoutError("fixture uncertainty")
    monkeypatch.setattr(ai.native, "generate_reply", timeout)
    with pytest.raises(RuntimeError, match="requires reconciliation"):
        invoke_mcp_ai(request_id=accepted["request_id"])
    assert MCPAIRequest.objects.get(pk=accepted["request_id"]).state == "unknown"


def test_lost_running_commit_acknowledgement_never_reports_job_success(auth, user, model, generation):
    from dj.apps.oidc.tasks import invoke_mcp_ai
    accepted = queued(auth, user, model)
    # Model a committed dispatch marker whose acknowledgement was lost. The
    # retry cannot know whether provider dispatch followed that transaction.
    MCPAIRequest.objects.filter(pk=accepted["request_id"]).update(state="running", started_at=timezone.now())
    with pytest.raises(RuntimeError, match="requires reconciliation"):
        invoke_mcp_ai(request_id=accepted["request_id"])
    assert generation == []
    assert MCPAIRequest.objects.get(pk=accepted["request_id"]).state == "running"


def test_expired_settlement_hold_withholds_answer_and_never_debits_again(auth, user, model, generation, monkeypatch):
    from django.db import OperationalError
    accepted = queued(auth, user, model)
    original = ai.native.ledger.settle_reservation
    def fail(*args, **kwargs):
        cause = Exception("fixture rollback")
        cause.sqlstate = "55P03"
        raise OperationalError("fixture lock timeout") from cause
    monkeypatch.setattr(ai.native.ledger, "settle_reservation", fail)
    before = balance(user)
    assert ai.invoke(accepted["request_id"]) == "settle_pending"
    monkeypatch.setattr(ai.native.ledger, "settle_reservation", original)
    row = MCPAIRequest.objects.get(pk=accepted["request_id"])
    ai.native.ledger.release_reservation(ai.native._provider_reservation(user, row.native_key, "ai_prompt"))
    result = ai.get(auth, user.username, row.pk)
    assert result["state"] == "failed" and "response" not in result["receipt"]
    assert result["receipt"]["tuzis_charged"] == "0.000" and balance(user) == before
    assert ai.invoke(row.pk) == "failed" and len(generation) == 1


def test_queue_retries_only_saved_settlement_and_prioritizes_it():
    from types import SimpleNamespace
    from django.db import OperationalError
    from dj.apps.oidc.tasks import MCPSettlementPending, invoke_mcp_ai
    strategy = invoke_mcp_ai.retry_strategy
    decision = strategy.get_retry_decision(exception=MCPSettlementPending(), job=SimpleNamespace(attempts=1))
    assert decision.priority == 100
    assert strategy.get_retry_decision(exception=OperationalError(), job=SimpleNamespace(attempts=1)).priority == 100
    assert strategy.get_retry_decision(exception=RuntimeError(), job=SimpleNamespace(attempts=1)) is None
    assert strategy.get_retry_decision(exception=MCPSettlementPending(), job=SimpleNamespace(attempts=10)) is None


def test_zero_charge_still_rechecks_authorization_before_provider(auth, user, model, generation):
    AIModel.objects.filter(pk=model.pk).update(markup=0)
    accepted = queued(auth, user, model)
    assert accepted["quote"]["max_charge_tuzis"] == "0.000"
    MCPAccountGrant.objects.filter(user=user).update(revoked_at=timezone.now())
    ai.invoke(accepted["request_id"])
    assert not generation
    assert MCPAIRequest.objects.get(pk=accepted["request_id"]).state == "failed"


def test_unconfirmed_legacy_receipt_cannot_expose_a_free_answer(auth, user, model):
    accepted = queued(auth, user, model)
    row = MCPAIRequest.objects.get(pk=accepted["request_id"])
    row.state = "unknown"
    row.receipt = {"response": "uncollected answer", "charge_status": "unknown", "tuzis_charged": None}
    row.save()
    assert "response" not in ai.get(auth, user.username, row.pk)["receipt"]
