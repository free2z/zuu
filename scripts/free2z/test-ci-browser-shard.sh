#!/usr/bin/env bash
# Free2Z application check: test ci browser shard.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/free2z/ci-browser-shard.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

APP_DIR="${WORK}/app"
mkdir -p "${APP_DIR}"
mkdir -p "${APP_DIR}/tests/browser/ci-shards"
for shard in 1 2 3 4; do
  printf 'stub.spec.ts\n' >"${APP_DIR}/tests/browser/ci-shards/shard-${shard}.list"
done

# The stub stands in for `npm run test:browser --`. It records its argv (so we
# can prove the selected test list reached the runner), sleeps for STUB_SLEEP
# and exits with STUB_RC.
STUB="${WORK}/fake-runner.sh"
cat >"${STUB}" <<'EOF'
#!/usr/bin/env bash
[ "$#" -eq 0 ] || printf '%s\n' "$*" >"${STUB_ARGV_LOG}"
sleep "${STUB_SLEEP:-0}"
exit "${STUB_RC:-0}"
EOF
chmod +x "${STUB}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# The TIME CAP claim is made in exactly two places a reader sees at a glance:
# the ::error annotation TITLE and the step-summary heading. Assert on those
# rather than on the phrase anywhere in the text -- the SIGKILL message below
# legitimately contains the words "not a time cap", and a loose grep flags it.
assert_no_time_cap_claim() {
  grep -q '::error title=TIME CAP' "${out}" &&
    fail "$1 (annotation title claims a TIME CAP)"
  grep -q 'TIME CAP EXCEEDED' "${summary_file}" &&
    fail "$1 (step summary claims a TIME CAP)"
  return 0
}

# run <name> -- sets globals rc/out/err/summary_file for the assertions below.
run() {
  local name="$1"
  shift
  out="${WORK}/${name}.out"
  err="${WORK}/${name}.err"
  summary_file="${WORK}/${name}.summary"
  argv_log="${WORK}/${name}.argv"
  : >"${summary_file}"
  set +e
  env BROWSER_APP_DIR="${APP_DIR}" \
    "$@" \
    BROWSER_TEST_COMMAND="${STUB}" \
    STUB_ARGV_LOG="${argv_log}" \
    GITHUB_STEP_SUMMARY="${summary_file}" \
    "${SCRIPT}" >"${out}" 2>"${err}"
  rc=$?
  set -e
}

# ---------------------------------------------------------------------------
# 1. A passing shard, comfortably inside budget.
# ---------------------------------------------------------------------------
run pass BROWSER_SHARD=2 BROWSER_TOTAL_SHARDS=4 BROWSER_BUDGET_SECONDS=60 STUB_RC=0
[ "${rc}" -eq 0 ] || fail "a passing shard did not exit 0 (got ${rc})"
grep -Fq -- "--test-list=${APP_DIR}/tests/browser/ci-shards/shard-2.list" "${argv_log}" ||
  fail "the selected test list never reached the runner: $(cat "${argv_log}")"
grep -q 'passed in' "${summary_file}" || fail "no pass line in the step summary"
grep -q '| used |' "${summary_file}" || fail "the summary did not report budget usage"
# Negative control for the whole exercise: a pass must not mention a time cap
# anywhere, or the marker means nothing when it is real.
assert_no_time_cap_claim "a passing run claimed a TIME CAP"
grep -q '::warning' "${err}" "${out}" &&
  fail "a run at 0% of budget emitted the approaching-budget warning"

(
  cd "${WORK}"
  run relativeapp BROWSER_APP_DIR=app BROWSER_SHARD=2 BROWSER_TOTAL_SHARDS=4 \
    BROWSER_BUDGET_SECONDS=60 STUB_RC=0
  [ "${rc}" -eq 0 ] || fail "a relative BROWSER_APP_DIR did not resolve (got ${rc})"
  grep -Fq -- "--test-list=${APP_DIR}/tests/browser/ci-shards/shard-2.list" \
    "${WORK}/relativeapp.argv" ||
    fail "a relative BROWSER_APP_DIR produced the wrong test-list path"
)

# A local single-shard invocation keeps its historical behavior: run the full
# suite when no matrix split is configured.
run localfullsuite BROWSER_SHARD=1 BROWSER_TOTAL_SHARDS=1 BROWSER_BUDGET_SECONDS=60 STUB_RC=0
[ "${rc}" -eq 0 ] || fail "the local full-suite run did not pass (got ${rc})"
[ ! -s "${WORK}/localfullsuite.argv" ] ||
  fail "the local full-suite run was restricted to a CI test list"

# ---------------------------------------------------------------------------
# 2. A spec failure. Must surface as a SPEC failure and explicitly not a
#    timeout -- this is the case the old shared-cap setup could not tell apart.
# ---------------------------------------------------------------------------
run specfail BROWSER_SHARD=1 BROWSER_TOTAL_SHARDS=2 BROWSER_BUDGET_SECONDS=60 STUB_RC=1
[ "${rc}" -eq 1 ] || fail "a spec failure did not propagate the runner's exit 1 (got ${rc})"
[ "${rc}" -ne 124 ] || fail "a spec failure used the reserved time-cap exit code"
grep -qi 'spec failure' "${summary_file}" || fail "spec failure not named in the summary"
grep -qi 'not a timeout' "${summary_file}" ||
  fail "the spec-failure summary does not rule out a timeout"
assert_no_time_cap_claim "a spec failure was reported as a TIME CAP"

# ---------------------------------------------------------------------------
# 3. The budget is exceeded. Distinct exit code, an ::error whose TITLE says
#    TIME CAP (the title is what GitHub shows on the job without opening it),
#    and a summary that says no spec is known to have failed.
# ---------------------------------------------------------------------------
run overrun BROWSER_SHARD=1 BROWSER_TOTAL_SHARDS=1 BROWSER_BUDGET_SECONDS=1 \
  STUB_SLEEP=5 STUB_RC=0
[ "${rc}" -eq 124 ] || fail "an over-budget run did not exit 124 (got ${rc})"
grep -q '::error title=TIME CAP' "${out}" ||
  fail "no TIME CAP annotation title on an over-budget run"
grep -qi 'not a spec failure' "${out}" ||
  fail "the over-budget annotation does not say it is not a spec failure"
grep -qi 'TIME CAP EXCEEDED' "${summary_file}" ||
  fail "the over-budget step summary does not lead with the time cap"
# It must also have actually STOPPED the run rather than merely complaining
# afterwards: the stub sleeps 5s against a 1s budget.
grep -qi 'do not just re-run' "${out}" ||
  fail "the over-budget annotation does not steer away from a blind re-run"

# ---------------------------------------------------------------------------
# 4. Approaching the budget warns while still GREEN. This is the "we are at 11
#    of 12 minutes" signal that has to arrive before the gate turns red.
# ---------------------------------------------------------------------------
run nearly BROWSER_SHARD=1 BROWSER_TOTAL_SHARDS=1 BROWSER_BUDGET_SECONDS=3 \
  BROWSER_WARN_PERCENT=50 STUB_SLEEP=2 STUB_RC=0
[ "${rc}" -eq 0 ] || fail "a slow-but-passing shard did not stay green (got ${rc})"
grep -q '::warning title=Browser suite is approaching its time budget' "${out}" ||
  fail "no approaching-budget warning at >= BROWSER_WARN_PERCENT"
grep -qi 'close to failing on the clock' "${summary_file}" ||
  fail "the approaching-budget note is missing from the step summary"

# ---------------------------------------------------------------------------
# 5. A malformed shard spec must fail loudly. `--shard=5/4` selects NOTHING in
#    Playwright and the job goes green having run zero specs -- the single
#    worst outcome available, and the one a matrix/env mismatch produces.
# ---------------------------------------------------------------------------
run badshard BROWSER_SHARD=5 BROWSER_TOTAL_SHARDS=4 BROWSER_BUDGET_SECONDS=60 STUB_RC=0
[ "${rc}" -eq 2 ] || fail "shard 5 of 4 was not rejected (got ${rc})"
[ ! -s "${argv_log}" ] || fail "an invalid shard spec still invoked the test runner"

run zeroshard BROWSER_SHARD=0 BROWSER_TOTAL_SHARDS=4 BROWSER_BUDGET_SECONDS=60 STUB_RC=0
[ "${rc}" -eq 2 ] || fail "shard 0 of 4 was not rejected (got ${rc})"

run wordshard BROWSER_SHARD=one BROWSER_TOTAL_SHARDS=4 BROWSER_BUDGET_SECONDS=60 STUB_RC=0
[ "${rc}" -eq 2 ] || fail "a non-numeric shard was not rejected (got ${rc})"

rm "${APP_DIR}/tests/browser/ci-shards/shard-4.list"
run missinglist BROWSER_SHARD=4 BROWSER_TOTAL_SHARDS=4 BROWSER_BUDGET_SECONDS=60 STUB_RC=0
[ "${rc}" -eq 2 ] || fail "a valid shard with no assigned test list was not rejected (got ${rc})"
[ ! -s "${WORK}/missinglist.argv" ] || fail "the runner ran despite a missing assigned list"

# ---------------------------------------------------------------------------
# 5b. Exit 137 is SIGKILL, and SIGKILL is ambiguous: it is what --kill-after
#     sends after the budget expires, but it is ALSO what an out-of-memory
#     kill looks like. Calling an OOM at minute two a TIME CAP hides an
#     infrastructure failure behind the wrong remedy ("add a shard"), which is
#     the same mislabelling this script exists to prevent -- just pointing the
#     other way. The clock has to agree before we blame the budget.
# ---------------------------------------------------------------------------
run oomkill BROWSER_SHARD=1 BROWSER_TOTAL_SHARDS=1 BROWSER_BUDGET_SECONDS=600 STUB_RC=137
[ "${rc}" -eq 137 ] || fail "an early SIGKILL did not propagate exit 137 (got ${rc})"
[ "${rc}" -ne 124 ] || fail "an early SIGKILL used the reserved time-cap exit code"
assert_no_time_cap_claim "a SIGKILL well inside budget was reported as a TIME CAP"
grep -q '::error title=Browser suite was KILLED' "${out}" ||
  fail "an early SIGKILL is not named as a kill"
grep -qi 'out-of-memory\|out of memory' "${out}" ||
  fail "the SIGKILL annotation does not point at the usual cause"
grep -qi 'adding a shard will not' "${out}" ||
  fail "the SIGKILL annotation does not steer away from the time-cap remedy"

# The negative control for the check above, and it needs a host with no
# timeout(1): where timeout(1) exists it reports 124 for every overrun it
# handled -- SIGKILL escalation included -- so an exit 137 there can only come
# from something else. Strip timeout(1) off PATH and the script falls back to
# measuring; a runner that then dies of SIGKILL PAST the budget must still be
# an overrun, not an infrastructure kill. This doubles as the only coverage of
# the no-timeout(1) fallback, which is what a macOS dev box actually runs.
MINIMAL_BIN="${WORK}/minimal-bin"
mkdir -p "${MINIMAL_BIN}"
for tool in date sleep env bash sh; do
  path="$(command -v "${tool}" 2>/dev/null || true)"
  [ -n "${path}" ] && ln -sf "${path}" "${MINIMAL_BIN}/${tool}"
done
command -v timeout >/dev/null 2>&1 || command -v gtimeout >/dev/null 2>&1 ||
  echo "note: no timeout(1) on this host; the fallback case is the only one exercised" >&2
[ ! -e "${MINIMAL_BIN}/timeout" ] || fail "the minimal PATH still provides timeout(1)"

run nokill_overrun PATH="${MINIMAL_BIN}" BROWSER_SHARD=1 BROWSER_TOTAL_SHARDS=1 \
  BROWSER_BUDGET_SECONDS=1 STUB_SLEEP=3 STUB_RC=137
[ "${rc}" -eq 124 ] || fail "a SIGKILL past the budget was not a time cap (got ${rc})"
grep -q '::error title=TIME CAP' "${out}" ||
  fail "a SIGKILL past the budget lost its TIME CAP annotation"
grep -qi 'no timeout' "${err}" ||
  fail "the script did not disclose that it could not enforce the budget"

# Same host, same missing timeout(1), but the runner finished INSIDE budget:
# the fallback must not manufacture an overrun.
run nokill_pass PATH="${MINIMAL_BIN}" BROWSER_SHARD=1 BROWSER_TOTAL_SHARDS=1 \
  BROWSER_BUDGET_SECONDS=60 STUB_RC=0
[ "${rc}" -eq 0 ] || fail "the no-timeout fallback failed a passing run (got ${rc})"
assert_no_time_cap_claim "the no-timeout fallback invented a TIME CAP"

python3 "$REPO_ROOT/scripts/free2z/check-ci-contract.py"
python3 -m unittest discover -s "$REPO_ROOT/scripts/free2z/tests" -p 'test_ci_contract.py'
echo 'PASS: browser bounded runner and structured workflow mutation controls'
