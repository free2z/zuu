"""Observe the credit wallet's chain tip separately from credit activity.

The credit loop can complete successfully while its lightwalletd provider keeps
returning the same old tip.  This module compares the wallet database's tip
with a separate ``GetLatestBlock`` request to that same configured provider and
keeps the observation baseline on disk.  It is deliberately read-only and
advisory: a failed observation must not change whether the credit commands run.
"""

import argparse
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path


WALLET_TIP_OK_SIGNAL = "credit-loop: wallet tip ok"
WALLET_TIP_STALE_SIGNAL = "credit-loop: WALLET TIP STALE"
WALLET_TIP_BEHIND_SIGNAL = "credit-loop: WALLET TIP BEHIND"
WALLET_TIP_PROVIDER_ERROR_SIGNAL = "credit-loop: WALLET TIP PROVIDER ERROR"
WALLET_TIP_WALLET_ERROR_SIGNAL = "credit-loop: WALLET TIP WALLET ERROR"
WALLET_TIP_STATE_ERROR_SIGNAL = "credit-loop: WALLET TIP STATE ERROR"
WALLET_TIP_REORG_LINE = "credit-loop: wallet tip reorg"
WALLET_TIP_RECOVERED_LINE = "credit-loop: wallet tip recovered"

GET_LATEST_BLOCK = (
    "cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock"
)
GET_LATEST_BLOCK_REQUEST = "{}"
HEIGHT_RE = re.compile(r"^[0-9]+$")

DEFAULT_STATE = "/var/lib/free2z/wallet-tip/wallet-tip.json"
DEFAULT_GRPCURL = "grpcurl"
DEFAULT_TARGET = "zec.rocks:443"
DEFAULT_STALE_SECONDS = 1200
DEFAULT_BEHIND_BLOCKS = 40
DEFAULT_GRPC_TIMEOUT = 15
DEFAULT_WALLET_TIMEOUT = 5
DEFAULT_OUTER_TIMEOUT = 30
OBSERVER_CLEANUP_MARGIN = 5


def parse_height(value):
    """Return a non-negative integer from grpcurl's uint64 JSON value.

    grpcurl renders protobuf ``uint64`` values as JSON strings by default, but
    test doubles and alternate formatters may use JSON numbers.  Floats,
    booleans, signs and decimal text are rejected rather than turning units or
    malformed provider data into a plausible height.
    """
    if isinstance(value, bool):
        raise ValueError("height must be an integer, not a boolean")
    if isinstance(value, int):
        height = value
    elif isinstance(value, str) and HEIGHT_RE.fullmatch(value):
        height = int(value)
    else:
        raise ValueError(f"height is not a non-negative integer: {value!r}")
    if height < 0:
        raise ValueError(f"height is negative: {height}")
    return height


def parse_latest_block(payload):
    """Extract the upstream block height from one GetLatestBlock response."""
    try:
        body = json.loads(payload)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid GetLatestBlock JSON: {exc}") from exc
    if not isinstance(body, dict) or "height" not in body:
        raise ValueError("GetLatestBlock response has no height")
    return parse_height(body["height"])


def wallet_height(db_path, timeout=DEFAULT_WALLET_TIMEOUT):
    """Read the highest committed wallet block without modifying SQLite."""
    connection = sqlite3.connect(
        f"file:{db_path}?mode=ro", uri=True, timeout=float(timeout)
    )
    try:
        row = connection.execute("SELECT max(height) FROM blocks").fetchone()
    finally:
        connection.close()
    height = int(row[0]) if row and row[0] is not None else 0
    if height < 0:
        raise ValueError(f"wallet height is negative: {height}")
    return height


def upstream_height(grpcurl=DEFAULT_GRPCURL, target=DEFAULT_TARGET,
                    timeout=DEFAULT_GRPC_TIMEOUT):
    """Query the same provider's latest tip and return its height."""
    argv = [
        grpcurl,
        "-max-time",
        str(int(timeout)),
        "-d",
        GET_LATEST_BLOCK_REQUEST,
        target,
        GET_LATEST_BLOCK,
    ]
    try:
        completed = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=float(timeout),
            check=False,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"{grpcurl} is not installed or not on PATH") from exc
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError(f"could not run {grpcurl}: {exc}") from exc
    if completed.returncode != 0:
        detail = " ".join(
            ((completed.stderr or "") + (completed.stdout or "")).split()
        )[:400]
        raise RuntimeError(
            f"GetLatestBlock from {target} failed"
            f" (exit {completed.returncode}): {detail or 'no output'}"
        )
    return parse_latest_block(completed.stdout)


def read_state(path):
    """Return ``(state, error)`` while distinguishing missing from corrupt."""
    path = Path(path)
    if not path.exists():
        return {}, None
    try:
        state = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        return {}, f"could not read {path}: {exc}"
    if not isinstance(state, dict):
        return {}, f"{path} does not contain a JSON object"
    if state.get("version") != 1:
        return {}, f"{path} has unsupported state version {state.get('version')!r}"
    if not isinstance(state.get("source"), str) or not state["source"]:
        return {}, f"{path} has no provider source"
    for key in ("wallet", "upstream"):
        observation = state.get(key)
        if not isinstance(observation, dict):
            return {}, f"{path} has no {key} observation"
        try:
            parse_height(observation["height"])
            since = float(observation["since"])
            if not math.isfinite(since):
                raise ValueError("since is not finite")
        except (KeyError, TypeError, ValueError) as exc:
            return {}, f"{path} has invalid {key} observation: {exc}"
    progress = state.get("progress")
    if progress is not None:
        if not isinstance(progress, dict):
            return {}, f"{path} has invalid progress observations"
        for key in ("wallet", "upstream"):
            observation = progress.get(key)
            if not isinstance(observation, dict):
                return {}, f"{path} has no {key} progress observation"
            try:
                parse_height(observation["height"])
                since = float(observation["since"])
                if not math.isfinite(since):
                    raise ValueError("since is not finite")
            except (KeyError, TypeError, ValueError) as exc:
                return {}, f"{path} has invalid {key} progress: {exc}"
    if "alerting" in state and not isinstance(state["alerting"], bool):
        return {}, f"{path} has invalid alerting state"
    return state, None


def write_state(state, path):
    """Atomically persist the latest baseline; return an error or ``None``."""
    path = Path(path)
    temporary = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent,
            prefix=f".{path.name}.", delete=False
        ) as handle:
            temporary = Path(handle.name)
            json.dump(state, handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except OSError as exc:
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass
        return f"could not write {path}: {exc}"
    return None


def _age(now, since):
    return max(0, int(float(now) - float(since)))


def evaluate(wallet, upstream, now, previous, source=DEFAULT_TARGET,
             stale_seconds=DEFAULT_STALE_SECONDS,
             behind_blocks=DEFAULT_BEHIND_BLOCKS):
    """Return ``(lines, state)`` from two valid height observations.

    Height decreases are treated as reorgs. The displayed observation clock
    resets, but a separate high-water progress clock is retained so repeated
    reversals cannot keep a stalled provider looking healthy forever. The
    clock uses ``now`` from the observer, never a block header timestamp.
    """
    previous = previous or {}
    if previous.get("source") != source:
        previous = {}

    lines = []
    observations = {}
    progress = {}
    recovered = []
    for key, height in (("wallet", wallet), ("upstream", upstream)):
        old = previous.get(key) or {}
        old_height = old.get("height")
        explicit_progress = (previous.get("progress") or {}).get(key) or {}
        old_progress = explicit_progress
        if not old_progress and old_height is not None:
            old_progress = {"height": int(old_height), "since": old.get("since", now)}
        if old_height is None or int(old_height) != height:
            observations[key] = {"height": height, "since": now}
            if old_height is not None and height < int(old_height):
                lines.append(
                    f"{WALLET_TIP_REORG_LINE} - {key} height fell from "
                    f"{old_height} to {height}; staleness clock reset"
                )
                if explicit_progress:
                    progress[key] = old_progress
                else:
                    progress[key] = {"height": height, "since": now}
            elif old_height is not None:
                recovered.append(key)
                progress[key] = (
                    {"height": height, "since": now}
                    if not old_progress or height > int(old_progress["height"])
                    else old_progress
                )
            else:
                progress[key] = {"height": height, "since": now}
        else:
            observations[key] = {
                "height": height,
                "since": old.get("since", now),
            }
            progress[key] = old_progress or {"height": height, "since": now}

    wallet_age = _age(now, progress["wallet"]["since"])
    upstream_age = _age(now, progress["upstream"]["since"])
    lag = upstream - wallet

    if (upstream_age >= stale_seconds and wallet_age < stale_seconds
            and wallet >= upstream):
        # The wallet has kept advancing and already holds every block this
        # endpoint admits exists, so the frozen answer is the OBSERVER's
        # endpoint (another backend behind the same anycast name, or a
        # mis-paired CREDIT_WALLET_TIP_TARGET), not the sync. Crediting is
        # current; paging the stale tier here would be a false CRITICAL.
        lines.append(
            f"{WALLET_TIP_PROVIDER_ERROR_SIGNAL} - observer endpoint {source} "
            f"height {upstream} unchanged for {upstream_age}s while the "
            f"wallet advanced to {wallet}; tip observation is not "
            f"measuring the sync provider"
        )
    elif upstream_age >= stale_seconds:
        lines.append(
            f"{WALLET_TIP_STALE_SIGNAL} - upstream height {upstream} "
            f"unchanged for {upstream_age}s (threshold {stale_seconds}s)"
        )
    elif wallet_age >= stale_seconds:
        lines.append(
            f"{WALLET_TIP_STALE_SIGNAL} - wallet height {wallet} "
            f"unchanged for {wallet_age}s while upstream height {upstream} "
            f"is ahead (threshold {stale_seconds}s)"
        )

    if lag > behind_blocks:
        lines.append(
            f"{WALLET_TIP_BEHIND_SIGNAL} - wallet height {wallet} is "
            f"{lag} blocks behind upstream height {upstream} "
            f"(threshold {behind_blocks})"
        )

    alerting = any(
        line.startswith((WALLET_TIP_STALE_SIGNAL, WALLET_TIP_BEHIND_SIGNAL))
        for line in lines
    )
    if recovered and previous.get("alerting", False) and not alerting:
        lines.append(
            f"{WALLET_TIP_RECOVERED_LINE} - wallet height {wallet}, "
            f"upstream height {upstream}"
        )
    state = {
        "version": 1,
        "source": source,
        "wallet": observations["wallet"],
        "upstream": observations["upstream"],
        "progress": progress,
        "alerting": alerting,
    }
    lines.append(
        f"{WALLET_TIP_OK_SIGNAL} - wallet height {wallet}, upstream height "
        f"{upstream}, lag {max(0, lag)} blocks"
    )
    return lines, state


def _env_int(name, default):
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if value >= 1 else default


def observer_budgets(outer_timeout, grpc_timeout):
    """Normalize observer deadlines so every inner call has cleanup margin."""
    outer = max(DEFAULT_OUTER_TIMEOUT, int(outer_timeout))
    grpc = int(grpc_timeout)
    if grpc < 1 or grpc + DEFAULT_WALLET_TIMEOUT + OBSERVER_CLEANUP_MARGIN >= outer:
        grpc = DEFAULT_GRPC_TIMEOUT
    wallet = min(
        DEFAULT_WALLET_TIMEOUT,
        max(1, outer - grpc - OBSERVER_CLEANUP_MARGIN),
    )
    return outer, grpc, wallet


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)

    state_path = os.environ.get("CREDIT_WALLET_TIP_STATE", DEFAULT_STATE)
    db_path = os.environ.get("CREDIT_WALLET_TIP_WALLET_DB")
    grpcurl = os.environ.get("CREDIT_WALLET_TIP_GRPCURL", DEFAULT_GRPCURL)
    target = os.environ.get("CREDIT_WALLET_TIP_TARGET", DEFAULT_TARGET)
    stale_seconds = _env_int(
        "CREDIT_WALLET_TIP_STALE_SECONDS", DEFAULT_STALE_SECONDS)
    behind_blocks = _env_int(
        "CREDIT_WALLET_TIP_BEHIND_BLOCKS", DEFAULT_BEHIND_BLOCKS)
    outer_timeout = _env_int("CREDIT_WALLET_TIP_TIMEOUT", DEFAULT_OUTER_TIMEOUT)
    timeout = _env_int("CREDIT_WALLET_TIP_GRPC_TIMEOUT", DEFAULT_GRPC_TIMEOUT)
    # Leave explicit room for the read-only SQLite check and process/shell
    # cleanup inside the outer GNU-timeout budget. The shell validates the same
    # relationship before starting the loop; this keeps direct invocations safe.
    outer_timeout, timeout, wallet_timeout = observer_budgets(
        outer_timeout, timeout
    )
    previous, state_error = read_state(state_path)
    now = int(time.time())

    if state_error:
        print(f"{WALLET_TIP_STATE_ERROR_SIGNAL} - {state_error}")
    if not db_path:
        print(f"{WALLET_TIP_WALLET_ERROR_SIGNAL} - wallet database is not configured")
        return 0

    try:
        wallet = wallet_height(db_path, wallet_timeout)
    except (OSError, sqlite3.Error, ValueError) as exc:
        print(f"{WALLET_TIP_WALLET_ERROR_SIGNAL} - {exc}")
        return 0
    try:
        upstream = upstream_height(grpcurl, target, timeout)
    except (RuntimeError, ValueError) as exc:
        print(f"{WALLET_TIP_PROVIDER_ERROR_SIGNAL} - {exc}")
        return 0

    lines, state = evaluate(
        wallet, upstream, now, previous, target, stale_seconds, behind_blocks
    )
    if not args.dry_run and not state_error:
        state_error = write_state(state, state_path)
        if state_error:
            lines.insert(0, f"{WALLET_TIP_STATE_ERROR_SIGNAL} - {state_error}")
    if state_error and not any(
        line.startswith(WALLET_TIP_STATE_ERROR_SIGNAL) for line in lines
    ):
        lines.insert(0, f"{WALLET_TIP_STATE_ERROR_SIGNAL} - {state_error}")
    if state_error:
        lines = [
            line for line in lines
            if not line.startswith(WALLET_TIP_OK_SIGNAL)
        ]
    for line in lines:
        print(line, flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # pragma: no cover - final subprocess safety net
        print(
            f"{WALLET_TIP_PROVIDER_ERROR_SIGNAL} - observer crashed: {exc}",
            flush=True,
        )
        raise SystemExit(0)
