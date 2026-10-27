"""gunicorn's own error log as one JSON line per record.

``--error-logfile=-`` writes ``gunicorn.error`` to stderr as
``[2026-09-26 17:41:53 +0000] [7] [INFO] Booting worker with pid: 7``. GKE's
logging agent cannot read a level off plain text, so it grades by stream and
every stderr line is ERROR: every deploy put a dozen ``Starting gunicorn`` /
``Booting worker`` / ``Handling signal: term`` lines per pod into
``severity>=ERROR``.

Selected with ``--logger-class dj.free2z.gunicorn_logging.JSONErrorLogger``
in the Deployment. Only the FORMATTER of gunicorn's own error-log handlers
changes: the handlers, streams, levels and the access log (stdout, graded
INFO, matched by the sitemap_outcome log metrics) are exactly what gunicorn
set up, and ``dj.apps.health.log_filters`` still filters the same logger
objects. An exception gunicorn logs (``Error handling request``) keeps its
traceback, inside ``message``, so Error Reporting still groups it.

Imported by the gunicorn MASTER before Django is set up, so like log_json it
must not import anything that needs settings or the app registry.
"""

from gunicorn.glogging import Logger

from dj.free2z.log_json import ReportingJSONFormatter

#Cloud Logging ``jsonPayload.event`` for a gunicorn error-log record.
GUNICORN_EVENT = "gunicorn_log"


class JSONErrorLogger(Logger):
    def setup(self, cfg):
        super().setup(cfg)
        formatter = ReportingJSONFormatter(event=GUNICORN_EVENT)
        for handler in self.error_log.handlers:
            # Only the handlers gunicorn itself installed (it marks them);
            # anything a logconfig added keeps its own formatting.
            if getattr(handler, "_gunicorn", False):
                handler.setFormatter(formatter)
