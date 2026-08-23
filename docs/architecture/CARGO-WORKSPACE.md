# Cargo workspace boundary

Status: accepted on 2026-08-23. This records the decision for
[issue #341](https://github.com/free2z/zuu/issues/341).

## Decision

Keep the three existing Rust package roots independent:

- `wallet/plugins/tauri-plugin-zcash/`
- `wallet/zuuli/src-tauri/`
- `wallet/zuuallet/src-tauri/`

Each remains the root of its own Cargo resolution, lockfile, profiles, and
target directory. Do not add a virtual workspace above all three merely to
deduplicate configuration.

The durable boundary is the **release train**, not the repository. ZUULI and
Zuuallet are separately built applications, while `tauri-plugin-zcash` is a
reusable package that must also work and test standalone. A product may use a
product-scoped workspace later if it grows several inseparable internal crates;
that does not imply a single workspace for every Rust package under `wallet/`.

## Why

### The committed lockfiles describe real, different states

The three locks are not duplicate files waiting to be moved. At the time of
this decision, ZUULI resolves Tauri 2.11.5 and `aws-lc-rs` 1.17.3, while the
standalone plugin and Zuuallet resolve Tauri 2.10.2 and `aws-lc-rs` 1.15.4.
There are many more compatible-version differences in their transitive graphs.
A shared lock would therefore begin with a coordinated dependency update, not
a no-op relocation.

That independence is bounded by integration checks:

- the standalone plugin is tested with its own lock on Linux and native Apple
  and Windows hosts, and type-checked for 32-bit Android;
- Zuuallet is built with `wallet/zuuallet/src-tauri/Cargo.lock`, which compiles
  the plugin as a path dependency in Zuuallet's resolved graph; and
- ZUULI is built and tested with `wallet/zuuli/src-tauri/Cargo.lock`, which
  compiles the same plugin in the graph that ZUULI ships.

The plugin's unit tests do not replace either application build, and an
application build does not replace the plugin's standalone tests. These are
three intentional proofs of three supported contexts.

### The release system owns the current layout

ZUULI's build, packaging, and protected release commands run the Tauri CLI from
`wallet/zuuli` with `-- --locked`. Its release identity and version-bump code
read `src-tauri/Cargo.lock`; its cache and artifact collection use
`src-tauri/target`; and its generated Android and Apple projects invoke the
same app-local Tauri project.

Cargo supports Tauri packages in a workspace. Tauri itself is not the blocker.
The blocker is changing all of those proven paths at once while also changing
the resolved graph used by Android, iOS, macOS, Linux, and Windows. The profile
duplication is cheaper and safer than that migration today.

### A shared target directory would not make the current gate faster

The expensive app and plugin checks run in parallel on different hosted
runners. A workspace's common `target/` cannot be shared between those
machines. CI already gives each graph a deliberately scoped cache; combining
the jobs would trade parallel wall-clock time for serial compilation and a
larger cache. Revisit this only with measurements from a concrete replacement,
not Cargo's same-machine workspace behavior.

### One lockfile is not one runtime graph

Cargo resolves all workspace members into one lockfile, but a command still
builds the selected package and its dependencies. A common lock would constrain
which versions can coexist and would centralize profiles and updates; it would
not make the two applications one binary or remove the need to build each
application on every shipped target.

The `links = "sqlite3"` rule remains repository-wide policy even with separate
locks. Both applications link `tauri-plugin-zcash`, so a crate that eventually
joins either app must resolve the established `rusqlite` / `libsqlite3-sys`
line. Independent locks are not permission to postpone that compatibility
check.

## Adding Rust crates

Before adding a manifest, prefer putting app-specific code in that app and
shared wallet code in `tauri-plugin-zcash`. A crate boundary should represent a
real ownership or reuse boundary, not directory organization.

When a new crate is justified:

1. **App-internal crates** belong under that app's `src-tauri/` tree. If there
   will be several of them, a workspace rooted at that app's `src-tauri/` may
   share the app lock and profiles without coupling the two release trains.
2. **Reusable crates** live under `wallet/plugins/` (or another clearly shared
   `wallet/` subtree), keep a standalone `Cargo.lock` if they are supported
   standalone, and are added as explicit path dependencies to every consumer.
3. Copy the load-bearing `profile.dev`, `profile.dev.package."*"`,
   `profile.dev.build-override`, and `profile.release` settings from an existing
   root. Dependency optimization is required for usable debug wallet sync.
4. Commit the lockfile that `cargo --locked` will consume. Update and test every
   consuming application's lockfile in the same change when the new crate
   enters its graph.
5. Run the repository's manifest-discovering format, clippy, and cargo-deny
   checks. Add explicit locked build/test coverage for the new supported
   context; discovery alone does not decide which platforms it promises.
6. Preserve the repository-wide Rust toolchain and SQLite singleton rules in
   `AGENTS.md`.

Do not create a repository-root workspace. Cargo automatically enrolls path
dependencies below a workspace root, and this synthetic monorepo contains
upstream Cargo projects under `z/` that are not ours to govern as workspace
members. If a wallet-wide workspace is ever adopted, its candidate root is
`wallet/`, with explicit members and exclusions.

## Revisit triggers

Do not re-litigate this decision without at least one of these changes:

- ZUULI and Zuuallet are intentionally moved onto one dependency-update and
  release cadence;
- two or more additional shared Rust crates are planned, making standalone
  lock/profile maintenance a material recurring cost;
- a dependency or feature divergence escapes the existing per-app locked
  builds and causes a shipped defect;
- measured CI data shows that a proposed shared job/cache is faster than the
  current parallel jobs; or
- release tooling is deliberately made independent of the app-local lock and
  target paths as part of another migration.

At that point, consolidation is accepted only after a migration proves:

- a virtual `wallet/Cargo.toml` with explicit members, exclusions, and resolver;
- one reviewed dependency-resolution diff and one root profile definition;
- locked standalone-plugin and per-app builds/tests;
- native plugin tests on Linux, macOS, and Windows;
- Android builds for every shipped ABI and an iOS device archive;
- desktop bundles on every shipped host;
- unchanged generated Tauri projects and permission/schema outputs; and
- updated release identity, bump, cache, artifact-collection, and supply-chain
  checks.

Until those proofs and a revisit trigger exist, the three-root layout is the
chosen architecture rather than unresolved cleanup.
