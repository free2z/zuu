#!/usr/bin/env bash
# Free2Z application check: ci backend pytest.
set -uo pipefail

readonly TIME_CAP_EXIT=124

budget="${BACKEND_BUDGET_SECONDS:-3000}"
warn_percent="${BACKEND_WARN_PERCENT:-70}"
kill_after="${BACKEND_KILL_AFTER_SECONDS:-60}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
app_dir="${BACKEND_APP_DIR:-$repo_root/py/free2z}"

for value in "$budget" "$warn_percent" "$kill_after"; do
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "ci-backend-pytest: non-numeric setting: '$value'" >&2
    exit 2
  fi
done
if [ "$budget" -lt 1 ]; then
  echo "ci-backend-pytest: BACKEND_BUDGET_SECONDS must be >= 1" >&2
  exit 2
fi

read -r -a runner <<<"${BACKEND_TEST_COMMAND:-python -m pytest --durations=25}"
if [ "${#runner[@]}" -eq 0 ]; then
  echo "ci-backend-pytest: BACKEND_TEST_COMMAND is empty" >&2
  exit 2
fi

human() {
  # 2253 -> "37m33s"; keeps the summary readable without a units mixup.
  local s="$1"
  printf '%dm%02ds' "$((s / 60))" "$((s % 60))"
}

summary() {
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
  printf '%s\n' "$@" >>"$GITHUB_STEP_SUMMARY"
}

# `timeout` is coreutils; macOS has it only as `gtimeout` via homebrew. Without
# either we still MEASURE and still report an overrun -- we just cannot cut the
# run short. Degrading silently into "no budget at all" is the one outcome that
# would put us back where we started.
timeout_bin=""
if command -v timeout >/dev/null 2>&1; then
  timeout_bin="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  timeout_bin="gtimeout"
else
  echo "ci-backend-pytest: no timeout(1) on PATH; the budget will be reported after the fact, not enforced" >&2
fi

cd "$app_dir" || exit 2

echo "ci-backend-pytest: budget $(human "$budget") ($budget s), running: ${runner[*]}" >&2

started="$(date +%s)"
if [ -n "$timeout_bin" ]; then
  # SIGINT rather than SIGTERM: pytest treats it as KeyboardInterrupt, so it
  # still prints the short test summary and the --durations table for what had
  # already run. A SIGTERM'd pytest tells you nothing about where it was, and
  # "where it was" is the entire diagnostic value of an overrun.
  # --kill-after is the backstop for a child (a hung DB connection, a stuck
  # subprocess) that ignores the interrupt.
  "$timeout_bin" --signal=INT --kill-after="$kill_after" "$budget" "${runner[@]}"
  status=$?
else
  "${runner[@]}"
  status=$?
fi
finished="$(date +%s)"

elapsed=$((finished - started))
[ "$elapsed" -ge 0 ] || elapsed=0
percent=$((elapsed * 100 / budget))

# 124 is timeout(1)'s "the command timed out" and is unambiguous. The elapsed
# comparison catches an overrun on a host with no timeout(1) at all.
#
# 137 is NOT unambiguous: it is exit-by-SIGKILL, which is what --kill-after
# sends to a pytest that ignored SIGINT -- but it is ALSO what an OOM kill
# looks like, and this job runs a real Postgres and a real redis alongside
# pytest. Reporting a suite the kernel killed at minute two as "TIME CAP: make
# it faster" hides an infrastructure failure behind the wrong remedy, which is
# the same class of mislabelling this script exists to prevent.
#
# And 137 is genuinely what our OWN escalation produces: `timeout` reports 124
# only when the first signal did the job, and 137 once it had to escalate to
# SIGKILL (verified against GNU coreutils 9.8 with a stub that traps SIGINT --
# scripts/free2z/test-ci-backend-pytest.sh pins it). So the exit code alone cannot tell
# our kill from the kernel's, and THE CLOCK IS THE TIEBREAKER: past the budget
# it is an overrun (which also covers a host with no timeout(1) at all and
# normalises the escalation back to 124), inside the budget it is a kill we
# did not ask for. Order matters here -- the over-budget test must come
# first.
over_budget=0
killed_early=0
if [ "$status" -eq 124 ] || [ "$elapsed" -gt "$budget" ]; then
  over_budget=1
elif [ "$status" -eq 137 ]; then
  killed_early=1
fi

label="${BACKEND_TEST_LABEL:-Backend pytest suite}"

if [ "$killed_early" -eq 1 ]; then
  echo "::error title=Backend suite was KILLED (SIGKILL), not by its budget::$label died after $(human "$elapsed") of a $(human "$budget") budget. SIGKILL well inside budget is an infrastructure failure -- an out-of-memory kill on the runner is the usual cause. This is neither a test failure nor a time cap: making the suite faster will not fix it."
  summary \
    "## 💥 $label — killed by SIGKILL, inside its budget" \
    "" \
    "The pytest process was killed with signal 9 after \`$(human "$elapsed")\`," \
    "well inside its \`$(human "$budget")\` budget. That is an **infrastructure**" \
    "failure -- most often the runner running out of memory -- not a test" \
    "failure and not a time cap." \
    "" \
    "| | |" \
    "| --- | --- |" \
    "| ran for | \`$(human "$elapsed")\` |" \
    "| budget | \`$(human "$budget")\` (${percent}% used) |" \
    "| pytest exit | \`$status\` (SIGKILL) |"
  echo "$label: KILLED by SIGKILL after $(human "$elapsed") (${percent}% of budget)"
  exit "$status"
fi

if [ "$over_budget" -eq 1 ]; then
  echo "::error title=TIME CAP: backend suite ran out of budget::$label ran for $(human "$elapsed") against a $(human "$budget") budget and was stopped. This is a TIME CAP failure, not a test failure -- no test is known to have failed. Make the suite faster or split it; do not just re-run."
  summary \
    "## ⏱ $label — TIME CAP EXCEEDED (not a test failure)" \
    "" \
    "The suite was **stopped by its own time budget**. No test is known to have" \
    "failed: this run simply did not finish in the time allotted. Re-running" \
    "will not help unless the runner happens to be faster." \
    "" \
    "| | |" \
    "| --- | --- |" \
    "| ran for | \`$(human "$elapsed")\` |" \
    "| budget | \`$(human "$budget")\` |" \
    "| pytest exit | \`$status\` |" \
    "" \
    "pytest was interrupted with SIGINT, so the log above still shows the" \
    "\`--durations\` table and which tests had run. Split the suite or" \
    "make the slowest tests cheaper; raising \`BACKEND_BUDGET_SECONDS\` in" \
    ".github/workflows/free2z-web-ci.yml also requires raising the job's" \
    "\`timeout-minutes\` to keep the stated arithmetic true."
  echo "$label: TIME CAP EXCEEDED after $(human "$elapsed") (budget $(human "$budget"))"
  exit "$TIME_CAP_EXIT"
fi

if [ "$status" -ne 0 ]; then
  # pytest reserves 2..5 for things that are NOT a failing assertion, and
  # sending the reader to hunt for a failing test when a plugin blew up or the
  # invocation was malformed is the same mislabelling this script exists to
  # prevent, one step further in. Name what actually happened; every branch
  # still rules a timeout out, because none of these is one.
  case "$status" in
    2)
      detail="pytest exited 2: INTERRUPTED. Our own budget interrupt is reported as a time cap instead, so this was interrupted by something else (a KeyboardInterrupt from a test, or a signal from outside the runner). Not a failing test, and not this script's time cap."
      ;;
    3)
      detail="pytest exited 3: INTERNAL ERROR in pytest itself -- a plugin or a collection hook, not a failing assertion. Read the traceback above, not the tests."
      ;;
    4)
      detail="pytest exited 4: COMMAND-LINE USAGE ERROR. The invocation is malformed (see BACKEND_TEST_COMMAND); no test outcome was produced at all."
      ;;
    5)
      detail="pytest exited 5: NO TESTS WERE COLLECTED. That is a broken invocation or a collection error, not a failing test, and not a timeout."
      ;;
    *)
      detail="This is a TEST failure, not a timeout -- the pytest output above has the details."
      ;;
  esac
  # The ::error TITLE is what GitHub shows on the collapsed job, so it has to
  # carry the classification too -- a detailed body under a title that says
  # "tests failed" still sends the reader to the test suite.
  case "$status" in
    2) title="Backend suite was INTERRUPTED (not by its budget)"; heading="⚠️ $label — interrupted (not a timeout, not a test failure)" ;;
    3) title="Backend suite hit a pytest INTERNAL ERROR"; heading="💣 $label — pytest internal error (not a timeout, not a test failure)" ;;
    4) title="Backend pytest invocation is malformed"; heading="🚫 $label — usage error, no tests ran (not a timeout)" ;;
    5) title="Backend suite collected NO TESTS"; heading="🫙 $label — no tests collected (not a timeout, not a test failure)" ;;
    *) title="Backend tests failed"; heading="❌ $label — test failure (not a timeout)" ;;
  esac
  echo "::error title=${title}::$label exited $status in $(human "$elapsed") of its $(human "$budget") budget (${percent}%). $detail"
  summary \
    "## $heading" \
    "" \
    "The suite finished **inside** its budget and pytest exited nonzero." \
    "$detail" \
    "" \
    "| | |" \
    "| --- | --- |" \
    "| ran for | \`$(human "$elapsed")\` |" \
    "| budget | \`$(human "$budget")\` (${percent}% used) |" \
    "| pytest exit | \`$status\` |"
  echo "$label: exited $status in $(human "$elapsed") (${percent}% of budget) -- ${title}"
  exit "$status"
fi

icon="✅"
if [ "$percent" -ge "$warn_percent" ]; then
  icon="⚠️"
  echo "::warning title=Backend suite is approaching its time budget::$label used ${percent}% of its budget ($(human "$elapsed") of $(human "$budget")). It passed. Make it faster or split it before it does not."
fi

summary \
  "## $icon $label — passed in $(human "$elapsed")" \
  "" \
  "| | |" \
  "| --- | --- |" \
  "| ran for | \`$(human "$elapsed")\` |" \
  "| budget | \`$(human "$budget")\` |" \
  "| used | **${percent}%** |"

if [ "$percent" -ge "$warn_percent" ]; then
  summary "" "At ${percent}% of budget this suite is close to failing on the clock." \
    "Split it or make the slowest tests cheaper before it does."
fi

echo "$label: passed in $(human "$elapsed") (${percent}% of a $(human "$budget") budget)"
