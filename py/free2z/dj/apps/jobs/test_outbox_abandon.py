"""The escape hatch for a permanently unpublishable outbox row.

The outbox has no attempt cap, the admin is read-only, and the backlog
runbook says not to delete rows -- all deliberate, and together they left a
row that CAN NEVER publish (deleted topic, dropped IAM binding, a payload
over Pub/Sub's 10MB limit; ``bounded_retry`` correctly does not retry
``NotFound``/``PermissionDenied``/``InvalidArgument``) retrying forever at
the 3600s ceiling and re-paging every 30 minutes, with no sanctioned remedy
short of hand-written SQL against prod.

What these tests pin is that the remedy is NARROW: it refuses everything
that still has a chance, and the one thing it does destroy, it records
first.
"""
import io
import json

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import transaction
from django.utils import timezone

from dj.apps.jobs import outbox
from dj.apps.jobs.management.commands import outbox_abandon
from dj.apps.jobs.models import OutboxMessage

TOPIC = 'projects/free2z/topics/outbox-abandon-test'


def _stuck(**overrides):
    """A row that has genuinely exhausted every retry that could work."""
    fields = {
        'topic': TOPIC,
        'payload': {'n': 1},
        'attributes': {'kind': 'test'},
        'ordering_key': '',
        'attempts': 9,
        'last_error': '404 Topic not found',
        'created_at': timezone.now() - timezone.timedelta(
            seconds=outbox.STALE_SECONDS + 60),
    }
    fields.update(overrides)
    return OutboxMessage.objects.create(**fields)


def _run(*, ids, reason='topic deleted in a namespace teardown', yes=False,
         out=None, err=None):
    """Drive the command through ARGV, exactly as an operator does.

    Not ``call_command(..., ids=[...])``: that bypasses argparse for a
    repeated ``--id``, so it would test a call shape nobody ever makes.
    """
    # The caller may pass its own buffers: a refusal raises out of
    # call_command, so a test that wants the REFUSED line cannot get it from
    # a return value.
    out = io.StringIO() if out is None else out
    err = io.StringIO() if err is None else err
    argv = []
    for row_id in ids:
        argv += ['--id', str(row_id)]
    argv += ['--reason', reason]
    if yes:
        argv.append('--yes')
    call_command('outbox_abandon', *argv, stdout=out, stderr=err)
    return out.getvalue(), err.getvalue()


def _log_bodies(caplog):
    """The abandonment records as they actually reach stdout.

    Deliberately parsed from ``record.message`` -- the RENDERED line -- and
    not from an attribute on the LogRecord. This project's root handler is a
    plain StreamHandler with the default message-only formatter, so anything
    passed as ``extra=`` never leaves the process; a test that asserted on
    ``record.json_fields`` would pass while the audit record was silently
    discarded, which is exactly how this was written the first time.
    """
    bodies = []
    for record in caplog.records:
        try:
            body = json.loads(record.message)
        except (ValueError, TypeError):
            continue
        if isinstance(body, dict) and (
                body.get('event') == outbox_abandon.ABANDONED_EVENT):
            bodies.append(body)
    return bodies


@pytest.mark.django_db
def test_a_permanently_unpublishable_row_can_be_abandoned(caplog):
    row = _stuck()

    with caplog.at_level('ERROR'):
        out, _err = _run(ids=[row.pk], yes=True)

    assert 'ABANDONED id=%s' % row.pk in out
    assert not OutboxMessage.objects.filter(pk=row.pk).exists()

    # The promise survives the row. Everything needed to re-enqueue it by
    # hand is in the log line -- that is the whole difference between this
    # and `DELETE FROM jobs_outbox_message`.
    bodies = _log_bodies(caplog)
    assert len(bodies) == 1, caplog.text
    fields = bodies[0]
    assert fields['severity'] == 'ERROR'
    assert fields['message']
    assert fields['outbox_id'] == row.pk
    assert fields['topic'] == TOPIC
    assert fields['payload'] == {'n': 1}
    assert fields['attributes'] == {'kind': 'test'}
    assert fields['attempts'] == 9
    assert fields['last_error'] == '404 Topic not found'
    assert fields['reason'] == 'topic deleted in a namespace teardown'
    assert fields['operator']

    # And the same record, complete, on stdout -- the copy the operator keeps.
    assert json.loads(out[out.index('{'):out.rindex('}') + 1])['payload'] == {
        'n': 1}


@pytest.mark.django_db
def test_an_oversized_payload_is_dropped_from_the_log_and_kept_on_stdout(
        caplog):
    """A 10MB payload is one of the reasons a row is unpublishable at all.

    Cloud Logging truncates or rejects an oversized entry, so the log record
    says the payload is absent and how big it was, rather than carrying a
    prefix that reads like a payload and is not one. stdout still has all of
    it, which is why the command prints it whether or not it is a dry run.
    """
    big = 'x' * (outbox_abandon.MAX_LOGGED_PAYLOAD_CHARS + 1000)
    row = _stuck(payload={'blob': big})

    with caplog.at_level('ERROR'):
        out, _err = _run(ids=[row.pk], yes=True)

    body = _log_bodies(caplog)[0]
    assert body['payload'] is None
    assert (body['payload_omitted_bytes']
            > outbox_abandon.MAX_LOGGED_PAYLOAD_CHARS)
    assert big in out


@pytest.mark.django_db
def test_nothing_is_written_without_yes():
    """The default is a dry run, not a deletion.

    A destructive command whose safe mode is opt-IN is one somebody runs
    destructively by accident at 3am, which is the only hour it is ever run.
    """
    row = _stuck()

    out, _err = _run(ids=[row.pk])

    assert 'WOULD ABANDON' in out
    assert 'DRY RUN' in out
    assert OutboxMessage.objects.filter(pk=row.pk).exists()


@pytest.mark.django_db
def test_dry_run_still_refuses_and_still_reports_the_refusal():
    row = _stuck(attempts=0)

    with pytest.raises(CommandError):
        _run(ids=[row.pk])

    assert OutboxMessage.objects.filter(pk=row.pk).exists()


@pytest.mark.django_db
@pytest.mark.parametrize('overrides,expected', [
    ({'attempts': 0}, 'nothing has really tried'),
    ({'attempts': 2}, 'nothing has really tried'),
    ({'last_error': ''}, 'never recorded a failure'),
    ({'created_at': timezone.now()}, 'in-flight work'),
    ({'published_at': timezone.now()}, 'already published'),
])
def test_a_row_that_still_has_a_chance_is_refused(overrides, expected):
    """Every gate, each one on its own.

    These are the rows an operator reaches for this command about and must
    NOT be allowed to delete: one nothing has tried yet (look at the worker),
    one the relay has never seen fail, one that is simply young, and one that
    already went out -- deleting the last would also free its dedup_key for
    re-promising.
    """
    row = _stuck(**overrides)

    err = io.StringIO()
    with pytest.raises(CommandError, match='refused'):
        _run(ids=[row.pk], yes=True, err=err)

    assert expected in err.getvalue()
    assert OutboxMessage.objects.filter(pk=row.pk).exists()


@pytest.mark.django_db
def test_one_refusal_does_not_roll_back_a_justified_deletion():
    """Each id is judged and committed alone.

    A single transaction over the batch would make one bad id undo the good
    ones, which an operator working an alert at 3am would read as "the
    command did nothing".
    """
    good, bad = _stuck(), _stuck(attempts=0)

    with pytest.raises(CommandError, match='1 of 2'):
        _run(ids=[good.pk, bad.pk], yes=True)

    assert not OutboxMessage.objects.filter(pk=good.pk).exists()
    assert OutboxMessage.objects.filter(pk=bad.pk).exists()


@pytest.mark.django_db
def test_an_unknown_id_is_refused_rather_than_ignored():
    with pytest.raises(CommandError, match='refused'):
        _run(ids=[9999999], yes=True)


@pytest.mark.django_db
def test_an_empty_reason_is_refused():
    """The audit record is the deliverable; a blank reason is not one."""
    row = _stuck()

    with pytest.raises(CommandError, match='--reason'):
        _run(ids=[row.pk], reason='   ', yes=True)

    assert OutboxMessage.objects.filter(pk=row.pk).exists()


@pytest.mark.django_db(transaction=True)
def test_abandoning_the_head_of_an_ordering_key_unblocks_its_successors():
    """This is usually WHY the command is being run.

    `due_messages` holds a key's later rows behind an unpublished earlier
    one, so one permanently stuck head stalls the whole key indefinitely.
    """
    key = 'dyte-recording:abc'
    head = _stuck(ordering_key=key)
    successor = _stuck(ordering_key=key, attempts=0, last_error='')

    assert list(outbox.due_messages().values_list('pk', flat=True)) == [
        head.pk], 'the successor must be blocked while the head is unpublished'

    _run(ids=[head.pk], yes=True)

    assert list(outbox.due_messages().values_list('pk', flat=True)) == [
        successor.pk]


@pytest.mark.django_db(transaction=True)
def test_a_row_abandoned_mid_publish_does_not_break_the_relay_pass():
    """Deleting a leased row is safe, which is why there is no gate for it.

    `_settle_success` and `_settle_failure` are both compare-and-set on the
    row, so a pass whose row vanished underneath it updates zero rows and
    carries on. Without that this command would need to know whether a relay
    holds the lease, which the row alone cannot say.
    """
    with transaction.atomic():
        message = outbox.enqueue(TOPIC, {'n': 1})
    OutboxMessage.objects.filter(pk=message.pk).update(
        attempts=9, last_error='404 Topic not found',
        created_at=timezone.now() - timezone.timedelta(
            seconds=outbox.STALE_SECONDS + 60))

    rows, lease_until = outbox._claim(10, timezone.now())
    assert [r.pk for r in rows] == [message.pk]

    _run(ids=[message.pk], yes=True)

    # The pass settles into thin air, both ways, without raising.
    outbox._settle_success(rows[0], timezone.now())
    outbox._settle_failure(rows[0], RuntimeError('boom'), lease_until)
    assert not OutboxMessage.objects.filter(pk=message.pk).exists()
