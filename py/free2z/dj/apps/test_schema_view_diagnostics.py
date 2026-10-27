"""`/api/schema/` must not print drf-spectacular's diagnostics to stderr.

GKE grades a plain stderr line ERROR, and every schema hit printed ~72 of
them in prod. See dj/free2z/schema_view.py.

The probe is a warning this test injects into schema generation, so the
assertions do not depend on how many real diagnostics the codebase happens to
have today (a codebase with none would make an absence check pass vacuously).
The stock-view test is the negative control: the same request through
drf-spectacular's own view DOES print the probe.
"""

import threading

import pytest
from django.urls import resolve
from drf_spectacular import generators
from drf_spectacular.drainage import GENERATOR_STATS, warn
from drf_spectacular.views import SpectacularAPIView
from rest_framework.test import APIRequestFactory

from dj.free2z import schema_view
from dj.free2z.schema_view import SchemaView, generator_diagnostics_silenced

PROBE = "w2198-probe: injected schema-generation diagnostic"


@pytest.fixture
def probe(monkeypatch):
    """Make every get_schema() emit PROBE through drf-spectacular's own path."""
    original = generators.SchemaGenerator.get_schema

    def get_schema(self, *args, **kwargs):
        schema = original(self, *args, **kwargs)
        # After the original: get_schema() resets the stats cache first, so
        # the probe is counted for THIS call and is not de-duplicated away.
        warn(PROBE)
        return schema

    monkeypatch.setattr(generators.SchemaGenerator, "get_schema", get_schema)
    # Start from drf-spectacular's real default (not silenced), as a fresh
    # gunicorn worker does, and put back whatever the suite had.
    previous = GENERATOR_STATS.silent
    GENERATOR_STATS.silent = False
    yield
    GENERATOR_STATS.silent = previous


def _get_schema(view_class):
    request = APIRequestFactory().get("/api/schema/")
    response = view_class.as_view()(request)
    response.render()
    return response


def test_the_url_is_served_by_the_quiet_view():
    assert resolve("/api/schema/").func.view_class is SchemaView


def test_schema_view_keeps_diagnostics_off_stderr(probe, capsys):
    response = _get_schema(SchemaView)

    assert response.status_code == 200
    assert response.content.startswith(b"openapi: 3.")
    err = capsys.readouterr().err
    assert PROBE not in err
    assert "Warning" not in err and "Error" not in err, err[:500]
    # Silenced, not lost: drf-spectacular still counted it.
    assert any(PROBE in msg for msg in GENERATOR_STATS._warn_cache)
    # And restored for everything else in the process (manage.py
    # spectacular, the system check) once the request is done.
    assert GENERATOR_STATS.silent is False


def test_negative_control_the_stock_view_prints_to_stderr(probe, capsys):
    response = _get_schema(SpectacularAPIView)

    assert response.status_code == 200
    assert PROBE in capsys.readouterr().err


def test_the_schema_body_is_unchanged(probe):
    assert _get_schema(SchemaView).content == _get_schema(SpectacularAPIView).content


def test_overlapping_requests_neither_leak_nor_stick(probe):
    """Threaded gunicorn: A starts, B starts, A ends while B is generating."""
    assert GENERATOR_STATS.silent is False
    with generator_diagnostics_silenced():          # A
        with_b = threading.Event()
        a_done = threading.Event()
        seen_by_b = []

        def request_b():
            with generator_diagnostics_silenced():  # B
                with_b.set()
                a_done.wait(5)
                seen_by_b.append(GENERATOR_STATS.silent)

        t = threading.Thread(target=request_b)
        t.start()
        assert with_b.wait(5)
    # A has exited; B is still inside.
    a_done.set()
    t.join(5)
    assert seen_by_b == [True], "A's exit un-silenced B mid-generation"
    assert GENERATOR_STATS.silent is False, "the silence stuck after both ended"
    assert schema_view._depth == 0


def test_nesting_restores_a_caller_that_was_already_silent(probe):
    GENERATOR_STATS.silent = True
    with generator_diagnostics_silenced():
        with generator_diagnostics_silenced():
            pass
    assert GENERATOR_STATS.silent is True
