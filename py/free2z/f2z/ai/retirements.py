"""Reviewed lifecycle cutoffs for Free2Z catalogue/history and operator pins.

Verified 2026-11-10. Exact IDs only: discovery presence (including provider
redirects) is not evidence that an old price/capability contract still applies.
Dates without a published time fail closed at 00:00 UTC. This inventory grants
no replacement capabilities or prices. Keep historical migrations frozen.
"""
from dataclasses import dataclass
from datetime import datetime, timezone


@dataclass(frozen=True)
class Retirement:
    provider: str
    shutdown: str
    ids: tuple[str, ...]
    source: str

    @property
    def cutoff(self):
        return datetime.fromisoformat(self.shutdown).replace(tzinfo=timezone.utc)


OPENAI_SOURCE = "https://developers.openai.com/api/docs/deprecations"
ANTHROPIC_SOURCE = "https://platform.claude.com/docs/en/about-claude/model-deprecations"
RETIREMENTS = (
    Retirement("openai", "2026-03-26", (
        "gpt-4-0314", "gpt-4-0125-preview", "gpt-4-turbo-preview", "gpt-4-turbo-preview-completions",
    ), OPENAI_SOURCE),
    Retirement("openai", "2026-05-12", ("dall-e-2", "dall-e-3"), OPENAI_SOURCE),
    Retirement("openai", "2026-12-01", (
        "gpt-image-1-mini", "gpt-image-1.5", "gpt-image-1.5-2025-12-16", "chatgpt-image-latest",
    ), OPENAI_SOURCE),
    Retirement("openai", "2026-10-23", (
        "gpt-3.5-turbo", "gpt-3.5-turbo-0125", "gpt-3.5-turbo-completions",
        "gpt-4", "gpt-4-0613", "gpt-4-0613-completions", "gpt-4-completions",
        "gpt-4-1106-preview", "gpt-4-turbo", "gpt-4-turbo-2024-04-09", "gpt-4-turbo-completions",
        "gpt-4.1-nano", "gpt-4.1-nano-2025-04-14", "gpt-4o-2024-05-13",
        "gpt-image-1", "o1", "o1-2024-12-17", "o1-pro", "o1-pro-2025-03-19",
        "o3-mini", "o3-mini-2025-01-31", "o4-mini", "o4-mini-2025-04-16",
        "ft-o4-mini-2025-04-16",
    ), OPENAI_SOURCE),
    Retirement("openai", "2026-08-10", (
        "gpt-5.2-chat-latest", "gpt-5.3-chat-latest",
    ), OPENAI_SOURCE),
    Retirement("openai", "2026-09-28", (
        "gpt-3.5-turbo-instruct", "gpt-3.5-turbo-1106", "babbage-002", "davinci-002",
    ), OPENAI_SOURCE),
    Retirement("openai", "2026-12-11", (
        "gpt-5", "gpt-5-2025-08-07", "gpt-5-mini", "gpt-5-mini-2025-08-07",
        "gpt-5-nano", "gpt-5-nano-2025-08-07", "gpt-5-pro", "gpt-5-pro-2025-10-06",
        "o3", "o3-2025-04-16", "o3-pro", "o3-pro-2025-06-10",
    ), OPENAI_SOURCE),
    Retirement("openai", "2027-01-14", (
        "gpt-4o", "gpt-4o-2024-08-06", "gpt-4o-2024-11-20",
        "gpt-4o-mini", "gpt-4o-mini-2024-07-18", "gpt-4.1", "gpt-4.1-2025-04-14",
        "gpt-4.1-mini", "gpt-4.1-mini-2025-04-14",
    ), OPENAI_SOURCE),
    Retirement("openai", "2027-04-01", (
        "gpt-5.1", "gpt-5.1-2025-11-13", "gpt-5.4-nano", "gpt-5.4-nano-2026-03-17",
        "gpt-5.3-codex",
    ), OPENAI_SOURCE),
    Retirement("openai", "2027-02-10", (
        "gpt-image-2", "gpt-image-2-2026-04-21",
    ), OPENAI_SOURCE),
    Retirement("anthropic", "2026-11-30", (
        "claude-sonnet-4-5", "claude-sonnet-4-5-20250929",
    ), ANTHROPIC_SOURCE),
    Retirement("anthropic", "2026-08-05", (
        "claude-opus-4-1", "claude-opus-4-1-20250805",
    ), ANTHROPIC_SOURCE),
    Retirement("anthropic", "2026-06-15", (
        "claude-sonnet-4", "claude-sonnet-4-20250514", "claude-opus-4", "claude-opus-4-20250514",
    ), ANTHROPIC_SOURCE),
    Retirement("xai", "2026-05-15T19:00:00", (
        "grok-4-1-fast-reasoning", "grok-4-1-fast-non-reasoning", "grok-4-fast-reasoning",
        "grok-4-fast-non-reasoning", "grok-4-0709", "grok-code-fast-1", "grok-3", "grok-imagine-image-pro",
    ), "https://docs.x.ai/developers/migration/may-15-retirement"),
    Retirement("xai", "2026-11-02", ("grok-imagine-image-quality",),
               "https://docs.x.ai/developers/migration/imagine-image-quality-nov-2"),
)


def _identities(provider, model, provider_model_id=""):
    # Settings and provider metadata can contain malformed, even unhashable,
    # values. They are not identities; dispatch validates them before I/O.
    identities = {value for value in (model, provider_model_id) if isinstance(value, str)}
    if provider == "openai":
        # OpenAI's notice explicitly extends base-model shutdowns to fine-tunes.
        # Only the documented ft:<base>:... identity inherits a base cutoff.
        identities |= {value.split(":", 2)[1] for value in identities
                       if value.startswith("ft:") and value.count(":") >= 2}
    return identities


def retirement_for(provider, model, provider_model_id=""):
    identities = _identities(provider, model, provider_model_id)
    return min((entry for entry in RETIREMENTS if entry.provider == provider
                and identities.intersection(entry.ids)),
               key=lambda entry: entry.cutoff, default=None)


def retired_model_ids(provider, *, at=None):
    at = at or datetime.now(timezone.utc)
    return frozenset(model for entry in RETIREMENTS
                     if entry.provider == provider and entry.cutoff <= at for model in entry.ids)


def model_is_retired(provider, model, provider_model_id=""):
    # Either identity can be retired; a live upstream pin cannot revive an old
    # public ID, nor can an innocent public alias hide a retired upstream ID.
    ids = retired_model_ids(provider)
    return bool(_identities(provider, model, provider_model_id).intersection(ids))
