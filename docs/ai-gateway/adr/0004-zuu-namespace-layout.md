# ADR 0004 — The f2z-sdk namespace in this repository

**Status:** Accepted (owner, 2026-09-26) · **Refs:**
[#1047](https://github.com/free2z/zuu/issues/1047),
[#1048](https://github.com/free2z/zuu/issues/1048),
[CARGO-WORKSPACE](../../architecture/CARGO-WORKSPACE.md)

## Context

The v1 platform adds a gateway service, a Zcash scanner service, a Rust
SDK core, a Tauri plugin, two npm packages and a reference app. Some are
published for strangers to depend on; some run only on the platform;
some are AGPL and some MIT. The repository already has conventions for
each of those things — `rs/` for Rust services and shared crates with its
own workspace and gate, `wallet/plugins/` for Tauri plugins with a
mirrored `guest-js` package, `ts/` for TypeScript, `docs/` with one
directory per subsystem — and a decided boundary on Cargo workspaces.

The owner's direction is that **new, non-sensitive code is born in this
repository**, the public one. Secrets, store credentials, viewing keys,
deployment manifests and the identity provider and ledger themselves stay
in the platform's private backend.

## Decision

| Path | Package | Published | Licence |
|---|---|---|---|
| `rs/crates/f2z-ai-proto` | `f2z-ai-proto` | crates.io | MIT |
| `rs/crates/f2z-ai` | — | container image only | AGPL-3.0 |
| `rs/crates/f2z-ai-testkit` | — | no (dev-dependency of the two above) | MIT |
| `rs/crates/f2z-sdk` | `f2z-sdk` | crates.io | MIT |
| `rs/crates/f2z-zec-scanner` | — | container image only | AGPL-3.0 |
| `wallet/plugins/tauri-plugin-f2z` | `tauri-plugin-f2z` | crates.io | MIT |
| `wallet/plugins/tauri-plugin-f2z/guest-js` | `@free2z/tauri-plugin-f2z-api` | npm | MIT |
| `ts/sdk` | `@free2z/sdk` | npm | MIT |
| `ts/sdk-ui` | `@free2z/sdk-ui` | npm (later) | MIT |
| `wallet/examples/hello-ai` | — | no | — |
| `docs/sdk/`, `docs/ai-gateway/` | — | rendered docs | — |

Rules that follow from the placement:

1. **The Rust crates join the `rs/` workspace** — one `Cargo.lock`, the
   existing fmt/clippy/deny gate, the existing image pipeline for the two
   services. They do not create a new package root. The Tauri plugin is
   the exception by necessity: it links into a Tauri app graph and lives
   under `wallet/plugins/` as an independent root, exactly as the
   messaging and Zcash plugins do, and for the reasons the workspace ADR
   gives.
2. **`f2z-sdk` has no Tauri dependency.** The plugin depends on the SDK
   core, never the reverse, so a non-Tauri Rust program (a CLI, a server,
   another framework's plugin) can use the core.
3. **`f2z-ai-proto` has no I/O**: serde types, the SSE event enum, the
   catalogue schema with signature verification, the error enum and
   `price_2z()`. It is the one crate both the service and the SDK
   depend on, and it is what the OpenAPI document and the TypeScript types
   are generated from.
4. **Third parties consume published packages only.** No path
   dependency into this repository is a supported way to integrate.
   Pre-1.0 versions follow a strict changelog; `1.0` freezes the public
   surface.
5. **Servers are AGPL, shared crates are MIT** (`rs/README.md`). The
   testkit is MIT so that a third party can run the same mock provider and
   ledger-contract fixtures against their own integration.
6. **`docs/sdk/` is the developer product**; `docs/ai-gateway/` holds
   the gateway's decisions. Guides (D2), generated reference (D3) and
   security and operations notes (D4) are added under `docs/sdk/` as they
   land, and each spec document links to the reference that supersedes
   its examples.
7. **The plugin supports Tauri 2 from 2.5 up** (`tauri = "2"`, peer
   `@tauri-apps/api ^2.5`), and CI builds it against the lowest and the
   highest supported versions, for desktop, iOS and Android.

## Consequences

- The gateway inherits, on its first commit, the gate that already
  protects the relay: toolchain pin, fmt, clippy `-D warnings`, cargo-deny,
  the Markdown link check, and the digest-pinned image supply chain.
- Adding the SDK core to `rs/` means its dependency graph is audited by
  the same `deny.toml` as the services; a crate acceptable in an app may
  be unacceptable here, and that is discovered in CI.
- Two Tauri-plugin conventions now exist in `wallet/plugins/` (the
  messaging and Zcash plugins, and this one); they must stay identical in
  shape — `guest-js`, permissions files, the plugin-permissions check — so
  that the existing scripts govern the new plugin without a special case.
- The repository is public. Anything that is not safe to publish —
  provider keys, store credentials, viewing keys, deployment detail — is
  not in scope for any path above, and a change that would need one is a
  sign the code belongs in the private backend instead.

## Alternatives rejected

- **A separate `f2z-sdk` repository.** Cleaner for a package consumer's
  first impression; worse for the platform. The gateway and the SDK share
  `f2z-ai-proto` and its fixtures, the plugin shares tooling with two
  existing plugins, and the parallel-agent workflow of this repository
  depends on one trunk. A mirror for discoverability can be added later
  without moving anything.
- **The gateway in the private backend repository.** It has no secrets
  in its source, its contract is public, and a third party benefits from
  reading it. Only its deployment is private.
- **A `sdk/` top-level directory holding every language.** It would
  create a fourth Rust root outside `rs/` and a second TypeScript root
  outside `ts/`, each needing its own gate, for the sake of a name.
