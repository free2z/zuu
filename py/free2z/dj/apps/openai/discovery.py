"""Programmatic model discovery: what each keyed provider says it serves.

The owner's rule ( follow-up): the model shelf is not a hardcoded list,
it is ``discovered ∩ priced ∩ enabled``. This module is the *discovered* half.
For every provider whose API key this process holds it asks the provider's own
model-listing endpoint -- ``GET /v1/models`` on OpenAI and the OpenAI-compatible
xAI / Kimi, ``GET /v1/models`` on Anthropic -- and records the answer in
:class:`dj.apps.openai.models.ProviderModel` with timestamps. Nothing here
decides prices::meth:`AIModelQuerySet.discovered` joins the record against
the priced ``AIModel`` rows, and the signed catalogue and the chat picker both
read through it.

Properties that matter at 3am:

* **A failed listing writes nothing.** The last successful snapshot stays in
  force, so a provider outage or an expired key cannot empty the shelf. The
  run exits non-zero instead, which the CronJob's failure alerting sees.
* **No key, no call.** An unconfigured or policy-disabled provider is skipped
  and reported; a provider id this module has no lister for is skipped too.
* **The key is never logged.** The SDKs put the key in a header, not in the
  URL or in error text; the failure line carries the exception's class and a
  bounded message only.
* **Bounded.** One listing call per provider per run, under the SDK's default
  timeout, no retries beyond the SDK's own.
* **Every discovered-but-unpriced id is reported** on one structured line per
  provider (``ai_models_discovered_unpriced``) and visible in the admin, so a
  human can price it. Discovery never creates an ``AIModel`` row: pricing is a
  reviewed migration, not a side effect of a listing.

Tests inject recorded provider payloads through:func:`list_provider_models`;
nothing in CI calls a provider.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field

from django.db import transaction
from django.utils import timezone

from f2z.ai.providers import (
    ANTHROPIC,
    API_KEY_NAMES,
    OPENAI_COMPATIBLE,
    POLICY_DISABLED_PROVIDERS,
    get_client,
    provider_is_configured,
)

logger = logging.getLogger(__name__)

#One INFO line per provider per successful run.
AI_MODEL_DISCOVERY_EVENT = "ai_model_discovery"
#One ERROR line per provider whose listing failed (nothing written).
AI_MODEL_DISCOVERY_FAILED_EVENT = "ai_model_discovery_failed"
#One WARNING line per provider listing ids no ``AIModel`` row prices.
AI_MODELS_DISCOVERED_UNPRICED_EVENT = "ai_models_discovered_unpriced"
#One INFO line per provider skipped (no key, policy-disabled, no lister).
AI_MODEL_DISCOVERY_SKIPPED_EVENT = "ai_model_discovery_skipped"

#Per-provider budget for one listing call, seconds. Four providers at this
#budget fit well inside the CronJob's 300 s activeDeadlineSeconds.
LISTING_TIMEOUT_SECONDS = 20


class EmptyListing(RuntimeError):
    """A provider answered with no models at all."""


@dataclass(frozen=True)
class DiscoveredModel:
    """One entry of a provider's listing, provider-agnostic."""

    id: str
    metadata: dict = field(default_factory=dict)


@dataclass
class ProviderResult:
    provider: str
    listed: list[str]
    added: list[str]
    returned: list[str]
    gone: list[str]
    unpriced: list[str]


@dataclass
class DiscoveryReport:
    results: list[ProviderResult] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    skipped: dict[str, str] = field(default_factory=dict)


def _entry_metadata(entry) -> dict:
    """The JSON-safe part of a listing entry, minus its id."""
    if hasattr(entry, "model_dump"):
        raw = entry.model_dump(mode="json")
    elif isinstance(entry, dict):
        raw = dict(entry)
    else:
        raw = {}
    raw.pop("id", None)
    try:
        json.dumps(raw)
    except (TypeError, ValueError):
        raw = {k: str(v) for k, v in raw.items()}
    return raw


def _entry_id(entry):
    value = entry.get("id") if isinstance(entry, dict) else getattr(entry, "id", None)
    return value if isinstance(value, str) and value else None


def list_provider_models(provider: str) -> list[DiscoveredModel]:
    """Ask ``provider`` what it serves. Raises on any failure.

    The seam tests monkeypatch with recorded payloads. The OpenAI SDK's
    ``models.list()`` and the Anthropic SDK's are both auto-paginating
    iterators, so one loop drains either.
    """
    # A short, explicit budget and NO retries: the shared clients carry a
    # 120 s read timeout and the SDK default of two retries, so one stalled
    # provider would eat the CronJob's 300 s deadline before the next provider
    # was asked. Both SDKs expose ``with_options``.
    client = get_client(provider).with_options(
        timeout=LISTING_TIMEOUT_SECONDS, max_retries=0)
    if provider in OPENAI_COMPATIBLE or provider == ANTHROPIC:
        page = client.models.list()
    else:  # pragma: no cover - every known provider is one of the above
        raise ValueError(f"no model lister for provider {provider!r}")
    found = []
    for entry in page:
        model_id = _entry_id(entry)
        if model_id is None:
            continue
        found.append(DiscoveredModel(id=model_id, metadata=_entry_metadata(entry)))
    return found


#Anthropic lists dated snapshot ids (``claude-haiku-4-5-20251001``) and
#documents the undated name (``claude-haiku-4-5``) as a valid alias of the
#newest snapshot, but does not list the alias itself. The lineup names the
#alias, so without this a successful Anthropic discovery would remove every
#Claude row. The alias row carries ``alias_of`` so
#the admin shows where it came from. OpenAI lists its aliases (``gpt-4o``)
#beside the snapshots, and a dated OpenAI id can be priced DIFFERENTLY
#(``gpt-4o-2024-05-13`` is $5/$15), so no other provider gets a rule.
_SNAPSHOT_SUFFIX = re.compile(r"^(?P<alias>.+)-(?P<date>\d{8})$")


def _anthropic_aliases(models: list[DiscoveredModel]) -> list[DiscoveredModel]:
    listed = {m.id for m in models}
    aliases: dict[str, DiscoveredModel] = {}
    for model in models:
        match = _SNAPSHOT_SUFFIX.match(model.id)
        if not match or match["alias"] in listed:
            continue
        alias = match["alias"]
        current = aliases.get(alias)
        # The alias means the NEWEST snapshot; keep the latest date.
        if current is None or match["date"] > current.metadata["alias_of"][-8:]:
            aliases[alias] = DiscoveredModel(
                id=alias, metadata={"alias_of": model.id, "derived": True})
    return list(aliases.values())


PROVIDER_ALIAS_RULES = {ANTHROPIC: _anthropic_aliases}


def with_provider_aliases(provider: str, models: list[DiscoveredModel]) -> list[DiscoveredModel]:
    """``models`` plus the aliases ``provider`` documents but does not list."""
    rule = PROVIDER_ALIAS_RULES.get(provider)
    return models + rule(models) if rule else models


def _priced_upstream_ids(provider: str) -> set[str]:
    from .models import AIModel

    return {
        row.upstream_model_id
        for row in AIModel.objects.filter(provider=provider).only("model", "provider_model_id")
    }


def record_listing(provider: str, models: list[DiscoveredModel], now=None) -> ProviderResult:
    """Persist one provider's listing in one transaction and return the diff.

    Ids listed are upserted with ``last_seen_at = now`` (``missing_since``
    cleared); ids previously recorded for this provider and not listed now
    get ``missing_since = now`` the first time they are absent. A duplicate
    id inside one listing counts once.
    """
    from .models import ProviderModel

    now = now or timezone.now()
    by_id = {}
    for model in with_provider_aliases(provider, models):
        by_id.setdefault(model.id, model)
    listed = sorted(by_id)
    with transaction.atomic():
        existing = {
            row.provider_model_id: row
            for row in ProviderModel.objects.select_for_update().filter(provider=provider)
        }
        added, returned = [], []
        for model_id in listed:
            model = by_id[model_id]
            row = existing.get(model_id)
            if row is None:
                ProviderModel.objects.create(
                    provider=provider, provider_model_id=model_id,
                    first_seen_at=now, last_seen_at=now, availability_changed_at=now,
                    metadata=model.metadata,
                )
                added.append(model_id)
                continue
            changes = {"last_seen_at": now, "metadata": model.metadata}
            if row.missing_since is not None:
                returned.append(model_id)
                # A transition, so the catalogue version moves on this poll
                # even inside the minute that saw it go missing.
                changes.update(missing_since=None, availability_changed_at=now)
            ProviderModel.objects.filter(pk=row.pk).update(**changes)
        gone = sorted(
            model_id for model_id, row in existing.items()
            if model_id not in by_id and row.missing_since is None
        )
        if gone:
            ProviderModel.objects.filter(
                provider=provider, provider_model_id__in=gone, missing_since__isnull=True,
            ).update(missing_since=now, availability_changed_at=now)
    unpriced = sorted(set(listed) - _priced_upstream_ids(provider))
    return ProviderResult(
        provider=provider, listed=listed, added=added, returned=returned,
        gone=gone, unpriced=unpriced,
    )


def discover(providers=None, now=None) -> DiscoveryReport:
    """Run discovery for every configured, permitted provider (or ``providers``).

    Never raises for a provider failure: the report names it and the caller
    decides the exit status. Logging happens here so the management command
    and any future caller emit the same lines.
    """
    report = DiscoveryReport()
    # No shared run timestamp: each provider's snapshot is stamped when IT
    # commits (``record_listing`` takes ``timezone.now()`` on a None), so a
    # gateway that polls between two providers' commits sees a higher
    # revision for the second one rather than an equal, "unchanged" version
    #. Tests pass an explicit ``now`` for determinism.
    for provider in sorted(providers if providers is not None else API_KEY_NAMES):
        if provider not in API_KEY_NAMES:
            report.skipped[provider] = "unknown_provider"
        elif provider in POLICY_DISABLED_PROVIDERS:
            report.skipped[provider] = "policy_disabled"
        elif not provider_is_configured(provider):
            report.skipped[provider] = "no_api_key"
        if provider in report.skipped:
            _log_skipped(provider, report.skipped[provider])
            continue
        try:
            models = list_provider_models(provider)
            if not models:
                # No provider serves zero models; an empty page is a broken
                # listing (or a key with no access), not a snapshot. Recording
                # it would mark every model of the provider missing; skipping
                # it silently would leave the gate open forever.
                raise EmptyListing(f"{provider} listed no models")
        except Exception as exc:  # the SDK raises many types; none carries the key
            report.failed.append(provider)
            _log_failed(provider, exc)
            continue
        result = record_listing(provider, models, now)
        report.results.append(result)
        _log_result(result)
    return report


# ---------------------------------------------------------------------------
# Structured log lines
# ---------------------------------------------------------------------------


def _log_skipped(provider, why):
    logger.info(json.dumps({
        "severity": "INFO",
        "message": f"AI model discovery skipped {provider}: {why}.",
        "event": AI_MODEL_DISCOVERY_SKIPPED_EVENT,
        "provider": provider,
        "reason": why,
    }, separators=(",", ":")))


def _log_failed(provider, exc):
    """The exception's TYPE and HTTP status only -- never its text. A provider
    error body could echo the rejected credential, and a log line is forever
   . The type (``AuthenticationError``,
    ``APIConnectionError``, ``APITimeoutError``) says what to look at."""
    status = getattr(exc, "status_code", None)
    logger.error(json.dumps({
        "severity": "ERROR",
        "message": (
            f"AI model discovery FAILED for {provider}: {type(exc).__name__}"
            + (f" (HTTP {status})" if isinstance(status, int) else "")
            + ". Nothing was written; the last successful listing stays in force."
        ),
        "event": AI_MODEL_DISCOVERY_FAILED_EVENT,
        "provider": provider,
        "error_type": type(exc).__name__,
        "status_code": status if isinstance(status, int) else None,
    }, separators=(",", ":")))


def _log_result(result: ProviderResult):
    logger.info(json.dumps({
        "severity": "INFO",
        "message": (
            f"AI model discovery: {result.provider} lists {len(result.listed)} models "
            f"(+{len(result.added)} new, {len(result.returned)} back, "
            f"-{len(result.gone)} gone, {len(result.unpriced)} unpriced)."
        ),
        "event": AI_MODEL_DISCOVERY_EVENT,
        "provider": result.provider,
        "listed": len(result.listed),
        "added": result.added,
        "returned": result.returned,
        "gone": result.gone,
        "unpriced": len(result.unpriced),
    }, separators=(",", ":")))
    if result.unpriced:
        logger.warning(json.dumps({
            "severity": "WARNING",
            "message": (
                f"AI model discovery: {result.provider} lists {len(result.unpriced)} "
                "models with no AIModel row. They are NOT sold until a human prices "
                "them (a new lineup + rate-card migration)."
            ),
            "event": AI_MODELS_DISCOVERED_UNPRICED_EVENT,
            "provider": result.provider,
            "models": result.unpriced,
        }, separators=(",", ":")))
