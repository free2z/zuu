"""Log lines graded by what they mean, not by the stream they used.

GKE's logging agent reads ``severity`` off a stdout/stderr line only when the
line is ONE JSON object; anything else is graded by stream, and every plain
stderr line is ERROR. Three sources wrote plain stderr for routine events:

* Django's ``django.request`` (``Not Found: /x`` for every 4xx) --
  ``DjangoRequestJSONFormatter`` wired in ``settings.LOGGING``;
* gunicorn's own error log (``[INFO] Booting worker``) --
  ``dj.free2z.gunicorn_logging.JSONErrorLogger`` via ``--logger-class``;
* the video-decoder's access log (``INFO... "GET /healthz" 200``) --
  ``video_decoder_service.configure_logging``.

Each case asserts the line a real emitter produces, parses it as JSON (one
physical line) and checks ``severity``; each has a negative control showing
what the unfixed path wrote. A real 500 must STILL reach Error Reporting, so
its traceback is asserted inside ``message``.
"""
import http.client
import io
import json
import logging
import sys
import threading

import pytest
from django.http import HttpResponse
from django.test import RequestFactory
from django.utils.log import log_response

from dj.free2z import log_json
from dj.free2z.log_json import (
    MAX_REPORTED_TRACEBACK_CHARS,
    REPORTED_ERROR_EVENT_TYPE,
    DjangoRequestJSONFormatter,
)


def _one_json_line(text):
    lines = [line for line in text.splitlines() if line.strip()]
    assert len(lines) == 1, lines
    return json.loads(lines[0])


@pytest.fixture
def django_request_output():
    """The stream behind settings.LOGGING's django.request handler."""
    logger = logging.getLogger("django.request")
    handlers = [h for h in logger.handlers
                if isinstance(h.formatter, DjangoRequestJSONFormatter)]
    assert len(handlers) == 1, logger.handlers
    buf = io.StringIO()
    old = handlers[0].setStream(buf)
    try:
        yield buf
    finally:
        handlers[0].setStream(old)


# -- django.request --------------------------------------------------------


def test_settings_route_django_request_through_the_json_formatter():
    logger = logging.getLogger("django.request")
    assert logger.propagate is False, (
        "propagating would ALSO print the record through the plain root "
        "handler -- the ERROR-graded line this exists to remove")
    assert any(isinstance(h.formatter, DjangoRequestJSONFormatter)
               for h in logger.handlers)


@pytest.mark.django_db
def test_a_real_404_is_one_info_json_line(client, django_request_output):
    response = client.get("/api/no-such-route-2189/?token=SECRETVALUE")
    assert response.status_code == 404
    payload = _one_json_line(django_request_output.getvalue())
    assert payload["severity"] == "INFO"
    assert payload["status"] == 404
    assert payload["method"] == "GET"
    assert payload["event"] == "django_request"
    assert payload["message"] == "Not Found: /api/no-such-route-2189/"
    # log_response attaches the request object; its repr carries the query
    # string, which must never be forwarded.
    assert "SECRETVALUE" not in django_request_output.getvalue()


@pytest.mark.parametrize("status,text", [
    (403, "Forbidden"), (409, "Conflict"), (400, "Bad Request"),
])
def test_every_4xx_is_info(status, text, django_request_output):
    request = RequestFactory().post("/api/zpage/")
    log_response(f"{text}: %s", request.path,
                 response=HttpResponse(status=status), request=request)
    payload = _one_json_line(django_request_output.getvalue())
    assert payload["severity"] == "INFO"
    assert payload["status"] == status
    assert payload["method"] == "POST"
    assert "@type" not in payload


def _raise_in_a_view():
    def view_body():
        raise ValueError("boom-2189")
    view_body()


def test_a_real_500_is_error_with_the_traceback_for_error_reporting(
        django_request_output):
    request = RequestFactory().get(
        "/api/comments/", HTTP_X_CLOUD_TRACE_CONTEXT="0123456789abcdef0123456789abcdef/1;o=1")
    try:
        _raise_in_a_view()
    except ValueError:
        # Exactly what django.core.handlers.exception.response_for_exception
        # does for an unhandled exception.
        log_response("%s: %s", "Internal Server Error", request.path,
                     response=HttpResponse(status=500), request=request,
                     exception=sys.exc_info()[1])
    raw = django_request_output.getvalue()
    payload = _one_json_line(raw)
    assert payload["severity"] == "ERROR"
    assert payload["status"] == 500
    assert payload["@type"] == REPORTED_ERROR_EVENT_TYPE
    assert payload["error_type"] == "ValueError"
    message = payload["message"]
    assert message.startswith(
        "Internal Server Error: /api/comments/\n"
        "Traceback (most recent call last):\n")
    assert "view_body" in message
    assert message.rstrip().endswith("ValueError: boom-2189")
    assert payload["logging.googleapis.com/trace"].endswith(
        "/traces/0123456789abcdef0123456789abcdef")


def test_a_4xx_that_carries_an_exception_is_not_reported(
        django_request_output):
    """response_for_exception passes the exception for PermissionDenied /
    BadRequest too. An expected 403 must not become an Error Reporting
    event: INFO, the type only, no traceback, no @type."""
    from django.core.exceptions import PermissionDenied

    request = RequestFactory().get("/api/x/")
    try:
        raise PermissionDenied("nope")
    except PermissionDenied as exc:
        log_response("Forbidden (Permission denied): %s", request.path,
                     response=HttpResponse(status=403), request=request,
                     exception=exc)
    payload = _one_json_line(django_request_output.getvalue())
    assert payload["severity"] == "INFO"
    assert payload["error_type"] == "PermissionDenied"
    assert "@type" not in payload
    assert "Traceback" not in payload["message"]


def test_a_5xx_without_an_exception_is_error_but_not_a_reported_event(
        django_request_output):
    """With @type set and no stack, Error Reporting wants reportLocation."""
    request = RequestFactory().get("/api/x/")
    log_response("Service Unavailable: %s", request.path,
                 response=HttpResponse(status=503), request=request)
    payload = _one_json_line(django_request_output.getvalue())
    assert payload["severity"] == "ERROR"
    assert "@type" not in payload


def test_negative_control_django_default_formatting_is_plain_text():
    """What the root handler printed before: not JSON, so GKE graded it by
    stream (stderr -> ERROR) whatever the Python level."""
    buf = io.StringIO()
    handler = logging.StreamHandler(buf)  # the root 'console' handler shape
    record = logging.LogRecord("django.request", logging.WARNING, __file__, 1,
                               "Not Found: %s", ("/x",), None)
    handler.handle(record)
    with pytest.raises(json.JSONDecodeError):
        json.loads(buf.getvalue())


def test_a_huge_traceback_keeps_its_head_and_its_tail():
    """Error Reporting parses from ``Traceback (most recent call last):`` and
    groups on the final ``ValueError:`` line -- truncation must keep both."""
    frames = "".join(f'  File "f{i}.py", line {i}, in g{i}\n    x()\n'
                     for i in range(3000))
    text = "Traceback (most recent call last):\n" + frames + "ValueError: last"
    out = log_json.bounded_traceback(text)
    assert len(out) <= MAX_REPORTED_TRACEBACK_CHARS + 64
    assert out.startswith("Traceback (most recent call last):\n")
    assert out.endswith("ValueError: last")


def test_a_huge_exception_message_does_not_push_out_the_frames():
    """Codex review: tail-truncation alone let a 20 KB str(exc) (an upstream
    body echoed into the exception) fill the whole budget, leaving no frame,
    no type and no prefix."""
    try:
        _raise_huge()
    except ValueError:
        message = log_json.reported_error_message(
            "Internal Server Error: /x", sys.exc_info())
    assert message.startswith(
        "Internal Server Error: /x\nTraceback (most recent call last):\n")
    assert "_raise_huge" in message
    assert "ValueError: " in message
    assert len(message) < 4000


def _raise_huge():
    raise ValueError("x" * 20000)


# -- gunicorn --------------------------------------------------------------


def _gunicorn_logger(logger_class):
    from gunicorn.config import Config

    cfg = Config()
    cfg.set("errorlog", "-")
    cfg.set("accesslog", "-")
    log = logger_class(cfg)
    buf = io.StringIO()
    for handler in log.error_log.handlers:
        if getattr(handler, "_gunicorn", False):
            handler.setStream(buf)
    return log, buf


def test_gunicorn_info_is_info_json():
    from dj.free2z.gunicorn_logging import JSONErrorLogger

    log, buf = _gunicorn_logger(JSONErrorLogger)
    log.info("Booting worker with pid: %s", 7)
    payload = _one_json_line(buf.getvalue())
    assert payload == {
        "severity": "INFO", "message": "Booting worker with pid: 7",
        "event": "gunicorn_log", "logger": "gunicorn.error",
    }


def test_gunicorn_crash_keeps_its_traceback_for_error_reporting():
    from dj.free2z.gunicorn_logging import JSONErrorLogger

    log, buf = _gunicorn_logger(JSONErrorLogger)
    try:
        _raise_in_a_view()
    except ValueError:
        log.exception("Error handling request %s", "/api/x")
    payload = _one_json_line(buf.getvalue())
    assert payload["severity"] == "ERROR"
    assert payload["@type"] == REPORTED_ERROR_EVENT_TYPE
    assert payload["message"].startswith(
        "Error handling request /api/x\nTraceback (most recent call last):")
    assert payload["message"].endswith("ValueError: boom-2189")
    assert "stack_trace" not in payload


def test_gunicorn_access_log_is_left_alone():
    """stdout, plain text, matched by the sitemap_outcome log metrics."""
    from dj.free2z.gunicorn_logging import JSONErrorLogger

    log, _ = _gunicorn_logger(JSONErrorLogger)
    ours = [h for h in log.access_log.handlers if getattr(h, "_gunicorn", False)]
    assert ours
    for handler in ours:
        assert handler.stream is sys.stdout
        assert type(handler.formatter) is logging.Formatter


def test_negative_control_stock_gunicorn_logger_is_plain_text():
    from gunicorn.glogging import Logger

    log, buf = _gunicorn_logger(Logger)
    log.info("Booting worker with pid: %s", 7)
    assert "[INFO] Booting worker with pid: 7" in buf.getvalue()
    with pytest.raises(json.JSONDecodeError):
        json.loads(buf.getvalue())


# -- video-decoder ---------------------------------------------------------


@pytest.fixture
def decoder_log():
    from dj.apps.uploads import video_decoder_service

    root = logging.getLogger()
    saved_handlers, saved_level = list(root.handlers), root.level
    buf = io.StringIO()
    video_decoder_service.configure_logging(stream=buf)
    server = video_decoder_service.make_server("127.0.0.1", 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1], buf
    finally:
        server.shutdown()
        server.server_close()
        for handler in list(root.handlers):
            root.removeHandler(handler)
        for handler in saved_handlers:
            root.addHandler(handler)
        root.setLevel(saved_level)


def _get(port, path):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        conn.request("GET", path)
        response = conn.getresponse()
        response.read()
        return response.status
    finally:
        conn.close()


def test_decoder_healthz_probe_is_not_logged(decoder_log):
    port, buf = decoder_log
    assert _get(port, "/healthz") == 200
    assert buf.getvalue() == ""


def test_decoder_access_line_is_info_json(decoder_log):
    port, buf = decoder_log
    status = _get(port, "/nope")
    payload = _one_json_line(buf.getvalue())
    assert payload["severity"] == "INFO"
    assert payload["event"] == "video_decoder_log"
    assert f'"GET /nope HTTP/1.1" {status}' in payload["message"]


def test_decoder_malformed_request_line_still_answers_and_logs_json(
        decoder_log):
    """send_error(400) runs log_request before the stdlib sets `path`."""
    import socket

    port, buf = decoder_log
    with socket.create_connection(("127.0.0.1", port), timeout=10) as sock:
        sock.sendall(b"GET / HTTP/broken\r\n\r\n")
        answer = sock.recv(4096)
    # A request line that does not parse is answered HTTP/0.9-style (body
    # only), so the proof it was answered at all is the 400 page.
    assert b"400 - Bad request syntax" in answer
    lines = [json.loads(line) for line in buf.getvalue().splitlines()]
    assert lines and all(line["severity"] in ("INFO", "WARNING") for line in lines)


def test_negative_control_decoder_used_to_write_plain_stderr():
    """The old basicConfig format: `... INFO video_decoder_service:...`."""
    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s: %(message)s")
    record = logging.LogRecord("video_decoder_service", logging.INFO,
                               __file__, 1, '10.8.2.1 "GET /healthz" 200 -',
                               (), None)
    with pytest.raises(json.JSONDecodeError):
        json.loads(formatter.format(record))
