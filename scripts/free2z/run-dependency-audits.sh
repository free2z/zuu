#!/usr/bin/env bash
# Free2Z application check: run dependency audits.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
baseline="$repo_root/.github/dependency-audit-baseline.json"
checker="$repo_root/scripts/free2z/check-dependency-audit.py"
python_bin="${PYTHON:-python3}"

# Exit code check-dependency-audit.py reserves for "the scanner produced no
# usable report". Keep in sync with EXIT_INFRASTRUCTURE there.
readonly checker_exit_infrastructure=3

# This script's own exit code for "the scanner could not resolve the dependency
# set". Deliberately NOT 3: 3 means "something outside this repo broke, try
# again", and a monitor or a human reading 3 reasonably re-runs the job. This
# one is fixed by editing a requirements pin (or the interpreter it must match),
# and re-running it forever will never go green.
readonly exit_resolution_failure=4

# Overridable so scripts/free2z/test-run-dependency-audits.sh does not sleep for real.
max_attempts="${DEPENDENCY_AUDIT_ATTEMPTS:-3}"
backoff_seconds="${DEPENDENCY_AUDIT_BACKOFF_SECONDS-5 15}"
scanner_timeout="${DEPENDENCY_AUDIT_SCANNER_TIMEOUT_SECONDS:-180}"
# Settable to '' to exercise the unbounded path in the tests. The worst-case
# schedule this implies MUST fit the job's timeout-minutes in ci.yml with room
# for setup and the final diagnosis, or the retry reproduces the very hard-kill
# it exists to prevent; scripts/free2z/test-run-dependency-audits.sh asserts that
# arithmetic against the workflow file itself.
timeout_bin="${DEPENDENCY_AUDIT_TIMEOUT_BIN-$(command -v timeout || true)}"


# Validate the knobs before running anything. An unvalidated `3x` makes every
# `[ "$attempt" -ge "$max_attempts" ]` return status 2 instead of true, so the
# loop can never terminate and this required job burns to its 20-minute timeout
# with the whole queue behind it. Fail in the first millisecond instead.
fail_configuration() {
  echo "DEPENDENCY AUDIT CONFIGURATION ERROR: $1" >&2
  exit 2
}

npm_project="${NPM_AUDIT_PROJECT:-ts/svelte/free2z}"
npm_only="${DEPENDENCY_AUDIT_NPM_ONLY:-0}"
case "$npm_project" in
  ts/svelte/free2z | ts/react/free2z | docs/about-free2z | docs/free2z/website) ;;
  *) fail_configuration "unregistered application npm project: $npm_project" ;;
esac
case "$npm_only" in
  0 | 1) ;;
  *) fail_configuration 'DEPENDENCY_AUDIT_NPM_ONLY must be 0 or 1' ;;
esac

case "$max_attempts" in
  '' | *[!0-9]*)
    fail_configuration "DEPENDENCY_AUDIT_ATTEMPTS must be a positive integer, got '$max_attempts'"
    ;;
esac
[ "$max_attempts" -ge 1 ] ||
  fail_configuration "DEPENDENCY_AUDIT_ATTEMPTS must be at least 1, got '$max_attempts'"

case "$scanner_timeout" in
  '' | *[!0-9]*)
    fail_configuration "DEPENDENCY_AUDIT_SCANNER_TIMEOUT_SECONDS must be a non-negative integer (0 disables), got '$scanner_timeout'"
    ;;
esac

# shellcheck disable=SC2086 # deliberate word splitting of the delay list
for configured_delay in $backoff_seconds; do
  case "$configured_delay" in
    *[!0-9]*)
      fail_configuration "DEPENDENCY_AUDIT_BACKOFF_SECONDS must be whitespace-separated non-negative integers, got '$backoff_seconds'"
      ;;
  esac
done

npm_report="$(mktemp)"
pip_report="$(mktemp)"
scanner_stderr="$(mktemp)"
trap 'rm -f "$npm_report" "$pip_report" "$scanner_stderr"' EXIT

# A retry only helps if an attempt can END. npm allows a single registry request
# 300s and retries internally, so one blackholed connection can consume the
# whole 20-minute job timeout -- GitHub then kills the job before the
# exhausted-retry diagnosis is ever printed, and the queue is blocked for 20
# minutes with no explanation. Bound each attempt instead: 6 attempts (2
# ecosystems x 3) at 180s plus backoff is ~19 minutes worst case, inside the job
# timeout with room for the diagnosis. `timeout` exits 124, which is outside the
# documented 0/1, so a hang lands in the retryable infrastructure class by
# construction rather than by a second special case.
warn_unbounded_once() {
  # Silently dropping the bound is how a hang comes back. Say so, every run, in
  # the same place the exhausted-retry diagnosis would have appeared.
  [ -z "${unbounded_warned:-}" ] || return 0
  unbounded_warned=1
  echo "DEPENDENCY AUDIT WARNING: timeout(1) is unavailable, so no per-attempt wall-clock bound is enforced." >&2
  echo "A hung scanner will run until the caller (or the CI job timeout) kills it, with no retry and no diagnosis." >&2
}

run_bounded() {
  if [ -z "$timeout_bin" ] || [ "$scanner_timeout" -eq 0 ]; then
    warn_unbounded_once
  fi
  if [ -n "$timeout_bin" ] && [ "$scanner_timeout" -gt 0 ]; then
    # Plain `timeout SECS CMD`: --kill-after/--signal are GNU-only and this
    # script is also run by hand on macOS.
    "$timeout_bin" "$scanner_timeout" "$@"
  else
    "$@"
  fi
}

scan_npm() {
  (
    cd "$repo_root/$npm_project"
    run_bounded npm audit --json
  )
}

scan_pip() {
  # Audit runtime, tests, lock compilers, and language-data generators.
  # Read frozen pins directly: a temporary pip environment can omit tools that
  # its bootstrap already installed. The checker verifies complete lock coverage.
  run_bounded "$python_bin" -m pip_audit \
    -r "$repo_root/py/free2z/requirements/main.txt" \
    -r "$repo_root/py/free2z/requirements/test.txt" \
    -r "$repo_root/py/free2z/requirements/lock-tools.txt" \
    -r "$repo_root/py/free2z/requirements/language-data.txt" \
    --require-hashes \
    --no-deps \
    --disable-pip \
    --format json
}

backoff_for_attempt() {
  # Attempt N waits the Nth configured delay, clamped to the last one. Split via
  # positional parameters rather than an array: `${#arr[@]}` on an empty array
  # is an "unbound variable" error under `set -u` in the bash 3.2 that ships on
  # macOS, which would turn an empty override into a crash mid-outage.
  local attempt="$1"
  # shellcheck disable=SC2086 # deliberate word splitting of the delay list
  set -- $backoff_seconds
  if [ "$#" -eq 0 ]; then
    printf '0'
    return
  fi
  while [ "$attempt" -gt 1 ] && [ "$#" -gt 1 ]; do
    shift
    attempt=$((attempt - 1))
  done
  printf '%s' "$1"
}

# Patterns pip's resolver prints when it gives up:
#
#   Could not find a version that satisfies the requirement ipython==9.17.1
#   No matching distribution found for ipython==9.17.1
#   ResolutionImpossible: ...            (resolvelib's conflict report)
#
# Matched against the CAPTURED stderr file, never as `scanner | grep -q`: under
# `set -o pipefail` the pipeline's status is not grep's, and this repo has
# already shipped tests that passed without testing anything that way.
readonly resolution_give_up_pattern='No matching distribution found|Could not find a version that satisfies|ResolutionImpossible'

readonly resolution_reached_index_pattern='Requires-Python|Ignored the following versions|The conflict is caused by|\(from versions: [0-9]'

# And an explicit veto, because a multi-index run can reach one source and fail
# to reach another. Anything that smells of the network sends it back to the
# retry path: the asymmetry is deliberate. Retrying a deterministic failure
# costs ~40s and still fails closed; NOT retrying a transient one blocks every
# PR behind a required check. When in doubt, retry. Matched case-insensitively
# -- pip, urllib3 and requests each capitalise these differently.
readonly resolution_transient_pattern='retrying \(retry\(|warning: retrying|connection broken|read timed out|readtimeouterror|temporary failure in name resolution|max retries exceeded|connectionerror|service unavailable|[45][0-9][0-9] server error|\(from versions: none\)'

# Echoes the offending requirement (possibly empty -- ResolutionImpossible names
# no single one) and returns 0 when the stderr shows a resolver give-up that is
# unambiguously deterministic.
detect_resolution_failure() {
  local stderr_file="$1" matched extracted transient_evidence reached_index
  [ -s "$stderr_file" ] || return 1
  matched="$(grep -E -- "$resolution_give_up_pattern" "$stderr_file" || true)"
  [ -n "$matched" ] || return 1

  # --- ambiguity guards (mutation target: naive-classification) ---
  transient_evidence="$(grep -Ei -- "$resolution_transient_pattern" "$stderr_file" || true)"
  [ -z "$transient_evidence" ] || return 1
  reached_index="$(grep -E -- "$resolution_reached_index_pattern" "$stderr_file" || true)"
  [ -n "$reached_index" ] || return 1
  # --- end ambiguity guards ---

  # Two `-e` expressions rather than a pipe into `head`: `head` closing the pipe
  # early SIGPIPEs sed, and under pipefail that 141 becomes the substitution's
  # status. Take the first line with a parameter expansion instead.
  extracted="$(
    printf '%s\n' "$matched" | sed -n \
      -e 's/.*No matching distribution found for \([^ ]*\).*/\1/p' \
      -e 's/.*satisfies the requirement \([^ ]*\).*/\1/p'
  )"
  printf '%s' "${extracted%%$'\n'*}"
  return 0
}

report_resolution_failure() {
  local ecosystem="$1" requirement="$2" interpreter_version
  interpreter_version="$("$python_bin" --version 2>&1 || true)"

  echo "DEPENDENCY AUDIT RESOLUTION FAILURE: the $ecosystem scanner could not resolve the dependency set." >&2
  if [ -n "$requirement" ]; then
    echo "Unresolvable requirement: $requirement" >&2
  else
    echo "The resolver reported a conflict it could not satisfy; the stderr above names the packages." >&2
  fi
  echo "The 'no usable report' line above is the symptom: the scanner wrote nothing because it never" >&2
  echo "got past resolution. The cause is deterministic, not a transient outage, so it was NOT retried:" >&2
  echo "the same requirements file read by the same interpreter (${interpreter_version:-unknown})" >&2
  echo "gives the same answer every time." >&2
  if [ "$ecosystem" = pip ]; then
    echo "The audit reads exact locked versions using the interpreter selected by build/free2z/backend.Dockerfile." >&2
    echo "Keep that image and the dependency-security job's Python version aligned for marker evaluation." >&2
    echo "Package installation compatibility is checked separately by the backend and image jobs." >&2
  fi
  echo "No vulnerability conclusion was reached for $ecosystem, so this fails closed." >&2
}

audit_ecosystem() {
  local ecosystem="$1" scanner="$2" report="$3"
  local attempt=1 scanner_status checker_status delay
  local -a inventory_args=()
  if [ "$ecosystem" = pip ]; then
    for lock in main.txt test.txt lock-tools.txt language-data.txt; do
      inventory_args+=(--pip-lock "$repo_root/py/free2z/requirements/$lock")
    done
  fi

  while :; do
    # `set +e`/`set -e` around the scanner because exit 1 is a LEGITIMATE
    # result (findings), not an error to abort on.
    set +e
    "$scanner" >"$report" 2>"$scanner_stderr"
    scanner_status=$?
    set -e

    # Echo every attempt's stderr, labelled, so a real outage is diagnosable
    # from the CI log instead of being swallowed by the retry.
    if [ -s "$scanner_stderr" ]; then
      echo "--- $ecosystem scanner stderr (attempt $attempt/$max_attempts, exit $scanner_status) ---" >&2
      cat "$scanner_stderr" >&2
      echo "--- end $ecosystem scanner stderr ---" >&2
    fi

    set +e
    "$python_bin" "$checker" \
      --ecosystem "$ecosystem" \
      --input "$report" \
      --baseline "$baseline" \
      --scanner-exit "$scanner_status" \
      ${inventory_args[@]+"${inventory_args[@]}"}
    checker_status=$?
    set -e

    if [ "$checker_status" -eq 0 ]; then
      return 0
    fi

    if [ "$checker_status" -ne "$checker_exit_infrastructure" ]; then
      # A real result the checker rejected. Not retried, not softened.
      return "$checker_status"
    fi

    # Gated on the checker having already said "infrastructure", so the branch
    # above -- a real finding, never retried, always fatal -- is untouched by
    # this classification. A resolver give-up cannot be re-decided by trying
    # again, so it costs one attempt, not three.
    if resolution_requirement="$(detect_resolution_failure "$scanner_stderr")"; then
      report_resolution_failure "$ecosystem" "$resolution_requirement"
      return "$exit_resolution_failure"
    fi

    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "DEPENDENCY AUDIT INFRASTRUCTURE FAILURE: the $ecosystem scanner produced no usable report in $max_attempts attempt(s)." >&2
      echo "This is NOT a clean audit and NOT a findings report: no vulnerability conclusion was reached for $ecosystem." >&2
      echo "The scanner stderr above is the evidence for what actually broke." >&2
      # An ambiguous resolver give-up lands here on purpose -- "(from versions:
      # none)" is equally consistent with a dead index and with a package that
      # simply does not exist, and the safe guess is "retry". But after the
      # retries are spent, "infrastructure failure" alone sends the reader back
      # to the re-run button for a typo'd or withdrawn pin, which is the exact
      # misdiagnosis this change exists to end. Name the other possibility.
      if [ -n "$(grep -E -- "$resolution_give_up_pattern" "$scanner_stderr" || true)" ]; then
        echo "NOTE: every attempt ended with the resolver giving up. If the index is healthy, this is a" >&2
        echo "bad requirement -- a typo, a withdrawn release, or a pin that exists on no index this run" >&2
        echo "can reach -- and re-running will not change it. Check the requirement before the registry." >&2
      fi
      return "$checker_exit_infrastructure"
    fi

    delay="$(backoff_for_attempt "$attempt")"
    echo "$ecosystem audit attempt $attempt/$max_attempts hit an infrastructure failure; retrying in ${delay}s." >&2
    sleep "$delay"
    attempt=$((attempt + 1))
  done
}

audit_ecosystem npm scan_npm "$npm_report"
if [ "$npm_only" = 0 ]; then
  audit_ecosystem pip scan_pip "$pip_report"
fi
