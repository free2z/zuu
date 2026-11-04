#!/usr/bin/env bash
# Free2Z application check: test check negative status assertions.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK="${ROOT}/scripts/free2z/check-negative-status-assertions.py"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

pass=0
fail=0
ok() { printf 'PASS  %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf 'FAIL  %s\n' "$1"; shift; printf '      %s\n' "$@"; fail=$((fail + 1)); }

# expect <name> <want-exit> <relpath> <file-content> [<grep-in-output>]
expect() {
  local name="$1" want="$2" rel="$3" content="$4" needle="${5:-}"
  local tree="${WORK}/case-$((pass + fail))"
  mkdir -p "$(dirname "${tree}/${rel}")"
  printf '%s\n' "${content}" >"${tree}/${rel}"
  local out rc
  out="$(python3 "${CHECK}" "${tree}" 2>&1)"
  rc=$?
  if [ "${rc}" != "${want}" ]; then
    bad "${name}" "exit=${rc}, want ${want}" "${out}"
  elif [ -n "${needle}" ] && ! grep -qF -- "${needle}" <<<"${out}"; then
    bad "${name}" "output does not name '${needle}'" "${out}"
  else
    ok "${name}"
  fi
}

expect "Playwright .not.toBe(410) on a status" 1 \
  ts/svelte/free2z/tests/browser/legacy-route-redirects.spec.ts \
  '    expect(hop.status(), path).not.toBe(410);' \
  "legacy-route-redirects.spec.ts:1"
expect "Playwright .not.toContain(status) over a status list" 1 \
  ts/svelte/free2z/tests/browser/legacy-route-redirects.spec.ts \
  '    expect([301, 302, 410], path).not.toContain(hop.status());'
expect "node test .not.toEqual(404)" 1 ts/svelte/free2z/tests/x.test.mjs \
  '  expect(res.status).not.toEqual(404);'
expect "pytest != 405" 1 py/free2z/dj/apps/test_anonymous_access.py \
  '    assert response.status_code != 405, f"{method.upper()} {path} is not allowed"' \
  "test_anonymous_access.py:1"
expect "pytest != 404" 1 py/free2z/dj/apps/dyte/test_webhook_signature.py \
  '    assert response.status_code != 404, response.content'
expect "pytest != 429 (throttle isolation)" 1 py/free2z/dj/apps/test_throttling.py \
  '        assert signup.status_code != 429, ('
expect "pytest not in (200, 201)" 1 py/free2z/dj/apps/g12f/test_captcha_replay.py \
  '        assert signup.status_code not in (200, 201), ('
expect "if status != 200: return NEUTRAL (the embed card rule)" 1 \
  py/free2z/dj/apps/g12f/test_first_party_embed_card_contract.py \
  '    if response.status_code != 200:'
expect "DRF constant: != status.HTTP_404_NOT_FOUND" 1 py/free2z/dj/apps/x/tests/test_y.py \
  '    assert r.status_code != status.HTTP_404_NOT_FOUND'
# Wrapped by the formatter -- a per-line scan saw neither (codex review).
expect "multiline pytest not in (...)" 1 py/free2z/dj/apps/test_m.py \
  "$(printf '    assert response.status_code not in (\n        404,\n        405,\n    )')" \
  "test_m.py:1"
expect "multiline .not.toBe(\n410,\n)" 1 ts/svelte/free2z/tests/browser/m.spec.ts \
  "$(printf '    expect(response.status()).not.toBe(\n      410,\n    );')"
expect "multiline expect(...status...) subject" 1 ts/svelte/free2z/tests/browser/m.spec.ts \
  "$(printf '    expect(\n      hop.status(),\n      path,\n    ).not.toBe(302);')"
expect "an exemption with no reason is not an exemption" 1 py/free2z/dj/apps/test_z.py \
  "$(printf '    # status-negation-ok:\n    assert r.status_code != 404')"
expect "an exemption separated by code does not carry over" 1 py/free2z/dj/apps/test_z.py \
  "$(printf '    # status-negation-ok: no redirect of any kind is the contract\n    x = 1\n    assert r.status_code != 301')"

# --- green: what must NOT be flagged ----------------------------------------
expect "exact status assertions" 0 py/free2z/dj/apps/test_ok.py \
  "$(printf '    assert r.status_code == 404\n    assert r.status_code in (401, 403)')"
expect "Playwright exact .toBe(301)" 0 ts/svelte/free2z/tests/browser/ok.spec.ts \
  '    expect(hop.status(), path).toBe(301);'
expect "same shape in application code is not a test" 0 py/free2z/dj/apps/social/clients.py \
  '            if tok.status_code != 200:'
expect "a docstring that mentions != 429 is prose" 0 py/free2z/dj/apps/test_throttling.py \
  '#. These tests used to assert only ``!= 429``, which stayed green if the'
expect "not.toBe on a non-status value" 0 ts/svelte/free2z/tests/ok.test.ts \
  '  expect(title).not.toBe("");'
# A three-digit number that is not a status is not a finding (codex review).
expect "not.toBe(320) on a layout width" 0 ts/svelte/free2z/tests/browser/ok.spec.ts \
  '    expect(width).not.toBe(320);'
expect "subprocess returncode != 127" 0 py/free2z/dj/apps/test_proc.py \
  '    assert proc.returncode != 127, proc.stderr'
expect "exit_code != 124 / errcode != 404 / exit_status != 127" 0 scripts/free2z/tests/test_exit.py \
  "$(printf '    assert r.exit_code != 124\n    assert result.errcode != 404\n    assert run.exit_status != 127')"
expect "expect(statusBar.count).not.toBe(200)" 0 ts/svelte/free2z/tests/browser/ok.spec.ts \
  '    expect(statusBar.count).not.toBe(200);'
expect "not.toContain over a status-named list is not a status subject" 0 ts/svelte/free2z/tests/ok.test.ts \
  '    expect(statuses).not.toContain(statusBar.label);'
expect "res.statusCode is still a status" 1 ts/svelte/free2z/tests/x.test.mjs \
  '  expect(res.statusCode).not.toBe(500);'
expect "a status statement does not bleed into the next one" 0 ts/svelte/free2z/tests/browser/ok.spec.ts \
  "$(printf '    expect(r.status()).toBe(200);\n    expect(box.width).not.toBe(320);')"
expect "a reasoned exemption on the line above" 0 py/free2z/dj/apps/g12f/test_crawler_prerender.py \
  "$(printf '    # status-negation-ok: the contract is "no redirect of any kind";\n    # the exact 404 is asserted on the next statement.\n    assert response.status_code not in (301, 302, 307, 308), (')"
expect "a reasoned exemption on the same line" 0 ts/svelte/free2z/tests/browser/ok.spec.ts \
  '    expect(r.status()).not.toBe(500); // status-negation-ok: any non-5xx is the contract here'

# --- and the real tree is clean --------------------------------------------
if out="$(python3 "${CHECK}" 2>&1)"; then
  ok "the repository has no unexempted negated status assertions"
else
  bad "the repository has no unexempted negated status assertions" "${out}"
fi

echo
echo "check-negative-status-assertions tests: ${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]
