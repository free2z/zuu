"""Exercise real tiktoken definitions, offline loading, and integrity failures."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys

import pytest

from utils.warm_tiktoken_cache import VOCABULARIES

ROOT = Path(__file__).resolve().parents[5]
SCRIPT = ROOT / "py/free2z/utils/warm_tiktoken_cache.py"
ASSETS = ROOT / "build/free2z/tiktoken-vocab"


def run(cache, assets=ASSETS, *args):
    env = dict(os.environ, TIKTOKEN_CACHE_DIR=str(cache), TIKTOKEN_VOCAB_DIR=str(assets))
    return subprocess.run([sys.executable, str(SCRIPT), *args], env=env,
                          capture_output=True, text=True, timeout=30)


def test_seed_and_fresh_process_offline_proof(tmp_path):
    result = run(tmp_path / "cache")
    assert result.returncode == 0, result.stderr
    assert "verified cl100k_base" in result.stdout
    assert "verified o200k_base" in result.stdout
    assert run(tmp_path / "empty", ASSETS, "--verify-only").returncode != 0


@pytest.mark.parametrize("name", VOCABULARIES)
def test_corrupt_asset_fails_as_integrity_error(tmp_path, name):
    assets = tmp_path / "assets"
    assets.mkdir()
    for item in VOCABULARIES:
        (assets / f"{item}.tiktoken").write_bytes(
            b"corrupt" if item == name else (ASSETS / f"{item}.tiktoken").read_bytes()
        )
    result = run(tmp_path / "cache", assets)
    assert result.returncode != 0
    assert "INTEGRITY ERROR" in result.stderr


def test_corrupt_existing_cache_is_not_replaced(tmp_path):
    cache = tmp_path / "cache"
    assert run(cache).returncode == 0
    url, _ = VOCABULARIES["cl100k_base"]
    path = cache / hashlib.sha1(url.encode()).hexdigest()
    path.write_bytes(b"corrupt")
    result = run(cache)
    assert result.returncode != 0
    assert "INTEGRITY ERROR" in result.stderr
    assert path.read_bytes() == b"corrupt"


@pytest.mark.parametrize("changed_field", ["url", "hash"])
def test_installed_definition_drift_is_refused(tmp_path, changed_field):
    # Exercise the real constructor and warmer in a fresh interpreter, changing
    # only what that constructor passes to tiktoken's BPE loader.
    code = """
import sys
import tiktoken_ext.openai_public as definitions
from utils import warm_tiktoken_cache

original = definitions.load_tiktoken_bpe

def changed(url, expected_hash=None):
    if sys.argv[1] == 'url':
        url += '.changed'
    else:
        expected_hash = '0' * 64
    return original(url, expected_hash=expected_hash)

definitions.load_tiktoken_bpe = changed
warm_tiktoken_cache.warm()
"""
    cache = tmp_path / "cache"
    env = dict(os.environ, TIKTOKEN_CACHE_DIR=str(cache), TIKTOKEN_VOCAB_DIR=str(ASSETS))
    result = subprocess.run([sys.executable, "-c", code, changed_field], env=env,
                            capture_output=True, text=True, timeout=30)
    assert result.returncode != 0
    assert "tiktoken definition drift for cl100k_base" in result.stderr
    assert list(cache.iterdir()) == []
