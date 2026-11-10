"""Read-only provider inventory. Discovery never grants a billing capability."""
import re

from django.utils import timezone

from f2z.ai.retirements import model_is_retired

from .models import AIModel, ProviderModel
from f2z.ai.providers import configured_providers


def unreviewed_reason(provider, model):
    """Explain exclusions without inventing prices for unfamiliar model IDs."""
    if provider == "openai":
        if any(part in model for part in ("audio", "realtime", "transcribe", "whisper", "tts", "image", "embedding", "moderation", "live-")):
            return "unsupported_modality_or_endpoint"
        if any(part in model for part in ("-pro", "codex", "search")):
            return "requires_unimplemented_endpoint_or_tool_billing"
        if re.search(r"-\d{4}-\d{2}-\d{2}$", model):
            return "snapshot_requires_separate_price_and_capability_review"
    if provider == "xai" and any(part in model for part in ("imagine", "voice", "audio", "multi-agent")):
        return "unsupported_modality_or_endpoint"
    if provider == "anthropic" and "mythos" in model:
        return "restricted_access_requires_separate_review"
    return "price_and_capabilities_not_reviewed"


def provider_inventory():
    """Every discovered ID plus reviewed rows; no keys or raw metadata.

    ``available`` requires a configured key, successful exact-ID discovery,
    reviewed enabled GA row and an unexpired price. It is not a guarantee of
    inference entitlement: providers can revoke access between calls.
    """
    configured = configured_providers()
    models = {(row.provider, row.model): row for row in AIModel.objects.all()}
    listings = {(row.provider, row.provider_model_id): row for row in ProviderModel.objects.all()}
    enabled = set(AIModel.objects.enabled().values_list("provider", "model"))
    result = []
    for key in sorted(models.keys() | listings.keys()):
        provider, model = key
        row, listing = models.get(key), listings.get(key)
        reason = None
        if model_is_retired(provider, model, row.provider_model_id if row else ""):
            reason = "provider_retired"
        elif listing and listing.metadata.get("lifecycle") in ("deprecated", "retired"):
            reason = "provider_" + listing.metadata["lifecycle"]
        elif row is None:
            reason = unreviewed_reason(provider, model)
        elif row.price_checked_at is None:
            reason = "price_and_capabilities_not_reviewed"
        elif not row.is_ga or key not in enabled:
            reason = "price_expired" if row.price_valid_until and row.price_valid_until <= timezone.now() else "disabled"
        elif provider not in configured:
            reason = "provider_not_configured"
        elif listing is None:
            reason = "not_discovered"
        elif listing.missing_since is not None:
            reason = "provider_no_longer_lists_model"
        result.append({
            "provider": provider, "model": model,
            "available": reason is None, "unavailable_reason": reason,
            "price_checked_at": row.price_checked_at.isoformat() if row and row.price_checked_at else None,
            "price_valid_until": row.price_valid_until.isoformat() if row and row.price_valid_until else None,
            "last_seen_at": listing.last_seen_at.isoformat() if listing else None,
        })
    return result
