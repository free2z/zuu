"""`/api/schema/`, without drf-spectacular's generator diagnostics on stderr.

. drf-spectacular reports every schema-generation problem ("unable to
guess serializer", "unable to resolve type hint", operationId collisions...)
by ``print(..., file=sys.stderr)`` from ``drainage.GeneratorStats.emit``, and
``SchemaGenerator.get_schema`` resets its de-duplication cache on every call.
So every request to this endpoint re-printed the whole list -- ~72 lines in
prod -- onto gunicorn's stderr, and GKE grades plain stderr ERROR. Over
2026-09-30..10-04 that was 2,736 of free2z-gunicorn's 3,032 ERROR entries in
prod (38 schema hits), none of them a runtime fault.

Those diagnostics describe the CODE, not the request: they are identical for
every hit of a given build, and ``bin/gen-openapi.sh`` (``manage.py
spectacular``, which CI runs) is where they belong. This view silences them
only while it is generating a schema; the management command, the Django
system check and everything else keep drf-spectacular's own behaviour.

The silence is reference-counted rather than ``GENERATOR_STATS.silence()``:
``silent`` is one process-wide attribute and gunicorn runs threaded workers,
so two overlapping requests through ``silence()`` (which saves and restores a
single previous value) could leave it either off while a schema is still
being generated or permanently on.
"""

import threading
from contextlib import contextmanager

from drf_spectacular.drainage import GENERATOR_STATS
from drf_spectacular.views import SpectacularAPIView

_lock = threading.Lock()
_depth = 0
_restore = False


@contextmanager
def generator_diagnostics_silenced():
    global _depth, _restore
    with _lock:
        if _depth == 0:
            _restore = GENERATOR_STATS.silent
            GENERATOR_STATS.silent = True
        _depth += 1
    try:
        yield
    finally:
        with _lock:
            _depth -= 1
            if _depth == 0:
                GENERATOR_STATS.silent = _restore


class SchemaView(SpectacularAPIView):
    # drf-spectacular documents this operation from the view's docstring;
    # keep the library's so f2z.yaml does not change.
    __doc__ = SpectacularAPIView.__doc__

    def _get_schema_response(self, request):
        # get_schema() runs (and would emit) inside this call; rendering the
        # Response later only serialises the finished dict.
        with generator_diagnostics_silenced():
            return super()._get_schema_response(request)
