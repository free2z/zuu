"""Write and validate the host wallet-sync freshness marker.

The standalone wallet-sync unit runs as root so the marker is owned by root
and cannot be forged by the credit-loop account. The wallet read and provider
tip observation are read-only; a marker is written only after a successful
wallet sync.
"""

import argparse
import json
import os
import re
import sqlite3
import stat
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from .wallet_tip import parse_height, upstream_height, wallet_height


UTC_STAMP = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")


def machine_id(path="/etc/machine-id"):
    value = Path(path).read_text(encoding="ascii").strip()
    if not re.fullmatch(r"[0-9a-f]{32}", value):
        raise ValueError("host machine-id is missing or malformed")
    return value


def write_marker(path, wallet_db, source, grpcurl, grpc_timeout, now=None,
                 machine_id_path="/etc/machine-id", tip_target=None):
    synced = wallet_height(wallet_db)
    tip = upstream_height(grpcurl, tip_target or source, grpc_timeout)
    timestamp = int(time.time() if now is None else now)
    stamp = datetime.fromtimestamp(timestamp, timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    payload = {
        "version": 1,
        "synced_height": synced,
        "chain_tip": tip,
        "synced_at": stamp,
        "source": source,
        "machine_id": machine_id(machine_id_path),
    }
    path = Path(path)
    temporary = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(path.parent, 0o755)
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent,
            prefix=f".{path.name}.", delete=False
        ) as handle:
            temporary = Path(handle.name)
            os.fchmod(handle.fileno(), 0o644)
            json.dump(payload, handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        temporary = None
        dir_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass
    return payload


def validate_marker(path, wallet_db, source, max_age, max_lag, now=None,
                    expected_machine_id=None, trusted_uid=0,
                    grpcurl="grpcurl", grpc_timeout=15, tip_target=None):
    path = Path(path)
    try:
        info = path.lstat()
        parent_info = path.parent.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("marker is not a single regular file")
        if info.st_uid != trusted_uid or info.st_mode & 0o022:
            raise ValueError("marker owner or permissions are not trusted")
        if not stat.S_ISDIR(parent_info.st_mode) or parent_info.st_uid != trusted_uid:
            raise ValueError("marker directory is not trusted")
        if parent_info.st_mode & 0o022:
            raise ValueError("marker directory is writable by group or others")
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or type(data.get("version")) is not int or data["version"] != 1:
            raise ValueError("marker has an unsupported format")
        synced = parse_height(data.get("synced_height"))
        tip = parse_height(data.get("chain_tip"))
        if data.get("source") != source:
            raise ValueError("marker provider does not match the configured sync provider")
        expected_host = expected_machine_id or machine_id()
        if data.get("machine_id") != expected_host:
            raise ValueError("marker belongs to another host")
        stamp = data.get("synced_at")
        if not isinstance(stamp, str) or not UTC_STAMP.fullmatch(stamp):
            raise ValueError("marker timestamp is not canonical UTC")
        parsed = datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=timezone.utc
        )
        timestamp = int(parsed.timestamp())
        current = int(time.time() if now is None else now)
        age = current - timestamp
        if age < 0:
            raise ValueError("marker timestamp is in the future")
        if age > max_age:
            raise ValueError(f"marker is stale ({age}s old; maximum {max_age}s)")
        # Providers are anycast and may observe adjacent blocks. A wallet
        # ahead of the endpoint is not stale; treat negative lag as zero.
        lag = max(0, tip - synced)
        if lag > max_lag:
            raise ValueError(
                f"wallet was {lag} blocks behind the recorded chain tip "
                f"(maximum {max_lag})"
            )
        current_height = wallet_height(wallet_db)
        if current_height < synced:
            raise ValueError(
                f"wallet height rolled back from marker height {synced} "
                f"to {current_height}"
            )
        current_tip = upstream_height(grpcurl, tip_target or source, grpc_timeout)
        current_lag = max(0, current_tip - current_height)
        if current_lag > max_lag:
            raise ValueError(
                f"wallet is currently {current_lag} blocks behind the chain tip "
                f"(maximum {max_lag})"
            )
    except (OSError, ValueError, TypeError, KeyError, sqlite3.Error) as exc:
        return False, str(exc)
    return True, f"wallet height {current_height}, synced {synced}, tip {tip}, age {age}s"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    write = commands.add_parser("write")
    check = commands.add_parser("check")
    for command in (write, check):
        command.add_argument("--marker", required=True)
        command.add_argument("--wallet-db", required=True)
        command.add_argument("--source", required=True)
    write.add_argument("--grpcurl", default="/usr/local/bin/grpcurl")
    write.add_argument("--grpc-timeout", type=int, default=15)
    write.add_argument("--tip-target", required=True)
    write.add_argument("--machine-id-file", default="/etc/machine-id")
    check.add_argument("--max-age", type=int, required=True)
    check.add_argument("--max-lag", type=int, required=True)
    check.add_argument("--grpcurl", default="grpcurl")
    check.add_argument("--grpc-timeout", type=int, default=15)
    check.add_argument("--tip-target", required=True)
    check.add_argument("--expected-machine-id")
    check.add_argument("--trusted-uid", type=int, default=0)
    args = parser.parse_args(argv)
    try:
        if args.command == "write":
            result = write_marker(
                args.marker, args.wallet_db, args.source, args.grpcurl,
                args.grpc_timeout, machine_id_path=args.machine_id_file,
                tip_target=args.tip_target
            )
            print(json.dumps(result, sort_keys=True))
            return 0
        ok, detail = validate_marker(
            args.marker, args.wallet_db, args.source, args.max_age,
            args.max_lag, expected_machine_id=args.expected_machine_id,
            trusted_uid=args.trusted_uid, grpcurl=args.grpcurl,
            grpc_timeout=args.grpc_timeout, tip_target=args.tip_target,
        )
        if not ok:
            print(f"credit_creators: CREDITING BLOCKED - wallet sync freshness: {detail}")
            return 1
        print(f"wallet sync freshness ok - {detail}")
        return 0
    except (OSError, RuntimeError, ValueError, sqlite3.Error) as exc:
        print(f"credit_creators: CREDITING BLOCKED - wallet sync freshness: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
