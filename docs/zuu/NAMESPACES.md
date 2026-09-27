# Project namespaces in ZUU

ZUU is a multipurpose monorepo. A path identifies the owner and scope of its
contents; it does not make one product the default for unrelated work.

## Adding a project or subsystem

1. Put project-specific documentation under `docs/<owner>/<subsystem>/`, or
   next to its named implementation. For example, two independent SDKs can
   live at `docs/free2z/sdk/` and `docs/example-project/sdk/`.
2. Register the documentation namespace and its owner/scope in
   [`scripts/project-namespaces.json`](../../scripts/project-namespaces.json).
   Add a new owner without changing the guard's implementation. A short owner
   namespace can contain several named subsystems.
3. Name code packages for their actual purpose within the appropriate language
   or product collection. A reusable library need not belong to an application;
   declare its package boundary and consumers. Avoid generic new project roots
   such as `sdk`, `sdk-ui`, or a third-party dependency's name.
4. Keep runtime identifiers, published package names, licenses, and release
   boundaries independent of directory cleanup. Moving an API or module is a
   separate compatibility decision.
5. Update links, source includes, fixtures, build contexts, CI selectors, policy
   digests, and package/release inputs together. Required checks must still
   select the affected consumers after a move.

The root README is a project index. Architecture, status, roadmap, and quickstart
claims belong to the named project. A shared toolchain default does not imply a
shared runtime graph: the SQLite version required by a Zcash wallet graph does
not constrain an unrelated program. Package manifests and licenses determine
licensing; the root license is not a blanket assertion about all projects.

[`check-project-namespaces.mjs`](../../scripts/check-project-namespaces.mjs)
runs before change selection in both protected workflows. It checks explicit
documentation ownership and rejects retired ambiguous paths. Its fixtures
prove that named projects, multiple SDKs, and deliberately shared repository
policy coexist. The manifest's repository-wide documentation exceptions are
explicit; new product documentation should not be added to that exception list.

## Documentation audit

The following map records scope, not a change to runtime behavior. Paths in the
first column are historical locations or retained paths.

| Location | Decision / destination | Reason |
| --- | --- | --- |
| `docs/architecture.md`, `docs/status.md`, `docs/development.md` | `docs/free2z/app-suite/` | These describe the named three-app suite, not every ZUU project |
| `docs/release/` | `docs/free2z/app-suite/release/` | Store capture/setup and mobile OAuth evidence belongs to those apps |
| `docs/architecture/CARGO-WORKSPACE.md` | `docs/free2z/app-suite/build/CARGO-WORKSPACE.md` | Independent wallet/app/plugin release trains; scoped graph constraints |
| `docs/ZUULI-*.md` | `docs/zuuli/build/` | ZUULI image/capture infrastructure |
| `docs/e2ee/` | `docs/free2z/messaging/` | Free2Z messaging, enrollment and key-transparency contract |
| `docs/intent-bridge/` | `docs/free2z/intent-bridge/` | Named app-suite protocol shared by several applications |
| `docs/sdk/`, `docs/ai-gateway/` | `docs/free2z/sdk/`, `docs/free2z/ai-gateway/` (coordinated namespace change) | The Free2Z developer product; compiled spec tests and CI selectors consume these paths |
| `docs/about-free2z/` | Retain | Named public documentation site, with its own build and assets |
| `docs/DEPENDENCIES.md` | Retain, owned by ZUU | Enforced repository dependency exception/exit-condition register |
| `docs/PARALLEL-AGENTS.md` | Retain, owned by ZUU | Repository contribution workflow |
| `docs/ci/` | Retain, owned by ZUU | Shared gate-runtime evidence, not a product roadmap |
| `docs/zuu/` | Retain | Repository structure and namespace policy |

The old locations are recorded here only as migration history; they must not
be recreated as live files or directories.

## Whole-repository root audit

This table covers every tracked top-level root at the start of issue #1082.
A language collection or repository tool directory is retained because it
contains named projects or genuinely shared infrastructure, not because it is
an implicit Free2Z application.

| Root | Decision and scope |
| --- | --- |
| `.devcontainer/` | Retain: optional shared development environment; project instructions still select prerequisites |
| `.github/` | Retain: workflows/actions with explicit project selectors and required-gate ownership |
| `.gitattributes`, `.gitignore`, `.gitmodules` | Retain: repository source control metadata; upstream ownership remains in `.gitmodules` |
| `AGENTS.md`, `CLAUDE.md` | Retain: repository contribution rules and routing; product constraints are explicitly scoped |
| `README.md` | Retain: neutral project index and per-package license guidance |
| `LICENSE` | Retain: root license; individual projects and upstreams retain their licenses |
| `docs/` | Retain: named owners/subsystems plus explicit shared-policy exceptions, as mapped above |
| `langchain/` | Follow-up move: its sole `zcash/` experiment belongs at `py/experiments/zcash-rag/`; avoid presenting the third-party LangChain dependency as our project owner |
| `py/` | Retain language collection; follow-up `py/dj/proj/zuu/` → `py/dj/proj/free2z/` reflects the actual Free2Z scaffold and requires updating its Python module references |
| `rs/` | Retain: explicit Rust workspace with named protocol/service/SDK crates; independent from app-local Cargo roots |
| `scripts/` | Retain shared enforcement/tooling; product-only checks should use named subdirectories such as `scripts/free2z/`, with consumers migrated in a coordinated follow-up |
| `ts/` | Retain language collection with named framework/project roots; Free2Z SDK/reference UI work uses `ts/free2z/`, not generic `ts/sdk/` or `ts/sdk-ui/` |
| `update_submodules.sh` | Retain: repository-wide upstream maintenance helper |
| `wallet/` | Retain named wallet/app-suite collection. `shared/` is an explicit package; `plugins/` contains independently reusable, specifically named Tauri packages. Neither forces unrelated SDKs to link a wallet |
| `z/` | Retain: upstream `organization/repository` namespaces; do not rename vendored projects or apply first-party ownership rules to their contents |

The root `rust-toolchain.toml` is added by the coordinated build-policy change
as the shared compiler authority, without a version bump. `wallet/` and `rs/`
retain checked restatements only because isolated build contexts copy or mount
those subtrees. All these moves preserve APIs and runtime identifiers unless a
separately reviewed follow-up explicitly addresses module compatibility.
