"""
Show the Procrastinate queue health report on demand.

    python dj/free2z/manage.py job_health            # human table
    python dj/free2z/manage.py job_health --json     # the log payloads
    python dj/free2z/manage.py job_health --emit     # log them, as the
                                                    # periodic task does

Exit code is 1 when any alert condition is tripped, so this doubles as a
one-shot check from a shell or a CronJob if the periodic task is ever
unavailable.
"""
import json
import sys

from django.core.management.base import BaseCommand

from dj.apps.jobs import health


class Command(BaseCommand):
    help = 'Report Procrastinate queue health (failed/backlogged jobs)'

    def add_arguments(self, parser):
        parser.add_argument(
            '--json', action='store_true',
            help='Emit the same JSON payloads the periodic sweep logs.')
        parser.add_argument(
            '--emit', action='store_true',
            help='Log the payloads through the sweep code path '
                 '(fires the same Cloud Logging alerts).')

    def handle(self, *args, **options):
        if options['emit']:
            from dj.apps.jobs.tasks import report_job_health
            summary = report_job_health()
            if summary['alerts']:
                sys.exit(1)
            return

        report = health.collect()

        if options['json']:
            self.stdout.write(json.dumps({
                'queues': [
                    q.as_payload(report.window_seconds)
                    for q in report.queues
                ],
                'summary': report.summary_payload(),
            }, indent=2, default=str))
        else:
            self.stdout.write(
                f'window: last {report.window_seconds}s\n')
            header = (
                f'{"queue":<12}{"todo":>6}{"overdue":>9}{"doing":>7}'
                f'{"failed":>8}{"oldest_overdue_s":>18}  alerts'
            )
            self.stdout.write(header)
            self.stdout.write('-' * len(header))
            for q in report.queues:
                self.stdout.write(
                    f'{q.queue:<12}{q.todo:>6}{q.todo_overdue:>9}'
                    f'{q.doing:>7}{q.failed_recent:>8}'
                    f'{round(q.oldest_overdue_seconds):>18}  '
                    f'{",".join(q.alerts()) or "-"}'
                )
                for task_name, n in sorted(
                        q.failed_tasks.items(), key=lambda kv: -kv[1]):
                    self.stdout.write(f'    failed: {task_name} x{n}')

            b = report.backstops
            self.stdout.write('\ncron backstop evidence (#632):')
            self.stdout.write(
                f'  pages overdue+unpublished (publish-pages sweep would '
                f'act):        {b.pages_overdue_unpublished}')
            self.stdout.write(
                f'  future-scheduled pages with no pending job:            '
                f'          {b.pages_scheduled_without_job}')
            self.stdout.write(
                f'  active subscriptions:                                  '
                f'          {b.subscriptions_active}')
            self.stdout.write(
                f'  ...with no pending renew_subscription job (renew-subs '
                f'sweep):    {b.subscriptions_without_job}')

        if report.alerts():
            self.stderr.write(
                self.style.ERROR(
                    'ALERTING: ' + ', '.join(report.alerts())))
            # Non-zero exit so a shell/CronJob caller can act on it.
            # (Returning a value from handle() only prints it.)
            sys.exit(1)
