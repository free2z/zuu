#!/usr/bin/env bash
# Free2Z application check: test ci backend pytest.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/free2z/ci-backend-pytest.sh"
WORKFLOW="${REPO_ROOT}/.github/workflows/free2z-web-ci.yml"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

APP_DIR="${WORK}/py"
mkdir -p "${APP_DIR}"

# Stands in for `python -m pytest --durations=25`. Records its argv (so we can
# prove the real command reaches the runner), sleeps for STUB_SLEEP, exits
# STUB_RC.
STUB="${WORK}/fake-pytest.sh"
cat >"${STUB}" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >"${STUB_ARGV_LOG}"
printf '%s\n' "$PWD" >"${STUB_CWD_LOG}"
sleep "${STUB_SLEEP:-0}"
exit "${STUB_RC:-0}"
EOF
chmod +x "${STUB}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# The TIME CAP claim is made in exactly the two places a reader sees at a
# glance: the ::error annotation TITLE and the step-summary heading. Assert on
# those rather than on the phrase anywhere in the text -- the SIGKILL message
# legitimately contains the words "not a time cap", and a loose grep flags it.
assert_no_time_cap_claim() {
  grep -q '::error title=TIME CAP' "${out}" &&
    fail "$1 (annotation title claims a TIME CAP)"
  grep -q 'TIME CAP EXCEEDED' "${summary_file}" &&
    fail "$1 (step summary claims a TIME CAP)"
  return 0
}

# run <name> -- sets globals rc/out/err/summary_file/argv_log for assertions.
run() {
  local name="$1"
  shift
  out="${WORK}/${name}.out"
  err="${WORK}/${name}.err"
  summary_file="${WORK}/${name}.summary"
  argv_log="${WORK}/${name}.argv"
  cwd_log="${WORK}/${name}.cwd"
  : >"${summary_file}"
  : >"${argv_log}"
  : >"${cwd_log}"
  set +e
  env "$@" \
    BACKEND_APP_DIR="${APP_DIR}" \
    BACKEND_TEST_COMMAND="${STUB} -m pytest --durations=25" \
    STUB_ARGV_LOG="${argv_log}" \
    STUB_CWD_LOG="${cwd_log}" \
    GITHUB_STEP_SUMMARY="${summary_file}" \
    "${SCRIPT}" >"${out}" 2>"${err}"
  rc=$?
  set -e
}

# ---------------------------------------------------------------------------
# 1. A passing run, comfortably inside budget. It must stay green, report its
#    usage, run the command it was given, and run it in the app directory.
# ---------------------------------------------------------------------------
run pass BACKEND_BUDGET_SECONDS=60 STUB_RC=0
[ "${rc}" -eq 0 ] || fail "a passing run did not exit 0 (got ${rc})"
grep -q '| used |' "${summary_file}" || fail "the summary did not report budget usage"
grep -q -- '-m pytest --durations=25' "${argv_log}" ||
  fail "the pytest arguments did not reach the runner"
grep -q "^${APP_DIR}$" "${cwd_log}" ||
  fail "the runner did not execute in BACKEND_APP_DIR (got '$(cat "${cwd_log}")')"
assert_no_time_cap_claim "a passing run claimed a TIME CAP"
grep -q '::warning title=Backend suite is approaching' "${out}" &&
  fail "a run at ~0% of budget emitted the approaching-budget warning"

# ---------------------------------------------------------------------------
# 2. A genuine test failure. The runner's own status, and a summary that rules
#    a timeout OUT. This is the negative control for every TIME CAP assertion
#    below: if this case were labelled a time cap, the label would be noise.
# ---------------------------------------------------------------------------
run testfail BACKEND_BUDGET_SECONDS=60 STUB_RC=1
[ "${rc}" -eq 1 ] || fail "a failing run did not propagate exit 1 (got ${rc})"
grep -q '::error title=Backend tests failed' "${out}" ||
  fail "a test failure is not named as a test failure"
grep -qi 'not a timeout' "${out}" ||
  fail "the test-failure annotation does not rule out a timeout"
grep -qi 'not a timeout' "${summary_file}" ||
  fail "the test-failure summary does not rule out a timeout"
assert_no_time_cap_claim "a test failure was reported as a TIME CAP"

# ---------------------------------------------------------------------------
# 2b. pytest's exit 5 is "no tests were collected" -- a broken invocation, not
#     a failing assertion. Red either way, but calling it a test failure sends
#     the reader hunting for a test that does not exist.
# ---------------------------------------------------------------------------
run nocollect BACKEND_BUDGET_SECONDS=60 STUB_RC=5
[ "${rc}" -eq 5 ] || fail "exit 5 was not propagated (got ${rc})"
grep -qi 'NO TESTS WERE COLLECTED' "${out}" ||
  fail "exit 5 was not named as an empty collection"
assert_no_time_cap_claim "an empty collection was reported as a TIME CAP"

# ---------------------------------------------------------------------------
# 2c. pytest reserves 2/3/4 for interrupted, internal error, and usage error.
#     None of them is a failing assertion, and blaming one on "a test failed"
#     points the reader at the test suite when the runner, a plugin or the
#     invocation is what broke -- the same mislabelling as calling an overrun
#     a test failure, one step further in. Every one of them must still rule
#     a timeout OUT.
# ---------------------------------------------------------------------------
for spec in "3:INTERNAL ERROR" "4:usage error"; do
  code="${spec%%:*}"
  phrase="${spec#*:}"
  run "status${code}" BACKEND_BUDGET_SECONDS=60 "STUB_RC=${code}"
  [ "${rc}" -eq "${code}" ] || fail "exit ${code} was not propagated (got ${rc})"
  grep -qi "${phrase}" "${out}" ||
    fail "pytest exit ${code} was not named (expected '${phrase}')"
  # The collapsed annotation title is all most readers see. A detailed body
  # under "Backend tests failed" still sends them to the test suite.
  grep -q '::error title=Backend tests failed' "${out}" &&
    fail "pytest exit ${code} is titled as a plain test failure"
  grep -qi 'not a timeout' "${summary_file}" ||
    fail "pytest exit ${code} did not rule out a timeout"
  assert_no_time_cap_claim "pytest exit ${code} was reported as a TIME CAP"
done

# ---------------------------------------------------------------------------
# 3. The budget is exceeded. A distinct exit code, an ::error whose TITLE says
#    TIME CAP (the title is what GitHub shows without opening the job), and a
#    summary that says no test is known to have failed.
#
#    It must also ACTUALLY STOP the run rather than complain afterwards: the
#    stub sleeps 10s against a 1s budget, so the whole invocation has to come
#    back in well under 10s. Without that wall-clock assertion this suite would
#    pass against a script that merely measured and never enforced -- which is
#    the same "guard that cannot be observed to fire" this file exists to rule
#    out.
# ---------------------------------------------------------------------------
overrun_started="$(date +%s)"
run overrun BACKEND_BUDGET_SECONDS=1 BACKEND_KILL_AFTER_SECONDS=2 STUB_SLEEP=10 STUB_RC=0
overrun_elapsed=$(($(date +%s) - overrun_started))
[ "${rc}" -eq 124 ] || fail "an over-budget run did not exit 124 (got ${rc})"
[ "${rc}" -ne 1 ] || fail "an over-budget run used a test failure's exit code"
grep -q '::error title=TIME CAP' "${out}" ||
  fail "no TIME CAP annotation title on an over-budget run"
grep -qi 'not a test failure' "${out}" ||
  fail "the over-budget annotation does not say it is not a test failure"
grep -qi 'TIME CAP EXCEEDED' "${summary_file}" ||
  fail "the over-budget step summary does not lead with the time cap"
grep -qi 'do not just re-run' "${out}" ||
  fail "the over-budget annotation does not steer away from a blind re-run"
if command -v timeout >/dev/null 2>&1 || command -v gtimeout >/dev/null 2>&1; then
  [ "${overrun_elapsed}" -lt 8 ] ||
    fail "a 1s budget did not stop a 10s run (took ${overrun_elapsed}s): the budget is measured, not enforced"
fi

# ---------------------------------------------------------------------------
# 3b. A pytest that IGNORES SIGINT. This is the only hard stop between a
#     deadlocked suite and the outer job cap, and it is the path that the
#     ordinary overrun case above does NOT exercise: `sleep` dies on the first
#     interrupt, so --kill-after never escalates and could be deleted with
#     this file still green.
#
#     It also pins a fact the comment in the script depends on: GNU timeout
#     returns 124 only when the FIRST signal worked, and 137 once it had to
#     escalate to SIGKILL (verified against coreutils 9.8). The exit code
#     therefore cannot distinguish our own kill from an OOM kill, and only the
#     clock can -- so this run must still come back as a TIME CAP with the
#     normalised 124, not as an infrastructure kill.
# ---------------------------------------------------------------------------
if command -v timeout >/dev/null 2>&1 || command -v gtimeout >/dev/null 2>&1; then
  STUBBORN="${WORK}/deadlocked-pytest.sh"
  cat >"${STUBBORN}" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >"${STUB_ARGV_LOG}"
printf '%s\n' "$PWD" >"${STUB_CWD_LOG}"
trap '' INT
sleep 60
EOF
  chmod +x "${STUBBORN}"
  deadlock_started="$(date +%s)"
  out="${WORK}/deadlock.out"
  err="${WORK}/deadlock.err"
  summary_file="${WORK}/deadlock.summary"
  : >"${summary_file}"
  set +e
  env BACKEND_APP_DIR="${APP_DIR}" \
    BACKEND_TEST_COMMAND="${STUBBORN}" \
    BACKEND_BUDGET_SECONDS=1 \
    BACKEND_KILL_AFTER_SECONDS=2 \
    STUB_ARGV_LOG="${WORK}/deadlock.argv" \
    STUB_CWD_LOG="${WORK}/deadlock.cwd" \
    GITHUB_STEP_SUMMARY="${summary_file}" \
    "${SCRIPT}" >"${out}" 2>"${err}"
  rc=$?
  set -e
  deadlock_elapsed=$(($(date +%s) - deadlock_started))
  [ "${deadlock_elapsed}" -lt 30 ] ||
    fail "a SIGINT-ignoring runner was not escalated to SIGKILL (took ${deadlock_elapsed}s of a 60s sleep): --kill-after is not doing anything"
  [ "${rc}" -eq 124 ] ||
    fail "a killed-after-escalation overrun did not normalise to 124 (got ${rc})"
  grep -q '::error title=TIME CAP' "${out}" ||
    fail "an escalated overrun lost its TIME CAP annotation"
  grep -q '::error title=Backend suite was KILLED' "${out}" &&
    fail "our own SIGKILL escalation was reported as an infrastructure kill"
fi

# ---------------------------------------------------------------------------
# 4. Approaching the budget warns while still GREEN. "We are at 44 of 50
#    minutes" is the signal that has to arrive BEFORE the gate turns red.
# ---------------------------------------------------------------------------
run nearly BACKEND_BUDGET_SECONDS=4 BACKEND_WARN_PERCENT=50 STUB_SLEEP=3 STUB_RC=0
[ "${rc}" -eq 0 ] || fail "a slow-but-passing run did not stay green (got ${rc})"
grep -q '::warning title=Backend suite is approaching its time budget' "${out}" ||
  fail "no approaching-budget warning at >= BACKEND_WARN_PERCENT"
grep -qi 'close to failing on the clock' "${summary_file}" ||
  fail "the approaching-budget note is missing from the step summary"
assert_no_time_cap_claim "a warning-level run claimed a TIME CAP"

# ---------------------------------------------------------------------------
# 5. Nonsense settings must fail loudly and BEFORE running anything. A budget
#    of "50m" would otherwise make every arithmetic comparison return status 2
#    and the guard would silently stop guarding.
# ---------------------------------------------------------------------------
run wordbudget BACKEND_BUDGET_SECONDS=50m STUB_RC=0
[ "${rc}" -eq 2 ] || fail "a non-numeric budget was not rejected (got ${rc})"
[ ! -s "${argv_log}" ] || fail "an invalid budget still invoked pytest"

run zerobudget BACKEND_BUDGET_SECONDS=0 STUB_RC=0
[ "${rc}" -eq 2 ] || fail "a zero budget was not rejected (got ${rc})"

# ---------------------------------------------------------------------------
# 6. Exit 137 is SIGKILL, and SIGKILL is ambiguous: it is what --kill-after
#    sends after the budget expires, but it is ALSO what an out-of-memory kill
#    looks like -- and this job runs a real Postgres and a real redis next to
#    pytest. Calling an OOM at minute two a TIME CAP hides an infrastructure
#    failure behind the wrong remedy, which is this script's own failure mode
#    pointed the other way. The clock has to agree before we blame the budget.
# ---------------------------------------------------------------------------
run oomkill BACKEND_BUDGET_SECONDS=600 STUB_RC=137
[ "${rc}" -eq 137 ] || fail "an early SIGKILL did not propagate exit 137 (got ${rc})"
[ "${rc}" -ne 124 ] || fail "an early SIGKILL used the reserved time-cap exit code"
assert_no_time_cap_claim "a SIGKILL well inside budget was reported as a TIME CAP"
grep -q '::error title=Backend suite was KILLED' "${out}" ||
  fail "an early SIGKILL is not named as a kill"
grep -qi 'out-of-memory\|out of memory' "${out}" ||
  fail "the SIGKILL annotation does not point at the usual cause"

# The negative control for the check above needs a host with no timeout(1):
# where timeout(1) exists it reports 124 for every overrun it handled --
# SIGKILL escalation included -- so an exit 137 there can only come from
# something else. Strip timeout(1) off PATH and the script falls back to
# measuring; a runner that then dies of SIGKILL PAST the budget must still be
# an overrun. This doubles as the only coverage of the no-timeout(1) fallback,
# which is what a macOS dev box actually runs.
MINIMAL_BIN="${WORK}/minimal-bin"
mkdir -p "${MINIMAL_BIN}"
for tool in date sleep env bash sh; do
  path="$(command -v "${tool}" 2>/dev/null || true)"
  [ -n "${path}" ] && ln -sf "${path}" "${MINIMAL_BIN}/${tool}"
done
[ ! -e "${MINIMAL_BIN}/timeout" ] || fail "the minimal PATH still provides timeout(1)"

run nokill_overrun PATH="${MINIMAL_BIN}" BACKEND_BUDGET_SECONDS=1 STUB_SLEEP=3 STUB_RC=137
[ "${rc}" -eq 124 ] || fail "a SIGKILL past the budget was not a time cap (got ${rc})"
grep -q '::error title=TIME CAP' "${out}" ||
  fail "a SIGKILL past the budget lost its TIME CAP annotation"
grep -qi 'no timeout' "${err}" ||
  fail "the script did not disclose that it could not enforce the budget"

# Same host, same missing timeout(1), but the runner finished INSIDE budget:
# the fallback must not manufacture an overrun.
run nokill_pass PATH="${MINIMAL_BIN}" BACKEND_BUDGET_SECONDS=60 STUB_RC=0
[ "${rc}" -eq 0 ] || fail "the no-timeout fallback failed a passing run (got ${rc})"
assert_no_time_cap_claim "the no-timeout fallback invented a TIME CAP"

python3 "$REPO_ROOT/scripts/free2z/check-ci-contract.py"
python3 -m unittest discover -s "$REPO_ROOT/scripts/free2z/tests" -p 'test_ci_contract.py'
echo 'PASS: backend bounded runner and structured workflow mutation controls'
