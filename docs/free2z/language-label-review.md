# Free2Z language-label review gate

The `analyze_zpage_language_labels` management command is an opt-in, bounded,
read-only aggregate inventory. Its default invocation prints only the plan;
`--scan` is required to read public pages. It excludes creator-labelled rows,
uses a fixed primary-key upper bound and keyset batches, samples bounded title and start/middle/end body windows under one total character cap,
and reports counts grouped by detection path and stored primary language. A
script mismatch is a cheap heuristic, not a language identification result or
ground truth. The command never calls a provider, emits page text or identity,
or writes labels.

## Re-detection decision: NO-GO pending evidence

No production aggregate analysis has been run for this decision. Do not start a
re-detection pass or relabel existing content based on this code or the offline
corpus. First, an authorized operator must run and review bounded aggregate
results, then assess a provider quote using the actual candidate count, model,
input/output token prices, and planned sample caps. Those inputs are not yet
measured here, so no candidate count or cost estimate is claimed. The corpus
only pins sampling blind spots; it does not measure provider accuracy. Any later
re-detection decision needs human review of those aggregate and cost inputs and
must preserve creator-set labels.
