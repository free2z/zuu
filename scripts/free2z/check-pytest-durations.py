#!/usr/bin/env python3
"""Fail closed when pytest-split's committed duration map is unusable."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any


class InvalidDurationFile(ValueError):
    """The duration file cannot provide trustworthy per-test weights."""


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise InvalidDurationFile(f"duplicate node ID: {key!r}")
        result[key] = value
    return result


def _reject_nonstandard_number(value: str) -> None:
    raise InvalidDurationFile(f"non-standard JSON number: {value}")


def load_duration_map(path: Path) -> dict[str, int | float]:
    try:
        with path.open(encoding="utf-8") as stream:
            data = json.load(
                stream,
                object_pairs_hook=_unique_object,
                parse_constant=_reject_nonstandard_number,
            )
    except (OSError, UnicodeError, json.JSONDecodeError, InvalidDurationFile) as exc:
        raise InvalidDurationFile(f"cannot read valid JSON: {exc}") from exc

    if not isinstance(data, dict) or not data:
        raise InvalidDurationFile("expected a nonempty JSON object of test node IDs to durations")

    for node_id, seconds in data.items():
        if not isinstance(node_id, str) or not node_id or "::" not in node_id:
            raise InvalidDurationFile(f"invalid pytest node ID: {node_id!r}")
        if isinstance(seconds, bool) or not isinstance(seconds, (int, float)):
            raise InvalidDurationFile(f"duration for {node_id!r} must be a number")
        try:
            finite = math.isfinite(seconds)
        except (OverflowError, TypeError):
            finite = False
        if not finite or seconds <= 0:
            raise InvalidDurationFile(
                f"duration for {node_id!r} must be finite and greater than zero"
            )

    # Intentionally do not compare these keys with pytest's current
    # collection: new tests are valid and pytest-split gives them the average
    # measured duration until the next successful refresh.
    return data


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, help="pytest-split JSON duration file")
    args = parser.parse_args()

    try:
        durations = load_duration_map(args.path)
    except InvalidDurationFile as exc:
        print(f"ERROR: {args.path}: {exc}", file=sys.stderr)
        return 1

    print(f"OK: {args.path} contains {len(durations)} valid per-test durations")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
