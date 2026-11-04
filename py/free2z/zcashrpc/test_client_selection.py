"""Contract tests for the runtime wallet-client selector."""

import os
from pathlib import Path
import subprocess
import sys

_REPO_ROOT = Path(__file__).resolve().parents[3]
_UNSET = object()


def _client_process(selector=_UNSET, backend=_UNSET):
    env = os.environ.copy()
    env.pop("ZCASHRPC_CLIENT", None)
    env.pop("ZCASH_BACKEND", None)
    if selector is not _UNSET:
        env["ZCASHRPC_CLIENT"] = selector
    if backend is not _UNSET:
        env["ZCASH_BACKEND"] = backend
    env["PYTHONPATH"] = str(_REPO_ROOT / "py" / "free2z")
    return subprocess.run(
        [
            sys.executable,
            "-c",
            "from zcashrpc.client import Client; print(Client.__module__)",
        ],
        cwd=_REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def test_legacy_client_remains_the_default():
    result = _client_process()
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "zcashrpc.client"


def test_wallet_sqlite_client_is_selected_by_environment():
    result = _client_process("wallet_sqlite")
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "zcashrpc.wallet_sqlite_client"


def test_explicit_selector_takes_precedence_over_the_legacy_backend_switch():
    result = _client_process("legacy", "zallet")
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "zcashrpc.client"


def test_wallet_selector_takes_precedence_over_the_legacy_zallet_switch():
    result = _client_process("wallet_sqlite", "zallet")
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "zcashrpc.wallet_sqlite_client"


def test_the_legacy_zallet_switch_remains_compatible():
    result = _client_process(backend="zallet")
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "zcashrpc.zallet_client"


def test_invalid_and_empty_client_selectors_fail_closed():
    for selector in ("not-a-client", ""):
        result = _client_process(selector)
        assert result.returncode != 0
        assert "invalid ZCASHRPC_CLIENT" in result.stderr
