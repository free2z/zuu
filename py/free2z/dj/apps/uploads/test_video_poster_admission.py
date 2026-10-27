"""
Per-owner admission control for poster jobs, against real Postgres.

Before this, `post_save` enqueued a poster job for every authenticated
video upload onto the concurrency-1 catch-all worker that also serves
notifications, translation, search indexing and blob cleanup.  made
each job bounded; nothing bounded how many of them one account could put in
front of everyone else's work. Now at most `VIDEO_POSTER_JOBS_PER_OWNER`
poster jobs per owner are queued or running at once, and the ones that
wait are re-admitted by every finishing job and by a periodic sweep -- so
the cap costs a bulk uploader nothing but fairness.

`transaction=True` throughout: the signal enqueues in `on_commit`, and the
job table is read back by the code under test.
"""
from datetime import timedelta
from uuid import uuid4

import pytest
from asgiref.sync import async_to_sync

from django.core.files.base import ContentFile
from django.db import connection
from django.utils import timezone

from procrastinate.contrib.django import app
from procrastinate.contrib.django.models import ProcrastinateJob

from dj.apps.jobs.models import QuarantinedJob
from dj.apps.uploads import tasks, video_utils
from dj.apps.uploads.models import GenericFile, ImageVariant

TASK = tasks.VIDEO_POSTER_TASK_NAME


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
        },
    }
    settings.MEDIA_ROOT = str(tmp_path)


@pytest.fixture
def cap(monkeypatch):
    """A small cap so the tests need few rows; the number is the contract."""
    monkeypatch.setattr(tasks, "VIDEO_POSTER_JOBS_PER_OWNER", 2)
    return 2


def _video(owner, name="clip.mp4"):
    return GenericFile.objects.create(
        owner=owner,
        file=ContentFile(b"not-really-mp4", name=name),
        mime_type="video/mp4",
    )


def _jobs(video, *statuses):
    jobs = ProcrastinateJob.objects.filter(
        task_name=TASK, args={"generic_file_id": video.pk},
    )
    if statuses:
        jobs = jobs.filter(status__in=statuses)
    return jobs


def _finish(video, status="succeeded"):
    """Move the video's job out of the lane the way a worker would.

    The Django model is read-only by design (procrastinate owns the table),
    so this is the SQL the worker's own finish would issue.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE procrastinate_jobs SET status = %s "
            "WHERE task_name = %s AND args->>'generic_file_id' = %s",
            [status, TASK, str(video.pk)],
        )


@pytest.mark.django_db(transaction=True)
def test_uploads_past_the_owner_s_cap_get_no_job_yet(creator_factory, cap):
    """The cap is per OWNER: a third video from one account waits, a first
    video from another account does not."""
    bulk, other = creator_factory(username="bulk"), creator_factory(username="other")

    first, second, third = (_video(bulk, f"{i}.mp4") for i in range(3))
    assert _jobs(first, "todo").count() == 1
    assert _jobs(first).get().scheduled_at > timezone.now(), (
        "initial upload admission retains the rollout delay"
    )
    assert _jobs(second, "todo").count() == 1
    assert not _jobs(third).exists(), (
        "the third upload was admitted past the cap"
    )

    theirs = _video(other)
    assert _jobs(theirs, "todo").count() == 1


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("mature_backlog", [True, False])
def test_a_finishing_job_tops_up_its_owner_s_lane(
    creator_factory, cap, monkeypatch, mature_backlog,
):
    """The waiting video is admitted the moment a slot is vacated -- by a
    poster that was stored AND by a video that turned out to have none.
    Fairness must not cost a bulk uploader throughput."""
    owner = creator_factory()
    admitted = [_video(owner, f"{i}.mp4") for i in range(cap)]
    waiting = _video(owner, "waiting.mp4")
    assert not _jobs(waiting).exists()

    if mature_backlog:
        completed_at = timezone.now() + tasks.VIDEO_POSTER_ROLLOUT_DELAY + timedelta(seconds=1)
        monkeypatch.setattr(timezone, "now", lambda: completed_at)

    # No poster for this one: terminal, and the slot is still given back.
    monkeypatch.setattr(video_utils, "extract_poster_bytes", lambda gf: None)
    tasks.generate_video_poster(generic_file_id=admitted[0].pk)

    assert _jobs(waiting, "todo").count() == 1
    scheduled_at = _jobs(waiting).get().scheduled_at
    if mature_backlog:
        assert scheduled_at <= timezone.now(), (
            "mature backlog must not wait another rollout delay"
        )
    else:
        assert scheduled_at >= waiting.created_at + tasks.VIDEO_POSTER_ROLLOUT_DELAY, (
            "fresh deferred uploads retain their original rollout grace"
        )


@pytest.mark.django_db(transaction=True)
def test_a_stored_poster_tops_up_too(creator_factory, cap, monkeypatch):
    owner = creator_factory()
    admitted = [_video(owner, f"{i}.mp4") for i in range(cap)]
    waiting = _video(owner, "waiting.mp4")

    monkeypatch.setattr(
        video_utils, "extract_poster_bytes",
        lambda gf: (b"RIFF....WEBPVP8 ", 16, 9),
    )
    tasks.generate_video_poster(generic_file_id=admitted[0].pk)

    assert ImageVariant.objects.filter(parent=admitted[0]).exists()
    assert _jobs(waiting, "todo").count() == 1


@pytest.mark.django_db(transaction=True)
def test_a_transient_failure_keeps_the_slot(creator_factory, cap, monkeypatch):
    """A job that will be retried still occupies its slot; topping up on it
    would let one owner exceed the cap by the width of their retries."""
    owner = creator_factory()
    admitted = [_video(owner, f"{i}.mp4") for i in range(cap)]
    waiting = _video(owner, "waiting.mp4")

    def _blip(generic_file):
        raise video_utils.PosterRetryable("decoder unreachable")

    monkeypatch.setattr(video_utils, "extract_poster_bytes", _blip)
    with pytest.raises(video_utils.PosterRetryable):
        tasks.generate_video_poster(generic_file_id=admitted[0].pk)

    assert not _jobs(waiting).exists()


@pytest.mark.django_db(transaction=True)
def test_the_sweep_readmits_waiting_videos_under_the_cap(creator_factory, cap):
    """The backstop for the top-up: a dead job, a missed on_commit, a worker
    that was killed mid-poster. Owner by owner, never past the cap."""
    owner = creator_factory()
    admitted = [_video(owner, f"{i}.mp4") for i in range(cap)]
    waiting = [_video(owner, f"waiting-{i}.mp4") for i in range(3)]
    assert not any(_jobs(v).exists() for v in waiting)

    # Nothing to admit while the lane is full.
    assert tasks.sweep_video_posters(timestamp=0) == 0

    _finish(admitted[0])
    assert tasks.sweep_video_posters(timestamp=0) == 1
    assert _jobs(waiting[0], "todo").count() == 1, "oldest first"
    assert not _jobs(waiting[1]).exists()

    _finish(admitted[1])
    _finish(waiting[0], status="failed")
    assert tasks.sweep_video_posters(timestamp=0) == 2
    assert _jobs(waiting[1], "todo").count() == 1
    assert _jobs(waiting[2], "todo").count() == 1

    # Idempotent: everything now has a job, in some state.
    assert tasks.sweep_video_posters(timestamp=0) == 0


@pytest.mark.django_db(transaction=True)
def test_the_sweep_never_re_attempts_a_video_that_had_a_job(creator_factory, cap):
    """`succeeded` with no poster is "undecodable", `failed` is "retries
    exhausted". Both are attempts. Re-demuxing a pathological file every ten
    minutes forever is the attack the cap exists to prevent."""
    owner = creator_factory()
    undecodable = _video(owner, "undecodable.mp4")
    exhausted = _video(owner, "exhausted.mp4")
    _finish(undecodable, "succeeded")
    _finish(exhausted, "failed")
    assert not ImageVariant.objects.filter(parent=undecodable).exists()

    assert tasks.sweep_video_posters(timestamp=0) == 0
    assert _jobs(undecodable).count() == 1
    assert _jobs(exhausted).count() == 1


@pytest.mark.django_db(transaction=True)
def test_admission_counts_nonterminal_jobs_until_terminal(
    creator_factory,
):
    """Requeueing a running job does not release its admission slot."""
    owner = creator_factory()
    stale_video = _video(owner, "stale.mp4")
    fresh_video = _video(owner, "fresh.mp4")
    stale_id = _jobs(stale_video).get().id
    fresh_id = _jobs(fresh_video).get().id
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE procrastinate_jobs SET status='doing' WHERE id = ANY(%s)",
            [[stale_id, fresh_id]],
        )
    assert tasks._live_poster_jobs_for_owner(owner.pk) == 2

    # Reclaiming it to todo still occupies the same slot.
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE procrastinate_jobs SET status='todo' WHERE id=%s",
            [stale_id],
        )
    assert tasks._live_poster_jobs_for_owner(owner.pk) == 2
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE procrastinate_jobs SET status='failed' WHERE id=%s",
            [stale_id],
        )
    assert tasks._live_poster_jobs_for_owner(owner.pk) == 1


@pytest.mark.django_db(transaction=True)
def test_sweep_readmits_all_failed_jobs_only_after_cooldown_and_below_ceiling(
    creator_factory, cap,
):
    owner = creator_factory()
    video = _video(owner, "retryable.mp4")
    original_id = _jobs(video).get().id
    failed_at = timezone.now() - tasks.VIDEO_POSTER_READMISSION_COOLDOWN - timedelta(seconds=1)
    with connection.cursor() as cursor:
        cursor.execute(
            # Reserve the complete normal-retry and worker-reclaim allowance.
            "UPDATE procrastinate_jobs SET status='failed', attempts=%s WHERE id=%s",
            [tasks.VIDEO_POSTER_READMISSION_MAX_RUNS, original_id],
        )
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO procrastinate_events (job_id, type, at) "
            "VALUES (%s, 'failed', %s)",
            [original_id, failed_at],
        )

    assert tasks.sweep_video_posters(timestamp=0) == 1
    rows = _jobs(video).order_by("id")
    assert list(rows.values_list("status", flat=True)) == ["failed", "todo"]


@pytest.mark.django_db(transaction=True)
def test_sweep_waits_for_readmission_cooldown(creator_factory, cap):
    owner = creator_factory()
    video = _video(owner, "recent-failure.mp4")
    job_id = _jobs(video).get().id
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE procrastinate_jobs SET status='failed', attempts=4 WHERE id=%s",
            [job_id],
        )
        cursor.execute(
            "INSERT INTO procrastinate_events (job_id, type, at) "
            "VALUES (%s, 'failed', %s)",
            [job_id, timezone.now() - timedelta(minutes=1)],
        )

    assert tasks.sweep_video_posters(timestamp=0) == 0
    assert _jobs(video).count() == 1


@pytest.mark.django_db(transaction=True)
def test_sweep_requires_every_historical_poster_job_to_be_failed(
    creator_factory, cap,
):
    owner = creator_factory()
    video = _video(owner, "mixed-history.mp4")
    failed_id = _jobs(video).get().id
    succeeded_id = tasks.generate_video_poster.configure(
        queueing_lock=f"poster-history-{video.pk}",
    ).defer(generic_file_id=video.pk)
    failed_at = timezone.now() - tasks.VIDEO_POSTER_READMISSION_COOLDOWN - timedelta(seconds=1)
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE procrastinate_jobs SET status='failed', attempts=4 "
            "WHERE id=%s",
            [failed_id],
        )
        cursor.execute(
            "UPDATE procrastinate_jobs SET status='succeeded', attempts=1 "
            "WHERE id=%s",
            [succeeded_id],
        )
        cursor.execute(
            "INSERT INTO procrastinate_events (job_id, type, at) "
            "VALUES (%s, 'failed', %s)",
            [failed_id, failed_at],
        )

    assert tasks.sweep_video_posters(timestamp=0) == 0
    assert _jobs(video).count() == 2


@pytest.mark.django_db(transaction=True)
def test_sweep_does_not_readmit_failed_jobs_at_attempt_ceiling(
    creator_factory, cap,
):
    owner = creator_factory()
    video = _video(owner, "exhausted.mp4")
    job_id = _jobs(video).get().id
    failed_at = timezone.now() - tasks.VIDEO_POSTER_READMISSION_COOLDOWN - timedelta(seconds=1)
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE procrastinate_jobs SET status='failed', attempts=%s WHERE id=%s",
            [tasks.VIDEO_POSTER_READMISSION_ATTEMPT_CEILING, job_id],
        )
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO procrastinate_events (job_id, type, at) "
            "VALUES (%s, 'failed', %s)",
            [job_id, failed_at],
        )

    assert tasks.sweep_video_posters(timestamp=0) == 0
    assert _jobs(video).count() == 1


@pytest.mark.django_db(transaction=True)
def test_sweep_does_not_automatically_readmit_reclaimer_quarantine(
    creator_factory, cap,
):
    owner = creator_factory()
    # Deliberately separate the GenericFile PK and Procrastinate job ID: the
    # quarantine FK is the latter, and a predicate comparing it to the video
    # PK would otherwise pass accidentally when fresh test sequences align.
    offset_ids = [
        tasks.generate_video_poster.configure(
            queueing_lock=f"quarantine-id-offset-{index}",
        ).defer(generic_file_id=-index)
        for index in (1, 2)
    ]
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE procrastinate_jobs SET status='failed' WHERE id = ANY(%s)",
            [offset_ids],
        )
    video = _video(owner, "quarantined.mp4")
    job_id = _jobs(video).get().id
    assert job_id != video.pk
    failed_at = timezone.now() - tasks.VIDEO_POSTER_READMISSION_COOLDOWN - timedelta(seconds=1)
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE procrastinate_jobs SET status='failed', attempts=%s WHERE id=%s",
            [tasks.VIDEO_POSTER_READMISSION_MAX_RUNS, job_id],
        )
        cursor.execute(
            "INSERT INTO procrastinate_events (job_id, type, at) "
            "VALUES (%s, 'failed', %s)",
            [job_id, failed_at],
        )
    QuarantinedJob.objects.create(
        job_id=job_id,
        task_name=TASK,
        queue="images",
        reason="test quarantine",
    )

    assert not tasks._posterless_videos_admissible(
        timezone.now() - tasks.VIDEO_POSTER_SWEEP_WINDOW,
    ).filter(pk=video.pk).exists()
    assert tasks.sweep_video_posters(timestamp=0) == 0
    assert _jobs(video).count() == 1


@pytest.mark.django_db(transaction=True)
def test_the_sweep_stays_inside_its_window(creator_factory, cap):
    """A video older than the window that never got a job belongs to the
    manual backfill, as before  -- not to every sweep for the life of
    the corpus."""
    owner = creator_factory()
    old = _video(owner, "old.mp4")
    with connection.cursor() as cursor:
        cursor.execute(
            "DELETE FROM procrastinate_jobs WHERE task_name = %s "
            "AND args->>'generic_file_id' = %s",
            [TASK, str(old.pk)],
        )
    GenericFile.objects.filter(pk=old.pk).update(
        created_at=timezone.now() - tasks.VIDEO_POSTER_SWEEP_WINDOW
        - timedelta(hours=1),
    )
    assert not _jobs(old).exists()

    assert tasks.sweep_video_posters(timestamp=0) == 0
    assert not _jobs(old).exists()


@pytest.mark.django_db(transaction=True)
def test_the_sweep_budget_bounds_one_run_across_owners(
    creator_factory, cap, monkeypatch,
):
    monkeypatch.setattr(tasks, "VIDEO_POSTER_SWEEP_BUDGET", 3)
    owners = [creator_factory(username=f"owner{i}") for i in range(3)]
    for owner in owners:
        for i in range(cap + 2):
            _video(owner, f"{i}.mp4")
        for video in GenericFile.objects.filter(owner=owner):
            _finish(video)
    # Every owner now has (cap + 2) - cap = 2 waiting videos; 6 in total.
    assert tasks.sweep_video_posters(timestamp=0) == 3
    assert tasks.sweep_video_posters(timestamp=0) == 3
    assert tasks.sweep_video_posters(timestamp=0) == 0


@pytest.mark.django_db(transaction=True)
def test_full_lanes_cannot_crowd_a_starved_owner_out_of_the_sweep(
    creator_factory, cap, monkeypatch,
):
    """The sweep used to pick its candidate owners BEFORE asking whether
    they had room: with more full lanes than budget, the same full owners
    filled the whole selection every run and enqueued nothing, while an
    owner behind them -- whose last job had exhausted its retries, which
    runs no completion top-up -- waited until its videos aged out of the
    window (codex adversarial review, round 3).

    Twelve owners with full lanes and one waiting video each, a budget of
    one, and two owners with room: the one whose waiting video is OLDEST
    is served first, the other on the next run, and the full lanes never
    consume the budget."""
    monkeypatch.setattr(tasks, "VIDEO_POSTER_SWEEP_BUDGET", 1)

    starved = creator_factory(username="starved")
    starved_videos = [_video(starved, f"{i}.mp4") for i in range(cap + 1)]
    for video in starved_videos[:cap]:
        _finish(video, status="failed")  # retries exhausted: no top-up ran
    starved_waiting = starved_videos[cap]
    assert not _jobs(starved_waiting).exists()

    full = [creator_factory(username=f"full{i}") for i in range(12)]
    for owner in full:
        for i in range(cap + 1):
            _video(owner, f"{i}.mp4")  # `cap` admitted, one waiting

    later = creator_factory(username="later")
    later_videos = [_video(later, f"{i}.mp4") for i in range(cap + 1)]
    for video in later_videos[:cap]:
        _finish(video)
    later_waiting = later_videos[cap]
    assert not _jobs(later_waiting).exists()

    assert tasks.sweep_video_posters(timestamp=0) == 1
    assert _jobs(starved_waiting, "todo").count() == 1, (
        "the owner whose video has waited longest goes first"
    )
    assert not _jobs(later_waiting).exists()

    assert tasks.sweep_video_posters(timestamp=0) == 1
    assert _jobs(later_waiting, "todo").count() == 1

    # The full lanes are exactly as full as they were: nothing past the cap.
    for owner in full:
        assert tasks._live_poster_jobs_for_owner(owner.pk) == cap

    assert tasks.sweep_video_posters(timestamp=0) == 0


@pytest.mark.django_db(transaction=True)
def test_racing_enqueues_collapse_onto_one_job(creator_factory):
    """A signal, a top-up and a sweep can all want the same video."""
    video = _video(creator_factory())
    assert _jobs(video, "todo").count() == 1
    assert tasks._defer_video_poster(video.pk) is False
    assert _jobs(video, "todo").count() == 1


def test_the_sweep_is_periodic_and_on_the_ordinary_lane():
    """Registered with a cron, on a queue the catch-all worker consumes --
    `py/dj/apps/jobs/test_queue_isolation.py` proves the second half."""
    task = app.tasks["uploads.sweep_video_posters"]
    assert task.queue == "images"
    periodic = {
        key[0]: value
        for key, value in app.periodic_registry.periodic_tasks.items()
    }
    assert "uploads.sweep_video_posters" in periodic
    assert periodic["uploads.sweep_video_posters"].cron == (
        tasks.VIDEO_POSTER_SWEEP_CRON
    )


@pytest.mark.django_db(transaction=True)
def test_concurrent_uploads_from_one_owner_cannot_beat_the_cap(
    creator_factory, cap,
):
    """Admission is count-then-enqueue. Eight uploads from one owner landing
    on eight web workers at once all used to see an empty lane and all get
    admitted (codex adversarial review: eight against a cap of four). The
    per-owner advisory lock makes each count+enqueue a critical section
    across connections; this races eight real threads on eight real
    connections through it."""
    import threading

    from django.db import connections

    owner = creator_factory()
    videos = [_video(owner, f"{i}.mp4") for i in range(8)]
    # The signal already admitted `cap` of them; race the admission itself
    # from a clean slate instead.
    with connection.cursor() as cursor:
        cursor.execute(
            "DELETE FROM procrastinate_jobs WHERE task_name = %s", [TASK],
        )

    barrier = threading.Barrier(len(videos))
    admitted = []
    errors = []

    def _upload(video):
        try:
            barrier.wait(timeout=30)
            if tasks.enqueue_video_poster(video.pk, owner.pk):
                admitted.append(video.pk)
        except Exception as exc:  # noqa: BLE001 - reported below
            errors.append(exc)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=_upload, args=(v,)) for v in videos]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)

    assert not errors, errors
    live = ProcrastinateJob.objects.filter(
        task_name=TASK, status="todo",
    ).count()
    assert len(admitted) == cap, f"{len(admitted)} admitted past a cap of {cap}"
    assert live == cap


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("lock_kind", ["owner", "job_insert"])
def test_upload_admission_lock_timeout_preserves_upload_for_sweep(
    creator_factory, monkeypatch, lock_kind,
):
    import threading

    from django.db import connections, transaction

    owner = creator_factory()
    monkeypatch.setattr(tasks, "POSTER_ADMISSION_LOCK_TIMEOUT_MS", 100)
    finished = threading.Event()
    result, errors = [], []

    def upload():
        try:
            result.append(_video(owner).pk)
        except Exception as exc:
            errors.append(exc)
        finally:
            finished.set()
            connections.close_all()

    with transaction.atomic():
        if lock_kind == "owner":
            tasks._admission_lock(owner.pk)
        else:
            with connection.cursor() as cursor:
                cursor.execute("LOCK TABLE procrastinate_jobs IN SHARE MODE")
        thread = threading.Thread(target=upload)
        thread.start()
        finished_while_locked = finished.wait(2)
    thread.join(timeout=5)
    assert finished_while_locked, "upload response waited for another transaction"
    assert not errors and len(result) == 1
    video = GenericFile.objects.get(pk=result[0])
    assert not _jobs(video).exists()
    assert tasks.top_up_video_posters(owner.pk) == 1
    assert _jobs(video, "todo").count() == 1


@pytest.mark.django_db(transaction=True)
def test_upload_admission_query_timeout_preserves_upload_for_sweep(
    creator_factory, monkeypatch,
):
    def slow_count(*_args, **_kwargs):
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_sleep(0.3)")
        return 0

    with monkeypatch.context() as patch:
        patch.setattr(tasks, "POSTER_ADMISSION_STATEMENT_TIMEOUT_MS", 50)
        patch.setattr(tasks, "_live_poster_jobs_for_owner", slow_count)
        video = _video(creator_factory())
    assert GenericFile.objects.filter(pk=video.pk).exists()
    assert not _jobs(video).exists()
    assert tasks.top_up_video_posters(video.owner_id) == 1
    assert _jobs(video, "todo").count() == 1


@pytest.mark.django_db(transaction=True)
def test_duplicate_admission_preserves_usable_transaction(creator_factory):
    video = _video(creator_factory())
    assert tasks.enqueue_video_poster(video.pk, video.owner_id) is False
    assert _jobs(video, "todo").count() == 1


@pytest.mark.django_db(transaction=True)
def test_sweep_candidate_query_timeout_retries_next_tick(creator_factory, monkeypatch):
    video = _video(creator_factory())
    with connection.cursor() as cursor:
        cursor.execute("DELETE FROM procrastinate_jobs WHERE task_name = %s", [TASK])
    original = tasks._posterless_videos_admissible
    with monkeypatch.context() as patch:
        patch.setattr(tasks, "POSTER_ADMISSION_STATEMENT_TIMEOUT_MS", 50)
        patch.setattr(
            tasks, "_posterless_videos_admissible",
            lambda since: original(since).extra(
                where=["(SELECT pg_sleep(0.3)) IS NOT NULL"],
            ),
        )
        patch.setattr(
            tasks, "top_up_video_posters",
            lambda *_args, **_kwargs: pytest.fail("timed-out selection reached top-up"),
        )
        assert tasks.sweep_video_posters(timestamp=0) == 0
    assert not _jobs(video).exists()
    assert tasks.sweep_video_posters(timestamp=1) == 1
    assert _jobs(video, "todo").count() == 1


@pytest.mark.django_db(transaction=True)
def test_sweep_and_waiting_owner_advance_during_bulk_owner_topups(
    creator_factory, cap, monkeypatch, request,
):
    """Use the actual database dequeue order while a bulk lane replenishes."""
    monkeypatch.setattr(tasks, "VIDEO_POSTER_ROLLOUT_DELAY", timedelta(0))
    queue = f"poster-fairness-{uuid4().hex[:12]}"
    def clean_queue():
        # Procrastinate's unmanaged tables survive Django's per-test flush.
        with connection.cursor() as cursor:
            cursor.execute("DELETE FROM procrastinate_jobs WHERE queue_name=%s", [queue])

    request.addfinalizer(clean_queue)
    monkeypatch.setattr(tasks.generate_video_poster, "queue", queue)
    monkeypatch.setattr(tasks.sweep_video_posters, "queue", queue)
    bulk = creator_factory(username="bulk-fairness")
    other = creator_factory(username="other-fairness")
    bulk_videos = [_video(bulk, f"bulk-{i}.mp4") for i in range(6)]
    waiting = _video(other, "waiting.mp4")
    # Model an upload whose admission timed out and relies on the backstop.
    with connection.cursor() as cursor:
        cursor.execute("DELETE FROM procrastinate_jobs WHERE id=%s",
                       [_jobs(waiting).get().id])
    periodic = next(
        value for key, value in app.periodic_registry.periodic_tasks.items()
        if key[0] == "uploads.sweep_video_posters"
    )
    sweep_id = periodic.task.configure(**periodic.configure_kwargs).defer(timestamp=0)
    worker_id = async_to_sync(app.job_manager.register_worker)()
    request.addfinalizer(
        lambda: async_to_sync(app.job_manager.unregister_worker)(worker_id),
    )

    def fetch():
        return async_to_sync(app.job_manager.fetch_job)(
            queues=[queue], worker_id=worker_id,
        )

    # Each completed bulk job immediately refills its own lane. The already
    # queued sweep must run before those newer jobs, despite sustained demand.
    for video in bulk_videos[:2]:
        assert fetch().id == _jobs(video).get().id
        _finish(video)
        tasks._top_up_after_poster_job(video)
    assert fetch().id == sweep_id
    assert tasks.sweep_video_posters(timestamp=0) == 1
    waiting_id = _jobs(waiting, "todo").get().id

    # Sweep-admitted ordinary user work also keeps its FIFO place when the
    # bulk owner's next completions admit still more work.
    for video in bulk_videos[2:4]:
        assert fetch().id == _jobs(video).get().id
        _finish(video)
        tasks._top_up_after_poster_job(video)
    assert fetch().id == waiting_id
    assert sum(_jobs(video, "todo").count() for video in bulk_videos[4:]) == 2
