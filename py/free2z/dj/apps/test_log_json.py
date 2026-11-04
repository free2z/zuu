"""
Unit tests for dj/free2z/log_json.py.

Pure Python, no DB and no django_db marker needed: a logging.Formatter is
just called against a hand-built LogRecord.

The load-bearing assertions:

- RawLoggerJSONFormatter renders a record as ONE line of valid JSON, with a
  top-level `severity` that matches the record's OWN Python level -- INFO
  stays INFO when the log collector parses the structured payload.
- Fields procrastinate attaches via `extra=` (action, worker, job,...) are
  forwarded, not hand-picked -- a NEW field the library starts sending later
  must not be silently dropped.
- The stock `logging.Formatter` (what was wired in before this PR) produces
  plain text that does NOT parse as JSON -- the negative control proving the
  bug: GKE's structured-severity handling only applies to a line that IS
  JSON, and the un-fixed formatter never produced one.
"""
import json
import logging
import os
import pathlib
import subprocess
import sys

from dj.free2z.log_json import RawLoggerJSONFormatter, SingleLineJSONFormatter


def _make_record(level, msg, logger_name='procrastinate.worker', extra=None):
    record = logging.LogRecord(
        name=logger_name,
        level=level,
        pathname=__file__,
        lineno=1,
        msg=msg,
        args=(),
        exc_info=None,
    )
    for key, value in (extra or {}).items():
        setattr(record, key, value)
    return record


def test_info_level_job_success_gets_info_severity_not_error():
    """The exact  bug: a job success logged at INFO must not read ERROR."""
    record = _make_record(
        logging.INFO,
        'Job dyte.sweep_live_meetings[123] ended with status: Success, '
        'lasted 0.412 s',
        extra={'action': 'job_success', 'job': {'id': 123}},
    )
    line = RawLoggerJSONFormatter().format(record)
    payload = json.loads(line)  # must be ONE line of valid JSON
    assert payload['severity'] == 'INFO'
    assert 'ended with status: Success' in payload['message']
    assert payload['action'] == 'job_success'
    assert payload['job'] == {'id': 123}
    assert payload['logger'] == 'procrastinate.worker'
    assert payload['event'] == 'worker_log'


def test_terminal_failure_gets_error_severity():
    """procrastinate's own logger.log() already picks ERROR for a terminal,
    non-retried failure (Worker._log_job_outcome) -- this only has to carry
    that level through as `severity`, not invent one."""
    record = _make_record(
        logging.ERROR,
        'Job jobs.sweep_outbox[456] ended with status: Error',
        extra={'action': 'job_error'},
    )
    payload = json.loads(RawLoggerJSONFormatter().format(record))
    assert payload['severity'] == 'ERROR'
    assert payload['action'] == 'job_error'


def test_retried_failure_stays_info_not_error():
    """A retryable failure (job_error_retry) is NOT terminal -- procrastinate
    logs it at INFO, and it must not inflate the ERROR count either."""
    record = _make_record(
        logging.INFO,
        'Job images.resize[789] ended with status: Error, to retry',
        extra={'action': 'job_error_retry'},
    )
    payload = json.loads(RawLoggerJSONFormatter().format(record))
    assert payload['severity'] == 'INFO'


def _raise_nested_value_error():
    def inner():
        raise ValueError('boom')
    inner()


def test_exception_is_reported_structured_not_as_a_second_line():
    exc = None
    try:
        _raise_nested_value_error()
    except ValueError as e:
        exc = e
    record = _make_record(logging.ERROR, 'worker crashed')
    record.exc_info = (type(exc), exc, exc.__traceback__)
    line = RawLoggerJSONFormatter().format(record)
    # The whole point: one physical line even though the rendered
    # traceback is naturally multi-line -- json.dumps escapes the
    # newlines inside the string value rather than emitting them raw.
    assert '\n' not in line
    payload = json.loads(line)
    assert payload['error_type'] == 'ValueError'
    assert payload['error_message'] == 'boom'
    # Codex adversarial review finding: an earlier version of this
    # formatter dropped the traceback entirely, which for procrastinate's
    # OWN terminal-failure logging (Worker._process_job passes the real
    # exception as exc_info) would have been a strict downgrade from the
    # unstructured multi-line text it replaced -- that text at least
    # carried the traceback, even if split across ingested entries.
    assert 'stack_trace' in payload
    assert '_raise_nested_value_error' in payload['stack_trace']
    assert 'inner' in payload['stack_trace']
    assert 'ValueError: boom' in payload['stack_trace']
    # And it decodes back to real newlines -- proving it was ESCAPED, not
    # stripped or collapsed to look single-line by accident.
    assert '\n' in payload['stack_trace']


def test_traceback_is_bounded_not_unbounded():
    """A pathological traceback must not turn this formatter back into the
    multi-line-defeating shape it exists to avoid -- it gets truncated with
    the same `bounded()` convention as every other free-text field here,
    just at a much larger cap sized for a traceback's usefulness."""
    from dj.free2z.log_json import MAX_TRACEBACK_CHARS

    exc = None
    try:
        raise ValueError('x' * (MAX_TRACEBACK_CHARS * 2))
    except ValueError as e:
        exc = e
    record = _make_record(logging.ERROR, 'worker crashed')
    record.exc_info = (type(exc), exc, exc.__traceback__)
    payload = json.loads(RawLoggerJSONFormatter().format(record))
    assert len(payload['stack_trace']) <= MAX_TRACEBACK_CHARS + 1
    assert payload['stack_trace'].endswith('…')


def test_long_worker_traceback_keeps_innermost_frame_and_terminal_exception():
    from dj.free2z.log_json import MAX_TRACEBACK_CHARS

    definitions = '\n'.join(
        f'def frame_{index}():\n    return frame_{index + 1}()'
        for index in range(100)
    )
    definitions += (
        '\ndef frame_100():\n'
        '    raise ValueError("terminal-" + "x" * 5000)\n'
    )
    scope = {}
    exec(definitions, scope)
    try:
        scope['frame_0']()
    except ValueError as exc:
        record = _make_record(logging.ERROR, 'worker crashed')
        record.exc_info = (type(exc), exc, exc.__traceback__)

    payload = json.loads(RawLoggerJSONFormatter().format(record))
    stack_trace = payload['stack_trace']
    assert stack_trace.startswith('Traceback (most recent call last):\n')
    assert 'in frame_100' in stack_trace
    assert 'ValueError: terminal-' in stack_trace
    assert len(stack_trace) <= MAX_TRACEBACK_CHARS + 64


def test_oversized_job_extras_are_capped_without_expanding_the_log_entry():
    from dj.free2z.log_json import MAX_EXTRA_FIELD_CHARS

    record = _make_record(
        logging.INFO,
        'job finished',
        extra={
            # Procrastinate puts task_kwargs inside `job.log_context()` and
            # the result at the top level via JobResult.as_dict().
            'job': {
                'task_kwargs': {'payload': 'x' * (MAX_EXTRA_FIELD_CHARS * 4)},
            },
            'result': 'y' * (MAX_EXTRA_FIELD_CHARS * 4),
        },
    )
    line = RawLoggerJSONFormatter().format(record)
    payload = json.loads(line)
    assert len(line) < MAX_EXTRA_FIELD_CHARS * 3
    for key in ('job', 'result'):
        assert isinstance(payload[key], str)
        assert len(payload[key]) <= MAX_EXTRA_FIELD_CHARS + 1
        assert payload[key].endswith('…')


def test_unserializable_extra_value_does_not_crash_the_formatter():
    """`default=str` covers anything json can't natively serialise (a UUID,
    a datetime) that procrastinate's `job_result.as_dict()` might attach."""
    import uuid

    record = _make_record(
        logging.INFO, 'ok', extra={'worker': {'id': uuid.uuid4()}})
    payload = json.loads(RawLoggerJSONFormatter().format(record))
    assert isinstance(payload['worker']['id'], str)


def test_standard_record_attributes_are_never_leaked_as_extra_fields():
    record = _make_record(logging.INFO, 'ok')
    payload = json.loads(RawLoggerJSONFormatter().format(record))
    # Only the fields this formatter deliberately sets.
    assert set(payload) == {'severity', 'message', 'event', 'logger'}


def test_negative_control_the_stock_formatter_is_not_json():
    """Proves the bug this PR fixes: before RawLoggerJSONFormatter, the
    logger that procrastinate's worker writes to used the stock
    `logging.Formatter`, whose default output is plain text. A plain-text
    line is exactly what GKE's logging agent cannot read a `severity` off,
    which is why it fell back to classifying by stream (stderr -> ERROR)
    regardless of the INFO level procrastinate actually logged at."""
    record = _make_record(
        logging.INFO,
        'Job dyte.sweep_live_meetings[123] ended with status: Success',
    )
    line = logging.Formatter().format(record)
    try:
        json.loads(line)
    except (json.JSONDecodeError, ValueError):
        pass
    else:
        raise AssertionError(
            'the stock formatter unexpectedly produced valid JSON; the '
            'negative control no longer demonstrates the bug')


def test_worker_root_logs_are_json_with_python_severity():
    """Exercise dictConfig in a subprocess with the same opt-in the worker
    pod templates set. App task loggers that do not have a dedicated handler
    must not fall through as plain stderr/ERROR lines in worker pods."""
    repo = pathlib.Path(__file__).resolve().parents[2]
    env = os.environ.copy()
    env['DJANGO_SETTINGS_MODULE'] = 'dj.free2z.settings'
    env['FREE2Z_WORKER_LOG_JSON'] = 'true'
    env['PYTHONPATH'] = str(repo) + os.pathsep + env.get('PYTHONPATH', '')
    proc = subprocess.run(
        [sys.executable, '-c',
         'import logging, logging.config; '
         'from dj.free2z import settings; '
         'logging.config.dictConfig(settings.LOGGING); '
         'logging.getLogger("dj.apps.dyte.tasks").info("checked: 1")'],
        cwd=repo, env=env, text=True, capture_output=True, check=True)
    payload = json.loads(proc.stderr)
    assert payload['severity'] == 'INFO'
    assert payload['event'] == 'worker_app_log'
    assert payload['logger'] == 'dj.apps.dyte.tasks'
    assert payload['message'] == 'checked: 1'






def test_single_line_json_formatter_still_behaves_as_before():
    """Sanity check that adding RawLoggerJSONFormatter alongside it did not
    disturb the existing formatter other code (django_redis, ) relies
    on."""
    record = _make_record(logging.ERROR, 'Exception ignored', logger_name='x')
    line = SingleLineJSONFormatter(event='some_event').format(record)
    payload = json.loads(line)
    assert payload['event'] == 'some_event'
    assert payload['severity'] == 'ERROR'
