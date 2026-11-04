import logging
from contextlib import contextmanager
from typing import List

import openai
# from tenacity import retry, wait_random_exponential, stop_after_attempt
from django.conf import settings
from django.contrib.contenttypes.models import ContentType
import tiktoken

from f2z.ai.providers import (
    PROMPT_COMPLETION_ENCODING,
    complete_prompt,
    prompt_completion_model,
)
from dj.apps.g12f.localization import variant_reads_enabled
from dj.apps.jobs.logs import emit_json_line
from dj.apps.g12f.models.zpage import ZPageVariant, zPage
from .models import SearchIndex
from .models import PageContext, Summary


logger = logging.getLogger(__name__)

#The embedding model. Deliberately a constant, NOT an env-overridable
#setting like ``PROMPT_COMPLETION_MODEL``: every stored ``SearchIndex``
#vector lives in this model's space, so pointing new pages at a different
#model would silently mix two incomparable spaces in one cosine index.
#Replacing it is a deploy plus a full re-embed, not a ConfigMap edit.
#``drf_filters.py`` embeds search QUERIES with this same constant: the
#query and the stored vectors must always be in one space.
EMBEDDING_MODEL = "text-embedding-3-small"

#Cloud Logging ``jsonPayload.event`` when OpenAI answers ``404
#model_not_found`` for a model this path calls. Contract with
#``monitoring/alert-policies/ai-model-unavailable.json``; renaming it
#blinds that policy.
AI_MODEL_UNAVAILABLE_EVENT = "ai_model_unavailable"


@contextmanager
def reporting_retired_model(model: str, purpose: str, remedy: str):
    """Say WHICH model is gone when the provider retires one.

    On 2026-09-28 OpenAI retired ``gpt-3.5-turbo-instruct``. Every
    ``search.index_zpage`` then failed with ``404 model_not_found`` for 31
    hours; the only signal was the generic "a job failed" policy, whose email
    names neither the task nor the exception. A retired model is not a
    transient error -- every call fails until someone changes the model -- so
    this emits one structured line naming the model and the fix, which
    ``ai-model-unavailable.json`` pages on at the FIRST occurrence.

    It only reports. The exception is re-raised unchanged, so the job still
    fails, keeps its retry strategy and its job-health accounting; nothing is
    swallowed and no new success path exists.
    """
    try:
        yield
    except openai.NotFoundError as exc:
        if getattr(exc, "code", None) == "model_not_found":
            emit_json_line(
                logger,
                {
                    "event": AI_MODEL_UNAVAILABLE_EVENT,
                    "provider": "openai",
                    "model": model,
                    "purpose": purpose,
                    "remedy": remedy,
                },
                "ERROR",
                f"OpenAI says model {model!r} ({purpose}) does not exist: "
                f"retired or not entitled. {remedy}",
            )
        raise


# One bounded OpenAI client for the whole indexing path.
#
# `openai.completions.create` / `openai.embeddings.create` go through the
# SDK's implicit module-level client, which sets NEITHER timeout NOR
# max_retries, so it takes the SDK defaults: 600s per request and 2 retries.
# search.index_zpage makes two such calls, so its old worst case was
# 2 x 3 x 600 = 3600s of one worker. The reclaim policy now uses that same
# configured client bound plus 240s for task overhead; the shared reclaim
# margin is added separately.
#
# With SEARCH_OPENAI_TIMEOUT_SECONDS (60) and SEARCH_OPENAI_MAX_RETRIES (2)
# the provider-call ceiling is 2 x 3 x 60 = 360s.
# search/tasks.py:INDEX_RETRY is a separate, outer budget and is deliberately
# untouched.
#
# Built lazily and memoised rather than at import time: `OpenAI()` raises
# OpenAIError when no API key is configured, and this module is imported by
# the g12f signal path, so an import-time construction would take down every
# environment without OPENAI_API_KEY (dev shells, unrelated management
# commands) rather than just the indexing task that actually needs a key.
_client = None


def get_openai_client() -> "openai.OpenAI":
    """The bounded, memoised OpenAI client used by the indexing tasks."""
    global _client
    if _client is None:
        _client = openai.OpenAI(
            timeout=settings.SEARCH_OPENAI_TIMEOUT_SECONDS,
            max_retries=settings.SEARCH_OPENAI_MAX_RETRIES,
        )
    return _client


def truncate_text(text: str, max_tokens: int,
                  encoding_name: str = PROMPT_COMPLETION_ENCODING) -> str:
    """
    Truncate the text to a maximum number of tokens.

    Counted in the summary model's tokenizer (``o200k_base`` for
    ``gpt-4o-mini``). This used ``encoding_for_model("gpt-3.5-turbo-instruct")``
    -- ``cl100k_base`` -- until that model was retired; the name is
    passed explicitly so a model tiktoken cannot map is never a ``KeyError``.
    """
    encoding = tiktoken.get_encoding(encoding_name)
    # encode_ordinary: an article that contains the literal text
    # `<|endoftext|>` is text, not a special token; `encode` raises on it.
    tokens = encoding.encode_ordinary(text)
    if len(tokens) > max_tokens:
        print(f"Truncating text from {len(tokens)} tokens to {max_tokens} tokens.")
        truncated_tokens = tokens[:max_tokens]
        return encoding.decode(truncated_tokens)
    return text


template = """
This is the page's data:

```
Title: {title}
Content: {content}
Author: {author}
Tags: {tags}
```

Tell me about the page including the author and title in a single natural paragraph that includes the important vocabulary from the page.
"""
# NOTE: this used langchain's PromptTemplate.from_template, but
# langchain is not in py/requirements/main.txt, so importing this module
# at runtime (now needed by the search.index_zpage task) would crash in
# the deployed image. Plain str.format produces the identical prompt.


def _index_variants(page: zPage):
    """The ``[lang] title\\ncontent`` blocks to embed, source first.

    Reads whichever shape is authoritative ( M5). Under dual write the two
    produce the same strings in the same order -- both tables order by
    ``language`` and the source is pinned first either way -- which is why this
    does NOT need a new task name under 's rollout contract. That contract
    exists so an old worker cannot claim translation-aware work and silently
    index canonical content only, reporting success; here an old worker (flag
    off, or code predating this change) indexes from ``ZPageTranslation`` and
    produces byte-identical input, so there is no "silently worse" outcome for
    a distinct name to protect against. ``search.index_multilingual_zpage``
    keeps its name and its dedicated, critically-monitored queue.

    A page with no source variant -- ``source_language`` still NULL, or drift --
    falls back to the legacy columns rather than dropping the article's own
    text out of its own embedding.
    """
    if variant_reads_enabled():
        rows = list(
            ZPageVariant.objects.filter(zpage_id=page.pk).only(
                "language", "title", "content", "is_published", "origin"
            )
        )
        source = next(
            (row for row in rows if row.origin == ZPageVariant.SOURCE), None
        )
        # `not source.is_published` is the same refusal `_variant_candidates`
        # makes, for the same reason. `_index_zpage` only reaches here for a
        # PUBLISHED page, so a source variant claiming otherwise means the two
        # shapes disagree about publication -- and the mirror row is then text
        # written while they were out of step, possibly the private draft the
        # creator edited before publishing. Embedding it would put that text
        # through a provider call and into a search summary. Use the columns
        # the publication decision was actually made from.
        if source is None or not source.is_published:
            blocks = [f"[{page.source_language}] {page.title}\n{page.content}"]
        else:
            blocks = [
                f"[{source.language}] {source.title}\n{source.content}"
            ]
        blocks.extend(
            f"[{row.language}] {row.title}\n{row.content}"
            for row in sorted(rows, key=lambda item: item.language)
            if row.origin != ZPageVariant.SOURCE and row.is_published
        )
        return blocks

    translations = list(page.translations.filter(is_published=True).only(
        "language", "title", "content"
    ))
    return [
        f"[{page.source_language}] {page.title}\n{page.content}",
        *(
            f"[{item.language}] {item.title}\n{item.content}"
            for item in translations
        ),
    ]


def get_zpage_context(page: zPage):
    """
    Gather all relevant context from the zPage instance.
    """
    variants = _index_variants(page)
    # Give every published language a share of the embedding budget. Truncating
    # one giant canonical-first string would routinely discard every
    # translation on long articles, defeating multilingual discovery.
    per_variant_tokens = max(1, 3500 // len(variants))
    content = "\n\n".join(
        truncate_text(variant, per_variant_tokens) for variant in variants
    )
    context = PageContext(
        title=page.title,
        content=content,
        author=page.creator.username,
        tags=[tag.name for tag in page.tags.all()],
    )
    return context


def generate_summary(context: PageContext) -> Summary:
    """
    Generate a one-paragraph summary with ``PROMPT_COMPLETION_MODEL``.

    Chat Completions, not the legacy Completions API: the latter's only model
    here, ``gpt-3.5-turbo-instruct``, was retired on 2026-09-28 and every
    ``search.index_zpage`` failed with ``404 model_not_found``.
    """
    model = prompt_completion_model()
    with reporting_retired_model(
        model,
        "search summary",
        "Set PROMPT_COMPLETION_MODEL in the free2z ConfigMap to a current "
        "non-reasoning chat model, then restart the free2z web AND worker "
        "Deployments (storytime and /api/openai/prompt use it too).",
    ):
        text = complete_prompt(
            get_openai_client(),
            template.format(**context.model_dump()),
            max_tokens=150,
            model=model,
        )
    return Summary(text=text.strip())


# @retry(wait=wait_random_exponential(min=1, max=20), stop=stop_after_attempt(6))
def generate_vector(summary: Summary) -> List[float]:
    """
    Generate a vector for the summary using OpenAI's embedding API.
    """
    # https://platform.openai.com/docs/guides/embeddings/what-are-embeddings
    with reporting_retired_model(
        EMBEDDING_MODEL,
        "search embedding",
        "Not a ConfigMap change: replacing the embedding model needs a "
        "deploy AND a re-embed of every SearchIndex row; the search query "
        "path (drf_filters.py) shares EMBEDDING_MODEL and must move with it.",
    ):
        response = get_openai_client().embeddings.create(
            input=[summary.text],
            model=EMBEDDING_MODEL,
        )
    return response.data[0].embedding


def update_zpage_search_index(page: zPage, vector: List[float]):
    """
    Create or update the SearchIndex entry for the given zPage.
    """
    content_type = ContentType.objects.get_for_model(page)
    SearchIndex.objects.update_or_create(
        content_type=content_type,
        object_id=page.pk,
        defaults={'vector': vector}
    )


def build_zpage_index(page: zPage) -> Summary:
    """
    The one code path for indexing a single zPage: gather context,
    summarize (OpenAI chat completion), embed (OpenAI embedding), and upsert
    the SearchIndex row. Used by both the index_public_zpages backfill
    command and the search.index_zpage task.
    """
    context = get_zpage_context(page)
    summary = generate_summary(context)
    vector = generate_vector(summary)
    update_zpage_search_index(page, vector)
    return summary


def create_search_index_if_not_exists(instance):
    if not instance.is_published or not instance.creator.is_active:
        SearchIndex.objects.filter(
            content_type=ContentType.objects.get_for_model(instance),
            object_id=instance.pk,
        ).delete()
        return
    content_type = ContentType.objects.get_for_model(instance)
    if not SearchIndex.objects.filter(content_type=content_type, object_id=instance.pk).exists():
        # If no SearchIndex exists, create one
        context = get_zpage_context(instance)
        summary = generate_summary(context)
        vector = generate_vector(summary)
        update_zpage_search_index(instance, vector)
