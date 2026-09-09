# `rs / changes` runtime observations

Measured on 2026-09-09 for [#939](https://github.com/free2z/zuu/issues/939).
The required job in [`rs.yml`](../../.github/workflows/rs.yml) has a **300-second
budget**. Retain that budget and every unconditional policy/self-test command:
four recent hosted jobs took **128–174 seconds**, or **43–58%** of the budget.
These are observations, not a worst-case bound or a promise about future runners.

## Hosted evidence

GitHub's job and step timestamps have one-second resolution; a reported zero
means below that resolution. Job duration includes setup and checkout, so it
need not equal the sum of policy steps. Each policy row combines its self-test
and live check; signing combines its self-test and Node test suite.

| Step (seconds) | Main | App PR | Ownership PR | Budget PR |
| --- | ---: | ---: | ---: | ---: |
| Action pins / fail-closed jobs | 43 | 41 | 61 | 40 |
| Gate wiring | 0 | 1 | 0 | 0 |
| Hash-domain labels | 1 | 0 | 1 | 0 |
| Markdown links | 0 | 0 | 0 | 1 |
| Server image policy | 0 | 1 | 1 | 0 |
| Apple signing controls | 2 | 3 | 23 | 3 |
| Rust toolchain pin / census | 70 | 93 | 76 | 90 |
| **Complete job** | **128** | **148** | **174** | **144** |

Exact jobs and source heads:

- [Main job](https://github.com/free2z/zuu/actions/runs/34361718293/job/102500095136), `882cdef492bee3a5b60ec1b10f179b5f1a41cace`.
- [App PR job](https://github.com/free2z/zuu/actions/runs/34361774407/job/102500291876), `20fe9628b966c0851fa34f1cae51c60ec282e77c`.
- [Ownership PR job](https://github.com/free2z/zuu/actions/runs/34361957881/job/102500917251), `4111676586697d355be4cb9db80317c4eedc2eca`.
- [Budget PR job](https://github.com/free2z/zuu/actions/runs/34367512931/job/102519953363), `e298e37dff481fa781d8260511640bf06308ea6b`.

## Decision and follow-up

The toolchain and action-policy steps account for most of the observed time.
That does not establish that any of their work is redundant. Do not remove a
mutation control, cache a verdict across different source inputs, or filter a
policy by the paths it is supposed to audit.

Keep the existing serial execution and five-minute timeout. Splitting or
parallelizing the job would add orchestration and gate-contract changes without
an observed timeout in this sample. Raising the timeout is unnecessary on this
evidence. No job, path selector, command order, policy pin, or mutation control
changes with this record.

Use **210 seconds (70%)** as an observation trigger: when a completed job reaches
that duration, record its per-step times and compare a few adjacent runs before
choosing a focused optimization or budget change. This is a review convention,
not an automated monitor. A new timing failure gate was considered and deferred:
runner and certificate-generation variation would make wall time an additional
source of merge failures, while the existing 300-second timeout already bounds
the job. A timeout or repeated growth warrants investigation immediately.

## Reproduce hosted measurements

This reads GitHub metadata only; it does not rerun CI or execute PR code.
Set `run_id` to an `rs` workflow run and retain the exact source SHA with the
result. `gh`, Python 3, and repository read access are required.

```bash
run_id=34361718293
timing_file="$(mktemp "${TMPDIR:-/tmp}/rs-policy-job.XXXXXX")"
gh api "repos/free2z/zuu/actions/runs/$run_id" --jq .head_sha
gh api --paginate "repos/free2z/zuu/actions/runs/$run_id/jobs?per_page=100" \
  --jq '.jobs[] | select(.name == "rs / changes")' > "$timing_file"
python3 - "$timing_file" <<'PY'
import datetime
import json
import sys
from pathlib import Path

job = json.loads(Path(sys.argv[1]).read_text())
def elapsed(item):
    if not item.get('completed_at'):
        raise SystemExit('Wait for a completed job before measuring it.')
    start = datetime.datetime.fromisoformat(item['started_at'].replace('Z', '+00:00'))
    end = datetime.datetime.fromisoformat(item['completed_at'].replace('Z', '+00:00'))
    return (end - start).total_seconds()

print(job['html_url'], job['conclusion'])
print(f"job: {elapsed(job):.0f}s")
for step in job['steps']:
    print(f"{elapsed(step):.0f}s\t{step['conclusion']}\t{step['name']}")
PY
rm "$timing_file"
```
