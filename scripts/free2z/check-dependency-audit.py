#!/usr/bin/env python3
"""Free2Z application check: check dependency audit."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


EXIT_ACCEPTED = 0
EXIT_AUDIT_FAILED = 1
# Deliberately not 2: argparse exits 2 on a usage error, and a caller must never
# mistake "this script was invoked wrongly" for "the registry blipped, retry".
EXIT_INFRASTRUCTURE = 3


class AuditFailure(Exception):
    """A scanner or reviewed-baseline invariant was not satisfied."""


class ScannerInfrastructureFailure(AuditFailure):
    """The scanner produced no usable report, so no audit conclusion exists.

    This is the ONLY failure class a caller may retry. It never covers a report
    that parsed: a valid report with findings is a real result at exit 0 or 1.
    """


def package_key(ecosystem: str, package: str) -> str:
    """Return the ecosystem's package-identity key without widening matches."""

    normalized = package.strip().lower()
    if ecosystem == "pip":
        # PEP 503 makes '-', '_' and '.' interchangeable for PyPI names.
        return re.sub(r"[-_.]+", "-", normalized)
    # npm package names may contain '-' and '_', which are distinct identities.
    return normalized


@dataclass(frozen=True)
class Finding:
    ecosystem: str
    package: str
    identifiers: frozenset[str]
    display_id: str

    @property
    def package_key(self) -> str:
        return package_key(self.ecosystem, self.package)


@dataclass(frozen=True)
class BaselineEntry:
    ecosystem: str
    package: str
    advisory: str
    rationale: str
    reachability: str
    follow_up: str
    expires: dt.date

    @property
    def package_key(self) -> str:
        return package_key(self.ecosystem, self.package)


def normalized_identifier(value: str) -> str:
    return value.strip().upper()


def preferred_identifier(identifiers: Iterable[str]) -> str:
    values = sorted(set(identifiers))
    for prefix in ("GHSA-", "CVE-"):
        matching = [value for value in values if value.startswith(prefix)]
        if matching:
            return matching[0]
    if not values:
        raise AuditFailure("scanner reported an advisory without an identifier")
    return values[0]


def load_json(
    path: Path, description: str, failure: type[AuditFailure] = AuditFailure
) -> Any:
    # ``failure`` is the class for an unreadable file. The scanner report passes
    # ScannerInfrastructureFailure (a truncated download is retryable); the
    # baseline keeps AuditFailure, because a broken baseline is a repo bug that
    # no amount of retrying fixes.
    try:
        with path.open(encoding="utf-8") as source:
            return json.load(source)
    except FileNotFoundError as error:
        raise failure(f"{description} does not exist: {path}") from error
    except json.JSONDecodeError as error:
        raise failure(f"{description} is not valid JSON: {path}: {error}") from error
    except UnicodeDecodeError as error:
        # A scanner killed mid-write truncates its output inside a multi-byte
        # character. That is not JSONDecodeError and not OSError, so without
        # this it escaped as a traceback -- exit 1, which the wrapper reads as a
        # conclusive rejected audit and refuses to retry.
        raise failure(f"{description} is not valid UTF-8: {path}: {error}") from error
    except OSError as error:
        raise failure(f"could not read {description} {path}: {error}") from error


def nonempty_string(record: dict[str, Any], key: str, index: int) -> str:
    value = record.get(key)
    if not isinstance(value, str) or not value.strip():
        raise AuditFailure(
            f"baseline entry {index} needs a non-empty {key!r} field; "
            "package- or severity-wide suppressions are not allowed"
        )
    return value.strip()


def load_baseline(path: Path) -> list[BaselineEntry]:
    raw = load_json(path, "dependency audit baseline")
    if not isinstance(raw, dict) or raw.get("schema_version") != 1:
        raise AuditFailure("baseline must be an object with schema_version: 1")
    entries = raw.get("findings")
    if not isinstance(entries, list):
        raise AuditFailure("baseline findings must be a list")

    parsed: list[BaselineEntry] = []
    seen: set[tuple[str, str, str]] = set()
    for index, record in enumerate(entries, start=1):
        if not isinstance(record, dict):
            raise AuditFailure(f"baseline entry {index} must be an object")
        ecosystem = nonempty_string(record, "ecosystem", index).lower()
        if ecosystem not in {"npm", "pip"}:
            raise AuditFailure(f"baseline entry {index} has unsupported ecosystem {ecosystem!r}")
        package = nonempty_string(record, "package", index)
        advisory = normalized_identifier(nonempty_string(record, "advisory", index))
        rationale = nonempty_string(record, "rationale", index)
        reachability = nonempty_string(record, "reachability", index)
        follow_up = nonempty_string(record, "follow_up", index)
        expires_raw = nonempty_string(record, "expires", index)
        try:
            expires = dt.date.fromisoformat(expires_raw)
        except ValueError as error:
            raise AuditFailure(
                f"baseline entry {index} expires must be ISO-8601 YYYY-MM-DD, got {expires_raw!r}"
            ) from error
        key = (ecosystem, package_key(ecosystem, package), advisory)
        if key in seen:
            raise AuditFailure(
                f"baseline repeats exact advisory {advisory} for {ecosystem} package {package}"
            )
        seen.add(key)
        parsed.append(
            BaselineEntry(
                ecosystem=ecosystem,
                package=package,
                advisory=advisory,
                rationale=rationale,
                reachability=reachability,
                follow_up=follow_up,
                expires=expires,
            )
        )
    return parsed


def advisory_from_npm_url(url: str) -> str:
    # npm's JSON puts the stable GHSA in the advisory URL. Its numeric `source`
    # is an implementation detail of npm's registry and is deliberately never
    # accepted as an allowlist key.
    match = re.search(r"(?:GHSA|CVE)-[A-Za-z0-9-]+", url, flags=re.IGNORECASE)
    if not match:
        raise AuditFailure(
            f"npm advisory URL has no stable GHSA/CVE identifier: {url!r}"
        )
    return normalized_identifier(match.group(0))


def npm_findings(payload: Any) -> list[Finding]:
    if not isinstance(payload, dict) or not isinstance(payload.get("vulnerabilities"), dict):
        # The registry-outage shape: npm exits 1 -- the same code as a genuine
        # findings run -- and emits an error object or nothing at all. No
        # conclusion was reached, so this is infrastructure, not an audit.
        raise ScannerInfrastructureFailure("npm audit JSON is missing its vulnerabilities object")

    findings: list[Finding] = []
    for outer_package, vulnerability in payload["vulnerabilities"].items():
        if not isinstance(outer_package, str) or not isinstance(vulnerability, dict):
            raise AuditFailure("npm audit vulnerabilities must map package names to objects")
        via = vulnerability.get("via")
        if not isinstance(via, list):
            raise AuditFailure(f"npm audit entry for {outer_package} has invalid via data")
        for advisory in via:
            # A string is npm's edge to another vulnerable package. The actual
            # advisory is emitted on that package's own entry, so do not invent
            # a non-exact exemption for this dependent edge.
            if isinstance(advisory, str):
                continue
            if not isinstance(advisory, dict):
                raise AuditFailure(f"npm audit entry for {outer_package} has invalid advisory data")
            package = advisory.get("name")
            url = advisory.get("url")
            if not isinstance(package, str) or not package.strip() or not isinstance(url, str):
                raise AuditFailure(
                    f"npm advisory for {outer_package} lacks an exact package name or URL"
                )
            identifier = advisory_from_npm_url(url)
            findings.append(
                Finding(
                    ecosystem="npm",
                    package=package,
                    identifiers=frozenset({identifier}),
                    display_id=identifier,
                )
            )
    return deduplicate_findings(findings)


def pip_findings(payload: Any) -> list[Finding]:
    # pip-audit 2.10.1 emits {"dependencies": [...]}; accepting the older list
    # form keeps the checker useful when replaying a saved report in an incident.
    dependencies = payload.get("dependencies") if isinstance(payload, dict) else payload
    if not isinstance(dependencies, list):
        raise ScannerInfrastructureFailure("pip-audit JSON is missing its dependencies list")

    findings: list[Finding] = []
    for dependency in dependencies:
        if not isinstance(dependency, dict):
            raise AuditFailure("pip-audit dependencies must be objects")
        package = dependency.get("name")
        vulnerabilities = dependency.get("vulns")
        if not isinstance(package, str) or not package.strip() or not isinstance(vulnerabilities, list):
            raise AuditFailure("pip-audit dependency has invalid name or vulns data")
        for vulnerability in vulnerabilities:
            if not isinstance(vulnerability, dict):
                raise AuditFailure(f"pip-audit vulnerability for {package} must be an object")
            primary_id = vulnerability.get("id")
            aliases = vulnerability.get("aliases", [])
            if not isinstance(primary_id, str) or not primary_id.strip() or not isinstance(aliases, list):
                raise AuditFailure(f"pip-audit vulnerability for {package} has invalid identifiers")
            identifiers = {normalized_identifier(primary_id)}
            for alias in aliases:
                if not isinstance(alias, str) or not alias.strip():
                    raise AuditFailure(f"pip-audit vulnerability for {package} has an invalid alias")
                identifiers.add(normalized_identifier(alias))
            findings.append(
                Finding(
                    ecosystem="pip",
                    package=package,
                    identifiers=frozenset(identifiers),
                    display_id=preferred_identifier(identifiers),
                )
            )
    return deduplicate_findings(findings)


def deduplicate_findings(findings: Iterable[Finding]) -> list[Finding]:
    # OSV currently exposes duplicate rows for some aliases. De-duplicate by
    # package plus a stable preferred identifier, while retaining the union of
    # aliases so a baseline can still use GHSA or CVE instead of a PYSEC ID.
    merged: dict[tuple[str, str, str], Finding] = {}
    for finding in findings:
        key = (finding.ecosystem, finding.package_key, finding.display_id)
        existing = merged.get(key)
        if existing is None:
            merged[key] = finding
            continue
        identifiers = existing.identifiers | finding.identifiers
        merged[key] = Finding(
            ecosystem=finding.ecosystem,
            package=finding.package,
            identifiers=frozenset(identifiers),
            display_id=preferred_identifier(identifiers),
        )
    return sorted(merged.values(), key=lambda item: (item.package_key, item.display_id))


def parse_findings(ecosystem: str, payload: Any) -> list[Finding]:
    if ecosystem == "npm":
        return npm_findings(payload)
    if ecosystem == "pip":
        return pip_findings(payload)
    raise AuditFailure(f"unsupported ecosystem {ecosystem!r}")


def ensure_expected_scanner_status(status: int, findings: list[Finding]) -> None:
    if status not in {0, 1}:
        raise ScannerInfrastructureFailure(
            f"scanner operational error: exit {status}; expected 0 (no findings) or 1 (findings)"
        )
    if status == 0 and findings:
        raise AuditFailure(
            "scanner exited 0 but its JSON contains findings; refusing an ambiguous report"
        )
    if status == 1 and not findings:
        raise AuditFailure(
            "scanner exited 1 but its JSON contains no findings; this is not a valid findings report"
        )


def validate_findings(
    findings: list[Finding], baseline: list[BaselineEntry], today: dt.date
) -> tuple[list[str], int]:
    failures: list[str] = []
    matched_entries: set[BaselineEntry] = set()
    for finding in findings:
        matches = [
            entry
            for entry in baseline
            if entry.ecosystem == finding.ecosystem
            and entry.package_key == finding.package_key
            and entry.advisory in finding.identifiers
        ]
        if not matches:
            failures.append(
                "UNBASELINED "
                f"{finding.ecosystem} {finding.package} {finding.display_id} "
                f"(scanner identifiers: {', '.join(sorted(finding.identifiers))})"
            )
            continue
        if len(matches) > 1:
            failures.append(
                "AMBIGUOUS baseline aliases "
                f"{finding.ecosystem} {finding.package} {finding.display_id}: "
                "one scanner advisory group matches multiple baseline entries"
            )
            continue
        if any(entry in matched_entries for entry in matches):
            failures.append(
                "SPLIT scanner alias group "
                f"{finding.ecosystem} {finding.package} {finding.display_id}: "
                "one baseline entry matches more than one scanner advisory group"
            )
            continue
        matched_entries.update(matches)
        expired = [entry for entry in matches if entry.expires < today]
        for entry in expired:
            failures.append(
                "EXPIRED baseline "
                f"{entry.ecosystem} {entry.package} {entry.advisory} expired {entry.expires}; "
                f"follow-up: {entry.follow_up}"
            )
    return failures, len(matched_entries)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ecosystem", choices=("npm", "pip"), required=True)
    parser.add_argument("--input", type=Path, required=True, help="scanner JSON report")
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument(
        "--scanner-exit",
        type=int,
        required=True,
        help="exit code captured from npm audit or pip-audit before this checker ran",
    )
    parser.add_argument(
        "--today",
        type=dt.date.fromisoformat,
        default=dt.date.today(),
        help="ISO date override for deterministic tests (default: today)",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        payload = load_json(
            args.input,
            f"{args.ecosystem} audit report",
            failure=ScannerInfrastructureFailure,
        )
        findings = parse_findings(args.ecosystem, payload)
        ensure_expected_scanner_status(args.scanner_exit, findings)
        baseline = [
            entry
            for entry in load_baseline(args.baseline)
            if entry.ecosystem == args.ecosystem
        ]
        failures, matched = validate_findings(findings, baseline, args.today)
    except ScannerInfrastructureFailure as error:
        # NOT a clean audit and NOT a findings report: the scanner produced
        # nothing to judge. The caller may retry this class; if every attempt
        # lands here it must still fail.
        print(
            f"DEPENDENCY AUDIT INFRASTRUCTURE FAILURE: {error}; "
            "no vulnerability conclusion was reached",
            file=sys.stderr,
        )
        return EXIT_INFRASTRUCTURE
    except AuditFailure as error:
        print(f"DEPENDENCY AUDIT FAILED: {error}", file=sys.stderr)
        return EXIT_AUDIT_FAILED
    except Exception:
        # An unexpected crash reached no conclusion either, and exit 1 must mean
        # ONLY "a real result was examined and rejected" -- that is the status
        # the wrapper refuses to retry. Print the traceback so the bug is not
        # hidden by the classification; the job still fails.
        traceback.print_exc()
        print(
            "DEPENDENCY AUDIT INFRASTRUCTURE FAILURE: the checker itself crashed; "
            "no vulnerability conclusion was reached",
            file=sys.stderr,
        )
        return EXIT_INFRASTRUCTURE

    if failures:
        print("DEPENDENCY AUDIT FAILED:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        return EXIT_AUDIT_FAILED

    inactive = len(baseline) - matched
    baseline_label = "entry" if len(baseline) == 1 else "entries"
    inactive_label = "entry" if inactive == 1 else "entries"
    print(
        f"Dependency audit accepted {len(findings)} exact {args.ecosystem} advisory finding(s) "
        f"against {len(baseline)} reviewed {args.ecosystem} baseline {baseline_label} "
        f"({inactive} {args.ecosystem} baseline {inactive_label} currently absent/fixed)."
    )
    return EXIT_ACCEPTED


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
