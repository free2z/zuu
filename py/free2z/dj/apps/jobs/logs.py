"""
One-line JSON log emission, shared by the jobs app.

GKE's logging agent turns a log line that is *entirely* JSON into
``jsonPayload`` and honours a top-level ``severity``, so these become
structured, filterable Cloud Logging entries with no formatter change to
``settings.LOGGING`` (a plain ``StreamHandler`` with the default
``%(message)s``).

Two rules are load-bearing and are why this lives in one place rather
than being copy-pasted per module:

* the JSON must be on **ONE line** -- a wrapped line is delivered as
  several unparsed ``textPayload`` entries and every ``jsonPayload.*``
  filter in ``monitoring/`` silently stops matching;
* ``message`` must be present -- without it the Logs Explorer shows an
  empty summary row, and the give-up policy in  matches on exactly
  that field.

The caller passes its OWN logger so the record keeps the emitting
module's name; tests filter on it.
"""
from __future__ import annotations

import json
import logging
from typing import Any


def emit_json_line(
    logger: logging.Logger,
    payload: dict[str, Any],
    severity: str,
    message: str,
) -> None:
    # Order matters only for human readability of the raw line.
    body: dict[str, Any] = {'severity': severity, 'message': message}
    body.update(payload)
    line = json.dumps(body, default=str, sort_keys=False)
    logger.log(logging.ERROR if severity == 'ERROR' else logging.INFO, line)
