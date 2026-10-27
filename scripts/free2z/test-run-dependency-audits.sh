#!/usr/bin/env bash
# Free2Z application check: test run dependency audits.
set -uo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

scratch="$(mktemp -d)"
[ -n "${scratch}" ] && [ -d "${scratch}" ] || { echo "mktemp -d failed" >&2; exit 1; }
cleanup() { [ -n "${scratch}" ] && rm -rf "${scratch}"; }
trap cleanup EXIT

real_python="$(command -v python3)"
[ -n "${real_python}" ] || { echo "python3 is required" >&2; exit 1; }

# ---------------------------------------------------------------------------
# A throwaway repo laid out exactly as the script expects, so it resolves its
# own repo_root, baseline and checker the same way it does in CI.
# ---------------------------------------------------------------------------
repo="${scratch}/repo"
mkdir -p "${repo}/scripts/free2z" "${repo}/.github" "${repo}/ts/svelte/free2z" "${repo}/py/free2z/requirements"
cp "${SOURCE_DIR}/run-dependency-audits.sh" "${repo}/scripts/free2z/"
cp "${SOURCE_DIR}/check-dependency-audit.py" "${repo}/scripts/free2z/"
: > "${repo}/py/free2z/requirements/main.txt"
: > "${repo}/py/free2z/requirements/language-data.txt"
: > "${repo}/py/free2z/requirements/test.txt"
: > "${repo}/py/free2z/requirements/lock-tools.txt"

cat > "${repo}/.github/dependency-audit-baseline.json" <<'JSON'
{
  "schema_version": 1,
  "findings": [
    {
      "ecosystem": "npm",
      "package": "known-package",
      "advisory": "GHSA-1111-2222-3333",
      "rationale": "Fixture for scripts/free2z/test-run-dependency-audits.sh.",
      "reachability": "fixture only",
      "follow_up": "Remove with the fixture.",
      "expires": "2099-01-01"
    },
    {
      "ecosystem": "pip",
      "package": "fixture-pkg",
      "advisory": "GHSA-AAAA-BBBB-CCCC",
      "rationale": "Fixture for scripts/free2z/test-run-dependency-audits.sh.",
      "reachability": "fixture only",
      "follow_up": "Remove with the fixture.",
      "expires": "2099-01-01"
    }
  ]
}
JSON

# ---------------------------------------------------------------------------
# Stub scanners. Each appends one line per invocation to its counter file
# BEFORE doing anything else, so a crash cannot lose a call.
#
# The transient shapes are the ones actually observed on 2026-09-04: npm exits
# 1 -- the same status a genuine findings run exits -- and emits an error object
# instead of `vulnerabilities`. Any classifier that looks only at the exit code
# either retries real findings or never retries the outage.
# ---------------------------------------------------------------------------
stub="${scratch}/stub"
mkdir -p "${stub}"

cat > "${stub}/npm" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
echo "npm $*" >> "${NPM_CALLS}"
attempt="$(wc -l < "${NPM_CALLS}" | tr -d '[:space:]')"

emit_clean() { echo '{"vulnerabilities":{}}'; exit 0; }
emit_unbaselined() {
  echo '{"vulnerabilities":{"evil-package":{"via":[{"name":"evil-package","url":"https://github.com/advisories/GHSA-9999-8888-7777"}]}}}'
  exit 1
}
emit_baselined() {
  echo '{"vulnerabilities":{"known-package":{"via":[{"name":"known-package","url":"https://github.com/advisories/GHSA-1111-2222-3333"}]}}}'
  exit 1
}
emit_transient() {
  echo 'npm warn audit network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk' >&2
  echo 'npm error audit endpoint returned an error' >&2
  echo '{"error":{"code":"E503","summary":"503 Service Unavailable"}}'
  exit 1
}

case "${NPM_BEHAVIOUR}" in
  clean) emit_clean ;;
  unbaselined) emit_unbaselined ;;
  baselined) emit_baselined ;;
  transient) emit_transient ;;
  transient-then-clean)
    if [ "${attempt}" -le 1 ]; then emit_transient; fi
    emit_clean ;;
  transient-then-unbaselined)
    if [ "${attempt}" -le 1 ]; then emit_transient; fi
    emit_unbaselined ;;
  killed)
    # Valid JSON, undocumented exit status (SIGKILL'd runner step). No exit
    # code outside 0/1 is a result, whatever the report says.
    echo '{"vulnerabilities":{}}'
    exit 137 ;;
  truncated)
    # Killed mid-write: the report stops inside a multi-byte character, so it
    # is not even valid UTF-8. Still infrastructure, still retryable.
    printf '{"vulnerabilities": {"pkg\xff\xfe'
    exit 137 ;;
  hangs)
    # A blackholed connection: npm never returns. Without a per-attempt bound
    # this consumes the whole job timeout and the retry never gets to report.
    # 20s, not minutes: long enough that a 1s bound must fire first, short
    # enough that a REGRESSION shows up as a slow red suite rather than one
    # that hangs until CI kills it.
    exec sleep 20 ;;
  *) echo "unknown NPM_BEHAVIOUR ${NPM_BEHAVIOUR}" >&2; exit 99 ;;
esac
STUB
chmod +x "${stub}/npm"

# The wrapper reaches pip-audit as `$PYTHON -m pip_audit`, and uses the same
# $PYTHON to run the checker. This shim intercepts only the former and hands
# everything else to the real interpreter, so the checker under test is the
# real one.
cat > "${stub}/pyshim" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
if [ "${1:-}" = "-m" ] && [ "${2:-}" = "pip_audit" ]; then
  for lock in main.txt test.txt lock-tools.txt language-data.txt; do
    [[ " $* " == *"/requirements/$lock "* ]] || { echo "missing audited lock $lock" >&2; exit 99; }
  done
  [[ " $* " == *" --require-hashes "* && " $* " == *" --no-deps "* ]] || exit 99
  echo "pip_audit $*" >> "${PIP_CALLS}"
  attempt="$(wc -l < "${PIP_CALLS}" | tr -d '[:space:]')"

  emit_clean() { echo '{"dependencies":[]}'; exit 0; }
  emit_unbaselined() {
    echo '{"dependencies":[{"name":"evilpkg","vulns":[{"id":"PYSEC-2099-9999","aliases":["GHSA-9999-8888-7777"]}]}]}'
    exit 1
  }
  emit_baselined() {
    # Fixture_Pkg vs the baseline's fixture-pkg also exercises PEP 503 naming.
    echo '{"dependencies":[{"name":"Fixture_Pkg","vulns":[{"id":"PYSEC-2099-1111","aliases":["GHSA-AAAA-BBBB-CCCC"]}]}]}'
    exit 1
  }
  emit_transient() {
    echo 'WARNING: Error fetching OSV: HTTPSConnectionPool(host=api.osv.dev) read timed out' >&2
    echo '{"error":"503 Service Unavailable"}'
    exit 1
  }
  emit_unresolvable() {
    echo 'ERROR: Ignored the following versions that require a different python version: 9.17.1 Requires-Python >=3.11' >&2
    echo 'ERROR: Could not find a version that satisfies the requirement foo==9.9.9 (from versions: 1.0.0, 2.0.0)' >&2
    echo 'ERROR: No matching distribution found for foo==9.9.9' >&2
    exit 1
  }
  # resolvelib's conflict report names no single requirement. pip renders the
  # conflict tree whenever it really did collect candidates -- that tree, not
  # the exception name, is what proves resolution ran to completion.
  emit_resolution_impossible() {
    echo 'ERROR: Cannot install foo==9.9.9 and bar==2.0 because these package versions have conflicting dependencies.' >&2
    echo '' >&2
    echo 'The conflict is caused by:' >&2
    echo '    The user requested foo==9.9.9' >&2
    echo '    bar 2.0 depends on foo<9.0' >&2
    echo '' >&2
    echo 'ERROR: ResolutionImpossible: for help visit https://pip.pypa.io/en/latest/topics/dependency-resolution/' >&2
    exit 1
  }
  # The token with nothing behind it. `ResolutionImpossible` must not be its own
  # proof that an index was reached, or incomplete index data fast-fails the
  # required job on attempt one.
  emit_bare_resolution_impossible() {
    echo 'ERROR: ResolutionImpossible: for help visit https://pip.pypa.io/en/latest/topics/dependency-resolution/' >&2
    exit 1
  }
  # THE TRAP. pip prints the identical give-up epilogue when it could not FETCH
  # an index page: it retries, drops that source, sees zero candidates, and
  # says "Could not find a version that satisfies". Classifying on that wording
  # alone converts a registry blip into a red required check that is never
  # retried -- the exact outage the retry exists for. Note "(from versions:
  # none)": pip never got a list.
  emit_transient_with_resolver_epilogue() {
    echo 'WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by NewConnectionError' >&2
    echo 'ERROR: Could not find a version that satisfies the requirement foo==9.9.9 (from versions: none)' >&2
    echo 'ERROR: No matching distribution found for foo==9.9.9' >&2
    exit 1
  }
  # The same trap without the retry banner -- only the empty candidate list
  # survives to stderr. Still ambiguous, still must be retried.
  emit_empty_index_epilogue() {
    echo 'ERROR: Could not find a version that satisfies the requirement foo==9.9.9 (from versions: none)' >&2
    echo 'ERROR: No matching distribution found for foo==9.9.9' >&2
    exit 1
  }

  case "${PIP_BEHAVIOUR}" in
    clean) emit_clean ;;
    unbaselined) emit_unbaselined ;;
    baselined) emit_baselined ;;
    transient) emit_transient ;;
    unresolvable) emit_unresolvable ;;
    resolution-impossible) emit_resolution_impossible ;;
    bare-resolution-impossible) emit_bare_resolution_impossible ;;
    transient-resolver-epilogue) emit_transient_with_resolver_epilogue ;;
    empty-index-epilogue) emit_empty_index_epilogue ;;
    transient-epilogue-then-clean)
      if [ "${attempt}" -le 1 ]; then emit_transient_with_resolver_epilogue; fi
      emit_clean ;;
    transient-then-clean)
      if [ "${attempt}" -le 1 ]; then emit_transient; fi
      emit_clean ;;
    transient-then-unbaselined)
      if [ "${attempt}" -le 1 ]; then emit_transient; fi
      emit_unbaselined ;;
    killed)
      echo '{"dependencies":[]}'
      exit 137 ;;
    truncated)
      printf '{"dependencies": [{"name": "pkg\xff\xfe'
      exit 137 ;;
    hangs)
      exec sleep 20 ;;
    *) echo "unknown PIP_BEHAVIOUR ${PIP_BEHAVIOUR}" >&2; exit 99 ;;
  esac
fi
exec "${REAL_PYTHON}" "$@"
STUB
chmod +x "${stub}/pyshim"

# ---------------------------------------------------------------------------
# Assertions. Note the deliberate absence of `something | grep -q`: under
# `set -o pipefail` a pipeline reports the LAST command's status but the whole
# pipeline's failure can mask which half failed, and this repo has shipped two
# tests that passed without testing anything that way. Everything below matches
# against a FILE or a captured variable.
# ---------------------------------------------------------------------------
RC=0
OUT=""
NPM_CALLS=""
PIP_CALLS=""

# Which copy of the script under test run_audits should execute. Every case
# uses the real one; the negative-control section below points this at a
# deliberately broken copy and points it back afterwards.
AUDIT_REPO="${repo}"

run_audits() {
  local tag="$1" npm_behaviour="$2" pip_behaviour="$3"
  shift 3
  NPM_CALLS="${scratch}/${tag}.npm.calls"
  PIP_CALLS="${scratch}/${tag}.pip.calls"
  OUT="${scratch}/${tag}.out"
  : > "${NPM_CALLS}"
  : > "${PIP_CALLS}"
  env \
    PATH="${stub}:${PATH}" \
    PYTHON="${stub}/pyshim" \
    REAL_PYTHON="${real_python}" \
    NPM_BEHAVIOUR="${npm_behaviour}" \
    PIP_BEHAVIOUR="${pip_behaviour}" \
    NPM_CALLS="${NPM_CALLS}" \
    PIP_CALLS="${PIP_CALLS}" \
    DEPENDENCY_AUDIT_BACKOFF_SECONDS="0 0" \
    "$@" \
    bash "${AUDIT_REPO}/scripts/free2z/run-dependency-audits.sh" > "${OUT}" 2>&1
  RC=$?
}

pass() { echo "  ok   $1"; PASS=$((PASS + 1)); }
fail() {
  echo "  FAIL $1"
  shift
  [ "$#" -eq 0 ] || sed 's/^/       | /' "$1"
  FAIL=$((FAIL + 1))
}

check_exit() {
  local name="$1" want="$2"
  if [ "${RC}" = "${want}" ]; then
    pass "${name} (exit ${RC})"
  else
    fail "${name}: expected exit ${want}, got ${RC}" "${OUT}"
  fi
}

check_calls() {
  local name="$1" file="$2" want="$3" got
  got="$(wc -l < "${file}" | tr -d '[:space:]')"
  if [ "${got}" = "${want}" ]; then
    pass "${name}: invoked ${got}x"
  else
    fail "${name}: expected ${want} invocation(s), got ${got}" "${OUT}"
  fi
}

expect_in() {
  local name="$1" pattern="$2"
  if grep -qF -- "${pattern}" "${OUT}"; then
    pass "${name}"
  else
    fail "${name}: output did not contain '${pattern}'" "${OUT}"
  fi
}

refute_in() {
  local name="$1" pattern="$2"
  if grep -qF -- "${pattern}" "${OUT}"; then
    fail "${name}: output unexpectedly contained '${pattern}'" "${OUT}"
  else
    pass "${name}"
  fi
}

echo "run-dependency-audits.sh retry contract"

# --- npm -------------------------------------------------------------------
echo "- npm: a clean audit is a RESULT, used once"
run_audits npm-clean clean clean
check_exit "clean run passes" 0
check_calls "npm" "${NPM_CALLS}" 1
check_calls "pip" "${PIP_CALLS}" 1
expect_in "  reports an accepted npm audit" "accepted 0 exact npm advisory finding(s)"

echo "- npm: a real finding still fails, and is NEVER re-run"
run_audits npm-finding unbaselined clean
check_exit "unbaselined finding fails" 1
check_calls "npm" "${NPM_CALLS}" 1
check_calls "pip (never reached)" "${PIP_CALLS}" 0
expect_in "  names the advisory" "UNBASELINED npm evil-package GHSA-9999-8888-7777"
refute_in "  not mislabelled as infrastructure" "INFRASTRUCTURE FAILURE"

echo "- npm: an exactly baselined finding still passes, once"
run_audits npm-baselined baselined clean
check_exit "baselined finding passes" 0
check_calls "npm" "${NPM_CALLS}" 1
expect_in "  accepted against the baseline" "accepted 1 exact npm advisory finding(s)"

echo "- npm: a transient failure is retried"
run_audits npm-flaky transient-then-clean clean
check_exit "second attempt succeeds" 0
check_calls "npm" "${NPM_CALLS}" 2
check_calls "pip" "${PIP_CALLS}" 1
expect_in "  the outage stays diagnosable in the log" "registry.npmjs.org"
expect_in "  labelled by attempt" "attempt 1/3"

echo "- npm: a retry must not swallow the finding it uncovers"
run_audits npm-flaky-finding transient-then-unbaselined clean
check_exit "finding on attempt 2 still fails" 1
check_calls "npm" "${NPM_CALLS}" 2
expect_in "  names the advisory" "UNBASELINED npm evil-package GHSA-9999-8888-7777"

echo "- npm: a total outage FAILS -- it is never a clean audit"
run_audits npm-outage transient clean
check_exit "exhausted attempts fail" 3
check_calls "npm" "${NPM_CALLS}" 3
check_calls "pip (never reached)" "${PIP_CALLS}" 0
expect_in "  says infrastructure" "INFRASTRUCTURE FAILURE: the npm scanner produced no usable report in 3 attempt(s)"
expect_in "  refuses to imply a conclusion" "no vulnerability conclusion was reached for npm"
refute_in "  never claims an accepted audit" "Dependency audit accepted"

echo "- npm: an exit status outside the documented 0/1 is infrastructure"
run_audits npm-killed killed clean
check_exit "exit 137 with valid JSON" 3
check_calls "npm" "${NPM_CALLS}" 3
expect_in "  names the operational error" "scanner operational error: exit 137"

# --- pip -------------------------------------------------------------------
echo "- pip: a clean audit is a RESULT, used once"
run_audits pip-clean clean clean
check_exit "clean run passes" 0
check_calls "pip" "${PIP_CALLS}" 1
expect_in "  reports an accepted pip audit" "accepted 0 exact pip advisory finding(s)"

echo "- pip: a real finding still fails, and is NEVER re-run"
run_audits pip-finding clean unbaselined
check_exit "unbaselined finding fails" 1
check_calls "npm" "${NPM_CALLS}" 1
check_calls "pip" "${PIP_CALLS}" 1
expect_in "  names the advisory" "UNBASELINED pip evilpkg GHSA-9999-8888-7777"
refute_in "  not mislabelled as infrastructure" "INFRASTRUCTURE FAILURE"

echo "- pip: an exactly baselined finding still passes, once"
run_audits pip-baselined clean baselined
check_exit "baselined finding passes" 0
check_calls "pip" "${PIP_CALLS}" 1
expect_in "  accepted against the baseline" "accepted 1 exact pip advisory finding(s)"

echo "- pip: a transient failure is retried"
run_audits pip-flaky clean transient-then-clean
check_exit "second attempt succeeds" 0
check_calls "pip" "${PIP_CALLS}" 2
expect_in "  the outage stays diagnosable in the log" "Error fetching OSV"

echo "- pip: a retry must not swallow the finding it uncovers"
run_audits pip-flaky-finding clean transient-then-unbaselined
check_exit "finding on attempt 2 still fails" 1
check_calls "pip" "${PIP_CALLS}" 2
expect_in "  names the advisory" "UNBASELINED pip evilpkg GHSA-9999-8888-7777"

echo "- pip: a total outage FAILS -- it is never a clean audit"
run_audits pip-outage clean transient
check_exit "exhausted attempts fail" 3
check_calls "pip" "${PIP_CALLS}" 3
expect_in "  says infrastructure" "INFRASTRUCTURE FAILURE: the pip scanner produced no usable report in 3 attempt(s)"
expect_in "  refuses to imply a conclusion" "no vulnerability conclusion was reached for pip"
refute_in "  never claims an accepted pip audit" "accepted 0 exact pip advisory"

echo "- pip: an exit status outside the documented 0/1 is infrastructure"
run_audits pip-killed clean killed
check_exit "exit 137 with valid JSON" 3
check_calls "pip" "${PIP_CALLS}" 3

echo "- pip: an unresolvable requirement is diagnosed, not retried"
run_audits pip-unresolvable clean unresolvable
check_exit "fails closed with the resolution code" 4
check_calls "pip" "${PIP_CALLS}" 1
check_calls "npm (ran first, cleanly)" "${NPM_CALLS}" 1
expect_in "  names the class" "RESOLUTION FAILURE: the pip scanner could not resolve the dependency set"
expect_in "  names the requirement" "Unresolvable requirement: foo==9.9.9"
expect_in "  says it was deliberately not retried" "was NOT retried"
expect_in "  points at the interpreter the pin must satisfy" "build/free2z/backend.Dockerfile"
expect_in "  still refuses to imply a conclusion" "No vulnerability conclusion was reached for pip"
refute_in "  NOT mislabelled as an outage" "INFRASTRUCTURE FAILURE: the pip scanner produced no usable report"
refute_in "  never claims an accepted audit" "accepted 0 exact pip advisory"

echo "- pip: a resolver conflict with no single culprit is still diagnosed"
run_audits pip-resolution-impossible clean resolution-impossible
check_exit "fails closed with the resolution code" 4
check_calls "pip" "${PIP_CALLS}" 1
expect_in "  admits it cannot name one requirement" "reported a conflict it could not satisfy"
refute_in "  does not print an empty requirement line" "Unresolvable requirement: "

echo "- pip: a BARE ResolutionImpossible is not its own evidence, so it is retried"
run_audits pip-bare-resolution-impossible clean bare-resolution-impossible
check_exit "retried and failed as infrastructure" 3
check_calls "pip" "${PIP_CALLS}" 3
refute_in "  NOT fast-failed on the exception name alone" "RESOLUTION FAILURE"
expect_in "  but the exhausted verdict still names a bad requirement" "If the index is healthy, this is a"

echo "- pip: a fetch failure wearing the resolver's epilogue is STILL retried"
run_audits pip-transient-epilogue clean transient-resolver-epilogue
check_exit "retried and failed as infrastructure, not resolution" 3
check_calls "pip" "${PIP_CALLS}" 3
expect_in "  classified as an outage" "INFRASTRUCTURE FAILURE: the pip scanner produced no usable report in 3 attempt(s)"
refute_in "  NOT fast-failed as a resolution failure" "RESOLUTION FAILURE"

echo "- pip: an empty candidate list alone is ambiguous, so it is retried"
run_audits pip-empty-index clean empty-index-epilogue
check_exit "retried and failed as infrastructure" 3
check_calls "pip" "${PIP_CALLS}" 3
refute_in "  NOT fast-failed as a resolution failure" "RESOLUTION FAILURE"
# A typo'd or withdrawn pin produces exactly this shape on a perfectly healthy
# index. Retrying it is the right call (we cannot tell it apart from a dead
# index), but the exhausted verdict must not send the reader to the re-run
# button and nowhere else.
expect_in "  still names the other possibility" "If the index is healthy, this is a"
expect_in "  and says re-running will not help" "re-running will not change it"

echo "- but a plain outage is not told to go looking for a bad requirement"
run_audits pip-plain-outage clean transient
check_exit "exhausted attempts fail" 3
refute_in "  no resolver hint on a pure fetch failure" "If the index is healthy, this is a"

echo "- pip: and that retry still recovers when the index comes back"
run_audits pip-transient-epilogue-recovers clean transient-epilogue-then-clean
check_exit "second attempt succeeds" 0
check_calls "pip" "${PIP_CALLS}" 2

# --- the attempt bound is real --------------------------------------------
echo "- the attempt count is bounded and configurable"
run_audits npm-two-attempts transient clean DEPENDENCY_AUDIT_ATTEMPTS=2
check_exit "two attempts, then fail" 3
check_calls "npm" "${NPM_CALLS}" 2
expect_in "  reports the configured bound" "no usable report in 2 attempt(s)"

echo "- a report truncated mid-write is infrastructure, not a rejected audit"
# UnicodeDecodeError is neither JSONDecodeError nor OSError. Uncaught it exits
# 1, and exit 1 is the status this loop must never retry -- so an interrupted
# download would have failed the queue on the first attempt.
run_audits npm-truncated truncated clean
check_exit "npm truncated report" 3
check_calls "npm" "${NPM_CALLS}" 3
expect_in "  names the encoding failure" "is not valid UTF-8"
run_audits pip-truncated clean truncated
check_exit "pip truncated report" 3
check_calls "pip" "${PIP_CALLS}" 3
expect_in "  names the encoding failure" "is not valid UTF-8"

echo "- a bad retry knob fails immediately, not at the job timeout"
# `[ 1 -ge 3x ]` returns status 2, not false, so an unvalidated typo makes the
# bound unreachable and burns the required job's 20 minutes with the queue
# behind it.
run_audits attempts-nonnumeric clean clean DEPENDENCY_AUDIT_ATTEMPTS=3x
check_exit "non-numeric attempts" 2
check_calls "npm (never started)" "${NPM_CALLS}" 0
expect_in "  names the variable" "DEPENDENCY_AUDIT_ATTEMPTS must be a positive integer"
run_audits attempts-zero clean clean DEPENDENCY_AUDIT_ATTEMPTS=0
check_exit "zero attempts" 2
check_calls "npm (never started)" "${NPM_CALLS}" 0
expect_in "  refuses a bound no attempt can meet" "must be at least 1"
run_audits backoff-nonnumeric clean clean DEPENDENCY_AUDIT_BACKOFF_SECONDS="5 soon"
check_exit "non-numeric backoff" 2
check_calls "npm (never started)" "${NPM_CALLS}" 0
expect_in "  names the variable" "DEPENDENCY_AUDIT_BACKOFF_SECONDS must be"

echo "- a HUNG scanner is bounded per attempt, not by the job timeout"
if [ -n "$(command -v timeout || true)" ]; then
  # `timeout` exits 124 -- outside the documented 0/1 -- so a hang lands in the
  # retryable infrastructure class by construction. This whole case would
  # otherwise take 120s per attempt; if it ever hangs again, it hangs here
  # instead of in the required job with the queue behind it.
  run_audits npm-hangs hangs clean DEPENDENCY_AUDIT_SCANNER_TIMEOUT_SECONDS=1
  check_exit "npm hangs" 3
  check_calls "npm" "${NPM_CALLS}" 3
  # The killed scanner leaves an EMPTY report, so the JSON parse fails before
  # the exit-124 status is ever examined. Both are infrastructure; assert the
  # classification, not which check happened to notice first.
  expect_in "  classified as infrastructure" "no vulnerability conclusion was reached for npm"
  refute_in "  never claims an accepted audit" "Dependency audit accepted"
  run_audits pip-hangs clean hangs DEPENDENCY_AUDIT_SCANNER_TIMEOUT_SECONDS=1
  check_exit "pip hangs" 3
  check_calls "pip" "${PIP_CALLS}" 3
else
  echo "  skip timeout(1) is unavailable on this host"
fi
echo "- with no timeout(1), the missing bound is announced, not silent"
# Previously this case was SKIPPED wherever timeout(1) was absent -- the one
# environment where the contract is not upheld was the one nobody tested. The
# empty override forces that path on every host.
run_audits no-timeout-bin clean clean DEPENDENCY_AUDIT_TIMEOUT_BIN=
check_exit "still audits" 0
expect_in "  says the bound is gone" "timeout(1) is unavailable"
expect_in "  says what that costs" "no retry and no diagnosis"

run_audits timeout-nonnumeric clean clean DEPENDENCY_AUDIT_SCANNER_TIMEOUT_SECONDS=soon
check_exit "non-numeric scanner timeout" 2
check_calls "npm (never started)" "${NPM_CALLS}" 0
expect_in "  names the variable" "DEPENDENCY_AUDIT_SCANNER_TIMEOUT_SECONDS must be"

echo "- the worst-case retry schedule fits the CI job's own timeout"
# The retry can otherwise reproduce the hard kill it was added to prevent: 6
# attempts at the default bound plus backoff must leave room for checkout,
# Node/Python setup, installing pip-audit, both contract suites AND the final
# diagnosis. Read from the script and the workflow so the two cannot drift.
budget_report="$(
  "${real_python}" - "${SOURCE_DIR}/run-dependency-audits.sh" "${SOURCE_DIR}/../../.github/workflows/free2z-web-ci.yml" <<'PYBUDGET'
import re
import sys

script = open(sys.argv[1], encoding="utf-8").read()
workflow = open(sys.argv[2], encoding="utf-8").read()


def default(name, text):
    match = re.search(r"\$\{" + name + r":?-([^}]*)\}", text)
    if not match:
        print(f"FAIL could not read {name} default from the script")
        raise SystemExit(0)
    return match.group(1)


attempts = int(default("DEPENDENCY_AUDIT_ATTEMPTS", script))
per_attempt = int(default("DEPENDENCY_AUDIT_SCANNER_TIMEOUT_SECONDS", script))
backoffs = [int(value) for value in default("DEPENDENCY_AUDIT_BACKOFF_SECONDS", script).split()]

block = re.search(
    r"^  dependency-security:\n(?:.*\n)*?^    timeout-minutes: (\d+)$",
    workflow,
    re.MULTILINE,
)
if not block:
    print("FAIL could not read dependency-security timeout-minutes from ci.yml")
    raise SystemExit(0)
job_budget = int(block.group(1)) * 60

# Two ecosystems, each burning every attempt and every backoff it can reach.
waits = sum(backoffs[: attempts - 1]) if attempts > 1 else 0
worst = 2 * (attempts * per_attempt + waits)
# Measured setup on this job (checkout + Node + Python + pip-audit + both
# contract suites) is well under 5 minutes; reserve that plus a margin.
reserve = 420
if worst + reserve > job_budget:
    print(
        f"FAIL worst case {worst}s + {reserve}s reserve exceeds the "
        f"{job_budget}s job budget: the retry can reproduce the hard kill"
    )
else:
    print(f"OK worst case {worst}s + {reserve}s reserve fits the {job_budget}s job budget")
PYBUDGET
)"
case "${budget_report}" in
  "OK "*) pass "retry schedule fits the job timeout (${budget_report#OK })" ;;
  *) echo "  FAIL ${budget_report}"; FAIL=$((FAIL + 1)) ;;
esac

mutate_repo() {
  # Separate `local` statements: bash expands the whole assignment list before
  # any of it is bound, so `local a=$1 b=${a}` reads an UNSET a and dies under
  # `set -u`.
  local name="$1"
  local code="$2"
  local mutant="${scratch}/mutant-${name}"
  rm -rf "${mutant}"
  cp -R "${repo}" "${mutant}"
  "${real_python}" - "${mutant}/scripts/free2z/run-dependency-audits.sh" "${code}" <<'PYMUT'
import sys

path, code = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
block = """    if resolution_requirement="$(detect_resolution_failure "$scanner_stderr")"; then
      report_resolution_failure "$ecosystem" "$resolution_requirement"
      return "$exit_resolution_failure"
    fi

"""
guard_start = "  # --- ambiguity guards (mutation target: naive-classification) ---\n"
guard_end = "  # --- end ambiguity guards ---\n"

if code == "remove-classification":
    if block not in text:
        raise SystemExit("MUTATION TARGET MISSING: the classification block")
    text = text.replace(block, "", 1)
elif code == "naive-classification":
    start = text.find(guard_start)
    end = text.find(guard_end)
    if start == -1 or end == -1:
        raise SystemExit("MUTATION TARGET MISSING: the ambiguity guards")
    text = text[:start] + text[end + len(guard_end):]
else:
    raise SystemExit(f"unknown mutation {code}")

open(path, "w", encoding="utf-8").write(text)
PYMUT
  printf '%s' "${mutant}"
}

check_mutant_fails() {
  # A mutant that still behaves correctly means the assertion above proves
  # nothing. Report THAT as a failure of this suite.
  local name="$1" ok="$2"
  if [ "${ok}" = "yes" ]; then
    pass "negative control: ${name}"
  else
    fail "negative control did NOT fail: ${name} -- the assertion it guards is vacuous" "${OUT}"
  fi
}

echo "- negative control: without the classification, a resolution failure burns 3 attempts"
mutant_no_class="$(mutate_repo no-class remove-classification)" ||
  { echo "  FAIL could not build the no-class mutant"; FAIL=$((FAIL + 1)); }
AUDIT_REPO="${mutant_no_class}"
run_audits mutant-no-class clean unresolvable
control_ok=no
control_pip_calls="$(wc -l < "${PIP_CALLS}" | tr -d '[:space:]')"
if [ "${RC}" = "3" ] && [ "${control_pip_calls}" = "3" ]; then control_ok=yes; fi
check_mutant_fails "reverting the classification restores 3 attempts + exit 3 (got ${control_pip_calls} attempt(s), exit ${RC})" "${control_ok}"

echo "- negative control: without the ambiguity guards, a fetch failure stops being retried"
mutant_naive="$(mutate_repo naive naive-classification)" ||
  { echo "  FAIL could not build the naive mutant"; FAIL=$((FAIL + 1)); }
AUDIT_REPO="${mutant_naive}"
run_audits mutant-naive clean transient-resolver-epilogue
control_ok=no
control_pip_calls="$(wc -l < "${PIP_CALLS}" | tr -d '[:space:]')"
if [ "${RC}" = "4" ] && [ "${control_pip_calls}" = "1" ]; then control_ok=yes; fi
check_mutant_fails "classifying on the wording alone kills the retry a real outage needs (got ${control_pip_calls} attempt(s), exit ${RC})" "${control_ok}"

run_audits mutant-naive-real clean unresolvable
control_ok=no
control_pip_calls="$(wc -l < "${PIP_CALLS}" | tr -d '[:space:]')"
if [ "${RC}" = "4" ] && [ "${control_pip_calls}" = "1" ]; then control_ok=yes; fi
check_mutant_fails "the mutant still fast-fails the genuine case, so the control isolates the guards (got ${control_pip_calls} attempt(s), exit ${RC})" "${control_ok}"

AUDIT_REPO="${repo}"

echo "- the real script retries that same transient, and passes"
run_audits post-control-transient clean transient-then-clean
check_exit "unmutated script recovers" 0
check_calls "pip" "${PIP_CALLS}" 2

if "${real_python}" "${SOURCE_DIR}/check-ci-contract.py" && "${real_python}" -m unittest discover -s "${SOURCE_DIR}/tests" -p 'test_ci_contract.py'; then
  pass 'runtime Python, audit interpreter, lint target and source selection agree; negative controls reject drift'
else
  FAIL=$((FAIL + 1))
fi
echo "${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
