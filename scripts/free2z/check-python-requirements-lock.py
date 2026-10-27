#!/usr/bin/env python3
"""Check that the hash lock matches its direct input and pinned Docker image."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from python_requirements_lock import (
    RequirementsError,
    exact_version,
    package_name,
    parse_lock,
    parse_source,
)


def docker_image(path: Path) -> str:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as error:
        raise RequirementsError(f"could not read Dockerfile {path}: {error}") from error
    matches = [match.group(1) for line in lines if (match := re.fullmatch(r"FROM ([^\s]+)", line))]
    if len(matches) != 1 or "@sha256:" not in matches[0]:
        raise RequirementsError(f"{path} must have one digest-pinned FROM image")
    return matches[0]


def check(source_path: Path, lock_path: Path, dockerfile: Path) -> int:
    source = parse_source(source_path)
    records = parse_lock(lock_path)
    target = docker_image(dockerfile)
    try:
        first_line = lock_path.read_text(encoding="utf-8").splitlines()[0]
    except (OSError, UnicodeDecodeError, IndexError) as error:
        raise RequirementsError(f"could not read lock target metadata: {error}") from error
    expected_target = f"# Target image: {target} (linux/amd64)"
    if first_line != expected_target:
        raise RequirementsError(
            f"{lock_path}: target image metadata does not match {dockerfile}; "
            "regenerate with scripts/free2z/compile-python-requirements-lock.sh"
        )

    by_name: dict[str, list[tuple[str, tuple[str, ...], str, bool]]] = {}
    for record in records:
        name = package_name(record.requirement.name)
        version = exact_version(record.requirement, lock_path, record.line)
        extras = tuple(sorted(record.requirement.extras))
        marker = str(record.requirement.marker) if record.requirement.marker is not None else ""
        by_name.setdefault(name, []).append((version, extras, marker, record.direct_source))

    for name, (version, requirement) in source.items():
        direct_specs = {
            (candidate, extras, marker)
            for candidate, extras, marker, direct in by_name.get(name, [])
            if direct
        }
        expected = (
            version,
            tuple(sorted(requirement.extras)),
            str(requirement.marker) if requirement.marker is not None else "",
        )
        # pip-compile may merge extras requested transitively into a direct
        # package record (for example, procrastinate needs psycopg[pool]).
        # Require every source extra to survive, while allowing that safe
        # superset. Markers and the exact pin must remain identical.
        if not any(
            candidate == expected[0]
            and set(expected[1]).issubset(extras)
            and marker == expected[2]
            for candidate, extras, marker in direct_specs
        ):
            actual = ", ".join(sorted(map(repr, direct_specs))) or "missing direct provenance"
            raise RequirementsError(
                f"{name}=={version} in {source_path} does not match direct lock entry "
                f"including extras and markers ({actual})"
            )

    source_names = set(source)
    for name, entries in by_name.items():
        if any(direct for _version, _extras, _marker, direct in entries) and name not in source_names:
            raise RequirementsError(f"{name} has stale direct provenance in {lock_path}")

    print(
        f"Python production lock is hash-complete for {len(records)} records and "
        f"matches {len(source)} direct pins and {target}."
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("py/free2z/requirements/main.in"))
    parser.add_argument("--lock", type=Path, default=Path("py/free2z/requirements/main.txt"))
    parser.add_argument("--dockerfile", type=Path, default=Path("build/free2z/backend.Dockerfile"))
    args = parser.parse_args(argv)
    try:
        return check(args.source, args.lock, args.dockerfile)
    except RequirementsError as error:
        print(f"INVALID PYTHON PRODUCTION LOCK: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
