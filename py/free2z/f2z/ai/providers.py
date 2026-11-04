"""Provider abstraction for the Free2Z multi-provider AI backend.

xAI, Kimi (Moonshot), and OpenAI all speak the OpenAI Chat Completions wire
protocol, so they share a single ``openai`` SDK client that differs only by
``base_url`` + API key. Anthropic speaks its own Messages API, so it gets a
dedicated adapter normalized to the SAME streaming interface. The rest of the
codebase only ever sees:func:`stream_chat`, which yields plain **text delta
strings** and records the provider's terminal reason on the returned iterator,
so ``Conversation.generate`` and the Channels consumer stay provider-agnostic
while bounded callers can tell why generation stopped.

API keys and the default utility model are read from Django settings when a
configured Django project is available, falling back to the process
environment otherwise (so this module is importable — and usable — without
Django, e.g. from ``f2z/openai/example.py``).
"""

import logging
import os
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Provider identifiers
# --------------------------------------------------------------------------- #
OPENAI = "openai"
ANTHROPIC = "anthropic"
XAI = "xai"
KIMI = "kimi"

PROVIDER_CHOICES = [
    (OPENAI, "OpenAI"),
    (ANTHROPIC, "Anthropic"),
    (XAI, "xAI"),
    (KIMI, "Kimi (Moonshot)"),
]

# Providers that speak the OpenAI Chat Completions wire protocol.
OPENAI_COMPATIBLE = {OPENAI, XAI, KIMI}

# --------------------------------------------------------------------------- #
# Policy: providers free2z may not send ANY content to
# --------------------------------------------------------------------------- #
#Provider -> why, for providers whose terms we have declined. This is a
#CODE-level list on purpose, and it is stronger than the per-row
#``AIModel.is_enabled`` checkbox it drives: ``AIModel.save`` forces every row
#of a listed provider to ``is_enabled=False``, so an operator cannot re-enable
#one from the Django admin, and a NEW row added there lands disabled instead
#of defaulting open. It is also read directly by ``stream_chat``, which does
#NOT trust the row it was handed: ``QuerySet.update()`` and ``bulk_create()``
#skip ``save()`` entirely, so the list -- not the column -- is what makes the
#outbound boundary authoritative.
#
#LIFTING A BAN is two deliberate steps, both pinned by
#``test_lifting_the_ban_restores_the_lineup_and_unblocks_re_enabling``:
#1. remove the entry here and deploy. A reseed then restores ``is_ga``,
#which ``seed_ai_models`` DERIVES from this list rather than hardcoding
#-- otherwise lifting the ban would restore translation (which keys off
#``is_enabled``) and leave chat silently missing (which keys off
#``is_ga``).
#2. turn ``is_enabled`` back on per row, in the Django admin. The seeder
#writes that column on CREATE only, so that a routine reseed can never
#clear an operator's own kill switch -- the price of which is that it
#cannot clear a policy one either. Step 1 is what makes step 2 stick.
#The rows keep their prices, reserves, ceilings and order throughout, so
#nothing is rebuilt.
#
#Mirrored (frozen) in migration ``openai.0019_aimodel_is_enabled`` and read
#directly by ``seed_ai_models`` -- keep the migration copy in sync.
POLICY_DISABLED_PROVIDERS = {
    KIMI: (
        "Moonshot OpenPlatform ToS (2026-07-30) permits use of Customer "
        "Content to improve the Services; no published retention period and "
        "no zero-data-retention option (#1041)."
    ),
}


def policy_disabled_reason(provider):
    """Why ``provider`` is off, or ``None`` if it is permitted."""
    return POLICY_DISABLED_PROVIDERS.get(provider)

# Base URLs for the OpenAI-compatible providers. ``None`` uses the OpenAI SDK
# default (api.openai.com).
BASE_URLS = {
    OPENAI: None,
    XAI: "https://api.x.ai/v1",
    KIMI: "https://api.moonshot.ai/v1",
}

# Settings/env var name that holds each provider's API key.
API_KEY_NAMES = {
    OPENAI: "OPENAI_API_KEY",
    ANTHROPIC: "ANTHROPIC_API_KEY",
    XAI: "XAI_API_KEY",
    KIMI: "MOONSHOT_API_KEY",
}

# Anthropic requires an explicit output cap on every request. Do NOT pass
# temperature / top_p / thinking — those are removed on Opus 4.8 / Sonnet 5.
ANTHROPIC_MAX_OUTPUT = 8192


# --------------------------------------------------------------------------- #
# Reasoning that no output cap bounds
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ReasoningPolicy:
    """How a chat request bounds and pays for reasoning the cap cannot stop.

    ``effort`` is sent as ``reasoning_effort`` on every Chat Completions
    request to the model, or nothing when ``None``.

    ``allowance_tokens`` is the number of reasoning tokens a request is
    ADMITTED for on top of the visible output cap it sends. It is part of the
    ceiling the requester must hold (and, on the metered path, has held), and
    the charge is clamped to that larger ceiling. Typical reasoning is then
    paid for by the requester, not by us. Only reasoning past the allowance is
    absorbed, and every time that happens the clamp emits
    ``ai_charge_clamped``, which ``monitoring/`` counts and alerts on.
    """

    effort: "str | None" = None
    allowance_tokens: int = 0


#Providers that bound reasoning with the output cap we send. OpenAI's
#``max_completion_tokens`` covers reasoning, and so does Anthropic's
#``max_tokens``, which covers thinking. The admitted ceiling is already a
#real bound for them, so they get no allowance.
NO_REASONING_ALLOWANCE = ReasoningPolicy()

#Reasoning allowance for an xAI row this table does not name (an
#operator-added model). xAI's output cap never covers reasoning. Its
#``max_completion_tokens`` "only applies to visible output tokens (i.e. does
#not apply to tokens used for reasoning or function calls)"
#(https://docs.x.ai/developers/rest-api-reference/inference/chat-completions).
#So an unknown xAI model is admitted as if it reasons, which fails closed:
#the entry bar is higher, and the charge is still metered. No ``effort`` is
#sent to it, because the accepted values vary by model.
XAI_DEFAULT_REASONING_ALLOWANCE = 16384

#``(provider, model)`` ->:class:`ReasoningPolicy`. Checked against xAI's
#reasoning guide and the per-model catalogue embedded in it
#(https://docs.x.ai/docs/guides/reasoning, read 2026-10-04):
#
#* grok-4.5: ``supportedEfforts`` low/medium/high/xhigh, ``defaultEffort``
#high. "Reasoning cannot be disabled", and xhigh is treated as high.
#Left at its default, every chat request reasons at the most expensive
#setting it has. ``"low"`` ("uses some reasoning tokens, but still fast")
#shrinks the tail. It does not bound it. The allowance pays for it.
#* grok-4.3: ``supportedEfforts`` none/low/medium/high/xhigh,
#``defaultEffort`` low. Sending ``"low"`` is today's behaviour. Pinning
#it here means a change to xAI's default cannot quietly move our costs.
#
#The allowance is an owner pricing knob, not a measurement. No live xAI
#usage has been recorded here. At grok-4.5's $6/1M output and the
#x1.5 markup, 16384 tokens add about 15 2Z to what a requester must hold.
#They are charged only for the reasoning the provider actually reports.
#Raise the allowance if ``ai_charge_clamped`` fires for a model, and lower
#it if the entry bar is what users trip on.
REASONING_POLICIES = {
    (XAI, "grok-4.5"): ReasoningPolicy(effort="low", allowance_tokens=16384),
    (XAI, "grok-4.3"): ReasoningPolicy(effort="low", allowance_tokens=16384),
}

#Providers whose output cap does not bound reasoning, mapped to the policy
#for a model:data:`REASONING_POLICIES` does not name.
_UNCAPPED_REASONING_PROVIDERS = {
    XAI: ReasoningPolicy(allowance_tokens=XAI_DEFAULT_REASONING_ALLOWANCE),
}


def reasoning_policy(provider, model):
    """The:class:`ReasoningPolicy` for one ``(provider, model)``."""
    return (REASONING_POLICIES.get((provider, model))
            or _UNCAPPED_REASONING_PROVIDERS.get(provider)
            or NO_REASONING_ALLOWANCE)


class ModelDisabled(RuntimeError):
    """Raised by:func:`stream_chat` for a model flagged off in the catalogue.

    A ``RuntimeError`` subclass on purpose: every caller in the tree already
    treats a ``RuntimeError`` out of this module as "this model can't be used,
    tell the user and move on" (that is how a missing API key surfaces), so an
    unfiltered path degrades to a clean error rather than a 500.
    """


# Exact aliases and snapshots in the October 23, 2026 retirement cohort used
# by our catalog. Keep historical prices/receipts; only new work is refused.
# https://developers.openai.com/api/docs/deprecations (verified 2026-10-17).
RETIRED_OPENAI_MODEL_IDS = frozenset({
    "gpt-4.1-nano", "gpt-4.1-nano-2025-04-14",
    "gpt-4o-2024-05-13",
    "o1", "o1-2024-12-17",
    "o3-mini", "o3-mini-2025-01-31",
    "o4-mini", "o4-mini-2025-04-16",
})


def model_is_retired(provider, model, provider_model_id=""):
    """A reviewed retirement cannot be undone by a flag or upstream pin."""
    return provider == OPENAI and (
        model in RETIRED_OPENAI_MODEL_IDS or provider_model_id in RETIRED_OPENAI_MODEL_IDS
    )


def refuse_retired_model(provider, model, provider_model_id=""):
    if model_is_retired(provider, model, provider_model_id):
        raise ModelDisabled(f"AI model {provider}/{model} is retired; refusing new generation.")


@dataclass(frozen=True)
class ProviderUsage:
    """The provider's own token report for one completed request.

    ``output_tokens`` is what the provider BILLS as output, hidden reasoning
    included, normalised across providers that disagree about where reasoning
    goes:

    * OpenAI: ``completion_tokens`` already includes
      ``completion_tokens_details.reasoning_tokens`` (``total_tokens`` is
      ``prompt + completion``; the pinned SDK's ``CompletionTokensDetails``
      says reasoning is "counted in the total completion tokens for purposes
      of billing").
    * xAI: ``completion_tokens`` EXCLUDES reasoning, which is reported beside
      it (``total_tokens`` is ``prompt + completion + reasoning``) and billed
      at the output rate.
    * Anthropic: ``output_tokens`` is "the inclusive, authoritative total used
      for billing"; ``output_tokens_details.thinking_tokens`` is a breakdown.

    ``reasoning_tokens`` is informational only -- it is already inside
    ``output_tokens`` and must never be added to it again.
    ``input_tokens`` is the provider's total prompt count. Cache counts are
    disjoint subsets of it: cached reads, 5-minute writes, and 1-hour writes.
    Anthropic reports its input count with cache tokens excluded, so its
    adapter adds the categories to produce this total.
    """

    input_tokens: int | None
    output_tokens: int
    reasoning_tokens: int = 0
    cached_input_tokens: int = 0
    cache_write_tokens: int = 0
    cache_write_1h_tokens: int = 0


def _field(obj, name):
    """``obj.name`` or ``obj[name]``: Moonshot's usage is an untyped extra."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _count(value):
    """A token count, or ``None`` for anything that is not a plain int.

    Strict on purpose: a value that is not an ``int`` (a mock attribute, a
    string, a bool) is not evidence of what the provider billed, and the
    caller then falls back to its own estimate rather than billing on it.
    """
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


#OpenAI-compatible providers whose ``completion_tokens`` does NOT contain
#``reasoning_tokens``. Used only when ``total_tokens`` cannot settle the
#question by arithmetic (see:func:`_openai_compatible_usage`).
_REASONING_OUTSIDE_COMPLETION = {XAI}


def _openai_compatible_usage(provider, usage):
    """Normalise a Chat Completions ``usage`` block, or ``None``.

    Whether ``reasoning_tokens`` is inside ``completion_tokens`` is decided
    from the payload itself first, because ``total_tokens`` says so:
    ``prompt + completion`` means inside (OpenAI), ``prompt + completion +
    reasoning`` means beside it (xAI). Reasoning larger than the completion
    cannot be inside it. Only a payload that settles none of those falls back
    to the provider's documented convention.
    """
    prompt = _count(_field(usage, "prompt_tokens"))
    completion = _count(_field(usage, "completion_tokens"))
    if completion is None:
        return None
    reasoning = _count(
        _field(_field(usage, "completion_tokens_details"), "reasoning_tokens")
    ) or 0
    total = _count(_field(usage, "total_tokens"))

    prompt_details = _field(usage, "prompt_tokens_details")
    cached = _count(_field(prompt_details, "cached_tokens")) or 0
    cache_write = _count(_field(prompt_details, "cache_write_tokens")) or 0
    cache_write_1h = _count(
        _field(prompt_details, "cache_write_1h_tokens")) or 0
    # Treat detail counts as a breakdown only when they fit inside the
    # provider's total. A malformed/overlapping breakdown must not subtract
    # prompt tokens or make any category negative.
    if prompt is None or cached + cache_write + cache_write_1h > prompt:
        cached = cache_write = cache_write_1h = 0

    outside = provider in _REASONING_OUTSIDE_COMPLETION
    if reasoning:
        if prompt is not None and total == prompt + completion + reasoning:
            outside = True
        elif prompt is not None and total == prompt + completion:
            outside = False
        elif reasoning > completion:
            outside = True
    output = completion + reasoning if outside else completion
    return ProviderUsage(
        input_tokens=prompt, output_tokens=output,
        reasoning_tokens=reasoning, cached_input_tokens=cached,
        cache_write_tokens=cache_write,
        cache_write_1h_tokens=cache_write_1h,
    )


def _anthropic_usage(start_usage, delta_usage):
    """Normalise Anthropic's streamed usage, or ``None``.

    ``message_delta`` carries the CUMULATIVE ``output_tokens`` (thinking
    included) at the end of the message; ``message_start`` only has the
    opening count, so without a ``message_delta`` there is no final figure.
    """
    output = _count(_field(delta_usage, "output_tokens"))
    if output is None:
        return None
    input_tokens = _count(_field(delta_usage, "input_tokens"))
    if input_tokens is None:
        input_tokens = _count(_field(start_usage, "input_tokens"))
    cache_read = _count(_field(delta_usage, "cache_read_input_tokens"))
    if cache_read is None:
        cache_read = _count(_field(start_usage, "cache_read_input_tokens")) or 0
    cache_create = _count(_field(delta_usage, "cache_creation_input_tokens"))
    if cache_create is None:
        cache_create = _count(
            _field(start_usage, "cache_creation_input_tokens")) or 0
    creation_details = _field(delta_usage, "cache_creation")
    if creation_details is None:
        creation_details = _field(start_usage, "cache_creation")
    write_5m = _count(_field(creation_details, "ephemeral_5m_input_tokens"))
    write_1h = _count(_field(creation_details, "ephemeral_1h_input_tokens"))
    if write_5m is None and write_1h is None:
        write_5m, write_1h = cache_create, 0
    else:
        write_5m = write_5m or 0
        write_1h = write_1h or 0
        if cache_create is not None and write_5m + write_1h != cache_create:
            write_5m, write_1h = cache_create, 0
    if input_tokens is None:
        # Cache details cannot be priced against the local fallback estimate:
        # without the provider's uncached base count their disjoint total is
        # unknown, so fall back to the model's encoding as one ordinary class.
        cache_read = write_5m = write_1h = 0
    thinking = _count(_field(
        _field(delta_usage, "output_tokens_details"), "thinking_tokens")) or 0
    return ProviderUsage(
        input_tokens=(None if input_tokens is None else
                      input_tokens + cache_read + write_5m + write_1h),
        output_tokens=output,
        reasoning_tokens=min(thinking, output),
        cached_input_tokens=cache_read,
        cache_write_tokens=write_5m,
        cache_write_1h_tokens=write_1h,
    )


class ChatStream:
    """Text iterator with the terminal reason reported by its provider.

    Iteration remains string-for-string compatible with the historical
    ``stream_chat`` generator. ``termination_reason`` is set only when the
    underlying stream is exhausted normally and the provider supplied a
    reason; an interrupted stream or omitted final event leaves it ``None``.

    ``usage``  is the provider's own:class:`ProviderUsage` for the
    request once it is FINAL: the stream ran to its end, or the adapter has
    already seen the usage that follows the provider's terminal reason (the
    usage-only chunk after ``finish_reason``; Anthropic's ``message_delta``
    carrying ``stop_reason``). The second case matters because a caller's
    wall clock can break the loop between that chunk and ``StopIteration``,
    and the count it already holds is the whole one. Anything earlier is
    ``None``: a stream abandoned mid-generation never reports a partial count
    as if it were the whole -- Anthropic's opening ``message_start`` says
    ``output_tokens: 1``, and billing on that would be worse than the
    estimate the caller falls back to.
    """

    def __init__(self, stream, usage_sink=None):
        self._stream = iter(stream)
        self._usage_sink = usage_sink if usage_sink is not None else {}
        self._exhausted = False
        self.termination_reason = None

    @property
    def usage(self):
        # EOF alone is not proof of a complete provider response. In
        # particular, an accepted SSE connection can be truncated before its
        # terminal event; only a terminal reason (or an already-seen final
        # usage chunk) makes its usage authoritative.
        if not (
            self._usage_sink.get("final")
            or (self._exhausted and self.termination_reason is not None)
        ):
            return None
        return self._usage_sink.get("usage")

    @property
    def terminal_event_received(self):
        """Whether the provider completed, even before final usage or EOF."""
        return bool(self._usage_sink.get("terminal_event_received"))

    @property
    def exhausted(self):
        """Whether the provider iterator reached EOF."""
        return self._exhausted

    @property
    def provider_started(self):
        """Whether the provider emitted a generation event."""
        return bool(self._usage_sink.get("provider_started"))

    def __iter__(self):
        return self

    def __next__(self):
        try:
            return next(self._stream)
        except StopIteration as stopped:
            self.termination_reason = stopped.value
            self._exhausted = True
            raise

    def close(self):
        close = getattr(self._stream, "close", None)
        if close is not None:
            close()


# --------------------------------------------------------------------------- #
# Settings / env access
# --------------------------------------------------------------------------- #
def _get_setting(name, default=""):
    """Read ``name`` from Django settings, falling back to ``os.environ``."""
    try:
        from django.conf import settings

        if settings.configured:
            value = getattr(settings, name, None)
            if value is not None:
                return value
    except Exception:
        # Django not installed / not configured — fall through to the env.
        pass
    return os.environ.get(name, default)


def default_utility_model():
    """Model used by the OpenAI-only moderation/tagging helpers."""
    return _get_setting("DEFAULT_UTILITY_MODEL", "gpt-4o")


#Default for:func:`prompt_completion_model`. The same cheap model
#``TAGGING_MODEL`` already runs in prod, so it is a model this key is known to
#be entitled to, and tiktoken 0.14 maps it to ``o200k_base`` -- a vocabulary
#``utils/warm_tiktoken_cache.py`` bakes into the image.
DEFAULT_PROMPT_COMPLETION_MODEL = "gpt-4o-mini"

#The tokenizer for text that is budgeted for:func:`prompt_completion_model`
#(``search.helpers.truncate_text``). Named explicitly rather than derived
#with ``tiktoken.encoding_for_model`` so an env override to a model name
#tiktoken has never heard of cannot turn into a ``KeyError`` on every index
#job -- a truncation budget does not need the exact tokenizer, it needs one
#that is always there.
PROMPT_COMPLETION_ENCODING = "o200k_base"


#Prompt + reply ceiling for the two FLAT-PRICED callers of
#:func:`complete_prompt` (storytime pages, ``/api/openai/prompt``: 1 2Z =
#$0.01 each, not metered). It is the context window of the model they used
#to run on, gpt-3.5-turbo-instruct, which is what bounded their provider
#cost until: a longer prompt was a provider 400, i.e. a 503 and no
#charge. gpt-4o-mini accepts 128k tokens, so without this a 100k-token prompt
#would cost ~$0.015 of input alone against a $0.01 charge (codex review).
#At gpt-4o-mini list prices 4,096 tokens is at most ~$0.0025 -- all of it
#output at $0.60/M -- so the flat 1 2Z keeps its margin.
FLAT_PRICE_CONTEXT_TOKENS = 4096


def prompt_token_count(prompt):
    """Tokens in ``prompt`` under:data:`PROMPT_COMPLETION_ENCODING`.

    ``encode_ordinary``, not ``encode``: user text that happens to contain a
    literal special-token string (``<|endoftext|>``) is ordinary text, and
    ``encode`` raises ``ValueError`` on it -- a 500 on user input (codex).
    """
    import tiktoken

    encoding = tiktoken.get_encoding(PROMPT_COMPLETION_ENCODING)
    return len(encoding.encode_ordinary(prompt))


def flat_price_prompt_error(prompt, *, max_tokens):
    """``None`` if ``prompt`` fits a flat-priced call reserving ``max_tokens``
    of reply, else the user-facing reason it does not. Checked BEFORE the
    provider is called, so an over-long prompt costs nobody anything."""
    budget = FLAT_PRICE_CONTEXT_TOKENS - max_tokens
    used = prompt_token_count(prompt)
    if used > budget:
        return f"Prompt is too long: {used} tokens, the limit is {budget}."
    return None


class EmptyCompletion(RuntimeError):
    """:func:`complete_prompt` got a reply with no visible text.

    Deliberately NOT caught as success anywhere: the paid callers release the
    idempotency claim and answer 503 without charging, and search lets the
    job fail rather than embed an empty summary.
    """


def prompt_completion_model():
    """The one model behind every single-prompt OpenAI text call.

    Search summaries (``search.index_zpage``), storytime pages and the legacy
    flat-priced ``/api/openai/prompt`` all used ``gpt-3.5-turbo-instruct`` on
    the legacy Completions API. OpenAI retired it on 2026-09-28 and every one
    of those calls started returning ``404 model_not_found``. One setting
    (``PROMPT_COMPLETION_MODEL``, env-overridable) instead of three literals,
    so the next retirement is a ConfigMap change, not a hunt.

    Override it only with a NON-reasoning chat model: the callers' budgets
    (150 tokens for a search summary) are sized for visible output, and a
    reasoning model counts its hidden reasoning against the same cap -- the
    result is:class:`EmptyCompletion` on every call, not a degraded one.
    """
    # `or`: an env var set to "" must not become `model=""` on every call.
    value = _get_setting("PROMPT_COMPLETION_MODEL", DEFAULT_PROMPT_COMPLETION_MODEL)
    return str(value).strip() or DEFAULT_PROMPT_COMPLETION_MODEL


def complete_prompt(client, prompt, *, max_tokens, temperature=None,
                    model=None, system=None):
    """Send ONE user prompt through Chat Completions and return the reply text.

    The replacement for ``client.completions.create(prompt=...)``:
    the prompt becomes the single user message, nothing else is added, so the
    model sees the same text the legacy call sent. ``client`` is the caller's
    already-bounded OpenAI client -- this function sets no timeout of its own
    and never builds a client, so the per-path budgets  keep
    applying.

    ``max_tokens`` is sent as ``max_completion_tokens``, the parameter every
    current OpenAI chat model accepts (``max_tokens`` is rejected by the
    reasoning families, which an env override could select). ``temperature``
    is only sent when given, matching the legacy calls that did not set it.

    ``system``, when given, is sent as a system message ahead of the prompt --
    for a caller that was already on Chat Completions with a system message
    (the ``describe_zpage_listener`` meta description, ), so moving it
    onto this helper does not change what the model sees.

    A reply with no visible text -- ``content`` is ``None`` on a refusal, and
    a reasoning model can spend the whole ``max_tokens`` budget before it
    writes anything -- raises:class:`EmptyCompletion` instead of returning
    ``""``. Two callers charge 2Z right after this returns and search embeds
    the result, so "nothing came back" must never look like a deliverable.
    """
    model = model or prompt_completion_model()
    refuse_retired_model(OPENAI, model)
    kwargs = {
        "model": model,
        "messages": (
            [{"role": "system", "content": system}] if system else []
        ) + [{"role": "user", "content": prompt}],
        "max_completion_tokens": max_tokens,
    }
    if temperature is not None:
        kwargs["temperature"] = temperature
    response = client.chat.completions.create(**kwargs)
    choice = response.choices[0]
    content = choice.message.content
    if not content or not content.strip():
        raise EmptyCompletion(
            f"{kwargs['model']} returned no text "
            f"(finish_reason={getattr(choice, 'finish_reason', None)!r})"
        )
    return content


def _api_key(provider):
    return _get_setting(API_KEY_NAMES[provider], "")


# --------------------------------------------------------------------------- #
# Configuration-derived availability
# --------------------------------------------------------------------------- #
def provider_is_configured(provider):
    """Whether an API key is set for ``provider``. No network I/O.

    Exactly the test:func:`get_client` applies before it raises "No API key
    configured", so a provider this calls configured is one ``get_client``
    will build a client for, and vice versa. It does not prove the key WORKS
    -- only a provider call can -- but it is the difference between a model
    that might answer and one that 503s on every prompt by construction.
    """
    return provider in API_KEY_NAMES and bool(_api_key(provider))


def configured_providers():
    """Every provider with an API key set, as a frozenset."""
    return frozenset(p for p in API_KEY_NAMES if provider_is_configured(p))


def unconfigured_providers():
    """Permitted providers with NO key -- what the catalogue must not offer.

    Policy-disabled providers (:data:`POLICY_DISABLED_PROVIDERS`) are left
    out: they are off whether or not a key exists, so listing them here would
    report a deliberate decision as a missing secret.
    """
    return sorted(
        p for p in API_KEY_NAMES
        if p not in POLICY_DISABLED_PROVIDERS and not provider_is_configured(p)
    )


#``jsonPayload.event`` of the startup line below. Counted by the
#``ai_providers_unconfigured`` log-based metric
#(``monitoring/log-metrics/ai-providers-unconfigured.json``); keep the two
#in step.
AI_PROVIDERS_UNCONFIGURED_EVENT = "ai_providers_unconfigured"


def availability_report(translation_preference=()):
    """The startup availability summary, as a JSON-serializable dict.

    ``translation_preference`` is the ordered ``provider:model`` list
    translation will try. Each entry whose provider has no key is reported
    as skipped, and the first one that is NOT is reported as the effective
    first choice -- so "the documented first choice is Haiku but prod runs
    gpt-4o"  is a line in the log instead of a thing nobody notices
    because the fallback works. Pure configuration: no DB, no network, so it
    is safe from ``AppConfig.ready``. A row can still be flagged off with
    ``AIModel.is_enabled`` in the admin, which this cannot see.
    """
    unconfigured = unconfigured_providers()
    skipped = []
    effective = None
    for entry in translation_preference:
        provider = str(entry).partition(":")[0].strip()
        if provider in POLICY_DISABLED_PROVIDERS:
            skipped.append({"model": entry, "why": "policy_disabled"})
        elif not provider_is_configured(provider):
            skipped.append({
                "model": entry,
                "why": f"no {API_KEY_NAMES.get(provider, 'API key')}",
            })
        elif effective is None:
            effective = entry
    return {
        "unconfigured_providers": unconfigured,
        "missing_keys": [API_KEY_NAMES[p] for p in unconfigured],
        "configured_providers": sorted(configured_providers()),
        "translation_skipped": skipped,
        "translation_first_choice": effective,
    }


def log_availability(translation_preference=(), log=None):
    """Emit the one-line startup availability record; return the report.

    WARNING with ``event=ai_providers_unconfigured`` when any permitted
    provider has no key -- the log-based metric counts that line, so the
    state is visible on a dashboard rather than only as a 503 some API
    client eventually sees. INFO otherwise. One JSON line either way, the
    same shape as ``dj.free2z.throttling._log_throttle_fail_open``.
    """
    import json

    log = log or logger
    report = availability_report(translation_preference)
    if report["unconfigured_providers"]:
        payload = {
            "severity": "WARNING",
            "message": (
                "AI providers unconfigured: "
                + ", ".join(report["unconfigured_providers"])
                + ". Their models are hidden from the catalogue and skipped "
                "by translation; effective first translation choice is "
                + str(report["translation_first_choice"])
                + "."
            ),
            "event": AI_PROVIDERS_UNCONFIGURED_EVENT,
            **report,
        }
        log.warning(json.dumps(payload, separators=(",", ":")))
    else:
        payload = {
            "severity": "INFO",
            "message": "AI providers: every permitted provider has a key.",
            "event": "ai_providers_configured",
            **report,
        }
        log.info(json.dumps(payload, separators=(",", ":")))
    return report


# --------------------------------------------------------------------------- #
# Lazily-constructed, cached clients (one per provider)
# --------------------------------------------------------------------------- #
_clients = {}

#Client-level DEFAULT budget, in seconds, for any call that does not pass its
#own ``timeout``. The SDK defaults this replaces were read from the
#installed packages, not assumed: ``openai._constants.DEFAULT_TIMEOUT`` and
#``anthropic._constants.DEFAULT_TIMEOUT`` are both 600s read / 5s connect,
#with ``DEFAULT_MAX_RETRIES = 2`` -- up to ~30 minutes of one worker per
#call. Every chat/translation/detection path passes its own ``timeout``
#through:func:`_bind_options` and is unaffected; this is the floor under
#whatever does not. The read budget is an INACTIVITY bound between bytes, so
#120s never cuts off a stream that is still producing tokens, and it covers
#a non-streaming completion or an image generation, which are the slowest
#single responses this codebase asks for.
DEFAULT_CONNECT_TIMEOUT_SECONDS = 5.0
DEFAULT_READ_TIMEOUT_SECONDS = 120.0


def default_timeout():
    """The (connect=5, read/write/pool=120) budget used to BUILD clients."""
    from openai import Timeout

    return Timeout(
        DEFAULT_READ_TIMEOUT_SECONDS, connect=DEFAULT_CONNECT_TIMEOUT_SECONDS,
    )


def get_client(provider):
    """Return a cached SDK client for ``provider``.

    Clients are constructed on first use so an unset API key only fails when a
    provider is actually exercised — not at import time.
    """
    if provider in _clients:
        return _clients[provider]

    key = _api_key(provider)
    if not key:
        raise RuntimeError(
            f"No API key configured for AI provider '{provider}'. "
            f"Set {API_KEY_NAMES[provider]} in Django settings or the "
            f"environment."
        )

    if provider in OPENAI_COMPATIBLE:
        from openai import OpenAI

        client = OpenAI(
            api_key=key, base_url=BASE_URLS.get(provider),
            timeout=default_timeout(),
        )
    elif provider == ANTHROPIC:
        import anthropic

        client = anthropic.Anthropic(
            api_key=key,
            timeout=anthropic.Timeout(
                DEFAULT_READ_TIMEOUT_SECONDS,
                connect=DEFAULT_CONNECT_TIMEOUT_SECONDS,
            ),
        )
    else:
        raise ValueError(f"Unknown AI provider: {provider!r}")

    _clients[provider] = client
    return client


def get_utility_client():
    """OpenAI client for the moderation/tagging helpers (they stay on OpenAI)."""
    return get_client(OPENAI)


# --------------------------------------------------------------------------- #
# Unified streaming interface — yields text delta strings
# --------------------------------------------------------------------------- #
def _bind_options(client, timeout=None, max_retries=None):
    """Return ``client`` bound to a per-request ``timeout`` / ``max_retries``.

    ``timeout`` is in **seconds**. Both SDKs expose ``with_options``; if a
    future version does not, or rejects the arguments, log loudly and fall back
    to the unmodified client. Failing open is deliberate -- a call without a
    tightened timeout is a worse day, not a broken feature -- but it is NOT
    silent, because the caller's cost/latency guarantees quietly weaken when
    this happens (see:func:`f2z.ai.language.detect_language`, whose 20s budget
    depends on it).
    """
    options = {}
    if timeout is not None:
        options["timeout"] = timeout
    if max_retries is not None:
        options["max_retries"] = max_retries
    if not options:
        return client

    with_options = getattr(client, "with_options", None)
    if with_options is None:
        logger.warning(
            "AI client %s has no with_options(); falling back to SDK default "
            "timeout/retries", type(client).__name__,
        )
        return client
    try:
        return with_options(**options)
    except Exception:
        logger.warning(
            "AI client %s rejected with_options(%s); falling back to SDK "
            "defaults", type(client).__name__, sorted(options),
            exc_info=True,
        )
        return client


# Chat Completions output cap: OpenAI's current models require
# ``max_completion_tokens`` (``max_tokens`` is deprecated there), while the
# other OpenAI-compatible providers still take ``max_tokens``. Guessing wrong
# is a 400, so ``_create_capped`` tries the expected name, falls back to the
# other on a parameter complaint, and remembers what worked per (provider,
# model) -- a mis-mapped model costs one rejected request once, not a broken
# feature.
_MAX_OUTPUT_PARAM = {
    OPENAI: "max_completion_tokens",
    XAI: "max_tokens",
    KIMI: "max_tokens",
}
_max_output_param_learned = {}


#Providers asked for a final usage chunk (``stream_options.include_usage``),
#without which a Chat Completions stream reports no usage at all and the
#reasoning a reply cost is invisible to billing. Both document the
#parameter. Kimi is left out: it is policy-disabled, and Moonshot reports
#usage inside the last choice unasked (read anyway, see
#:func:`stream_openai_compatible`).
_STREAM_USAGE_PROVIDERS = {OPENAI, XAI}
#``(provider, model)`` pairs that rejected ``stream_options`` -- asked once,
#then streamed without it (usage then falls back to the caller's estimate).
_stream_usage_unsupported = set()
#``(provider, model)`` pairs that rejected ``reasoning_effort`` -- asked
#once, then sent without it (the provider's default effort then applies;
#the admission allowance and the clamp alert still bound what it costs us).
_reasoning_effort_unsupported = set()


def _create_capped(client, provider, model, messages, max_output_tokens):
    request = {"model": model, "messages": messages, "stream": True}
    if (provider in _STREAM_USAGE_PROVIDERS
            and (provider, model) not in _stream_usage_unsupported):
        request["stream_options"] = {"include_usage": True}
    # xAI's output cap does not bound reasoning, and grok-4.5 reasons at
    # "high" unless told otherwise. This sets the effort explicitly,
    # which is the only lever xAI offers: "Reasoning cannot be disabled".
    effort = reasoning_policy(provider, model).effort
    if effort and (provider, model) not in _reasoning_effort_unsupported:
        request["reasoning_effort"] = effort
    # Each optional parameter may be dropped at most once, so this tries at
    # most three requests.
    while True:
        try:
            return _create_with_cap(
                client, provider, model, request, max_output_tokens)
        except Exception as exc:
            # Same discipline as the cap fallback below: only a 400 that is
            # ABOUT one of these parameters earns another try. Losing usage
            # costs us the reasoning charge on this model, and losing the
            # effort costs us a longer tail. Losing chat costs everything.
            if ("stream_options" in request
                    and _is_unsupported_param_error(exc, "stream_options")):
                logger.warning(
                    "%s/%s rejected stream_options; streaming without "
                    "provider usage (reasoning tokens will not be billed "
                    "for it)", provider, model,
                )
                _stream_usage_unsupported.add((provider, model))
                dropped = "stream_options"
            elif ("reasoning_effort" in request
                    and _is_unsupported_param_error(exc, "reasoning_effort")):
                logger.warning(
                    "%s/%s rejected reasoning_effort=%r; sending without it, "
                    "so the provider's default effort applies (#2447)",
                    provider, model, request["reasoning_effort"],
                )
                _reasoning_effort_unsupported.add((provider, model))
                dropped = "reasoning_effort"
            else:
                raise
            request = {k: v for k, v in request.items() if k != dropped}


def _create_with_cap(client, provider, model, request, max_output_tokens):
    refuse_retired_model(provider, model)
    if max_output_tokens is None:
        return client.chat.completions.create(**request)

    preferred = _max_output_param_learned.get((provider, model)) or \
        _MAX_OUTPUT_PARAM.get(provider, "max_tokens")
    alternate = (
        "max_tokens" if preferred == "max_completion_tokens"
        else "max_completion_tokens"
    )
    for name in (preferred, alternate):
        try:
            response = client.chat.completions.create(
                **request, **{name: max_output_tokens},
            )
        except Exception as exc:
            # Only a complaint ABOUT the cap parameter earns the second try.
            # Anything else -- auth, a bad model id, and above all a 429 whose
            # message happens to mention "tokens per minute" -- propagates
            # immediately. Retrying into a throttled provider would double the
            # pressure on capacity shared with paid interactive chat.
            if name is alternate or not _is_unsupported_param_error(exc, name):
                raise
            logger.info(
                "%s/%s rejected '%s'; retrying with '%s'",
                provider, model, name, alternate,
            )
            continue
        _max_output_param_learned[(provider, model)] = name
        return response


_UNSUPPORTED_PARAM_HINTS = (
    "unsupported", "unrecognized", "not supported", "unknown parameter",
    "invalid parameter", "instead",
)


def _is_unsupported_param_error(exc, param_name):
    """True only for "this endpoint does not take ``param_name``" errors.

    Gated on an HTTP 400 where the SDK exposes one (a 429 is never a parameter
    complaint), and on the parameter name plus an explicit "unsupported"-shaped
    phrase in the message otherwise.
    """
    status = getattr(exc, "status_code", None)
    if status is not None and status != 400:
        return False
    message = str(exc).lower()
    if param_name not in message:
        return False
    return any(hint in message for hint in _UNSUPPORTED_PARAM_HINTS)


def stream_openai_compatible(
    provider, model, messages, timeout=None, max_retries=None,
    max_output_tokens=None, emit_keepalive=False, usage_sink=None,
):
    """Stream text deltas from an OpenAI-compatible provider.

    Matches the historical behavior by default: no ``temperature`` /
    ``max_tokens`` are passed, and the SDK's own timeout/retry defaults apply,
    so existing callers are unchanged. The optional arguments exist for short,
    machine-shaped calls that must be bounded:

    ``timeout``            per-request budget in seconds.
    ``max_retries``        SDK-level retry count (``0`` keeps the budget above
                           from silently multiplying).
    ``max_output_tokens``  hard output cap enforced BY THE PROVIDER. Closing
                           the stream client-side stops us reading; only this
                           stops the provider generating (and billing).
    ``emit_keepalive``     yield ``""`` for chunks that carry no text instead
                           of swallowing them. The SDK's read timeout is an
                           *inactivity* timeout between chunks, not a total
                           deadline -- so a stream of heartbeat/usage/reasoning
                           chunks that never contains text can keep a consumer
                           blocked forever inside this ``for`` loop. Passing
                           ``True`` hands control back to the caller on every
                           chunk so it can enforce its own wall clock. Default
                           ``False`` keeps the historical "text deltas only"
                           contract for every existing caller.
    ``usage_sink``         dict that receives ``"usage"``: the latest
                           :class:`ProviderUsage` the provider reported.
                           Read it through:attr:`ChatStream.usage`, which
                           withholds it until the stream has ended.
    """
    refuse_retired_model(provider, model)
    client = _bind_options(get_client(provider), timeout, max_retries)
    response = _create_capped(
        client, provider, model, messages, max_output_tokens)
    termination_reason = None
    refusal_detected = False
    for chunk in response:
        # HTTP acceptance alone can precede an SSE rejection. Charge an
        # interruption only after the provider emits a generation event.
        if usage_sink is not None:
            usage_sink["provider_started"] = True
        # Some providers emit a final usage-only chunk with an empty
        # ``choices`` list (e.g. when ``stream_options`` is set). Guard against
        # it before indexing so a stray chunk can't raise IndexError, and treat
        # a ``None`` delta/content as "nothing to yield".
        word = None
        if chunk.choices:
            reason = getattr(chunk.choices[0], "finish_reason", None)
            if reason is not None:
                termination_reason = reason
                if usage_sink is not None:
                    usage_sink["terminal_event_received"] = True
        # The usage chunk (`stream_options.include_usage`) arrives last, with
        # empty `choices`; Moonshot instead puts `usage` on the final choice.
        # Every other chunk carries `usage: null`. Keep the latest real one,
        # and call it FINAL once the terminal reason has been seen: nothing
        # the provider bills comes after that (see ChatStream.usage).
        if usage_sink is not None:
            raw_usage = getattr(chunk, "usage", None)
            if raw_usage is None and chunk.choices:
                raw_usage = _field(chunk.choices[0], "usage")
            if raw_usage is not None:
                normalized = _openai_compatible_usage(provider, raw_usage)
                if normalized is not None:
                    usage_sink["usage"] = normalized
                    usage_sink["final"] = termination_reason is not None
        if chunk.choices:
            choice = chunk.choices[0]
            delta = choice.delta
            if getattr(delta, "refusal", None):
                # Chat Completions carries refusal as a delta field, not as a
                # finish_reason. Preserve it as a non-completing terminal
                # signal even when the final finish_reason is the ordinary
                # "stop" value.
                refusal_detected = True
            word = getattr(delta, "content", None) if delta is not None else None
        if word:
            yield word
        elif emit_keepalive:
            yield ""
    # The refusal delta is a semantic outcome, not an end-of-stream event;
    # keep the completion incomplete until the provider supplies its finish
    # reason. Preserve the refusal marker when that terminal event arrives.
    return (
        "refusal"
        if refusal_detected and termination_reason is not None
        else termination_reason
    )


def _stream_anthropic(
    model, messages, timeout=None, max_retries=None, max_output_tokens=None,
    emit_keepalive=False, usage_sink=None,
):
    """Stream text deltas from Anthropic's Messages API.

    System messages are split out and concatenated into a single ``system``
    string; the remaining user/assistant messages already alternate (first is
    ``user`` once the system messages are removed).

    Anthropic requires ``max_tokens`` on every request; ``max_output_tokens``
    overrides the module default:data:`ANTHROPIC_MAX_OUTPUT` so a caller that
    only wants a few tokens is not exposed to an 8192-token generation.

    ``emit_keepalive`` switches from ``stream.text_stream`` -- which yields TEXT
    ONLY -- to the event iterator, yielding ``""`` for every non-text event, so
    a caller enforcing its own wall clock gets a turn between them. What that
    does and does not buy, checked against the pinned ``anthropic==0.120.2``
    rather than assumed (the first version of this comment claimed pings and
    was wrong; the codex adversarial review caught it):

    * ``thinking_delta`` and the structural events (``message_start``,
      ``content_block_start/stop``, ``message_delta``) DO reach here, so a long
      extended-thinking phase -- the usual reason an Anthropic stream is quiet
      for minutes -- now hands control back on every chunk. ``text_stream``
      swallows all of them.
    * ``ping`` events do NOT: ``anthropic._streaming.Stream.__stream__`` drops
      them (``if sse.event == "ping": continue``) before ``MessageStream`` sees
      them. A stream that emits nothing but pings therefore still blocks here,
      resetting the SDK's inactivity timeout as it goes. That is unchanged from
      before this parameter existed, and it is one of the things the SSE
      transport in  §3.2 removes rather than patches.
    """
    client = _bind_options(get_client(ANTHROPIC), timeout, max_retries)

    system_parts = [
        m["content"] for m in messages if m.get("role") == "system" and m.get("content")
    ]
    system = "\n\n".join(system_parts)
    convo = [m for m in messages if m.get("role") != "system"]

    with client.messages.stream(
        model=model,
        max_tokens=max_output_tokens or ANTHROPIC_MAX_OUTPUT,
        system=system,
        messages=convo,
    ) as stream:
        termination_reason = None
        start_usage = None
        for event in stream:
            if usage_sink is not None:
                usage_sink["provider_started"] = True
            # `content_block_delta` carries the visible tokens; a `text_delta`
            # has `.text`, a `thinking_delta` does not and must not be
            # accumulated (it is reasoning, not the answer). Everything else --
            # message_start/stop, content_block_start/stop, message_delta --
            # yields the empty keepalive so the caller gets its turn.
            text = ""
            if getattr(event, "type", None) == "message_start":
                start_usage = _field(getattr(event, "message", None), "usage")
            if getattr(event, "type", None) == "message_delta":
                delta = getattr(event, "delta", None)
                reason = getattr(delta, "stop_reason", None)
                if reason is not None:
                    termination_reason = reason
                    if usage_sink is not None:
                        usage_sink["terminal_event_received"] = True
                # Cumulative, thinking included. Billing reads it
                # only once the stream has ended: see ChatStream.usage.
                if usage_sink is not None:
                    normalized = _anthropic_usage(
                        start_usage, getattr(event, "usage", None))
                    if normalized is not None:
                        usage_sink["usage"] = normalized
                        usage_sink["final"] = reason is not None
            if getattr(event, "type", None) == "content_block_delta":
                delta = getattr(event, "delta", None)
                text = getattr(delta, "text", "") or ""
            if text or emit_keepalive:
                yield text
        return termination_reason


def _stream_chat(
    ai_model, messages, timeout=None, max_retries=None, max_output_tokens=None,
    emit_keepalive=False, usage_sink=None,
):
    """Yield provider-agnostic text and return the terminal reason.

    ``ai_model`` is an:class:`~dj.apps.openai.models.AIModel` (or any object
    exposing ``.provider`` and ``.model``). Yields plain text delta strings so
    callers never touch provider-specific chunk shapes.

    All three optional arguments default to ``None``, which reproduces the
    historical behaviour exactly, so interactive chat generation is unchanged.
    They exist for short, machine-shaped calls such as
    :func:`f2z.ai.language.detect_language`:

    ``timeout``            per-request budget in **seconds**, instead of the
                           SDK default of many minutes -- so a hung provider
                           connection cannot pin a background worker.
    ``max_retries``        SDK-level retry count; ``0`` stops a nominal
                           ``timeout`` from silently spanning several attempts.
    ``max_output_tokens``  provider-enforced output cap. Abandoning the stream
                           client-side only stops us *reading*; this is what
                           stops the provider *generating* -- the difference
                           between an aborted 8-token reply and a billed
                           128k-token one when a hostile document talks the
                           model into writing an essay.
    ``emit_keepalive``     yield ``""`` on text-less chunks so the caller can
                           enforce a wall clock even while the provider is
                           sending anything that is not text. Honoured by every
                           provider, but see:func:`_stream_anthropic` for
                           exactly how far it reaches there -- the SDK drops
                           ``ping`` events before this module can see them.
    """
    provider = getattr(ai_model, "provider", OPENAI) or OPENAI
    model = ai_model.model
    refuse_retired_model(provider, model, getattr(ai_model, "provider_model_id", ""))

    # LAST LINE OF DEFENCE for the availability flag. Every caller
    # already filters on ``is_enabled`` -- the chat views, zPage translation,
    # language detection -- and each of those produces a far better error than
    # this one. This exists because ``stream_chat`` is the one function that
    # turns an ``AIModel`` ROW into an outbound request carrying user content,
    # and a flag meaning "we may not send content here" is only true if it is
    # checked at that point. A path added later that forgets to filter fails
    # loudly here instead of quietly shipping a prompt to a vendor whose terms
    # we refused.
    #
    # SCOPE, honestly: this gates catalogue-driven traffic and nothing else.
    # Several endpoints call the OpenAI SDK directly against a HARDCODED model
    # id and never consult ``AIModel`` at all -- ``PromptView`` (legacy
    # completions), ``ImageView``, ``dj.apps.storytime``,
    # ``dj.apps.uploads.models``, and the moderation/tagging helpers in
    # ``f2z.openai.util``. Disabling every OpenAI row would NOT stop those.
    # Bringing them under the flag means giving them catalogue rows, which is
    # a real piece of work and not this change; 's per-provider
    # disclosure needs it and should carry it. Flagged by the codex
    # adversarial review.
    #
    # TWO checks, and the ORDER is the point.
    #
    # The provider check first, because it does NOT read the row. `AIModel.save`
    # forces a banned provider's rows off, but `save()` is not the only way a
    # row is written: `QuerySet.update()` and `bulk_create()` both skip it, so a
    # stray `AIModel.objects.filter(provider="kimi").update(is_enabled=True)` --
    # a data migration, a management command, a psql session -- would otherwise
    # re-open a vendor we have refused, with no reviewed code change anywhere.
    # It also does not care whether the row in hand is stale: the policy list is
    # process state, so an admin flip that lands mid-request is seen here even
    # though the loaded `is_enabled` is not. This is what makes the sentence
    # "we do not send content to Kimi" true rather than merely intended.
    #
    # The per-row check second, for the ordinary case: a model an operator
    # switched off for their own reasons, on a provider that is otherwise fine.
    # ``getattr`` default ``True``: ``ai_model`` is documented as "any object
    # exposing.provider and.model", and a duck-typed caller must not be newly
    # broken by a column it has never heard of.
    #
    # Both found by the codex adversarial review.
    reason = policy_disabled_reason(provider)
    if reason is not None:
        raise ModelDisabled(
            f"AI provider {provider!r} is disabled by policy; refusing to send "
            f"content to {provider}/{model}. Reason: {reason}"
        )

    if not getattr(ai_model, "is_enabled", True):
        raise ModelDisabled(
            f"AI model {provider}/{model} is disabled (AIModel.is_enabled is "
            f"False); refusing to send content to it."
        )

    if provider in OPENAI_COMPATIBLE:
        return (yield from stream_openai_compatible(
            provider, model, messages, timeout=timeout,
            max_retries=max_retries, max_output_tokens=max_output_tokens,
            emit_keepalive=emit_keepalive, usage_sink=usage_sink,
        ))
    elif provider == ANTHROPIC:
        return (yield from _stream_anthropic(
            model, messages, timeout=timeout, max_retries=max_retries,
            max_output_tokens=max_output_tokens,
            emit_keepalive=emit_keepalive, usage_sink=usage_sink,
        ))
    else:
        raise ValueError(f"Unknown AI provider: {provider!r}")


def stream_chat(
    ai_model, messages, timeout=None, max_retries=None, max_output_tokens=None,
    emit_keepalive=False,
):
    """Provider-agnostic text iterator with optional terminal metadata.

    Existing callers still iterate over exactly the same plain string deltas.
    Once exhausted, ``stream.termination_reason`` contains the provider's
    native finish/stop reason, or ``None`` when no terminal reason was
    observed. The provider check and request remain lazy, as they were when
    this function returned a generator.

    ``stream.usage`` is the provider's own:class:`ProviderUsage` once the
    stream has ended, or ``None``. It is what bills hidden reasoning:
    the yielded text never contains it.
    """
    usage_sink = {}
    return ChatStream(_stream_chat(
        ai_model, messages, timeout=timeout, max_retries=max_retries,
        max_output_tokens=max_output_tokens, emit_keepalive=emit_keepalive,
        usage_sink=usage_sink,
    ), usage_sink=usage_sink)
