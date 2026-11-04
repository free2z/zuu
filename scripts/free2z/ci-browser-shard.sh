#!/usr/bin/env bash
# Free2Z application check: ci browser shard.
set -uo pipefail

readonly TIME_CAP_EXIT=124

shard="${BROWSER_SHARD:-1}"
total="${BROWSER_TOTAL_SHARDS:-1}"
budget="${BROWSER_BUDGET_SECONDS:-720}"
warn_percent="${BROWSER_WARN_PERCENT:-70}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
app_dir="${BROWSER_APP_DIR:-$repo_root/ts/svelte/free2z}"
if ! app_dir="$(cd "$app_dir" 2>/dev/null && pwd)"; then
  echo "ci-browser-shard: BROWSER_APP_DIR is not a directory: ${BROWSER_APP_DIR:-$app_dir}" >&2
  exit 2
fi

# The numeric matrix index selects one checked-in test list. Refuse an index
# outside the declared list set instead of trusting the workflow matrix to
# stay in step with BROWSER_TOTAL_SHARDS.
for value in "$shard" "$total" "$budget" "$warn_percent"; do
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "ci-browser-shard: non-numeric setting: '$value'" >&2
    exit 2
  fi
done
if [ "$total" -lt 1 ] || [ "$shard" -lt 1 ] || [ "$shard" -gt "$total" ]; then
  echo "ci-browser-shard: invalid shard $shard/$total (need 1 <= shard <= total)" >&2
  exit 2
fi
if [ "$budget" -lt 1 ]; then
  echo "ci-browser-shard: BROWSER_BUDGET_SECONDS must be >= 1" >&2
  exit 2
fi

export BROWSER_SHARD="$shard"
export BROWSER_TOTAL_SHARDS="$total"

read -r -a runner <<<"${BROWSER_TEST_COMMAND:-npm run test:browser --}"

human() {
  # 292 -> "4m52s"; keeps the summary readable without a units mixup.
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
  echo "ci-browser-shard: no timeout(1) on PATH; the budget will be reported after the fact, not enforced" >&2
fi

cd "$app_dir" || exit 2

test_list=""
if [ "$total" -gt 1 ]; then
  test_list="$app_dir/tests/browser/ci-shards/shard-$shard.list"
  if [ ! -s "$test_list" ]; then
    echo "ci-browser-shard: missing or empty Playwright test list for shard $shard/$total: $test_list" >&2
    exit 2
  fi
fi

selection="full suite"
[ -z "$test_list" ] || selection="test list $test_list"
echo "ci-browser-shard: shard $shard/$total, budget $(human "$budget") ($budget s), $selection" >&2

started="$(date +%s)"
if [ -n "$timeout_bin" ]; then
  # SIGINT rather than SIGTERM: Playwright treats it as "interrupted", flushes
  # its reporters and exits, so the uploaded HTML report still shows which
  # specs had run. --kill-after is the backstop for a runner that ignores it.
  if [ -n "$test_list" ]; then
    "$timeout_bin" --signal=INT --kill-after=60 "$budget" \
      "${runner[@]}" "--test-list=$test_list"
  else
    "$timeout_bin" --signal=INT --kill-after=60 "$budget" "${runner[@]}"
  fi
  status=$?
else
  if [ -n "$test_list" ]; then
    "${runner[@]}" "--test-list=$test_list"
  else
    "${runner[@]}"
  fi
  status=$?
fi
finished="$(date +%s)"

elapsed=$((finished - started))
[ "$elapsed" -ge 0 ] || elapsed=0
percent=$((elapsed * 100 / budget))

# 124 is timeout(1)'s "the command timed out" and is unambiguous. The elapsed
# comparison catches an overrun on a host with no timeout(1) at all.
#
# 137 is NOT unambiguous, and treating it as a time cap on its own was a bug:
# it is exit-by-SIGKILL, which is what --kill-after sends to a runner that
# ignored SIGINT -- but it is ALSO what an OOM kill looks like. Reporting a
# shard the kernel killed at minute two as "TIME CAP: add a shard" hides an
# infrastructure failure behind the wrong remedy, which is the same class of
# mislabelling this script exists to prevent. So 137 only counts as a time cap
# when the clock agrees.
#
# Note that timeout(1) reports 124 whenever IT timed the command out, including
# when --kill-after had to escalate to SIGKILL -- so on a host with timeout(1),
# 137 reaching us means something ELSE killed the process. The clock is the
# only tiebreaker: past the budget it is an overrun (that is the first
# condition, which also covers a host with no timeout(1) at all), inside the
# budget it is a kill we did not ask for.
over_budget=0
killed_early=0
if [ "$status" -eq 124 ] || [ "$elapsed" -gt "$budget" ]; then
  over_budget=1
elif [ "$status" -eq 137 ]; then
  killed_early=1
fi

label="Browser shard $shard/$total"

if [ "$killed_early" -eq 1 ]; then
  echo "::error title=Browser suite was KILLED (SIGKILL), not by its budget::$label died after $(human "$elapsed") of a $(human "$budget") budget. SIGKILL well inside budget is an infrastructure failure -- an out-of-memory kill on the runner is the usual cause. This is neither a spec failure nor a time cap: adding a shard will not fix it."
  summary \
    "## 💥 $label — killed by SIGKILL, inside its budget" \
    "" \
    "The runner process was killed with signal 9 after \`$(human "$elapsed")\`," \
    "well inside its \`$(human "$budget")\` budget. That is an **infrastructure**" \
    "failure -- most often the runner running out of memory -- not a spec" \
    "failure and not a time cap. Adding a shard will not help." \
    "" \
    "| | |" \
    "| --- | --- |" \
    "| ran for | \`$(human "$elapsed")\` |" \
    "| budget | \`$(human "$budget")\` (${percent}% used) |" \
    "| runner exit | \`$status\` (SIGKILL) |"
  echo "$label: KILLED by SIGKILL after $(human "$elapsed") (${percent}% of budget)"
  exit "$status"
fi

if [ "$over_budget" -eq 1 ]; then
  echo "::error title=TIME CAP: browser suite ran out of budget::$label ran for $(human "$elapsed") against a $(human "$budget") budget and was stopped. This is a TIME CAP failure, not a spec failure -- no spec is known to have failed. Shard the suite further or make it faster; do not just re-run."
  summary \
    "## ⏱ $label — TIME CAP EXCEEDED (not a spec failure)" \
    "" \
    "The suite was **stopped by its own time budget**. No spec is known to have" \
    "failed: this run simply did not finish in the time allotted." \
    "" \
    "| | |" \
    "| --- | --- |" \
    "| ran for | \`$(human "$elapsed")\` |" \
    "| budget | \`$(human "$budget")\` |" \
    "| runner exit | \`$status\` |" \
    "" \
    "Re-running will not help unless the runner happens to be faster. Add a" \
    "shard (\`matrix.shard\` **and** \`BROWSER_TOTAL_SHARDS\` in .github/workflows/free2z-web-ci.yml)," \
    "or make the specs cheaper. Inspect the slowest browser tests."
  echo "$label: TIME CAP EXCEEDED after $(human "$elapsed") (budget $(human "$budget"))"
  exit "$TIME_CAP_EXIT"
fi

if [ "$status" -ne 0 ]; then
  echo "::error title=Browser specs failed::$label failed in $(human "$elapsed") of its $(human "$budget") budget (${percent}%). This is a SPEC failure, not a timeout -- the report artifact has the details."
  summary \
    "## ❌ $label — spec failure (not a timeout)" \
    "" \
    "The suite finished inside its budget and **reported failing specs**." \
    "Download the \`playwright-report-shard-$shard\` artifact for traces." \
    "" \
    "| | |" \
    "| --- | --- |" \
    "| ran for | \`$(human "$elapsed")\` |" \
    "| budget | \`$(human "$budget")\` (${percent}% used) |" \
    "| runner exit | \`$status\` |"
  echo "$label: FAILED specs in $(human "$elapsed") (${percent}% of budget)"
  exit "$status"
fi

icon="✅"
if [ "$percent" -ge "$warn_percent" ]; then
  icon="⚠️"
  echo "::warning title=Browser suite is approaching its time budget::$label used ${percent}% of its budget ($(human "$elapsed") of $(human "$budget")). It passed. Add a shard before it does not."
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
  summary "" "At ${percent}% of budget this shard is close to failing on the clock." \
    "Add a shard (\`matrix.shard\` **and** \`BROWSER_TOTAL_SHARDS\`) before it does."
fi

echo "$label: passed in $(human "$elapsed") (${percent}% of a $(human "$budget") budget)"
