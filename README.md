# ZUU

**The Zcash User Universe**

ZUU is a synthetic monorepo for building Free2Z products against the Zcash
ecosystem from source. It brings our applications, shared wallet code,
documentation, and upstream Zcash projects into one integration tree.

Our flagship app is [ZUULI](wallet/zuuli/): a Zcash-native desktop and mobile
app that combines a self-custody wallet with the free2z platform's AI,
livestreaming, articles, and 2Z economy. ZUULI is experimental; its implemented
surfaces and known release gaps are tracked in
[its status document](wallet/zuuli/STATUS.md).

> [!IMPORTANT]
> Local `main` is read-only. Every change starts from `origin/main` in a new
> branch and isolated worktree, goes through an issue and pull request, and is
> squash-merged on GitHub. Local `main` moves only with
> `git pull --ff-only origin main`. Read [AGENTS.md](AGENTS.md) before changing
> anything.

## What makes this a synthetic monorepo?

The [`z/`](z/) tree vendors 30 Zcash-ecosystem repositories as Git submodules,
organized as `z/{github-owner}/{repository}`. Our applications can therefore
build and test against real upstream source instead of waiting for published
packages. The complete, authoritative list of submodule URLs and tracked
branches is [`.gitmodules`](.gitmodules).

This repository tracks upstream HEAD and fixes forward. If a dependency update
exposes a bug in our code, we port our code. If it exposes a genuine upstream
regression, we contribute the fix upstream and use a reachable fork commit only
as a temporary bridge. [AGENTS.md](AGENTS.md) documents that contribution
doctrine and the repository's dependency guardrails.

Submodules are intentionally not initialized in a fresh worktree. Initialize
only what your project needs; initializing the entire ecosystem is expensive.
ZUULI and Zuuallet currently require `librustzcash`:

```bash
git submodule update --init --recursive z/zcash/librustzcash
```

## Repository map

| Path | Purpose | Start here |
| --- | --- | --- |
| [`wallet/zuuli/`](wallet/zuuli/) | Flagship ZUULI desktop/mobile app (React, TypeScript, Tauri, Rust) | [README](wallet/zuuli/README.md), [status](wallet/zuuli/STATUS.md), [contributor instructions](wallet/zuuli/CLAUDE.md) |
| [`wallet/plugins/tauri-plugin-zcash/`](wallet/plugins/tauri-plugin-zcash/) | Shared native wallet engine over `librustzcash` | [README](wallet/plugins/tauri-plugin-zcash/README.md), [contributor instructions](wallet/plugins/tauri-plugin-zcash/CLAUDE.md) |
| [`wallet/zuuallet/`](wallet/zuuallet/) | Focused reference wallet using the shared plugin | [README](wallet/zuuallet/README.md), [contributor instructions](wallet/zuuallet/CLAUDE.md) |
| [`ts/react/free2z/`](ts/react/free2z/) | Free2Z React frontend | [README](ts/react/free2z/README.md) |
| [`ts/svelte/free2z/`](ts/svelte/free2z/) | Free2Z Svelte frontend | [README](ts/svelte/free2z/README.md) |
| [`py/dj/proj/zuu/`](py/dj/proj/zuu/) | Open-source Free2Z Django backend components | [README](py/dj/proj/zuu/README.md) |
| [`docs/`](docs/) | Product, architecture, operations, and contributor documentation | [parallel-agent workflow](docs/PARALLEL-AGENTS.md) |
| [`z/`](z/) | Upstream Zcash ecosystem Git submodules | [submodule manifest](.gitmodules) |
| [`scripts/`](scripts/) | Repository-wide Rust, dependency, and CI policy checks | [Rust guardrails](AGENTS.md#guardrails-that-keep-us-honest) |

## Prerequisites

Install only the toolchains needed by the project you choose:

- Git is required; the GitHub CLI (`gh`) is used for the issue/PR workflow.
- ZUULI frontend development uses Node.js 24, matching CI, and `npm`.
- Native wallet work uses `rustup`; [`wallet/rust-toolchain.toml`](wallet/rust-toolchain.toml)
  selects the exact Rust compiler for every wallet crate.
- Tauri builds need platform-specific
  [system dependencies](https://v2.tauri.app/start/prerequisites/). iOS and
  Android builds also need their respective Xcode or Android SDK/NDK tooling;
  [the ZUULI README](wallet/zuuli/README.md#run-it) lists the project commands.
- [`.devcontainer/`](.devcontainer/) is an optional general-purpose development
  container. Project READMEs and CI remain authoritative for current build
  commands and versions.

## Quick start: explore ZUULI in a browser

The fixture-backed browser mode is the lightest way to explore the flagship UI;
it does not require Rust, native SDKs, or submodules:

```bash
git clone https://github.com/free2z/zuu.git
cd zuu/wallet/zuuli
npm ci
VITE_MOCK=1 npm run dev
```

Mock mode is UI/demo evidence, not an end-to-end wallet or production proof.
For the real staging API, native wallet, tests, release state, and mobile
commands, continue with the [ZUULI README](wallet/zuuli/README.md) and
[`wallet/zuuli/CLAUDE.md`](wallet/zuuli/CLAUDE.md).

## Find work

- Start with open issues labeled
  [`agent-ready`](https://github.com/free2z/zuu/issues?q=is%3Aissue%20is%3Aopen%20label%3Aagent-ready).
- [`good first issue`](https://github.com/free2z/zuu/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22)
  identifies narrower entry points; `help wanted` marks work where another
  contributor is especially useful.
- Read the issue, its linked code, and the closest `CLAUDE.md` before claiming
  it. Comment on the issue so parallel contributors do not duplicate work.
- If the work is not already tracked, open an issue with a bounded scope and
  acceptance criteria before writing code.

## Contribution workflow

The full process, including review, CI, merge, and safe cleanup, is in
[docs/PARALLEL-AGENTS.md](docs/PARALLEL-AGENTS.md). The short version for a
repository collaborator is:

1. Create or claim one issue and mark it `in-progress`.
2. Fetch the remote, then create one isolated worktree and branch from
   `origin/main` (never from local `main`):

   ```bash
   git fetch origin
   git worktree add -b <type>/<issue>-<slug> <worktree-path> origin/main
   ```

3. Make one focused change, follow the nearest project instructions, and run
   the relevant checks in that worktree.
4. Push the branch and open one pull request against `main`; include
   `Closes #<issue>` in its body.
5. Wait for required CI and an approving review. A red gate never merges.
6. Squash-merge on the remote. Only then fast-forward the primary checkout's
   local `main` from `origin/main` and perform the audited worktree cleanup.

Contributors without repository push access should still start from an issue,
keep local `main` clean, branch from the upstream `main`, and open the pull
request from a fork.

## Zcash ecosystem sources

The submodules currently span:

- **Core protocol and nodes:** Zcash, Zcash Foundation, and Zakura projects,
  including `librustzcash`, Orchard, Zebra, Zallet, Zcash, and Zakura.
- **Wallets and SDKs:** Zcash mobile SDKs, ZODL wallets, Warp, and ZWallet.
- **Community implementations:** ChainSafe WebZjs, Zingo Labs, Nozy Wallet,
  and QED-it's ZSA work.

Always use [`.gitmodules`](.gitmodules) rather than this summary when deciding
which upstream repository and branch a path tracks.

## License

ZUU's own source is available under the [MIT License](LICENSE). Each Git
submodule is an independent upstream repository with its own license and
contribution rules.
