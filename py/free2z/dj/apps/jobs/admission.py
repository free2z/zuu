"""Count poster jobs that still occupy per-owner admission capacity."""

from procrastinate.contrib.django.models import ProcrastinateJob


def live_job_rows(task):
    """Return all queued, running, or aborting rows for an admitted task.

    Keep a ``doing`` row in the cap until it is terminal. A stale lease makes
    the reclaimer eligible to move the row; it does not guarantee when that
    requeue happens, so releasing its slot earlier could exceed the cap.
    """
    task_name = getattr(task, "task_name", task)
    if task_name != "uploads.generate_video_poster":
        raise ValueError(f"owner admission is not defined for task {task_name!r}")

    return ProcrastinateJob.objects.filter(
        task_name=task_name,
        status__in=("todo", "doing", "aborting"),
    )


def live_jobs_for(task, owner_key, *, exclude_key=None):
    """Count pending, running, or aborting jobs for an upload owner.

    ``owner_key`` is the GenericFile owner ID encoded indirectly by the task's
    ``generic_file_id`` argument. Every nonterminal status occupies a slot
    through recovery so a lease timeout cannot make room for a job that the
    reclaimer may shortly requeue.
    """
    from dj.apps.uploads.models import GenericFile
    from django.db.models import TextField
    from django.db.models.fields.json import KeyTextTransform
    from django.db.models.functions import Cast

    from dj.apps.uploads.models import VIDEO_MIME_TYPE_VALUES

    owned = GenericFile.objects.filter(
        owner_id=owner_key,
        mime_type__in=sorted(VIDEO_MIME_TYPE_VALUES),
    ).annotate(
        pk_text=Cast("pk", TextField()),
    ).values("pk_text")
    jobs = live_job_rows(task).annotate(
        video_id_text=KeyTextTransform("generic_file_id", "args"),
    ).filter(video_id_text__in=owned)
    if exclude_key is not None:
        jobs = jobs.exclude(video_id_text=str(exclude_key))

    return jobs.count()
