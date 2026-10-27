import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass
from fractions import Fraction
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal, InvalidOperation

from django.db import models
from django.contrib.auth import get_user_model

import tiktoken

from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync

from taggit.managers import TaggableManager
from taggit.models import Tag, TaggedItem

from dj.apps.comments.models import UUIDTaggedItem

from f2z.ai.providers import (
    ANTHROPIC,
    PROVIDER_CHOICES,
    POLICY_DISABLED_PROVIDERS,
    OPENAI,
    RETIRED_OPENAI_MODEL_IDS,
    model_is_retired,
    configured_providers,
    reasoning_policy,
)
from .cache_pricing import cache_price_fractions, max_input_price_fraction

User = get_user_model()

logger = logging.getLogger(__name__)


def _provider_input_cost(
    provider, model, input_price, input_tokens, *, cached_input_tokens=0,
    cache_write_tokens=0, cache_write_1h_tokens=0,
):
    """Calculate provider input cost from model fields and disjoint subsets."""
    counts = (cached_input_tokens, cache_write_tokens,
              cache_write_1h_tokens)
    if (any(isinstance(n, bool) or not isinstance(n, int) or n < 0
            for n in counts)
            or sum(counts) > input_tokens):
        counts = (0, 0, 0)
    fractions = cache_price_fractions(provider, model)
    input_cost = Decimal(input_tokens) * Decimal(str(input_price))
    for count, (numerator, denominator) in zip(counts, fractions):
        rate_delta = (
            Decimal(numerator) / Decimal(denominator) - Decimal(1)
        )
        input_cost += (
            Decimal(count) * Decimal(str(input_price)) * rate_delta
        )
    return input_cost


# TWO NUMBERS, AND THE NAMES ARE HISTORY. `max_output_tokens` is 's
# column and it holds the RESERVE -- the slice of the context window
# `build_messages` keeps free for the answer, i.e. the shortest reply a
# maximally packed conversation is still guaranteed room for. The largest
# reply the model can produce lives in `max_response_tokens`.
#
# The obvious tidy-up -- rename the old column to `output_token_reserve` -- is
# a rolling-deploy trap, and the codex adversarial review caught it twice.
# `manage.py migrate` runs BEFORE the new pods roll, so pods on the old image
# would either SELECT a column that no longer exists (a 500 on every AIModel
# access, i.e. the model picker and the whole chat) or read a repurposed one
# with values that mean something else. Adding a column and leaving
# `max_output_tokens` untouched is the only shape where an old pod behaves
# EXACTLY as it does today and a code rollback is a no-op. The rename belongs
# in a later contract-phase PR, once no pod reads the old meaning.

# Fallback RESERVE for a row whose ``max_output_tokens`` is unset, zero or
# negative (an operator-added row, or one that escaped the data migration).
DEFAULT_OUTPUT_TOKEN_RESERVE = 4096

# Fallback CEILING for a row whose ``max_response_tokens`` is unset, zero or
# negative. Deliberately modest: a row nobody has characterised should not
# license the longest generation on the fleet. Never zero and never ``None`` --
# for the three OpenAI-compatible providers a missing cap means the provider
# generates (and bills) without any ceiling at all ( §3.2).
DEFAULT_MAX_RESPONSE_TOKENS = 8192

# Maximum inactivity between gateway stream events. The gateway's independent
# absolute call deadline is 300s; an idle timeout may never outlive it.
DEFAULT_IDLE_TIMEOUT_MS = 60_000
MAX_IDLE_TIMEOUT_MS = 300_000

# Floor for the per-request output cap. A prompt that cannot be trimmed any
# further (a single oversized turn) squeezes the cap down to whatever the
# context window has left; below this there is no useful answer left to give,
# so stop squeezing and let the provider be the one to refuse.
MIN_REQUEST_OUTPUT_TOKENS = 256

# ---------------------------------------------------------------------------
# Bounds on the interactive chat's provider call ( §3.2 flagged that both
# `timeout` and `max_retries` were unset here). None of these is an output cap:
# how long a reply the user asked for is decided by admission, above. These
# bound how long ONE sync gunicorn worker can be held, which is an availability
# question, not a 2Z one.
# ---------------------------------------------------------------------------

# Per-request provider timeout, in SECONDS. Both SDKs pass this to their
# HTTPX transport (httpx2 for openai>=3; httpx for anthropic<1), where
# for a streamed response it behaves as an INACTIVITY timeout -- the gap
# between chunks -- not a total deadline. Deliberately generous: a reasoning
# model can be silent for the best part of a minute before its first visible
# token, and turning that into a 503 would be a worse bug than the one this
# fixes. Without it the SDK default (10 minutes, openai) outlives the wall the
# request dies against anyway, so a hung connection held a sync worker until
# gunicorn killed it ( §3.2 flagged `timeout`/`max_retries` as unset).
AI_CHAT_TIMEOUT_SECONDS = 120

# SDK-level retries, and ZERO on purpose. Retries happen before the first
# chunk, i.e. while `generate` is blocked inside `next(stream)` and cannot
# check its own wall clock -- so every allowed retry multiplies the inactivity
# timeout above. At the SDK default of 2 a stalled provider can hold this
# worker for 3 x 120s before the deadline gets its first turn, which is past
# nginx's 200s window and most of the way to gunicorn's 600s. One attempt means
# the worst case before the first chunk is one timeout. The cost is that a
# genuinely flaky connect answers 503 instead of quietly succeeding on the
# second try; for an interactive request the human retries, and a retry that
# outlives the proxy was never going to reach them anyway. Found by the codex
# adversarial review.
AI_CHAT_MAX_RETRIES = 0

# TOTAL wall clock for one generation, in SECONDS. NOT an output cap -- how
# long a reply this request asked for is settled by admission, and the full
# number is still what the provider is told. This is about who can still
# receive the answer.
#
# `/api` inherits `proxy_read_timeout 200s` from the server block in
# k8s/free2z/nginx.conf, and gunicorn writes no bytes until the generation
# finishes. So at 200s nginx hands the client a 504 while the worker carries on
# generating -- and then persists and charges for an answer the HTTP caller
# never received. Stopping at 170s keeps the reply inside the window that can
# still be delivered, and the partial answer is returned and charged for the
# tokens actually produced.
#
# It also bounds how long ONE sync gunicorn worker  is held, which is the
# availability half of uncapping the reply length. The check below can only run
# when the iterator returns, so the worst case is this deadline plus one
# inactivity window -- 170 + 120 = 290s, with AI_CHAT_MAX_RETRIES = 0 keeping
# that at ONE window rather than one per attempt. Still well inside gunicorn's
# `--timeout 600`, and comfortably better than the 600s a stalled stream could
# hold a worker for before this change. It does NOT fit inside nginx's 200s in
# that stalled case: a client who has already been handed a 504 is the price of
# not killing the worker, and it is what SSE ( §3.2) actually fixes.
#
# THIS, not our pricing, is what now limits a single very long reply: ~170s of
# streaming is roughly 10k-20k tokens at observed rates. Raising it means
# raising the nginx window too, which is a deliberate availability decision
# about how long one of five workers may be held -- and the actual fix is the
# SSE transport in  §3.2, which stops a long generation holding a sync
# worker at all. Neither is taken unilaterally here.
AI_CHAT_DEADLINE_SECONDS = 170

# Per-token live-stream WebSocket push timeout, in SECONDS.
# The WebSocket push is an OPTIONAL best-effort side-channel. `group_send`
# makes multiple sequential Redis round trips (group membership check +
# channel sends), and a slow or stalling Redis must not hold the sync
# gunicorn worker for seconds on each word. Bounding each push to 0.5s ensures
# a hung push is aborted promptly, live token streaming is disabled for the
# remainder of this generation, and the authoritative HTTP response continues
# accumulating.
AI_LIVE_STREAM_PUSH_TIMEOUT_SECONDS = 0.5


@dataclass(frozen=True)
class GenerationResult:
    """Visible result plus the token count used for settlement.

    Iteration preserves the four-value ``generate_reply`` API, including usage.
    When final provider usage is absent, settlement uses the same visible-text
    estimate as the response; an authorization ceiling is not treated as proof
    of provider consumption.
    """

    response_text: str
    input_tokens: int
    output_tokens: int
    settlement_output_tokens: int
    usage: object = None

    def __iter__(self):
        yield self.response_text
        yield self.input_tokens
        yield self.output_tokens
        yield self.usage

    def __len__(self):
        return 4

    def __getitem__(self, index):
        return (self.response_text, self.input_tokens, self.output_tokens, self.usage)[index]


class GenerationInterrupted(RuntimeError):
    """Provider stream failure after the provider returned its stream."""

    def __init__(self, cause, *, response_text, input_tokens,
                 settlement_output_tokens, usage):
        super().__init__(str(cause))
        self.provider_started = True
        self.response_text = response_text
        self.input_tokens = input_tokens
        self.settlement_output_tokens = settlement_output_tokens
        self.usage = usage
        self.__cause__ = cause


def _interrupted_output_tokens(ai_model, response, usage, *, label="interrupted generation"):
    """Use final provider usage or the observable estimate on interruption.

    The admission ceiling bounds what the provider can cost us, but it is not
    evidence that the provider consumed that whole amount. When an interrupted
    stream has no final usage, charge the same visible-text estimate as any
    other stream without usage; the existing reasoning-unmetered warning makes
    hidden provider usage visible for operations without passing it through to
    the user as presumed consumption.
    """
    if usage is not None:
        return int(usage.output_tokens)
    return billable_output_tokens(
        ai_model, None, response, label=label)


async def _bounded_group_send(
    channel_layer, group, message, timeout=AI_LIVE_STREAM_PUSH_TIMEOUT_SECONDS
):
    """Send with a bound verified against the pinned Redis stack in CI.

    ``wait_for`` includes cancellation cleanup time.  The real-Redis regression
    test in ``apps/events/tests/test_ws_consumer.py`` therefore pauses Redis and
    verifies that channels_redis/redis-py cancellation remains prompt.
    """
    await asyncio.wait_for(
        channel_layer.group_send(group, message),
        timeout=timeout,
    )


def _get_encoding(model="gpt-3.5-turbo"):
    """Best-effort tiktoken encoding.

    Non-OpenAI model names (Anthropic / xAI / Kimi) have no tiktoken mapping,
    so fall back to ``cl100k_base``. Returns ``None`` if tiktoken can't produce
    any encoding (callers then approximate with ``len(text) // 4``), so token
    trimming keeps working for every provider.
    """
    # The provider assigns these newer GPT families the o200k vocabulary,
    # while older installed tiktoken releases can either reject them or
    # match an overly broad legacy prefix. Keep tokenization aligned with the
    # provider contract even before tiktoken learns each model identifier.
    if model.startswith(("gpt-6-", "gpt-6.", "gpt-5.6-")):
        try:
            return tiktoken.get_encoding("o200k_base")
        except Exception:
            return None
    try:
        return tiktoken.encoding_for_model(model)
    except Exception:
        try:
            return tiktoken.get_encoding("cl100k_base")
        except Exception:
            return None


def num_tokens_from_text(text, model="gpt-3.5-turbo"):
    encoding = _get_encoding(model)
    if encoding is None:
        return len(text) // 4
    return len(encoding.encode(text))


#The encodings every budget count is taken over, whatever the model: both
#are baked into the image (``utils.warm_tiktoken_cache.REQUIRED_ENCODINGS``).
#A count that is the MAX over them is an upper bound for any model that
#uses either, which is every OpenAI model we sell; for the others it is the
#same conservative stand-in ``cl100k_base`` was, never looser.
BUDGET_ENCODINGS = ("cl100k_base", "o200k_base")


def _budget_encodings(model):
    """The model's own encoding (when tiktoken knows it) plus
    :data:`BUDGET_ENCODINGS`, deduplicated, as encoding objects."""
    names = []
    try:
        names.append(tiktoken.encoding_name_for_model(model))
    except Exception:
        pass
    names.extend(n for n in BUDGET_ENCODINGS if n not in names)
    encodings = []
    for name in names:
        try:
            encodings.append(tiktoken.get_encoding(name))
        except Exception:
            continue
    return encodings


def count_prompt_tokens(messages, model):
    """The input-token count the CONTEXT BUDGET is checked against.

    Deliberately the maximum over the model's encoding and
    :data:`BUDGET_ENCODINGS`, not the single model-mapped count. The budget
    is a billing boundary on long-context-tiered models (: a prompt the
    provider counts past 272K is billed at 2x for the whole request), and a
    single tokenizer can UNDERCOUNT the provider's: ``" className " * 1000``
    is 2000 tokens in ``cl100k_base`` and 3000 in ``o200k_base`` (codex
    review of ), more than the x1.15 margin absorbs. The cost of the
    max is a slightly earlier trim on ordinary prose; the alternative is a
    reproducible undercharge.
    """
    encodings = _budget_encodings(model)
    if not encodings:
        return num_tokens_from_messages(messages, model)
    return max(_num_tokens_with(encoding, messages) for encoding in encodings)


def _num_tokens_with(encoding, messages):
    num_tokens = 0
    for message in messages:
        num_tokens += 4
        for key, value in message.items():
            num_tokens += len(encoding.encode(value))
            if key == "name":
                num_tokens += 1
    return num_tokens + 2


def num_tokens_from_messages(messages, model="gpt-3.5-turbo"):
    # https://learn.microsoft.com/en-us/azure/cognitive-services/openai/how-to/chatgpt?pivots=programming-language-chat-completions#managing-conversations
    encoding = _get_encoding(model)
    num_tokens = 0
    for message in messages:
        # every message follows <im_start>{role/name}\n{content}<im_end>\n
        num_tokens += 4
        for key, value in message.items():
            if encoding is None:
                num_tokens += len(value) // 4
            else:
                num_tokens += len(encoding.encode(value))
            if key == "name":
                # OpenAI's documented chat framing adds one token per name.
                num_tokens += 1
    num_tokens += 2  # every reply is primed with <im_start>assistant
    return num_tokens


class Personality(models.Model):
    """
    A system message that is used to prime the AI.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    creator = models.ForeignKey(
        User, on_delete=models.CASCADE,
        # TODO: user-defined personalities
        related_name='personalities',
        null=True, blank=True,
    )
    display_name = models.CharField(max_length=200)
    system_message = models.TextField()
    is_public = models.BooleanField(default=False)

    class Meta:
        ordering = ['display_name']
        verbose_name_plural = "Personalities"

    def __str__(self) -> str:
        return self.display_name


# ---------------------------------------------------------------------------
# Gateway catalogue vocabulary. The values are zuu f2z-ai-proto's
# ``ApiStyle`` (serde snake_case) verbatim, so a row serializes into the
# signed catalogue without translation.
# ---------------------------------------------------------------------------
API_STYLE_OPENAI_RESPONSES = "openai_responses"
API_STYLE_OPENAI_CHAT = "openai_chat"
API_STYLE_ANTHROPIC_MESSAGES = "anthropic_messages"
API_STYLES = (
    API_STYLE_OPENAI_RESPONSES,
    API_STYLE_OPENAI_CHAT,
    API_STYLE_ANTHROPIC_MESSAGES,
)
API_STYLE_CHOICES = [
    (API_STYLE_OPENAI_RESPONSES, "OpenAI Responses"),
    (API_STYLE_OPENAI_CHAT, "OpenAI Chat Completions (and compatible)"),
    (API_STYLE_ANTHROPIC_MESSAGES, "Anthropic Messages"),
]

# ``controls.effort_levels`` vocabulary (zuu#1170): every ``reasoning_effort``
# level a provider documents, in increasing effort. The gateway's request wire
# takes only minimal/low/medium/high today; a signed level it cannot express
# (``xhigh``, ``none``, ``max``) is inert there, so a model page's full list
# may be signed now. ``dj.apps.pricing.catalog.EFFORT_LEVELS`` is the same set.
REASONING_EFFORT_LEVELS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")


def validate_reasoning_effort_levels(value):
    """``AIModel.reasoning_effort_levels``: a list of DISTINCT strings from
    :data:`REASONING_EFFORT_LEVELS` (empty = no list signed). Refused at the
    admin rather than at signing time, where a bad list would only exclude
    the model from the catalogue."""
    from django.core.exceptions import ValidationError

    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ValidationError("reasoning_effort_levels must be a list of strings")
    unknown = [v for v in value if v not in REASONING_EFFORT_LEVELS]
    if unknown:
        raise ValidationError(
            f"unknown reasoning_effort level(s) {unknown}; allowed: "
            f"{', '.join(REASONING_EFFORT_LEVELS)}")
    if len(set(value)) != len(value):
        raise ValidationError("reasoning_effort_levels repeats a level")


# 60 s. A reasoning model can be silent for most of a minute before its first
# visible token (see AI_CHAT_TIMEOUT_SECONDS below); a tighter TTFB turns
# that into a failed call.
DEFAULT_TTFB_TIMEOUT_MS = 60_000
# x1.15 on a stand-in tokenizer's count (the crate's worked example). Only
# sizes a hold; the charge settles from provider-reported usage.
DEFAULT_SAFETY_FACTOR_BPS = 11_500


def api_style_for_provider(provider: str) -> str:
    """What each provider is reached through today (``f2z.ai.providers``):
    Anthropic's Messages API, and Chat Completions for OpenAI and the
    OpenAI-compatible xAI / Kimi."""
    if provider == ANTHROPIC:
        return API_STYLE_ANTHROPIC_MESSAGES
    return API_STYLE_OPENAI_CHAT


class AIModelQuerySet(models.QuerySet):
    """The two catalogue predicates, named once instead of open-coded.

    Every place that decides "may this row be used" goes through one of these,
    so turning a model off is a single flag flip rather than an audit of every
    ``filter(is_ga=True)`` in the tree.
    """

    def enabled(self):
        """Rows free2z is currently permitted to send ANY content to.

        The availability gate. See:attr:`AIModel.is_enabled`.

        Two predicates, for the same reason ``stream_chat`` has two: the
        column is what an operator controls, and the policy list is what a
        reviewed code change controls. ``AIModel.save`` keeps them agreeing,
        but ``QuerySet.update()`` and ``bulk_create()`` skip ``save()``, so a
        stray write could leave a banned provider's row with
        ``is_enabled=True``. Excluding the provider here means such a row never
        reaches the catalogue and no conversation can be started, patched or
        forked onto it -- without this, the outbound guard would still stop the
        content, but only after the user had been handed a conversation that
        503s on every prompt. Found by the codex adversarial review.
        """
        return self.filter(is_enabled=True).exclude(
            provider__in=list(POLICY_DISABLED_PROVIDERS)
        ).exclude(
            models.Q(provider=OPENAI) & (
                models.Q(model__in=RETIRED_OPENAI_MODEL_IDS)
                | models.Q(provider_model_id__in=RETIRED_OPENAI_MODEL_IDS)
            )
        )

    def configured(self):
        """Rows whose provider has an API key in THIS process.

        Availability derived from configuration rather than asserted by a
        checkbox. Prod advertised three Claude and two Grok models as GA and
        enabled with no Anthropic or xAI key anywhere, so every prompt to them
        503'd -- the  "configured but dead" class on a public API. The
        key is read per call (no caching), so adding one to the Secret and
        rolling the pods is all it takes for the rows to reappear.
        """
        return self.filter(provider__in=sorted(configured_providers()))

    def discovered(self, upstream=True):
        """Rows whose id the PROVIDER ITSELF lists as available -- the
        upstream id the gateway sends (``upstream=True``, the catalogue) or
        the ``model`` Django's own chat sends (``upstream=False``).

        The fourth availability predicate ( follow-up, "programmatic
        discovery"). ``manage.py discover_ai_models`` records each configured
        provider's ``GET /v1/models`` answer in:class:`ProviderModel`; a row
        is discovered when that table holds its provider and
        :attr:`AIModel.upstream_model_id` with ``missing_since`` unset.

        FAIL-OPEN UNTIL THE FIRST SNAPSHOT, PER PROVIDER. A provider with no
        recorded listing at all (discovery has never succeeded for it: the
        release that introduced the table has not been followed by a run yet,
        or the provider's key arrived minutes ago) is not gated -- its rows
        behave exactly as before this predicate existed. Once ONE snapshot
        exists the gate is strict: a model the provider stopped listing
        leaves the catalogue and the picker at the next build, and a row an
        operator adds for a model the provider does not list is never sold.
        A FAILED discovery run writes nothing, so a provider outage or a
        broken cron keeps the last known answer rather than emptying the
        shelf (the CronJob's own failure alert is the signal for that).
        """
        from django.db.models import Case, Exists, F, OuterRef, When

        # Gate each execution path on the id IT sends (codex review of
        # ): the gateway sends ``provider_model_id`` (a pinned snapshot
        # when set), Django's own chat sends ``model``. A row pinned to a
        # withdrawn snapshot must stop the gateway and not Django, and the
        # reverse.
        if upstream:
            sent_id = Case(
                When(provider_model_id="", then=F("model")),
                default=F("provider_model_id"),
            )
        else:
            sent_id = F("model")
        listed = ProviderModel.objects.filter(
            provider=OuterRef("provider"),
            provider_model_id=OuterRef("sent_id"),
            missing_since__isnull=True,
        )
        snapshot = ProviderModel.objects.filter(provider=OuterRef("provider"))
        return self.annotate(sent_id=sent_id).filter(
            ~Exists(snapshot) | Exists(listed)
        )

    def selectable(self):
        """Rows a user may pick for a new conversation.

        Enabled AND in the lineup AND callable AND listed by the provider:
        ``is_enabled`` is the policy gate, ``is_ga`` is the product one,
        ``configured()`` is the deployment's, ``discovered()`` is the
        provider's, and a row needs all four to reach the picker (and
        ``GET /api/ai/models/``, whose queryset this is).
        """
        return self.enabled().configured().discovered(upstream=False).filter(is_ga=True)


class ProviderModel(models.Model):
    """One model id a provider's own ``GET /v1/models`` listed, with when.

    Written only by ``manage.py discover_ai_models`` (``dj.apps.openai.
    discovery``), read by:meth:`AIModelQuerySet.discovered` -- the signed
    gateway catalogue and the chat picker both go through it -- and shown in
    the admin so a human can see what a key can reach that nobody has priced.

    ``provider_model_id`` is the id exactly as the provider lists it, which is
    what:attr:`AIModel.upstream_model_id` must equal to be sold. A row is
    never deleted by discovery: a model the provider stops listing gets
    ``missing_since`` set (and cleared again if it comes back), so the history
    of what was reachable when stays readable.
    """

    provider = models.CharField(max_length=32, choices=PROVIDER_CHOICES)
    provider_model_id = models.CharField(max_length=200)
    first_seen_at = models.DateTimeField(
        help_text="The first discovery run that listed this id.")
    last_seen_at = models.DateTimeField(
        help_text="The latest discovery run that listed this id.")
    missing_since = models.DateTimeField(
        null=True, blank=True,
        help_text=(
            "Set by the first run that no longer listed the id; NULL while the "
            "provider lists it. A row with this set is not sold."
        ),
    )
    availability_changed_at = models.DateTimeField(
        help_text=(
            "When this id last flipped between listed and missing (set on "
            "first sight, on going missing, and on coming back). The signed "
            "catalogue's content revision reads this, not last_seen_at, so a "
            "run that changes nothing mints no version and a return within "
            "the same minute still does."
        ),
    )
    metadata = models.JSONField(
        default=dict, blank=True,
        help_text="The provider's own listing entry (e.g. created, owned_by).")

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["provider", "provider_model_id"],
                name="openai_providermodel_unique",
            ),
        ]
        ordering = ["provider", "provider_model_id"]

    def __str__(self) -> str:
        state = "missing" if self.missing_since else "listed"
        return f"{self.provider}/{self.provider_model_id} ({state})"


class AIModel(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    provider = models.CharField(
        max_length=32,
        choices=PROVIDER_CHOICES,
        default="openai",
        help_text="Which AI provider serves this model.",
    )
    model = models.CharField(max_length=200, help_text="Provider model name / id")
    display_name = models.CharField(max_length=200)
    system_message = models.TextField(help_text="Default system message")
    max_tokens = models.IntegerField(
        help_text=(
            "TOTAL context window: prompt AND reply are charged against this "
            "one number by every provider, so build_messages() trims the "
            "prompt to max_tokens - max_output_tokens and the reply is "
            "clamped to whatever the window has left."
        ),
    )
    max_output_tokens = models.IntegerField(
        default=DEFAULT_OUTPUT_TOKEN_RESERVE,
        help_text=(
            "RESERVE, despite the name (kept so a rolling deploy never sees a "
            "column change meaning under it): output tokens held back from "
            "the context window when trimming the prompt. This is the "
            "SHORTEST reply a maximally packed conversation is still "
            "guaranteed room for -- NOT a cap on the reply. The longest reply "
            "is max_response_tokens. Raising this gives long conversations "
            "more room to answer and less room to remember."
        ),
    )
    max_response_tokens = models.IntegerField(
        default=DEFAULT_MAX_RESPONSE_TOKENS,
        help_text=(
            "The LONGEST single reply this model will produce -- the "
            "provider's own documented output limit. It is the ceiling on the "
            "output length a request may ask for (max_output_tokens in the "
            "request body) and the default when a request asks for nothing in "
            "particular, clamped to what the context window has left and to "
            "what the requester's 2Z cover. Count reasoning tokens in here "
            "too: on models that bill them, they consume the same budget. "
            "Setting it above what the provider accepts earns a 400 on the "
            "requests that reach for it."
        ),
    )
    is_ga = models.BooleanField(
        default=False,
        help_text=(
            "Lineup / product decision: does this row appear in the chat "
            "picker? A retired or preview model is is_ga=False. Paths that "
            "are not the picker deliberately ignore it -- zPage translation "
            "resolves its model from settings, not from GA. For 'we must not "
            "send content here at all', use is_enabled."
        ),
    )
    is_enabled = models.BooleanField(
        default=True,
        help_text=(
            "AVAILABILITY KILL SWITCH: may free2z route any content to this "
            "model? This is a policy decision about the provider's terms, not "
            "a product one, so unlike is_ga it gates EVERY path -- the public "
            "catalogue, starting a conversation, forking one, generating a "
            "reply, zPage translation, and language detection. Turning it off "
            "deletes nothing: conversations already on the model stay "
            "readable, and turning it back on restores the model exactly as "
            "it was. EXCEPTION: rows whose provider is listed in "
            "f2z.ai.providers.POLICY_DISABLED_PROVIDERS are forced off on "
            "every save and cannot be re-enabled here -- lifting a "
            "vendor-terms decision is a reviewed code change, not a checkbox."
        ),
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    order = models.IntegerField(default=0)

    # The Cost PER TOKEN
    # GPT35
    #               Input               Output
    # 4K context	$0.0015 / 1K tokens	$0.002 / 1K tokens
    # 16K context	$0.003 / 1K tokens	$0.004 / 1K tokens
    # GPT4
    # Model         Input               Output
    # 8K context	$0.03 / 1K tokens	$0.06 / 1K tokens
    # 32K context	$0.06 / 1K tokens	$0.12 / 1K tokens
    input_price = models.DecimalField(
        max_digits=10,
        decimal_places=9,
        default="0.0000015",
        help_text="The cost per token for input. E.g., $0.0015 / 1K tokens means $0.0000015 per token."
    )
    output_price = models.DecimalField(
        max_digits=10,
        decimal_places=9,
        default="0.000002",
        help_text="The cost per token for output. E.g., $0.002 / 1K tokens means $0.000002 per token."
    )
    markup = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=1,
        help_text="The multiplier that we charge above our cost. Default: at cost"
    )

    # --- Gateway catalogue fields  -------------------------------
    # Read by the signed model catalogue the f2z-ai gateway prices from
    # (zuu f2z-ai-proto ``CatalogModel``); NOTHING in Django reads them yet,
    # so Django's own chat keeps sending ``model`` upstream exactly as before.
    # Every one has a DATABASE default: ``migrate`` runs before the new pods
    # roll, and an old pod creating a row in the admin must not hit a NOT
    # NULL it has never heard of. Prices are NOT here -- they live on the
    # immutable, versioned ``pricing.RateCardModel``.
    #
    # Two catalogue members deliberately have no column of their own, because
    # a second copy of a number Django already relies on would drift from it:
    # ``context_window`` IS ``max_tokens`` and ``max_output_tokens`` (the
    # catalogue's ceiling) IS ``max_response_tokens`` -- see the
    # ``context_window`` / ``catalogue_max_output_tokens`` properties.
    provider_model_id = models.CharField(
        max_length=200,
        blank=True,
        default="",
        db_default="",
        help_text=(
            "The provider's own model id the GATEWAY sends upstream, when it "
            "differs from `model` (e.g. a dated snapshot). Blank = same as "
            "`model`. Django's own chat path still sends `model`."
        ),
    )
    api_style = models.CharField(
        max_length=32,
        blank=True,
        default="",
        db_default="",
        choices=[
            ("", "Derived from provider"),
            *API_STYLE_CHOICES,
        ],
        help_text=(
            "Upstream API shape the gateway speaks to this model. Blank = "
            "derived from `provider` (anthropic -> anthropic_messages, "
            "everything else -> openai_chat)."
        ),
    )
    ttfb_timeout_ms = models.PositiveIntegerField(
        default=DEFAULT_TTFB_TIMEOUT_MS,
        db_default=DEFAULT_TTFB_TIMEOUT_MS,
        help_text=(
            "Gateway time-to-first-byte timeout, in MILLISECONDS. Generous by "
            "default: a reasoning model can be silent for most of a minute."
        ),
    )
    idle_timeout_ms = models.PositiveIntegerField(
        default=DEFAULT_IDLE_TIMEOUT_MS,
        db_default=DEFAULT_IDLE_TIMEOUT_MS,
        help_text=(
            "Maximum gateway stream silence, in MILLISECONDS. Defaults to 60s "
            "for models that emit keepalives; never above the gateway's 300s "
            "absolute call deadline. Increase for silent-reasoning models."
        ),
    )
    safety_factor_bps = models.PositiveIntegerField(
        default=DEFAULT_SAFETY_FACTOR_BPS,
        db_default=DEFAULT_SAFETY_FACTOR_BPS,
        help_text=(
            "Tokenizer safety factor for the gateway's input ESTIMATE, in "
            "basis points (11500 = x1.15). Never below 10000: it may only "
            "scale an estimate up. A charge always settles from provider "
            "usage, never from this."
        ),
    )

    # Explicit audited provider/model capabilities for the signed gateway
    # catalogue. No model-name inference or seed auto-enablement. The gateway
    # still intersects these declarations with its implemented safe features.
    # (structured_output's reviewed rows are declared by name in migration
    # 0024, tools/strict_tools' in 0027 -- explicit audited declarations, not
    # inferences.)
    supports_tools = models.BooleanField(
        default=False,
        db_default=False,
        help_text=(
            "Signed gateway policy: this exact provider/model supports tool "
            "definitions and tool-result history. Enable only after reviewed "
            "provider evidence and adapter verification; never inferred from its name."
        ),
    )
    supports_vision = models.BooleanField(
        default=False,
        db_default=False,
        help_text=(
            "Signed gateway policy: this exact provider/model supports image "
            "input. Enable only after reviewed evidence. The gateway must also "
            "implement safe image estimation before advertising vision."
        ),
    )
    supports_reasoning = models.BooleanField(
        default=False,
        db_default=False,
        help_text=(
            "Signed gateway policy: this exact provider/model reports reasoning "
            "usage. Enable only after reviewed provider evidence and adapter verification."
        ),
    )
    supports_structured_output = models.BooleanField(
        default=False,
        db_default=False,
        help_text=(
            "Signed gateway policy: this exact provider/model honours a strict "
            "JSON-schema `response_format` (structured output). Always signed "
            "explicitly, true or false: the gateway reads an ABSENT member as "
            "'catalogue silent' and applies its own interim rule, so false is "
            "a real refusal. Enable only after reviewed provider evidence; the "
            "gateway still requires an adapter that can express it."
        ),
    )

    supports_strict_tools = models.BooleanField(
        default=False,
        db_default=False,
        help_text=(
            "Signed gateway policy: this exact provider/model honours "
            "`strict: true` on a function tool (provider-enforced argument "
            "schemas). Always signed explicitly, true or false: the gateway "
            "reads an ABSENT member as 'catalogue silent' and applies its own "
            "interim rule, so false is a real refusal. Meaningless without "
            "supports_tools. Enable only after reviewed provider evidence."
        ),
    )

    supports_reasoning_effort = models.BooleanField(
        default=False,
        db_default=False,
        help_text=(
            "Signed gateway policy: this exact provider/model takes the "
            "provider's `reasoning_effort` control (zuu#1170). Signed "
            "explicitly, true or false; NOT implied by supports_reasoning. "
            "Enable only after reviewed provider evidence."
        ),
    )
    reasoning_effort_levels = models.JSONField(
        default=list,
        db_default=[],
        blank=True,
        validators=[validate_reasoning_effort_levels],
        help_text=(
            "Signed `controls.effort_levels`: the reasoning_effort levels this "
            "model documents (e.g. [\"low\", \"medium\", \"high\"]). Signed only "
            "while supports_reasoning_effort is on; empty = no list, so the "
            "gateway forwards any level and the provider refuses one it does "
            "not take (uncharged). List them from the model page."
        ),
    )

    objects = AIModelQuerySet.as_manager()

    class Meta:
        # ordering = ['display_name']
        ordering = ['-order']
        constraints = [
            models.CheckConstraint(
                condition=models.Q(safety_factor_bps__gte=10000),
                name='openai_aimodel_safety_factor_gte_1',
            ),
            models.CheckConstraint(
                condition=models.Q(ttfb_timeout_ms__gte=1),
                name='openai_aimodel_ttfb_timeout_positive',
            ),
            models.CheckConstraint(
                condition=(models.Q(idle_timeout_ms__gte=1)
                           & models.Q(idle_timeout_ms__lte=MAX_IDLE_TIMEOUT_MS)),
                name='openai_aimodel_idle_timeout_ms_range',
            ),
            models.CheckConstraint(
                condition=models.Q(api_style__in=['', *API_STYLES]),
                name='openai_aimodel_api_style_known',
            ),
        ]

    def clean(self):
        super().clean()
        # Field validators are skipped for "empty" values on a blank=True
        # field, so `{}` or `""` would pass the admin and then exclude the
        # whole model at signing time (codex round 2). Re-check here:
        # only a list (``[]`` = no list) is accepted.
        from django.core.exceptions import ValidationError

        try:
            validate_reasoning_effort_levels(self.reasoning_effort_levels)
        except ValidationError as exc:
            raise ValidationError({"reasoning_effort_levels": exc.messages}) from None

    def __str__(self) -> str:
        return self.display_name

    def save(self, *args, **kwargs):
        """Force ``is_enabled=False`` for a policy-disabled provider.

        The column defaults to ``True``, which is right for every provider we
        have not declined — and exactly wrong for one we have. An operator
        adding ``kimi-k4`` in the Django admin would tick ``is_ga``, leave the
        availability box at its default, and publish a model of a vendor whose
        terms we refused; the one-shot data migration cannot see a row created
        after it ran. So the policy list is enforced on every write instead of
        only at seed time, and the flag fails CLOSED for a listed provider.
        Found by the codex adversarial review.

        Deliberately not overridable from the admin: lifting a ToS judgement
        is a reviewed code change (remove the entry from
        ``providers.POLICY_DISABLED_PROVIDERS``), not a checkbox. ``update()``
        on a queryset still bypasses this, as it bypasses every ``save()`` —
        the guard is for the paths humans and application code use.
        """
        if self.provider in POLICY_DISABLED_PROVIDERS and self.is_enabled:
            self.is_enabled = False
            update_fields = kwargs.get("update_fields")
            if update_fields is not None:
                # Otherwise the correction is computed and then not written.
                kwargs["update_fields"] = set(update_fields) | {"is_enabled"}
        # Keep both legacy readers and the signed catalog closed to retired
        # aliases/snapshots, including an operator-created upstream pin.
        if model_is_retired(self.provider, self.model, self.provider_model_id):
            self.is_enabled = False
            self.is_ga = False
            update_fields = kwargs.get("update_fields")
            if update_fields is not None:
                kwargs["update_fields"] = set(update_fields) | {"is_enabled", "is_ga"}
        # Every save stamps `updated_at`, partial ones included. auto_now only
        # writes it when it is IN update_fields, and the signed AI catalogue's
        # version is derived from max(updated_at): a
        # save(update_fields=["is_enabled"]) kill switch that left the stamp
        # alone would reach a running gateway only at the next hourly
        # re-issue. Found by the codex review of.
        update_fields = kwargs.get("update_fields")
        if update_fields:  # [] stays a no-op save (Django skips it)
            kwargs["update_fields"] = set(update_fields) | {"updated_at"}
        return super().save(*args, **kwargs)

    # --- catalogue views of existing columns  ---------------------

    @property
    def upstream_model_id(self) -> str:
        """The catalogue's ``provider_model_id``: the override, else ``model``."""
        return self.provider_model_id or self.model

    @property
    def effective_api_style(self) -> str:
        """The catalogue's ``api_style``: the override, else by provider."""
        return self.api_style or api_style_for_provider(self.provider)

    @property
    def context_window(self) -> int:
        """The catalogue's ``context_window``. ``max_tokens`` already holds the
        TOTAL window (see its help text); one number, not two that drift."""
        return self.max_tokens

    @property
    def catalogue_max_output_tokens(self) -> int:
        """The catalogue's ``max_output_tokens`` (the model's output CEILING),
        which in Django is ``max_response_tokens`` -- NOT the legacy
        ``max_output_tokens`` column, which holds the reserve."""
        return self.get_max_response_tokens()

    # The Django chat charge remains cost-plus from this model row. Cache
    # multipliers live in cache_pricing.py and are shared with the immutable
    # rate-card seed; Django does not depend on the gateway's active card.
    def get_tuzi_price(
        self, input_tokens: int, output_tokens: int, *,
        cached_input_tokens: int = 0, cache_write_tokens: int = 0,
        cache_write_1h_tokens: int = 0,
    ) -> int:
        """Price provider-reported input classes without counting any token twice.

        ``input_tokens`` is the total input count; cache counts are disjoint
        subsets. Invalid/overlapping cache details safely fall back to pricing
        the total at the ordinary input rate.
        """
        input_cost = _provider_input_cost(
            self.provider, self.model, self.input_price, input_tokens,
            cached_input_tokens=cached_input_tokens,
            cache_write_tokens=cache_write_tokens,
            cache_write_1h_tokens=cache_write_1h_tokens,
        )
        total_cost = (
            input_cost + Decimal(output_tokens) * Decimal(str(self.output_price))
        ) * 100 * Decimal(str(self.markup))
        return int(total_cost.to_integral_value(rounding=ROUND_CEILING))

    def get_provider_input_cost(
        self, input_tokens: int, *, cached_input_tokens: int = 0,
        cache_write_tokens: int = 0, cache_write_1h_tokens: int = 0,
    ) -> Decimal:
        """Provider input cost in USD using disjoint prompt categories."""
        return _provider_input_cost(
            self.provider, self.model, self.input_price, input_tokens,
            cached_input_tokens=cached_input_tokens,
            cache_write_tokens=cache_write_tokens,
            cache_write_1h_tokens=cache_write_1h_tokens,
        )

    def get_output_token_reserve(self) -> int:
        """Output tokens held back from the context window when trimming.

        Never returns ``None`` or a non-positive number: a row with a missing
        or nonsense reserve falls back to
        :data:`DEFAULT_OUTPUT_TOKEN_RESERVE`.

        Never returns more than the model can actually produce either. The
        ceiling is the number a provider will reject; the reserve is only how
        much context we decline to fill, so when the two disagree the CEILING
        wins and the reserve gives way. The earlier draft had this backwards --
        an operator correctly setting ``max_response_tokens=4096`` for a model
        whose real limit is 4096, while the legacy reserve still said 8192,
        would have had 8192 sent to the provider and every ordinary request on
        that model turn into a 503. Found by the codex adversarial review.
        """
        reserve = self.max_output_tokens or 0
        if reserve <= 0:
            reserve = DEFAULT_OUTPUT_TOKEN_RESERVE
        return max(1, min(reserve, self.get_max_response_tokens()))

    def get_max_response_tokens(self) -> int:
        """The longest reply this model will produce, in tokens.

        Never returns ``None`` or a non-positive number. ``None`` is the value
        that must never reach ``stream_chat``: for openai / xai / kimi it means
        no provider-side ceiling at all, which is an unbounded charge and an
        unbounded hold on a sync worker ( §3.2). A row with a missing or
        nonsense value falls back to:data:`DEFAULT_MAX_RESPONSE_TOKENS`.

        Deliberately independent of the reserve: this number is a statement
        about what the provider accepts, and nothing we configure on our side
        may raise it.
        """
        limit = self.max_response_tokens or 0
        if limit <= 0:
            limit = DEFAULT_MAX_RESPONSE_TOKENS
        return limit

    def get_input_token_budget(self) -> int:
        """How many prompt tokens ``build_messages`` may pack.

        ``max_tokens`` holds the model's TOTAL context window for every seeded
        row (128k for gpt-4o, 200k for the Claudes, 400k for the gpt-5.6
        family), and the providers charge the prompt and the completion against
        that one window: OpenAI answers a 400 when
        ``prompt + max_completion_tokens`` exceeds it. So the prompt budget
        holds:meth:`get_output_token_reserve` back (the `max_output_tokens`
        column -- see the note at the top of this module). Found by the codex
        adversarial review of.

        The reserve, deliberately, is NOT the model's full output ceiling. It
        is the shortest reply a maximally packed conversation is guaranteed
        room for; the reply is separately clamped to whatever the window
        actually has left (:meth:`get_request_output_cap`), so trimming stays
        independent of how long a reply this particular request asked for. If
        the ceiling were reserved instead, raising a model's
        ``max_response_tokens`` from 16k to 128k would silently amputate 112k
        tokens of every conversation's memory.

        Never returns less than 1: a row whose reserve exceeds its context
        window is a misconfiguration, and answering it with a nonsensical
        budget is worse than answering it with a tiny one.
        """
        return max(1, self.max_tokens - self.get_output_token_reserve())

    def get_request_output_cap(self, input_tokens: int, requested=None) -> int:
        """The output cap sent to the provider for one specific request.

        ``requested`` is the caller's ``max_output_tokens`` (the request body
        field), or ``None`` for "as much as this model can give". Either way
        the answer is a real number -- "uncapped" is never sent, because for
        openai / xai / kimi that means the provider generates and bills without
        any ceiling.

        Two clamps, both of which exist to avoid a provider 400 rather than to
        ration anything:

        * the model's own ceiling (:meth:`get_max_response_tokens`) -- asking
          gpt-4o for 100 000 output tokens is a 400, surfaced to the user as
          "this model isn't available right now", which is a lie;
        * the room left in the context window -- prompt and reply share
          ``max_tokens``. This is what covers the case the reserve cannot: a
          single turn too large to trim, where there is nothing to drop but the
          system message and the turn itself. The cap gives way instead, down
          to:data:`MIN_REQUEST_OUTPUT_TOKENS`.

        Together they are also why an operator typo (``81920`` for ``8192``)
        can never produce an impossible request. Its *effect on 2Z* is bounded
        separately, by admission: a longer reply is simply a larger number the
        requester has to hold first.
        """
        ceiling = min(self.get_max_response_tokens(),
                      self.max_tokens - input_tokens)
        ceiling = max(MIN_REQUEST_OUTPUT_TOKENS, ceiling)
        if requested is None:
            return ceiling
        # A request for a SHORT reply is honoured exactly: someone who wants
        # two sentences should not be charged the ceiling to get them.
        return max(1, min(int(requested), ceiling))

    def get_max_tuzi_price(self, input_tokens: int, output_tokens=None) -> int:
        """The largest charge one request on this model can produce.

        The prompt is already assembled when this is called, so
        ``input_tokens`` is exact; the only unknown is the length of the reply,
        and that is bounded because the SAME ``output_tokens`` is handed to the
        provider as a hard cap. It prices every input token at the highest
        configured cache class, so this is a genuine ceiling for the request,
        not an estimate. The two must not drift apart: pricing a longer reply than we ask
        for over-charges the entry bar, pricing a shorter one re-opens the hole
         closed.

        ``output_tokens=None`` prices the model's default (unrestricted)
        reply for that prompt.

        Derived from the model's own columns on purpose: adding a model or
        repricing one in the admin moves the ceiling with it. A hardcoded floor
        cannot track eleven models across four providers, which is exactly how
        a 100-2Z floor ended up guarding a 300-2Z request ( §3.1).

        "Genuine ceiling" holds only where the cap bounds reasoning too. xAI's
        does not, so the chat endpoints admit with:meth:`get_admission_price`,
        which adds the reasoning allowance. This method stays the
        price of the prompt and the visible cap.
        """
        if output_tokens is None:
            output_tokens = self.get_request_output_cap(input_tokens)
        fractions = cache_price_fractions(self.provider, self.model)
        # Compare the rates as rational values. Tuple ordering would rank
        # (5, 4) above (2, 1) and under-reserve Anthropic one-hour writes.
        highest = max(
            range(len(fractions)),
            key=lambda index: Fraction(*fractions[index]),
        )
        cache_counts = [0, 0, 0]
        cache_counts[highest] = input_tokens
        return self.get_tuzi_price(
            input_tokens, output_tokens,
            cached_input_tokens=cache_counts[0],
            cache_write_tokens=cache_counts[1],
            cache_write_1h_tokens=cache_counts[2],
        )

    def get_reasoning_allowance(self) -> int:
        """Reasoning tokens a request is admitted for beyond its output cap.

        Zero for every provider whose output cap already bounds reasoning
        (OpenAI, Anthropic). For xAI the cap covers visible output only, so
        reasoning is unbounded by anything we send. The allowance is
        what the requester's ceiling covers on top of it. The values live in
        :data:`f2z.ai.providers.REASONING_POLICIES`, a reviewed code table and
        not a column, so no migration is needed to tune it.
        """
        return max(0, int(reasoning_policy(
            self.provider, self.model).allowance_tokens))

    def get_admission_price(self, input_tokens: int, output_tokens=None) -> int:
        """The ceiling a request is ADMITTED, held and clamped at.

        :meth:`get_max_tuzi_price` for the visible ``output_tokens`` sent as
        the provider's cap, plus:meth:`get_reasoning_allowance`. For a
        provider whose cap bounds reasoning the two are the same number. For
        xAI, the cap does not bound reasoning, and pricing only the cap made
        the clamp hand every reasoning token past it to the platform: a
        requester naming 256 output tokens was admitted at about 1 2Z for a
        reply whose reasoning cost us 18x that. The allowance moves typical
        reasoning back onto the requester. Only reasoning past it is still
        absorbed, and it is logged as ``ai_charge_clamped`` and alerted on.

        Both chat endpoints admit with this, and the charge is clamped to it.
        Nothing else may substitute:meth:`get_max_tuzi_price`, or the two
        drift into different guarantees.
        """
        if output_tokens is None:
            output_tokens = self.get_request_output_cap(input_tokens)
        return self.get_max_tuzi_price(
            input_tokens, int(output_tokens) + self.get_reasoning_allowance())

    def get_affordable_output_tokens(self, input_tokens: int, tuzis) -> int:
        """The longest reply ``tuzis`` covers, for a prompt of ``input_tokens``.

        This is what makes "no cap" safe rather than reckless.  handed
        every request the same fixed per-model cap and refused anyone who could
        not hold its price; the effect was that a 2Z-rich user got no more than
        a 2Z-poor one, and a user just under the line got nothing at all. Here
        the length of the reply is instead the largest one the requester
        already covers -- so the answer scales with what they hold, and the
        pre-flight check below can still be an exact ceiling.

        Solves ``get_admission_price(input_tokens, out) <= tuzis`` for ``out``
        using the most expensive configured input class:

            (in*max_input_rate + out*op) * 100 * markup <= tuzis
            out <= (tuzis / (100*markup) - in*max_input_rate) / op

        ``get_tuzi_price`` rounds UP to a whole 2Z, so the usable budget is
        ``floor(tuzis)``: a holding of 100.500 covers a price of 100 and not
        101, and ``Creator.tuzis`` really is a 3-decimal-place column. Solving
        against the un-floored number picks a length whose raw price is
        100.4985, which ``ceil`` turns into 101 -- over the line, and only by
        a rounding step the correction loop below cannot walk back, so the
        request 402s when a slightly shorter one would have gone through.
        Found by the codex adversarial review.

        Decimal throughout, then a short correction loop, because
        ``get_tuzi_price`` returns a whole-2Z ceiling: rounding must never
        leave this one token OVER the line. It is a hint, not a guarantee --
        ``PromptResponseViewSet.create`` re-prices whatever cap it ends up with
        and is the only thing that admits the request.

        Returns 0 when the prompt alone is already over what they hold.
        """
        try:
            budget = Decimal(tuzis).to_integral_value(rounding=ROUND_FLOOR)
        except (TypeError, ValueError, InvalidOperation):
            return 0
        scale = Decimal(100) * Decimal(self.markup)
        if scale <= 0:
            # Free by configuration; the model's own ceiling is the only bound.
            return self.get_max_response_tokens()
        numerator, denominator = max_input_price_fraction(
            self.provider, self.model)
        worst_input_price = (
            Decimal(str(self.input_price)) * Decimal(numerator)
            / Decimal(denominator)
        )
        remaining = budget - (
            Decimal(input_tokens) * worst_input_price * scale)
        if remaining <= 0:
            return 0
        per_token = Decimal(self.output_price) * scale
        if per_token <= 0:
            return self.get_max_response_tokens()
        out = int(remaining / per_token)
        # Float/Decimal disagreement is a couple of ULPs, so this settles
        # immediately; the bound stops a pathological price turning it into a
        # long loop, and being one token optimistic is harmless because
        # admission re-prices the result anyway.
        for _ in range(4):
            if out <= 0 or self.get_max_tuzi_price(input_tokens, out) <= tuzis:
                break
            out -= 1
        # Admission prices the reasoning allowance on top of the visible cap
        # (:meth:`get_admission_price`), so the reply length those 2Z cover is
        # whatever is left once the allowance is paid for.
        return max(0, out - self.get_reasoning_allowance())


def generate_reply(ai_model, messages, input_tokens, max_output_tokens=None, *,
                   channel_group=None, stream_id=None, label="prompt"):
    """Stream one reply from ``ai_model`` for ``messages`` and accumulate it.

    The single generation loop behind:meth:`Conversation.generate` and the
    metered prompt endpoint. ``messages`` is the exact provider payload
    and ``input_tokens`` its already-computed size: the prompt priced by the
    caller's admission check must be the prompt sent, so neither is recomputed
    here.

    ``max_output_tokens`` is the length of reply the request was ADMITTED
    against. It must be the same number the caller priced, or admission guarded
    a different request than the one we pay for. ``None`` means "this caller
    has no opinion" and falls back to the model's default for this prompt; it
    is resolved to a real integer here, never passed down, because
    ``stream_chat(max_output_tokens=None)`` is exactly the unbounded-generation
    hole  closed.

    ``channel_group`` names the Channels group that receives each delta as it
    arrives (the conversation WebSocket). ``None`` skips the push entirely --
    a bare prompt has no live listener -- and never touches the channel layer.

    Returns a tuple-compatible:class:`GenerationResult` containing
    ``(response_text, input_tokens, output_tokens, usage)``. Provider input
    counts replace the model-specific estimate when present. **Writes nothing** and
    MUST NOT be called inside ``transaction.atomic()`` (issue
    ): it spends 10-90s inside a third-party network call, and holding a
    database transaction open across it leaves a Cloud SQL connection ``idle
    in transaction`` for the whole generation.
    """
    from f2z.ai.providers import stream_chat

    # `max_output_tokens` is NOT optional and must never be dropped. For
    # the three OpenAI-compatible providers, omitting it meant no
    # provider-side cap at all ( §3.2): abandoning the stream on our
    # side stops us *reading*, never the provider *generating and billing*.
    # Anthropic was accidentally the only bounded one, at the module
    # default of 8192. It is also what makes the view's pre-flight ceiling
    # a real ceiling rather than a hopeful one.
    if max_output_tokens is None:
        max_output_tokens = ai_model.get_request_output_cap(input_tokens)
    max_output_tokens = int(max_output_tokens)
    if max_output_tokens <= 0:
        # Belt and braces: 0 is falsy and would reach the SDK as "no cap"
        # on the Anthropic adapter's `or ANTHROPIC_MAX_OUTPUT` and as a
        # 400 elsewhere. Neither is a sane answer to a caller bug.
        max_output_tokens = MIN_REQUEST_OUTPUT_TOKENS

    # TODO: we should put this in a task queue?
    # stream_chat yields provider-agnostic text delta strings; the actual
    # provider (OpenAI / Anthropic / xAI / Kimi) is selected from the model.
    #
    # `timeout` / `max_retries` were both unset here ( §3.2), so a
    # provider that accepted the connection and then went quiet held this
    # sync worker on the SDK's own multi-minute default. `emit_keepalive`
    # hands control back on chunks that carry no text, which is what lets
    # the wall clock below run even while the provider is only sending
    # heartbeats. None of the three is an output cap.
    stream = stream_chat(
        ai_model, messages,
        max_output_tokens=max_output_tokens,
        timeout=AI_CHAT_TIMEOUT_SECONDS,
        max_retries=AI_CHAT_MAX_RETRIES,
        emit_keepalive=True,
    )

    # The live-token WebSocket push is an OPTIONAL side-channel. On the
    # deployed API pods ``get_channel_layer()`` can return ``None`` (the
    # Channels layer isn't wired into that request context), and even when
    # present a ``group_send`` can fail. Neither must ever abort the HTTP
    # reply: ``response`` (the accumulated deltas) is the authoritative
    # answer returned to the client. So keep the push strictly best-effort
    # and always keep accumulating.
    channel_layer = get_channel_layer() if channel_group is not None else None
    response = ""
    provider_started = False
    deadline_interrupted = False
    incomplete_stream = False
    deadline = time.monotonic() + AI_CHAT_DEADLINE_SECONDS
    try:
        for word in stream:
            # Reaching an iterator item proves the provider stream started,
            # including adapters/test doubles with no explicit metadata.
            provider_started = True
            # See AI_CHAT_DEADLINE_SECONDS. Stop BEFORE gunicorn's
            # --timeout 600 kills the worker, so the caller still gets to
            # persist and charge for what was produced instead of the
            # request being a total loss that we alone pay for.
            if time.monotonic() >= deadline:
                logger.warning(
                    "AI generation for %s hit the %ss wall "
                    "clock with %d characters produced; returning the "
                    "partial reply (see #1033 §3.2 -- the streaming "
                    "transport is what removes this ceiling)",
                    label, AI_CHAT_DEADLINE_SECONDS, len(response),
                )
                deadline_interrupted = True
                break
            if not word:
                continue
            if channel_layer is not None:
                try:
                    event = {
                        'type': 'send_word',
                        'message': word,
                    }
                    if stream_id is not None:
                        event['stream_id'] = stream_id
                    async_to_sync(_bounded_group_send)(
                        channel_layer,
                        channel_group,
                        event,
                        timeout=AI_LIVE_STREAM_PUSH_TIMEOUT_SECONDS,
                    )
                except Exception:
                    # A missing/failed channel layer must never abort the
                    # reply. Log once-ish and stop trying to push for the
                    # rest of this stream, but keep building the full
                    # response.
                    logger.warning(
                        "WebSocket group_send failed for %s; "
                        "continuing without live token streaming",
                        label,
                        exc_info=True,
                    )
                    channel_layer = None
            response += word
        incomplete_stream = (
            not deadline_interrupted
            and bool(getattr(stream, "exhausted", False))
            and getattr(stream, "termination_reason", None) is None
        )
        if incomplete_stream and not provider_started:
            raise RuntimeError("Provider stream ended before generation began")
    except Exception as exc:
        usage = getattr(stream, "usage", None)
        # A terminal event completes the answer independently of whether the
        # later usage chunk arrives. Preserve it on trailing transport errors;
        # pricing uses authoritative usage when present, otherwise estimates.
        if usage is not None or getattr(stream, "terminal_event_received", False):
            output_tokens = billable_output_tokens(
                ai_model, usage, response, label=label)
            return GenerationResult(
                response,
                billable_input_tokens(ai_model, usage, input_tokens, label=label),
                output_tokens, output_tokens, usage)
        provider_started = provider_started or bool(
            getattr(stream, "provider_started", False))
        if provider_started:
            raise GenerationInterrupted(
                exc,
                response_text=response,
                input_tokens=billable_input_tokens(ai_model, usage, input_tokens, label=label),
                settlement_output_tokens=_interrupted_output_tokens(
                    ai_model, response, usage, label=label),
                usage=usage,
            ) from exc
        raise
    finally:
        # Release the HTTP connection deterministically on the deadline
        # break (and on any exception) instead of waiting for the
        # generator to be garbage collected.
        close = getattr(stream, "close", None)
        if close is not None:
            try:
                close()
            except Exception:
                logger.warning(
                    "closing the provider stream for %s failed",
                    label, exc_info=True,
                )

    usage = getattr(stream, "usage", None)
    input_tokens = billable_input_tokens(ai_model, usage, input_tokens, label=label)
    if incomplete_stream:
        cause = RuntimeError(
            "Provider stream ended before a terminal completion event")
        raise GenerationInterrupted(
            cause,
            response_text=response,
            input_tokens=billable_input_tokens(ai_model, usage, input_tokens, label=label),
            settlement_output_tokens=_interrupted_output_tokens(
                ai_model, response, usage, label=label),
            usage=usage,
        ) from cause
    output_tokens = billable_output_tokens(
        ai_model, usage, response, label=label)
    settlement_output_tokens = output_tokens

    return GenerationResult(
        response, input_tokens, output_tokens, settlement_output_tokens, usage)


def billable_input_tokens(ai_model, usage, estimated_tokens, *, label="prompt"):
    """The provider's prompt count, or a model-specific local estimate."""
    value = getattr(usage, "input_tokens", None) if usage is not None else None
    if (isinstance(value, int) and not isinstance(value, bool) and value >= 0):
        return value
    if usage is not None:
        logger.warning(
            "provider usage for %s on %s/%s had no valid input token count; "
            "using the model-encoding estimate (%d tokens)",
            label, getattr(ai_model, "provider", "?"),
            getattr(ai_model, "model", "?"), estimated_tokens,
        )
    return estimated_tokens


def billable_output_tokens(ai_model, usage, response, *, label="prompt"):
    """The output tokens a reply is CHARGED for.

    ``usage`` is the provider's own:class:`f2z.ai.providers.ProviderUsage`
    for the finished stream. When there is one, its ``output_tokens`` is the
    answer: that is what the provider bills us, and it includes the hidden
    reasoning / thinking a reasoning model spends before (and between) the
    visible words -- xAI grok reasons on high by default, OpenAI's reasoning
    families and Anthropic thinking likewise. Counting only the visible
    ``response`` (as this did until ) charged none of that, so every
    reasoning reply was under-billed, often by most of its cost.

    The provider's count is used EXACTLY, never added to a local count of the
    visible text: the visible text is already inside it, and the reasoning is
    already inside it (``ProviderUsage`` normalises the one provider, xAI,
    that reports reasoning beside ``completion_tokens`` instead of in it).

    No ``usage`` -- the wall clock cut the stream, the provider rejected
    ``stream_options``, or a stand-in stream in a test -- falls back to the
    historical estimate of the visible reply. That still under-counts any
    reasoning, and it is logged so the gap is visible rather than silent.
    """
    if usage is not None:
        return int(usage.output_tokens)
    visible = num_tokens_from_text(response, ai_model.model)
    allowance = 0
    if isinstance(ai_model, AIModel):
        allowance = ai_model.get_reasoning_allowance()
    if allowance > 0:
        # A model whose output cap does not bound its reasoning, and
        # we cannot see how much it reasoned: the clamp never binds on the
        # visible estimate, so `ai_charge_clamped` would stay silent while
        # the provider bills reasoning we did not charge. Counted instead.
        logger.warning(json.dumps(
            reasoning_unmetered_payload(ai_model, visible, label),
            separators=(",", ":")))
    else:
        logger.info(
            "no provider usage for %s on %s/%s; charging the visible-text "
            "estimate (%d tokens), which cannot see reasoning tokens",
            label, getattr(ai_model, "provider", "?"),
            getattr(ai_model, "model", "?"), visible,
        )
    return visible


#``jsonPayload.event`` of the line:func:`billable_output_tokens` writes when
#a model with a reasoning allowance finishes with no provider usage.
#Contract with ``monitoring/log-metrics/ai-reasoning-unmetered.json``.
AI_REASONING_UNMETERED_EVENT = "ai_reasoning_unmetered"


def reasoning_unmetered_payload(ai_model, visible_tokens, label):
    """The ``ai_reasoning_unmetered`` line, as a dict.

    The usual cause is the chat wall clock (``AI_CHAT_DEADLINE_SECONDS``)
    cutting a stream before the provider's final usage chunk. A reasoning
    model can spend the whole deadline reasoning. The provider then bills
    that reasoning, and we charge only ``visible_tokens``.
    """
    return {
        "severity": "WARNING",
        "message": (
            f"No provider usage for {label} on {ai_model.provider}/"
            f"{ai_model.model}, whose output cap does not bound its "
            f"reasoning: charged the visible-text estimate "
            f"({visible_tokens} tokens), and any reasoning went unbilled"
        ),
        "event": AI_REASONING_UNMETERED_EVENT,
        "provider": ai_model.provider,
        "model": ai_model.model,
        "label": label,
        "visible_tokens": int(visible_tokens),
        "reasoning_allowance_tokens": ai_model.get_reasoning_allowance(),
    }


class Conversation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    ai_model = models.ForeignKey(AIModel, on_delete=models.CASCADE)
    personality = models.ForeignKey(
        Personality, on_delete=models.CASCADE,
        null=True, blank=True
    )
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    display_name = models.CharField(max_length=200)
    is_public = models.BooleanField(default=False)
    is_subscriber_only = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    prompt_response_set = models.ManyToManyField(
        'openai.PromptResponse', related_name='conversations')

    tags = TaggableManager()

    class Meta:
        ordering = ['-updated_at']

    def __str__(self) -> str:
        return f"{self.user} - {self.ai_model}"

    def get_url(self):
        # SPLIT-BRAIN URL, and deliberately so until classic is deleted: it
        # RESOLVES in the classic UI (still the default) and answers 410 Gone
        # in the new one. Four things still emit it — `AIFeed` and
        # `UserAIFeed` under /feeds/, plus `CommentListSerializer` and
        # `EventSerializer`'s `get_content_url`, so a comment on a conversation
        # and a CHAT2Z spend event carry it into /api/comments/ and
        # /api/events/.
        #
        # Left exactly as it is on purpose. Retiring the emitters ahead of the
        # feature they describe is the tempting mistake: /feeds is proxied to
        # Django for EVERY user agent regardless of the f2z_ui cookie, so a 410
        # there tells every existing RSS subscriber to unsubscribe permanently
        # while classic is still creating and serving the conversations. That
        # is not undoable by rollback. All of this goes together in
        # phase 4. Do not publish this URL anywhere new in the meantime.
        return f"/ai/conversation/{self.id}"

    def build_messages(self, user_input: str):
        """The provider payload for this conversation plus ``user_input``.

        Returns ``(messages, input_tokens)``. Read-only: plain SELECTs against
        the conversation, its personality and its transcript.
        """
        # if the conversation has a personality, use the system message
        # from the personality, else fall back to the model's default system message
        # personality is a FK to Personality so we need to handle
        # the case where it's null
        if self.personality:
            messages = [
                {"role": "system", "content": self.personality.system_message},
            ]
        else:
            messages = [
                {"role": "system", "content": self.ai_model.system_message},
            ]

        for pr in self.prompt_response_set.all():
            messages.append({"role": "user", "content": pr.user_input})
            messages.append(
                {"role": "assistant", "content": pr.response})

        messages.append({"role": "user", "content": user_input})

        # Calculate the number of tokens in the messages
        # we can't use the specific model at the moment
        # KeyError: 'Could not automatically map gpt-3.5-16k to a tokeniser.
        # Please use `tiktok.get_encoding` to explicitly get the tokeniser you expect.'
        budget_tokens = count_prompt_tokens(messages, self.ai_model.model)

        # The budget RESERVES `max_output_tokens` out of the context window
        # -- see AIModel.get_input_token_budget. It is deliberately the
        # RESERVE and not the model's full output ceiling, so how long a reply
        # this particular request asked for never changes how much of the
        # conversation is remembered.
        #
        # `len(messages) > 2` is a termination guard, not an optimisation. The
        # list is [system] + n*[user, assistant] + [current user], so 2 is the
        # floor: neither the system message nor the turn being asked can be
        # dropped. Without it, a single prompt larger than the budget pops the
        # current turn and then raises IndexError on the next pop -- a 503 on
        # what should be a normal (if oversized) request.
        # Trimming is decided on the CONSERVATIVE count (the max over the
        # shipped tokenizers, ``count_prompt_tokens``): the budget is a
        # billing boundary on long-context-tiered models. The count RETURNED
        # -- what admission prices and the charge uses -- stays the legacy
        # single-encoding ``num_tokens_from_messages``, so a prompt is never
        # billed on a tokenizer the model does not use (codex review of
        # ). A caller that must refuse an untrimmable turn or size the
        # output cap re-derives the conservative count itself
        # (``count_prompt_tokens``) and bills on the returned one.
        budget = self.ai_model.get_input_token_budget()
        while budget_tokens > budget and len(messages) > 2:
            # Remove the oldest user and assistant messages from the list
            messages.pop(1)
            messages.pop(1)
            budget_tokens = count_prompt_tokens(messages, self.ai_model.model)

        return messages, num_tokens_from_messages(
            messages, self.ai_model.model)

    def generate(self, user_input: str, messages=None, input_tokens=None,
                 max_output_tokens=None, stream_id=None):
        """Call the provider and accumulate the streamed reply.

        ``messages`` / ``input_tokens`` let a caller that has ALREADY run
        :meth:`build_messages` -- the view does, to price the ceiling before
        admitting the request -- hand the result straight through instead of
        re-assembling and re-tokenizing a prompt of up to 400 000 tokens. Pass
        both or neither; either missing rebuilds. The prompt priced must be the
        prompt sent, or the admission check guards a different request than the
        one we pay for.

        ``max_output_tokens`` is the length of reply this request was ADMITTED
        against -- the number ``PromptResponseViewSet.create`` priced and the
        requester was found to cover. It must be the same number, or admission
        guarded a different request than the one we pay for. ``None`` means
        "this caller has no opinion" and falls back to the model's default for
        this prompt; see:func:`generate_reply`.

        Returns ``(response_text, input_tokens, output_tokens, usage)``. **Writes
        nothing** and MUST NOT be called inside ``transaction.atomic()``
       : this method spends 10-90s inside a third-party network
        call, and holding a database transaction open across it leaves a Cloud
        SQL connection ``idle in transaction`` for the whole generation --
        pinning an xmin, holding back vacuum, and burning a connection slot
        that every monitoring tool reports as idle. The caller persists the
        result and charges for it in a separate, millisecond-long transaction;
        see ``PromptResponseViewSet.create``.

        The streaming loop itself lives in:func:`generate_reply`, shared with
        the conversation-less metered prompt endpoint, so both paths
        get the same output cap handling, wall clock and stream close. This
        method only adds what a conversation has and a bare prompt does not:
        the assembled transcript and the live-token WebSocket group.
        """
        if messages is None or input_tokens is None:
            messages, input_tokens = self.build_messages(user_input)

        return generate_reply(
            self.ai_model, messages, input_tokens, max_output_tokens,
            channel_group=f'conversation_{self.id}',
            stream_id=stream_id,
            label=f"conversation {self.id}",
        )

    def persist_response(self, user_input: str, response: str):
        """Store one completed exchange and attach it to this conversation.

        Both writes -- the ``PromptResponse`` row and the M2M link -- plus the
        caller's ``ledger.debit`` belong in ONE ``transaction.atomic()`` block
       : the user must never end up holding an answer they were
        not charged for, and must never be charged for an answer that did not
        persist. These writes are cheap and lock-free, so they cost that
        transaction microseconds, not a provider round trip.
        """
        prompt_response = PromptResponse.objects.create(
            ai_model=self.ai_model,
            personality=self.personality,
            user=self.user,
            # conversation=self,
            user_input=user_input,
            response=response,
        )
        self.prompt_response_set.add(prompt_response)

        return prompt_response

    def get_content_for_ai_tagging(self):
        content = ""
        for pr in self.prompt_response_set.all()[:5]:
            content += f"{pr.user_input}\n"
        return content[:3000]


class PromptResponseManager(models.Manager):
    """Hides the turns of an account whose self-service deletion is pending
    (``g12f.account_deletion.deletion_pending_q``), wherever they are read:
    a conversation's ``prompt_response_set`` (the M2M manager subclasses
    this one), public transcripts, other members' forks, a new fork's copy,
    and the history sent to the model. Reversible: a keep shows them again;
    the purge deletes them (through ``_base_manager``, which sees all)."""

    def get_queryset(self):
        from dj.apps.g12f.account_deletion import deletion_pending_q

        return super().get_queryset().exclude(deletion_pending_q("user__"))


class PromptResponse(models.Model):

    objects = PromptResponseManager()

    # TODO: remove this field after new code has landed
    conversation = models.ForeignKey(
        Conversation, on_delete=models.CASCADE, related_name='prompt_responses',
        null=True, blank=True,
    )

    # These are added so that each PResp can have a new user/personality
    #eyes:
    user = models.ForeignKey(User, on_delete=models.CASCADE, null=True)
    ai_model = models.ForeignKey(AIModel, on_delete=models.CASCADE, null=True)
    personality = models.ForeignKey(
        Personality, on_delete=models.CASCADE,
        null=True, blank=True
    )

    user_input = models.TextField()
    response = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['created_at']

    def __str__(self) -> str:
        return f"{self.user_input[:20]} - {self.response[:10]}"


def combine_tags(tag_a_name, tag_b_name):
    if tag_a_name == tag_b_name:
        print(f"Skipping {tag_a_name}, {tag_b_name}")
        return
    print(f"CT:: {tag_a_name}, {tag_b_name}")
    try:
        tag_a = Tag.objects.get(name=tag_a_name)
        print(f"Found {tag_a_name}")
    except Tag.DoesNotExist:
        print(f"TagA {tag_a_name} not found")
        return

    try:
        tag_b = Tag.objects.get(name=tag_b_name)
        print(f"Found {tag_b_name}")

        # Get all TaggedItems for tag_b
        tagged_items = TaggedItem.objects.filter(tag=tag_b)
        uuidtagged_items = UUIDTaggedItem.objects.filter(tag=tag_b)

        # Transfer all items from tag_b to tag_a, avoiding duplicates
        for tagged_item in tagged_items:
            # print(tagged_item.content_object, end="")
            content_object = tagged_item.content_object
            if not content_object.tags.filter(name=tag_a_name).exists():
                print("+", end="")
                content_object.tags.add(tag_a)
            else:
                print(".", end="")
            content_object.tags.remove(tag_b)

        for uuidtagged_item in uuidtagged_items:
            # print(uuidtagged_item.content_object, end="")
            content_object = uuidtagged_item.content_object
            if not content_object.tags.filter(name=tag_a_name).exists():
                print("+", end="")
                content_object.tags.add(tag_a)
            else:
                print(".", end="")
            content_object.tags.remove(tag_b)

        # Force the queryset to re-evaluate
        tagged_items = TaggedItem.objects.filter(tag=tag_b)
        uuidtagged_items = UUIDTaggedItem.objects.filter(tag=tag_b)

        # Delete tag_b if it's no longer used
        if not tagged_items.exists() and not uuidtagged_items.exists():
            print("")
            print(f"Deleting {tag_b_name}")
            tag_b.delete()
            print(f"Combined {tag_b_name} into {tag_a_name}")
            return

        print(f"{tag_b_name} still has {tagged_items.count()} items")

    except Tag.DoesNotExist:
        print(f"TagB not found: {tag_b_name}")
    except Exception as err:
        print(f"ERROR: {err}")
        print(f"for {tag_a_name} and {tag_b_name}")
