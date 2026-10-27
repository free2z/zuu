"""Requeue incomplete multilingual indexing work after a worker rollout.

The ``SearchIndex`` row is deliberately not used as a completeness marker:
an old worker can successfully write a canonical-only vector while a page has
published translations. Reconciliation is therefore limited to pages whose
latest multilingual indexing job has not succeeded. That keeps a successful
deployment from paying to re-embed the entire multilingual corpus while still
repairing work stranded by a rollback. The task reads the current publication
state when it runs, so a failed job is also enough to scrub a translation
unpublished during the bad window.

An active page with published translation content but no retained multilingual
job row is also a reconciliation candidate. ``procrastinate_jobs`` retention
must therefore either preserve these rows or accept a repair pass for every
such page; the count is emitted as ``pages_without_retained_job`` so retention
cannot turn missing history into an unobservable zero-candidate success.
``candidate_pages`` is a point-in-time database count of the rows selected by
the same query that is streamed for enqueueing; it is not a promise that the
set will remain unchanged while the command runs. With ``--limit``, it reports
the bounded pass size rather than the unbounded query's total.

The task arguments stay exactly the stable ``search.index_multilingual_zpage``
contract. The deployment/run marker is carried in Procrastinate's ``lock``
column, which workers use for scheduling but do not pass to the task. This is
important during rollback: a worker from the preceding release can consume
the job without receiving a keyword that its task signature does not know.
"""
import json
import logging
import os

from django.core.management.base import BaseCommand, CommandError
from django.db.models import (
    CharField,
    Count,
    Exists,
    OuterRef,
    Q,
    Subquery,
    Window,
)
from django.db.models.fields.json import KeyTextTransform
from django.db.models.functions import Cast

from procrastinate.contrib.django.models import ProcrastinateJob
from procrastinate.exceptions import AlreadyEnqueued

from dj.apps.g12f.models import ZPageTranslation, ZPageVariant, zPage
from dj.apps.search.tasks import index_multilingual_zpage


logger = logging.getLogger(__name__)
RECONCILIATION_EVENT = "search_multilingual_reconciliation"
RECONCILIATION_TASK = "search.index_multilingual_zpage"
QUEUEING_LOCK_PREFIX = "multilingual-zpage"
RECONCILIATION_LOCK_PREFIX = "multilingual-reconciliation"
DEFAULT_BATCH_SIZE = 500
JOB_STATES_THAT_PROVE_PROGRESS = ("todo", "doing", "succeeded")
JOB_STATES_THAT_ARE_PENDING = ("todo",)
JOB_STATES_THAT_NEED_RECONCILIATION = ("todo", "doing", "failed")


def _emit(status, reconciliation_id, **details):
    payload = {
        "event": RECONCILIATION_EVENT,
        "status": status,
        "reconciliation_id": reconciliation_id,
    }
    payload.update(details)
    message = json.dumps(payload, sort_keys=True)
    (logger.error if status == "failed" else logger.info)(message)


def _queueing_lock(page_id):
    return f"{QUEUEING_LOCK_PREFIX}-{page_id}"


def _reconciliation_lock(reconciliation_id, page_id):
    return f"{RECONCILIATION_LOCK_PREFIX}:{reconciliation_id}:{page_id}"


class Command(BaseCommand):
    help = (
        "Requeue multilingual indexing jobs that did not complete so the "
        "current worker can rebuild their search vectors."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--reconciliation-id",
            default=os.environ.get("SEARCH_RECONCILIATION_ID", ""),
            help=(
                "Unique deployment/run identifier. Required for the deploy "
                "path; use a fresh value when intentionally rerunning."
            ),
        )
        parser.add_argument(
            "--batch-size",
            type=int,
            default=DEFAULT_BATCH_SIZE,
            help=f"Page IDs fetched per DB batch (default {DEFAULT_BATCH_SIZE}).",
        )
        parser.add_argument(
            "--limit",
            type=int,
            default=None,
            help="Maximum pages to examine (for a bounded manual trial).",
        )

    def handle(self, *args, **options):
        reconciliation_id = options["reconciliation_id"].strip()
        batch_size = options["batch_size"]
        limit = options["limit"]
        if not reconciliation_id:
            raise CommandError("--reconciliation-id is required")
        if len(reconciliation_id) > 128:
            raise CommandError("--reconciliation-id must be at most 128 characters")
        if batch_size < 1:
            raise CommandError("--batch-size must be at least 1")
        if limit is not None and limit < 1:
            raise CommandError("--limit must be at least 1 when supplied")

        stats = {
            "candidate_pages": 0,
            "pages_without_retained_job": 0,
            "examined": 0,
            "enqueued": 0,
            "already_done": 0,
            "already_queued": 0,
        }
        try:
            self._run(reconciliation_id, batch_size, limit, stats)
        except Exception as exc:
            _emit(
                "failed",
                reconciliation_id,
                **stats,
                error_type=type(exc).__name__,
                error_message=str(exc)[:500],
            )
            raise

    def _run(self, reconciliation_id, batch_size, limit, stats):
        published_translation = ZPageTranslation.objects.filter(
            zpage_id=OuterRef("pk"),
            is_published=True,
        )
        published_variant = ZPageVariant.objects.filter(
            zpage_id=OuterRef("pk"),
            is_published=True,
        ).exclude(origin=ZPageVariant.SOURCE)
        latest_multilingual_job = ProcrastinateJob.objects.filter(
            task_name=RECONCILIATION_TASK,
        ).annotate(
            zpage_id_text=KeyTextTransform("zpage_id", "args"),
        ).filter(
            zpage_id_text=Cast(OuterRef("pk"), output_field=CharField()),
        ).order_by("-id")
        # KeyTextTransform binds the JSON key as a parameter. The count and
        # candidate queries each run once per invocation, staying below
        # psycopg's prepare threshold so PostgreSQL can choose a custom plan
        # for the expression index from jobs migration 0002. Revisit this if
        # it becomes a hot path.
        eligible_pages = zPage.objects.filter(
            is_published=True,
            creator__is_active=True,
        ).annotate(
            latest_multilingual_status=Subquery(
                latest_multilingual_job.values("status")[:1]
            ),
            has_published_translation=Exists(published_translation),
            has_published_variant=Exists(published_variant),
        )
        stats["pages_without_retained_job"] = eligible_pages.filter(
            latest_multilingual_status__isnull=True,
        ).filter(
            Q(has_published_translation=True) | Q(has_published_variant=True),
        ).count()
        pages = eligible_pages.filter(
            Q(latest_multilingual_status__in=JOB_STATES_THAT_NEED_RECONCILIATION)
            | Q(
                latest_multilingual_status__isnull=True,
            ) & (
                Q(has_published_translation=True)
                | Q(has_published_variant=True)
            )
        ).annotate(
            candidate_page_count=Window(Count("pk")),
        ).order_by("pk").values("pk", "candidate_page_count")
        if limit is not None:
            pages = pages[:limit]

        page_iterator = iter(pages.iterator(chunk_size=batch_size))
        first_page = next(page_iterator, None)
        if first_page is not None:
            stats["candidate_pages"] = first_page["candidate_page_count"]
            if limit is not None:
                stats["candidate_pages"] = min(stats["candidate_pages"], limit)
        _emit(
            "started",
            reconciliation_id,
            candidate_pages=stats["candidate_pages"],
            pages_without_retained_job=stats["pages_without_retained_job"],
            batch_size=batch_size,
        )

        batch = []
        if first_page is not None:
            batch.append(first_page["pk"])
        for page in page_iterator:
            batch.append(page["pk"])
            if len(batch) == batch_size:
                self._enqueue_batch(batch, reconciliation_id, stats)
                batch = []
        if batch:
            self._enqueue_batch(batch, reconciliation_id, stats)

        _emit("completed", reconciliation_id, **stats)
        self.stdout.write(
            self.style.SUCCESS(
                f"Reconciled {stats['examined']} multilingual zPages: "
                f"enqueued {stats['enqueued']}, "
                f"already complete {stats['already_done']}, "
                f"already queued {stats['already_queued']}."
            )
        )

    def _enqueue_batch(self, page_ids, reconciliation_id, stats):
        reconciliation_locks = {
            page_id: _reconciliation_lock(reconciliation_id, page_id)
            for page_id in page_ids
        }
        queueing_locks = {
            page_id: _queueing_lock(page_id) for page_id in page_ids
        }

        completed_or_pending = set(
            ProcrastinateJob.objects.filter(
                task_name=RECONCILIATION_TASK,
                lock__in=reconciliation_locks.values(),
                status__in=JOB_STATES_THAT_PROVE_PROGRESS,
            ).values_list("lock", flat=True)
        )
        pending_queueing_locks = set(
            ProcrastinateJob.objects.filter(
                task_name=RECONCILIATION_TASK,
                queueing_lock__in=queueing_locks.values(),
                status__in=JOB_STATES_THAT_ARE_PENDING,
            ).values_list("queueing_lock", flat=True)
        )

        for page_id in page_ids:
            stats["examined"] += 1
            reconciliation_lock = reconciliation_locks[page_id]
            queueing_lock = queueing_locks[page_id]
            if reconciliation_lock in completed_or_pending:
                stats["already_done"] += 1
                continue
            if queueing_lock in pending_queueing_locks:
                # A normal publish/edit job or another reconciliation already
                # owns the stable per-page queueing lock. It reads current DB
                # state when it runs, so it is valid repair work.
                stats["already_queued"] += 1
                continue
            try:
                # Do not add reconciliation_id to task kwargs. The stable
                # task is consumed by workers from both sides of a rollout;
                # lock is Procrastinate metadata, not a callable argument.
                index_multilingual_zpage.configure(
                    lock=reconciliation_lock,
                    queueing_lock=queueing_lock,
                ).defer(zpage_id=page_id)
            except AlreadyEnqueued:
                # A concurrent publish/edit/reconciliation won the unique
                # queueing-lock race. Its task also reads current state.
                stats["already_queued"] += 1
            else:
                stats["enqueued"] += 1
                pending_queueing_locks.add(queueing_lock)
                completed_or_pending.add(reconciliation_lock)


__all__ = [
    "Command",
    "RECONCILIATION_EVENT",
    "RECONCILIATION_TASK",
    "_reconciliation_lock",
    "_queueing_lock",
]
