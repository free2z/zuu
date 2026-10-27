#!/usr/bin/env python3
"""Fail if the test overlay changed any applicable production lock pin."""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from pathlib import Path

from python_requirements_lock import (
    RequirementsError,
    applicable,
    exact_version,
    installed_distributions,
    package_name,
    parse_lock,
)


def check(lock_path: Path, installed_json: Path | None) -> int:
    records = parse_lock(lock_path)
    environment = None
    expected: dict[str, set[str]] = defaultdict(set)
    for record in records:
        if applicable(record.requirement, environment):
            expected[package_name(record.requirement.name)].add(
                exact_version(record.requirement, lock_path, record.line)
            )

    distributions: dict[str, list[dict[str, object]]] = defaultdict(list)
    for distribution in installed_distributions(installed_json):
        name = distribution.get("name")
        version = distribution.get("version")
        editable = distribution.get("editable", False)
        if not isinstance(name, str) or not name.strip():
            raise RequirementsError("installed distribution has no valid name")
        if not isinstance(version, str) or not version.strip():
            raise RequirementsError(f"installed distribution {name!r} has no valid version")
        if not isinstance(editable, bool):
            raise RequirementsError(f"installed distribution {name!r} has invalid editable metadata")
        distributions[package_name(name)].append(
            {"name": name, "version": version, "editable": editable}
        )

    failures: list[str] = []
    for name, versions in sorted(expected.items()):
        if len(versions) != 1:
            failures.append(
                f"{name} has multiple lock versions selected for this environment: "
                f"{', '.join(sorted(versions))}"
            )
            continue
        rows = distributions.get(name, [])
        if not rows:
            failures.append(f"{name}=={next(iter(versions))} is missing from the installed environment")
            continue
        if len(rows) != 1:
            failures.append(f"{name} has duplicate installed distribution metadata")
            continue
        row = rows[0]
        if row["editable"]:
            failures.append(f"{name} is installed as an editable distribution")
        if row["version"] != next(iter(versions)):
            failures.append(
                f"{name} is installed at {row['version']}, but the production lock requires "
                f"{next(iter(versions))}"
            )

    if failures:
        print("PRODUCTION LOCK/INSTALLED ENVIRONMENT MISMATCH:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1
    print(f"Installed environment matches {len(expected)} production lock packages.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=Path, default=Path("py/free2z/requirements/main.txt"))
    parser.add_argument(
        "--installed-json",
        type=Path,
        help="test seam: JSON list of installed distribution name/version/editable records",
    )
    args = parser.parse_args(argv)
    try:
        return check(args.lock, args.installed_json)
    except RequirementsError as error:
        print(f"CANNOT VERIFY INSTALLED PRODUCTION REQUIREMENTS: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
