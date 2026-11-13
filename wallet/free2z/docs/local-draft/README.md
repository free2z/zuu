# Free2Z on-device draft evaluation — refs #1295

This is a browser evaluation prototype, **default off**, not a rollout or an
issue closure. It belongs to `wallet/free2z`, the unprivileged content surface.
It adds no native command, permission, wallet dependency, seed access, provider
API, schema or generated API surface. The retained classic editor's paid
`AIzPageDialog` and Free2Z's existing server conversation path remain separate.
No local text is imported into their paid/persisted retry records.

## Reproduce

1. `npm ci` in `wallet/free2z`.
2. `VITE_LOCAL_DRAFT_EVALUATION=1 npm run build` and `npm run preview`.
3. Open `/local-draft.html` on localhost or HTTPS. This is an explicit evaluation
   entry, also linked from AI Studio only in evaluation builds. Default builds
   emit neither this page nor the runtime bundle.
4. For an authorized evaluation deployment, serve `/local-draft-policy.json`
   with `{"version":1,"enabled":true}`, `Cache-Control: no-store`, no redirects,
   outside any service-worker/offline cache. The checked-in policy is **false**.
   A local tester can edit this public JSON temporarily; restore false afterward.
5. Check capability, review the download/storage disclosure, then opt in. Only
   then are the fixed public model files fetched. Enter synthetic prompts only.
6. Cancel releases the worker. Remove model cache deletes this feature's cache.
   Use the explicit server link if unsupported or the result is poor. The draft
   is not transferred; type a new message and press Send on the ordinary chat.

The page has its own restrictive CSP. Vite dev/preview also set a worker
response CSP. A different static host must apply that same response header to
`/assets/inference.worker-*.js`:

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://huggingface.co https://raw.githubusercontent.com https://cas-bridge.xethub.hf.co https://us.aws.cdn.hf.co
```

Do not loosen the seed-holding wallet's CSP or the native content app's CSP to
run this evaluation. Native Tauri contexts are deliberately refused. No browser
or physical-device support is inferred from the platform name.

## Model and runtime provenance

One model: **HuggingFaceTB SmolLM2-360M-Instruct**, 360 million parameters,
commercially usable under Apache-2.0 according to its [pinned upstream model
card](https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct/blob/a10cc1512eabd3dde888204e902eca88bddb4951/README.md).
The [MLC conversion's model card](https://huggingface.co/mlc-ai/SmolLM2-360M-Instruct-q4f32_1-MLC/blob/1e6b2ca3684e2bc8a6d39eb36e8d6cd51eb12bda/README.md)
identifies that base model. This is a 4-bit `q4f32_1` conversion, **not** a
full-precision 360M download. f32 here refers to runtime arithmetic. f16 was
considered but not selected because the available software adapter lacks
`shader-f16`.

The authoritative file inventory and SHA-256 values live in
[`artifacts.json`](../../src/features/ai/local/artifacts.json). Weights revision:
`1e6b2ca3684e2bc8a6d39eb36e8d6cd51eb12bda`; compiled library revision:
`146ed9cd4b4062e967b017fd2291f7106b50599f`, WebLLM-compatible `v0_2_87/base`.
The inventory pins seven weight shards, config, tensor manifest, tokenizer and
WASM: **212,426,251 bytes / 202.59 MiB** total. Shard hashes are upstream LFS
SHA-256 object identities; small-file and compiled-library hashes were derived
from the actual pinned upstream responses. Runtime checks size and SHA-256 for
**every** artifact, including warm-cache reads and weight shards, before use.
All pinned URLs are literal HTTPS; CDN redirects deliver hash-checked bytes
without cookies, Authorization or a Referer. No remote code is imported.

Runtime: `@mlc-ai/web-llm` **0.2.88**, exact dependency with npm tarball integrity
in `package-lock.json`. Its code is bundled into a same-origin, code-split worker asset loaded only
after opt-in. The upstream `LICENSE` is emitted as `webllm.LICENSE.txt`. Consulted current [basic
usage](https://webllm.mlc.ai/docs/user/basic_usage.html), [worker
usage](https://webllm.mlc.ai/docs/user/advanced_usage.html#using-workers), and
[official model configuration](https://github.com/mlc-ai/web-llm/blob/main/src/config.ts),
then inspected installed `engine.d.ts`, `config.d.ts`, and the actual
CacheStorage/fetch implementation. This prototype wraps `MLCEngine` in its own
worker protocol to control lifecycle and artifact IO.

`web-llm`, `web-runtime` 0.28.0-dev2, `web-tokenizers` 0.1.6 and `web-xgrammar`
0.1.27 declare Apache-2.0; type packages and loglevel declare MIT. This adds one
direct dependency, no fork or Cargo patch; the repository's fork/patch exit
register therefore needs no exception. [Apache-2.0.txt](Apache-2.0.txt) retains
the license text. Model author: Hugging Face; conversion/runtime author: MLC.
The converted repository has no separate LICENSE file or contrary terms; its
base-model declaration links the original license. No model binaries are
redistributed in this repository.

## Lifecycle, privacy and remote control

- An actual worker `navigator.gpu.requestAdapter()` followed by
  `requestDevice()` validates runtime capability and the required storage
  buffer limit. A successful probe is **not** a generation/performance promise.
  WebLLM creates/checks its own runtime device and errors fail closed.
- A single Web Lock owns the cache across tabs for the lifetime of the worker.
  The worker downloads, bounds, verifies and stores artifacts, loads WebLLM and
  streams real generation. The UI thread never runs inference. Context is
  limited to 1024 tokens, input to 2000 characters, output to 32 tokens.
- Only `free2z-local-draft-smollm2-360m-v1` is used. The runtime receives a
  read-only verified CacheStorage view and a fetch function which only reads
  pinned cached URLs. Runtime-created shared caches and additional network
  calls fail. A partial existing inventory fails rather than silently repairing
  it. The next download requires a new support/opt-in choice.
- Cancellation, timeout, page exit, worker errors, invalid replies and policy
  failure terminate the owned worker and fence late callbacks by generation.
  Download cancellation/failure deletes the app-owned cache, with deletion
  failures disclosed. Cancelling a ready runtime retains verified artifacts;
  Remove acquires ownership before deleting. No other feature's cache is swept.
  Termination releases worker memory/GPU resources to the browser; timing of
  driver/OS reclamation cannot be guaranteed. HTTP caches, browser internal
  copies and OS caches cannot be securely erased by this application.
- Policy is read without credentials, redirects or HTTP cache before the probe,
  each load and each generation; it is also checked every 30 seconds and on
  visibility resume. Failure, timeout, malformed version or non-boolean `true`
  denies local mode and terminates active work. Policy checks time out at five
  seconds. Suspended tabs and noncompliant intermediary caches cannot promise
  instantaneous remote revocation. Offline local operation intentionally fails
  closed. Ordinary server chat never reads this policy.
- The evaluation entry imports no API transport, account bootstrap, diagnostic
  reporter, prompt persistence or paid-action recovery code. Text stays in
  ephemeral page/worker memory and renders as plain text. No provider fallback,
  URL-in-prompt fetch, external telemetry or automatic download exists. Download
  CDNs can observe IP/request metadata. Browser extensions/OS remain outside
  this page's protection. Switching to server is a user navigation and never
  transfers or submits the local prompt.

## Validation and remaining acceptance

See [REPORT.md](REPORT.md) for measured results and explicit NOT RUN/OPEN rows.
`tests/local-draft.pw.ts` labels simulated workers as control fixtures; they are
not model/quality evidence. `artifact-cache.test.ts` uses tiny synthetic bytes
to prove size/hash rejection and no-network warm/cache-failure behavior.

The executable synthetic-only runner is
[`scripts/local-draft-benchmark.mjs`](../../scripts/local-draft-benchmark.mjs).
It requires explicit `--run`, accepts localhost only, blocks live API calls,
and closes its disposable browser. `--controls-only` skips generation and
checks real cache eviction, real public-download cancellation and explicit
server navigation. Its optional software-adapter flag never
establishes physical device support.
