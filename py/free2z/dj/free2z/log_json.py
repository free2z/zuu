"""One-line JSON log formatting for records a metric has to count.

Cloud Logging promotes a stdout line that is *entirely* JSON into
``jsonPayload``, which is what lets ``monitoring/log-metrics/*.json`` filter on
a named field instead of grepping text. Anything else — including a second line
— is ingested as a separate plain ``textPayload`` entry.

That is the whole reason this exists. The record we need to count is
django_redis's ``logger.exception("Exception ignored")``: with the default
formatter it prints the message and then the traceback, which the GKE logging
agent records as *several* entries with no shared field. A filter written as
"the message string AND a frame from the traceback" can therefore never match a
single entry, and the metric built on it would sit at zero through the exact
outage it was written for.

Deliberately importable with no Django models and no app-registry access:
``LOGGING`` is resolved by ``dictConfig`` during ``django.setup()``, before the
app registry is ready, so anything this module imports at module scope would be
imported too early.
"""

import json
import logging
import traceback

#Cap on any free-text field. An exception message is not length-bounded and a
#log entry that Cloud Logging truncates is worse than one that is short.
MAX_FIELD_CHARS = 400

# Cap each procrastinate ``extra`` field after JSON encoding. Job kwargs and
# results are application controlled and can contain arbitrarily large
# payloads; one large field can push an otherwise one-line log beyond the
# logging agent's entry limit. Keep ordinary fields structured, and represent
# only oversized values as a bounded JSON-text string.
MAX_EXTRA_FIELD_CHARS = 4000

#Cap for a rendered traceback specifically (RawLoggerJSONFormatter). A
#traceback is the evidence that lets someone diagnose a terminal job
#failure without a psql session -- which frame raised, and what it was
#doing -- so it gets a MUCH bigger allowance than an ordinary free-text
#field. Still bounded: an unbounded field is exactly the multi-line,
#metric-defeating shape this module exists to avoid once something (a
#recursive task, a pathological retry) produces a traceback pathological
#enough to matter. (Codex adversarial review, / PR.)
MAX_TRACEBACK_CHARS = 4000

#Cap for a traceback that Error Reporting has to PARSE. Bigger than
#MAX_TRACEBACK_CHARS because a real Django 500 is routinely 5-10k characters
#of middleware frames, and truncated differently: see ``bounded_traceback``.
#Well under Cloud Logging's 256 KiB entry limit.
MAX_REPORTED_TRACEBACK_CHARS = 16000

#Cap on ONE piece of a reported traceback -- a frame, or an exception's own
#text (see ``reported_error_message``).
MAX_TRACEBACK_CHUNK_CHARS = 1000

#``jsonPayload.@type`` that tells Error Reporting "this entry IS an error
#event" rather than leaving it to heuristics. Only set on an entry whose
#message carries a stack trace -- with the type set and no stack, Error
#Reporting wants ``context.reportLocation``, which we do not have.
REPORTED_ERROR_EVENT_TYPE = (
    "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1."
    "ReportedErrorEvent"
)


def bounded(value, limit=MAX_FIELD_CHARS):
    """Cap one free-text field. Escaping is ``json.dumps``'s job."""
    text = str(value)
    return text if len(text) <= limit else text[:limit] + "…"


def bounded_traceback(text, limit=MAX_REPORTED_TRACEBACK_CHARS):
    """Cap a rendered traceback, keeping its FIRST line and its TAIL.

    ``bounded()`` keeps the head, which for a traceback throws away the
    innermost frames and the ``ValueError:...`` line -- the part Error
    Reporting groups on and the part a human reads first. Keep
    ``Traceback (most recent call last):`` (so the text still parses as a
    Python traceback) and the last ``limit`` characters.
    """
    if len(text) <= limit:
        return text
    head, _, _ = text.partition("\n")
    return head + "\n  …\n" + text[-limit:]


def reported_error_message(message, exc_info):
    """``message`` followed by the rendered traceback, for Error Reporting.

    Error Reporting finds a stack trace in ``jsonPayload.message``; that is
    how a real 500 keeps grouping once it is one JSON line instead of the
    plain text (header line + separate traceback entry) GKE used to split it
    into. The newlines are escaped by ``json.dumps``, so it stays one line.
    """
    exc_type, exc, exc_tb = exc_info
    # Cap each rendered piece (a frame, or an exception's own text) BEFORE
    # the tail-keeping cap: otherwise one exception whose str() is a 20 KB
    # upstream response body fills the whole tail and every frame is lost.
    # (Codex adversarial review,.)
    rendered = "".join(
        chunk if len(chunk) <= MAX_TRACEBACK_CHUNK_CHARS
        else chunk[:MAX_TRACEBACK_CHUNK_CHARS] + "…\n"
        for chunk in traceback.TracebackException(
            exc_type, exc, exc_tb).format()
    )
    return bounded(message) + "\n" + bounded_traceback(rendered.rstrip("\n"))


class SingleLineJSONFormatter(logging.Formatter):
    """Render a record as exactly one line of JSON carrying a fixed ``event``.

    The ``event`` is the contract with a log-based metric, so it is set in
    ``LOGGING`` next to the handler rather than inferred from the record.

    ``logging.Formatter.format`` appends ``exc_text`` when the record carries
    ``exc_info``; this does not call it. The exception is reported as the
    structured ``error_type``/``error_module``/``error_message`` fields
    instead, and the traceback is dropped on purpose — a multi-line entry is
    exactly the failure this class exists to avoid. Use it for records a metric
    counts, not as a general-purpose formatter.
    """

    def __init__(self, event, **kwargs):
        super().__init__(**kwargs)
        self.event = event

    def format(self, record):
        payload = {
            "severity": record.levelname,
            "message": bounded(record.getMessage()),
            "event": self.event,
            "logger": record.name,
        }
        if record.exc_info and record.exc_info[0] is not None:
            exc_type, exc = record.exc_info[0], record.exc_info[1]
            payload["error_type"] = exc_type.__name__
            payload["error_module"] = exc_type.__module__
            payload["error_message"] = bounded(exc)
        return json.dumps(payload, separators=(",", ":"))


#The stdlib ``LogRecord`` attributes every record carries regardless of
#what a caller passed as ``extra=``. Anything NOT in this set on a record
#came in through ``extra`` and is therefore something the emitting code
#chose to attach -- see ``RawLoggerJSONFormatter`` below.
_STANDARD_RECORD_ATTRS = frozenset({
    "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
    "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
    "created", "msecs", "relativeCreated", "thread", "threadName",
    "processName", "process", "message", "taskName",
})


class RawLoggerJSONFormatter(logging.Formatter):
    """Render EVERY record from a third-party logger as one line of JSON
    carrying a real ``severity``.

    ``SingleLineJSONFormatter`` above is for OUR OWN call sites, which choose
    their own severity and a fixed ``event`` per formatter. This is for a
    logger we do not control -- today, procrastinate's worker -- whose
    ``logging.log(level, text, extra=...)`` calls already pick the correct
    Python level (``Worker._log_job_outcome`` logs INFO for a job success or
    a retried failure and ERROR only once a job is TERMINALLY failed with no
    retry left), but which the default ``%(message)s`` formatter renders as
    plain, unstructured text.

    THAT IS THE ACTUAL BUG  REPORTED. GKE's logging agent can only read
    `severity` off a line that parses as JSON; an unstructured line gets
    classified by its STREAM instead, and every unconfigured Django logger
    (the ``root`` handler here, like every other logger in this file) writes
    to stderr -- which GKE defaults to ERROR regardless of the Python level
    that produced it. So `Job dyte.sweep_live_meetings... ended with
    status: Success`, logged at `logging.INFO`, arrived in Cloud Logging at
    severity ERROR: 1,765 times in 30 days, drowning out the handful of
    lines that were real terminal failures.

    The fix is exactly the pattern `SingleLineJSONFormatter` already proved
    works for `django_redis`'s ignored exceptions  -- one line of
    JSON with a top-level `severity` -- generalised to carry the record's
    OWN level (`record.levelname`, which for the stdlib's five levels is
    already spelled the way Cloud Logging's `LogSeverity` enum spells them:
    DEBUG/INFO/WARNING/ERROR/CRITICAL) rather than a formatter-fixed one, and
    to forward whatever the emitter attached via `extra=` instead of hand
    -picking fields -- procrastinate's `_log_extra` puts `action`, `worker`,
    `job` and (on completion) the job result on the record, and a new field
    the library adds later is passed through rather than silently dropped,
    because the set excluded here is the FIXED set of attributes every
    `LogRecord` carries, not a guess at procrastinate's current keys.

    UNLIKE `SingleLineJSONFormatter`, this KEEPS the traceback (as
    `stack_trace`, a bounded string -- see MAX_TRACEBACK_CHARS). That
    formatter drops it on purpose, because its callers already choose their
    own structured fields for the failure and the traceback is redundant
    detail on top of them. This one has no such luxury: procrastinate's
    worker passes the REAL exception as `exc_info` for a terminal job error
    (`Worker._process_job`, `exc_info = e`), and that traceback -- which
    task, which line, which nested call -- is the only evidence a terminal
    failure carries at all. Dropping it would make this formatter a
    downgrade from the plain-text logging it replaces, where the traceback
    at least reached Cloud Logging as extra (unlinked, multi-entry) lines.
    A literal newline in the traceback text becomes `\n` inside the JSON
    STRING value, which `json.dumps` escapes automatically -- the line on
    disk stays exactly one physical line, the property this whole module
    exists to guarantee. (Codex adversarial review round 1, finding 1.)
    """

    def __init__(self, event="worker_log", **kwargs):
        super().__init__(**kwargs)
        self.event = event

    def format(self, record):
        payload = {
            "severity": record.levelname,
            "message": bounded(record.getMessage()),
            "event": self.event,
            "logger": record.name,
        }
        for key, value in record.__dict__.items():
            if key in _STANDARD_RECORD_ATTRS or key in payload:
                continue
            encoded = json.dumps(value, default=str, separators=(",", ":"))
            if len(encoded) > MAX_EXTRA_FIELD_CHARS:
                payload[key] = bounded(encoded, MAX_EXTRA_FIELD_CHARS)
            else:
                payload[key] = value
        if record.exc_info and record.exc_info[0] is not None:
            exc_type, exc, exc_tb = record.exc_info
            payload["error_type"] = exc_type.__name__
            payload["error_module"] = exc_type.__module__
            payload["error_message"] = bounded(exc)
            rendered = "".join(
                chunk if len(chunk) <= MAX_TRACEBACK_CHUNK_CHARS
                else chunk[:MAX_TRACEBACK_CHUNK_CHARS] + "…\n"
                for chunk in traceback.TracebackException(
                    exc_type, exc, exc_tb).format()
            ).rstrip("\n")
            payload["stack_trace"] = bounded_traceback(
                rendered, limit=MAX_TRACEBACK_CHARS)
        return json.dumps(payload, default=str, separators=(",", ":"))


class WorkerRootJSONFormatter(RawLoggerJSONFormatter):
    """Format ordinary worker app logs, preserving already-structured lines.

    ``emit_json_line`` deliberately passes its one-line JSON payload as the
    logging message. Wrapping that message would move ``event``, ``alert``,
    ``queue`` and extracted values under ``message`` and replace the event
    name, making the corresponding Cloud Logging filters stop matching. Keep
    a valid single-line structured message intact; use the raw formatter for
    ordinary app log records that still need JSON severity.
    """

    def format(self, record):
        message = record.getMessage()
        if "\n" not in message and "\r" not in message:
            try:
                payload = json.loads(message)
            except (json.JSONDecodeError, TypeError):
                payload = None
            if (isinstance(payload, dict)
                    and "severity" in payload
                    and "message" in payload):
                return message
        return super().format(record)


class ReportingJSONFormatter(RawLoggerJSONFormatter):
    """``RawLoggerJSONFormatter`` for a logger whose exceptions must still
    reach Error Reporting  -- gunicorn's own ``gunicorn.error``.

    Same one-line shape and the record's own ``severity``, but a record that
    carries ``exc_info`` puts the traceback IN ``message`` (and marks the
    entry as a ``ReportedErrorEvent``) instead of in ``stack_trace``:
    ``gunicorn.error``'s ``Error handling request`` is a real crash that
    Error Reporting grouped as plain text before this, and it has to keep
    grouping. ``error_type``/``error_module``/``error_message`` stay, for
    filters.
    """

    def format(self, record):
        payload = json.loads(super().format(record))
        if record.exc_info and record.exc_info[0] is not None:
            payload.pop("stack_trace", None)
            payload["message"] = reported_error_message(
                record.getMessage(), record.exc_info)
            payload["@type"] = REPORTED_ERROR_EVENT_TYPE
        return json.dumps(payload, default=str, separators=(",", ":"))


#Cloud Logging ``jsonPayload.event`` for a ``django.request`` record.
DJANGO_REQUEST_EVENT = "django_request"


class DjangoRequestJSONFormatter(logging.Formatter):
    """One JSON line per ``django.request`` record, graded by STATUS.

    ``django.utils.log.log_response`` writes ``Not Found: /x`` /
    ``Forbidden: /x`` / ``Conflict: /x`` for every 4xx (Python WARNING) and
    ``Internal Server Error: /x`` plus the traceback for a 5xx (ERROR). With
    no formatter they reached the root handler as plain text on stderr, and
    GKE grades plain stderr ERROR regardless of level: ~436 expected 4xx an
    hour sat in every ``severity>=ERROR`` query next to the real 500s.

    * 4xx -> ``INFO``. A 404 for a scanner's ``/.env`` is not a warning about
      this service, and the 4xx that IS worth a look -- a rejected WRITE --
      already gets its own structured WARNING (``event=write_rejected``,
      dj/util/rejected_writes.py, ). WARNING here would count it twice.
    * 5xx -> the record's own level (ERROR), and when the record carries the
      exception the traceback goes INTO ``message`` with ``@type`` set to
      ``ReportedErrorEvent``, so Error Reporting keeps grouping real 500s.
      (Before, the header line and the traceback were two entries; the
      traceback entry was the one that grouped.)

    Only named fields are emitted. ``log_response`` attaches the whole
    ``request`` object via ``extra``; forwarding it (as
    ``RawLoggerJSONFormatter`` does with extras) would ``str()`` it into
    ``<WSGIRequest: GET '/path?query'>`` -- the query string, which can carry
    credentials (see SENSITIVE_QUERY_PARAMS). ``message`` carries
    ``request.path`` exactly as the plain-text line always did, no more.
    """

    def format(self, record):
        status = getattr(record, "status_code", None)
        severity = record.levelname
        if isinstance(status, int) and 400 <= status < 500:
            severity = "INFO"
        payload = {
            "severity": severity,
            "message": bounded(record.getMessage()),
            "event": DJANGO_REQUEST_EVENT,
            "logger": record.name,
        }
        if isinstance(status, int):
            payload["status"] = status
        request = getattr(record, "request", None)
        method = getattr(request, "method", None)
        if isinstance(method, str):
            payload["method"] = bounded(method, limit=16)
        self._add_trace(payload, request)
        if record.exc_info and record.exc_info[0] is not None:
            exc_type = record.exc_info[0]
            payload["error_type"] = exc_type.__name__
            payload["error_module"] = exc_type.__module__
            # Django passes the exception for 4xx too (PermissionDenied,
            # BadRequest, a parse error). Those are the client's problem:
            # the type is enough, and a traceback + @type would hand an
            # expected 403 to Error Reporting. Only a real error is reported.
            if severity in ("ERROR", "CRITICAL"):
                payload["message"] = reported_error_message(
                    record.getMessage(), record.exc_info)
                payload["@type"] = REPORTED_ERROR_EVENT_TYPE
        return json.dumps(payload, default=str, separators=(",", ":"))

    @staticmethod
    def _add_trace(payload, request):
        """Join this entry to the GCLB request log, as write_rejected does.

        Imported lazily: rejected_writes needs settings and DRF, and this
        module must stay importable before the app registry is ready. A
        logging formatter must never raise, so any failure means no trace.
        """
        if request is None:
            return
        try:
            from django.conf import settings

            from dj.util.rejected_writes import trace_id

            trace = trace_id(request)
            if trace:
                project = getattr(settings, "PROJECT_ID", "free2z")
                payload["logging.googleapis.com/trace"] = (
                    f"projects/{project}/traces/{trace}")
        except Exception:  # noqa: BLE001 -- a formatter must not raise
            pass
