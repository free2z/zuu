# Rust/WASM spike

Issue [#383](https://github.com/free2z/zuu/issues/383) asked whether first-party
Rust can be compiled for a browser, consumed by a frontend, and kept honest in
CI before a real feature depends on that path. The answer is **yes for ZUULI's
Vite frontend**, with a small baseline cost and some important limits.

## What the spike proves

`wasm-spike` is a dependency-free Rust crate with one deliberately trivial
`i32` export. `npm run wasm:build` compiles it with the repository's pinned Rust
toolchain and `wasm32-unknown-unknown`, validates and calls the export in Node,
then writes an ignored artifact plus metadata binding its SHA-256 to the exact
Cargo manifest, lockfile, Rust source, target, and compiler channel.

Vite 6 consumes the module through its native `?init&no-inline` integration.
The no-inline marker matters: it makes the production `.wasm` independently
auditable instead of hiding 116 bytes in a JavaScript data URL. A post-build
verifier requires exactly one byte-identical emitted module and a JavaScript
reference to its content-hashed filename. Playwright then proves a real browser
instantiates the module, calls the Rust export, and observes the result `42`.
The packaged Tauri WebView carries the narrowly required
`script-src 'wasm-unsafe-eval'` CSP capability; it does not add JavaScript
`'unsafe-eval'`.

Generated files are **not committed or versioned**. Rust source and
`Cargo.lock` are the reviewable inputs, CI always removes and regenerates the
integration output, and Vite owns the final content-hashed asset name. The
always-required change detector self-tests the WASM boundary policy, while the
required frontend job builds and exercises it. Mutations prove that removing
the fresh build, source binding, byte-identity check, browser call, browser
assertion, compiler target, CSP authority, or required policy invocation makes
the gate fail.

The Playwright result is specifically evidence for Vite's plain-browser path.
This spike does not package and execute the module inside macOS, iOS, Android,
or Windows WebViews. Adding `wasm-unsafe-eval` to the reviewed Tauri CSP is the
required source-level prerequisite, not device or package-runtime acceptance
evidence; that distinct evidence belongs with the first real WASM-backed
feature on each release platform.

## Measurements

Measured on 2026-08-23 on an Apple Silicon development host with Rust 1.97.1
and the WASM standard library already installed. The cold command first ran
`cargo clean --manifest-path wallet/zuuli/wasm-spike/Cargo.toml`, so it reused no
crate build output:

The release module is **116 bytes** before transport compression.

| Measurement                                              |               Result |
| -------------------------------------------------------- | -------------------: |
| Clean-target `npm run wasm:build`, wall clock            |               1.37 s |
| Rust build and artifact verification within that command |               1.02 s |
| Warm `npm run wasm:build`                                |         about 0.52 s |
| Release `.wasm`                                          |            116 bytes |
| Release `.wasm`, deterministic gzip (`gzip -n -9`)       |            128 bytes |
| Hosted required-frontend direct WASM overhead            |         about 10.5 s |

The build script reports its own elapsed time, byte count, and SHA-256 in every
CI log. The first replacement-head run for
[PR #535](https://github.com/free2z/zuu/actions/runs/32651540544/job/97223897698)
measured the required frontend job from GitHub's job and step timestamps plus
the build script's own timers. Installing Rust 1.97.1 with the WASM target took
10 seconds. The fresh test build, Playwright web-server build, and production
build reported 107 ms, 23 ms, and 24 ms respectively; the three artifact
negative tests reported 254 ms total, and final dist verification took about
72 ms from log timestamps. Those directly attributable sequential costs total
about **10.5 seconds** within an 8 minute 31 second frontend job.

The real-browser WASM case ran successfully inside the existing 127-case,
two-worker Playwright suite. GitHub's reporter exposes only the aggregate 6.9
minute suite duration for successful tests, so no additional browser-test wall
time is claimed: it was scheduled in parallel and cannot be isolated honestly
from this run. Likewise this is an isolated-cost measurement, not a noisy
before/after claim about the rest of the frontend or packaging pipeline.

## Recommendation

Use this path for future shared Rust logic in `wallet/zuuli`. Vite already has
the necessary bundler behavior, the generated artifact does not need to enter
Git history, and the required gate now owns the compiler, target, browser call,
and freshness contract.

Do not add a parallel integration to `ts/react/free2z` while it remains on
Create React App / `react-scripts` 5. Its WASM customization and test setup
would require an override layer or ejecting the build. Migrate that frontend to
Vite (or another explicitly WASM-capable maintained bundler) first, then reuse
this generated-output contract.

The raw numeric ABI is intentionally the end of this spike, not the beginning
of a hand-written application protocol. A real shared crate should:

1. separate browser-compatible core logic from Tauri, SQLite, filesystem,
   sockets, and other native-only dependencies;
2. pin matching `wasm-bindgen` library and CLI versions, add
   `serde-wasm-bindgen` only when structured JS values are needed, and
   checksum/pin any downloaded build tool;
3. keep native and WASM tests against the same Rust behavior and retain the
   source/artifact/dist/browser proof established here;
4. treat randomness, threads, and large cryptographic dependencies as explicit
   follow-up design work—browser entropy and cross-origin isolation are runtime
   constraints, not Cargo flags to turn on casually.

That is enough infrastructure to prevent a future E2EE core from being
reimplemented in TypeScript, without claiming that the current native wallet
graph can or should compile to a browser unchanged.
