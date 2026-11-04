"""The corpus backfill command ( M4).

It runs against the real production corpus with a real bill attached, so the
properties under test are the ones that make that safe: a dry run that spends
nothing, a ceiling that stops the run *before* the call that would cross it,
resumability, idempotence, and never touching a human's label.
"""
import uuid
from io import StringIO

import pytest
from django.core.cache import cache
from django.core.management import call_command

from f2z.ai import language as lang
from f2z.ai import providers

from dj.apps.g12f.management.commands.backfill_zpage_languages import (
    Command as BackfillCommand,
)
from dj.apps.g12f.models import zPage, ZPageVariant
from dj.apps.g12f.models.zpage import (
    LANGUAGE_SOURCE_CREATOR,
    LANGUAGE_SOURCE_DETECTED,
    LEGACY_UNDETERMINED_LANGUAGE,
)
from dj.apps.openai.models import AIModel


ENGLISH = (
    "Encrypted messaging is live on free2z and there are two concrete ways "
    "you can help us finish it before the end of the quarter."
)
SPANISH = (
    "La mensajeria cifrada ya funciona en free2z y hay dos maneras concretas "
    "de ayudarnos a terminarla antes de que acabe el trimestre."
)


@pytest.fixture(autouse=True)
def _clean_state(settings):
    settings.OPENAI_API_KEY = "test-key-not-used"
    settings.ANTHROPIC_API_KEY = ""
    settings.XAI_API_KEY = ""
    settings.MOONSHOT_API_KEY = ""
    providers._clients.clear()
    cache.clear()
    yield
    providers._clients.clear()
    cache.clear()


@pytest.fixture
def cheap_model(db):
    AIModel.objects.all().delete()
    return AIModel.objects.create(
        provider="openai", model="cheap-test", display_name="Cheap",
        system_message="x", max_tokens=100000, is_ga=True,
        input_price="0.000001", output_price="0.000002",
    )


class Recorder:
    def __init__(self, answer):
        self.answer = answer
        self.calls = []
        self.models = []

    def __call__(self, ai_model, messages, **kwargs):
        self.models.append(ai_model)
        self.calls.append(messages)
        yield self.answer(messages)


def batch_answer(tag_for):
    """Classify each envelope by its own text; canaries answer truthfully."""
    import re

    canaries = {text: tag for tag, text in lang.BATCH_CANARIES}

    def answer(messages):
        prompt = messages[-1]["content"]
        lines = []
        for doc_id, body in re.findall(
            r'<document id="([0-9a-f]{12})">\n(.*?)\n</document',
            prompt, re.DOTALL,
        ):
            tag = "en"
            for text, candidate in {**canaries, **tag_for}.items():
                if text[:30] in body:
                    tag = candidate
                    break
            lines.append(f"{doc_id} {tag}")
        return "\n".join(lines)
    return answer


def batch_answer_omitting_documents(omitted_documents):
    """Answer controls and all but ``omitted_documents`` real batch entries."""
    import re

    canaries = {text: tag for tag, text in lang.BATCH_CANARIES}

    def answer(messages):
        if "SEVERAL INDEPENDENT" not in messages[0]["content"]:
            # The omitted entries are re-detected in isolation.
            return "en"
        omitted = 0
        lines = []
        for doc_id, body in re.findall(
            r'<document id="([0-9a-f]{12})">\n(.*?)\n</document',
            messages[-1]["content"], re.DOTALL,
        ):
            tag = None
            for text, candidate in canaries.items():
                if text[:30] in body:
                    tag = candidate
                    break
            if tag is None:
                if omitted < omitted_documents:
                    omitted += 1
                    continue
                tag = "en"
            lines.append(f"{doc_id} {tag}")
        return "\n".join(lines)

    return answer


@pytest.fixture
def provider(monkeypatch):
    def install(tag_for=None):
        recorder = Recorder(batch_answer(tag_for or {}))
        monkeypatch.setattr(lang, "stream_chat", recorder)
        return recorder
    return install


def make_page(creator, **overrides):
    values = {
        "creator": creator,
        "free2zaddr": str(uuid.uuid4()),
        "title": "Encrypted messaging on free2z and two ways you can help",
        "description": "",
        "content": ENGLISH,
        "source_language": LEGACY_UNDETERMINED_LANGUAGE,
        "is_published": True,
    }
    values.update(overrides)
    return zPage.objects.create(**values)


def run(**options):
    out = StringIO()
    call_command("backfill_zpage_languages", stdout=out, stderr=out, **options)
    return out.getvalue()


# --------------------------------------------------------------------------- #
# Dry run
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_the_default_is_a_dry_run_that_spends_nothing(creator_factory,
                                                      cheap_model, provider):
    recorder = provider()
    pages = [make_page(creator_factory()) for _ in range(3)]

    output = run()

    assert recorder.calls == [], "a dry run made a provider call"
    for page in pages:
        page.refresh_from_db()
        assert page.source_language == LEGACY_UNDETERMINED_LANGUAGE
    assert "DRY RUN" in output
    assert "projected upper-bound spend $" in output
    assert "unlabelled zPages remaining: 3" in output


@pytest.mark.django_db
def test_dry_run_and_execute_are_refused_together(creator_factory,
                                                  cheap_model, provider):
    provider()
    output = run(dry_run=True, execute=True)
    assert "contradictory" in output


@pytest.mark.django_db
def test_the_dry_run_projection_brackets_the_executed_upper_bound(
    creator_factory, cheap_model, provider, monkeypatch,
):
    """A quote nobody can rely on is worse than no quote."""
    for _ in range(4):
        make_page(creator_factory())

    reported_usd = {}
    # _report is terminal presentation; handle ignores its return value. A
    # capture-only instance-method replacement observes the raw usage without
    # reparsing rounded output or repeating the remaining-count query.
    def capture_unrounded_usage(
        command, execute, scanned, detected, usage, outcome, budget,
    ):
        reported_usd[execute] = usage.usd

    monkeypatch.setattr(BackfillCommand, "_report", capture_unrounded_usage)

    provider()
    run()
    projected = reported_usd[False]

    provider()
    run(execute=True, max_usd=1.0)
    executed_upper_bound = reported_usd[True]

    # Fresh random envelope ids can shift locally recomputed input tokens by a
    # few percent; both paths charge the same full output cap. Compare the raw
    # estimates passed to the report instead of reparsing its four-decimal,
    # operator-facing presentation, whose rounding quantum exceeds 5% here.
    assert projected * 0.95 < executed_upper_bound < projected * 1.05


@pytest.mark.django_db
def test_dry_run_and_execute_choose_the_same_batch_model(
    creator_factory, cheap_model, provider,
):
    preferred = AIModel.objects.create(
        provider="openai", model="gpt-4o", display_name="GPT-4o",
        system_message="x", max_tokens=128000, is_ga=True,
        input_price="0.000010", output_price="0.000020",
    )
    make_page(creator_factory())

    output = run()
    assert "model: openai/gpt-4o" in output

    recorder = provider()
    run(execute=True, max_usd=1.0)
    assert recorder.models[0].pk == preferred.pk


@pytest.mark.django_db
def test_execute_keeps_a_failed_batch_candidate_open_across_row_slices(
    creator_factory, cheap_model, monkeypatch, settings,
):
    """The command calls the batch function once per provider-sized slice."""
    preferred = AIModel.objects.create(
        provider="openai", model="gpt-4o", display_name="GPT-4o",
        system_message="x", max_tokens=128000, is_ga=True,
        input_price="0.000010", output_price="0.000020",
    )
    AIModel.objects.create(
        provider="anthropic", model="backup", display_name="Backup",
        system_message="x", max_tokens=100000, is_ga=True,
        input_price="0.000030", output_price="0.000040",
    )
    settings.ANTHROPIC_API_KEY = "test-key-not-used"
    providers._clients.clear()
    for index in range(lang.BATCH_MAX_DOCUMENTS + 1):
        make_page(
            creator_factory(),
            title=f"Fresh page {index}",
            content=f"{ENGLISH} Fresh marker {index}.",
        )

    calls = []

    def stream(ai_model, messages, **kwargs):
        calls.append((ai_model, messages))
        if "SEVERAL INDEPENDENT" in messages[0]["content"]:
            if ai_model.pk == preferred.pk:
                raise ConnectionError("gpt-4o is unavailable")
            yield batch_answer({})(messages)
            return
        yield "en"

    monkeypatch.setattr(lang, "stream_chat", stream)

    run(execute=True, max_usd=1.0)

    batch_models = [
        ai_model.pk for ai_model, messages in calls
        if "SEVERAL INDEPENDENT" in messages[0]["content"]
    ]
    assert len(batch_models) == 3
    assert batch_models[0] == preferred.pk
    assert batch_models.count(preferred.pk) == 1
    assert batch_models[1] == batch_models[2]
    assert batch_models[1] != preferred.pk


# --------------------------------------------------------------------------- #
# Execute
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_execute_labels_the_corpus_in_one_call(creator_factory, cheap_model,
                                               provider):
    recorder = provider({SPANISH: "es"})
    english = [make_page(creator_factory()) for _ in range(3)]
    spanish = make_page(creator_factory(), content=SPANISH)

    output = run(execute=True, max_usd=1.0)

    assert len(recorder.calls) == 1, "the whole point is batching"
    for page in english:
        page.refresh_from_db()
        assert page.source_language == "en"
        assert page.language_source == LANGUAGE_SOURCE_DETECTED
    spanish.refresh_from_db()
    assert spanish.source_language == "es"
    assert "unlabelled zPages remaining: 0" in output


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("classifiable_pages", "omitted_documents", "warns"),
    [
        (lang.BATCH_MAX_DOCUMENTS, 1, False),
        (lang.BATCH_MAX_DOCUMENTS, 2, True),
        (lang.BATCH_MAX_DOCUMENTS - 1, 2, False),
    ],
)
def test_execute_warns_when_the_batch_fallback_rate_reaches_ten_percent(
    creator_factory, cheap_model, monkeypatch, classifiable_pages,
    omitted_documents, warns,
):
    """One full batch avoids turning a tiny smoke test into an alert."""
    for _ in range(classifiable_pages):
        make_page(creator_factory())
    monkeypatch.setattr(
        lang, "stream_chat", Recorder(
            batch_answer_omitting_documents(omitted_documents)
        ),
    )

    output = run(execute=True, max_usd=1.0)
    warning = (
        "WARNING: batch fallback rate is "
        f"{omitted_documents}/{classifiable_pages} "
        f"({omitted_documents / classifiable_pages:.1%})"
    )
    assert (warning in output) is warns


@pytest.mark.django_db
def test_fallback_warning_excludes_cached_pages_from_its_rate(
    creator_factory, cheap_model, monkeypatch,
):
    """Cache hits cost no batch call, so they cannot dilute its failure rate."""
    for index in range(lang.BATCH_MAX_DOCUMENTS):
        page = make_page(
            creator_factory(), title=f"Cached page {index}",
            content=f"{ENGLISH} Cached marker {index}.",
        )
        cache.set(
            lang.CACHE_PREFIX + lang.content_digest(page.title, page.content),
            ["en", lang.CONFIDENCE_STRONG], lang.CACHE_SECONDS,
        )
    for index in range(lang.BATCH_MAX_DOCUMENTS):
        make_page(
            creator_factory(), title=f"Fresh page {index}",
            content=f"{ENGLISH} Fresh marker {index}.",
        )
    recorder = Recorder(batch_answer_omitting_documents(2))
    monkeypatch.setattr(lang, "stream_chat", recorder)

    output = run(execute=True, max_usd=1.0)

    assert len(recorder.calls) == 3  # One batch and two isolated fallbacks.
    assert "WARNING: batch fallback rate is 2/20 (10.0%)" in output
    assert "2/40" not in output


def test_fallback_warning_counts_documents_deferred_before_isolation():
    """A budget stop after a bad batch must not hide its fallback rate."""
    from dj.apps.g12f.management.commands.backfill_zpage_languages import (
        Command,
    )

    outcome = lang.BatchOutcome()
    outcome.batch_attempted_documents = lang.BATCH_MAX_DOCUMENTS
    outcome.fallback_routed_documents = lang.BATCH_MAX_DOCUMENTS
    outcome.fallback_budget_deferred_documents = lang.BATCH_MAX_DOCUMENTS

    warning = Command._fallback_warning(outcome)

    assert outcome.fallback_documents == 0
    assert "20/20 (100.0%)" in warning


def test_fallback_warning_includes_direct_routes_after_the_circuit_opens():
    """A persistent outage must not turn the rate into an impossible >100%."""
    from dj.apps.g12f.management.commands.backfill_zpage_languages import (
        Command,
    )

    outcome = lang.BatchOutcome()
    outcome.batch_attempted_documents = lang.BATCH_MAX_DOCUMENTS
    outcome.fallback_direct_documents = lang.BATCH_MAX_DOCUMENTS
    outcome.fallback_routed_documents = 2 * lang.BATCH_MAX_DOCUMENTS

    warning = Command._fallback_warning(outcome)

    assert "40/40 (100.0%)" in warning


@pytest.mark.django_db
def test_the_source_variant_follows_the_new_label(creator_factory,
                                                  cheap_model, provider):
    """A bulk_update would leave every variant still claiming `und`."""
    provider()
    page = make_page(creator_factory())
    run(execute=True, max_usd=1.0)

    variant = page.variants.get(origin=ZPageVariant.SOURCE)
    assert variant.language == "en"


@pytest.mark.django_db
def test_a_creator_label_is_never_touched(creator_factory, cheap_model,
                                          provider):
    recorder = provider()
    page = make_page(creator_factory(), source_language="oc",
                     language_source=LANGUAGE_SOURCE_CREATOR)

    run(execute=True, max_usd=1.0)

    page.refresh_from_db()
    assert page.source_language == "oc"
    assert recorder.calls == [], "a creator-labelled page was even considered"


@pytest.mark.django_db
def test_an_already_labelled_page_is_out_of_scope(creator_factory,
                                                  cheap_model, provider):
    recorder = provider()
    make_page(creator_factory(), source_language="fr")
    run(execute=True, max_usd=1.0)
    assert recorder.calls == []


@pytest.mark.django_db
def test_the_backfill_does_not_reindex(creator_factory, cheap_model, provider,
                                       monkeypatch,
                                       django_capture_on_commit_callbacks):
    """A re-index is a summary + an embedding per page. At corpus scale that
    would cost far more than the detection it reacts to."""
    from procrastinate.contrib.django.models import ProcrastinateJob

    provider()
    make_page(creator_factory())
    # Asserted on real job rows, not a patched `.defer`: the
    # signals enqueue through `defer_in_transaction`, which a patched
    # `index_zpage.defer` never sees -- that version passed vacuously.
    ProcrastinateJob.objects.all().delete()

    with django_capture_on_commit_callbacks(execute=True):
        run(execute=True, max_usd=1.0)

    assert not ProcrastinateJob.objects.filter(
        task_name__in=["search.index_zpage", "search.index_multilingual_zpage"],
    ).exists()


# --------------------------------------------------------------------------- #
# The ceiling
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_the_ceiling_stops_the_run_before_it_is_crossed(creator_factory,
                                                        cheap_model, provider):
    recorder = provider()
    for _ in range(50):
        make_page(creator_factory())

    output = run(execute=True, max_usd=0.0000001, batch_size=5)

    assert recorder.calls == []
    assert "STOPPED at the $0.00 ceiling" in output
    assert zPage.objects.filter(
        source_language=LEGACY_UNDETERMINED_LANGUAGE
    ).count() == 50


@pytest.mark.django_db
def test_a_partial_run_is_resumable_and_the_rerun_is_idempotent(
    creator_factory, cheap_model, provider,
):
    provider()
    for _ in range(9):
        make_page(creator_factory())

    run(execute=True, max_usd=1.0, limit=4)
    assert zPage.objects.filter(
        source_language=LEGACY_UNDETERMINED_LANGUAGE
    ).count() == 5

    run(execute=True, max_usd=1.0)
    assert zPage.objects.filter(
        source_language=LEGACY_UNDETERMINED_LANGUAGE
    ).count() == 0

    # A third run has nothing to do and costs nothing.
    recorder = provider()
    output = run(execute=True, max_usd=1.0)
    assert recorder.calls == []
    assert "pages considered      0" in output


@pytest.mark.django_db
@pytest.mark.parametrize("value", [0, -1.0, float("nan"), float("inf")])
def test_a_nonsense_ceiling_is_refused(creator_factory, cheap_model, provider,
                                       value):
    """`nan` is the dangerous one: every ceiling comparison against it is
    false, so a typo would silently turn the ceiling OFF."""
    recorder = provider()
    make_page(creator_factory())
    assert "positive, finite" in run(execute=True, max_usd=value)
    assert recorder.calls == []


@pytest.mark.django_db
def test_no_configured_model_reports_rather_than_crashing(db, provider):
    AIModel.objects.all().delete()
    provider()
    assert "No callable GA AIModel" in run(execute=True)


# --------------------------------------------------------------------------- #
# `und` retirement reporting
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_it_reports_how_many_unlabelled_pages_remain(creator_factory,
                                                     cheap_model, provider):
    """The number  M7 is waiting on."""
    provider()
    make_page(creator_factory())
    make_page(creator_factory(), source_language=None)
    make_page(creator_factory(), source_language="en",
              language_source=LANGUAGE_SOURCE_CREATOR)

    output = run()
    assert "unlabelled zPages remaining: 2" in output


@pytest.mark.django_db
def test_a_page_with_no_classifiable_text_is_reported_not_billed(
    creator_factory, cheap_model, provider,
):
    recorder = provider()
    make_page(creator_factory(), title="   ", content="```\ncode()\n```")

    output = run(execute=True, max_usd=1.0)

    assert recorder.calls == []
    assert "no classifiable text       1" in output


# --------------------------------------------------------------------------- #
# Adversarial review findings (codex, 2026-08-09)
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_controls_are_drawn_from_the_corpus_when_ground_truth_exists(
    creator_factory, cheap_model, provider,
):
    """Creator-labelled pages are human-asserted ground truth.

    An attacker can read `BATCH_CANARIES` in the source tree and answer them
    correctly while steering everyone else; they cannot pick a real zPage out
    of a batch of real zPages.
    """
    creator = creator_factory()
    make_page(creator, source_language="es", content=SPANISH,
              language_source=LANGUAGE_SOURCE_CREATOR)
    make_page(creator)
    recorder = provider()

    output = run(execute=True, max_usd=1.0)

    assert "controls: corpus" in output
    prompt = recorder.calls[0][-1]["content"]
    assert SPANISH[:30] in prompt
    for _tag, canary in lang.BATCH_CANARIES:
        assert canary[:40] not in prompt


@pytest.mark.django_db
def test_controls_fall_back_to_the_static_canaries_on_a_fresh_corpus(
    creator_factory, cheap_model, provider,
):
    """Which is the state on the day this ships."""
    make_page(creator_factory())
    recorder = provider()
    output = run(execute=True, max_usd=1.0)

    assert "controls: static canaries" in output
    prompt = recorder.calls[0][-1]["content"]
    assert lang.BATCH_CANARIES[0][1][:40] in prompt


@pytest.mark.django_db
def test_a_relabel_between_the_scan_and_the_write_is_not_clobbered(
    creator_factory, cheap_model, provider, monkeypatch,
):
    """Minutes pass between the SELECT and the write.

    Checking `language_source` on a stale in-memory row and then writing
    unconditionally would erase the very override it just checked for.
    """
    page = make_page(creator_factory())
    provider()

    from dj.apps.g12f.management.commands import (
        backfill_zpage_languages as cmd,
    )

    real_write = cmd.Command._write

    def relabel_first(self, results):
        zPage.objects.filter(pk=page.pk).update(
            source_language="oc", language_source=LANGUAGE_SOURCE_CREATOR
        )
        return real_write(self, results)

    monkeypatch.setattr(cmd.Command, "_write", relabel_first)
    run(execute=True, max_usd=1.0)

    page.refresh_from_db()
    assert page.source_language == "oc"
    assert page.language_source == LANGUAGE_SOURCE_CREATOR
