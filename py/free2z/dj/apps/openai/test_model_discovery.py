"""Programmatic model discovery (``dj.apps.openai.discovery``), on recorded payloads.

No test here calls a provider::func:`list_provider_models` is fed the
listings under ``test_fixtures/provider_models/`` either directly (the seam)
or through a fake SDK client, so the SDK-object -> record translation is
exercised too. Real Postgres, as everywhere in this repo.

The properties pinned, each with its negative control:

1. a listing is recorded with timestamps; a later listing that drops an id
   marks it missing (and lists it again when it comes back);
2. a FAILED listing writes nothing and makes the command exit non-zero, and
   the failure line never carries the API key;
3. unconfigured and policy-disabled providers are skipped, never called;
4. ``AIModel.objects.discovered()`` is open for a provider with no snapshot
   and strict once one exists -- the picker (``GET /api/ai/models/``) and
   ``selectable()`` go through it;
5. a discovered-but-unpriced id is reported, never sold or created.
"""
import json
import logging
import types
import uuid
from pathlib import Path

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.utils import timezone

from f2z.ai import providers

from dj.apps.openai import discovery
from dj.apps.openai.models import AIModel, ProviderModel

pytestmark = pytest.mark.django_db

FIXTURES = Path(__file__).resolve().parent / "test_fixtures" / "provider_models"
MODELS_URL = "/api/ai/models/"
SECRET = "sk-test-NEVER-IN-A-LOG-7f3a"


def _recorded(provider):
    return json.loads((FIXTURES / f"{provider}.json").read_text())


def _listing(provider):
    return [discovery.DiscoveredModel(id=e["id"], metadata={k: v for k, v in e.items() if k != "id"})
            for e in _recorded(provider)["data"]]


def _ids(provider):
    return sorted(e["id"] for e in _recorded(provider)["data"])


def _model(provider="openai", model="gpt-4o", **kw):
    return AIModel.objects.create(
        provider=provider, model=model, display_name=model, system_message="s",
        max_tokens=128_000, max_output_tokens=8192, max_response_tokens=16_384,
        is_ga=kw.pop("is_ga", True), **kw,
    )


@pytest.fixture
def openai_key(settings):
    settings.OPENAI_API_KEY = SECRET
    settings.ANTHROPIC_API_KEY = ""
    settings.XAI_API_KEY = ""
    settings.MOONSHOT_API_KEY = ""


@pytest.fixture
def recorded_listings(monkeypatch):
    """The seam: every provider answers with its recorded fixture."""
    monkeypatch.setattr(discovery, "list_provider_models", _listing)


@pytest.fixture(autouse=True)
def _clean():
    AIModel.objects.all().delete()
    ProviderModel.objects.all().delete()


# ------------------------------------------------------------- recording


def test_a_listing_is_recorded_with_timestamps_and_the_unpriced_report(openai_key, recorded_listings):
    _model(model="gpt-4o")
    _model(model="gpt-6.1-sol")  # priced, NOT in the recorded listing
    _model(model="o3", provider_model_id="o3")  # explicit upstream id
    at = timezone.now()
    report = discovery.discover(now=at)
    assert report.failed == []
    assert report.skipped == {"anthropic": "no_api_key", "kimi": "policy_disabled",
                              "xai": "no_api_key"}
    (result,) = report.results
    assert result.provider == "openai"
    assert result.listed == _ids("openai")
    assert result.added == _ids("openai") and result.returned == [] and result.gone == []
    assert result.unpriced == sorted(set(_ids("openai")) - {"gpt-4o", "o3"})
    rows = {r.provider_model_id: r for r in ProviderModel.objects.filter(provider="openai")}
    assert set(rows) == set(_ids("openai"))
    assert all(r.first_seen_at == at and r.last_seen_at == at and r.missing_since is None
               for r in rows.values())
    assert rows["gpt-4o"].metadata == {"object": "model", "created": 1715367049, "owned_by": "system"}
    # Nothing is created or priced by discovery.
    assert set(AIModel.objects.values_list("model", flat=True)) == {"gpt-4o", "gpt-6.1-sol", "o3"}


def test_a_dropped_id_is_marked_missing_and_cleared_when_it_returns(openai_key, monkeypatch):
    first = timezone.now()
    monkeypatch.setattr(discovery, "list_provider_models", _listing)
    discovery.discover(["openai"], now=first)
    without_4o = [m for m in _listing("openai") if m.id != "gpt-4o"]
    monkeypatch.setattr(discovery, "list_provider_models", lambda p: without_4o)
    second = first + timezone.timedelta(hours=1)
    (result,) = discovery.discover(["openai"], now=second).results
    assert result.gone == ["gpt-4o"] and result.added == []
    row = ProviderModel.objects.get(provider="openai", provider_model_id="gpt-4o")
    assert row.missing_since == second and row.last_seen_at == first and row.first_seen_at == first
    assert row.availability_changed_at == second
    other = ProviderModel.objects.get(provider="openai", provider_model_id="o3")
    assert other.last_seen_at == second and other.missing_since is None
    assert other.availability_changed_at == first, "an unchanged row mints no revision"
    # A third run that still lacks it does not move missing_since.
    third = second + timezone.timedelta(hours=1)
    discovery.discover(["openai"], now=third)
    row.refresh_from_db()
    assert row.missing_since == second
    # It comes back.
    monkeypatch.setattr(discovery, "list_provider_models", _listing)
    fourth = third + timezone.timedelta(hours=1)
    (result,) = discovery.discover(["openai"], now=fourth).results
    assert result.returned == ["gpt-4o"]
    row.refresh_from_db()
    assert row.missing_since is None and row.last_seen_at == fourth and row.first_seen_at == first
    assert row.availability_changed_at == fourth, "a return is a transition too"


def test_a_duplicate_id_in_one_listing_counts_once(openai_key, monkeypatch):
    doubled = _listing("openai") + [discovery.DiscoveredModel(id="gpt-4o")]
    monkeypatch.setattr(discovery, "list_provider_models", lambda p: doubled)
    (result,) = discovery.discover(["openai"]).results
    assert result.listed.count("gpt-4o") == 1
    assert ProviderModel.objects.filter(provider="openai", provider_model_id="gpt-4o").count() == 1


# ------------------------------------------------------ the SDK adapters


class _FakePage:
    def __init__(self, entries):
        self._entries = entries

    def __iter__(self):
        return iter(self._entries)


def _fake_client(provider):
    data = _recorded(provider)["data"]
    entries = []
    for e in data:
        # The SDKs hand back pydantic models; a namespace with model_dump is
        # the same surface. One dict entry too, as Moonshot's untyped extras.
        ns = types.SimpleNamespace(**e)
        ns.model_dump = lambda mode="json", e=e: dict(e)
        entries.append(ns)
    entries[-1] = dict(data[-1])
    client = types.SimpleNamespace()
    client.models = types.SimpleNamespace(list=lambda: _FakePage(entries))
    client.options_seen = []

    def with_options(**options):
        client.options_seen.append(options)
        return client

    client.with_options = with_options
    return client


@pytest.mark.parametrize("provider", ["openai", "xai", "anthropic"])
def test_the_sdk_listing_is_translated_id_by_id(provider, monkeypatch):
    clients = {}
    monkeypatch.setattr(discovery, "get_client", lambda p: clients.setdefault(p, _fake_client(p)))
    found = discovery.list_provider_models(provider)
    # One bounded attempt: a stalled provider cannot eat the CronJob deadline.
    assert clients[provider].options_seen == [
        {"timeout": discovery.LISTING_TIMEOUT_SECONDS, "max_retries": 0}]
    assert discovery.LISTING_TIMEOUT_SECONDS * len(providers.API_KEY_NAMES) < 300
    assert [m.id for m in found] == [e["id"] for e in _recorded(provider)["data"]]
    for m, e in zip(found, _recorded(provider)["data"]):
        assert m.metadata == {k: v for k, v in e.items() if k != "id"}
        assert "id" not in m.metadata


def test_an_entry_without_a_string_id_is_skipped(monkeypatch):
    entries = [{"id": "gpt-4o"}, {"id": None}, {"object": "model"}, {"id": ""}, {"id": 7}]
    client = types.SimpleNamespace(models=types.SimpleNamespace(list=lambda: _FakePage(entries)))
    client.with_options = lambda **kw: client
    monkeypatch.setattr(discovery, "get_client", lambda p: client)
    assert [m.id for m in discovery.list_provider_models("openai")] == ["gpt-4o"]


# ------------------------------------------------------------- failures


def test_a_failed_listing_writes_nothing_exits_nonzero_and_never_logs_the_key(
        openai_key, monkeypatch, caplog):
    _model(model="gpt-4o")
    monkeypatch.setattr(discovery, "list_provider_models", _listing)
    discovery.discover(["openai"])
    before = list(ProviderModel.objects.values_list("provider_model_id", "last_seen_at", "missing_since"))

    class Boom(RuntimeError):
        status_code = 401

    def failing(provider):
        # A provider error body that echoes the credential: the line must
        # carry the type and status, never the text.
        raise Boom(f"401 Unauthorized for key {SECRET}")

    monkeypatch.setattr(discovery, "list_provider_models", failing)
    with caplog.at_level(logging.ERROR, logger="dj.apps.openai.discovery"):
        with pytest.raises(CommandError, match="discovery failed for: openai"):
            call_command("discover_ai_models")
    assert list(ProviderModel.objects.values_list("provider_model_id", "last_seen_at", "missing_since")) == before
    lines = [json.loads(r.getMessage()) for r in caplog.records
             if r.name == "dj.apps.openai.discovery"]
    failed = [l for l in lines if l["event"] == discovery.AI_MODEL_DISCOVERY_FAILED_EVENT]
    assert len(failed) == 1 and failed[0]["provider"] == "openai"
    assert failed[0]["error_type"] == "Boom" and failed[0]["status_code"] == 401
    assert "error" not in failed[0], "exception text is never logged"
    assert SECRET not in json.dumps(lines) and "sk-test" not in json.dumps(lines)
    assert "Unauthorized" not in json.dumps(lines)


def test_a_failure_on_one_provider_still_records_the_others(settings, monkeypatch):
    settings.OPENAI_API_KEY = SECRET
    settings.XAI_API_KEY = "xai-test"
    settings.ANTHROPIC_API_KEY = ""

    def one_fails(provider):
        if provider == "openai":
            raise ConnectionError("boom")
        return _listing(provider)

    monkeypatch.setattr(discovery, "list_provider_models", one_fails)
    report = discovery.discover()
    assert report.failed == ["openai"]
    assert [r.provider for r in report.results] == ["xai"]
    assert set(ProviderModel.objects.values_list("provider", flat=True)) == {"xai"}


def test_unconfigured_and_policy_disabled_providers_are_never_called(settings, monkeypatch):
    settings.OPENAI_API_KEY = ""
    settings.ANTHROPIC_API_KEY = ""
    settings.XAI_API_KEY = ""
    settings.MOONSHOT_API_KEY = "moonshot-test"  # keyed AND policy-disabled
    called = []
    monkeypatch.setattr(discovery, "list_provider_models", lambda p: called.append(p) or [])
    report = discovery.discover()
    assert called == [] and report.results == [] and report.failed == []
    assert report.skipped == {"anthropic": "no_api_key", "kimi": "policy_disabled",
                              "openai": "no_api_key", "xai": "no_api_key"}
    assert "kimi" in providers.POLICY_DISABLED_PROVIDERS  # the premise of the kimi case


def test_the_command_reports_without_calling_anyone(openai_key, recorded_listings, capsys, monkeypatch):
    _model(model="gpt-4o")
    call_command("discover_ai_models")
    monkeypatch.setattr(discovery, "list_provider_models", lambda p: pytest.fail("called"))
    call_command("discover_ai_models", "--report")
    out = capsys.readouterr().out
    assert "openai/gpt-4o: listed, priced" in out
    assert "openai/gpt-image-1: listed, UNPRICED" in out
    assert "unpriced: openai/text-embedding-3-small" in out  # from the first run's output


# ---------------------------------------------------------- the gate


def test_discovered_is_open_without_a_snapshot_and_strict_with_one(openai_key, recorded_listings):
    listed = _model(model="gpt-4o")
    unlisted = _model(model="gpt-6.1-sol")
    pinned = _model(model="gpt-4o-aug", provider_model_id="gpt-4o-2024-08-06")
    mispinned = _model(model="gpt-4o-may", provider_model_id="gpt-4o-2024-05-13")
    other_provider = _model(provider="anthropic", model="claude-sonnet-5")
    assert set(AIModel.objects.discovered()) == {listed, unlisted, pinned, mispinned, other_provider}
    discovery.discover(["openai"])
    # The catalogue gates on the id the GATEWAY sends (the pin when set).
    assert set(AIModel.objects.discovered()) == {listed, pinned, other_provider}, (
        "with an openai snapshot only ids openai lists pass; anthropic has no snapshot and stays open")
    # Django's own chat sends `model`, so it is gated on that id instead: the
    # row pinned to a listed snapshot is NOT sellable there (its alias
    # "gpt-4o-aug" is unlisted), and a row whose pin is withdrawn but whose
    # alias is listed still is.
    assert set(AIModel.objects.discovered(upstream=False)) == {listed, other_provider}
    alias_listed = _model(model="gpt-4o-mini", provider_model_id="gpt-4o-mini-withdrawn-snapshot")
    assert alias_listed in AIModel.objects.discovered(upstream=False)
    assert alias_listed not in AIModel.objects.discovered()
    ProviderModel.objects.filter(provider="openai", provider_model_id="gpt-4o").update(
        missing_since=timezone.now())
    assert set(AIModel.objects.discovered()) == {pinned, other_provider}
    assert set(AIModel.objects.discovered(upstream=False)) == {alias_listed, other_provider}


def test_the_picker_and_selectable_go_through_the_gate(openai_key, recorded_listings, api_client):
    listed = _model(model="gpt-4o")
    unlisted = _model(model="gpt-6.1-sol")
    ids_before = {row["id"] for row in api_client.get(MODELS_URL).data["results"]}
    assert ids_before == {str(listed.id), str(unlisted.id)}
    discovery.discover(["openai"])
    ids_after = {row["id"] for row in api_client.get(MODELS_URL).data["results"]}
    assert ids_after == {str(listed.id)}
    assert set(AIModel.objects.selectable()) == {listed}
    assert api_client.get(f"{MODELS_URL}{unlisted.id}/").status_code == 404
    # Negative control: a snapshot that does list it puts it back.
    ProviderModel.objects.create(
        provider="openai", provider_model_id="gpt-6.1-sol",
        first_seen_at=timezone.now(), last_seen_at=timezone.now(),
        availability_changed_at=timezone.now())
    assert set(AIModel.objects.selectable()) == {listed, unlisted}


def test_discovery_never_creates_enables_or_prices_a_model(openai_key, recorded_listings):
    discovery.discover(["openai"])
    assert AIModel.objects.count() == 0
    assert ProviderModel.objects.filter(provider="openai").count() == len(_ids("openai"))


# ------------------------------------------------------ provider aliases


def test_anthropic_dated_snapshots_also_list_their_documented_alias(settings, recorded_listings):
    """Anthropic lists ``claude-haiku-4-5-20251001`` and documents
    ``claude-haiku-4-5`` as its alias without listing it; the lineup names
    the alias. Without the rule a successful Anthropic discovery would drop
    every Claude row (codex review)."""
    settings.ANTHROPIC_API_KEY = "sk-ant-test"
    settings.OPENAI_API_KEY = ""
    settings.XAI_API_KEY = ""
    _model(provider="anthropic", model="claude-haiku-4-5")
    (result,) = discovery.discover(["anthropic"]).results
    assert "claude-haiku-4-5" in result.listed and "claude-haiku-4-5-20251001" in result.listed
    alias = ProviderModel.objects.get(provider="anthropic", provider_model_id="claude-haiku-4-5")
    assert alias.metadata == {"alias_of": "claude-haiku-4-5-20251001", "derived": True}
    assert set(AIModel.objects.discovered().values_list("model", flat=True)) == {"claude-haiku-4-5"}
    # Unpriced report names the dated id AND the undated opus-5-5 the lineup lacks.
    assert "claude-opus-5-5" in result.unpriced and "claude-haiku-4-5-20251001" in result.unpriced


def test_the_alias_rule_is_anthropic_only_and_keeps_the_newest_snapshot():
    dated = [discovery.DiscoveredModel(id=i) for i in
             ["claude-x-20250101", "claude-x-20260301", "claude-x-20251212", "claude-y"]]
    aliases = discovery.with_provider_aliases("anthropic", dated)
    assert [m.id for m in aliases][-1:] == ["claude-x"]
    assert aliases[-1].metadata["alias_of"] == "claude-x-20260301"
    # A listed alias is not derived twice; other providers get no rule --
    # gpt-4o-2024-05-13 is priced differently from gpt-4o.
    openai = [discovery.DiscoveredModel(id="gpt-4o-2024-05-13")]
    assert discovery.with_provider_aliases("openai", openai) == openai
    assert discovery.with_provider_aliases("xai", openai) == openai


# ------------------------------------------- paid admission goes through it


@pytest.fixture
def paid_user(creator_factory):
    from decimal import Decimal

    return creator_factory(tuzis=Decimal("1000"))


@pytest.fixture
def undiscovered(openai_key, recorded_listings):
    """An enabled, GA, keyed OpenAI row its provider does not list."""
    row = _model(model="gpt-6.1-sol")
    discovery.discover(["openai"])
    assert row not in AIModel.objects.discovered()
    return row


def test_a_withdrawn_model_takes_no_new_metered_prompt(undiscovered, paid_user, api_client, monkeypatch):
    calls = []
    monkeypatch.setattr("f2z.ai.providers.stream_chat",
                        lambda *a, **k: calls.append(1) or iter(["x"]))
    api_client.force_authenticate(user=paid_user)
    response = api_client.post(
        "/api/ai/prompt/", {"prompt": "hi", "model": str(undiscovered.id)},
        format="json", HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
    assert response.status_code == 409, response.content
    assert undiscovered.display_name in response.data["detail"]
    assert calls == []


def test_a_withdrawn_model_cannot_start_or_receive_a_conversation(undiscovered, paid_user, api_client, monkeypatch):
    from dj.apps.openai.models import Conversation

    api_client.force_authenticate(user=paid_user)
    response = api_client.post(
        "/api/ai/conversations/", {"display_name": "c", "ai_model": str(undiscovered.id)},
        format="json")
    assert response.status_code == 409, response.content
    assert not Conversation.objects.filter(ai_model=undiscovered).exists()
    # An existing conversation (started before the provider withdrew the
    # model) takes no NEW prompt either.
    conversation = Conversation.objects.create(
        user=paid_user, ai_model=undiscovered, display_name="old")
    calls = []
    monkeypatch.setattr("f2z.ai.providers.stream_chat",
                        lambda *a, **k: calls.append(1) or iter(["x"]))
    response = api_client.post(
        f"/api/ai/conversations/{conversation.id}/promptresponses/",
        {"user_input": "hi"}, format="json", HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
    assert response.status_code in (400, 409), response.content
    assert calls == []
    # Nor can a live conversation be PATCHed onto it.
    live = _model(model="gpt-4o")
    other = Conversation.objects.create(user=paid_user, ai_model=live, display_name="live")
    response = api_client.patch(
        f"/api/ai/conversations/{other.id}/", {"ai_model": str(undiscovered.id)}, format="json")
    assert response.status_code == 400, response.content
    other.refresh_from_db()
    assert other.ai_model == live


def test_an_empty_listing_is_a_failure_not_a_snapshot(openai_key, monkeypatch):
    """No provider serves zero models. Recording an empty page would mark
    every model missing; skipping it silently would keep the gate open with
    no signal. It is reported as a failure (exit 1) and writes nothing."""
    monkeypatch.setattr(discovery, "list_provider_models", lambda p: [])
    report = discovery.discover(["openai"])
    assert report.failed == ["openai"] and report.results == []
    assert ProviderModel.objects.count() == 0


def test_the_admin_cannot_add_change_or_delete_discovery_rows(rf):
    from django.contrib.admin.sites import AdminSite

    from dj.apps.openai.admin import ProviderModelAdmin

    admin = ProviderModelAdmin(ProviderModel, AdminSite())
    request = rf.get("/")
    assert not admin.has_add_permission(request)
    assert not admin.has_change_permission(request)
    assert not admin.has_delete_permission(request), "a delete would reopen the provider's gate"


def test_the_picker_and_create_gate_on_the_id_django_sends(openai_key, recorded_listings, api_client, paid_user):
    """Call-site twin of the queryset test (independent review of ): a
    row pinned to a LISTED snapshot whose alias is unlisted is not offered
    by the picker and cannot start a conversation -- Django would send the
    unlisted alias."""
    pinned = _model(model="gpt-4o-aug", provider_model_id="gpt-4o-2024-08-06")
    alias = _model(model="gpt-4o")
    discovery.discover(["openai"])
    assert pinned in AIModel.objects.discovered() and pinned not in AIModel.objects.discovered(upstream=False)
    ids = {row["id"] for row in api_client.get(MODELS_URL).data["results"]}
    assert ids == {str(alias.id)}
    api_client.force_authenticate(user=paid_user)
    response = api_client.post(
        "/api/ai/conversations/", {"display_name": "c", "ai_model": str(pinned.id)}, format="json")
    assert response.status_code == 409, response.content
