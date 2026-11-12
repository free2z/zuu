#!/usr/bin/env python3
"""Seed the image's tiktoken cache from verified files and prove offline loading.

Each phase runs in a fresh, time-bounded process. The second phase poisons
 tiktoken's file reader: a successful lookup must come from the on-disk cache,
not the in-process encoding memo or the network. See build/free2z/README.md.
"""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile

# URLs and SHA-256 values are pinned by tiktoken 0.14.0's openai_public.py.
VOCABULARIES = {
    "cl100k_base": ("https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken",
                    "223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7"),
    "o200k_base": ("https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken",
                   "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d"),
}
REQUIRED_ENCODINGS = tuple(VOCABULARIES)
PROBE = "probe 漢字 العربية हिन्दी 123"
DEFAULT_PHASE_TIMEOUT_SECONDS = 300.0


class Unwarmed(RuntimeError):
    """The image cannot safely load its required encodings offline."""


def cache_dir() -> Path:
    value = os.environ.get("TIKTOKEN_CACHE_DIR", "")
    if not value.strip():
        raise Unwarmed("TIKTOKEN_CACHE_DIR must be set and nonempty")
    return Path(value)


def _checked_bytes(path: Path, expected_hash: str) -> bytes:
    data = path.read_bytes()
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected_hash:
        raise Unwarmed(f"INTEGRITY ERROR: {path}: expected sha256 {expected_hash}, got {actual}")
    return data


def warm() -> None:
    import tiktoken
    import tiktoken.load

    source = os.environ.get("TIKTOKEN_VOCAB_DIR", "")
    if not source.strip():
        raise Unwarmed("TIKTOKEN_VOCAB_DIR must point to the vendored vocabulary files")
    target = cache_dir()
    target.mkdir(parents=True, exist_ok=True)
    original = tiktoken.load.read_file_cached
    # Do not allow tiktoken to silently replace a corrupt cache entry by fetching.
    def seed(blobpath, expected_hash=None):
        if blobpath != url or expected_hash != digest:
            raise Unwarmed(f"tiktoken definition drift for {name}: {blobpath}, sha256 {expected_hash}")
        data = _checked_bytes(Path(source) / f"{name}.tiktoken", digest)
        path = target / hashlib.sha1(url.encode()).hexdigest()
        if path.exists():
            _checked_bytes(path, digest)
        else:
            with tempfile.NamedTemporaryFile(dir=target, delete=False) as handle:
                temporary = handle.name
                try:
                    handle.write(data)
                except BaseException:
                    os.unlink(temporary)
                    raise
            try:
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        observed.append(blobpath)
        return original(blobpath, expected_hash)

    def refuse(blobpath):
        raise Unwarmed(f"unexpected file or network read while warming: {blobpath}")

    tiktoken.load.read_file_cached = seed
    tiktoken.load.read_file = refuse
    for name, (url, digest) in VOCABULARIES.items():
        observed = []
        tiktoken.get_encoding(name).encode(PROBE)
        if observed != [url]:
            raise Unwarmed(f"tiktoken did not load the expected vocabulary for {name}")
        print(f"warmed {name} from verified local data", flush=True)


def verify() -> None:
    import tiktoken
    import tiktoken.load

    cache_dir()
    if not hasattr(tiktoken.load, "read_file"):
        raise Unwarmed("tiktoken.load.read_file is gone; re-check the offline proof")
    def refuse(blobpath):
        raise Unwarmed(f"tiktoken tried to read {blobpath}; the cache is cold or corrupt")
    tiktoken.load.read_file = refuse
    for name in REQUIRED_ENCODINGS:
        tiktoken.get_encoding(name).encode(PROBE)
        print(f"verified {name} resolves with no network access", flush=True)


def phase_timeout() -> float:
    try:
        value = float(os.environ.get("TIKTOKEN_WARM_TIMEOUT_SECONDS", ""))
        return value if 0 < value < float("inf") else DEFAULT_PHASE_TIMEOUT_SECONDS
    except ValueError:
        return DEFAULT_PHASE_TIMEOUT_SECONDS


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--verify-only", action="store_true")
    group.add_argument("--warm-only", action="store_true")
    args = parser.parse_args(argv)
    if args.verify_only or args.warm_only:
        try:
            verify() if args.verify_only else warm()
        except Exception as exc:
            print(f"tiktoken cache: {type(exc).__name__}: {exc}", file=sys.stderr)
            return 1
        return 0
    for flag in ("--warm-only", "--verify-only"):
        try:
            result = subprocess.run([sys.executable, os.path.abspath(__file__), flag],
                                    timeout=phase_timeout(), check=False)
        except subprocess.TimeoutExpired:
            print(f"tiktoken cache: {flag} exceeded {phase_timeout():g}s", file=sys.stderr)
            return 1
        if result.returncode:
            return result.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
