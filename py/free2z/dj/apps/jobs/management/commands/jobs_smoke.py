"""Send a real probe through every selected worker queue and record its result.

Usage: manage.py jobs_smoke --commit SHA --queues QUEUE[,QUEUE...] [--timeout 120]

Exit 0 confirms every probe succeeded on a worker reporting the selected
BUILD_SHA and the diagnostic cache acknowledged the result. Exit 10 means an
observed terminal probe failure. Exit 2 indicates invalid usage; exit 3 means
an inconclusive attempt or an unacknowledged diagnostic record. Pending probes
cannot distinguish an unserved queue from a busy consumer.

Supply deployment queue coverage explicitly. Without --queues, an optional
private deployment checkout must provide the legacy worker manifest. The
command refuses an absent or empty manifest instead of guessing coverage.
"""
from __future__ import annotations

import sys

from django.core.management.base import BaseCommand, CommandError
from django.db import DatabaseError
from procrastinate.exceptions import ConnectorException

from dj.apps.jobs import smoke


class Command(BaseCommand):
    help = ('Defer jobs.smoke_probe onto every worker queue and wait for '
            'all of them to succeed on the given commit.')

    def add_arguments(self, parser):
        parser.add_argument('--namespace', default=None, help='Required deployed namespace stamp, checked before recording.')
        parser.add_argument(
            '--commit', required=True,
            help='The 40-hex commit the workers must report as BUILD_SHA '
                 '(or "dev" for an unstamped local process).')
        parser.add_argument(
            '--timeout', type=float, default=120.0,
            help='Seconds to wait for every probe to be consumed '
                 '(default 120).')
        parser.add_argument(
            '--queues', default=None,
            help='Comma-separated queue list (the manifest union). Default: '
                 'read k8s/free2z/worker/BUILD.bazel from this checkout.')
        parser.add_argument(
            '--poll-seconds', type=float, default=1.0,
            help='How often to re-read the probe rows (default 1).')

    def handle(self, *args, **options):
        commit = options['commit']
        if not smoke.is_commit(commit):
            raise CommandError(
                f'--commit must be 40 lowercase hex characters or "dev", '
                f'got {commit!r}')
        if options['timeout'] <= 0:
            raise CommandError('--timeout must be positive')

        if options['queues']:
            queues = smoke.split_queues(options['queues'])
            if not queues:
                raise CommandError('--queues named no queue')
        else:
            build_file = smoke.repo_root_from() / smoke.WORKER_BUILD_RELATIVE
            try:
                queues = smoke.manifest_queue_union(build_file)
            except (FileNotFoundError, ValueError) as exc:
                raise CommandError(
                    f'cannot read the worker manifest union from '
                    f'{build_file} ({exc}); pass --queues explicitly') from exc

        self.stdout.write(
            f'jobs_smoke: commit={commit} queues={",".join(sorted(queues))} '
            f'timeout={options["timeout"]:g}s')
        try:
            namespace = smoke.stamped_namespace()
            if options['namespace'] is not None and options['namespace'] != namespace:
                raise smoke.SmokeRecordError('requested namespace does not match NAMESPACE stamp')
            attempt = smoke.record_result(commit, queues, ok=None, missing=queues)
        except smoke.SmokeRecordError as exc:
            self.stderr.write(f'jobs_smoke: INCONCLUSIVE -- {exc}')
            sys.exit(3)
        try:
            outcome = smoke.run_smoke(
                commit, queues,
                timeout_seconds=options['timeout'],
                poll_seconds=options['poll_seconds'],
            )
        except (DatabaseError, ConnectorException) as exc:
            # The acknowledged start remains inconclusive. A database failure
            # cannot attest that a worker probe reached a terminal failure.
            self.stderr.write(f'jobs_smoke: INCONCLUSIVE -- database operation failed: {exc}')
            sys.exit(3)
        for queue in outcome.queues:
            if queue in outcome.succeeded:
                state = 'succeeded'
            elif queue in outcome.failed:
                state = 'FAILED (consumed, but not by a worker on this commit)'
            elif queue in outcome.busy:
                other = outcome.busy[queue]
                state = (f'BUSY (a worker is mid-job on this lane: '
                         f'job={other["job_id"]} task={other["task"]}; '
                         'inconclusive, not dead)')
            else:
                state = 'PENDING (consumer availability is unproven; inconclusive)'
            self.stdout.write(
                f'  {queue:<20} job={outcome.job_ids[queue]:<8} {state}')

        if outcome.ok:
            try:
                result = smoke.record_result(commit, outcome.queues, attempt_id=attempt.attempt_id)
            except smoke.SmokeRecordError as exc:
                self.stderr.write(
                    f'jobs_smoke: every lane consumed commit {commit}, but '
                    f'the result could NOT be recorded: {exc}. The promotion '
                    'check will not see this run; fix the cache and re-run.')
                sys.exit(3)
            self.stdout.write(
                f'jobs_smoke: OK -- every lane consumed commit {commit} in '
                f'{outcome.elapsed_seconds:.1f}s; recorded at {result.at}')
            return

        busy = ', '.join(
            f'{q} (job={v["job_id"]} task={v["task"]})'
            for q, v in sorted(outcome.busy.items()))
        missing = sorted(outcome.failed)
        if not missing:
            try:
                smoke.record_result(commit, outcome.queues, ok=None,
                                    missing=outcome.pending, attempt_id=attempt.attempt_id)
            except smoke.SmokeRecordError as exc:
                self.stderr.write(f'jobs_smoke: INCONCLUSIVE -- {exc}')
                sys.exit(3)
            # Queue-local activity cannot establish whether a shared worker
            # is occupied elsewhere. Do not persist an invented dead-lane verdict.
            self.stderr.write(
                f'jobs_smoke: INCONCLUSIVE -- probes still pending after '
                f'{options["timeout"]:g}s: {sorted(outcome.pending)}. '
                f'Observed same-lane work: {busy or "none"}. Consumer '
                'availability is unproven; inconclusive attempt recorded. Re-run later. '
                'The probe rows remain queued.')
            sys.exit(3)
        try:
            smoke.record_failure(commit, outcome.queues, missing, attempt_id=attempt.attempt_id)
            recorded = 'recorded as the latest run (superseding any earlier pass)'
        except smoke.SmokeRecordError as exc:
            recorded = f'and the failure could not be recorded either: {exc}'
        self.stderr.write(
            f'jobs_smoke: FAILED -- {len(missing)} of {len(outcome.queues)} '
            f'lanes did not consume commit {commit}: {", ".join(missing)} '
            f'(failed={sorted(outcome.failed)} '
            f'pending={sorted(outcome.pending)}'
            f'{"; busy=" + busy if busy else ""}); {recorded}. Pending '
            'probe rows are left in todo on purpose: they are the '
            'evidence, and the todo_overdue health alert on that queue is '
            'the second signal.')
        sys.exit(10)
