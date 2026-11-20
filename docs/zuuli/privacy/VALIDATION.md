# ZUULI Tor validation record

2026-11-12, implementation based on `b4e3d79334b6ee56f0796776db6251e821d5dd4a`.
Threat model, exact traffic coverage and remaining acceptance are in [TOR.md](TOR.md).
This record separates actual network behavior from fixtures and physical devices.

## Actual native I/O

- **Shipping helper and shipping app lock:** the ignored app test
  `network::tests::shipping_wallet_rpc_reads_lightd_info_through_tor` passed.
  It calls `tauri_plugin_zcash::wallet::client::connect_to_lightwalletd`, then
  generated `get_lightd_info`, asserts a positive chain height, suspends the
  policy, and asserts the **same client** can no longer perform that RPC.
  It uses the app's tonic 0.14.6 graph and the fixed production 127.0.0.1:9050
  proxy address. No wallet is created/unlocked and no transaction is submitted.
  Evidence: `.evidence/787/shipping-tor-read.log`.
- Owned C Tor **0.4.9.11**, SafeSocks=1 / TestSocks=1, reported bootstrap 100%
  and recorded that the application delegated hostname resolution to Tor.
  The process was stopped with TERM after the read. Evidence:
  `.evidence/787/shipping-tor-runtime.log`. This establishes the test's Tor
  process, not an identity-verification capability in the shipping application.
- An earlier standalone transport read also returned HTTP 200 / gRPC status 0
  over TLS/HTTP2 using an owned Tor listener on 19050. Evidence:
  `.evidence/787/public-read.log`. The shipping-helper probe above is the
  stronger evidence because it uses the actual wallet helper and app lock.

## Controlled fixtures and negative controls

- Native policy tests pass: remote hostname SOCKS encoding; real HTTP2 requests
  through the proxy; reachable direct-destination trap; dead/refusing proxy;
  30-second stalled negotiation; direct and old-Tor stream revocation;
  enable-disable-enable; suspended/resumed epochs; connection construction
  queued across a transition; cancellation of blocking workers; and a native
  lifecycle event captured during settings acknowledgement.
  Evidence: `.evidence/787/transport-verified.log`.
- Isolated live DNS fixture: **Tor mode DNS=0 / destination TCP=0**. The same
  test's direct negative control produced **DNS=2 / TCP=1**. A root network/mount
  namespace supplies its own resolver; the host's resolver is never changed.
  Evidence: `.evidence/787/dns-verified.log`.
- The source-inventory alarm checks the shipping helper/epoch seam, the exact
  native HTTP constructor inventory, direct DNS resolver installation, absence
  of the HTTP plugin command registration and HTTP/opener grants, and the
  browser connect prohibition. This is an inventory alarm, not a semantic
  transaction/privacy oracle. Evidence: `.evidence/787/inventory.log`.
- Browser CSP fixture refuses remote fetch **before request dispatch**, with
  the previous remote-connect policy as an allowed negative control. All
  requests in that test are intercepted locally; no production API is called.
  Native UI fixture covers opt-in, degraded status, offline pause, reconnect
  and disable. These are simulated native commands, **not physical devices**.
  Evidence: `.evidence/787/browser-verified.log` (Tor cases).

## Compilation and UI checks

- Full ZUULI native `cargo build --locked` completed on **Ubuntu 24.04.4 / Rust
  1.97.1**. The initial application target was absent. Only the reviewed pinned
  librustzcash submodule was initialized. `CARGO_INCREMENTAL=0`,
  `CARGO_PROFILE_DEV_DEBUG=0`, `-j 2`, and command-line overrides
  `profile.dev.package."*".opt-level=0` / `profile.dev.build-override.opt-level=0`
  bound memory/disk use. These overrides change optimization, not features,
  manifests, the toolchain or lock resolution. This was a native Ubuntu host
  build, **not a container-image validation or mobile build**.
  Evidence: `.evidence/787/native-build-final.log`, with a final cached build
  recorded separately in `.evidence/787/native-build-verified.log`.
- The app-native test executable compiled, including the actual shipping RPC
  probe. All **94 normal app tests passed**; the public read stays ignored unless
  explicitly selected. Full app all-target clippy with `-D warnings` passed.
  Evidence: `.evidence/787/native-probe-build.log`, `native-tests.log`,
  `native-clippy-final.log`.
- Transport clippy with all targets and `-D warnings` passed; its advisory,
  license, ban and source policy checks passed. No cargo-deny suppression or
  SQLite/toolchain upgrade was added. Evidence:
  `.evidence/787/transport-clippy-verified.log`, `transport-deny.log`.
- Production and test TypeScript checks passed. Targeted locale/About/network/
  OAuth/funding unit checks passed **163 tests**, and existing HTTP regression
  checks passed **7 tests**. en/es/fr catalog/source checks remain enforced.
  Evidence: `.evidence/787/typecheck-final.log`, `ui-final.log`,
  `http-verified.log`. Native development keeps its reviewed staging origin
  through the same native policy command instead of falling back to Vite.
- Changed browser tests passed individually, including en/es/fr at narrow
  widths, disabled web mode, keyboard/200% layout, native-state fixtures and
  CSP dispatch refusal. Native linking caused transient cold-module loading
  timeouts in shared runs; the unchanged pseudo-locale assertion passed in
  isolation in **5.5s**, without increasing timeouts or weakening the assertion.
  Evidence: `.evidence/787/playwright-final.log`, `browser-verified.log`,
  `pseudo-browser-verified.log`. Earlier full relevant run also passed feedback,
  CSP and mobile frame-boundary cases; those surfaces retain their assertions.
- Pinned rustfmt, Rust toolchain registration and self-test, namespaces,
  dependency register, immutable-action/workflow checks and compatibility
  checker/self-tests passed. No guard inventory was reduced.

## Existing advisory failure (unchanged)

The full app advisory check **fails** on **RUSTSEC-2026-0459**, bundled
`libsqlite3-sys 0.35.0` through `rusqlite 0.37.0`. The locked package block,
including checksum and dependencies, is identical to the prepared base.
No upgrade, suppression or policy waiver was added in this Tor change.
This is not a clean full-app supply-chain verdict. Evidence:
`.evidence/787/native-advisories.log`, `advisory-baseline.log`.

## External acceptance

**OPEN:** signed Android and iOS devices, actual mobile Tor runtime availability,
background/resume/network-switch/device power/battery measurements, and native
macOS/Windows CI/runtime acceptance. Linux, a local SOCKS fixture, a Chromium
fixture, or a synthetic lifecycle event is never recorded as a physical device.
No system-wide anonymity, sibling-app coverage, verified proxy identity, Nym
protection or actual send acceptance is claimed. Keep #787 open with `Refs #787`.

Cleanup verified no remaining task build/test/server processes, no Tor process,
and inactive Tor runtime units. Only task-owned temporary runtime cache/read
copies were removed. No extra branch, worktree, container or volume was created;
source, evidence logs and build caches remain for subsequent validation.
Evidence: `.evidence/787/cleanup.log`.

## Remote navigation bypass correction

The missing native navigation/new-window boundary is corrected in
`src-tauri/src/navigation.rs`. Configured automatic windows are disabled; the
single main window uses the guarded factory, global navigation backstop and
explicit renderer creation denials. Local routing and IPC remain functional.
Linux additionally refuses WebKit network speculation before the first document
loads. Merely returning false from navigation, or disabling DNS prefetch, was
insufficient: a live anchor fixture initially emitted destination DNS/TCP despite
remaining on the local page. The native WebsiteDataManager refusal policy closes
that path. Direct form posts are also disabled by the packaged form-action
policy to cover Android's documented POST callback limitation.

Regression evidence:

- The exact shipping CSP alone dispatches an intercepted, controlled top-level
  HTTPS navigation in Chromium: dispatched=1. No external request is sent.
- The actual Linux WebKitGTK fixture compiles the same native module and calls
  the production `create_main` factory and global plugin. Isolated DNS/TCP
  counters exercise assignment, anchors, popups, blank-popup retargeting,
  redirects and direct forms. Local routing plus a real Tauri IPC command are
  required positive controls, not mocked browser callbacks.
- Native settings are configured before application HTML is loaded. A dummy
  documentation-range interface only makes GIO's isolated network monitor live;
  it has no physical uplink. The unsafe-sandbox environment flag is confined to
  this root-owned fixture namespace, never shipping configuration.
- Removing the native boundary makes the controlled destination receive DNS=2 /
  TCP=1; the protected cases report DNS=0 / TCP=0. Evidence:
  `.evidence/787/native-navigation-refused.log`; the final extended development
  redirect fixture is recorded in `navigation-acceptance.log`.
- URL-origin/config tests and constructor/permission inventory tests bind the
  native callbacks and factory to production. Browser tests retain the CSP-only
  navigation negative control and form-post dispatch controls. Evidence:
  `navigation-unit.log`, `navigation-inventory.log`, `navigation-browser.log`.

Reproduce the native engine fixture with
`wallet/zuuli-transport/scripts/tor-navigation-fixture.sh` on a Linux host with
Xvfb, D-Bus and permission to create an isolated network/mount namespace. It
creates no wallet, does not call a provider/store API and cannot reach external
network services. This is Linux engine evidence, not signed mobile acceptance.

Post-correction checks passed on the same Ubuntu host and pinned toolchain:
full native build (`final-native-build.log`), all-target clippy with warnings
as errors (`final-native-clippy.log`), **96 app tests**
(`navigation-app-tests.log`), two inventory alarms, 47 authority/CSP checks,
13 relevant browser cases plus the separate direct-form dispatch control, and
production/test TypeScript checks. Namespace, Markdown link, workflow/action,
toolchain, dependency-register, compatibility and rustfmt guards all passed on
the staged final tree (`final-*.log`). The extended native engine fixture also
proved that the exact allowed development origin loads and retains IPC: its
remote redirect produced DNS=0/TCP=0, while the unguarded redirect produced
DNS=2/TCP=1. All six protected native cases passed in
`navigation-acceptance.log`; assignment and redirect controls each reached the
live destination. These checks do not replace the still-open signed-device or
other-platform acceptance, and the known SQLite advisory remains unchanged.
