"""
The isolated video decoder: the process that meets the demuxer.

    python -m dj.apps.uploads.video_decoder_service --port 8090

WHAT IT IS
----------
An HTTP server whose only job is to run `video_utils._run_decoder_child` --
the rlimited FFmpeg child  introduced -- over bytes a caller POSTs to
it, and answer with the poster. It runs in the `video-decoder` Deployment
(k8s/free2z/video-decoder/), a pod that deliberately has NOTHING: its own
ServiceAccount with no Workload Identity binding, no projected token, no
`envFrom` (so no Secret and no ConfigMap), a NetworkPolicy that allows no
egress at all, and the same restricted securityContext as every other pod.
The procrastinate worker keeps the identity, the bucket and the database;
it streams the source in and takes the WebP out over one request.

Why this shape and not "run the poster job in the isolated pod": the job
needs Postgres (to fetch work) and the bucket (to read the video and write
the poster), and both of those are identity. Anything that can do the job
can be exploited into doing other things with that identity. Splitting at
the demux means the process that parses attacker-controlled bytes is the one
with no capabilities, which is the only split that removes the target rather
than moving it.

WHAT IT MUST NOT BECOME
-----------------------
It imports no Django, holds no settings, and reads no environment beyond
the port and the temp dir. `dj/__init__.py`, `dj/apps/__init__.py` and
`dj/apps/uploads/__init__.py` are empty, so `-m dj.apps.uploads.video_decoder_service`
starts without touching a database driver or a credential. Keep it that way:
a convenience import of `django.conf.settings` here would silently make this
process need the ConfigMap, and the manifest test that asserts the pod has
no `envFrom` would then be asserting a pod that cannot start.

BOUNDS
------
* Request bodies need a `Content-Length` (no chunked bodies: `http.server`
  does not read them, and a body it cannot size is a body it cannot bound)
  of at most `MAX_SOURCE_BYTES`, spooled to `/tmp` -- an emptyDir with a
  sizeLimit in the manifest, sized for exactly one such body.
* ONE decode at a time. The child's `RLIMIT_AS` is 768 MiB against a 1 GiB
  pod; two of them is an OOMKill. A second request waits up to
  `DECODER_BUSY_WAIT_SECONDS` for the slot and is then told `503`, which
  the worker treats as retryable. Today there is exactly one caller (the
  concurrency-1 catch-all worker), so the slot is defence, not a queue.
* Demux/decode has the child's own rlimits and parent's wall clock,
  unchanged from `video_utils`. A body watchdog interrupts dripping uploads
  within the remaining connected-exchange budget. Header/idle handler count
  remains unbounded; this is not a general-purpose hardened HTTP server.

The answer is one JSON object. `ok: true` carries `width`, `height` and
`webp_base64`; `ok: false` carries `reason` and `retryable`, and the worker
believes `retryable` -- so this file is the one place that decides whether
"busy" (yes) and "the file is undecodable" (no) burn a retry.
"""
import argparse
import base64
import json
import logging
import signal
import socket
import sys
import tempfile
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from dj.apps.uploads.video_utils import (
    MAX_SOURCE_BYTES,
    POSTER_DECODER_FORMAT_HEADER,
    POSTER_DECODER_PATH,
    POSTER_DECODER_PROTOCOL,
    POSTER_DECODER_TIMEOUT_SECONDS,
    POSTER_DECODER_PROTOCOL_HEADER,
    POSTER_SUBPROCESS_TIMEOUT_SECONDS,
    PosterRetryable,
    PosterUnavailable,
    _DEMUX_FORMATS,
    _run_decoder_child,
)
from dj.free2z.log_json import RawLoggerJSONFormatter


logger = logging.getLogger("video_decoder_service")

DEFAULT_PORT = 8090
HEALTH_PATH = "/healthz"

# How long a second request waits for the single decode slot before being
# refused. Short on purpose: the caller's socket timeout has to cover this
# PLUS a whole decode, and a worker slot held waiting is a worker slot not
# serving notifications.
DECODER_BUSY_WAIT_SECONDS = 30

# Socket timeout on each request, so a client that connects and stalls
# cannot hold a handler thread (and its spooled file) forever.
REQUEST_SOCKET_TIMEOUT_SECONDS = 60
# Budget the body inside the worker's connected exchange: busy wait + body
# + decode + 10s reap + 5s answer overhead = 180s with the shared defaults.
REQUEST_BODY_TIMEOUT_SECONDS = (
    POSTER_DECODER_TIMEOUT_SECONDS - DECODER_BUSY_WAIT_SECONDS
    - POSTER_SUBPROCESS_TIMEOUT_SECONDS - 10 - 5
)
if REQUEST_BODY_TIMEOUT_SECONDS <= 0:
    raise ValueError("decoder exchange budget leaves no time to receive a body")

SPOOL_CHUNK_BYTES = 1024 * 1024

# Only one body on disk at a time, too: /tmp is sized for one
# MAX_SOURCE_BYTES spool, and a second concurrent upload would evict the pod
# on the emptyDir sizeLimit rather than fail cleanly. Held from the first
# body byte to the end of the decode.
_slot = threading.BoundedSemaphore(1)


class _Refused(Exception):
    """A request the service will not process; `status` names how."""

    def __init__(self, status, reason, retryable=False):
        super().__init__(reason)
        self.status = status
        self.reason = reason
        self.retryable = retryable


class DecoderHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = REQUEST_SOCKET_TIMEOUT_SECONDS
    # `server_version`/`sys_version` would advertise the Python version in
    # every response header. Nothing needs it.
    server_version = "video-decoder"
    sys_version = ""

    def log_message(self, fmt, *args):  # noqa: D102 - stdlib hook
        logger.info("%s " + fmt, self.address_string(), *args)

    def log_request(self, code="-", size="-"):  # noqa: D102 - stdlib hook
        # The kubelet's readiness (10s) and liveness (30s) probes are ~9 of
        # every 10 access lines and say nothing a Ready condition does not
        #. A FAILING probe is still logged -- that one is news.
        # getattr: send_error() runs this for a request line that failed to
        # parse, before the stdlib has set `path` (codex review, ).
        status = getattr(code, "value", code)
        path = getattr(self, "path", None)
        if path == HEALTH_PATH and status == HTTPStatus.OK:
            return
        level = logging.INFO
        if isinstance(status, int) and status >= 500:
            level = logging.WARNING
        logger.log(level, '%s "%s" %s %s', self.address_string(),
                   getattr(self, "requestline", ""), status, size)

    def log_error(self, fmt, *args):  # noqa: D102 - stdlib hook
        # The stdlib routes send_error()/timeouts here and then to
        # log_message at INFO; they are worth more than an access line.
        logger.warning("%s " + fmt, self.address_string(), *args)

    # -- helpers ----------------------------------------------------------

    def _answer(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if status == HTTPStatus.SERVICE_UNAVAILABLE:
            self.send_header("Retry-After", "5")
        self.end_headers()
        self.wfile.write(body)

    def _refuse(self, status, reason, retryable=False):
        self._answer(status, {
            "ok": False, "reason": reason, "retryable": retryable,
        })

    def _spool_body(self, length, spool):
        """Copy exactly `length` bytes of the request into `spool`."""
        def abort_body():
            # A timeout on read() alone resets whenever another byte arrives.
            # shutdown interrupts the buffered read even while bytes drip.
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

        watchdog = threading.Timer(REQUEST_BODY_TIMEOUT_SECONDS, abort_body)
        watchdog.daemon = True
        watchdog.start()
        try:
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(SPOOL_CHUNK_BYTES, remaining))
                if not chunk:
                    raise _Refused(
                        HTTPStatus.BAD_REQUEST,
                        f"body ended after {length - remaining} of {length} bytes",
                        retryable=True,
                    )
                spool.write(chunk)
                remaining -= len(chunk)
            spool.flush()
        finally:
            watchdog.cancel()
            # Do not let a timer racing with completion shut down a later
            # keep-alive request on this same socket.
            watchdog.join()

    def _validate(self):
        """Everything about the request that can be refused before a byte
        of body is read. Returns (demux_format, content_length)."""
        if self.path != POSTER_DECODER_PATH:
            raise _Refused(HTTPStatus.NOT_FOUND, f"no such path {self.path!r}")
        protocol = self.headers.get(POSTER_DECODER_PROTOCOL_HEADER)
        if protocol != POSTER_DECODER_PROTOCOL:
            # A worker and a decoder from different releases. Transient
            # until the two Deployments converge, so retryable.
            raise _Refused(
                HTTPStatus.CONFLICT,
                f"protocol {protocol!r} is not {POSTER_DECODER_PROTOCOL!r}; "
                "worker and decoder are from different releases",
                retryable=True,
            )
        demux_format = self.headers.get(POSTER_DECODER_FORMAT_HEADER, "")
        if demux_format not in set(_DEMUX_FORMATS.values()):
            raise _Refused(
                HTTPStatus.BAD_REQUEST,
                f"demux format {demux_format!r} is not allowlisted",
            )
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            raise _Refused(
                HTTPStatus.LENGTH_REQUIRED,
                "chunked request bodies are not accepted; send Content-Length",
            )
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            raise _Refused(HTTPStatus.LENGTH_REQUIRED, "Content-Length required")
        if length <= 0:
            raise _Refused(HTTPStatus.BAD_REQUEST, "empty body")
        if length > MAX_SOURCE_BYTES:
            raise _Refused(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                f"body declares {length} bytes, over MAX_SOURCE_BYTES "
                f"({MAX_SOURCE_BYTES})",
            )
        return demux_format, length

    # -- verbs ------------------------------------------------------------

    def do_GET(self):  # noqa: N802 - stdlib naming
        if self.path != HEALTH_PATH:
            self._refuse(HTTPStatus.NOT_FOUND, f"no such path {self.path!r}")
            return
        # `_slot` is a BoundedSemaphore(1): `_value` is 0 while a decode
        # holds it. Reported, not gated on -- a busy decoder is a healthy
        # decoder, and a readiness probe that failed under load would pull
        # the only endpoint out of the Service mid-request.
        self._answer(HTTPStatus.OK, {
            "ok": True, "protocol": POSTER_DECODER_PROTOCOL,
            "busy": _slot._value == 0,
        })

    def do_POST(self):  # noqa: N802 - stdlib naming
        try:
            demux_format, length = self._validate()
        except _Refused as refused:
            # Refused before reading the body: close the connection rather
            # than try to drain up to a gibibyte we said we would not take.
            self.close_connection = True
            self._refuse(refused.status, refused.reason, refused.retryable)
            return

        if not _slot.acquire(timeout=DECODER_BUSY_WAIT_SECONDS):
            self.close_connection = True
            self._refuse(
                HTTPStatus.SERVICE_UNAVAILABLE,
                f"decoder busy for {DECODER_BUSY_WAIT_SECONDS}s",
                retryable=True,
            )
            return
        try:
            with tempfile.NamedTemporaryFile(suffix=".bin") as spool:
                try:
                    self._spool_body(length, spool)
                except _Refused as refused:
                    self.close_connection = True
                    self._refuse(refused.status, refused.reason,
                                 refused.retryable)
                    return
                except OSError as exc:
                    # ENOSPC on the emptyDir, a reset socket. Node/transport
                    # pressure, not this video.
                    self.close_connection = True
                    self._refuse(
                        HTTPStatus.SERVICE_UNAVAILABLE,
                        f"could not spool body: {type(exc).__name__}: {exc}",
                        retryable=True,
                    )
                    return
                self._decode_and_answer(spool.name, demux_format)
        finally:
            _slot.release()

    def _decode_and_answer(self, source_path, demux_format):
        try:
            webp, width, height = _run_decoder_child(source_path, demux_format)
        except PosterUnavailable as exc:
            # The child's verdict on the MEDIA. Terminal: the same bytes will
            # be the same bytes on the next attempt.
            self._answer(HTTPStatus.OK, {
                "ok": False, "reason": str(exc), "retryable": False,
            })
            return
        except (OSError, PosterRetryable) as exc:
            # EMFILE, ENOSPC, a SIGKILL from the cgroup OOM killer: this pod
            # under pressure, which says nothing about the file.
            self._answer(HTTPStatus.OK, {
                "ok": False, "retryable": True,
                "reason": f"{type(exc).__name__}: {exc}",
            })
            return
        except Exception as exc:  # noqa: BLE001 - attacker-supplied media
            # Same backstop as `extract_poster_bytes`'s broad handler, and
            # the same verdict: an unreadable answer from a child that died
            # strangely is this file breaking this decoder.
            logger.warning(
                "decode failed unexpectedly: %s: %s", type(exc).__name__, exc,
            )
            self._answer(HTTPStatus.OK, {
                "ok": False, "retryable": False,
                "reason": f"{type(exc).__name__}: {str(exc)[:200]}",
            })
            return
        self._answer(HTTPStatus.OK, {
            "ok": True,
            "protocol": POSTER_DECODER_PROTOCOL,
            "width": width,
            "height": height,
            "bytes": len(webp),
            "webp_base64": base64.b64encode(webp).decode("ascii"),
        })


class DecoderServer(ThreadingHTTPServer):
    # A handler thread that is mid-decode when the process is told to stop
    # is joined by `shutdown()`, not abandoned: the pod's
    # terminationGracePeriodSeconds is sized so that join can finish.
    daemon_threads = False
    allow_reuse_address = True


def make_server(host, port):
    return DecoderServer((host, port), DecoderHandler)


def serve(host, port):
    """Run until SIGTERM/SIGINT, then finish the in-flight request and exit.

    Binds `host` -- `0.0.0.0` in the manifest, deliberately: a Kubernetes
    httpGet probe arrives on the POD IP, so a server bound to 127.0.0.1
    fails every probe and crashloops (that already happened once to daphne).
    """
    server = make_server(host, port)
    stopping = threading.Event()

    def _stop(signum, _frame):
        if stopping.is_set():
            return
        stopping.set()
        logger.info("signal %s: draining", signal.Signals(signum).name)
        # `shutdown()` blocks until `serve_forever` returns, and must not be
        # called from the thread running it.
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    logger.info(
        "video-decoder listening on %s:%s (protocol %s, one decode at a "
        "time, wall clock %ss)",
        host, port, POSTER_DECODER_PROTOCOL, POSTER_SUBPROCESS_TIMEOUT_SECONDS,
    )
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
    logger.info("video-decoder stopped")


#Cloud Logging ``jsonPayload.event`` for this service's log lines.
LOG_EVENT = "video_decoder_log"


def configure_logging(stream=None):
    """One JSON line per record, with the record's own ``severity``.

    This used to be ``basicConfig`` plain text on stderr, which GKE grades
    ERROR whatever the Python level -- every ``INFO... "GET /healthz" 200``
    line was an ERROR. The service imports nothing from Django, and
    log_json is safe to import without it (test_the_service_starts_without_
    django pins that).
    """
    handler = logging.StreamHandler(stream if stream is not None else sys.stderr)
    handler.setFormatter(RawLoggerJSONFormatter(event=LOG_EVENT))
    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    return handler


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="The isolated poster-frame decoder (#1575).",
    )
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args(argv)
    configure_logging()
    serve(args.host, args.port)
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised as a process
    sys.exit(main())
