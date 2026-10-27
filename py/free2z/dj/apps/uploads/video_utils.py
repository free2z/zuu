"""
Poster-frame extraction for video uploads.

Google Search Console reports every zPage video as *"No thumbnail URL
provided"*, and `thumbnailUrl` is a REQUIRED property of `VideoObject`.
Nothing in this repository has ever produced a still from a video, so the
structured data cannot be emitted honestly until a real frame exists.

Why PyAV rather than an `ffmpeg` binary
---------------------------------------
`docker/py3base/Dockerfile` is `python:3.12-bookworm` (was `3.10-bullseye`
until ) plus `pip install -r requirements/main.txt` and installs **no** apt
packages.
The `av` manylinux wheel bundles its own FFmpeg shared libraries, so adding
`av==13.1.0` to `requirements/main.txt` is a pure Python-dependency change
that needs no Dockerfile edit and no new system package. Verified against
the exact pinned base-image digest — see the PR body for the transcript.

`docker/nginx/Dockerfile` builds nginx-vod-module WITHOUT libavcodec /
libswscale, so nginx-vod's `vod thumb` mode is not available; enabling it
would mean rebuilding the image that carries 100% of production traffic.
That option was ruled out deliberately.

Safety posture
--------------
Uploaded video is attacker-supplied input handed to a media demuxer, and the
demuxer is the part that cannot be reasoned with.

**`av.open()` is unbounded, and no in-process check can bound it.** An MP4
whose sample tables (``stts``/``stsz``/``stsc``) declare a huge sample count
makes FFmpeg build a sample index proportional to the DECLARED count, not to
the bytes on disk. Measured against the then-deployed base image
(``python:3.10-bullseye`` at its pinned digest) with ``av==16.0.1``:

    642-byte file declaring 60,000,000 samples  ->  2,240 MB, 0.9 s

and it *opens successfully*, so every allowlist and ceiling below runs far too
late to matter. The file passes ``MAX_SOURCE_BYTES`` (it is 642 bytes), passes
the declared-size pre-check, and really is a structurally valid MP4, so
pinning the demuxer with ``format=`` does not exclude it either. This is a
memory-and-parse vector, not a decode vector: no CPU, no decoding, sub-second.

**So the bound is a process boundary, not a check.** Demux and decode run in a
short-lived child process under three limits the child cannot exceed:

  * ``RLIMIT_AS`` (``POSTER_SUBPROCESS_ADDRESS_SPACE_BYTES``) — kernel
    enforced. The same 642-byte file peaks at 136 MB and fails to open,
    instead of 2,240 MB.
  * ``RLIMIT_CPU`` (``POSTER_SUBPROCESS_CPU_SECONDS``) — kernel enforced,
    ``SIGXCPU``. This is what actually closes the "pathological file pins the
    worker" hole: nothing in-process could interrupt a native FFmpeg call,
    because the procrastinate worker runs sync tasks off the main thread and
    ``signal.alarm`` is therefore unavailable.
  * a wall-clock kill by the parent
    (``POSTER_SUBPROCESS_TIMEOUT_SECONDS``), which also covers a child
    blocked in a syscall rather than burning CPU.

The ceilings *inside* the child (``MAX_DECODE_PIXELS``, the codec and
container allowlists, ``MAX_DECODED_PACKETS``) are still worth having — they
refuse work early and cheaply, and they keep the reachable decoder surface
small — but they are advisory in the sense that matters: if one of them were
wrong, the address-space ceiling still holds. Note in particular that the
in-band frame-geometry check happens **after** FFmpeg has allocated the frame;
it prevents the second, RGB copy, not the first allocation. That check is
meaningful only because it runs under the address-space ceiling.

The remaining hard costs are the ones the parent owns: the source copy
(``MAX_SOURCE_BYTES``, refused on the declared size first so an oversized
file is never fetched) and the child's own resident memory, which counts
against the same worker cgroup the parent lives in — which is why
``MAX_DECODE_PIXELS`` is set from a *measurement* of the worst legitimate
decode rather than from what a decoder will tolerate.

**And the process boundary is a pod boundary in production.** The
rlimits bound resources, not code execution. A decoder bug reachable from an
upload used to yield code running beside the worker's `DBPASS`, its projected
service-account token and the GKE metadata server. Now the worker only ever
streams the source to the ``video-decoder`` Deployment
(k8s/free2z/video-decoder/): its own powerless ServiceAccount, no token, no
Secret, no ConfigMap, and a deny-egress policy that the documented cluster
currently does NOT enforce. Unauthenticated services remain reachable, so
this is credential separation, not complete containment.
``video_decoder_service`` in that pod spawns
this module's child; the WebP comes back over the same HTTP request. Inside a
Kubernetes pod without ``VIDEO_DECODER_URL`` the worker REFUSES to demux
rather than falling back to doing it in-pod.

Everything fails **closed**: any failure yields ``None`` and the upload
simply keeps having no poster. A malformed video must never crash the
worker or poison the retry queue.
"""
import base64
import http.client
import json
import logging
import os
import resource
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from io import BytesIO

logger = logging.getLogger(__name__)

# WebP encoder settings for the poster still. Higher than the legacy
# avatar thumbnail (quality=50) because this frame is displayed at article
# width and is the image Google indexes as the video's thumbnail.
POSTER_QUALITY = 72

# Longest edge of the stored poster. 800 px matches the `banner`-1 rung of
# VARIANT_WIDTHS and is comfortably above Google's 60x30 minimum for video
# thumbnails while staying a few tens of kilobytes.
POSTER_MAX_WIDTH = 800

# Frame geometry ceiling, in pixels. MEASURED, not chosen for roundness.
#
# The cost that matters is not one frame: an H.264 stream may declare up to 16
# reference frames, and the decoder holds all of them plus the RGB conversion
# copy. Profiled on the deployed base image with `av==16.0.1`, decoding a
# `refs=16` clip through this module's exact path (peak virtual size, which is
# what RLIMIT_AS bounds):
#
#     1920x1080 (2.1 MP)   233 MB
#     3840x2160 (8.3 MP)   521 MB
#     4096x2160 (8.8 MP)   547 MB   <- 4K DCI, the largest we accept
#     5328x3000 (16.0 MP)  877 MB   <- the OLD ceiling: over budget on its own
#
# 16 MP was set from what a decoder tolerates rather than from what this
# worker has. It does not fit: 877 MB is more than the demux child's ENTIRE
# address-space cap (`POSTER_SUBPROCESS_ADDRESS_SPACE_BYTES`, 768 MiB =
# 805 MB), so the child dies on its own rlimit -- and it was over the whole
# container limit back when that limit was 1 GiB, in a pod also running
# Django, procrastinate and every other queue. Raising the container limit
#  does NOT re-open 16 MP: the child's cap is the binding
# constraint and it did not move. 8.9 MP admits 4K DCI (8,847,360 px) and
# everything below it, and refuses 5K/8K -- which then fails CLOSED, leaving
# those uploads without a poster instead of taking the worker down with them.
MAX_DECODE_PIXELS = 8_900_000

# Largest source we are willing to stage on the worker's /tmp emptyDir.
# The whole file has to be copied because MP4 indexes are not necessarily
# at the front.
#
# IT IS ALSO A MEMORY BOUND, not just a disk one . In
# production `STORAGES["default"]` is django-storages' `GoogleCloudStorage`,
# and `GoogleCloudFile` downloads the entire blob into a
# `SpooledTemporaryFile(max_size=GS_MAX_MEMORY_SIZE)` as soon as the file is
# opened. `GS_MAX_MEMORY_SIZE` defaults to 0 and `SpooledTemporaryFile` treats
# 0 as "never roll over" (`if max_size and file.tell() > max_size`), so the
# spool stays a `BytesIO`: `_copy_source_to_temp`'s 1 MiB read loop bounds the
# WRITE to /tmp and nothing else, and the worker holds up to this many bytes
# resident before the demux child is even forked. That makes this the LARGER
# of the poster job's two memory phases today (1024Mi vs the child's 768Mi
# cap), and py/dj/apps/jobs/test_queue_isolation.py budgets the worker's
# container limit against the max of the two. Raising it means going to
# k8s/free2z/worker/BUILD.bazel -- or, cheaper, setting `GS_MAX_MEMORY_SIZE`
# so the download spools to the same /tmp this function is copying to anyway.
MAX_SOURCE_BYTES = 1_073_741_824  # 1 GiB

# Where in the timeline to look for a representative still. Frame 0 of a
# video is very often a black or a fade-in frame; a couple of seconds in is
# the conventional compromise. Clamped to a fraction of the duration so a
# 1.5 s clip does not seek past its own end.
POSTER_SEEK_SECONDS = 2.0
POSTER_SEEK_MAX_FRACTION = 0.25

# Bounds INSIDE the child. Both are cheap early exits, not the safety net --
# the safety net is the child's rlimits and the parent's wall clock. In
# particular `DECODE_DEADLINE_SECONDS` is checked only between yielded frames,
# so one native FFmpeg call can overrun it by any amount; that is exactly why
# it is no longer the outermost bound on anything.
MAX_DECODED_PACKETS = 240
DECODE_DEADLINE_SECONDS = 60.0

# --- the actual bounds: the child process ---------------------------------
#
# RLIMIT_AS. 768 MiB is 1.4x the 547 MB worst legitimate decode measured
# above, so a legitimate 4K clip has room while the sample-table bomb in the
# module docstring is refused at 136 MB in 0.03 s instead of reaching
# 2,240 MB. Both directions were measured on the deployed base image; see the
# PR body for the transcript.
#
# THIS NUMBER IS ONE END OF AN INVARIANT ACROSS THE MANIFESTS
# . The child's pages are charged to the WORKER's cgroup --
# there is no second budget -- so the container limit of the worker that runs
# `uploads.generate_video_poster` must satisfy
#
#     %{LIMIT_MEMORY}  >=  (max(this cap, MAX_SOURCE_BYTES)
#                           * %{CONCURRENCY}  +  ~250Mi)  *  1.25
#
# in k8s/free2z/worker/BUILD.bazel, where ~250Mi is the worker's own measured
# steady state. `MAX_SOURCE_BYTES` is in there because staging the source is
# the OTHER memory phase of the same job and today it is the bigger one: the
# GCS backend spools the whole blob in memory (see the note on
# `MAX_SOURCE_BYTES` above), so raising THIS cap above 1 GiB is what makes
# this half of the max() start to bind.
#
# It is deliberately NOT written here as "a fraction of the
# worker's limit": it used to say "3/4 of the worker's 1 GiB", the limit moved
# and this comment did not, and a cap derived from a limit that no longer
# exists is how the application security contract happened -- 768 + 250 = 1018Mi against a 1Gi
# cgroup, four poster jobs stranded in `doing` by a child that never exceeded
# its own ceiling.
#
# So the causality runs one way: this cap comes from the measurements above,
# and the worker's limit is derived FROM it. Raising it means going to
# k8s/free2z/worker/BUILD.bazel; `test_the_poster_worker_can_hold_the_job
# _it_runs` in py/dj/apps/jobs/test_queue_isolation.py evaluates the
# formula against this constant and fails the `backend` job if you don't.
# Note the ceiling that implies: past ~1388Mi (at concurrency 1) the required
# limit exceeds the 2048Mi per-worker ceiling that same module enforces, and
# NO value satisfies both. That is not a number to tune -- it is the point at
# which the demux stops belonging in the catch-all worker at all
# .
#
# It is set by the CHILD on itself, immediately before `import av`, rather
# than through `preexec_fn`: the procrastinate worker is threaded, and
# `subprocess`'s own documentation warns that `preexec_fn` is unsafe in the
# presence of threads. The child is our code and runs the limit first, so
# nothing attacker-controlled is loaded before the ceiling exists.
POSTER_SUBPROCESS_ADDRESS_SPACE_BYTES = 805_306_368  # 768 MiB

# RLIMIT_CPU, in seconds. Kernel-enforced SIGXCPU, so it lands mid-call inside
# FFmpeg where nothing in Python could have interrupted it. Comfortably above
# the ~0.5 s a real 4K poster takes.
POSTER_SUBPROCESS_CPU_SECONDS = 45

# How far above the soft CPU limit the HARD one sits. See _apply_child_limits:
# the soft limit raises SIGXCPU (a nameable cause), the hard limit raises
# SIGKILL (an unignorable one).
POSTER_SUBPROCESS_CPU_GRACE_SECONDS = 5

# Wall clock, enforced by the PARENT. Covers what RLIMIT_CPU cannot: a child
# blocked in a syscall rather than burning CPU. Above the CPU limit on purpose
# -- if both are live, the CPU limit should be the one that fires, because it
# names the real cause.
POSTER_SUBPROCESS_TIMEOUT_SECONDS = 75

# The child answers with ONE JSON line. Bounded so a child that goes berserk
# on stdout cannot make the parent buffer without limit.
POSTER_SUBPROCESS_MAX_STDOUT = 4096

# RLIMIT_FSIZE, in bytes. Any single file the child writes is capped here by
# the kernel: its poster, and its stdout/stderr scratch files.
#
# THIS EXISTS BECAUSE THE PREVIOUS FIX MOVED THE PROBLEM (codex adversarial
# review, two rounds). Piping the child's output made the PARENT buffer it
# without limit; redirecting to files fixed that and created a new hole --
# `/tmp` is an unbounded disk-backed emptyDir, so a decoder induced to emit
# diagnostics for the full 75-second window could fill node storage and put
# the node into DiskPressure, evicting pods that have nothing to do with
# posters. A cap applied by the reader is not a cap on the writer.
#
# 8 MiB: a POSTER_MAX_WIDTH-bounded WebP is tens of kilobytes, so this is
# ~100x the real output and still nowhere near a disk. Exceeding it raises
# SIGXFSZ, which is fatal by default and reported by `_describe_exit`.
POSTER_SUBPROCESS_MAX_FILE_BYTES = 8 * 1024 * 1024

# --- the decoder pod  ---------------------------------------------
#
# The rlimits above contain memory, CPU and disk. They do not contain code
# execution: a memory-safety bug in an allowlisted decoder turns an
# authenticated upload into code running in the WORKER's pod -- which shares
# the pod's network namespace (the GKE metadata server), its projected
# service-account token and its filesystem, and whose parent process holds
# `DBPASS` and every other secret in `os.environ` (readable through
# `/proc/<ppid>/environ` by any process of the same uid, which the child is).
#
# So in production the demux does not happen in the worker at all. The
# worker streams the source to `video-decoder`, a separate Deployment
# (k8s/free2z/video-decoder/) whose pod has its OWN ServiceAccount with no
# Workload Identity binding, `automountServiceAccountToken: false`, no
# `envFrom` (no Secret, no ConfigMap), and a NetworkPolicy allowing nothing
# out. That pod runs `dj.apps.uploads.video_decoder_service`, which spawns
# exactly the same rlimited child this module always did, and answers with
# the WebP. The bytes cross a plain HTTP request in both directions; nothing
# in the decoder pod can reach the bucket, the database, or the metadata
# server WHEN that NetworkPolicy is enforced. The current cluster does not
# enforce it: credentials are removed, but unauthenticated in-cluster
# services remain reachable. This is not a complete containment boundary.
#
# `VIDEO_DECODER_URL` selects it. It is an ENVIRONMENT variable rather than a
# Django setting because this module is imported by the child and by the
# service, neither of which has Django. Set by k8s/free2z/config.yaml.
POSTER_DECODER_URL_ENV = "VIDEO_DECODER_URL"

# The request the worker sends and the service accepts. Bumped when the
# request or the answer changes shape, so a worker and a decoder from
# different releases refuse each other by name instead of misreading each
# other -- the two Deployments roll independently, and a rollback restores
# only the ones prod-healthcheck owns.
POSTER_DECODER_PROTOCOL = "1"
POSTER_DECODER_PATH = "/v1/poster"
POSTER_DECODER_FORMAT_HEADER = "X-Demux-Format"
POSTER_DECODER_PROTOCOL_HEADER = "X-Poster-Protocol"

# A DEADLINE on the whole exchange, in seconds of wall clock, enforced by a
# watchdog that closes the socket when it passes -- NOT a socket timeout. A
# socket timeout bounds the gap between two bytes; a decoder that has been
# compromised can send headers and then drip one byte every few seconds for
# as long as it likes, and each byte resets a socket timeout (codex
# adversarial review). The catch-all worker would sit in `read()` for the
# duration, with notifications, translation, search and cleanup behind it.
# The deadline is armed after connect, before the first byte is sent, and
# covers the send, the wait for headers and the read of the answer together.
# DNS resolution is outside this deadline; connect uses the socket timeout.
# This is not a total task deadline (source/storage I/O is also separate).
#
# It has to exceed the service's honest worst case -- streaming a
# MAX_SOURCE_BYTES body in, waiting `DECODER_BUSY_WAIT_SECONDS` for the
# single decode slot, the child's 75 s wall clock and the kill/reap grace --
# or a slow legitimate decode is reported as the decoder being unreachable,
# which retries and burns the queue.
POSTER_DECODER_TIMEOUT_SECONDS = 180

# Per-operation socket timeout, inside the deadline: the longest the worker
# will wait for ONE byte. The legitimate silent stretch is the busy wait
# plus a full decode plus reap (30 + 75 + 10 s), so this sits above that.
POSTER_DECODER_SOCKET_TIMEOUT_SECONDS = 130

# The service answers with one JSON document carrying the WebP in base64. A
# POSTER_MAX_WIDTH-bounded WebP is tens of kilobytes and the child's
# RLIMIT_FSIZE caps it at 8 MiB, so 16 MiB is ~1.5x the largest possible
# honest answer. Read with a cap for the same reason the child's stdout is:
# the reader bounds what enters the worker.
POSTER_DECODER_MAX_RESPONSE_BYTES = 16 * 1024 * 1024

# Container formats we are willing to demux, as `av` names them.
# `validation.ALLOWED_TYPE_EXTENSIONS` admits only mp4/webm/mov and
# `mime_type` is sniffed from the bytes server-side, so anything else that
# FFmpeg's probe decides a file "is" got there by disagreeing with our own
# sniffer -- which is exactly the case not to hand to a demuxer.
# Both spellings on purpose: `av` reports the NAME IT WAS GIVEN when the
# demuxer is pinned with `format=` ("mp4"/"mov"/"webm"), and the demuxer's own
# full name when it probed ("mov,mp4,m4a,3gp,3g2,mj2"). Listing only one set
# would make this check fire on every file or on none.
ALLOWED_CONTAINER_FORMATS = frozenset({
    "mp4", "mov", "webm",
    "mov,mp4,m4a,3gp,3g2,mj2",
    "matroska,webm", "matroska",
})

# Video codecs we are willing to decode a frame from.
#
# FFmpeg ships ~200 video decoders. Uploading a file is an authenticated but
# otherwise open action, and without this allowlist an attacker chooses which
# of those 200 decoders runs, in-process, in the catch-all worker that carries
# the `free2z` secret and database credentials -- a bug in any one of them is
# reachable by uploading a `.mov`. (The 2026 MagicYUV out-of-bounds write is
# the shape of the thing: a decoder nothing here would ever legitimately
# need.) This list is what a browser can actually play plus the two intraframe
# codecs cameras and screen recorders emit; everything else yields no poster.
ALLOWED_VIDEO_CODECS = frozenset({
    "h264", "hevc", "vp8", "vp9", "av1", "mpeg4",
    "mjpeg", "prores", "theora",
})


class PosterUnavailable(Exception):
    """No poster could be derived. Terminal, never retried."""


class PosterRetryable(Exception):
    """The attempt failed for a reason that is not about this video.

    Distinct from `PosterUnavailable` because the two have opposite correct
    responses. A file that cannot be decoded will never decode, and retrying
    it burns the queue; a child killed by the cgroup OOM killer while the
    node was under memory pressure says nothing about the file at all, and
    swallowing it marks the job DONE and leaves the upload posterless until
    an operator intervenes; failed jobs otherwise get one cooled-down,
    bounded sweep readmission.
    `VARIANT_RETRY` allows eight infrastructure retries after the first run,
    so this remains bounded while surviving a longer decoder outage.
    """


def _source_missing_exceptions() -> tuple:
    """Exception types that mean "the source OBJECT is gone", not "the
    object store is having a bad moment" .

    `FileNotFoundError` is what BOTH storage backends raise, and from the
    SAME place -- `.open()` itself, not a later read. Locally,
    `FileSystemStorage.open()` raises it directly. In production
    `STORAGES["default"]` is django-storages' `GoogleCloudStorage`
    (pinned 1.14.6); `GoogleCloudStorage._open` (`storages/backends/
    gcloud.py:181-186`) calls `bucket.get_blob()`, which does its own
    metadata fetch and returns `None` on a 404 rather than raising --
    `_open` then raises `FileNotFoundError` itself before `_copy_source_
    to_temp` ever gets a file object to read from. `google.api_core.
    exceptions.NotFound` (the same class `_gcs_backend()` in `tasks.py`
    guards against, imported the same optional way so this module keeps
    working if `google-cloud-storage` is ever absent -- the demux child
    imports this module too, and never talks to storage) is a narrower
    backstop: it surfaces only from the later `download_to_file()` read,
    for the TOCTOU window where the object existed at `get_blob()` but was
    deleted before the download -- not the common case, but the same
    terminal outcome either way.
    """
    exceptions: list = [FileNotFoundError]
    try:
        from google.api_core.exceptions import NotFound
    except ImportError:  # pragma: no cover - optional GCS dependency
        pass
    else:
        exceptions.append(NotFound)
    return tuple(exceptions)


def _copy_source_to_temp(generic_file, tmp):
    """
    Stream the upload onto local disk, refusing anything oversized.

    The declared size is checked FIRST, so a file we are going to refuse is
    never fetched: legacy source objects may be larger than this command's
    1 GiB processing ceiling, and reading an oversized one before rejecting
    it would burn the single catch-all worker's slot, its object
    store egress and its node's ephemeral disk for nothing. The streaming
    check below stays as the backstop -- `storage.size()` is metadata, and
    metadata can be absent, stale or wrong.
    """
    try:
        declared = generic_file.file.size
    except Exception:  # noqa: BLE001 - storage may not answer; fall through
        declared = None
    if declared is not None and declared > MAX_SOURCE_BYTES:
        raise PosterUnavailable(
            f"source declares {declared} bytes, over MAX_SOURCE_BYTES "
            f"({MAX_SOURCE_BYTES})"
        )

    copied = 0
    with generic_file.file.open(mode="rb") as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            copied += len(chunk)
            if copied > MAX_SOURCE_BYTES:
                raise PosterUnavailable(
                    f"source exceeds MAX_SOURCE_BYTES ({MAX_SOURCE_BYTES})"
                )
            tmp.write(chunk)
    if copied == 0:
        raise PosterUnavailable("source is empty")
    tmp.flush()
    tmp.seek(0)
    return copied


def _refuse_oversized_frame(frame, max_pixels=None):
    if max_pixels is None:
        max_pixels = MAX_DECODE_PIXELS
    pixels = (frame.width or 0) * (frame.height or 0)
    if pixels > max_pixels:
        raise PosterUnavailable(
            f"decoded frame {frame.width}x{frame.height} = {pixels} px "
            f"exceeds MAX_DECODE_PIXELS ({max_pixels})"
        )


def _frame_at_or_after(container, stream, target, deadline, max_pixels=None):
    """
    First decoded frame at or after ``target`` seconds, as a PIL image.

    `container.seek` lands on the preceding KEYFRAME, which for a
    libx264-encoded clip with a default 250-frame GOP is very often frame 0
    -- and frame 0 of a real video is very often black or mid-fade. So the
    decoder is walked forward from that keyframe to the requested
    timestamp. That walk is what makes the poster representative rather
    than merely present, and it is why this does not simply decode with
    ``skip_frame = "NONKEY"``.

    Bounded by both a frame count and a wall clock; on either bound it
    returns the best frame decoded so far rather than failing, because a
    frame from the wrong second is still a real frame of this video.
    Returns ``None`` only when nothing decoded at all.
    """
    decoded = 0
    earliest = None
    try:
        for frame in container.decode(stream):
            decoded += 1
            if earliest is None:
                earliest = frame
            # The declared `codec_context` geometry is checked before any
            # decoding starts, but H.264/HEVC can change resolution IN BAND:
            # a file can declare something tiny and hand back a huge frame.
            # FFmpeg has already allocated that frame by the time we see it,
            # so this is a partial mitigation -- what it does prevent is
            # `to_image()` allocating a second, RGB copy of it and Pillow
            # then resizing it, which is where the worker actually dies.
            _refuse_oversized_frame(frame, max_pixels)
            timestamp = frame.time
            if timestamp is None or timestamp >= target:
                return frame.to_image()
            if decoded >= MAX_DECODED_PACKETS:
                logger.info(
                    "poster: stopping at the %s-frame cap before %.2fs",
                    MAX_DECODED_PACKETS, target,
                )
                break
            if time.monotonic() > deadline:
                logger.info("poster: stopping at the decode deadline")
                break
    except Exception:
        # A stream that dies part way through still gave us frames; a
        # decoder error after we already hold one is not a reason to have
        # no poster.
        if earliest is None:
            raise
    if earliest is None:
        return None
    _refuse_oversized_frame(earliest, max_pixels)
    return earliest.to_image()


def extract_poster_bytes(generic_file):
    """
    Return ``(webp_bytes, width, height)`` for ``generic_file``'s poster
    frame, or ``None`` if one cannot be produced.

    Raises only for a TRANSIENT failure (a flaky object-store read, node
    memory/disk pressure) so procrastinate retries it -- swallowing that
    would mark the job DONE and the upload would silently never get a
    poster, defeating `VARIANT_RETRY`. Every other outcome, including the
    source object itself having been deleted from storage between upload
    and this job running, is TERMINAL and returns ``None`` instead of
    raising: the caller leaves the video without a poster rather than
    burning retries on something that can never succeed, or emitting a
    `thumbnailUrl` that 404s.
    """
    with tempfile.NamedTemporaryFile(suffix=".bin") as tmp:
        # OUTSIDE the broad handler, deliberately. A transient object-store
        # read (a GCS timeout, a full /tmp) is not "this video has no
        # poster" -- swallowing it would mark the job DONE and the upload
        # would silently never get one, defeating VARIANT_RETRY. Let it
        # propagate so procrastinate retries. `PosterUnavailable` from here
        # is the terminal kind (oversized, empty) and is not retried.
        try:
            _copy_source_to_temp(generic_file, tmp)
        except PosterUnavailable as exc:
            logger.info(
                "extract_poster_bytes: no poster for %s (%s): %s",
                generic_file.pk, generic_file.file.name, exc,
            )
            return None
        except _source_missing_exceptions() as exc:
            # The source OBJECT is gone (deleted, or a manual purge), not
            # "the store is having a bad moment". Not an upload race: the
            # poster job is deferred from signals.py's on_commit, so the
            # FileField has already written the object by the time this
            # runs -- a first-run miss really means the object is gone.
            # Retrying this burns the retry budget on something that can
            # never succeed (tuzi#2096): every future attempt hits the same
            # FileNotFoundError/NotFound. Terminal, and logged distinctly
            # from both the generic "no poster" info line above and the
            # transient-failure warning below, so this is never mistaken
            # for either an unusable video or a live object-store outage.
            logger.warning(
                "extract_poster_bytes: source object gone for %s (%s): "
                "%s: %s -- terminal, not retried",
                generic_file.pk, generic_file.file.name,
                type(exc).__name__, exc,
            )
            return None

        try:
            return _decode_poster_sandboxed(tmp.name, generic_file)
        except PosterUnavailable as exc:
            logger.info(
                "extract_poster_bytes: no poster for %s (%s): %s",
                generic_file.pk, generic_file.file.name, exc,
            )
            return None
        except (OSError, PosterRetryable) as exc:
            # NOT a media failure, and NOT terminal. EMFILE/EAGAIN from
            # `Popen`, ENOSPC or an inode shortage on the /tmp emptyDir --
            # these are node pressure, and swallowing them would mark the job
            # DONE and leave the upload posterless without a failed job for
            # the cooled-down sweep readmission to discover.
            # Re-raised so procrastinate retries, exactly like the storage
            # read above. Listed BEFORE the broad handler, which is the only
            # thing that makes the distinction real.
            logger.warning(
                "extract_poster_bytes: transient failure for %s (%s): %s: %s",
                generic_file.pk, generic_file.file.name,
                type(exc).__name__, exc,
            )
            raise
        except Exception as exc:  # noqa: BLE001 - attacker-supplied media
            # Broad on purpose, and scoped to the DEMUX/DECODE step only.
            # The child already fails closed for anything media-shaped; this
            # is the parent's own backstop (an unreadable answer, a decoder
            # that died in a way the child could not report) and it must not
            # abort a backfill batch or burn retries on a file that will
            # never decode.
            logger.warning(
                "extract_poster_bytes: failed for %s (%s): %s: %s",
                generic_file.pk, generic_file.file.name,
                type(exc).__name__, exc,
            )
            return None


def _child_argv(source_path, demux_format, output_path):
    """The exact command line the sandboxed child is spawned with.

    Split out so a test can assert the limits are really on it: a subprocess
    that is spawned WITHOUT its ceilings is indistinguishable from the
    in-process version this replaced, and would pass every other test here.
    """
    return [
        sys.executable,
        "-m", "dj.apps.uploads.video_utils",
        "--child",
        "--source", source_path,
        "--format", demux_format,
        "--output", output_path,
        "--address-space", str(POSTER_SUBPROCESS_ADDRESS_SPACE_BYTES),
        "--cpu-seconds", str(POSTER_SUBPROCESS_CPU_SECONDS),
        # Read at SPAWN time, so the parent stays the single source of truth
        # for every bound. It also keeps the ceiling testable: a constant the
        # child re-imported for itself could not be lowered from a test, and
        # `test_frames_above_the_pixel_ceiling_are_refused` would have
        # silently stopped exercising anything the moment decoding moved out
        # of process.
        "--max-pixels", str(MAX_DECODE_PIXELS),
        "--max-file-bytes", str(POSTER_SUBPROCESS_MAX_FILE_BYTES),
    ]


#The only environment variables the demuxer child is given. An ALLOW-list,
#not a deny-list: a deny-list is wrong by omission the first time somebody
#adds a secret, and this process exists to run an FFmpeg decoder over
#attacker-supplied bytes. `dict(os.environ)` handed it `DBPASS`, the Stripe
#keys and everything else the worker holds (codex adversarial review).
#`PYTHONPATH` is in here, and it is not an oversight. It is how the
#interpreter resolves its own dependencies (`av`, Pillow) wherever
#site-packages is not the only source -- CI sets it, and dropping it made
#eight tests fail with the child unable to import `av` at all. It carries no
#credential. `package_root` is PREPENDED to whatever it already held.
CHILD_ENV_PASSTHROUGH = (
    "PATH", "PYTHONPATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ",
    # Virtualenvs resolve site-packages from the interpreter, but an
    # activated venv sets these and a child that ignores them can end up on a
    # different set of packages than the parent it was spawned from.
    "VIRTUAL_ENV",
)


def _child_env():
    """A MINIMAL environment for the child, carrying no credential.

    `python -m dj.apps.uploads.video_utils` must resolve without Django, so
    `py/` is prepended to PYTHONPATH from this file's own location rather
    than trusted to be inherited -- the child then resolves the same tree the
    parent was imported from even though it inherits nothing else. Every
    `__init__.py` from `dj` down to `dj.apps.uploads` is empty, so the child
    starts without importing Django, settings or a database driver, and holds
    no connection to lose.

    BE PRECISE ABOUT WHAT THIS BUYS. It removes the parent's environment from
    the child's. It does NOT isolate the child from the POD it runs in: the
    child shares that pod's network namespace, its projected token and its
    filesystem, and can read the parent's environment back out of
    `/proc/<ppid>/environ` because it runs as the same uid. That is why, in
    production, the parent is `video_decoder_service` in the `video-decoder`
    pod -- which has no secret, no token and no identity for the child to
    find -- and never the procrastinate worker. Here this allow-list
    is what keeps the decoder pod's own environment (`HOME`, `PATH`) from
    growing into the child by accident; the codec and container allowlists
    are what keep the reachable decoder surface small.
    """
    package_root = os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__))
    )))
    env = {
        name: os.environ[name]
        for name in CHILD_ENV_PASSTHROUGH
        if name in os.environ
    }
    inherited = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = (
        f"{package_root}{os.pathsep}{inherited}" if inherited else package_root
    )
    # No `.pyc` writes into a tree the child should only ever read.
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def _decoder_url():
    """Where the isolated decoder is, or None to demux in a local child."""
    return os.environ.get(POSTER_DECODER_URL_ENV, "").strip() or None


def _running_in_kubernetes():
    """Observed environment, not a setting: the kubelet sets this in every
    pod, and nobody can turn it off from a ConfigMap."""
    return bool(os.environ.get("KUBERNETES_SERVICE_HOST"))


def _decode_poster_sandboxed(source_path, generic_file):
    """Demux and decode somewhere this process is willing to lose.

    The mime type is mapped to a demuxer HERE, in the worker, so an
    unsupported type never leaves this process at all.

    WHERE the demux happens is decided from the environment:

    * `VIDEO_DECODER_URL` set -> the `video-decoder` pod, over HTTP. This is
      production. The worker's identity, secrets and network never meet the
      attacker's bytes and a decoder.
    * unset, and this is a Kubernetes pod -> REFUSED, as a retryable failure.
      A pod that has lost its ConfigMap entry must not quietly fall back to
      running FFmpeg beside `DBPASS` and the metadata server; that fallback
      is the exact posture this change retires, and a fail-open here would
      be invisible (posters would keep appearing). The job retries, fails,
      and the failed job is the alarm.
    * unset, outside Kubernetes -> a local rlimited child. Development and
      the test suite. The child is the same code the service runs, so the
      suite exercises the real decode path either way.
    """
    demux_format = _demux_format_for(generic_file.mime_type)
    if demux_format is None:
        raise PosterUnavailable(
            f"mime type {generic_file.mime_type!r} has no allowlisted demuxer"
        )

    decoder_url = _decoder_url()
    if decoder_url:
        return _decode_poster_remote(source_path, demux_format, decoder_url)
    if _running_in_kubernetes():
        raise PosterRetryable(
            "refusing to demux inside the worker pod: "
            f"{POSTER_DECODER_URL_ENV} is unset. Production demuxes only in "
            "the video-decoder pod (k8s/free2z/video-decoder/, #1575); set "
            "it in k8s/free2z/config.yaml and restart the worker"
        )
    return _run_decoder_child(source_path, demux_format)


def _decode_poster_remote(source_path, demux_format, decoder_url):
    """Hand the spooled source to the isolated decoder and take its answer.

    The source is streamed from disk with an explicit Content-Length -- the
    service is `http.server`, which does not speak chunked request bodies,
    and it refuses a body it cannot size up front. The answer is read with
    a cap, exactly like the local child's stdout.

    FAILURE MAPPING, because it decides what retries. Anything that is about
    the TRANSPORT -- connection refused, a timeout, a 5xx, an answer that is
    not JSON -- is `PosterRetryable`: the decoder being down says nothing
    about this video, and swallowing it would strand the upload posterless.
    Anything the decoder SAID about the media is terminal unless it says
    otherwise; the service marks its own transient conditions (busy, node
    pressure) `retryable` in the body.
    """
    parts = urllib.parse.urlsplit(decoder_url)
    if parts.scheme != "http" or not parts.hostname:
        # A misconfiguration, not a media failure. Retryable so it surfaces
        # as failed jobs rather than as videos that quietly have no poster.
        raise PosterRetryable(
            f"{POSTER_DECODER_URL_ENV}={decoder_url!r} is not an "
            "http://host[:port] URL"
        )
    size = os.path.getsize(source_path)
    headers = {
        "Content-Type": "application/octet-stream",
        "Content-Length": str(size),
        POSTER_DECODER_FORMAT_HEADER: demux_format,
        POSTER_DECODER_PROTOCOL_HEADER: POSTER_DECODER_PROTOCOL,
    }
    connection = http.client.HTTPConnection(
        parts.hostname, parts.port or 80,
        timeout=min(POSTER_DECODER_SOCKET_TIMEOUT_SECONDS,
                    POSTER_DECODER_TIMEOUT_SECONDS),
    )
    # THE DEADLINE. A watchdog thread closes the socket when it passes, so
    # whatever blocking call the worker is in -- sending the body, waiting
    # for headers, reading a dripped answer -- fails right then instead of
    # being kept alive one byte at a time. Armed before the first byte goes
    # out; the socket exists from `connect()` onwards, which is itself
    # bounded by the socket timeout.
    expired = threading.Event()
    # OUR OWN reference to the socket, taken right after `connect()`. Not
    # `connection.sock`: `getresponse()` sets that to None as soon as the
    # response says `Connection: close` (or is HTTP/1.0), while the response
    # object keeps reading from the socket through its own file handle -- so
    # a watchdog that looked the socket up through the connection would find
    # nothing to close exactly when a hostile decoder chose that header
    # (codex adversarial review, round 2).
    held = {}

    def _abort():
        expired.set()
        sock = held.get("sock")
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass

    watchdog = threading.Timer(POSTER_DECODER_TIMEOUT_SECONDS, _abort)
    watchdog.daemon = True
    try:
        connection.connect()
        held["sock"] = connection.sock
        watchdog.start()
        with open(source_path, "rb") as body:
            connection.request("POST", POSTER_DECODER_PATH, body=body,
                               headers=headers)
        response = connection.getresponse()
        status = response.status
        raw = response.read(POSTER_DECODER_MAX_RESPONSE_BYTES + 1)
    except (OSError, http.client.HTTPException) as exc:
        if expired.is_set():
            raise PosterRetryable(
                f"video decoder at {decoder_url} did not finish within "
                f"{POSTER_DECODER_TIMEOUT_SECONDS}s; the exchange was aborted"
            )
        raise PosterRetryable(
            f"video decoder at {decoder_url} unreachable: "
            f"{type(exc).__name__}: {exc}"
        )
    finally:
        watchdog.cancel()
        connection.close()
    if expired.is_set():
        # The watchdog fired between the last read returning and here: the
        # answer may be truncated. Retryable, like every transport failure.
        raise PosterRetryable(
            f"video decoder at {decoder_url} did not finish within "
            f"{POSTER_DECODER_TIMEOUT_SECONDS}s"
        )

    if len(raw) > POSTER_DECODER_MAX_RESPONSE_BYTES:
        raise PosterRetryable(
            "video decoder answered with more than "
            f"{POSTER_DECODER_MAX_RESPONSE_BYTES} bytes; refusing to read it"
        )
    try:
        answer = json.loads(raw.decode("utf-8", "replace") or "{}")
        if not isinstance(answer, dict):
            raise ValueError("not an object")
    except ValueError:
        raise PosterRetryable(
            f"video decoder answered HTTP {status} with no usable JSON: "
            f"{_tail(raw)}"
        )

    if not answer.get("ok"):
        reason = answer.get("reason") or f"video decoder answered HTTP {status}"
        if answer.get("retryable") or status >= 500:
            raise PosterRetryable(f"video decoder: {reason}")
        raise PosterUnavailable(f"video decoder: {reason}")
    if status != 200 or answer.get("protocol") != POSTER_DECODER_PROTOCOL:
        raise PosterRetryable(
            "video decoder success has an unexpected status or protocol; "
            "worker and decoder may be from different releases"
        )
    try:
        webp = base64.b64decode(answer["webp_base64"], validate=True)
        width, height = int(answer["width"]), int(answer["height"])
    except (KeyError, TypeError, ValueError) as exc:
        raise PosterRetryable(
            f"video decoder answered ok without a usable poster: {exc}"
        )
    if not (0 < width <= POSTER_MAX_WIDTH and 0 < height <= POSTER_MAX_WIDTH):
        raise PosterRetryable("video decoder returned invalid poster geometry")
    if not webp:
        raise PosterUnavailable("video decoder returned an empty poster")
    return webp, width, height


def _run_decoder_child(source_path, demux_format):
    """Demux and decode in a child process that cannot outgrow its limits.

    THE REASON THIS IS NOT INLINE. `av.open()` allocates in proportion to
    what the file DECLARES, not to its size -- a 642-byte MP4 reaches 2.3 GB
    before returning (see the module docstring). Every ceiling in this module
    used to run after that call, so none of them was reachable in time; the
    only thing that bounds a native allocation is a limit the kernel enforces
    on a process we are willing to lose.

    Runs in the `video-decoder` pod in production and in the worker process
    only outside Kubernetes -- see `_decode_poster_sandboxed`.
    """
    if demux_format not in set(_DEMUX_FORMATS.values()):
        raise PosterUnavailable(f"format {demux_format!r} not allowlisted")

    # PIPES WOULD BE UNBOUNDED IN THE PARENT (codex adversarial review).
    # `communicate()` buffers the child's whole stdout and stderr in this
    # process before anything gets to apply a cap, so a decoder induced to
    # emit diagnostics for the full 75-second window would grow the WORKER
    # while the child sat comfortably inside its own ceiling -- the exact
    # inversion this change exists to prevent. Files on disk instead, read
    # back with a cap. `/tmp` is an emptyDir; the wall clock bounds how long
    # anything can write to it.
    with tempfile.NamedTemporaryFile(suffix=".webp") as out, \
            tempfile.TemporaryFile() as child_out, \
            tempfile.TemporaryFile() as child_err:
        argv = _child_argv(source_path, demux_format, out.name)
        # start_new_session so the child leads its own process group and a
        # timeout can kill the whole group; FFmpeg does not fork today, but
        # "today" is not a bound.
        #
        # An OSError HERE IS TRANSIENT, not "this video has no poster":
        # EMFILE, EAGAIN and a full /tmp are node pressure. Letting it
        # propagate is what makes procrastinate retry instead of marking the
        # job done and leaving the upload permanently posterless (codex
        # adversarial review). Only media-shaped failures below are terminal.
        process = subprocess.Popen(
            argv,
            stdout=child_out,
            stderr=child_err,
            stdin=subprocess.DEVNULL,
            env=_child_env(),
            start_new_session=True,
            close_fds=True,
        )
        try:
            process.communicate(
                timeout=POSTER_SUBPROCESS_TIMEOUT_SECONDS
            )
        except subprocess.TimeoutExpired:
            _kill_group(process)
            # Reap, so a killed child cannot be left a zombie for the life of
            # a long backfill.
            try:
                process.communicate(timeout=10)
            except Exception:  # noqa: BLE001
                pass
            raise PosterUnavailable(
                "poster subprocess exceeded "
                f"{POSTER_SUBPROCESS_TIMEOUT_SECONDS}s and was killed"
            )

        stdout = _read_capped(child_out, POSTER_SUBPROCESS_MAX_STDOUT)
        stderr = _read_capped(child_err, POSTER_SUBPROCESS_MAX_STDOUT)

        if process.returncode != 0:
            detail = _describe_exit(process.returncode)
            # WHICH SIGNAL DECIDES WHETHER THIS RETRIES.
            #
            # SIGXCPU / SIGXFSZ are OUR OWN ceilings firing: the file really
            # is pathological and will be pathological again, so retrying it
            # only burns the queue. Terminal.
            #
            # SIGKILL is not ours -- our own timeout kill raises above,
            # before this -- so it is the cgroup OOM killer, i.e. the NODE
            # was under pressure, which says nothing about this video.
            # Terminal would strand a perfectly good upload with no poster
            # until the cooled-down sweep readmission gets a chance to retry.
            #
            # Anything else (a SIGSEGV out of a decoder) is this file
            # breaking this decoder: terminal, or a crashing file burns all
            # infrastructure retries every time it is touched.
            if process.returncode == -signal.SIGKILL:
                raise PosterRetryable(
                    f"poster subprocess {detail} (external memory pressure, "
                    f"not this video): {_tail(stderr)}"
                )
            raise PosterUnavailable(
                f"poster subprocess {detail}: "
                f"{_tail(stderr)}"
            )

        try:
            answer = json.loads((stdout or b"").decode("utf-8", "replace") or "{}")
        except ValueError:
            raise PosterUnavailable(
                f"poster subprocess wrote no usable answer: {_tail(stdout)}"
            )
        _require_enforced_limits(answer.get("limits"))

        if not answer.get("ok"):
            raise PosterUnavailable(
                answer.get("reason") or "poster subprocess reported no poster"
            )

        out.seek(0)
        webp = out.read()
        if not webp:
            raise PosterUnavailable("poster subprocess wrote an empty file")
        return webp, int(answer["width"]), int(answer["height"])


def _limits_are_sufficient(limits):
    """Is this process actually bounded enough to demux hostile media?

    One predicate, deliberately, used by the child before it decodes and by
    the parent before it accepts a result. Two copies of this rule would be
    one copy too many.

    Linux is the deployment platform and the ceiling is mandatory there. macOS
    does not implement `RLIMIT_AS` at all (`setrlimit` fails EINVAL), so a
    developer laptop is allowed to proceed unbounded -- and is told so. The
    discriminator is observed kernel behaviour, not a settings flag anyone can
    switch off.
    """
    if (limits or {}).get("address_space"):
        return True
    return not sys.platform.startswith("linux")


def _require_enforced_limits(limits):
    """Refuse a poster produced by a child that was NOT actually bounded.

    The child reads its limits back from the kernel rather than assuming the
    `setrlimit` call meant anything, so this can tell "bounded" from "asked
    to be bounded". The distinction is the whole fix: a subprocess without
    its ceilings is exactly the in-process version this replaced, and would
    otherwise pass every other assertion in the suite.

    LINUX IS THE DEPLOYMENT PLATFORM, and there the ceiling is mandatory --
    if it ever stops being installable, posters stop rather than the demuxer
    running unbounded again. macOS does not implement `RLIMIT_AS` at all
    (`setrlimit` fails with EINVAL), so a developer's laptop keeps working
    and is told, once per extraction, exactly which guarantee it is missing.
    Deciding on the observed kernel behaviour rather than on a settings flag
    is deliberate: there is no switch here for someone to turn off.
    """
    if (limits or {}).get("address_space"):
        return
    if not _limits_are_sufficient(limits):
        raise PosterUnavailable(
            "poster subprocess could not install its RLIMIT_AS ceiling; "
            "refusing to demux attacker-supplied media unbounded"
        )
    logger.warning(
        "poster: %s cannot enforce RLIMIT_AS, so this host demuxes video "
        "WITHOUT an address-space ceiling. Fine for local development, and "
        "the reason production runs on Linux.",
        sys.platform,
    )


def _read_capped(handle, limit):
    """At most `limit` bytes from the FRONT of a child's output file.

    The front, not the tail: the child's protocol is one JSON line written
    first, so a child that then floods cannot push its own answer out of
    range. The file is on disk, so this is the only point at which any of it
    enters the parent's memory.
    """
    try:
        handle.seek(0)
        return handle.read(limit)
    except OSError:
        return b""


def _kill_group(process):
    """SIGKILL the child's process group, falling back to the child."""
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except Exception:  # noqa: BLE001 - already gone, or no process group
        try:
            process.kill()
        except Exception:  # noqa: BLE001
            pass


def _describe_exit(returncode):
    if returncode < 0:
        name = signal.Signals(-returncode).name if -returncode in {
            s.value for s in signal.Signals
        } else str(-returncode)
        if name == "SIGXCPU":
            return (
                f"was killed by {name} (RLIMIT_CPU, "
                f"{POSTER_SUBPROCESS_CPU_SECONDS}s)"
            )
        if name == "SIGXFSZ":
            return (
                f"was killed by {name} (RLIMIT_FSIZE, "
                f"{POSTER_SUBPROCESS_MAX_FILE_BYTES} bytes)"
            )
        return f"was killed by {name}"
    return f"exited {returncode}"


def _tail(stream, limit=400):
    text = (stream or b"").decode("utf-8", "replace").strip()
    return text[-limit:] if text else "<no output>"


def _demux_format_for(mime_type):
    """
    The ONE demuxer we let FFmpeg use, chosen from our own sniffed mime type.

    Without this, `av.open()` probes: it reads attacker-controlled bytes and
    decides for itself which of FFmpeg's demuxers to run, before any
    allowlist of ours has had a chance to look. Naming the format removes
    that step entirely -- a file whose bytes are not the container we
    sniffed simply fails to open.
    """
    return _DEMUX_FORMATS.get(mime_type)


#Our sniffed mime type -> the ONE demuxer FFmpeg is allowed to use for it.
_DEMUX_FORMATS = {
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
}


def _decode_poster(path, demux_format, max_pixels=None):
    """Demux, decode and encode the poster. RUNS ONLY IN THE CHILD.

    Every ceiling below is an early exit under the child's address-space and
    CPU limits, not a substitute for them -- `av.open()` on the next line is
    the call that cannot be bounded from inside this process.
    """
    # Imported lazily so importing this module (admin autodiscovery, the
    # OpenAPI generation step, `manage.py check`) does not pull in a
    # multi-megabyte FFmpeg binding.
    import av
    from PIL import Image

    if max_pixels is None:
        max_pixels = MAX_DECODE_PIXELS
    deadline = time.monotonic() + DECODE_DEADLINE_SECONDS

    if True:
        with av.open(path, format=demux_format) as container:
            # Belt and braces: `format=` above already pinned the demuxer,
            # so this can only fire if that mapping and this list disagree.
            container_format = getattr(container.format, "name", "")
            if container_format not in ALLOWED_CONTAINER_FORMATS:
                raise PosterUnavailable(
                    f"container format {container_format!r} is not allowlisted"
                )
            if not container.streams.video:
                raise PosterUnavailable("no video stream")
            stream = container.streams.video[0]
            codec_name = getattr(stream.codec_context, "name", "")
            if codec_name not in ALLOWED_VIDEO_CODECS:
                raise PosterUnavailable(
                    f"video codec {codec_name!r} is not allowlisted"
                )
            # Single-threaded on purpose: the worker runs at concurrency 1
            # inside a 1-CPU container, and frame-threading buys
            # nothing when exactly one frame is wanted while multiplying the
            # decoder's reference-frame memory by the thread count.
            stream.codec_context.thread_count = 1

            width = stream.codec_context.width
            height = stream.codec_context.height
            pixels = width * height
            if pixels <= 0:
                raise PosterUnavailable("stream reports no geometry")
            if pixels > max_pixels:
                raise PosterUnavailable(
                    f"{width}x{height} = {pixels} px exceeds "
                    f"MAX_DECODE_PIXELS ({max_pixels})"
                )

            duration = None
            if container.duration:
                duration = float(container.duration) / av.time_base

            offset = POSTER_SEEK_SECONDS
            if duration and duration > 0:
                offset = min(offset, duration * POSTER_SEEK_MAX_FRACTION)
            if offset > 0:
                try:
                    container.seek(
                        int(offset * av.time_base), backward=True,
                    )
                except Exception:
                    # A stream that cannot seek is still decodable from
                    # the start; that is a worse poster, not a failure.
                    logger.debug("poster: seek failed; decoding from the start")

            image = _frame_at_or_after(
                container, stream, offset, deadline, max_pixels,
            )
            if image is None:
                raise PosterUnavailable("no decodable frame")

    try:
        if image.mode != "RGB":
            converted = image.convert("RGB")
            image.close()
            image = converted

        # Fit inside a POSTER_MAX_WIDTH square: the ceiling is on the LONGEST
        # edge, so a portrait 1080x1920 frame becomes 450x800 rather than
        # 800x1422, and the extreme aspect ratios `MAX_DECODE_PIXELS` still
        # admits (an 800x16000 frame is only 12.8 MP) cannot produce a poster
        # twenty times taller than the number in the constant's name.
        if max(image.width, image.height) > POSTER_MAX_WIDTH:
            scale = POSTER_MAX_WIDTH / max(image.width, image.height)
            target = (
                max(1, round(image.width * scale)),
                max(1, round(image.height * scale)),
            )
            resized = image.resize(target, Image.LANCZOS)
            image.close()
            image = resized

        with BytesIO() as output:
            image.save(output, format="WEBP", quality=POSTER_QUALITY)
            payload = output.getvalue()
        result = (payload, image.width, image.height)
    finally:
        image.close()

    return result


def poster_file_name(generic_file, token):
    """`<stem>_poster_<token>.webp`, beside the parent in the bucket."""
    base_name = os.path.splitext(os.path.basename(generic_file.file.name))[0]
    return f"{base_name}_poster_{token}.webp"


# ---------------------------------------------------------------------------
# The child process
#
# `python -m dj.apps.uploads.video_utils --child...`. It lives in this module
# rather than a separate one on purpose: parent and child then share one copy
# of every constant and of `_decode_poster` itself, so the limits the parent
# advertises and the limits the child applies cannot drift apart.
#
# It never imports Django. Every `__init__.py` from `dj` down is empty, so the
# whole child is `resource` + `av` + Pillow: fast to start, and it holds no
# database connection or credential to lose if a decoder is exploited.
# ---------------------------------------------------------------------------

def _apply_child_limits(address_space, cpu_seconds, max_file_bytes=None):
    """Install the ceilings on ourselves, BEFORE any media library is imported.

    Order is the point. `import av` maps FFmpeg's shared libraries and
    `av.open()` is what allocates; both must happen with the ceiling already
    installed, or the ceiling is decoration. The hard limit is set alongside
    the soft one so nothing later can raise it back.

    Returns what is ACTUALLY in force, read back from the kernel rather than
    assumed. Darwin does not implement `RLIMIT_AS` -- `setrlimit` fails with
    EINVAL, which CPython surfaces as `ValueError` -- so on a macOS
    development machine the address-space ceiling simply does not exist. That
    is reported honestly instead of being swallowed, and the PARENT decides
    what to do about it: on Linux, which is the only platform this is
    deployed on, a missing ceiling is fatal.
    """
    enforced = {
        "cpu_seconds": None, "address_space": None, "file_bytes": None,
    }
    if max_file_bytes is not None:
        try:
            # Soft below hard for the same reason as RLIMIT_CPU: the soft
            # limit raises SIGXFSZ (a nameable cause), the hard limit is what
            # cannot be talked out of.
            resource.setrlimit(
                resource.RLIMIT_FSIZE,
                (max_file_bytes, max_file_bytes * 2),
            )
            enforced["file_bytes"] = resource.getrlimit(
                resource.RLIMIT_FSIZE
            )[0]
        except (ValueError, OSError, AttributeError):
            pass
    try:
        # SOFT below HARD, deliberately. At the soft limit the kernel sends
        # SIGXCPU, which names the cause in the parent's log; at the hard
        # limit it sends SIGKILL, which cannot be ignored. Setting them equal
        # (the obvious thing) collapses that to a bare SIGKILL on Linux --
        # observed as exit -9 -- and "the poster job keeps dying" then looks
        # identical to a cgroup OOM. The grace is what buys the diagnostic
        # without weakening the guarantee.
        resource.setrlimit(
            resource.RLIMIT_CPU,
            (cpu_seconds, cpu_seconds + POSTER_SUBPROCESS_CPU_GRACE_SECONDS),
        )
        enforced["cpu_seconds"] = resource.getrlimit(resource.RLIMIT_CPU)[0]
    except (ValueError, OSError, AttributeError):
        pass
    try:
        resource.setrlimit(resource.RLIMIT_AS, (address_space, address_space))
        enforced["address_space"] = resource.getrlimit(resource.RLIMIT_AS)[0]
    except (ValueError, OSError, AttributeError):
        pass
    return enforced


def _child_main(argv):
    import argparse

    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--child", action="store_true")
    parser.add_argument("--source", required=True)
    parser.add_argument("--format", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--address-space", type=int, required=True)
    parser.add_argument("--cpu-seconds", type=int, required=True)
    parser.add_argument("--max-pixels", type=int, required=True)
    parser.add_argument("--max-file-bytes", type=int, required=True)
    args = parser.parse_args(argv)

    # Refuse a demuxer the parent should never have asked for. The parent
    # already maps mime -> format, so this is the child declining to be
    # talked into a different one.
    if args.format not in set(_DEMUX_FORMATS.values()):
        _emit({"ok": False, "reason": f"format {args.format!r} not allowlisted"})
        return 0

    limits = _apply_child_limits(
        args.address_space, args.cpu_seconds, args.max_file_bytes,
    )

    # FAIL CLOSED HERE, NOT IN THE PARENT (codex adversarial review, HIGH).
    # The parent also checks, but it cannot check until `communicate()`
    # returns -- by which time this process has already run the demuxer and
    # allocated whatever it wanted. A ceiling verified after the allocation
    # is not a ceiling. So the refusal has to happen in the only place that
    # is still upstream of `av.open()`: right here, before `_decode_poster`
    # imports av at all.
    if not _limits_are_sufficient(limits):
        _emit({
            "ok": False,
            "reason": (
                "refusing to demux: RLIMIT_AS could not be installed on "
                f"{sys.platform}"
            ),
        }, limits)
        return 0

    try:
        payload, width, height = _decode_poster(
            args.source, args.format, args.max_pixels,
        )
    except PosterUnavailable as exc:
        _emit({"ok": False, "reason": str(exc)}, limits)
        return 0
    except MemoryError:
        # RLIMIT_AS surfacing as a Python allocation failure rather than a
        # kill. Reported as its own reason because "this file wanted more
        # address space than a poster is worth" is a different operational
        # story from "this file is corrupt".
        _emit({"ok": False, "reason": "decode exceeded the address-space limit"}, limits)
        return 0
    except Exception as exc:  # noqa: BLE001 - attacker-supplied media
        # `av` raises its own hierarchy plus whatever the bundled FFmpeg
        # feels like. An allocation refused by RLIMIT_AS also arrives here,
        # as an errno from inside FFmpeg rather than a MemoryError.
        _emit({
            "ok": False,
            "reason": f"{type(exc).__name__}: {str(exc)[:200]}",
        }, limits)
        return 0

    with open(args.output, "wb") as handle:
        handle.write(payload)
    _emit({"ok": True, "width": width, "height": height, "bytes": len(payload)}, limits)
    return 0


def _child_peak_kb():
    """The child's own high-water mark, for the tests that pin the limits."""
    try:
        with open("/proc/self/status") as handle:
            for line in handle:
                if line.startswith("VmHWM:"):
                    return int(line.split()[1])
    except OSError:
        pass
    return None


def _emit(answer, limits=None):
    """One JSON line on stdout, and nothing else ever.

    `peak_rss_kb` rides along because it is the only number that tells the
    difference between "the limits are installed" and "the limits are
    decoration" -- a child that quietly ran unbounded produces an identical
    answer otherwise. The tests assert on it.
    """
    peak = _child_peak_kb()
    if peak is not None:
        answer = {**answer, "peak_rss_kb": peak}
    if limits is not None:
        answer = {**answer, "limits": limits}
    sys.stdout.write(json.dumps(answer))
    sys.stdout.flush()


if __name__ == "__main__":  # pragma: no cover - exercised via subprocess
    sys.exit(_child_main(sys.argv[1:]))
