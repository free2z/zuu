"""The sanctioned terminal state for an outbox row that can never publish.

    python dj/free2z/manage.py outbox_abandon --id 4711 \
        --reason 'topic dyte-video-ready-prod deleted; recreated as ...' \
        --dry-run
    python dj/free2z/manage.py outbox_abandon --id 4711 --reason '...' --yes

WHY THIS EXISTS
---------------
The outbox has NO attempt cap on purpose (``outbox.RETRY_MAX_SECONDS``): a
capped outbox silently drops a message a charged transaction promised, and
the backlog alert is meant to page instead. The admin is read-only for the
same reason, and ``monitoring/alert-policies/pubsub-outbox-backlog.json``
says not to delete rows to clear the alert.

All three are right, and together they left one case with no remedy at all.
Some failures are **permanent**, and ``gcp.pubsub.client.bounded_retry``
correctly does not retry them: ``NotFound`` (the topic was deleted),
``PermissionDenied`` (an IAM binding was dropped), ``InvalidArgument`` (a
payload over Pub/Sub's 10MB message limit). Such a row retries forever at
the 3600s ceiling and re-pages every 30 minutes
(``notificationRateLimit`` 1800s, ``autoClose`` 3600s), and the only way out
was unwritten SQL against the production database at 3am.

FIX THE CAUSE FIRST. Recreate the topic, restore the binding, and the row
publishes itself -- that is always the better outcome, because the promise
is kept. This command is for the residue: a row whose message can no longer
be delivered *at all*, or whose delivery is no longer wanted.

WHAT IT DOES
------------
Deletes the row -- which IS the terminal state; there is no status column to
set and adding one would be a migration for a path that should stay rare --
after recording the ENTIRE row twice: to stdout, and to the log as ONE line
of JSON carrying ``event="pubsub_outbox_abandoned"``. The promise therefore
survives the row, with enough detail (topic, payload, attributes, ordering
key, attempts, last error, operator, reason) to re-enqueue it by hand if the
decision turns out to have been wrong. Deleting through this command and
deleting with ``DELETE FROM`` differ in exactly that record.

WHERE THAT RECORD ACTUALLY LANDS, because one of the two copies is
conditional. The JSON line becomes a Cloud Logging entry only when this
process's stdout is the stream the logging agent collects -- that is the
container's MAIN process, i.e. running this as a ``Job``. The runbook's
invocation is ``kubectl exec``, whose output is streamed to the client and
never enters the container's collected log, so on that path **the operator's
terminal is the only copy**. Capture it (`| tee`) before passing ``--yes``,
or run the command as a Job when the payload is one somebody may need to
re-enqueue. Promising a durable copy that does not exist would be worse than
promising nothing, because the operator would not keep the one that does.

THE LOG LINE IS ``json.dumps`` INTO THE MESSAGE, not ``extra=``. This
project's ``LOGGING`` gives the root logger a plain ``StreamHandler`` with
the default message-only formatter (``dj/free2z/log_json.py`` explains why a
record a metric counts must be one bare JSON line), so anything attached as
``extra=`` is silently dropped before it reaches stdout -- an audit record
that exists only inside the process is not an audit record. ``log_health``
in ``jobs.outbox`` emits the same way for the same reason.

The stdout copy is not redundant with it. Pub/Sub allows a 10MB message, and
an over-limit payload is one of the exact reasons a row becomes permanently
unpublishable, so the payload is dropped from the LOG record once it exceeds
:data:`MAX_LOGGED_PAYLOAD_CHARS` (Cloud Logging truncates or rejects an
oversized entry, and a truncated recovery record is a lie). The record
printed to stdout is always complete -- keep it before you pass ``--yes``.

THE GATES, and why each one is there:

* the row must be UNPUBLISHED. A published row is history, and deleting it
  would also free its ``dedup_key`` for re-promising.
* ``attempts >= --min-attempts`` (default 3) and a non-empty ``last_error``.
  Together these mean the relay ran and the far side refused. A row with
  ``attempts = 0`` means nothing has tried yet -- the runbook's "look at the
  worker, not at Pub/Sub" case -- and abandoning it would delete a message
  that was never given a chance.
* older than ``--min-age-seconds`` (default ``outbox.STALE_SECONDS``), so it
  is a backlog rather than in-flight work.
* an explicit ``--reason``, and ``--yes`` to write anything at all.

Deleting a row that a relay pass happens to be publishing RIGHT NOW is safe
and needs no gate: ``_settle_success`` and ``_settle_failure`` are both
compare-and-set on the row, so they update zero rows and the pass carries on.
The only consequence is that the message may go out after you abandoned it,
which is the at-least-once behaviour the table already documents.

Abandoning the HEAD of an ordering key deliberately unblocks its successors:
``outbox.due_messages`` holds a key's later rows behind an unpublished
earlier one, so a permanently stuck head stalls its whole key. That is
usually the reason to reach for this command, and it is also the reason to
think about whether the successors still make sense without it.

Exit code is 1 if any named id was refused, so a script cannot mistake a
partial run for a clean one.
"""
import json
import logging

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from dj.apps.jobs import outbox
from dj.apps.jobs.models import OutboxMessage

logger = logging.getLogger(__name__)

ABANDONED_EVENT = 'pubsub_outbox_abandoned'

#: Cap on the ``payload`` field of the LOG record only. Cloud Logging
#: truncates or rejects an oversized entry, and a truncated payload is worse
#: than an absent one flagged as absent -- the operator would not know it was
#: incomplete. stdout always carries the whole thing.
MAX_LOGGED_PAYLOAD_CHARS = 20_000

#: A row nothing has really tried is not permanently unpublishable, it is
#: untried. Three attempts spans base + 2 backoff rungs (60s, 120s).
DEFAULT_MIN_ATTEMPTS = 3


class Command(BaseCommand):
    help = (
        'Abandon (delete, with a full audit log line) an outbox row that can '
        'never be published. Fix the cause first -- see the module docstring.'
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--id', dest='ids', action='append', type=int, required=True,
            help='Outbox row id. Repeat for several; each is judged alone.')
        parser.add_argument(
            '--reason', required=True,
            help='Why this message can never be delivered. Goes into the '
                 'audit log line, which is the only thing left afterwards.')
        parser.add_argument(
            '--operator', default='',
            help='Who ran this. Defaults to the OS user.')
        parser.add_argument(
            '--min-attempts', type=int, default=DEFAULT_MIN_ATTEMPTS,
            help=f'Refuse a row with fewer attempts '
                 f'(default {DEFAULT_MIN_ATTEMPTS}).')
        parser.add_argument(
            '--min-age-seconds', type=int, default=outbox.STALE_SECONDS,
            help='Refuse a row younger than this (default '
                 'PUBSUB_OUTBOX_STALE_SECONDS).')
        parser.add_argument(
            '--dry-run', action='store_true',
            help='Show the verdict for every id and write nothing.')
        parser.add_argument(
            '--yes', action='store_true',
            help='Required to delete anything. Without it this is a dry run '
                 'that says so.')

    def handle(self, *args, **options):
        reason = options['reason'].strip()
        if not reason:
            raise CommandError('--reason must not be empty')

        operator = options['operator'] or _os_user()
        dry_run = options['dry_run'] or not options['yes']
        now = timezone.now()
        min_created = now - timezone.timedelta(
            seconds=options['min_age_seconds'])

        abandoned, refused = [], []
        for row_id in options['ids']:
            # One transaction per row: a refusal must not roll back a
            # deletion that was already justified.
            with transaction.atomic():
                row = (OutboxMessage.objects
                       .select_for_update()
                       .filter(pk=row_id)
                       .first())
                verdict = _refuse(
                    row, row_id,
                    min_attempts=options['min_attempts'],
                    min_created=min_created,
                )
                if verdict is not None:
                    refused.append((row_id, verdict))
                    self.stderr.write(f'REFUSED id={row_id}: {verdict}')
                    continue

                record = _record(row, reason, operator)
                if dry_run:
                    self.stdout.write(
                        f'WOULD ABANDON id={row_id} topic={row.topic} '
                        f'attempts={row.attempts}')
                    self.stdout.write(
                        json.dumps(record, indent=2, default=str))
                    continue

                # Record BEFORE the delete, and to stdout as well as the log.
                # If the process dies between the two, the record exists and
                # so does the row -- recoverable. The other order loses both.
                self.stdout.write(json.dumps(record, indent=2, default=str))
                _log_abandoned(record)
                row.delete()
                abandoned.append(row_id)
                self.stdout.write(f'ABANDONED id={row_id}')

        if dry_run:
            self.stdout.write(
                'DRY RUN: nothing was written. Re-run with --yes to abandon.')
        self.stdout.write(
            f'abandoned={len(abandoned)} refused={len(refused)}')
        if refused:
            # A partial run must not look like a clean one.
            raise CommandError(
                f'{len(refused)} of {len(options["ids"])} row(s) refused')


def _refuse(row, row_id, *, min_attempts, min_created):
    """Return the reason this row may NOT be abandoned, or ``None``."""
    if row is None:
        return 'no such row'
    if row.published_at is not None:
        return (
            f'already published at {row.published_at.isoformat()} -- a '
            'published row is history, and deleting it would free its '
            'dedup_key for re-promising')
    if row.attempts < min_attempts:
        return (
            f'attempts={row.attempts} < {min_attempts}: nothing has really '
            'tried to publish this. Look at the worker, not at Pub/Sub')
    if not row.last_error:
        return (
            'last_error is empty: the relay has claimed this row but never '
            'recorded a failure for it, so there is no evidence the far '
            'side is refusing it')
    if row.created_at > min_created:
        return (
            f'created {row.created_at.isoformat()} is newer than the '
            'minimum age: this is in-flight work, not a stuck promise')
    return None


def _record(row, reason, operator):
    """Everything needed to re-enqueue the message by hand, as JSON."""
    return {
        'event': ABANDONED_EVENT,
        'outbox_id': row.pk,
        'topic': row.topic,
        'payload': row.payload,
        'attributes': row.attributes,
        'ordering_key': row.ordering_key,
        'ensure_topic': row.ensure_topic,
        'dedup_key': row.dedup_key,
        'attempts': row.attempts,
        'created_at': row.created_at.isoformat(),
        'next_attempt_at': row.next_attempt_at.isoformat(),
        'last_error': row.last_error,
        'reason': reason,
        'operator': operator,
    }


def _log_abandoned(record):
    """Emit the record as ONE bare JSON line, the way `log_health` does.

    GKE lifts a stdout line that is entirely JSON into ``jsonPayload`` and
    honours a top-level ``severity``; that is what makes
    ``jsonPayload.event="pubsub_outbox_abandoned"`` findable later. An
    ``extra=`` dict would reach no handler this project configures.
    """
    body = dict(record)
    encoded = json.dumps(body.get('payload'), default=str)
    if len(encoded) > MAX_LOGGED_PAYLOAD_CHARS:
        # Say it is missing rather than truncate it into something that
        # looks like a payload and is not one.
        body['payload'] = None
        body['payload_omitted_bytes'] = len(encoded)
    body['severity'] = 'ERROR'
    body['message'] = (
        f'pubsub outbox: ABANDONED id={record["outbox_id"]} '
        f'topic={record["topic"]} attempts={record["attempts"]} '
        f'reason={record["reason"]}'
    )
    logger.error(json.dumps(body, default=str, sort_keys=False))


def _os_user():
    import getpass
    try:
        return getpass.getuser()
    except Exception:
        # No passwd entry in a distroless container, and this is an audit
        # field, not a gate: an unknown operator must not block the command.
        return 'unknown'
