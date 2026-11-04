#!/usr/bin/env python3
"""Free2Z application check: check negative status assertions."""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ALLOW = "status-negation-ok:"
MIN_REASON = 12

# A three-digit HTTP status, 100-599.
STATUS = r"[1-5][0-9]{2}\b"

# Python: an HTTP status -- a name that is exactly `status_code` or `status`
# (`response.status_code`, `r.status`) -- compared with != / not in against a
# literal status or a DRF `status.HTTP_...` constant. Keyed on that exact name
# so docstring prose ("``!= 429``") and PROCESS exit codes (`returncode != 127`,
# `exit_code != 124`, `errcode != 404`, `exit_status`) are not findings.
PY_PATTERNS = [
    re.compile(
        r"\b(?:status_code|status)\b(?:\(\))?\s*(?:!=|\bnot\s+in\b)\s*"
        r"[\(\[\{]?\s*(?:" + STATUS + r"|status\.HTTP_\w+)"
    ),
]

# JS / TS: a Jest-style negated matcher whose SUBJECT ends in a status access
# (`expect(hop.status(), path).not.toBe(410)`, `expect(res.statusCode)...`),
# or a negated "contains" over a list of statuses. The status must be the LAST
# thing the subject reads, so `expect(width).not.toBe(320)` and
# `expect(statusBar.count).not.toBe(200)` are not findings. `[^;]` keeps a
# match inside one statement (prettier always terminates them).
JS_PATTERNS = [
    re.compile(
        r"expect\(\s*[^;]*?\bstatus(?:Code)?(?:\(\))?\s*[,)][^;]*?\.not\s*\.\s*"
        r"(?:toBe|toEqual|toStrictEqual)\(\s*" + STATUS + r"\s*,?\s*\)"
    ),
    re.compile(r"\.not\s*\.\s*toContain\([^)]*\bstatus(?:Code)?(?:\(\))?\s*\)"),
]


def is_python_test(rel: str) -> bool:
    name = os.path.basename(rel)
    if not rel.endswith(".py"):
        return False
    return (
        name.startswith("test_")
        or name.endswith("_test.py")
        or name == "conftest.py"
        or "/tests/" in f"/{rel}"
    )


def is_js_test(rel: str) -> bool:
    return bool(re.search(r"\.(?:spec|test)\.(?:[cm]?[jt]sx?)$", rel))


def candidate_files(root: Path) -> list[str]:
    """Tracked files when `root` is a git checkout, else a plain walk (the
    controls scan a temp dir that is not a repository)."""
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z"],
            check=True, capture_output=True,
        ).stdout.decode()
        files = [f for f in out.split("\0") if f]
        if files:
            return files
    except (OSError, subprocess.CalledProcessError):
        pass
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in {".git", "node_modules"}]
        for f in filenames:
            found.append(os.path.relpath(os.path.join(dirpath, f), root))
    return found


def _marked(line: str) -> bool:
    k = line.find(ALLOW)
    return k != -1 and len(line[k + len(ALLOW):].strip()) >= MIN_REASON


def allowed(lines: list[str], i: int) -> bool:
    """The marker on the flagged line itself, or anywhere in the unbroken
    comment block directly above it (a reason may wrap)."""
    if _marked(lines[i]):
        return True
    j = i - 1
    while j >= 0 and lines[j].strip().startswith(("#", "//")):
        if _marked(lines[j]):
            return True
        j -= 1
    return False


def scan(root: Path) -> list[str]:
    findings: list[str] = []
    for rel in sorted(candidate_files(root)):
        if is_python_test(rel):
            patterns = PY_PATTERNS
        elif is_js_test(rel):
            patterns = JS_PATTERNS
        else:
            continue
        path = root / rel
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except FileNotFoundError:
            continue  # deleted in the working tree but still in the index
        except UnicodeDecodeError:
            continue
        text = "\n".join(lines)
        seen = set()
        for p in patterns:
            for m in p.finditer(text):
                i = text.count("\n", 0, m.start())
                if i in seen or allowed(lines, i):
                    continue
                seen.add(i)
                findings.append(f"{rel}:{i + 1}: {lines[i].strip()}")
    return findings


def main(argv: list[str]) -> int:
    root = Path(argv[1] if len(argv) > 1 else Path(__file__).resolve().parents[2])
    if not root.is_dir():
        print(f"check-negative-status-assertions: no such directory: {root}", file=sys.stderr)
        return 2
    findings = scan(root)
    if not findings:
        print("check-negative-status-assertions: no negated status assertions in test files.")
        return 0
    print(
        f"::error::{len(findings)} test assertion(s) accept any status but the "
        "one they name:"
    )
    for f in findings:
        print(f"  {f}")
    print(
        "\n\"Not X\" passes on a deleted route's 404, a 405, a 400 and an explicit "
        "500. Assert the EXACT status the code under test returns, plus a body "
        "marker if the status alone is ambiguous.\nIf \"anything but X\" really is "
        f"the contract, put `{ALLOW} <reason>` on that line or in a comment directly above it."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
