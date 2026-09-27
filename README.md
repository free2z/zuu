# ZUU

**The Zcash User Universe** is a multipurpose monorepo for applications,
protocol libraries, developer SDKs, experiments, and shared tooling. Projects
have their own runtime, dependency graph, release process, and license.

Upstream repositories are tracked as Git submodules under [`z/`](z/). Projects
that consume them build against source; initialize only the submodules your
project needs. [AGENTS.md](AGENTS.md) describes the upstream and contribution
workflow.

## Project index

| Project or collection | Entry point |
| --- | --- |
| Free2Z app suite | [Architecture](docs/free2z/app-suite/architecture.md), [status](docs/free2z/app-suite/status.md), [development](docs/free2z/app-suite/development.md) for the ZUULI wallet authority, Free2Z content app, and E2E2Z messaging app |
| ZUULI | [`wallet/zuuli/`](wallet/zuuli/README.md), [readiness](wallet/zuuli/STATUS.md), [build infrastructure](docs/zuuli/build/ZUULI-LINUX-BUILD-IMAGE.md) |
| Zuuallet | [`wallet/zuuallet/`](wallet/zuuallet/README.md), a separate wallet application |
| Free2Z developer SDK and metered AI | [SDK contract and integration](docs/free2z/sdk/README.md), [gateway architecture](docs/free2z/ai-gateway/README.md), [`f2z-sdk`](rs/crates/f2z-sdk/Cargo.toml) |
| Free2Z messaging and key transparency | [Protocol documentation](docs/free2z/messaging/README.md), [Rust libraries](rs/README.md) |
| Free2Z cross-app intent bridge | [Protocol and authority boundaries](docs/free2z/intent-bridge/PROTOCOL.md) |
| Free2Z web clients | [React](ts/react/free2z/README.md), [Svelte](ts/svelte/free2z/README.md) |
| Free2Z backend scaffold | [`py/dj/proj/free2z/`](py/dj/proj/free2z/README.md) |
| Free2Z public documentation site | [`docs/about-free2z/`](docs/about-free2z/README.md) |
| Reusable Tauri plugins | [`wallet/plugins/`](wallet/plugins/): named packages with independent consumers and lockfiles |
| Rust libraries and services | [`rs/`](rs/README.md): named `f2z-*` crates and their own workspace |
| Zcash retrieval experiment | [`py/experiments/zcash-rag/`](py/experiments/zcash-rag/): experimental Python code, independent of the shipping apps |
| Upstream projects | [`z/`](z/); [`.gitmodules`](.gitmodules) records repository ownership and tracking branches |

The app-suite architecture applies to those named applications. It does not
assign every project a wallet role or make every SDK depend on a Zcash wallet.
Current product capabilities and acceptance evidence belong in the relevant
project's documentation.

## Working in this repository

Read [AGENTS.md](AGENTS.md) and the selected project's local instructions.
Use isolated worktrees, issues, reviewed PRs, and the required CI gates; local
`main` is a clean fast-forward mirror of the remote.

- [Project namespaces and repository audit](docs/zuu/NAMESPACES.md)
- [Parallel-agent workflow](docs/PARALLEL-AGENTS.md)
- [Dependency exception register](docs/DEPENDENCIES.md)
- [Rust policy runtime observations](docs/ci/RS-POLICY-RUNTIME.md)

Choose the project first, then follow its build instructions. For example, the
**ZUULI browser UI mock** runs without native SDKs or submodules:

```bash
git clone https://github.com/free2z/zuu.git
cd zuu/wallet/zuuli
npm ci
VITE_MOCK=1 npm run dev
```

That command demonstrates ZUULI's fixture-backed UI. Other projects have their
own entry points; it does not validate a wallet, SDK, or service end to end.

## Licensing

Licenses are package-specific. Read the selected package's `LICENSE` and
manifest and the upstream project's license for code under `z/`. This
repository includes MIT and AGPL-licensed components; the root [LICENSE](LICENSE)
is not a claim that every project or dependency uses one license.
