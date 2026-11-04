"""
One-shot backfill: enqueue `generate_video_poster` for every existing video
upload that has no poster yet.

The Google Search Console report that motivated this is about videos that
are ALREADY published, so the new-upload signal alone closes nothing. Run
this once after the release that adds `av` to the image reaches production:

    python dj/free2z/manage.py backfill_video_posters --dry-run    # how big?
    python dj/free2z/manage.py backfill_video_posters --limit 50 \
        --rate 40 --max-inflight 100   # first slice
    python dj/free2z/manage.py backfill_video_posters --all \
        --rate 40 --max-inflight 100   # mean it
    python dj/free2z/manage.py backfill_video_posters --retry-terminal \
        --limit 50 --rate 40 --max-inflight 100  # selected old failures

Run it as a detached `Job`, never `kubectl exec` -- a deploy drains the pod
and kills a long-running exec with exit 137 (docs/agent-operations.md).

**Pace it.** `image-variant-worker` is the CATCH-ALL procrastinate worker
(`QUEUES=""`, concurrency 1), so every job this enqueues is ahead of, and
competing with, live work: notifications, translation, search indexing, blob
cleanup. Each poster job downloads a whole video and decodes a frame, so a
few thousand of them is hours of wall clock. Two things keep that from
becoming an outage:

  * jobs are deferred at the named `BACKFILL` priority, below every other
    priority class, so interactive, default, background and maintenance work
    is fetched ahead of the backlog; and
  * a bound is REQUIRED: `--limit N` or an explicit `--all`. Leaving the
    option off used to mean "the entire corpus", which made the shortest
    command the most dangerous one; and
  * `--rate N` spaces jobs into the future and `--max-inflight M` limits this
    invocation's additions against the live-job count read at the start of
    each serialized batch. Concurrent uploads and sweep top-ups can add jobs
    during a batch, so this is an operator pacing bound rather than a global
    hard cap. Both options are mandatory when enqueueing.
    Successive slices extend the latest persisted BACKFILL schedule, and a
    database lock serializes simultaneous invocations.

Start with `--dry-run` to see the size, then a small `--limit`.

This command deliberately BYPASSES the per-owner admission cap that the
upload path and the periodic sweep honour (`VIDEO_POSTER_JOBS_PER_OWNER`,
). Its snapshot in-flight allowance and rate limit keep the operator
path bounded. Concurrent upload and sweep producers can exceed that
allowance while this command is running. While a backfill slice is queued,
live uploads from the same owners may be held back to the top-up/sweep --
that is the per-owner cap working, not a bug.

Videos with any existing poster job are skipped, so a restarted or repeated
command does not create duplicate jobs. A video whose poster job fails is
eligible for a new job after the sweep's cooldown, only when all of its
poster jobs failed, it remains inside the sweep window, and its cumulative
execution budget has room for another complete retry cycle. Early-failing
cycles can therefore permit more than one readmission within that budget. Older or mixed-history failures remain
terminal for automatic admission and can be reviewed through the jobs
operator interface.

Use `--retry-terminal` only for an explicit operator repair after fixing a
decoder/storage issue. It selects old videos without a variant whose poster
history consists only of terminal `failed` or `succeeded` jobs, refuses live
or unknown statuses, and observes the same per-video deduplication, rate and
inflight bounds. The same cumulative execution ceiling limits repeated repair
runs. `schedule_at` preserves not-before timestamps across process restarts;
it cannot enforce a runtime rate after worker downtime makes older jobs overdue
and due together. `--max-inflight` is checked before each committed batch and
bounds the backfill's snapshot allowance in that case; uploads and sweep
top-ups can still enqueue concurrently between those checks. These scheduling
and admission limits do not bound command wall time: a batch can wait for
advisory locks or database queries.
"""
from datetime import timedelta
import math

from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from django.db.models import Exists, Max, OuterRef, Subquery, Sum, TextField
from django.db.models.fields.json import KeyTextTransform
from django.db.models.functions import Cast
from django.utils import timezone
from procrastinate.contrib.django.models import ProcrastinateJob

from dj.apps.jobs.admission import live_job_rows
from dj.apps.jobs.priorities import BACKFILL
from dj.apps.uploads.models import (
    VIDEO_MIME_TYPE_VALUES,
    GenericFile,
    ImageVariant,
)
from dj.apps.uploads.tasks import (
    VIDEO_POSTER_READMISSION_ATTEMPT_CEILING,
    VIDEO_POSTER_READMISSION_MAX_RUNS,
    VIDEO_POSTER_TASK_NAME,
    _admission_lock,
    generate_video_poster,
)
from procrastinate.exceptions import AlreadyEnqueued

BACKFILL_PRIORITY = BACKFILL
BACKFILL_ADMISSION_LOCK_CLASS = 157_501
BACKFILL_TERMINAL_STATUSES = ("failed", "succeeded")


class Command(BaseCommand):
    help = (
        "Enqueue poster-frame extraction for video uploads that have no "
        "poster yet (all access levels; the poster inherits the video's)."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--batch-size", type=int, default=500,
            help="IDs fetched per DB batch (default 500)",
        )
        # ONE OF THESE IS REQUIRED. `--limit` used to default to "no limit",
        # so the first command in the module docstring was also the most
        # dangerous one available: it enqueues the entire corpus onto a
        # concurrency-1 worker, each item downloading up to MAX_SOURCE_BYTES
        # before a bounded decode. An unbounded run should be something an
        # operator explicitly requests, not what they get by leaving an option
        # off.
        # Not `required=True` on the group: `--dry-run` alone must keep
        # working, and it enqueues nothing. The requirement is enforced in
        # handle() for the runs that actually defer jobs.
        group = parser.add_mutually_exclusive_group()
        group.add_argument(
            "--limit", type=int,
            help="Max number of jobs to enqueue. Start small.",
        )
        group.add_argument(
            "--all", action="store_true",
            help=(
                "Enqueue the WHOLE corpus. Prefer repeated --limit slices; "
                "this is idempotent, so slices resume where the last left off."
            ),
        )
        parser.add_argument(
            "--dry-run", action="store_true",
            help="Count what would be enqueued and stop.",
        )
        parser.add_argument(
            "--rate", type=float,
            help="Maximum scheduling rate in jobs per minute (required to enqueue).",
        )
        parser.add_argument(
            "--max-inflight", type=int,
            help=(
                "Maximum pending/running poster jobs observed before each "
                "batch (required to enqueue)."
            ),
        )
        parser.add_argument(
            "--retry-terminal", action="store_true",
            help=(
                "Explicitly include old videos whose poster jobs are all "
                "terminal (failed/succeeded without a variant), within the "
                "same cumulative attempt ceiling."
            ),
        )

    def handle(self, *args, **options):
        batch_size = options["batch_size"]
        limit = options["limit"]
        rate = options["rate"]
        max_inflight = options["max_inflight"]
        if not options["dry_run"] and limit is None and not options["all"]:
            raise CommandError(
                "refusing to enqueue an unbounded backfill. Pass --limit N "
                "(start small; the command is idempotent, so slices resume "
                "where the last one stopped), or --all to mean it. "
                "--dry-run needs neither."
            )
        if not options["dry_run"] and (rate is None or max_inflight is None):
            raise CommandError(
                "refusing to enqueue without both --rate N and --max-inflight M; "
                "--dry-run needs neither"
            )
        if rate is not None and (not math.isfinite(rate) or rate <= 0):
            raise CommandError("--rate must be a finite number greater than zero")
        if max_inflight is not None and max_inflight <= 0:
            raise CommandError("--max-inflight must be greater than zero")

        poster_jobs = ProcrastinateJob.objects.filter(
            task_name=VIDEO_POSTER_TASK_NAME,
        ).annotate(
            video_id_text=KeyTextTransform("generic_file_id", "args"),
        ).filter(
            video_id_text=Cast(OuterRef("pk"), TextField()),
        )
        terminal_jobs = poster_jobs.filter(
            status__in=BACKFILL_TERMINAL_STATUSES,
        )
        prior_executions = Subquery(
            terminal_jobs.order_by().values("video_id_text").annotate(
                # Terminal rows' attempts already include their final run.
                executions=Sum("attempts"),
            ).values("executions")[:1],
        )
        queryset = GenericFile.objects.filter(
            mime_type__in=sorted(VIDEO_MIME_TYPE_VALUES),
        ).annotate(
            has_variants=Exists(
                ImageVariant.objects.filter(parent=OuterRef("pk"))
            ),
        ).filter(
            has_variants=False,
        ).annotate(
            has_poster_job=Exists(poster_jobs),
            has_nonterminal_job=Exists(
                poster_jobs.exclude(status__in=BACKFILL_TERMINAL_STATUSES),
            ),
            prior_executions=prior_executions,
        )
        if options["retry_terminal"]:
            queryset = queryset.filter(
                has_poster_job=True,
                has_nonterminal_job=False,
                prior_executions__lte=(
                    VIDEO_POSTER_READMISSION_ATTEMPT_CEILING
                    - VIDEO_POSTER_READMISSION_MAX_RUNS
                ),
            )
        else:
            queryset = queryset.filter(has_poster_job=False)
        queryset = queryset.order_by("pk").values_list("pk", "owner_id")

        if options["dry_run"]:
            missing = queryset.count()
            total = missing if limit is None else min(missing, limit)
            self.stdout.write(self.style.WARNING(
                f"--dry-run: would enqueue {total} generate_video_poster jobs"
            ))
            return

        self._enqueue_slice(
            queryset, batch_size=batch_size, limit=limit, rate=rate,
            max_inflight=max_inflight,
            retry_terminal=options["retry_terminal"],
        )

    def _enqueue_slice(
            self, queryset, *, batch_size, limit, rate, max_inflight,
            retry_terminal):
        enqueued = 0
        last_pk = None
        reported_eligible = False
        while limit is None or enqueued < limit:
            # Each short transaction serializes a bounded batch. It commits
            # owner locks promptly so one large backfill cannot block upload
            # admission for every owner it has already visited. A competing
            # backfill sees the committed jobs and persisted schedule tail
            # before reserving its own batch.
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT pg_advisory_xact_lock(%s, %s)",
                        [BACKFILL_ADMISSION_LOCK_CLASS, 0],
                    )

                page = queryset
                if last_pk is not None:
                    page = page.filter(pk__gt=last_pk)
                missing = page.count()
                remaining_limit = (
                    None if limit is None else limit - enqueued
                )
                eligible = (
                    missing if remaining_limit is None
                    else min(missing, remaining_limit)
                )
                if not reported_eligible:
                    self.stdout.write(f"Videos eligible for posters: {missing}")
                    if limit is not None:
                        self.stdout.write(f"Limiting to {eligible + enqueued}")
                    reported_eligible = True

                inflight = live_job_rows(VIDEO_POSTER_TASK_NAME).count()
                if inflight >= max_inflight:
                    if enqueued == 0:
                        raise CommandError(
                            f"refusing to enqueue: {inflight} poster jobs are "
                            f"already pending/running (max-inflight {max_inflight})"
                        )
                    self.stdout.write(
                        "Max inflight reached during this run; rerun after "
                        "the queue drains to continue."
                    )
                    break

                capacity = max_inflight - inflight
                batch_size_now = min(batch_size, eligible, capacity)
                if batch_size_now <= 0:
                    break
                batch = list(page[:batch_size_now])
                if not batch:
                    break

                now = timezone.now()
                scheduled_tail = ProcrastinateJob.objects.filter(
                    task_name=VIDEO_POSTER_TASK_NAME,
                    status="todo",
                    priority=BACKFILL_PRIORITY,
                    scheduled_at__gt=now,
                ).aggregate(tail=Max("scheduled_at"))["tail"]
                start_at = max(now, scheduled_tail) if scheduled_tail else now
                interval = 60.0 / rate
                scheduled_count = len(batch)
                spacing = (
                    # Keep the batch at least N rate intervals wide after
                    # timestamp rounding; this is slightly slower than the
                    # requested maximum rate, never faster.
                    interval * (scheduled_count + 0.01) / (scheduled_count - 1)
                    if scheduled_count > 1 else interval
                )
                batch_enqueued = 0
                for pk, owner_id in batch:
                    # This is the same owner lock used by upload admission and
                    # sweep top-ups. Recheck under it because a producer may
                    # have committed after this batch selected its candidates.
                    _admission_lock(owner_id)
                    if ImageVariant.objects.filter(parent_id=pk).exists():
                        continue
                    history = ProcrastinateJob.objects.filter(
                        task_name=VIDEO_POSTER_TASK_NAME,
                        args__generic_file_id=pk,
                    )
                    if retry_terminal:
                        prior_attempts = history.filter(
                            status__in=BACKFILL_TERMINAL_STATUSES,
                        ).aggregate(total=Sum("attempts"))["total"] or 0
                        eligible_history = (
                            history.exists()
                            and not history.exclude(
                                status__in=BACKFILL_TERMINAL_STATUSES,
                            ).exists()
                            and prior_attempts <= (
                                VIDEO_POSTER_READMISSION_ATTEMPT_CEILING
                                - VIDEO_POSTER_READMISSION_MAX_RUNS
                            )
                        )
                    else:
                        eligible_history = not history.exists()
                    if not eligible_history:
                        continue
                    try:
                        with transaction.atomic():
                            generate_video_poster.configure(
                                priority=BACKFILL_PRIORITY,
                                queueing_lock=f"video-poster-{pk}",
                                schedule_at=start_at + timedelta(
                                    seconds=(batch_enqueued + 1) * spacing,
                                ),
                            ).defer(generic_file_id=pk)
                    except AlreadyEnqueued:
                        # The queueing lock is the final guard for an upload
                        # or sweep producer that won a status transition race.
                        continue
                    enqueued += 1
                    batch_enqueued += 1
                last_pk = batch[-1][0]

            self.stdout.write(f"  enqueued {enqueued} poster job(s) so far")

        self.stdout.write(self.style.SUCCESS(
            f"Enqueued {enqueued} generate_video_poster jobs"
        ))
