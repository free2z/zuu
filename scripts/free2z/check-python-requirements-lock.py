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


def check(source_path: Path, lock_path: Path, dockerfile: Path, *, kind: str = "main") -> int:
    if kind not in {"main", "test"}:
        raise RequirementsError(f"unsupported lock kind: {kind}")
    source = parse_source(source_path, test_constraint=kind == "test")
    records = parse_lock(lock_path, source_name=f"{kind}.in")
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

    if kind == "test":
        runtime_path = source_path.parent / "main.txt"
        runtime_versions: dict[str, set[str]] = {}
        for record in parse_lock(runtime_path):
            name = package_name(record.requirement.name)
            runtime_versions.setdefault(name, set()).add(
                exact_version(record.requirement, runtime_path, record.line)
            )
        for name in set(by_name) & set(runtime_versions):
            versions = {version for version, _extras, _marker, _direct in by_name[name]}
            if versions != runtime_versions[name]:
                raise RequirementsError(f"{name} test lock version differs from runtime constraint")

    print(
        f"Python {kind} lock is hash-complete for {len(records)} records and "
        f"matches {len(source)} direct pins and {target}."
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", choices=("main", "test"), default="main")
    parser.add_argument("--source", type=Path)
    parser.add_argument("--lock", type=Path)
    parser.add_argument("--dockerfile", type=Path, default=Path("build/free2z/backend.Dockerfile"))
    args = parser.parse_args(argv)
    source = args.source or Path(f"py/free2z/requirements/{args.kind}.in")
    lock = args.lock or Path(f"py/free2z/requirements/{args.kind}.txt")
    try:
        return check(source, lock, args.dockerfile, kind=args.kind)
    except RequirementsError as error:
        print(f"INVALID PYTHON PRODUCTION LOCK: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
