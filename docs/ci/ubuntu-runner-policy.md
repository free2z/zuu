# ZUU Ubuntu runner policy

## Decision and support evidence

For [#1227](https://github.com/free2z/zuu/issues/1227), retain Ubuntu 24.04
explicitly rather than migrate to 26.04 during the moving-label rollout.
Checked 2026-11-04 against the primary sources:

- [Official rollout notice](https://github.com/actions/runner-images/issues/14748):
  October 19 through November 19, 2026; recommends `ubuntu-24.04` to retain 24.04.
- [Available images and support policy](https://github.com/actions/runner-images#available-images):
  lists `ubuntu-24.04` (x64) and `ubuntu-24.04-arm` (ARM64).
- [GitHub announcement](https://github.blog/changelog/2026-09-17-ubuntu-26-generally-available-and-latest-migration/):
  26.04 is generally available, but changes/removals require compatibility testing.

This selects a supported OS family; it does **not** pin immutable VM contents.
GitHub updates the image, host kernel, Docker, preinstalled tools and distribution
packages. Apt repositories and downloaded SDKs can also change independently.
No claim is made that every prior `ubuntu-latest` run used 24.04 during rollout,
or that 26.04 has been tested here. A future migration needs a separate review
of support status, packages and representative build/test jobs before changing
the allowlist. Native macOS/Windows labels and mobile/cross-compilation targets
are outside this decision.

## Baseline and complete disposition

Inventory baseline: `7296378e1738c96c940f8228d92c26b35d2f166c`, all 25 workflow YAML files
(and local action YAML), including workflows absent from older inventories.
There are 35 floating selectors in eight workflows: 33 direct job selectors
and two matrix selectors. Every row below changes `ubuntu-latest` to
`ubuntu-24.04` (x64). Matrices retain their other rows and dimensions.

All jobs use the existing verified Python trust bootstrap before network clients.
Host jobs assume Bash, Python 3 with TLS, Git and runner-provided Node for local
policy commands where no setup-node step exists. Rust means the root
`rust-toolchain.toml` channel **1.97.1**, unless explicitly noted as the existing
stable canary; rustfmt/clippy components and WASM/Android targets remain explicit.
`cargo-deny` means the checksum-verified **0.20.2** binary selected by
`scripts/check-rust-deny.sh`, not the image's default Rust or deny version.

| Workflow | Job / selector | Image, tool and package assumptions retained |
| --- | --- | --- |
| `dependency-register.yml` | `offline` | Node 24.22.2; offline dependency-register policy. |
| `dependency-register.yml` | `upstream` | Node 24.22.2; public upstream status queries. |
| `docs-about-free2z.yml` | `build` | Node 24.22.2, npm ci and Docusaurus build. |
| `rs.yml` | `changes` | Host Node/Git; policy and change detection. |
| `rs.yml` | `payment_hooks` | Pinned Rust + rustfmt/clippy; native Linux release/test binaries. |
| `rs.yml` | `rs_fmt` | Pinned Rust + rustfmt. |
| `rs.yml` | `rs_clippy` | Pinned Rust + clippy; native Linux linker/system libraries. |
| `rs.yml` | `rs_deny` | Pinned Rust; cargo-deny. |
| `rs.yml` | `rs_test` | Pinned Rust; host Docker runs digest-pinned Redis (see below); process/crash tests. |
| `rs.yml` | `rs_wasm` | Pinned Rust with wasm32-unknown-unknown; compile-only browser contracts. |
| `rs.yml` | `gate` | Host Node/Git; all existing needs/results remain required. |
| `ts-react-free2z.yml` | `build` | Node 24.22.2; npm ci --legacy-peer-deps, React tests/build. |
| `ts-svelte-free2z.yml` | `build` | Node 24.22.2; npm ci/check/test; libxml2-utils via isolated Ubuntu package installer. |
| `wallet-surfaces.yml` | `surfaces_rust` | Pinned Rust; free2z/e2e2z app matrix; Tauri Ubuntu packages (see below). |
| `zuuallet.yml` | `fmt` | Pinned Rust + rustfmt. |
| `zuuallet.yml` | `deny` | Pinned Rust; cargo-deny. |
| `zuuallet.yml` | `clippy` | Pinned Rust + clippy; Tauri Ubuntu packages (see below). |
| `zuuallet.yml` | `frontend` | Node 22.23.4; npm ci/build/test. |
| `zuuallet.yml` | `rust` | Digest-pinned Linux CI container; Node 24.22.2, pinned Rust; GTK/WebKit and native build libraries supplied by container. |
| `zuuallet.yml` | `upstream-canary` | Existing stable Rust action; fresh upstream librustzcash/dependencies; Tauri Ubuntu packages. This remains a dependency canary, not an OS canary. |
| `zuuli.yml` | `changes` | Host Node/Git; policy and change detection. |
| `zuuli.yml` | `frontend` | Node 24.22.2; pinned Rust + wasm32-unknown-unknown; frontend/WASM boundary, unit and Playwright suites. |
| `zuuli.yml` | `surfaces` | Node 24.22.2; app matrix free2z/e2e2z; npm test includes Playwright. Existing mocked Tauri browser suites retained. |
| `zuuli.yml` | `rust_fmt` | Pinned Rust + rustfmt. |
| `zuuli.yml` | `rust_deny` | Pinned Rust; cargo-deny. |
| `zuuli.yml` | `rust_clippy` | Digest-pinned Linux CI container; pinned Rust + clippy. |
| `zuuli.yml` | `rust_plugin` | Digest-pinned Linux CI container; pinned Rust; production-route-probe plugin tests. |
| `zuuli.yml` | `rust_msg_plugin` | Digest-pinned Linux CI container; Node 24.22.2, pinned Rust; relay-harness tests and WASM authority checks. |
| `zuuli.yml` | `rust_android_32` | Pinned Rust + armv7-linux-androideabi; Temurin Java 21.0.12; runner ANDROID_HOME/cmdline-tools/latest sdkmanager installs NDK 27.0.12077973. |
| `zuuli.yml` | `rust_app` | Digest-pinned Linux CI container; pinned Rust; locked Tauri app build/test. |
| `zuuli.yml` | `zuuallet_schema` | Digest-pinned Linux CI container; Node 24.22.2, pinned Rust action; locked schema build. |
| `zuuli.yml` | `free2z_sdk_typescript` | Node 22.23.4; npm ci, formatting, tests and package contract. |
| `zuuli.yml` | `sdk_native` | matrix.os Ubuntu entry only; pinned Rust, Node 24.22.2; apt libwebkit2gtk-4.1-dev, libayatana-appindicator3-dev, librsvg2-dev, patchelf; macOS/Windows rows retained. |
| `zuuli.yml` | `sdk_mobile` | matrix.include Android OS only; pinned Rust; Temurin Java 21.0.12; existing Android/iOS targets and iOS macOS row retained. |
| `zuuli.yml` | `gate` | Host Node/Git; policy recheck and full required-job verdict unchanged. |

Tauri host package set in `wallet-surfaces.surfaces_rust`, `zuuallet.clippy`
and `zuuallet.upstream-canary`: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
`libayatana-appindicator3-dev`, `librsvg2-dev`, `libsoup-3.0-dev`,
`libjavascriptcoregtk-4.1-dev`, `libxdo-dev`, `libdbus-1-dev`, `libssl-dev`,
`build-essential`, `curl`, `wget`, `file`, `pkg-config`, installed through
`scripts/install-ubuntu-deps.sh` using the runner's Ubuntu source definition.
These are package names, not frozen package versions.

The six affected container jobs retain
`ghcr.io/free2z/zuuli-linux-ci@sha256:bb07838e6e6c4a138943e1254a7f1613c4860e4bfabc87fd1e0d18073de1015f`.
This is an immutable container-content reference; its 24.04 VM host label is not.
The Redis service in `rs_test` retains
`redis@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2`
and its health/cleanup contract in [rs.yml](../../.github/workflows/rs.yml).

## Already explicit selectors, unchanged

The baseline's remaining Ubuntu selectors were already `ubuntu-24.04`.
This census includes newer release/image/web workflows, even though they had no
floating selectors to replace. `zuuli-packaging.desktop` and `zuuli.rust_crypto_targets` are matrix Linux rows.
No ARM64 runner selector existed in this baseline; cross-target ARM builds do
exist and are unchanged. Policy also permits `ubuntu-24.04-arm` for ARM64 hosts;
it must never be replaced with an x64 label as a label cleanup.

| Workflow | Already explicit jobs / matrix rows |
| --- | --- |
| `cache-cleanup.yml` | `closed-pr`, `sweep`, `footprint-guard` |
| `e2e2z-release.yml` | `prepare`, `android-build`, `android-sign-upload`, `android-finalize` |
| `f2z-images.yml` | `f2z_image_policy`, `f2z_image_pull_request`, `f2z_image_publish` |
| `free2z-host-release.yml` | `policy`, `build`, `publish` |
| `free2z-release.yml` | `prepare`, `android-build`, `android-sign-upload`, `android-finalize` |
| `free2z-web-ci.yml` | `ui`, `ui-tests`, `docs`, `ui-browser`, `api-client`, `dependency-security`, `dependency-security-static`, `react`, `lint-python`, `backend`, `native-payment-bridge`, `gate`, `images`, `changes` |
| `free2z-web-host-dispatch.yml` | `dispatch` |
| `free2z-web-release.yml` | `publish`, `release` |
| `zuuli-linux-image.yml` | `validate`, `pull-request-build`, `publish` |
| `zuuli-packaging.yml` | `contract`, `android`, `desktop` |
| `zuuli-release.yml` | `prepare`, `android-build`, `android-sign-upload`, `android-finalize`, `linux`, `release-index` |
| `zuuli-store-audit.yml` | `audit` |
| `zuuli-store-capture-image.yml` | `validate`, `pull-request-build`, `publish` |
| `zuuli-store-publish.yml` | `publication-gate` |
| `zuuli-testflight-bootstrap.yml` | `bootstrap` |
| `zuuli-testflight-invite.yml` | `invite` |
| `zuuli-testflight-recovery.yml` | `inspect` |
| `zuuli.yml` | `rust_crypto_targets` |

## Enforcement and validation limits

[Action policy](../../scripts/check-github-actions-pins.mjs) scans discovered
workflow/action YAML for complete Ubuntu runner-label literals, including matrix
values and expression fallbacks. Only 24.04 x64/ARM64 labels are reviewed;
floating latest/slim and other OS versions fail. Comments, installer filenames
and cache-key suffixes are not runner-label literals. This source check does not
resolve arbitrary dynamically constructed runner names; keep Ubuntu labels literal.
Fixtures prove new-file discovery and scalar, quoted, array, matrix/include,
expression-fallback, ARM alias and unreviewed-version rejection, plus preservation
of explicit ARM64 and native platforms. Existing exact gate/Android source
assertions now bind 24.04; permissions, needs, containers, action SHAs and toolchain
pins are unchanged.

Local validation for this label/policy/documentation change is static: action
policy, workflow-gate, Android-gate and CI-trust self-tests/live checks, YAML parse,
namespace and Markdown link checks. No Rust/frontend build or 26.04 experiment is
claimed. Current-diff cloud CI was neither awaited nor used as evidence; successful
local checks establish source contracts, not a successful hosted job run. The
supported-image pin is the chosen alternative to a 26.04 validation campaign.
