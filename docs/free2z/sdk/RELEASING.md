# SDK package verification and release ordering

The Rust core is merged; package publication and live acceptance are still
pending. The supported third-party dependency model is crates.io/npm packages.
Source previews and local tarball checks are development tools, not a released
installation. See [INTEGRATION.md](./INTEGRATION.md) for current readiness.

## Artifact verification before publication

The two reusable Rust crates include source, license, README and changelog.
Repository fake examples and prose/fixture integration tests stay in the source
checkout: they depend on repository paths and are not a consumer API. Run those
repository tests before packaging. The SDK and protocol crate still inherit
`publish = false`; this preparation does not enable publication.

Run `python3 scripts/check-sdk-packages.py` from a clean public source checkout.
It exports the committed SDK/protocol source into an independent temporary Git
snapshot, builds `.crate` archives, checks their allowlisted contents, then
compiles/runs a fresh consumer using the **unpacked archives**. Add
`--with-native` once the native plugin is in that checkout to audit its archive
and compile it against the same unpacked core. `--source-root` permits running
this checker against another clean public worktree; generated output remains
inside that source worktree's `target/sdk-package-preview` directory.

The snapshot avoids a reproduced Cargo 1.97.1 VCS-inspection failure in this
synthetic monorepo's shared worktrees: `cargo package --list` can report
`No such file or directory` after `check_repo_state`, while the same files
package in an independent Git repository. No shared Git configuration or
submodule registration is changed. The snapshot's VCS metadata belongs to a
test artifact; **do not upload these preview archives as releases**. Build
release archives from a clean canonical checkout after the release PR merges.

Since `f2z-ai-proto` is not yet in the registry, the local SDK packaging check
uses a Cargo dependency override. The consumer override points only to the
unpacked protocol archive; the SDK archive has a normal versioned registry
dependency. This proves archive completeness and cross-package compilation,
not registry availability. Native verification similarly stages the unpacked
core. No `cargo publish`, npm publication or live API calls
occur in this checker.

## Publication sequence

A release PR must record independent review, exact-head green required gates,
version/changelog decisions, package-file audits, native platform results and
the live acceptance evidence the release claims. Keep preview claims separate
from desktop/iOS/Android system-browser and credential-store evidence.

Only an explicitly authorized release operator enables publishing for the
intended crates. Publish in dependency order:

1. `f2z-ai-proto`.
2. `f2z-sdk`, after crates.io serves the exact protocol version.
3. `tauri-plugin-f2z`, after crates.io serves the exact core version.
4. `@free2z/tauri-plugin-f2z-api` and `@free2z/sdk`, with compatible versions.

For each step, first rebuild/package from the release commit, inspect the
archive, and use the registry's official metadata endpoint to verify the name
and version after publishing. Then repeat consumer builds without local
patches or path dependencies. Those commands are operator actions; this guide
and its verification script do not publish anything.

The native crate must include Android sources/Gradle consumer rules, iOS Swift
sources/package manifest, permissions and generated command registration data.
A Rust compile alone does not prove those assets are present. The npm packages
must include emitted JavaScript/types and license/readme, and install in an
isolated consumer without monorepo path dependencies. The SDK's
`npm run test:package` checks that pre-publication tarball boundary.

Before announcing live readiness, run the app acceptance flow with registered
public clients and approved test accounts on desktop, iOS, Android and web:
login, reload/restart, sign-out/revocation, balances, purchase confirmation,
stream cancellation, pending settlement, broken-body recovery, and completed
same-key replay. Third-party store-payment limitations and the distinction
between cancelling delivery and cancelling a charge must remain visible in
the released integration guide.
