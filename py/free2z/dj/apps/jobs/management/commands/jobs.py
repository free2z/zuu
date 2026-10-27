"""Inspect and operate on Procrastinate jobs with dry-run by default."""
import json

from django.core.management.base import BaseCommand, CommandError

from dj.apps.jobs import ops


class Command(BaseCommand):
    help = 'Inspect Procrastinate jobs and perform explicitly audited operations'

    def add_arguments(self, parser):
        sub = parser.add_subparsers(dest='verb', required=True)

        listing = sub.add_parser('list', help='list matching jobs')
        self._selectors(listing)
        listing.add_argument('--json', action='store_true')

        inspect = sub.add_parser('inspect', help='show a job and its recovery context')
        inspect.add_argument('id', type=int)
        inspect.add_argument('--json', action='store_true')

        requeue = sub.add_parser('requeue', help='requeue jobs')
        requeue.add_argument('ids', nargs='*', type=int)
        requeue.add_argument('--task')
        requeue.add_argument('--status', default='failed')
        requeue.add_argument('--older-than', type=int, dest='older_than')
        requeue.add_argument('--from-quarantine', action='store_true')
        self._mutation(requeue)
        requeue.add_argument('--limit', type=int)

        fail = sub.add_parser('fail', help='mark todo/doing jobs failed')
        fail.add_argument('ids', nargs='+', type=int)
        self._mutation(fail)

        cancel = sub.add_parser('cancel', help='cancel or abort jobs')
        cancel.add_argument('ids', nargs='+', type=int)
        cancel.add_argument('--abort', action='store_true')
        self._mutation(cancel)

        pause = sub.add_parser('pause', help='pause a queue')
        pause.add_argument('queue')
        self._mutation(pause)

        resume = sub.add_parser('resume', help='resume a queue and restore drained jobs')
        resume.add_argument('queue')
        resume.add_argument('--limit', type=int, required=True)
        self._mutation(resume)

        drain = sub.add_parser('drain', help='pause and drain a queue')
        drain.add_argument('queue')
        drain.add_argument('--limit', type=int, required=True)
        self._mutation(drain)

        prune = sub.add_parser('prune', help='prune old succeeded jobs')
        prune.add_argument('--older-than', type=int, required=True, dest='older_than')
        prune.add_argument('--limit', type=int, required=True)
        self._mutation(prune)

    @staticmethod
    def _selectors(parser):
        parser.add_argument('--queue')
        parser.add_argument('--task')
        parser.add_argument('--status')
        parser.add_argument('--older-than', type=int, dest='older_than')
        parser.add_argument('--limit', type=int)

    @staticmethod
    def _mutation(parser):
        parser.add_argument('--execute', action='store_true',
                            help='perform mutations (default is dry-run)')
        parser.add_argument('--reason',
                            help='required explanation recorded with the action')
        parser.add_argument('--money', action='store_true',
                            help='allow mutation of configured billing queues')

    def handle(self, *args, **options):
        verb = options['verb']
        try:
            if verb == 'list':
                self._validate_limit(options)
                result = ops.list_jobs(
                    queue=options['queue'], task=options['task'],
                    status=options['status'], older_than=options['older_than'],
                    limit=options['limit'])
                self._write_list(result, options['json'])
            elif verb == 'inspect':
                result = ops.inspect_job(options['id'])
                if result is None:
                    raise CommandError(f'job {options["id"]} not found')
                self.stdout.write(json.dumps(result, default=str, indent=2))
            elif verb == 'requeue':
                self._validate_limit(options, ids=options['ids'])
                # argparse yields [] for `nargs='*'` with no positionals; []
                # means "these explicit ids (none)" to ops.requeue, which would
                # turn every selector-based requeue into a silent no-op.
                result = ops.requeue(
                    ids=options['ids'] or None, task=options['task'],
                    status=options['status'], older_than=options['older_than'],
                    limit=options['limit'], execute=options['execute'],
                    reason=options['reason'], money=options['money'],
                    from_quarantine=options['from_quarantine'])
                self._write_json(result)
            elif verb == 'fail':
                self._write_json(ops.fail(
                    ids=options['ids'], execute=options['execute'],
                    reason=options['reason'], money=options['money']))
            elif verb == 'cancel':
                self._write_json(ops.cancel(
                    ids=options['ids'], abort=options['abort'],
                    execute=options['execute'], reason=options['reason'],
                    money=options['money']))
            elif verb == 'pause':
                if options['execute'] and not options['reason']:
                    raise CommandError('pause --execute requires --reason',
                                       returncode=2)
                self._write_json(ops.set_queue_paused(
                    options['queue'], paused=True, reason=options['reason'],
                    execute=options['execute'], money=options['money']))
            elif verb == 'resume':
                self._validate_limit(options)
                result = ops.resume_queue(
                    options['queue'], execute=options['execute'],
                    reason=options['reason'], money=options['money'],
                    limit=options['limit'])
                self._write_json(result)
            elif verb == 'drain':
                self._validate_limit(options)
                self._write_json(ops.drain_queue(
                    options['queue'], execute=options['execute'],
                    reason=options['reason'], money=options['money'],
                    limit=options['limit']))
            elif verb == 'prune':
                self._write_json(ops.prune(
                    older_than_days=options['older_than'],
                    limit=options['limit'],
                    execute=options['execute'], reason=options['reason'],
                    money=options['money']))
        except ValueError as exc:
            raise CommandError(str(exc), returncode=2) from exc

    @staticmethod
    def _validate_limit(options, ids=None):
        limit = options.get('limit')
        if limit is not None and limit < 1:
            raise CommandError('--limit must be positive', returncode=2)
        if limit is None and (ids is None or not ids):
            raise CommandError('selector-based listing requires --limit', returncode=2)
        if limit is None and options['verb'] in ('drain', 'resume'):
            raise CommandError('--limit is required', returncode=2)

    def _write_json(self, value):
        self.stdout.write(json.dumps(value, default=str, indent=2))
        def has_error(item):
            if isinstance(item, dict):
                return item.get('result') in ('error', 'not_found') or any(
                    has_error(child) for child in item.values())
            if isinstance(item, list):
                return any(has_error(child) for child in item)
            return False
        if has_error(value):
            raise CommandError('one or more job operations failed', returncode=1)

    def _write_list(self, rows, as_json):
        if as_json:
            self._write_json(rows)
            return
        columns = ('id', 'status', 'queue', 'task', 'priority', 'attempts')
        widths = {key: max([len(key)] + [
            len(str(row.get(key, ''))) for row in rows]) for key in columns}
        self.stdout.write('  '.join(key.ljust(widths[key]) for key in columns))
        self.stdout.write('  '.join('-' * widths[key] for key in columns))
        for row in rows:
            self.stdout.write('  '.join(str(row.get(key, '')).ljust(widths[key])
                                         for key in columns))
