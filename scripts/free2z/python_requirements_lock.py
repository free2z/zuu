"""Parsing helpers shared by the Python production lock guards."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    from packaging.markers import default_environment
    from packaging.requirements import InvalidRequirement, Requirement
    from packaging.utils import canonicalize_name
except ImportError:  # Python runners ship packaging through pip.
    from pip._vendor.packaging.markers import default_environment
    from pip._vendor.packaging.requirements import InvalidRequirement, Requirement
    from pip._vendor.packaging.utils import canonicalize_name


HASH_RE = re.compile(r"--hash=sha256:[0-9a-fA-F]{64}\Z")


class RequirementsError(RuntimeError):
    """A requirements file cannot be trusted as a complete exact lock."""


@dataclass
class Record:
    line: int
    requirement: Requirement
    hashes: list[str] = field(default_factory=list)
    direct_source: bool = False


def package_name(value: str) -> str:
    return str(canonicalize_name(value.strip()))


def exact_version(requirement: Requirement, path: Path, line: int) -> str:
    specifiers = tuple(requirement.specifier)
    if (
        len(specifiers) != 1
        or specifiers[0].operator != "=="
        or specifiers[0].version.endswith(".*")
    ):
        raise RequirementsError(
            f"{path}:{line} must pin exactly one version with ==: {requirement}"
        )
    return specifiers[0].version


def _strip_comment(line: str) -> str:
    return re.sub(r"\s+#.*$", "", line).strip()


def _logical_lines(path: Path) -> list[tuple[int, str]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError as error:
        raise RequirementsError(f"requirements file does not exist: {path}") from error
    except UnicodeDecodeError as error:
        raise RequirementsError(f"requirements file is not UTF-8: {path}") from error

    records: list[tuple[int, str]] = []
    start: int | None = None
    pieces: list[str] = []
    for number, raw in enumerate(lines, start=1):
        if raw.lstrip().startswith("#"):
            continue
        value = _strip_comment(raw)
        if not value:
            continue
        continued = value.endswith("\\")
        if continued:
            value = value[:-1].rstrip()
            if not value:
                raise RequirementsError(f"{path}:{number} has an empty continuation")
        if start is None:
            start = number
        pieces.append(value)
        if not continued:
            records.append((start, " ".join(pieces)))
            start, pieces = None, []
    if start is not None:
        raise RequirementsError(f"{path}:{start} has an unterminated continuation")
    return records


def parse_source(path: Path) -> dict[str, tuple[str, Requirement]]:
    """Read the small direct input; it contains exact pins, not pip options."""

    result: dict[str, tuple[str, Requirement]] = {}
    for line, text in _logical_lines(path):
        if text.startswith(("-", "@")):
            raise RequirementsError(f"{path}:{line} is not a direct package pin: {text!r}")
        try:
            requirement = Requirement(text)
        except InvalidRequirement as error:
            raise RequirementsError(f"{path}:{line} is invalid: {text!r}") from error
        name = package_name(requirement.name)
        version = exact_version(requirement, path, line)
        if name in result:
            raise RequirementsError(f"{path}:{line} repeats direct package {name!r}")
        result[name] = (version, requirement)
    if not result:
        raise RequirementsError(f"{path} has no direct package pins")
    return result


def parse_lock(path: Path) -> list[Record]:
    """Parse exact pins and SHA-256 hashes from a pip-compile lock."""

    logical = _logical_lines(path)
    records: list[Record] = []
    seen_records: set[tuple[str, str, tuple[str, ...], str]] = set()
    previous: Record | None = None
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as error:
        raise RequirementsError(f"could not read lock {path}: {error}") from error

    # pip-compile emits provenance in comments after each logical record. Read
    # those separately so a transitive copy of a direct package cannot satisfy
    # the source/lock parity check accidentally.
    for number, text in logical:
        hashes = re.findall(r"(?<!\S)--hash(?:=\S+)?", text)
        invalid_hashes = [token for token in hashes if not HASH_RE.fullmatch(token)]
        if invalid_hashes:
            raise RequirementsError(
                f"{path}:{number} has invalid SHA-256 hash option {invalid_hashes[0]!r}"
            )
        requirement_text = re.sub(r"(?<!\S)--hash(?:=\S+)?", "", text).strip()
        if not requirement_text:
            raise RequirementsError(f"{path}:{number} has hashes without a package pin")
        try:
            requirement = Requirement(requirement_text)
        except InvalidRequirement as error:
            raise RequirementsError(
                f"{path}:{number} is not a package requirement: {requirement_text!r}"
            ) from error
        version = exact_version(requirement, path, number)
        key = (
            package_name(requirement.name),
            version,
            tuple(sorted(requirement.extras)),
            str(requirement.marker) if requirement.marker is not None else "",
        )
        if key in seen_records:
            raise RequirementsError(f"{path}:{number} repeats a package lock record")
        seen_records.add(key)
        record = Record(number, requirement, hashes)
        if not hashes:
            raise RequirementsError(f"{path}:{number} has no SHA-256 hash")
        records.append(record)

    if not records:
        raise RequirementsError(f"{path} has no package records")

    # The package's pip-compile provenance follows it and ends at the next
    # requirement. Only exact source provenance marks a direct input.
    record_index = 0
    for index, raw in enumerate(lines):
        if record_index < len(records) and index + 1 == records[record_index].line:
            previous = records[record_index]
            record_index += 1
            continue
        if previous is None or not raw.lstrip().startswith("#"):
            continue
        provenance = raw.strip()
        if provenance in {
            "# via -r requirements/main.in",
            "#   -r requirements/main.in",
            # Dependabot compiles from /py/free2z/requirements rather than /py.
            "# via -r main.in",
            "#   -r main.in",
        }:
            previous.direct_source = True
    return records


def applicable(requirement: Requirement, environment: dict[str, str] | None = None) -> bool:
    return requirement.marker is None or requirement.marker.evaluate(
        environment or default_environment()
    )


def installed_distributions(installed_json: Path | None = None) -> list[dict[str, Any]]:
    """Return installed metadata, with a JSON seam for deterministic controls."""

    import json

    if installed_json is not None:
        try:
            value = json.loads(installed_json.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RequirementsError(f"installed metadata is not valid JSON: {error}") from error
        if not isinstance(value, list) or not all(isinstance(row, dict) for row in value):
            raise RequirementsError("installed metadata must be a JSON list of distribution objects")
        return value

    from importlib import metadata

    result = []
    for distribution in metadata.distributions():
        name = distribution.metadata.get("Name")
        version = distribution.version
        if not name:
            continue
        try:
            direct_url = distribution.read_text("direct_url.json")
        except (OSError, UnicodeDecodeError) as error:
            raise RequirementsError(
                f"installed distribution {name!r} has unreadable direct_url.json"
            ) from error
        editable = False
        if direct_url:
            try:
                direct = json.loads(direct_url)
                editable = bool(
                    isinstance(direct, dict)
                    and isinstance(direct.get("dir_info"), dict)
                    and direct["dir_info"].get("editable") is True
                )
            except json.JSONDecodeError as error:
                raise RequirementsError(
                    f"installed distribution {name!r} has malformed direct_url.json"
                ) from error
        result.append({"name": name, "version": version, "editable": editable})
    return result
