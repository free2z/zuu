"""A committed write always has its job; a rolled-back write never does.

Every enqueue below used to be ``transaction.on_commit(lambda: task.defer())``.
That callback is a separate statement AFTER ``COMMIT``, so a process killed
between the two -- a deploy drain, an OOM kill -- or a failed INSERT left the
row saved and the job nonexistent, with nothing anywhere able to notice:
``index_zpage``, ``generate_image_variants`` and ``detect_zpage_language``
have no repair sweep.

"The process died after COMMIT" is simulated exactly: the connection's
post-commit hooks are cleared instead of run, which is what a SIGKILL between
the two statements amounts to. Against the old code every ``*_survives_*``
test here fails (no job); against the fix the job was committed with the row.

All real Postgres, ``transaction=True``: a savepoint or commit-ordering claim
proved inside the test-case transaction proves nothing.
"""
from __future__ import annotations

import threading
import time
import uuid
from datetime import timedelta
from io import BytesIO

import pytest
from django.core.files.base import ContentFile
from django.db import connection, connections, transaction
from django.utils import timezone
from PIL import Image
from procrastinate.contrib.django import app as procrastinate_app
from procrastinate.contrib.django.models import ProcrastinateJob
from procrastinate.exceptions import ConnectorException

from dj.apps.g12f.models import zPage, ZPageTranslation
from dj.apps.g12f.tasks import detect_zpage_language, publish_zpage
from dj.apps.jobs import transactional
from dj.apps.jobs.transactional import defer_in_transaction
from dj.apps.search.tasks import index_zpage
from dj.apps.uploads.models import GenericFile


class Boom(Exception):
    pass


@pytest.fixture
def process_dies_after_commit(monkeypatch):
    """COMMIT happens; the on-commit callbacks never run.

    ``run_and_clear_commit_hooks`` is what Django calls right after COMMIT.
    Clearing the list instead of running it is indistinguishable, from the
    database's point of view, from the pod being SIGKILLed between the two.
    """
    def die(self):
        self.run_on_commit = []

    monkeypatch.setattr(
        type(connections["default"]), "run_and_clear_commit_hooks", die,
    )


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
        },
    }
    settings.MEDIA_ROOT = str(tmp_path)


def _page(creator, **kwargs):
    values = dict(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        title="A page about transactional enqueues",
        content="Some content that is long enough to be a page.",
        is_published=False,
    )
    values.update(kwargs)
    return zPage.objects.create(**values)


def _png():
    out = BytesIO()
    Image.new("RGB", (400, 300), (10, 120, 200)).save(out, format="PNG")
    return out.getvalue()


def _image(creator):
    return GenericFile.objects.create(
        owner=creator,
        file=ContentFile(_png(), name="pic.png"),
        mime_type="image/png",
        access="public",
    )


def _jobs(task_name, **args):
    return ProcrastinateJob.objects.filter(task_name=task_name, args=args)


# --------------------------------------------------------------------------- #
# The loss window: COMMIT succeeded, the process died before the enqueue.
# --------------------------------------------------------------------------- #
@pytest.mark.django_db(transaction=True)
def test_index_job_survives_death_after_commit(
    creator_factory, process_dies_after_commit,
):
    with transaction.atomic():
        page = _page(creator_factory(), is_published=True)

    assert _jobs("search.index_zpage", zpage_id=page.pk).count() == 1


@pytest.mark.django_db(transaction=True)
def test_detection_job_survives_death_after_commit(
    creator_factory, process_dies_after_commit,
):
    with transaction.atomic():
        page = _page(creator_factory())

    assert _jobs("g12f.detect_zpage_language", zpage_id=page.pk).count() == 1


@pytest.mark.django_db(transaction=True)
def test_scheduled_publish_job_survives_death_after_commit(
    creator_factory, process_dies_after_commit,
):
    with transaction.atomic():
        page = _page(
            creator_factory(),
            publish_at=timezone.now() + timedelta(hours=1),
        )

    assert _jobs("g12f.publish_zpage", zpage_id=page.pk).count() == 1


@pytest.mark.django_db(transaction=True)
def test_multilingual_index_job_survives_death_after_commit(
    creator_factory, process_dies_after_commit,
):
    page = _page(creator_factory(), is_published=True)
    ProcrastinateJob.objects.all().delete()

    with transaction.atomic():
        ZPageTranslation.objects.create(
            zpage=page, language="fr", title="Titre", content="Contenu",
            is_published=True,
        )

    assert _jobs(
        "search.index_multilingual_zpage", zpage_id=page.pk,
    ).count() == 1


@pytest.mark.django_db(transaction=True)
def test_image_variant_job_survives_death_after_commit(
    creator_factory, process_dies_after_commit,
):
    with transaction.atomic():
        image = _image(creator_factory())

    assert _jobs(
        "uploads.generate_image_variants", generic_file_id=image.pk,
    ).count() == 1


@pytest.mark.django_db(transaction=True)
def test_publish_task_enqueues_the_reindex_with_the_publication(
    creator_factory, monkeypatch,
):
    """The worker path: publish_zpage commits, then its reindex enqueue fails.

    Before  the reindex was deferred AFTER the publish transaction, on
    the app's connector. If that failed (or the worker was killed there) the
    page stayed published and unindexed forever: the retried job sees
    ``updated == 0`` and no-ops. Now the reindex is inserted inside the
    publish transaction, on Django's connection, so a failure of the app's
    connector afterwards cannot lose it.
    """
    page = _page(creator_factory())
    zPage.objects.filter(pk=page.pk).update(
        publish_at=timezone.now() - timedelta(minutes=1),
    )
    ProcrastinateJob.objects.all().delete()

    real = procrastinate_app.job_manager.batch_defer_jobs

    def search_queue_down(jobs, connection=None):
        if any(job.task_name.startswith("search.") for job in jobs):
            raise ConnectorException("queue insert failed after COMMIT")
        return real(jobs=jobs, connection=connection)

    monkeypatch.setattr(
        procrastinate_app.job_manager, "batch_defer_jobs", search_queue_down,
    )

    try:
        publish_zpage(zpage_id=page.pk)
    except ConnectorException:
        pass
    # The job is retried, as procrastinate would.
    publish_zpage(zpage_id=page.pk)

    assert zPage.objects.get(pk=page.pk).is_published
    assert _jobs("search.index_zpage", zpage_id=page.pk).count() == 1


# --------------------------------------------------------------------------- #
# The other half of "transactional": a rolled-back write leaves no job.
# --------------------------------------------------------------------------- #
@pytest.mark.django_db(transaction=True)
def test_a_rolled_back_save_leaves_no_job(creator_factory):
    creator = creator_factory()
    before = set(ProcrastinateJob.objects.values_list("pk", flat=True))
    with pytest.raises(Boom):
        with transaction.atomic():
            _page(creator, is_published=True)
            _image(creator)
            # Visible inside the transaction...
            assert ProcrastinateJob.objects.exclude(pk__in=before).count() == 3
            raise Boom

    #...and gone with it.
    assert not ProcrastinateJob.objects.exclude(pk__in=before).exists()


@pytest.mark.django_db(transaction=True)
def test_a_failing_enqueue_rolls_the_write_back(creator_factory, monkeypatch):
    """A job INSERT that fails takes the write with it.

    That is the whole contract: there is no committed row without its job.
    The alternative -- swallowing the error -- is the silent loss  is.
    """
    creator = creator_factory()

    def refuse(self, jobs, connection=None):
        raise ConnectorException("queue insert failed")

    monkeypatch.setattr(
        transactional._job_manager("default").__class__,
        "batch_defer_jobs", refuse,
    )

    with pytest.raises(ConnectorException):
        with transaction.atomic():
            _page(creator, is_published=True)

    assert not zPage.objects.filter(creator=creator).exists()


@pytest.mark.django_db(transaction=True)
def test_a_failing_enqueue_rolls_back_a_real_request(
    creator_factory, monkeypatch,
):
    """Through the real middleware stack: ``POST /uploads/single-public``
    with the job INSERT failing is a 500 and commits no upload row.

    ``AtomicMiddleware`` rolls back on a raise since, which is what
    carries this case; the helper's own ``set_rollback`` agrees with it.
    """
    from django.test import Client
    from django.urls import reverse

    creator = creator_factory()

    def refuse(self, jobs, connection=None):
        raise ConnectorException("queue insert failed")

    monkeypatch.setattr(
        transactional._job_manager("default").__class__,
        "batch_defer_jobs", refuse,
    )
    client = Client(raise_request_exception=False)
    client.force_login(creator)
    upload = ContentFile(_png(), name="pic.png")
    upload.content_type = "image/png"

    response = client.post(
        reverse("uploads_single_public"),
        {"title": "pic", "name": "pic.png", "file": upload},
    )

    assert response.status_code == 500
    assert not GenericFile.objects.filter(owner=creator).exists()


@pytest.mark.django_db(transaction=True)
def test_a_failing_enqueue_rolls_back_even_when_a_caller_returns(
    creator_factory, monkeypatch,
):
    """A caller that CATCHES the failure and returns normally.

    a returned response -- even an error one -- means "commit"
    under ``AtomicMiddleware``, and a task or command that logs and carries on
    commits too. So the middleware cannot be what guarantees "no row without
    its job"; the helper marks the enclosing block for rollback itself.
    """
    creator = creator_factory()

    def refuse(self, jobs, connection=None):
        raise ConnectorException("queue insert failed")

    monkeypatch.setattr(
        transactional._job_manager("default").__class__,
        "batch_defer_jobs", refuse,
    )

    with transaction.atomic():  # the request / task transaction
        try:
            _image(creator)
        except ConnectorException:
            pass  # e.g. `return Response(status=503)`, or log-and-continue

    assert not GenericFile.objects.filter(owner=creator).exists()


@pytest.mark.django_db(transaction=True)
def test_a_pending_job_claimed_before_our_commit_does_not_swallow_the_edit():
    """AlreadyEnqueued inside a transaction is re-checked after COMMIT.

    The pending job was ``todo`` when the edit looked, but a worker can claim
    it before the edit commits and read the pre-edit text. After COMMIT the
    lock is free again, so a new job must be enqueued for the edit.
    """
    lock = "multilingual-zpage-55"
    first = defer_in_transaction(
        detect_zpage_language.configure(queueing_lock=lock), zpage_id=55,
    )
    with transaction.atomic():
        assert defer_in_transaction(
            detect_zpage_language.configure(queueing_lock=lock), zpage_id=55,
        ) is None
        # A worker claims the pending job before our write commits.
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE procrastinate_jobs SET status = 'doing' WHERE id = %s",
                [first],
            )

    statuses = sorted(
        _jobs("g12f.detect_zpage_language", zpage_id=55)
        .values_list("status", flat=True)
    )
    assert statuses == ["doing", "todo"]


@pytest.mark.django_db(transaction=True)
def test_a_still_pending_job_coalesces_after_commit_too():
    lock = "multilingual-zpage-56"
    defer_in_transaction(
        detect_zpage_language.configure(queueing_lock=lock), zpage_id=56,
    )
    with transaction.atomic():
        defer_in_transaction(
            detect_zpage_language.configure(queueing_lock=lock), zpage_id=56,
        )

    assert _jobs("g12f.detect_zpage_language", zpage_id=56).count() == 1


@pytest.mark.django_db(transaction=True)
def test_enqueue_uses_djangos_connection_not_the_apps_connector(
    monkeypatch,
):
    """In a worker, the app's connector is a psycopg POOL, not Django's.

    ``manage.py procrastinate worker`` swaps it in, so a plain ``.defer()``
    from a task would insert on a separate autocommit connection: committed
    before the write it describes, and surviving that write's rollback. The
    helper must never go through ``app.job_manager``.
    """
    def pool_connection(*args, **kwargs):
        raise AssertionError("enqueued through the app's (pool) connector")

    monkeypatch.setattr(
        procrastinate_app.job_manager, "batch_defer_jobs", pool_connection,
    )
    monkeypatch.setattr(
        procrastinate_app.job_manager, "defer_job", pool_connection,
    )

    with pytest.raises(Boom):
        with transaction.atomic():
            defer_in_transaction(index_zpage.configure(), zpage_id=424242)
            assert _jobs("search.index_zpage", zpage_id=424242).exists()
            raise Boom

    assert not _jobs("search.index_zpage", zpage_id=424242).exists()


@pytest.mark.django_db(transaction=True)
def test_already_enqueued_is_confined_to_its_savepoint():
    """A refused duplicate must not poison the caller's transaction."""
    with transaction.atomic():
        first = defer_in_transaction(
            detect_zpage_language.configure(queueing_lock="detect-zpage-7"),
            zpage_id=7,
        )
        second = defer_in_transaction(
            detect_zpage_language.configure(queueing_lock="detect-zpage-7"),
            zpage_id=7,
        )
        # The outer transaction is still usable.
        assert ProcrastinateJob.objects.filter(pk=first).exists()

    assert first is not None
    assert second is None
    assert _jobs("g12f.detect_zpage_language", zpage_id=7).count() == 1


@pytest.mark.django_db(transaction=True)
def test_lock_timeout_is_restored_after_a_locked_enqueue():
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL lock_timeout = '7s'")
        defer_in_transaction(
            detect_zpage_language.configure(queueing_lock="detect-zpage-8"),
            zpage_id=8,
        )
        with connection.cursor() as cursor:
            cursor.execute("SHOW lock_timeout")
            assert cursor.fetchone()[0] == "7s"


# --------------------------------------------------------------------------- #
# Queueing-lock contention: never wait on another open transaction for long.
# --------------------------------------------------------------------------- #
def _hold_lock_in_other_transaction(lock, zpage_id, holding, release, outcome):
    """Open a transaction on a SECOND connection, enqueue under ``lock``, and
    keep it open until told to commit or roll back."""
    try:
        with transaction.atomic():
            defer_in_transaction(
                detect_zpage_language.configure(queueing_lock=lock),
                zpage_id=zpage_id,
            )
            holding.set()
            release.wait(10)
            if outcome["rollback"]:
                raise Boom
    except Boom:
        pass
    finally:
        connections.close_all()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("other_rolls_back", [False, True])
def test_contended_queueing_lock_falls_back_instead_of_waiting(
    other_rolls_back,
):
    """Another open transaction holds the same queueing lock.

    Inside a transaction a second INSERT of the same lock WAITS on the unique
    index for the first to finish -- while holding this writer's own row
    locks, which is an ABBA deadlock between a translation save and a page
    save. The helper waits at most QUEUEING_LOCK_WAIT_MS, then hands the
    enqueue to an on-commit fallback. Either way exactly one job survives:
    the other transaction's if it commits, ours if it rolls back.
    """
    lock = "detect-zpage-99"
    holding, release = threading.Event(), threading.Event()
    outcome = {"rollback": other_rolls_back}
    other = threading.Thread(
        target=_hold_lock_in_other_transaction,
        args=(lock, 99, holding, release, outcome),
    )
    other.start()
    try:
        assert holding.wait(10)
        started = time.monotonic()
        with transaction.atomic():
            result = defer_in_transaction(
                detect_zpage_language.configure(queueing_lock=lock),
                zpage_id=99,
            )
            waited = time.monotonic() - started
            # Not the other transaction's full lifetime, and not 1s+ of
            # deadlock detection.
            assert waited < 0.9, waited
            assert result is None
            release.set()
            other.join(10)
    finally:
        release.set()
        other.join(10)

    assert _jobs("g12f.detect_zpage_language", zpage_id=99).count() == 1
