"""
The isolated video decoder: the pod, the service, and the seam.

 bounded the demuxer's memory, CPU and disk with rlimits on a child
process. It did not bound WHERE that child ran: in the procrastinate
worker's pod, beside `DBPASS`, the projected service-account token and the
GKE metadata server. This file pins the three halves of moving it out:

1. the SERVICE (`video_decoder_service`) really decodes, over HTTP, with the
   same child and the same verdicts, and refuses what the worker would
   never send;
2. the WORKER uses it when told to, REFUSES to demux in-pod when inside
   Kubernetes without it, and treats a missing decoder as retryable rather
   than as "this video has no poster";
3. the MANIFESTS give that pod nothing to be exploited into using -- its
   own unbound ServiceAccount, no token, no Secret, no ConfigMap, no egress
   -- and are wired into the release so the isolation is applied, not
   merely described.

The service is started IN-PROCESS on a loopback port for (1) and (2): the
worker side of the test process talks to a thread of the same process over
a real socket, and the service thread spawns the real rlimited child. It is
the same code path production runs, minus the network hop being between
two pods.
"""
import http.client
import json
import os
import pathlib
import re
import subprocess
import sys
import threading
from io import BytesIO

import av
import pytest
import yaml
from PIL import Image

from django.core.files.base import ContentFile

from dj.apps.uploads import video_decoder_service, video_utils
from dj.apps.uploads.models import GenericFile, ImageVariant
from dj.apps.uploads.tasks import generate_video_poster

REPO_ROOT = pathlib.Path(__file__).resolve().parents[5]


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
        },
    }
    settings.MEDIA_ROOT = str(tmp_path)


@pytest.fixture(autouse=True)
def _not_in_a_pod(monkeypatch):
    """Each test decides for itself whether it is 'in Kubernetes'."""
    monkeypatch.delenv("KUBERNETES_SERVICE_HOST", raising=False)
    monkeypatch.delenv(video_utils.POSTER_DECODER_URL_ENV, raising=False)


def _mp4_bytes(width=320, height=240, seconds=3, fps=10, colour_step=8):
    """A real, decodable H.264/MP4 clip whose frames change over time."""
    buffer = BytesIO()
    container = av.open(buffer, mode="w", format="mp4")
    stream = container.add_stream("libx264", rate=fps)
    stream.width = width
    stream.height = height
    stream.pix_fmt = "yuv420p"
    for index in range(seconds * fps):
        value = (index * colour_step) % 256
        image = Image.new("RGB", (width, height), (value, value, value))
        frame = av.VideoFrame.from_image(image)
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode():
        container.mux(packet)
    container.close()
    return buffer.getvalue()


@pytest.fixture
def decoder():
    """The real service, on a loopback port, in a thread. Yields its URL."""
    server = video_decoder_service.make_server("127.0.0.1", 0)
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.1},
        daemon=True,
    )
    thread.start()
    host, port = server.server_address[:2]
    try:
        yield f"http://{host}:{port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=10)


def _post(url, body, headers):
    parts = url.split("://", 1)[1]
    host, port = parts.split(":")
    connection = http.client.HTTPConnection(host, int(port), timeout=60)
    try:
        connection.request(
            "POST", video_utils.POSTER_DECODER_PATH, body=body, headers=headers,
        )
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


def _headers(body, demux_format="mp4", protocol=None):
    return {
        "Content-Type": "application/octet-stream",
        "Content-Length": str(len(body)),
        video_utils.POSTER_DECODER_FORMAT_HEADER: demux_format,
        video_utils.POSTER_DECODER_PROTOCOL_HEADER: (
            video_utils.POSTER_DECODER_PROTOCOL if protocol is None
            else protocol
        ),
    }


# ---------------------------------------------------------------------------
# 1. The service
# ---------------------------------------------------------------------------

def test_the_service_returns_a_real_poster_over_http(decoder, tmp_path):
    """The whole exchange, through the worker's own client."""
    source = tmp_path / "clip.mp4"
    source.write_bytes(_mp4_bytes())

    webp, width, height = video_utils._decode_poster_remote(
        str(source), "mp4", decoder,
    )

    assert (width, height) == (320, 240)
    with Image.open(BytesIO(webp)) as image:
        assert image.format == "WEBP"
        assert image.size == (320, 240)
        # Frames brighten over time; a poster from ~2 s in is not black.
        assert image.convert("L").getpixel((10, 10)) > 40


def test_the_service_refuses_what_the_worker_would_never_send(decoder):
    """Every refusal is decided before a body byte is read, and each one
    says on the wire whether it is worth retrying."""
    body = b"x" * 64

    status, answer = _post(decoder, body, _headers(body, demux_format="avi"))
    assert status == 400 and answer["ok"] is False
    assert answer["retryable"] is False
    assert "avi" in answer["reason"]

    status, answer = _post(decoder, body, _headers(body, protocol="0"))
    assert status == 409 and answer["ok"] is False
    # A worker and a decoder from different releases converge; retry.
    assert answer["retryable"] is True

    headers = _headers(body)
    headers["Content-Length"] = str(video_utils.MAX_SOURCE_BYTES + 1)
    status, answer = _post(decoder, body, headers)
    assert status == 413 and answer["ok"] is False
    assert answer["retryable"] is False

    headers = _headers(body)
    del headers["Content-Length"]
    # Send chunked headers without body bytes: refusal is required before
    # reading any body. Sending chunks concurrently with the refusal races
    # the server's deliberate connection close and can raise BrokenPipe.
    host, port = decoder.split("://", 1)[1].split(":")
    chunked = http.client.HTTPConnection(host, int(port), timeout=10)
    try:
        chunked.putrequest("POST", video_utils.POSTER_DECODER_PATH)
        for name, value in headers.items():
            chunked.putheader(name, value)
        chunked.putheader("Transfer-Encoding", "chunked")
        chunked.endheaders()
        response = chunked.getresponse()
        answer = json.loads(response.read())
        assert response.status == 411 and answer["ok"] is False
    finally:
        chunked.close()

    parts = decoder.split("://", 1)[1]
    host, port = parts.split(":")
    connection = http.client.HTTPConnection(host, int(port), timeout=10)
    connection.request("GET", "/healthz")
    response = connection.getresponse()
    health = json.loads(response.read())
    connection.close()
    assert response.status == 200
    assert health == {
        "ok": True, "protocol": video_utils.POSTER_DECODER_PROTOCOL,
        "busy": False,
    }


def test_undecodable_is_terminal_and_busy_is_retryable(decoder, monkeypatch):
    """The two verdicts the worker believes, and the difference between them:
    the same bytes will be the same bytes next time; a held slot will not."""
    garbage = b"definitely not an mp4" * 100
    status, answer = _post(decoder, garbage, _headers(garbage))
    assert status == 200
    assert answer["ok"] is False
    assert answer["retryable"] is False

    monkeypatch.setattr(video_decoder_service, "DECODER_BUSY_WAIT_SECONDS", 0.2)
    assert video_decoder_service._slot.acquire(timeout=1)
    try:
        status, answer = _post(decoder, garbage, _headers(garbage))
    finally:
        video_decoder_service._slot.release()
    assert status == 503
    assert answer["ok"] is False
    assert answer["retryable"] is True
    assert "busy" in answer["reason"]


def test_the_service_starts_without_django():
    """Its pod has no ConfigMap and no Secret. A `django.conf` import here
    would make the service need one, and the manifest test below would then
    be certifying a pod that cannot start."""
    package_root = str(REPO_ROOT / "py" / "free2z")
    probe = (
        "import sys\n"
        "import dj.apps.uploads.video_decoder_service\n"
        "loaded = sorted(m for m in sys.modules if m.split('.')[0] in "
        "('django', 'psycopg', 'psycopg2', 'google'))\n"
        "print('LOADED', loaded)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe],
        capture_output=True, timeout=60,
        env={**os.environ, "PYTHONPATH": package_root,
             "DJANGO_SETTINGS_MODULE": ""},
    )
    assert result.returncode == 0, result.stderr.decode()
    assert b"LOADED []" in result.stdout, result.stdout.decode()


# ---------------------------------------------------------------------------
# 2. The worker
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_the_worker_demuxes_in_the_decoder_and_not_in_its_own_process(
    creator_factory, decoder, monkeypatch,
):
    """With VIDEO_DECODER_URL set, the worker's own child path is never
    spawned -- the poster comes back from the service, which holds its own
    reference to the child runner and is unaffected by this patch."""
    monkeypatch.setenv(video_utils.POSTER_DECODER_URL_ENV, decoder)

    def _never(*args, **kwargs):
        raise AssertionError("the worker demuxed in its own process")

    monkeypatch.setattr(video_utils, "_run_decoder_child", _never)

    video = GenericFile.objects.create(
        owner=creator_factory(),
        file=ContentFile(_mp4_bytes(), name="clip.mp4"),
        mime_type="video/mp4",
    )
    generate_video_poster(generic_file_id=video.pk)

    variant = ImageVariant.objects.get(parent=video)
    assert (variant.width, variant.format) == (320, "webp")
    with variant.file.open("rb") as handle, Image.open(handle) as image:
        assert image.format == "WEBP"
        assert image.size == (320, 240)


@pytest.mark.django_db
def test_a_pod_without_a_decoder_refuses_to_demux_in_place(
    creator_factory, monkeypatch,
):
    """FAIL CLOSED. A worker pod that has lost its ConfigMap entry must not
    quietly go back to running FFmpeg beside DBPASS and the metadata server.
    The refusal is RETRYABLE so it surfaces as failed jobs, not as videos
    that silently have no poster."""
    monkeypatch.setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")

    def _never(*args, **kwargs):
        raise AssertionError("spawned a demuxer inside the worker pod")

    monkeypatch.setattr(video_utils.subprocess, "Popen", _never)

    video = GenericFile.objects.create(
        owner=creator_factory(),
        file=ContentFile(_mp4_bytes(seconds=1), name="clip.mp4"),
        mime_type="video/mp4",
    )
    with pytest.raises(video_utils.PosterRetryable) as excinfo:
        video_utils.extract_poster_bytes(video)
    assert video_utils.POSTER_DECODER_URL_ENV in str(excinfo.value)


@pytest.mark.django_db
def test_an_unreachable_decoder_retries_instead_of_recording_no_poster(
    creator_factory, monkeypatch,
):
    """A decoder that is down says nothing about this video. Swallowing it
    would mark the job DONE and leave the upload permanently posterless."""
    # A port nothing listens on: bind one, learn its number, close it.
    import socket
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    monkeypatch.setenv(
        video_utils.POSTER_DECODER_URL_ENV, f"http://127.0.0.1:{port}",
    )

    video = GenericFile.objects.create(
        owner=creator_factory(),
        file=ContentFile(_mp4_bytes(seconds=1), name="clip.mp4"),
        mime_type="video/mp4",
    )
    with pytest.raises(video_utils.PosterRetryable):
        video_utils.extract_poster_bytes(video)


def test_a_decoder_answer_is_read_with_a_cap(decoder, monkeypatch, tmp_path):
    """The reader bounds what enters the worker, same as the child's stdout."""
    source = tmp_path / "clip.mp4"
    source.write_bytes(_mp4_bytes(seconds=1))
    monkeypatch.setattr(video_utils, "POSTER_DECODER_MAX_RESPONSE_BYTES", 64)

    with pytest.raises(video_utils.PosterRetryable) as excinfo:
        video_utils._decode_poster_remote(str(source), "mp4", decoder)
    assert "more than 64 bytes" in str(excinfo.value)


@pytest.mark.parametrize("change", [
    {"protocol": "0"}, {"protocol": None}, {"width": 0},
    {"height": -1}, {"width": video_utils.POSTER_MAX_WIDTH + 1},
])
def test_worker_refuses_invalid_success_envelope(decoder, monkeypatch, tmp_path, change):
    """A valid transport must not bypass the negotiated reply contract."""
    import base64

    answer = {
        "ok": True, "protocol": video_utils.POSTER_DECODER_PROTOCOL,
        "width": 320, "height": 240,
        "webp_base64": base64.b64encode(b"poster").decode("ascii"),
        **change,
    }
    monkeypatch.setattr(
        video_decoder_service.DecoderHandler, "_decode_and_answer",
        lambda self, *_args: self._answer(200, answer),
    )
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    with pytest.raises(video_utils.PosterRetryable):
        video_utils._decode_poster_remote(str(source), "mp4", decoder)


# ---------------------------------------------------------------------------
# 3. The manifests
# ---------------------------------------------------------------------------

def _render(path):
    """The same literal substitution bazel and render_k8s.sh perform."""
    text = path.read_text()
    text = re.sub(r"%\{[A-Z_]+\}", "1", text)
    return yaml.safe_load(text)
















@pytest.mark.parametrize("connection_header", ["keep-alive", "close"])
def test_a_dripping_decoder_cannot_hold_the_worker_past_the_deadline(
    monkeypatch, tmp_path, connection_header,
):
    """A socket timeout bounds the gap between two bytes. A compromised
    decoder that sends headers and then one byte every few seconds would
    hold the catch-all worker in `read()` for as long as it liked (codex
    adversarial review). The exchange deadline is wall clock, and it ends
    the connection from a watchdog thread whatever the worker is blocked
    in.

    Both connection headers, because `Connection: close` makes http.client
    drop `connection.sock` before the body is read -- a watchdog that went
    looking for the socket there would find None and interrupt nothing
    (codex adversarial review, round 2)."""
    import socket
    import time

    source = tmp_path / "clip.mp4"
    source.write_bytes(b"x" * 1024)
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    stop = threading.Event()

    def _drip():
        client, _ = listener.accept()
        client.settimeout(5)
        try:
            request = b""
            while b"\r\n\r\n" not in request:
                request += client.recv(4096)
            head, body = request.split(b"\r\n\r\n", 1)
            length = int(re.search(
                rb"(?im)^content-length:\s*(\d+)", head,
            ).group(1))
            while len(body) < length:
                body += client.recv(4096)
            client.sendall(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                b"Connection: " + connection_header.encode() + b"\r\n"
                b"Content-Length: 1000000\r\n\r\n"
            )
            while not stop.is_set():
                client.sendall(b"{")
                time.sleep(0.05)
        except OSError:
            pass
        finally:
            client.close()

    thread = threading.Thread(target=_drip, daemon=True)
    thread.start()
    monkeypatch.setattr(video_utils, "POSTER_DECODER_TIMEOUT_SECONDS", 1.5)
    # The socket timeout alone would never fire: a byte arrives every 50 ms.
    monkeypatch.setattr(video_utils, "POSTER_DECODER_SOCKET_TIMEOUT_SECONDS", 60)

    started = time.monotonic()
    try:
        with pytest.raises(video_utils.PosterRetryable) as excinfo:
            video_utils._decode_poster_remote(
                str(source), "mp4", f"http://127.0.0.1:{port}",
            )
    finally:
        stop.set()
        listener.close()
    elapsed = time.monotonic() - started
    assert elapsed < 10, f"took {elapsed:.1f}s; the deadline did not fire"
    assert "did not finish within" in str(excinfo.value), str(excinfo.value)


def test_dripping_upload_releases_decoder_slot(decoder, monkeypatch):
    """The real server must interrupt a body even when bytes keep arriving."""
    import socket
    import time

    monkeypatch.setattr(video_decoder_service, "REQUEST_BODY_TIMEOUT_SECONDS", 0.3,
                        raising=False)
    host, port = decoder.split("://", 1)[1].split(":")
    client = socket.create_connection((host, int(port)), timeout=2)
    client.sendall((
        "POST /v1/poster HTTP/1.1\r\nHost: decoder\r\n"
        "Content-Length: 1000000\r\nX-Demux-Format: mp4\r\n"
        "X-Poster-Protocol: 1\r\n\r\n"
    ).encode())
    stopped = threading.Event()

    def drip():
        try:
            while not stopped.wait(0.02):
                client.sendall(b"x")
        except OSError:
            pass

    thread = threading.Thread(target=drip)
    thread.start()
    try:
        started = time.monotonic()
        # EOF/reset, not a per-read timeout: the peer closes the socket.
        try:
            assert client.recv(1) == b""
        except ConnectionResetError:
            pass
        assert time.monotonic() - started < 1.5
        deadline = time.monotonic() + 1
        while video_decoder_service._slot._value == 0 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert video_decoder_service._slot._value == 1
        monkeypatch.setattr(
            video_decoder_service, "_run_decoder_child",
            lambda *_args: (b"poster", 1, 1),
        )
        status, answer = _post(decoder, b"source", _headers(b"source"))
        assert status == 200 and answer["ok"] is True
    finally:
        stopped.set()
        client.close()
        thread.join(timeout=2)
