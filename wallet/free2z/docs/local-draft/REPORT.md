# Free2Z local draft evaluation report — refs #1295

Decision: **keep default off**. The prototype is available through an explicit
evaluation build only. Physical desktop/mobile acceptance is OPEN; this report
does not establish universal browser support or latency. No paid provider call
or live user prompt was used.

## Environment and method

2026-11-13, Linux x86-64 Hyper-V VM, two vCPUs (Xeon Platinum 8370C),
`MemTotal` 8,070,688 KiB (7,881.53 MiB), approximately 6 GiB free disk during
validation. `/dev/dri/card1` is `hyperv_drm`, not evidence of a compute GPU.
The T3 shared preview could not launch because the host blocks its browser
sandbox (AppArmor); installed Playwright Chromium 151.0.7922.34 was used.
No emulated viewport or software adapter is treated as a physical phone/GPU.

The production evaluation build uses the exact pinned model/runtime described
in [README.md](README.md). The benchmark launches a disposable browser context,
intercepts **only** the local policy to enable evaluation, and prevents live API
calls. Model artifacts and WebLLM run unchanged; neither inference nor adapter
capability is mocked. Request traces omit CDN query signatures. The script
records browser timings, CacheStorage estimates and Linux process RSS snapshots.
The optional Vulkan/unsafe-WebGPU flags are diagnostics for this VM only and
are not product requirements or a recommendation for end users.

Reproduce from `wallet/free2z`, with the evaluation preview on port 1445:

```
LOCAL_DRAFT_REPORT=/tmp/local-draft-default.json node scripts/local-draft-benchmark.mjs --run
LOCAL_DRAFT_REPORT=/tmp/local-draft-software.json node scripts/local-draft-benchmark.mjs --run --software-adapter
```

`--run` explicitly consents to the public 202.59 MiB download. The script sends
only the synthetic corpus below to the local worker. The enable response is a
local evaluation policy fixture, not a business rollout. The app's checked-in
policy stays false.

## Device/browser/memory matrix

| Device / browser | Memory | Probe / execution | Cold download/load | Warm load | First token / finished | Memory / heat / battery |
| --- | --- | --- | --- | --- | --- | --- |
| Available VM / default Chromium 151 headless | 7,881.53 MiB host RAM | Real `requestAdapter()` returned null; accessible fallback; no model download | NOT RUN, unsupported | NOT RUN | NOT RUN | RSS snapshot in evidence; heat/battery not measurable on VM |
| Available VM / Chromium 151 with Vulkan diagnostic flags | Same host | Software-adapter validation only; result below | Measured below | Measured below | Per corpus below | Linux RSS snapshots only; heat/battery not measurable on VM |
| Physical desktop / Chrome or Edge WebGPU, integrated GPU | Target 8 GiB | NOT RUN / OPEN — unavailable | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Physical desktop / Chrome or Edge WebGPU, discrete GPU | Target 16 GiB | NOT RUN / OPEN — unavailable | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Physical macOS / Safari WebGPU | Target 8 GiB | NOT RUN / OPEN — unavailable | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Physical Android / Chrome | Target 4 GiB | NOT RUN / OPEN — unavailable | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Physical Android / Chrome | Target 8 GiB | NOT RUN / OPEN — unavailable | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Physical iPhone / Safari | Target 4–8 GiB | NOT RUN / OPEN — unavailable | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Desktop Firefox | Unavailable | NOT RUN / OPEN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

A 375×812 viewport regression covers layout, keyboard access and pointer/disabled
cursors with a **simulated worker**. It is not a mobile browser, memory, heat or
battery benchmark.

## Synthetic quality corpus and rubric

Deterministic request settings: temperature 0, seed 1295, 32 output-token cap,
1024 context-token cap, independent single-turn conversations (reset before and
after each run). Ratings are manual observations, not a universal quality score:
0 unusable/unsafe; 1 needs major corrections; 2 useful with minor edits;
3 meets the stated instruction and preserves facts. N/R means no completed
inference, not a score of zero. These three easy English tasks cannot establish
multilingual, factual, financial or adversarial reliability.

1. `Write one sentence thanking a volunteer for planting trees.` Expected:
   one warm sentence, no invented specifics.
2. `Summarize in one sentence: The library opens at nine. It closes at five. It is closed on Sunday.`
   Expected: retain the hours and Sunday exception without inventing AM/PM.
3. `Rewrite politely: I cannot attend the meeting tomorrow.` Expected:
   polite refusal preserving tomorrow, without inventing reasons or promises.

## Measurements and observed limitations

The initial 128-token-limit attempt loaded the actual model in **6,592 ms**
(worker measurement, including capability recheck, download, hash verification
and initialization; policy/initial page load excluded). The observed
download/verification plus runtime-import phase occupied approximately 4,505 ms
between its first download status and first runtime-load status. These are one
run on one network/VM, not latency promises.

Its first synthetic generation did not finish before the **120-second**
application deadline. The app terminated the worker and removed its cache;
there was no provider request. The automation's animation-frame polling then
hit its own 130-second wait limit, despite the timeout message being recorded
by its DOM observer. The final runner uses timer polling so GPU/compositor
starvation cannot hide that status. This attempt provides no completed output,
first-token measurement or quality rating.

Summed Linux process RSS snapshots were **397,560 KiB** before the probe and
**1,096,000 KiB** after load. Summing RSS double-counts shared pages and samples
miss peaks; these numbers are neither unique memory footprint nor GPU memory.
The runtime's upstream VRAM estimate is not substituted for a measurement.
All observed requests in this attempt were GETs for page/runtime assets, model
artifacts and policy; no request body or provider API call occurred. Raw,
query-redacted evidence: [default browser](evidence/chromium-default.json),
[initial 128-token attempt](evidence/chromium-vulkan-128-attempt.json).

The final prototype limits output to 32 tokens to bound short draft work.
The additional real run measured **6,862 ms cold load**, **3,629 ms warm load**,
and **212,428,383 bytes** CacheStorage usage (payload plus observed browser
bookkeeping). Warm load retained the verified model and performed no additional
artifact network fetch. These worker timings exclude the policy GET and page
startup, but include hash verification and runtime device/model setup.

Generation of corpus item 1 again produced **no token** and hit the application's
120-second deadline; measured wall time to the accessible failure was
**120,080 ms**. Items 2 and 3 were not run after that failure. First-token and
finished-completion latency are **not available**, rather than zero. The final
UI says “not measured” for such missing metrics and clears prior-generation
timings before each new attempt. The application deadline safely terminated
the worker and removed the model cache. No claim of successful inference is
made from a successful load.

| Corpus item | Completed output | Rating | Reason |
| --- | --- | --- | --- |
| Volunteer thanks | None | N/R | Real generation attempted; no token observed before 120-second timeout |
| Library summary | NOT RUN | N/R | Execution stopped after first failure |
| Polite refusal | NOT RUN | N/R | Execution stopped after first failure |

RSS snapshots in this second run were 391,304 KiB before probing,
1,098,748 KiB after cold load, 1,075,756 KiB after warm load and 981,700 KiB
after the timed-out generation. These are summed process RSS snapshots with
shared pages double-counted, not peaks. Retained driver/browser resources can
outlive worker termination; the page does not promise immediate OS reclamation.
Heat and battery could not be measured. [Raw final-limit run](evidence/chromium-vulkan-32-attempt.json).

All unavailable physical-device metrics remain OPEN regardless of software
load success. **No device is accepted for rollout by these results.**

A separate real-worker control run (no simulated adapter, runtime, model bytes
or cache implementation) loaded cold in 6,872 ms and warm in 3,390 ms. Deleting
the actual model cache then pressing Generate produced the explicit cache-loss
fallback before inference. After a fresh opt-in, cancellation while real public
artifacts were downloading took 143 ms from the automated click to the cleanup
message; the app cache was absent and zero workers remained. This is one
observation, not a cancellation-latency guarantee. Explicit server navigation
opened an empty composer. Its metadata GETs were intercepted with 503 by the
benchmark, and **zero non-GET requests** occurred throughout. The local canary
was never submitted. [Raw control run](evidence/chromium-vulkan-controls.json).

## Controls and validation

The browser controls suite uses explicitly named simulated workers to test
remote kill, worker errors, cancel/late-reply fencing, offline policy denial,
manual fallback, cross-tab ownership and small-screen keyboard/cursor behavior.
Those timings and outputs never count as inference evidence. Tiny-byte unit
fixtures test artifact size/SHA rejection, corrupt/partial warm cache behavior,
no-network cache reads, unknown-artifact rejection and controller state fencing.
The real default-browser unsupported case separately executes the actual worker.

Fallback is tested as a link requiring user activation. It opens the ordinary
server composer empty; no local prompt is transferred or automatically sent.
The benchmark uses the production, non-mock server entry with all live API
requests blocked and recorded, including metadata GETs after explicit fallback.
No completion POST is permitted. Failure of the local policy does not disable
the ordinary server chat.

Remaining acceptance: repeat the same corpus on the physical rows above with
cold/evicted caches and warm starts, record hardware/browser versions, observe
OS memory/GPU allocations, and measure thermal/battery behavior with available
platform tools over a stated duration. Review errors, prompt-length limits and
quality before any rollout proposal. No physical acceptance checkbox is claimed
complete by this change.

Final focused validation:

- Production and test TypeScript checks passed.
- 12 local-draft unit cases passed; 16 Playwright cases passed across the local
  controls, existing AI conversation switching and existing paid-intent suites.
- 35 CSP/surface-authority cases and four UI-copy cases passed. Live Rust/WASM
  source policy, Tauri generated-permission parity (including negative
  controls), namespace self-test and namespace ownership checks passed.
- The full project-boundary audit passed across five projects, 535 source
  files, 2,413 parsed imports and three constrained production Vite builds.
  Unchanged sibling dependencies were installed from their lockfiles to run it.
- Default and evaluation production builds were checked separately; the default
  build emits no evaluation HTML or WebLLM license/runtime graph. Existing large
  chunk warnings remain informational.
- An additional, unrelated `wallet/zuuli/scripts/wasm-boundary.node-test.mjs`
  run could not pass its binary-fixture cases: this prepared checkout lacks
  `wallet/zuuli/wasm-spike/generated/zuu_wasm_spike.wasm` (ENOENT). Its live
  source-policy check passed. No Rust graph/toolchain change or fabricated WASM
  fixture was introduced for this content-app task.

The model/runtime source pins and raw browser observations are reviewable in
this directory and `src/features/ai/local/artifacts.json`. Simulated-control
outputs are intentionally absent from the inference/quality evidence files.

[Focused validation transcript](evidence/validation.txt) records the command
outputs; raw model/browser reports above record the separate real-runtime
experiments. Default-build exclusion and evaluation-build success were also
verified after the final UI state/measurement changes.

A final production-entry smoke check used the actual shipped policy JSON
without route fixtures: local mode was denied, no worker was started, and no
model or provider request occurred. [Raw shipped-off check](evidence/shipped-policy-off.json).
The emitted WebLLM license matched the installed package license byte-for-byte.
All owned browser contexts, workers, development/test servers and the preview
were stopped after validation.
