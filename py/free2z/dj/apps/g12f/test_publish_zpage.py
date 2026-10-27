"""
Event-based zPage publishing tests, against real Postgres.

Enqueue assertions use the real procrastinate DjangoConnector: defer()
writes a row to the procrastinate_jobs table through the Django DB
connection, so we assert on ProcrastinateJob rows — no queue mocking.
Task execution is exercised by calling the task function directly
(procrastinate tasks are plain callables). Signal-driven enqueues go
through transaction.on_commit, so those tests use
django_db(transaction=True).
"""
import uuid
from datetime import timedelta

import pytest
from django.core.management import call_command
from django.utils import timezone

from procrastinate.contrib.django.models import ProcrastinateJob

from dj.apps.g12f.models import zPage, ZPageTranslation
from dj.apps.g12f.tasks import notify_published_zpage, publish_zpage
from dj.apps.g12f.testing import job_context


def _make_page(creator, **kwargs):
    defaults = dict(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        title="Scheduled page",
        content="Content about a topic.",
        is_published=False,
    )
    defaults.update(kwargs)
    return zPage.objects.create(**defaults)


def _publish_jobs(page):
    return ProcrastinateJob.objects.filter(
        task_name="g12f.publish_zpage",
        args={"zpage_id": page.pk},
    )


def _index_jobs(page):
    return ProcrastinateJob.objects.filter(
        task_name="search.index_zpage",
        args={"zpage_id": page.pk},
    )


def _multilingual_index_jobs(page):
    return ProcrastinateJob.objects.filter(
        task_name="search.index_multilingual_zpage",
        args={"zpage_id": page.pk},
    )


def _notification_jobs(page):
    return ProcrastinateJob.objects.filter(
        task_name="g12f.notify_published_zpage",
        args={"zpage_id": page.pk},
    )


@pytest.mark.django_db(transaction=True)
def test_saving_future_publish_at_creates_scheduled_job(creator_factory):
    when = timezone.now() + timedelta(hours=3)

    page = _make_page(creator_factory(), publish_at=when)

    job = _publish_jobs(page).order_by("-id").first()
    assert job is not None
    assert job.status == "todo"
    assert job.queue_name == "default"
    assert job.scheduled_at == when


@pytest.mark.django_db(transaction=True)
def test_changing_publish_at_enqueues_again_without_cancellation(
        creator_factory):
    page = _make_page(
        creator_factory(), publish_at=timezone.now() + timedelta(hours=1))

    page.publish_at = timezone.now() + timedelta(hours=2)
    page.save()

    # No cancellation machinery by design: the obsolete job stays queued
    # and will no-op because the task re-checks DB state when it runs.
    assert _publish_jobs(page).count() == 2


@pytest.mark.django_db(transaction=True)
def test_unscheduled_saves_do_not_create_publish_jobs(creator_factory):
    creator = creator_factory()

    draft = _make_page(creator)  # no publish_at
    published = _make_page(creator, is_published=True)

    assert not _publish_jobs(draft).exists()
    assert not _publish_jobs(published).exists()


@pytest.mark.django_db
def test_manual_api_publish_records_first_publication_time(
        api_client, creator_factory):
    creator = creator_factory()
    page = _make_page(creator)
    api_client.force_authenticate(user=creator)

    before_publish = timezone.now()
    response = api_client.patch(
        f"/api/zpage/{page.free2zaddr}/",
        {"is_published": True},
        format="json",
    )

    assert response.status_code == 200, response.data
    page.refresh_from_db()
    assert page.is_published is True
    assert page.published_at is not None
    assert page.published_at >= before_publish


@pytest.mark.django_db
def test_save_does_not_stamp_unwritten_publication_state(creator_factory):
    page = _make_page(creator_factory())

    # A caller can carry an in-memory state change while deliberately saving
    # only another field. This must remain a draft with no durable first-publish
    # timestamp; the later real transition captures its own current time.
    page.is_published = True
    page.title = "Title-only draft edit"
    page.save(update_fields=["title"])

    page.refresh_from_db()
    assert page.is_published is False
    assert page.published_at is None

    before_publish = timezone.now()
    page.is_published = True
    page.save(update_fields=["is_published"])

    page.refresh_from_db()
    assert page.is_published is True
    assert page.published_at is not None
    assert page.published_at >= before_publish


@pytest.mark.django_db
def test_stale_full_save_preserves_publication_timestamp(creator_factory):
    page = _make_page(
        creator_factory(),
        publish_at=timezone.now() - timedelta(minutes=1),
    )
    stale_editor = zPage.objects.get(pk=page.pk)

    publish_zpage(zpage_id=page.pk)
    page.refresh_from_db()
    published_at = page.published_at
    assert published_at is not None

    # This is the old editor payload arriving after the scheduled publication
    # committed. It may still unpublish the page, but it must not erase the
    # publication event that the trigger used to preserve.
    stale_editor.is_published = False
    stale_editor.published_at = None
    stale_editor.save()

    page.refresh_from_db()
    assert page.is_published is False
    assert page.published_at == published_at


@pytest.mark.django_db
def test_editing_legacy_published_row_uses_created_at_fallback(creator_factory):
    creator = creator_factory()
    page = _make_page(creator, is_published=True)
    legacy_created = timezone.now() - timedelta(days=3)
    zPage.objects.filter(pk=page.pk).update(
        created_at=legacy_created,
        published_at=None,
    )
    page.refresh_from_db()

    page.title = "Edited legacy page"
    page.save()
    page.refresh_from_db()

    assert page.published_at == legacy_created


@pytest.mark.django_db
def test_publish_zpage_publishes_due_page_and_enqueues_indexing(
        creator_factory):
    page = _make_page(
        creator_factory(),
        publish_at=timezone.now() - timedelta(minutes=1))

    publish_zpage(zpage_id=page.pk)

    page.refresh_from_db()
    assert page.is_published is True
    assert page.publish_at is None
    # Publishing is the moment the page must become searchable
    assert _index_jobs(page).count() == 1
    assert _notification_jobs(page).count() == 1


@pytest.mark.django_db
def test_publish_zpage_records_publication_time_for_chronological_feeds(
        api_client, creator_factory):
    author = creator_factory()
    existing = _make_page(
        author, is_published=True, vanity="existing-public-feed-page",
    )
    scheduled = _make_page(
        author,
        vanity="scheduled-public-feed-page",
        publish_at=timezone.now() - timedelta(minutes=1),
    )
    old_existing_publication = timezone.now() - timedelta(hours=1)
    old_scheduled_creation = timezone.now() - timedelta(days=2)
    zPage.objects.filter(pk=existing.pk).update(
        created_at=timezone.now() - timedelta(days=1),
        published_at=old_existing_publication,
    )
    zPage.objects.filter(pk=scheduled.pk).update(
        created_at=old_scheduled_creation,
    )

    before_publish = timezone.now()
    publish_zpage(zpage_id=scheduled.pk)

    scheduled.refresh_from_db()
    assert scheduled.is_published is True
    assert scheduled.published_at is not None
    assert scheduled.published_at >= before_publish
    response = api_client.get("/api/zpage/?ordering=-published_at,-id")
    assert response.status_code == 200
    assert response.json()["results"][0]["vanity"] == scheduled.vanity


@pytest.mark.django_db
def test_publish_pages_backstop_records_first_publication_time(
        creator_factory):
    page = _make_page(
        creator_factory(),
        vanity="backstop-first-publication",
        publish_at=timezone.now() - timedelta(minutes=1),
    )
    old_creation = timezone.now() - timedelta(days=2)
    zPage.objects.filter(pk=page.pk).update(
        created_at=old_creation,
        published_at=None,
    )

    before_publish = timezone.now()
    call_command("publish_pages")

    page.refresh_from_db()
    assert page.is_published is True
    assert page.published_at is not None
    assert page.published_at >= before_publish
    assert page.published_at > old_creation


@pytest.mark.django_db(transaction=True)
def test_publish_zpage_with_published_translation_uses_rollout_safe_indexing(
        creator_factory):
    page = _make_page(
        creator_factory(),
        publish_at=timezone.now() - timedelta(minutes=1),
    )
    ZPageTranslation.objects.create(
        zpage=page,
        language="es",
        title="Título publicado",
        content="Contenido publicado",
        is_published=True,
    )
    old = timezone.now() - timedelta(days=365)
    zPage.objects.filter(pk=page.pk).update(
        searchable_content_updated_at=old,
    )

    publish_zpage(zpage_id=page.pk)

    page.refresh_from_db()
    assert page.is_published is True
    assert page.searchable_content_updated_at > old
    assert not _index_jobs(page).exists()
    job = _multilingual_index_jobs(page).get()
    assert job.queue_name == "search-multilingual"
    assert job.scheduled_at > timezone.now()
    assert _notification_jobs(page).count() == 1


@pytest.mark.django_db(transaction=True)
def test_saving_published_source_with_translation_uses_rollout_safe_indexing(
        creator_factory):
    page = _make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page,
        language="fr",
        title="Titre publié",
        content="Contenu publié",
        is_published=True,
    )

    old = timezone.now() - timedelta(days=365)
    zPage.objects.filter(pk=page.pk).update(
        searchable_content_updated_at=old,
    )
    page.refresh_from_db()
    page.is_published = True
    page.save()

    page.refresh_from_db()
    assert page.searchable_content_updated_at > old
    assert not _index_jobs(page).exists()
    job = _multilingual_index_jobs(page).get()
    assert job.queue_name == "search-multilingual"


@pytest.mark.django_db
def test_publish_zpage_is_a_noop_when_not_yet_due(creator_factory):
    when = timezone.now() + timedelta(hours=1)
    page = _make_page(creator_factory(), publish_at=when)

    publish_zpage(zpage_id=page.pk)

    page.refresh_from_db()
    assert page.is_published is False
    assert page.publish_at == when
    assert not _index_jobs(page).exists()
    assert not _notification_jobs(page).exists()


@pytest.mark.django_db
def test_notify_published_zpage_emits_page_update(creator_factory, mocker):
    page = _make_page(
        creator_factory(), is_published=True, vanity="scheduled-page"
    )
    emit = mocker.patch("dj.apps.g12f.publication.enqueue_page_update")

    notify_published_zpage(job_context(1), zpage_id=page.pk)

    emit.assert_called_once()
    assert emit.call_args.args[0].pk == page.pk


@pytest.mark.django_db
def test_notify_published_zpage_ignores_private_page(creator_factory, mocker):
    page = _make_page(creator_factory(), is_published=False)
    emit = mocker.patch("dj.apps.g12f.publication.enqueue_page_update")

    notify_published_zpage(job_context(1), zpage_id=page.pk)

    emit.assert_not_called()


@pytest.mark.django_db
def test_publish_zpage_is_a_noop_when_already_published(creator_factory):
    page = _make_page(creator_factory(), is_published=True)
    updated_at_before = page.updated_at
    # The save above enqueues its own reindex inside the (test) transaction
    # since; this test is about what publish_zpage adds.
    ProcrastinateJob.objects.all().delete()

    publish_zpage(zpage_id=page.pk)

    page.refresh_from_db()
    assert page.updated_at == updated_at_before
    assert not _index_jobs(page).exists()
    assert not _notification_jobs(page).exists()


@pytest.mark.django_db
def test_publish_zpage_is_a_noop_for_missing_page():
    # Stale job for a deleted page: must not raise
    publish_zpage(zpage_id=987654321)


@pytest.mark.django_db(transaction=True)
def test_saving_published_page_enqueues_indexing(creator_factory):
    page = _make_page(creator_factory(), is_published=True)
    assert _index_jobs(page).count() == 1

    page.title = "Edited title"
    page.save()

    assert _index_jobs(page).count() == 2


@pytest.mark.django_db(transaction=True)
def test_unpublishing_an_indexed_page_enqueues_deindexing(
        creator_factory, mocker):
    from django.contrib.contenttypes.models import ContentType

    from dj.apps.search.models import SearchIndex

    page = _make_page(creator_factory(), is_published=True)
    SearchIndex.objects.create(
        content_type=ContentType.objects.get_for_model(zPage),
        object_id=page.pk,
        vector=[0.0] * 1536,
    )
    before = _index_jobs(page).count()

    page.is_published = False
    page.save()

    # One more index job: the task will see is_published=False and
    # remove the stale SearchIndex row
    assert _index_jobs(page).count() == before + 1
