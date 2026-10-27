"""
Event-based search indexing tests, against real Postgres +
pgvector. SearchIndex rows are real DB rows; ONLY the OpenAI boundary
(summary completion + embedding) is mocked, with a deterministic fake
vector. Values are multiples of 1/8 so they round-trip exactly through
pgvector's float4 storage.
"""
import inspect
import io
import json
import logging
import uuid

import httpx2
import openai
import pytest
from django.contrib.contenttypes.models import ContentType
from django.core.management import call_command

from procrastinate.contrib.django.models import ProcrastinateJob

from dj.apps.g12f.models import ZPageTranslation, ZPageVariant, zPage
from dj.apps.search.models import SearchIndex
from dj.apps.search.helpers import EMBEDDING_MODEL
from dj.apps.search.tasks import index_multilingual_zpage, index_zpage
from dj.free2z.log_json import RawLoggerJSONFormatter

FAKE_VECTOR = [(i % 8) / 8.0 for i in range(1536)]


def _make_page(creator, **kwargs):
    defaults = dict(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        title="A page about zebras",
        content="Zebras have stripes.",
        is_published=True,
    )
    defaults.update(kwargs)
    return zPage.objects.create(**defaults)


def _index_rows(page_or_id):
    object_id = getattr(page_or_id, "pk", page_or_id)
    return SearchIndex.objects.filter(
        content_type=ContentType.objects.get_for_model(zPage),
        object_id=object_id,
    )


def _seed_multilingual_job(page, status="failed"):
    job_id = index_multilingual_zpage.defer(zpage_id=page.pk)
    ProcrastinateJob.objects.filter(pk=job_id).update(status=status)
    return job_id


def _seed_failed_multilingual_job(page):
    return _seed_multilingual_job(page, status="failed")


@pytest.fixture
def mock_openai(mocker):
    # helpers.py calls chat.completions.create / embeddings.create on the one
    # bounded client returned by helpers.get_openai_client; patching
    # that factory mocks exactly the OpenAI boundary and never constructs a
    # real client (which would demand an API key).
    #
    # spec_set on the client: a MagicMock would happily answer the retired
    # legacy `client.completions.create` too, so the fake exposes ONLY
    # the two surfaces the indexing path is allowed to use.
    fake = mocker.NonCallableMock(spec_set=["chat", "embeddings"])
    fake.chat = mocker.NonCallableMock(spec_set=["completions"])
    fake.chat.completions = mocker.NonCallableMock(spec_set=["create"])
    fake.chat.completions.create = mocker.Mock(name="chat.completions.create")
    fake.embeddings = mocker.NonCallableMock(spec_set=["create"])
    fake.embeddings.create = mocker.Mock(name="embeddings.create")
    completion = mocker.Mock()
    completion.choices = [
        mocker.Mock(message=mocker.Mock(content=" A fake summary. "))
    ]
    fake.chat.completions.create.return_value = completion

    embedding = mocker.Mock()
    embedding.data = [mocker.Mock(embedding=FAKE_VECTOR)]
    fake.embeddings.create.return_value = embedding

    from dj.apps.search import helpers
    mocker.patch.object(helpers, "get_openai_client", return_value=fake)
    return {
        "completions": fake.chat.completions.create,
        "embeddings": fake.embeddings.create,
    }


@pytest.mark.django_db
def test_index_zpage_indexes_published_page(creator_factory, mock_openai):
    page = _make_page(creator_factory())

    index_zpage(zpage_id=page.pk)

    row = _index_rows(page).get()
    assert list(row.vector) == FAKE_VECTOR
    # The summary came from Chat Completions on the supported prompt model,
    # with the page prompt as the one user message (: the legacy
    # Completions call on gpt-3.5-turbo-instruct 404s since its retirement).
    (summary_kwargs,) = [mock_openai["completions"].call_args.kwargs]
    assert summary_kwargs["model"] == "gpt-4o-mini"
    assert summary_kwargs["max_completion_tokens"] == 150
    (message,) = summary_kwargs["messages"]
    assert message["role"] == "user"
    assert page.title in message["content"]
    assert "single natural paragraph" in message["content"]
    # The embedding was generated from the OpenAI summary
    (call_kwargs,) = [mock_openai["embeddings"].call_args.kwargs]
    assert call_kwargs["input"] == ["A fake summary."]


@pytest.mark.django_db
def test_index_zpage_is_idempotent_upsert(creator_factory, mock_openai):
    page = _make_page(creator_factory())

    index_zpage(zpage_id=page.pk)
    index_zpage(zpage_id=page.pk)

    assert _index_rows(page).count() == 1


@pytest.mark.django_db
def test_index_zpage_removes_unpublished_page_without_calling_openai(
        creator_factory, mock_openai):
    page = _make_page(creator_factory(), is_published=False)
    SearchIndex.objects.create(
        content_type=ContentType.objects.get_for_model(zPage),
        object_id=page.pk,
        vector=[0.0] * 1536,
    )

    index_zpage(zpage_id=page.pk)

    assert not _index_rows(page).exists()
    mock_openai["completions"].assert_not_called()
    mock_openai["embeddings"].assert_not_called()


@pytest.mark.django_db
def test_index_zpage_removes_inactive_creator_page_without_calling_openai(
        creator_factory, mock_openai):
    creator = creator_factory()
    page = _make_page(creator)
    SearchIndex.objects.create(
        content_type=ContentType.objects.get_for_model(zPage),
        object_id=page.pk,
        vector=[0.0] * 1536,
    )
    creator.is_active = False
    creator.save(update_fields=["is_active"])

    index_zpage(zpage_id=page.pk)

    assert not _index_rows(page).exists()
    mock_openai["completions"].assert_not_called()
    mock_openai["embeddings"].assert_not_called()


@pytest.mark.django_db
def test_deactivating_creator_deletes_owned_search_rows(creator_factory):
    creator = creator_factory()
    page = _make_page(creator)
    SearchIndex.objects.create(
        content_type=ContentType.objects.get_for_model(zPage),
        object_id=page.pk,
        vector=[0.0] * 1536,
    )

    creator.is_active = False
    creator.save(update_fields=["is_active"])

    assert not _index_rows(page).exists()


@pytest.mark.django_db
def test_index_zpage_handles_missing_page(mock_openai):
    index_zpage(zpage_id=987654321)  # must not raise

    assert not _index_rows(987654321).exists()
    mock_openai["embeddings"].assert_not_called()


@pytest.mark.django_db
def test_backfill_command_uses_same_code_path(creator_factory, mock_openai):
    unindexed = _make_page(creator_factory())
    draft = _make_page(creator_factory(), is_published=False)

    call_command("index_public_zpages")

    assert _index_rows(unindexed).count() == 1
    assert not _index_rows(draft).exists()


@pytest.mark.django_db(transaction=True)
def test_multilingual_reconciliation_requeues_existing_canonical_rows(
    creator_factory,
):
    """A present SearchIndex row is not proof that translations were indexed."""
    page = _make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page,
        language="es",
        title="Una página",
        content="Contenido traducido.",
        is_published=True,
    )
    SearchIndex.objects.create(
        content_type=ContentType.objects.get_for_model(zPage),
        object_id=page.pk,
        vector=[0.0] * 1536,
    )
    # Isolate the reconciliation from the signal jobs created while building
    # the fixture. The command must enqueue this page even though its vector
    # already exists.
    ProcrastinateJob.objects.all().delete()
    _seed_failed_multilingual_job(page)

    call_command(
        "reconcile_multilingual_search",
        reconciliation_id="deploy-a",
    )

    job = ProcrastinateJob.objects.get(
        task_name="search.index_multilingual_zpage",
        args={"zpage_id": page.pk},
        lock="multilingual-reconciliation:deploy-a:%s" % page.pk,
    )
    assert job.queue_name == "search-multilingual"
    assert job.status == "todo"
    assert job.lock == f"multilingual-reconciliation:deploy-a:{page.pk}"
    assert job.queueing_lock == f"multilingual-zpage-{page.pk}"


@pytest.mark.django_db(transaction=True)
def test_multilingual_reconciliation_is_idempotent_for_one_deploy(
    creator_factory,
):
    page = _make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page,
        language="es",
        title="Una página",
        content="Contenido traducido.",
        is_published=True,
    )
    ProcrastinateJob.objects.all().delete()
    _seed_failed_multilingual_job(page)

    for _ in range(2):
        call_command(
            "reconcile_multilingual_search",
            reconciliation_id="deploy-idempotent",
        )

    assert ProcrastinateJob.objects.filter(
        task_name="search.index_multilingual_zpage",
        args={"zpage_id": page.pk},
        lock__startswith="multilingual-reconciliation:deploy-idempotent:",
    ).count() == 1


@pytest.mark.django_db(transaction=True)
def test_multilingual_reconciliation_retries_a_failed_marker(
    creator_factory,
):
    page = _make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page,
        language="es",
        title="Una página",
        content="Contenido traducido.",
        is_published=True,
    )
    ProcrastinateJob.objects.all().delete()
    _seed_failed_multilingual_job(page)

    call_command(
        "reconcile_multilingual_search",
        reconciliation_id="deploy-retry",
    )
    ProcrastinateJob.objects.filter(
        task_name="search.index_multilingual_zpage",
        args={"zpage_id": page.pk},
        lock="multilingual-reconciliation:deploy-retry:%s" % page.pk,
    ).update(status="failed")

    call_command(
        "reconcile_multilingual_search",
        reconciliation_id="deploy-retry",
    )

    jobs = ProcrastinateJob.objects.filter(
        task_name="search.index_multilingual_zpage",
        args={"zpage_id": page.pk},
    )
    assert jobs.filter(
        lock__startswith="multilingual-reconciliation:deploy-retry:",
    ).count() == 2
    assert jobs.filter(status="todo").count() == 1


@pytest.mark.django_db(transaction=True)
def test_multilingual_reconciliation_emits_progress_on_failure(
    creator_factory, mocker, caplog,
):
    page = _make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page,
        language="es",
        title="Una página",
        content="Contenido traducido.",
        is_published=True,
    )
    ProcrastinateJob.objects.all().delete()
    _seed_failed_multilingual_job(page)
    mocker.patch.object(
        index_multilingual_zpage,
        "configure",
        side_effect=RuntimeError("queue unavailable"),
    )
    caplog.set_level("ERROR", logger="dj.apps.search.management.commands.reconcile_multilingual_search")

    with pytest.raises(RuntimeError, match="queue unavailable"):
        call_command(
            "reconcile_multilingual_search",
            reconciliation_id="deploy-observable-failure",
        )

    payloads = [
        json.loads(record.getMessage())
        for record in caplog.records
        if record.name == "dj.apps.search.management.commands.reconcile_multilingual_search"
    ]
    failure = next(payload for payload in payloads if payload["status"] == "failed")
    assert failure["event"] == "search_multilingual_reconciliation"
    assert failure["candidate_pages"] == 1
    assert failure["examined"] == 1
    assert failure["enqueued"] == 0
    assert failure["error_type"] == "RuntimeError"
    assert failure["error_message"] == "queue unavailable"


@pytest.mark.django_db(transaction=True)
def test_multilingual_reconciliation_skips_a_successful_latest_job(
    creator_factory,
):
    page = _make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page,
        language="es",
        title="Una página",
        content="Contenido traducido.",
        is_published=True,
    )
    ProcrastinateJob.objects.all().delete()
    _seed_multilingual_job(page, status="succeeded")

    call_command(
        "reconcile_multilingual_search",
        reconciliation_id="deploy-successful",
    )

    assert not ProcrastinateJob.objects.filter(
        lock__startswith="multilingual-reconciliation:deploy-successful:",
    ).exists()


@pytest.mark.django_db(transaction=True)
def test_multilingual_reconciliation_counts_real_fallback_candidates(
    creator_factory, caplog,
):
    """The emitted count matches the streamed set, including retention gaps."""
    source_only = _make_page(creator_factory())
    # Page creation already dual-writes its source variant; update that real
    # production-shaped row rather than manufacturing a second source.
    ZPageVariant.objects.filter(
        zpage=source_only,
        origin=ZPageVariant.SOURCE,
    ).update(
        language="en",
        title="Source",
        content="Source content.",
        is_published=True,
    )
    translated = _make_page(creator_factory())
    ZPageVariant.objects.create(
        zpage=translated,
        language="es",
        title="Traducida",
        content="Contenido traducido.",
        is_published=True,
        origin=ZPageVariant.HUMAN,
    )
    # Fixture signals may enqueue unrelated work. Both pages intentionally
    # have no retained multilingual job row for this fallback test.
    ProcrastinateJob.objects.all().delete()
    logger_name = "dj.apps.search.management.commands.reconcile_multilingual_search"
    caplog.set_level("INFO", logger=logger_name)

    call_command(
        "reconcile_multilingual_search",
        reconciliation_id="deploy-count",
    )

    events = [
        json.loads(record.getMessage())
        for record in caplog.records
        if record.name == logger_name
    ]
    started = next(event for event in events if event["status"] == "started")
    completed = next(event for event in events if event["status"] == "completed")
    for event in (started, completed):
        assert event["candidate_pages"] == 1
        assert event["pages_without_retained_job"] == 1
    assert completed["examined"] == 1
    assert completed["enqueued"] == 1
    assert ProcrastinateJob.objects.filter(
        task_name="search.index_multilingual_zpage",
        args={"zpage_id": translated.pk},
        lock=f"multilingual-reconciliation:deploy-count:{translated.pk}",
    ).exists()
    assert not ProcrastinateJob.objects.filter(
        args={"zpage_id": source_only.pk},
    ).exists()


@pytest.mark.django_db(transaction=True)
def test_multilingual_reconciliation_requeues_a_stranded_doing_job(
    creator_factory,
):
    page = _make_page(creator_factory())
    ProcrastinateJob.objects.all().delete()
    _seed_multilingual_job(page, status="doing")

    call_command(
        "reconcile_multilingual_search",
        reconciliation_id="deploy-stranded",
    )

    assert ProcrastinateJob.objects.filter(
        task_name="search.index_multilingual_zpage",
        args={"zpage_id": page.pk},
        status="todo",
        lock="multilingual-reconciliation:deploy-stranded:%s" % page.pk,
    ).exists()


@pytest.mark.django_db(transaction=True)
def test_multilingual_reconciliation_scrubs_unpublished_translation_after_failure(
    creator_factory,
):
    page = _make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page,
        language="es",
        title="Borrador",
        content="Privado.",
        is_published=False,
    )
    ProcrastinateJob.objects.all().delete()
    _seed_failed_multilingual_job(page)

    call_command(
        "reconcile_multilingual_search",
        reconciliation_id="deploy-unpublished",
    )

    assert ProcrastinateJob.objects.filter(
        lock="multilingual-reconciliation:deploy-unpublished:%s" % page.pk,
    ).exists()


@pytest.mark.django_db(transaction=True)
def test_multilingual_reconciliation_excludes_non_public_pages_and_translations(
    creator_factory,
):
    public = _make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=public,
        language="es",
        title="Publicada",
        content="Visible.",
        is_published=True,
    )
    variant_only = _make_page(creator_factory())
    ZPageVariant.objects.create(
        zpage=variant_only,
        language="fr",
        title="Publiée",
        content="Visible.",
        is_published=True,
        origin=ZPageVariant.HUMAN,
    )
    draft_translation = _make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=draft_translation,
        language="es",
        title="Borrador",
        content="Privado.",
        is_published=False,
    )
    unpublished = _make_page(creator_factory(), is_published=False)
    ZPageTranslation.objects.create(
        zpage=unpublished,
        language="es",
        title="No pública",
        content="No visible.",
        is_published=True,
    )
    ProcrastinateJob.objects.all().delete()
    _seed_failed_multilingual_job(public)
    _seed_failed_multilingual_job(variant_only)

    call_command(
        "reconcile_multilingual_search",
        reconciliation_id="deploy-negative-control",
    )

    jobs = ProcrastinateJob.objects.filter(
        task_name="search.index_multilingual_zpage",
        lock__startswith="multilingual-reconciliation:deploy-negative-control:",
    )
    assert set(jobs.values_list("args__zpage_id", flat=True)) == {
        public.pk,
        variant_only.pk,
    }


def test_multilingual_task_accepts_reconciliation_metadata():
    """The reconciliation must not fork the stable worker task contract."""
    assert index_multilingual_zpage.name == "search.index_multilingual_zpage"
    assert index_multilingual_zpage.queue == "search-multilingual"
    assert list(inspect.signature(index_multilingual_zpage.func).parameters) == [
        "zpage_id",
    ]


# ---------------------------------------------------------------------------
#the 2026-09-28/30 search.index_zpage outage
# ---------------------------------------------------------------------------
#
# OpenAI retired ``gpt-3.5-turbo-instruct`` on 2026-09-28. Every
# ``search.index_zpage`` then failed terminally with ``404 model_not_found``
# (135 jobs, 26 zPages) until  moved the summary to ``gpt-4o-mini``
# on 09-30. Two things made it slow to see and slow to read:
#
# * the only signal was the generic job-failure policy, which names neither the
#   task nor the model -- ``ai_model_unavailable`` now names the model and the
#   remedy, and ``monitoring/alert-policies/ai-model-unavailable.json`` pages on
#   the first one;
# * every SUCCESS line (``index_zpage: indexed zPage N``, logged at INFO) landed
#   in Cloud Logging at severity ERROR, because plain stderr is graded by stream.
#
# Same harness as above (real Postgres, only the OpenAI client faked by
# ``mock_openai``); the error is built from the exact prod body.

HELPERS_LOGGER = "dj.apps.search.helpers"
TASKS_LOGGER = "dj.apps.search.tasks"


def _model_not_found(model):
    """The error OpenAI returned for every index job in the outage.

    Body copied from a prod ``job_error`` line (image-variant-worker,
    2026-09-29). ``body`` is the INNER ``error`` object: that is what the SDK
    passes the exception, and where ``exc.code`` comes from.
    """
    request = httpx2.Request(
        "POST", "https://api.openai.com/v1/chat/completions")
    return openai.NotFoundError(
        f"Error code: 404 - model `{model}` has been deprecated",
        response=httpx2.Response(404, request=request),
        body={
            "message": f"The model `{model}` has been deprecated, learn more "
                       "here: https://platform.openai.com/docs/deprecations",
            "type": "invalid_request_error",
            "param": None,
            "code": "model_not_found",
        },
    )


def _unavailable_events(caplog):
    events = []
    for record in caplog.records:
        if record.name != HELPERS_LOGGER:
            continue
        payload = json.loads(record.getMessage())
        if payload.get("event") == "ai_model_unavailable":
            events.append((record.levelname, payload))
    return events


# -- the retired model is named ---------------------------------------------


@pytest.mark.django_db
def test_retired_summary_model_is_named_and_the_job_still_fails(
        creator_factory, mock_openai, caplog):
    page = _make_page(creator_factory())
    mock_openai["completions"].side_effect = _model_not_found("gpt-4o-mini")

    with caplog.at_level("INFO", logger=HELPERS_LOGGER):
        with pytest.raises(openai.NotFoundError):
            index_zpage(zpage_id=page.pk)

    ((level, payload),) = _unavailable_events(caplog)
    assert level == "ERROR"
    assert payload["severity"] == "ERROR"
    assert payload["provider"] == "openai"
    assert payload["model"] == "gpt-4o-mini"
    assert payload["purpose"] == "search summary"
    assert "PROMPT_COMPLETION_MODEL" in payload["remedy"]
    # Reporting is not handling: no row, no embedding call, and the job
    # fails so its retry strategy and job-health accounting still apply.
    assert not _index_rows(page).exists()
    mock_openai["embeddings"].assert_not_called()


@pytest.mark.django_db
def test_the_reported_summary_model_is_the_one_that_was_called(
        creator_factory, mock_openai, caplog, settings):
    """An env override must be reported as itself, not as the default."""
    settings.PROMPT_COMPLETION_MODEL = "gpt-4.1-mini"
    page = _make_page(creator_factory())
    mock_openai["completions"].side_effect = _model_not_found("gpt-4.1-mini")

    with caplog.at_level("INFO", logger=HELPERS_LOGGER):
        with pytest.raises(openai.NotFoundError):
            index_zpage(zpage_id=page.pk)

    ((_, payload),) = _unavailable_events(caplog)
    assert payload["model"] == "gpt-4.1-mini"
    called = mock_openai["completions"].call_args.kwargs["model"]
    assert called == payload["model"]


@pytest.mark.django_db
def test_retired_embedding_model_is_named_with_its_own_remedy(
        creator_factory, mock_openai, caplog):
    page = _make_page(creator_factory())
    mock_openai["embeddings"].side_effect = _model_not_found(EMBEDDING_MODEL)

    with caplog.at_level("INFO", logger=HELPERS_LOGGER):
        with pytest.raises(openai.NotFoundError):
            index_zpage(zpage_id=page.pk)

    ((_, payload),) = _unavailable_events(caplog)
    assert payload["model"] == "text-embedding-3-small"
    assert payload["purpose"] == "search embedding"
    # The one remedy that must NOT be "flip the ConfigMap": a new embedding
    # model is a different vector space from every stored row.
    assert "Not a ConfigMap change" in payload["remedy"]
    assert (mock_openai["embeddings"].call_args.kwargs["model"]
            == EMBEDDING_MODEL)


@pytest.mark.django_db
def test_an_unrelated_404_is_not_reported_as_a_retired_model(
        creator_factory, mock_openai, caplog):
    """Only ``code=model_not_found`` pages. A bare 404 (a proxy, a CDN, an
    unknown route) does not get to claim that a model is gone."""
    page = _make_page(creator_factory())
    request = httpx2.Request(
        "POST", "https://api.openai.com/v1/chat/completions")
    mock_openai["completions"].side_effect = openai.NotFoundError(
        "Not Found", response=httpx2.Response(404, request=request),
        body=None,
    )

    with caplog.at_level("INFO", logger=HELPERS_LOGGER):
        with pytest.raises(openai.NotFoundError):
            index_zpage(zpage_id=page.pk)

    assert _unavailable_events(caplog) == []


@pytest.mark.django_db
def test_a_retired_query_embedding_model_is_reported_and_search_degrades(
        api_client, creator_factory, mock_openai, monkeypatch, caplog):
    """The search QUERY embeds with the same model as the stored vectors
    (codex round 2). Its retirement is reported like the index side's, and
    search still answers from full text rather than failing."""
    monkeypatch.setenv("OPENAI_API_KEY", "test-key-not-used")
    page = _make_page(creator_factory(), vanity="zebra-2357")
    mock_openai["embeddings"].side_effect = _model_not_found(EMBEDDING_MODEL)
    from types import SimpleNamespace

    from dj.apps.search import drf_filters
    monkeypatch.setattr(
        drf_filters, "query_embedding_client",
        lambda: SimpleNamespace(embeddings=SimpleNamespace(
            create=mock_openai["embeddings"])))

    with caplog.at_level("INFO", logger=HELPERS_LOGGER):
        response = api_client.get("/api/zpage/?search=zebras")

    assert response.status_code == 200, response.content
    assert [item["vanity"] for item in response.json()["results"]] == [
        page.vanity]
    ((_, payload),) = _unavailable_events(caplog)
    assert payload["model"] == EMBEDDING_MODEL
    assert payload["purpose"] == "search query embedding"
    assert (mock_openai["embeddings"].call_args.kwargs["model"]
            == EMBEDDING_MODEL)


# -- a success is INFO, not ERROR --------------------------------------------


@pytest.fixture
def search_tasks_output():
    """The stream behind settings.LOGGING's dj.apps.search.tasks handler."""
    logger = logging.getLogger(TASKS_LOGGER)
    handlers = [h for h in logger.handlers
                if isinstance(h.formatter, RawLoggerJSONFormatter)]
    assert len(handlers) == 1, (
        "dj.apps.search.tasks has no JSON handler: its INFO lines reach the "
        "plain root handler -> stderr -> graded ERROR by GKE (#2357)",
        logger.handlers)
    assert logger.propagate is False, (
        "propagating would ALSO print the line through the plain root "
        "handler -- the ERROR-graded copy this exists to remove")
    buf = io.StringIO()
    old = handlers[0].setStream(buf)
    try:
        yield buf
    finally:
        handlers[0].setStream(old)


def _json_lines(text):
    return [json.loads(line) for line in text.splitlines() if line.strip()]


@pytest.mark.django_db
def test_index_success_is_one_info_json_line(
        creator_factory, mock_openai, search_tasks_output):
    page = _make_page(creator_factory())

    index_zpage(zpage_id=page.pk)

    (payload,) = _json_lines(search_tasks_output.getvalue())
    assert payload["severity"] == "INFO"
    assert payload["message"] == f"index_zpage: indexed zPage {page.pk}"
    assert payload["event"] == "search_index_zpage"
    assert payload["zpage_id"] == page.pk
    assert payload["outcome"] == "indexed"


@pytest.mark.django_db
def test_index_removal_is_one_info_json_line(
        mock_openai, search_tasks_output):
    index_zpage(zpage_id=987654321)

    (payload,) = _json_lines(search_tasks_output.getvalue())
    assert payload["severity"] == "INFO"
    assert payload["outcome"] == "removed"
    assert payload["zpage_id"] == 987654321


def test_the_reconciliation_logger_is_left_alone():
    """Scoping guard. ``reconcile_multilingual_search`` logs a pre-serialised
    JSON string, and two alert policies match ``jsonPayload.event`` on it.
    Routing ``dj.apps.search`` (rather than just its ``tasks`` module) through
    the JSON formatter would nest that string inside ``message`` and blind
    both policies."""
    for name in ("dj.apps.search",
                 "dj.apps.search.management.commands."
                 "reconcile_multilingual_search"):
        logger = logging.getLogger(name)
        assert not any(isinstance(h.formatter, RawLoggerJSONFormatter)
                       for h in logger.handlers), name
        assert logger.propagate is True, name
