#!/usr/bin/env bash
# Free2Z application check: test check dependency audit.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
checker="$repo_root/scripts/free2z/check-dependency-audit.py"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

baseline="$scratch/baseline.json"
alias_baseline="$scratch/alias-baseline.json"
ambiguous_alias_baseline="$scratch/ambiguous-alias-baseline.json"
npm_known="$scratch/npm-known.json"
npm_new="$scratch/npm-new.json"
npm_separator="$scratch/npm-separator.json"
npm_removed="$scratch/npm-removed.json"
pip_alias="$scratch/pip-alias.json"
pip_split_aliases="$scratch/pip-split-aliases.json"
pip_normalized="$scratch/pip-normalized.json"
malformed="$scratch/malformed.json"
npm_outage="$scratch/npm-outage.json"
pip_outage="$scratch/pip-outage.json"

cat >"$baseline" <<'JSON'
{
  "schema_version": 1,
  "findings": [
    {
      "ecosystem": "npm",
      "package": "known-package",
      "advisory": "GHSA-1111-2222-3333",
      "rationale": "Positive-control fixture.",
      "reachability": "fixture only",
      "follow_up": "Remove with fixture finding.",
      "expires": "2099-01-01"
    },
    {
      "ecosystem": "pip",
      "package": "Django",
      "advisory": "GHSA-AAAA-BBBB-CCCC",
      "rationale": "Positive-control fixture.",
      "reachability": "fixture only",
      "follow_up": "Remove with fixture finding.",
      "expires": "2099-01-01"
    },
    {
      "ecosystem": "npm",
      "package": "victim_package",
      "advisory": "GHSA-4444-5555-6666",
      "rationale": "Positive-control fixture.",
      "reachability": "fixture only",
      "follow_up": "Remove with fixture finding.",
      "expires": "2099-01-01"
    },
    {
      "ecosystem": "pip",
      "package": "pep_503.package",
      "advisory": "GHSA-7777-8888-9999",
      "rationale": "Positive-control fixture.",
      "reachability": "fixture only",
      "follow_up": "Remove with fixture finding.",
      "expires": "2099-01-01"
    }
  ]
}
JSON

cat >"$alias_baseline" <<'JSON'
{
  "schema_version": 1,
  "findings": [
    {
      "ecosystem": "pip",
      "package": "Django",
      "advisory": "CVE-2099-1111",
      "rationale": "Positive-control fixture.",
      "reachability": "fixture only",
      "follow_up": "Remove with fixture finding.",
      "expires": "2099-01-01"
    }
  ]
}
JSON

cat >"$ambiguous_alias_baseline" <<'JSON'
{
  "schema_version": 1,
  "findings": [
    {
      "ecosystem": "pip",
      "package": "Django",
      "advisory": "CVE-2099-1",
      "rationale": "Positive-control fixture.",
      "reachability": "fixture only",
      "follow_up": "Remove with fixture finding.",
      "expires": "2099-01-01"
    },
    {
      "ecosystem": "pip",
      "package": "Django",
      "advisory": "GHSA-AAAA-BBBB-CCCC",
      "rationale": "Positive-control fixture.",
      "reachability": "fixture only",
      "follow_up": "Remove with fixture finding.",
      "expires": "2099-01-01"
    }
  ]
}
JSON

cat >"$npm_known" <<'JSON'
{
  "vulnerabilities": {
    "known-package": {
      "via": [{"name": "known-package", "url": "https://github.com/advisories/GHSA-1111-2222-3333"}]
    }
  }
}
JSON

cat >"$npm_new" <<'JSON'
{
  "vulnerabilities": {
    "new-package": {
      "via": [{"name": "new-package", "url": "https://github.com/advisories/GHSA-9999-8888-7777"}]
    }
  }
}
JSON

cat >"$npm_separator" <<'JSON'
{
  "vulnerabilities": {
    "victim-package": {
      "via": [{"name": "victim-package", "url": "https://github.com/advisories/GHSA-4444-5555-6666"}]
    }
  }
}
JSON

cat >"$npm_removed" <<'JSON'
{"vulnerabilities": {}}
JSON

cat >"$pip_alias" <<'JSON'
{
  "dependencies": [
    {
      "name": "django",
      "vulns": [
        {"id": "PYSEC-2099-1", "aliases": ["CVE-2099-1", "GHSA-aaaa-bbbb-cccc"]}
      ]
    }
  ]
}
JSON

cat >"$pip_normalized" <<'JSON'
{
  "dependencies": [
    {
      "name": "pep-503_package",
      "vulns": [{"id": "GHSA-7777-8888-9999", "aliases": []}]
    }
  ]
}
JSON

cat >"$pip_split_aliases" <<'JSON'
{
  "dependencies": [
    {
      "name": "Django",
      "vulns": [
        {"id": "GHSA-AAAA-BBBB-CCCC", "aliases": ["CVE-2099-1111"]},
        {"id": "GHSA-DDDD-EEEE-FFFF", "aliases": ["CVE-2099-1111"]}
      ]
    }
  ]
}
JSON

printf 'this is not JSON\n' >"$malformed"

# The registry-outage shape: npm exits 1 -- the same status as a real findings
# run -- and emits an error object instead of `vulnerabilities`.
printf '{"error": {"code": "E503", "summary": "503 Service Unavailable"}}\n' >"$npm_outage"
printf '{"error": "503 Service Unavailable"}\n' >"$pip_outage"

expect_exit() {
  local expected=$1
  local label=$2
  shift 2
  set +e
  "$@" >"$scratch/$label.out" 2>&1
  local actual=$?
  set -e
  if [ "$actual" -ne "$expected" ]; then
    echo "$label: expected exit $expected, got $actual" >&2
    sed -n '1,160p' "$scratch/$label.out" >&2
    exit 1
  fi
}

# Accepted known findings, including pip-audit's mutable primary PYSEC ID with
# the stable GHSA only present in aliases.
expect_exit 0 known-npm python3 "$checker" --ecosystem npm --input "$npm_known" --baseline "$baseline" --scanner-exit 1
grep -q 'against 2 reviewed npm baseline entries (1 npm baseline entry currently absent/fixed).' "$scratch/known-npm.out"
expect_exit 0 known-pip-alias python3 "$checker" --ecosystem pip --input "$pip_alias" --baseline "$baseline" --scanner-exit 1
# PyPI normalization remains intentionally broad under PEP 503.
expect_exit 0 pip-pep503-normalization python3 "$checker" --ecosystem pip --input "$pip_normalized" --baseline "$baseline" --scanner-exit 1
expect_exit 1 pip-split-alias-group python3 "$checker" --ecosystem pip --input "$pip_split_aliases" --baseline "$alias_baseline" --scanner-exit 1
grep -q 'SPLIT scanner alias group' "$scratch/pip-split-alias-group.out"
expect_exit 1 pip-ambiguous-alias-group python3 "$checker" --ecosystem pip --input "$pip_alias" --baseline "$ambiguous_alias_baseline" --scanner-exit 1
grep -q 'AMBIGUOUS baseline aliases' "$scratch/pip-ambiguous-alias-group.out"

# A new exact advisory must fail even if another advisory for that package is
# baselined. There is no package- or severity-level escape hatch.
expect_exit 1 new-finding python3 "$checker" --ecosystem npm --input "$npm_new" --baseline "$baseline" --scanner-exit 1
grep -q 'UNBASELINED npm new-package GHSA-9999-8888-7777' "$scratch/new-finding.out"

# npm treats '_' and '-' as distinct package identities. A baseline for one
# must not suppress an advisory for the other, even with the same GHSA.
expect_exit 1 npm-package-separator python3 "$checker" --ecosystem npm --input "$npm_separator" --baseline "$baseline" --scanner-exit 1
grep -q 'UNBASELINED npm victim-package GHSA-4444-5555-6666' "$scratch/npm-package-separator.out"

expect_exit 3 malformed python3 "$checker" --ecosystem npm --input "$malformed" --baseline "$baseline" --scanner-exit 1
grep -q 'not valid JSON' "$scratch/malformed.out"
grep -q 'INFRASTRUCTURE FAILURE' "$scratch/malformed.out"
expect_exit 3 scanner-error python3 "$checker" --ecosystem npm --input "$npm_known" --baseline "$baseline" --scanner-exit 2
grep -q 'scanner operational error' "$scratch/scanner-error.out"
expect_exit 3 npm-no-vulnerabilities python3 "$checker" --ecosystem npm --input "$npm_outage" --baseline "$baseline" --scanner-exit 1
grep -q 'missing its vulnerabilities object' "$scratch/npm-no-vulnerabilities.out"
expect_exit 3 pip-no-dependencies python3 "$checker" --ecosystem pip --input "$pip_outage" --baseline "$baseline" --scanner-exit 1
grep -q 'missing its dependencies list' "$scratch/pip-no-dependencies.out"

# A report that PARSED is a real result even when its status and contents
# disagree. That is exit 1, never retried: re-rolling it is how a finding gets
# lost.
expect_exit 1 status-contents-disagree python3 "$checker" --ecosystem npm --input "$npm_known" --baseline "$baseline" --scanner-exit 0
grep -q 'exited 0 but its JSON contains findings' "$scratch/status-contents-disagree.out"

# Fixed advisories naturally disappear from scanner output. Retaining their
# reviewed record briefly does not make the checker fail.
expect_exit 0 removed-finding python3 "$checker" --ecosystem npm --input "$npm_removed" --baseline "$baseline" --scanner-exit 0

echo "dependency audit baseline checker positive controls passed"
