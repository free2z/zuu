"""Startup diagnostics stay out of one-shot management commands.

the payment host's credit loop runs ``manage.py credit_creators`` and
``manage.py credit_pages_unified`` every cycle. Each one booted Django and
logged the AI-provider availability line  and ~30 procrastinate
periodic-task / blueprint registration lines (visible since ), on a host
that never translates and never runs a worker.

Every "quiet" assertion here is paired with the same thing under a serving
argv (gunicorn, ``procrastinate worker``) still producing the line. That
pairing is the negative control: a filter that dropped the lines everywhere,
or a test whose capture saw nothing at all, fails the second half.
"""
import io
import logging
import sys

import pytest
from django.apps import apps

from dj.free2z.process_role import (
    OneShotStartupNoiseFilter,
    is_one_shot_command,
)
from f2z.ai import providers

ONE_SHOT = ["/home/x/tuzi/py/free2z/dj/free2z/manage.py", "credit_creators"]
SERVING = [
    ["/usr/local/bin/gunicorn", "dj.free2z.wsgi"],
    ["/usr/local/bin/daphne", "dj.free2z.asgi:application"],
    ["manage.py", "procrastinate", "worker", "--queues=default"],
    ["manage.py", "procrastinate", "--verbose", "worker"],
    ["manage.py", "runserver"],
    # k8s/free2z/sub: long-lived Pub/Sub subscribers launched as
    # `manage.py <command>`; two of them call OpenAI.
    ["/py/free2z/dj/free2z/manage.py", "describe_zpage_listener"],
    ["/py/free2z/dj/free2z/manage.py", "aiscore_comments"],
]





def test_missing_sys_argv_is_loud_not_a_crash(monkeypatch):
    monkeypatch.delattr(sys, "argv")
    assert is_one_shot_command() is False
    assert OneShotStartupNoiseFilter().quiet is False


@pytest.mark.parametrize("argv", [
    ONE_SHOT,
    ["manage.py", "credit_pages_unified"],
    ["manage.py", "migrate"],
    ["django-admin", "check"],
    ["/x/django/__main__.py", "shell"],
    ["manage.py", "procrastinate", "defer", "jobs.sweep_outbox"],
])
def test_one_shot_commands_are_quiet(argv):
    assert is_one_shot_command(argv) is True


@pytest.mark.parametrize("argv", SERVING + [
    # Anything that is not visibly `manage.py <command>` keeps its lines.
    ["/usr/bin/pytest"],
    # `python -m pytest`, how CI runs the suite: argv[0] is a __main__.py,
    # but not django's.
    ["/x/site-packages/pytest/__main__.py", "dj/apps"],
    ["manage.py"],
    [],
])
def test_servers_workers_and_the_unclassifiable_are_not(argv):
    assert is_one_shot_command(argv) is False


def _record(action, msg="Registering task x"):
    record = logging.LogRecord(
        "procrastinate.periodic", logging.INFO, __file__, 1, msg, None, None,
    )
    if action is not None:
        record.action = action
    return record


def test_filter_drops_only_the_startup_registration_lines():
    quiet = OneShotStartupNoiseFilter(argv=ONE_SHOT)
    assert not quiet.filter(_record("registering_periodic_task"))
    assert not quiet.filter(_record("loading_blueprint"))
    # Everything else procrastinate says in a one-shot command still shows,
    # e.g. `manage.py procrastinate defer`'s own output.
    assert quiet.filter(_record("job_defer"))
    assert quiet.filter(_record(None))

    for argv in SERVING:
        loud = OneShotStartupNoiseFilter(argv=argv)
        assert loud.filter(_record("registering_periodic_task")), argv
        assert loud.filter(_record("loading_blueprint")), argv


@pytest.fixture
def procrastinate_stream(monkeypatch):
    """The LIVE `procrastinate` handler from settings.LOGGING, captured.

    Returns (stream, filter). Going through the configured handler proves the
    wiring: a filter attached to the `procrastinate` LOGGER instead would be
    skipped for records that propagate from `procrastinate.periodic`.
    """
    handlers = logging.getLogger("procrastinate").handlers
    matches = [
        (h, f) for h in handlers for f in h.filters
        if isinstance(f, OneShotStartupNoiseFilter)
    ]
    assert len(matches) == 1, "settings.LOGGING lost the #2144 filter"
    handler, noise_filter = matches[0]
    stream = io.StringIO()
    old = handler.setStream(stream)
    yield stream, noise_filter
    handler.setStream(old)


def _emit_from_children():
    logging.getLogger("procrastinate.periodic").info(
        "Registering task x with periodic id '' to run periodically",
        extra={"action": "registering_periodic_task"},
    )
    logging.getLogger("procrastinate.blueprints").info(
        "Adding tasks from blueprint", extra={"action": "loading_blueprint"},
    )
    logging.getLogger("procrastinate.worker").info(
        "Job ended", extra={"action": "job_success"},
    )


def test_configured_handler_quiets_a_one_shot_process(
    procrastinate_stream, monkeypatch,
):
    stream, noise_filter = procrastinate_stream
    monkeypatch.setattr(noise_filter, "quiet", True)
    _emit_from_children()
    out = stream.getvalue()
    assert "registering_periodic_task" not in out
    assert "loading_blueprint" not in out
    assert "job_success" in out, out


def test_configured_handler_keeps_them_in_a_serving_process(
    procrastinate_stream, monkeypatch,
):
    stream, noise_filter = procrastinate_stream
    monkeypatch.setattr(noise_filter, "quiet", False)
    _emit_from_children()
    out = stream.getvalue()
    assert "registering_periodic_task" in out
    assert "loading_blueprint" in out
    assert "job_success" in out


@pytest.fixture
def unconfigured_provider(settings):
    settings.OPENAI_API_KEY = "sk-test-openai"
    settings.ANTHROPIC_API_KEY = ""
    settings.XAI_API_KEY = ""
    settings.MOONSHOT_API_KEY = ""


def _availability_lines(caplog):
    return [
        r for r in caplog.records
        if '"event":"ai_providers_' in r.getMessage()
    ]


def test_ai_availability_line_is_not_logged_by_a_one_shot_command(
    unconfigured_provider, caplog, monkeypatch,
):
    monkeypatch.setattr(sys, "argv", ONE_SHOT)
    caplog.set_level(logging.INFO)
    apps.get_app_config("openai").ready()
    assert _availability_lines(caplog) == []


@pytest.mark.parametrize("argv", SERVING)
def test_ai_availability_line_is_still_logged_by_servers(
    unconfigured_provider, caplog, monkeypatch, argv,
):
    monkeypatch.setattr(sys, "argv", argv)
    caplog.set_level(logging.INFO)
    apps.get_app_config("openai").ready()
    lines = _availability_lines(caplog)
    assert len(lines) == 1, argv
    assert providers.AI_PROVIDERS_UNCONFIGURED_EVENT in lines[0].getMessage()
