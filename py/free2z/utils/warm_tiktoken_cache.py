#!/usr/bin/env python3
"""Bake the tiktoken BPE vocabularies into the image, and PROVE they are there.

WHY
-----------
``tiktoken`` downloads a vocabulary the first time it is asked for one, and the
pinned 0.14.0 does it with ``requests.get()`` and **no timeout**
(``tiktoken/load.py``). Nothing in the cluster pre-warmed that cache, so the
first translation on a fresh pod paid for the download -- and in
``dj.apps.g12f.translation.service.translate_unit`` that happens in
``provider_tokens()``, above every deadline the module has:
``REQUEST_TIMEOUT_SECONDS`` and ``DOCUMENT_TIMEOUT_SECONDS`` are both enforced
inside ``_complete()``, which has not been called yet. ``translation`` runs on
the catch-all worker at concurrency 1, sharing the lane with publishing, search,
reclamation and job health -- so one stalled download stops that lane until the
pod restarts, and the thing that would have told us is queued behind it. The
charge reaper refunds the creator; it cannot free the worker.

 made this newly reachable rather than newly broken: it is the first code
in the repo that needs ``o200k_base``, so there is a second vocabulary that no
pod has ever held.

WHAT THIS DOES, AND WHY IT IS TWO PHASES
----------------------------------------
Warming alone is not evidence. ``RUN python -c "get_encoding(...)"`` succeeds
just as happily when it silently downloaded the file into a directory that is
not on the runtime image, or into no cache at all -- ``read_file_cached``
disables caching entirely when ``TIKTOKEN_CACHE_DIR`` is the empty string, and
falls back to ``tempfile.gettempdir()`` when it is unset, which is exactly the
``/tmp`` a runtime image need not carry forward.

So phase two re-runs in a FRESH PROCESS with ``tiktoken.load.read_file``
replaced by a function that raises. In-process would prove nothing:
``tiktoken.get_encoding`` memoises, so the second lookup never reaches the
loader at all. With the loader poisoned, resolving an encoding can only succeed
by reading the on-disk cache -- which is the actual claim, stated as a test that
can fail.

Run at image build time; see ``docker/py3base/Dockerfile``. Exit non-zero fails
the build, which is the point: an image without these vocabularies must not
exist, because the failure it causes is invisible until it wedges a queue.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import urllib.parse

#Every encoding the deployed code can ask for.
#
#``cl100k_base`` is what ``openai.models._get_encoding`` falls back to for
#every model tiktoken has no mapping for -- Anthropic, xAI, Kimi -- and is the
#encoding ``count_tokens`` uses for chunk planning and pricing.
#
#``o200k_base`` is not just gpt-4o. Every OpenAI row in ``seed_ai_models``
#maps to it: ``gpt-4o``, ``gpt-5.6-sol``, ``gpt-5.6-terra``, ``gpt-5.6-luna``.
#
#``dj/apps/openai/test_tiktoken_vocabularies.py`` fails if a seeded model ever
#maps to an encoding that is not in this tuple, so adding a model to the
#catalogue cannot silently reintroduce a cold download.
REQUIRED_ENCODINGS = ("cl100k_base", "o200k_base")

#Wall clock for each phase, seconds. Override with TIKTOKEN_WARM_TIMEOUT_SECONDS.
#
#The download this bounds is the SAME untimed `requests.get()` that motivated
#the whole change -- moving it from a worker to a build does not give it a
#deadline, it just moves what it can block. A server that accepts the
#connection and then stops sending raises nothing, so an unbounded RUN would
#hold `py3base` -- and therefore migrations and the deploy behind it -- until
#`cloudbuild.yaml`'s 18,000-second build timeout expired. Production keeps
#running, but an urgent fix cannot ship through that build, which is a bad way
#to find out.
#
#300s is ~60x what the two files (about 5 MB together) need, and 1/60th of the
#build timeout, so it fails as a clear error long before it fails as a mystery.
#Bounded by running each phase as a CHILD PROCESS: unlike a thread, a stalled
#download can actually be killed. (codex adversarial review.)
DEFAULT_PHASE_TIMEOUT_SECONDS = 300.0

#Text with a non-ASCII, non-Latin run in it. Resolving an encoding proves the
#vocabulary loaded; encoding something that actually exercises the merge table
#proves it loaded intact rather than as a truncated file that happened to
#parse.
PROBE = "probe 漢字 العربية हिन्दी 123"


#The host tiktoken fetches vocabularies from, for the refusal message when we
#have no captured URL to quote (a killed child cannot report one). The real URL
#is recorded per attempt by:func:`_record_downloads` whenever there is one.
VOCAB_HOST = "openaipublic.blob.core.windows.net"


class Unwarmed(RuntimeError):
    """The cache is not usable without the network. The build must fail.

    ``reported`` marks the ones:func:`refuse` has already printed in full, so
    the terse handler in:func:`main` does not repeat the error underneath a
    banner that already contains it. A build log people only read during an
    incident should not make them decide which of two copies to trust.
    """

    reported = False


#THERE IS NO CONFIDENT "this was the network" PREAMBLE, and that is the
#conclusion of three review rounds rather than an omission. Every signal
#available here is compatible with a local fault: entering tiktoken's loader
#does not mean a socket opened, and the `downloading...` stage is written
#BEFORE the call, so even a hang there can be a proxy misconfiguration failing
#to establish a connection. We can say where the failure happened. We cannot
#say it was not us. (codex adversarial review, rounds 3 and 4.)
#Said when the failure came out of the download step but we cannot prove a
#socket ever opened. Entering tiktoken's loader is NOT evidence that the host
#was contacted: a missing CA bundle, a bad proxy URL or a TLS misconfiguration
#all raise inside requests before it connects, and every one of them fails
#identically on retry. So the claim is hedged to what is actually known, and
#the local alternative is named rather than left for the operator to discover
#after three build cycles. (codex adversarial review, round 3.)
DOWNLOAD_PREAMBLE = """\
The failure came out of the download step. MOST LIKELY the transfer itself failed,
in which case nothing in this commit caused it and a retry is the right move --
but a local TLS, CA-bundle or proxy misconfiguration raises in the same place
without ever contacting the host, and that kind fails identically every retry.
The error below is what distinguishes them. py3base bakes these files in so a
production worker never downloads one at runtime (#1918)."""

#Said when a phase was KILLED and its last reported stage was not a transfer.
#A timeout tells us how long something took and nothing whatsoever about what
#it was doing, so the honest answer is that we do not know -- and the stage the
#child managed to report is the only evidence there is. Asserting a network
#stall from elapsed time alone is the same error as asserting the commit is
#innocent from a caught exception. (codex adversarial review.)
UNKNOWN_PREAMBLE = """\
THE CAUSE IS NOT ESTABLISHED. A phase was killed for running too long, which says
how long it took and nothing about what it was doing. The last stage it managed
to report is below -- treat it as the only evidence, not as a conclusion. Warming
also imports dependencies, reads cache files, parses 5MB of vocabulary and
encodes a probe; any of those can stall without a byte crossing the network."""

#Said when no download was attempted, or one finished and something local then
#failed. Retrying is NOT the first move here, and saying so matters more than
#sounding reassuring.
LOCAL_PREAMBLE = """\
This is a LOCAL failure, not a network one, and RETRYING WILL PROBABLY NOT HELP.
Either no download was attempted or one completed and something on this builder
failed afterwards -- a bad encoding name, a dependency regression, a full or
read-only filesystem, or a checksum mismatch. Read the error below before
retrying: unlike an outage, this will fail again identically."""


def refuse(headline, preamble=UNKNOWN_PREAMBLE, facts=(), guidance=()) -> None:
    """Print a blocked-build refusal that says what to DO about it.

    Modelled on ``bin/deploy-fence.sh``, where every refusal names its escape
    hatch, because a build that stops at 3am with no route forward is its own
    incident. The operator reading this is not necessarily the person who
    touched translation -- most likely they touched nothing to do with it and
    just want their release out -- so the first thing said is that this is not
    a code fault, and the second is what to try.
    """
    width = 74
    lines = ["=" * width, f"tiktoken-cache: BUILD BLOCKED -- {headline}", "=" * width]
    lines.append(preamble.strip("\n"))
    if facts:
        lines.append("")
        label_width = max(len(label) for label, _ in facts)
        for label, value in facts:
            lines.append(f"  {label.ljust(label_width)} : {value}")
    lines.append("")
    lines.append("WHAT TO DO")
    for index, step in enumerate(guidance, 1):
        lines.append(f"  {index}. {step}")
    lines.append("")
    lines.extend([
        "THERE IS NO OVERRIDE, AND THAT IS DELIBERATE.",
        "  The only thing an override could do is ship an image with an empty",
        "  cache -- which is precisely the fault this step exists to prevent, and",
        "  it would surface as a wedged concurrency-1 worker lane in production",
        "  instead of as a red build. If the vocabulary host is unreachable from",
        "  this builder, translations on the new pods could not have worked",
        "  anyway. So the release waits. A red build leaves the last good image",
        "  serving; a bad image does not.",
        "=" * width,
    ])
    print("\n".join(lines), file=sys.stderr, flush=True)


#Where the child writes what it is currently doing, so a parent that has to
#KILL it can report a fact instead of a guess. Set by:func:`_run_phase`.
PROGRESS_ENV = "TIKTOKEN_WARM_PROGRESS_FILE"

#Progress markers live in the CACHE DIRECTORY, not in a temp directory.
#
#`tempfile.gettempdir()` discovers a writable directory by creating and writing
#a file in each candidate, which is filesystem I/O in the PARENT, before the
#subprocess timeout that protects the build has started. Catching its
#exceptions does not help with an operation that simply never returns. The
#cache directory has none of those problems: it is a path we already require,
#already validate, and are about to write 5MB of vocabulary into, so it adds no
#new storage dependency and nothing to probe. (codex adversarial review,
#round 5.)
#
#Accepted residual: reading the marker after a kill can still block if that
#filesystem hangs. At that point the cache directory itself is hung and the
#build is already lost for much larger reasons -- pip, the layer write and the
#vocabularies all use it.
PROGRESS_PREFIX = ".warm-progress"


def _stage(text) -> None:
    """Record the child's current operation, for the parent to read after a kill.

    Rewritten in full each time and flushed immediately: the parent only ever
    reads it after the child is dead, so the last complete write is what matters
    and there is no interleaving to worry about. Silent on any error -- progress
    reporting must never be the thing that fails a build.
    """
    path = os.environ.get(PROGRESS_ENV)
    if not path:
        return
    try:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
    except Exception:
        pass


def _last_stage(path) -> str:
    """What the child last said it was doing, or "" if it never got to say.

    Takes the path explicitly: the parent puts ``PROGRESS_ENV`` in the CHILD's
    environment only, so reading it out of ``os.environ`` here would always
    find nothing and silently turn every stage report into "none reported".
    """
    if not path:
        return ""
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read().strip()
    except Exception:
        return ""


class _DownloadLog:
    """What tiktoken's network read actually did, for the failing encoding.

    Three states have to be told apart, because the advice differs completely
    and getting it wrong sends an operator to the wrong system:

    * ``attempted`` false -- no download was even started, so the fault is local
      or in the code: an encoding name nothing recognises, a dependency
      regression, a cache hit followed by a failure to use it.
    * ``attempted`` true, ``completed`` false -- the transfer did not finish.
      This, and only this, is the upstream/egress case.
    * ``completed`` true -- the bytes arrived and something after that failed:
      writing them (disk full, read-only), the sha256 check, or encoding the
      probe. Retrying reruns the same download to the same end.
    """

    def __init__(self):
        self.reset()

    def reset(self):
        self.url = None
        self.attempted = False
        self.completed = False


_DOWNLOADS = _DownloadLog()


def _record_downloads():
    """Wrap tiktoken's network read so a failure can say what it was doing.

    tiktoken raises from inside its own loader and the exception does not always
    carry the URL, but "which host was unreachable" is the one fact that tells
    an operator whether this is an upstream outage or our own egress -- and
    "was a download attempted at all" is what stops us blaming the network for a
    local fault. Wrapping is how both are obtained without parsing an exception
    string.
    """
    import tiktoken.load

    original = getattr(tiktoken.load, "read_file", None)
    if original is None:
        return
    def recording(blobpath, *args, **kwargs):
        _DOWNLOADS.url = blobpath
        _DOWNLOADS.attempted = True
        _stage(f"downloading {blobpath}")
        data = original(blobpath, *args, **kwargs)
        _DOWNLOADS.completed = True
        _stage(f"downloaded {blobpath}; storing and parsing it")
        return data
    tiktoken.load.read_file = recording


def _looks_local(exc) -> bool:
    """True when the exception names something that is definitely on this box.

    Deliberately narrow and evidence-based. Anything not matched here is left
    UNESTABLISHED rather than asserted either way -- a wrong confident answer
    costs more than an honest "read the error".
    """
    if isinstance(exc, (ValueError, ImportError, MemoryError)):
        return True
    text = f"{type(exc).__name__}: {exc}".lower()
    local_markers = (
        # TLS / CA material that is missing or unreadable ON THIS BOX. requests
        # raises these before it opens a socket, so they are not network faults
        # however much they look like one.
        "ca bundle", "ca certificate", "certificate bundle", "cafile",
        "ca_certs", "certificate verify location", "invalid path",
        # Filesystem.
        "no such file", "errno 2", "errno 13", "permission denied",
        "no space left", "errno 28", "read-only file system", "errno 30",
        # Proxy and URL configuration.
        "invalid url", "proxyschemaunknown", "unsupported proxy",
        "invalid proxy",
    )
    return any(marker in text for marker in local_markers)


def _diagnose(exc) -> str:
    """One line on whether this looks like our network or theirs."""
    text = f"{type(exc).__name__}: {exc}".lower()
    if "name" in text and "resol" in text:
        return (
            "the host did not RESOLVE, which points at this builder's DNS or "
            "egress rather than an upstream outage"
        )
    if "timed out" in text or "timeout" in text:
        return (
            "the connection was accepted or attempted and then stalled -- "
            "consistent with an upstream problem, or with egress filtering "
            "that blackholes rather than rejects"
        )
    if "connection" in text or "refused" in text or "unreachable" in text:
        return "the connection failed outright; check egress from the builder"
    if "hash" in text:
        return (
            "the file downloaded but did not match the sha256 tiktoken pins "
            "for it -- a corrupted or substituted object, NOT a network fault"
        )
    return "cause not classified; read the error above"


def cache_dir() -> str:
    """The cache directory, validated. Raises if it cannot hold a vocabulary.

    Both bad values are silent rather than loud in tiktoken, which is why they
    are checked here and not left to it: unset falls back to a temp directory
    (so the vocabulary lands somewhere the runtime image need not have), and the
    empty string disables caching outright (so every lookup downloads, forever).
    """
    if "TIKTOKEN_CACHE_DIR" not in os.environ:
        raise Unwarmed(
            "TIKTOKEN_CACHE_DIR is not set. tiktoken would cache into "
            "tempfile.gettempdir(), which is not a path the runtime image is "
            "guaranteed to carry -- set it explicitly in the Dockerfile."
        )
    value = os.environ["TIKTOKEN_CACHE_DIR"]
    if not value.strip():
        raise Unwarmed(
            "TIKTOKEN_CACHE_DIR is empty, which tiktoken reads as 'caching "
            "disabled' -- every lookup would download the vocabulary again."
        )
    return value


#Advice that is true whichever way the warming failed.
_CACHE_HIT_NOTE = (
    "A release that does not change py/requirements/main.txt "
    "normally REUSES\n     the cached py3base layer and never "
    "runs this step at all -- so an urgent\n     hotfix is "
    "often not blocked by this. Look for a cache hit on the\n"
    "     py3base step before assuming you are stuck."
)


def _refuse_warm_failure(name, exc) -> None:
    """Report a warming failure and raise. Never returns.

    Branches on what:class:`_DownloadLog` observed rather than on the exception
    text, because whether a transfer was attempted is a fact and the advice that
    follows from it is completely different. Telling an operator "not a code
    fault, retry" about a deterministic local failure costs them a build cycle
    per retry on a release that is already blocked. (codex adversarial review.)
    """
    url = _DOWNLOADS.url or f"https://{VOCAB_HOST}/encodings/{name}.tiktoken"
    host = urllib.parse.urlsplit(url).netloc or VOCAB_HOST
    # "Inside the download step" is what `attempted` establishes. It does NOT
    # establish that a connection was made, so an exception that names something
    # local overrides it. (codex adversarial review, round 3.)
    downloading = (
        _DOWNLOADS.attempted
        and not _DOWNLOADS.completed
        and not _looks_local(exc)
    )

    facts = [("encoding", name), ("error", f"{type(exc).__name__}: {exc}")]
    if _DOWNLOADS.attempted:
        facts.insert(1, ("url", url))
        facts.insert(2, ("host", host))
    facts.append((
        "stage",
        "inside the download step; the transfer did not complete" if downloading
        else "the transfer completed; the failure is after it"
        if _DOWNLOADS.completed
        else "no download was attempted",
    ))
    facts.append(("looks like", _diagnose(exc)))

    if downloading:
        guidance = (
            "RETRY THE BUILD ONCE. A blob fetch failing once is transient far "
            "more often\n     than not -- and if it fails again identically, "
            "stop retrying and read the\n     error: that is the signature of "
            "a local TLS/CA/proxy fault, not an outage.",
            f"Check whether {host} is reachable AT ALL, and from somewhere "
            "else:\n"
            f"       curl -sSI {url}"
            "\n     If it answers elsewhere but not here, the fault is this "
            "builder's\n     egress, not an upstream outage.",
            _CACHE_HIT_NOTE,
            "If the outage is prolonged, the standing fix is to stop depending "
            "on\n     that host at build time. See #1923.",
        )
    else:
        guidance = (
            "READ THE ERROR ABOVE FIRST. This will fail again identically, so "
            "a retry\n     costs a build cycle and tells you nothing new.",
            "If the encoding name is not one tiktoken knows, the fault is in "
            "REQUIRED_ENCODINGS\n     in this file -- check it against "
            "tiktoken.list_encoding_names().",
            "If it is a filesystem error, the builder is out of space or the "
            "cache path is\n     not writable. If it is a checksum mismatch, "
            "the object served did not match the\n     sha256 tiktoken pins "
            "for it -- that is a corrupted or substituted file, and\n     "
            "retrying is the wrong response.",
            "If it is neither, suspect a dependency change: a tiktoken bump can "
            "move or\n     rename an encoding. py/requirements/main.txt pins "
            "it, so check what moved.",
        )

    refuse(
        f"could not {'download' if downloading else 'prepare'} the {name} "
        "vocabulary",
        preamble=DOWNLOAD_PREAMBLE if downloading else LOCAL_PREAMBLE,
        facts=tuple(facts),
        guidance=guidance,
    )
    already = Unwarmed(f"could not obtain the {name} vocabulary")
    already.reported = True
    raise already from exc


def warm(names=REQUIRED_ENCODINGS) -> None:
    """Download each vocabulary into the cache. Fails the build if it cannot."""
    _stage("importing tiktoken")
    import tiktoken

    target = cache_dir()
    os.makedirs(target, exist_ok=True)
    _record_downloads()
    for name in names:
        _DOWNLOADS.reset()
        try:
            _stage(f"resolving {name} (no transfer started yet)")
            encoding = tiktoken.get_encoding(name)
            _stage(f"encoding the probe with {name}")
            encoding.encode(PROBE)
        except Exception as exc:
            _refuse_warm_failure(name, exc)
        print(f"warmed {name}", flush=True)

    _stage("checking that the cache directory was populated")
    # Progress markers live here too (see PROGRESS_PREFIX), and they are written
    # by this process -- so counting them would let the check pass on a directory
    # holding nothing but our own telemetry.
    stored = [
        entry for entry in os.listdir(target)
        if not entry.startswith(PROGRESS_PREFIX)
    ]
    if not stored:
        # get_encoding succeeded and wrote nothing: the vocabulary came from
        # somewhere that is not this directory, so the image will not have it.
        raise Unwarmed(
            f"{target} is empty after warming {len(names)} encoding(s) -- "
            "the vocabularies were not cached where they were asked to be"
        )


def verify(names=REQUIRED_ENCODINGS) -> None:  # noqa: C901
    """Resolve each vocabulary with the network loader poisoned.

    Must run in a process that has not already resolved them;:func:`main`
    re-executes this module to guarantee that.
    """
    import tiktoken
    import tiktoken.load

    cache_dir()

    if not hasattr(tiktoken.load, "read_file"):
        # The function this poisons is the only network path into the loader.
        # If a tiktoken upgrade renames it, this check silently stops proving
        # anything -- so make that a build failure rather than a quiet pass.
        raise Unwarmed(
            "tiktoken.load.read_file is gone; this verification no longer "
            "proves the cache is being used. Re-check tiktoken's loader."
        )

    def refuse(blobpath, *args, **kwargs):
        raise Unwarmed(
            f"tiktoken tried to download {blobpath} -- the cache is cold"
        )

    tiktoken.load.read_file = refuse

    for name in names:
        try:
            encoding = tiktoken.get_encoding(name)
            encoding.encode(PROBE)
        except Unwarmed:
            raise
        except Exception as exc:
            raise Unwarmed(
                f"{name} is not usable from the cache: "
                f"{type(exc).__name__}: {exc}"
            ) from exc
        print(f"verified {name} resolves with no network access", flush=True)


def phase_timeout() -> float:
    raw = os.environ.get("TIKTOKEN_WARM_TIMEOUT_SECONDS", "")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_PHASE_TIMEOUT_SECONDS
    return value if value > 0 else DEFAULT_PHASE_TIMEOUT_SECONDS


def _run_phase(flag: str) -> int:
    """Run one phase in a child process, bounded by:func:`phase_timeout`.

    A child rather than a call, for two independent reasons. Verification MUST
    be a fresh interpreter, because `tiktoken.get_encoding` memoises and an
    in-process re-check would never reach the loader it poisons. And warming
    must be KILLABLE, because the download it performs has no timeout of its
    own and a thread could not be cancelled.
    """
    limit = phase_timeout()
    environment = dict(os.environ)
    # Telemetry must never be a PREREQUISITE, which is why every step of setting
    # it up is inside this try. (codex adversarial review, round 4.)
    try:
        target = cache_dir()
        os.makedirs(target, exist_ok=True)
        progress = os.path.join(
            target, f"{PROGRESS_PREFIX}.{flag.lstrip('-')}"
        )
        environment[PROGRESS_ENV] = progress
    except Exception:
        # Telemetry is never a prerequisite: losing the stage report costs a
        # worse error message, raising here costs the build.
        progress = ""
        environment.pop(PROGRESS_ENV, None)
    def discard_marker():
        """The marker is scaffolding, not an artefact -- it must not ship."""
        if not progress:
            return
        try:
            os.unlink(progress)
        except OSError:
            pass

    try:
        completed = subprocess.run(
            [sys.executable, os.path.abspath(__file__), flag],
            check=False,
            timeout=limit,
            env=environment,
        )
        discard_marker()
    except subprocess.TimeoutExpired:
        # WHICH PHASE MATTERS. Only `--warm-only` touches the network;
        # `--verify-only` runs with tiktoken's loader replaced by a function that
        # raises, so it cannot download anything at all. A verification timeout
        # is slow storage, CPU contention, or too small an override -- and
        # sending the operator to check Azure connectivity about it wastes the
        # one thing they are short of. Elapsed time alone never establishes a
        # network stall. (codex adversarial review.)
        # The child reports what it was doing; the parent does not guess. Only
        # a stage that says a transfer was in flight justifies pointing at the
        # network -- warming also imports, reads the cache, parses 5MB of
        # vocabulary and encodes a probe, and any of those can stall without a
        # byte crossing the wire. (codex adversarial review, round 2.)
        stage = _last_stage(progress)
        discard_marker()
        if flag == "--warm-only":
            mid_transfer = stage.startswith("downloading ")
            refuse(
                f"the download phase exceeded {limit:g}s and was killed",
                preamble=DOWNLOAD_PREAMBLE if mid_transfer else UNKNOWN_PREAMBLE,
                facts=(
                    ("phase", "download (--warm-only)"),
                    ("last stage", stage or
                     "none reported -- the child was killed before it said"),
                    ("timeout", f"{limit:g}s (TIKTOKEN_WARM_TIMEOUT_SECONDS)"),
                    ("host", VOCAB_HOST),
                    ("looks like",
                     "a stall inside the download step. tiktoken's own download "
                     "has no timeout, so this bound is the only thing that "
                     "ended it -- but the stage is recorded BEFORE the call, so "
                     "a proxy that never establishes a connection stalls here "
                     "identically" if mid_transfer else
                     "NOT established. The stage above is what it was doing; "
                     "it is not a transfer, so do not start with the network"),
                ),
                guidance=(
                    "RETRY THE BUILD once. That distinguishes a transient stall "
                    "from a\n     reproducible one, and costs one build.",
                    (f"Only if the stage above shows a transfer: check whether "
                     f"{VOCAB_HOST}\n     is serving, from somewhere other "
                     "than this builder. A stall rather than\n     a refusal "
                     "is also what egress filtering looks like."),
                    "If the stage shows importing, parsing or probing, this is "
                    "a BUILDER\n     resource problem -- CPU or I/O "
                    "starvation -- not an outage. Nothing\n     upstream will "
                    "explain it.",
                    "If the network here is genuinely this slow, raise "
                    "TIKTOKEN_WARM_TIMEOUT_SECONDS\n     rather than removing "
                    "the bound -- without it this build would have held\n"
                    "     until Cloud Build's own 18,000s timeout, blocking "
                    "every release behind it.",
                    _CACHE_HIT_NOTE,
                ),
            )
            return 1

        refuse(
            f"the offline verification exceeded {limit:g}s and was killed",
            preamble="""\
This phase does NO NETWORK I/O -- it re-reads the cached vocabularies with
tiktoken's downloader replaced by a function that raises, to prove the image can
load them offline (#1918). So this is NOT a connectivity problem and there is
nothing upstream to check.""",
            facts=(
                ("phase", "offline verification (--verify-only)"),
                ("last stage", stage or
                 "none reported -- the child was killed before it said"),
                ("timeout", f"{limit:g}s (TIKTOKEN_WARM_TIMEOUT_SECONDS)"),
                ("network", "not used by this phase"),
                ("looks like", "slow or contended storage, a starved CPU, or a "
                               "TIKTOKEN_WARM_TIMEOUT_SECONDS override that is "
                               "too small for this builder"),
            ),
            guidance=(
                "RETRY THE BUILD -- but if it recurs, this is a builder "
                "resource problem, not\n     an outage. Reading and parsing "
                "5MB of vocabulary should take a second.",
                "If TIKTOKEN_WARM_TIMEOUT_SECONDS was overridden downward, that "
                "is the first\n     thing to undo.",
                "Do NOT go looking at vocabulary-host status for this one; the "
                "download phase\n     already succeeded, which is why "
                "verification ran at all.",
                _CACHE_HIT_NOTE,
            ),
        )
        return 1
    return completed.returncode


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--verify-only", action="store_true",
        help="skip warming; only prove the cache is usable offline",
    )
    parser.add_argument(
        "--warm-only", action="store_true",
        help="download the vocabularies; do not verify them offline",
    )
    args = parser.parse_args(argv)

    if args.verify_only or args.warm_only:
        try:
            verify() if args.verify_only else warm()
        except Unwarmed as exc:
            if not exc.reported:
                print(f"tiktoken cache: {exc}", file=sys.stderr)
            return 1
        return 0

    # Fail fast and with a usable message on a misconfigured cache directory,
    # rather than paying a timeout to discover it in a child.
    try:
        cache_dir()
    except Unwarmed as exc:
        print(f"tiktoken cache: {exc}", file=sys.stderr)
        return 1

    status = _run_phase("--warm-only")
    if status != 0:
        return status

    # Flushed so the build log reads in the order things happened: the children
    # write to the same fd, and an unflushed parent buffer would interleave.
    sys.stdout.flush()

    status = _run_phase("--verify-only")
    if status != 0:
        print(
            "tiktoken cache: warming reported success but the vocabularies "
            "are not readable without the network -- refusing to build an "
            "image that would download them at runtime (#1918)",
            file=sys.stderr,
        )
    return status


if __name__ == "__main__":
    raise SystemExit(main())
