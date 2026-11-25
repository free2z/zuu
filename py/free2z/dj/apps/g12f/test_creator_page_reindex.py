"""Bounded, restartable creator page reindex task (PostgreSQL)."""
import uuid

import pytest
from dj.apps.g12f.models import Creator, zPage
from dj.apps.g12f.tasks import (
    CREATOR_PAGE_REINDEX_BATCH_SIZE,
    reindex_creator_pages,
)


def _page(creator, *, published=True):
    return zPage.objects.create(
        creator=creator, free2zaddr=str(uuid.uuid4()), title="Page",
        content="public searchable page text", is_published=published,
        vanity=f"page-{uuid.uuid4().hex[:8]}",
    )


@pytest.mark.django_db
def test_batches_continue_through_all_visible_pages_and_resume_safely(
    creator_factory, mocker,
):
    creator = creator_factory()
    pages = [_page(creator) for _ in range(CREATOR_PAGE_REINDEX_BATCH_SIZE + 3)]
    _page(creator, published=False)
    indexed, deferred = [], []
    mocker.patch(
        "dj.apps.g12f.signals.reindex_published_zpage",
        side_effect=lambda page: indexed.append(page.pk),
    )
    mocker.patch(
        "dj.apps.jobs.transactional.defer_in_transaction",
        side_effect=lambda task, **kw: deferred.append(kw),
    )
    epoch = creator.kt_account_epoch

    reindex_creator_pages(creator.pk, epoch)
    assert len(indexed) == CREATOR_PAGE_REINDEX_BATCH_SIZE
    assert len(deferred) == 1
    cursor = deferred[0]["after_pk"]
    reindex_creator_pages(creator.pk, epoch, after_pk=cursor)
    assert set(indexed) == {page.pk for page in pages}
    assert len(indexed) == len(pages)
    assert deferred == [
        {"creator_id": creator.pk, "account_epoch": epoch, "after_pk": cursor}
    ]

    # Replaying a batch after a worker restart is safe; index defers are
    # idempotent and the continuation cursor remains stable.
    indexed.clear()
    reindex_creator_pages(creator.pk, epoch, after_pk=cursor)
    assert set(indexed) == {page.pk for page in pages if page.pk > cursor}


@pytest.mark.django_db
@pytest.mark.parametrize("invalidator", ["epoch", "deletion"])
def test_stale_task_does_not_index_or_continue(creator_factory, mocker, invalidator):
    creator = creator_factory()
    _page(creator)
    epoch = creator.kt_account_epoch
    if invalidator == "epoch":
        Creator.objects.filter(pk=creator.pk).update(kt_account_epoch=epoch + 1)
    else:
        Creator.objects.filter(pk=creator.pk).update(
            is_active=False, deletion_requested_at="2026-11-10T00:00:00Z",
        )
    index = mocker.patch("dj.apps.g12f.signals.reindex_published_zpage")
    defer = mocker.patch("dj.apps.jobs.transactional.defer_in_transaction")
    reindex_creator_pages(creator.pk, epoch)
    index.assert_not_called()
    defer.assert_not_called()


@pytest.mark.django_db
def test_task_registration_disables_automatic_reclaim():
    from dj.apps.jobs.reclaim_policy import NEVER, policy_for

    assert policy_for("g12f.reindex_creator_pages").max_runtime_seconds is NEVER
    assert "paid OpenAI" in policy_for(
        "g12f.reindex_creator_pages"
    ).reason


@pytest.mark.django_db(transaction=True)
def test_continuation_enqueue_failure_rolls_back_batch(creator_factory, mocker):
    from procrastinate.contrib.django.models import ProcrastinateJob

    creator = creator_factory()
    for _ in range(CREATOR_PAGE_REINDEX_BATCH_SIZE):
        _page(creator)
    before = ProcrastinateJob.objects.count()
    before_tasks = list(ProcrastinateJob.objects.values_list("task_name", flat=True))
    enqueue = mocker.patch(
        "dj.apps.jobs.transactional.defer_in_transaction",
        side_effect=RuntimeError("enqueue unavailable"),
    )
    with pytest.raises(RuntimeError):
        reindex_creator_pages(creator.pk, creator.kt_account_epoch)
    enqueue.assert_called_once()
    assert ProcrastinateJob.objects.count() == before
    # Retry starts from the same cursor, and inserts actual page-index jobs
    # plus one actual continuation in one transaction.
    mocker.stopall()
    reindex_creator_pages(creator.pk, creator.kt_account_epoch)
    jobs = list(ProcrastinateJob.objects.order_by("id").values_list("task_name", flat=True))
    new_jobs = jobs[len(before_tasks):]
    assert new_jobs.count("search.index_zpage") == CREATOR_PAGE_REINDEX_BATCH_SIZE
    assert new_jobs.count("g12f.reindex_creator_pages") == 1
