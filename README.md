# ZUU

**The Zcash User Universe** — a synthetic monorepo where Free2Z's applications
are built against the Zcash ecosystem *from source*.

Thirty upstream repositories are vendored as Git submodules under [`z/`](z/), so
our apps compile against real upstream HEAD instead of published packages. We
stay on HEAD and contribute fixes upstream rather than pinning to old commits —
[AGENTS.md](AGENTS.md) is the doctrine.

## Three apps, one seed, no shared privilege

ZUULI used to be one Tauri app that held the Zcash seed **and** rendered
third-party content. [#367](https://github.com/free2z/zuu/issues/367) showed
that cannot hold: Wry injects Tauri's IPC bridge into *every* iframe, and
Android's IPC reports the top-level URL as the origin — so a remote subframe
resolves as the trusted main window and can invoke privileged commands. The
generalisation is that any embed policy permissive enough to be useful is too
permissive to sit next to seed access.

So it is three apps ([#904](https://github.com/free2z/zuu/issues/904)):

| App | Role | Holds | Renders remote content | Privileged plugins |
| --- | --- | --- | --- | --- |
| [`cash.free2z.zuuli`](wallet/zuuli/) | wallet authority | master seed, spending keys, account-level messaging keys | **never** | `zcash` |
| [`cash.free2z.free2z`](wallet/free2z/) | content — articles, creator, live, AI, search | Knox token, 2Z balance | **yes** | **none** |
| [`cash.free2z.e2e2z`](wallet/e2e2z/) | messaging | device keys + device credential | **never** | `f2zmsg` |

**The argument, in two sentences.** The app that holds the seed renders nothing
we do not control, and the app that renders untrusted content registers no
`invoke_handler`, links no privileged plugin, and grants no `zcash:*` or
`f2zmsg:*` capability — so a hostile subframe there finds nothing privileged to
reach. That is mechanical rather than customary:
[`surface-capability-authority.mjs`](wallet/zuuli/scripts/surface-capability-authority.mjs)
runs inside the required CI gate and fails if either delegated surface gains
one.

Ongoing messaging never needs the seed, only enrollment does — account keys and
device keys are already separated by
[`docs/e2ee/ARCHITECTURE.md`](docs/e2ee/ARCHITECTURE.md) §4.2, which is what
makes a third app possible instead of a compromise.

### How they talk

Over a versioned [**intent bridge**](docs/intent-bridge/PROTOCOL.md): one-shot,
expiring, single-use requests in three defined families — `execute-payment`,
`issue-device-credential`, `sign-challenge`. ZUULI is the only signing
authority: for `execute-payment`, the one family it implements today, it
re-derives its own review from its own wallet state, confirms natively, and
acts. No other app can spend or sign. The other two families are refused with
`INTENT_UNKNOWN_INTENT`, which is not a lie — this build does not implement
them.

> [!IMPORTANT]
> **The bridge has no transport.** Both caller sides build real, validated
> requests and then fail closed at one named seam, because verified App Links /
> Universal Links ([#461](https://github.com/free2z/zuu/issues/461)) are not
> wired. **Nothing crosses between apps today.** ZUULI's hardening
> ([#904](https://github.com/free2z/zuu/issues/904) phase 4) is also still in
> progress. [**docs/status.md**](docs/status.md) is the honest ledger: what
> works, what fails closed by design, and what is blocked.

## Read next

| | |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | The three-app split in depth — the threat, the target, what enforces it |
| [docs/status.md](docs/status.md) | What works, what fails closed, what is blocked |
| [docs/development.md](docs/development.md) | Build, test, and the CI gate model |
| [docs/intent-bridge/](docs/intent-bridge/PROTOCOL.md) | The cross-app protocol: wire format, authority side, caller authentication, conformance |
| [docs/e2ee/](docs/e2ee/README.md) | The E2EE messaging design and key transparency |
| [AGENTS.md](AGENTS.md) · [docs/PARALLEL-AGENTS.md](docs/PARALLEL-AGENTS.md) | Contribution doctrine and the parallel-agent workflow |

## Repository map

| Path | Purpose |
| --- | --- |
| [`wallet/zuuli/`](wallet/zuuli/) | ZUULI, the wallet authority ([status](wallet/zuuli/STATUS.md)) |
| [`wallet/free2z/`](wallet/free2z/) | free2z, the content surface |
| [`wallet/e2e2z/`](wallet/e2e2z/) | e2e2z, the messaging surface |
| [`wallet/shared/`](wallet/shared/) | `@free2z/wallet-shared` — the one client-side intent implementation |
| [`wallet/plugins/`](wallet/plugins/) | [`tauri-plugin-zcash`](wallet/plugins/tauri-plugin-zcash/README.md), [`tauri-plugin-f2zmsg`](wallet/plugins/tauri-plugin-f2zmsg/README.md) |
| [`wallet/zuuallet/`](wallet/zuuallet/) | Focused reference wallet over the shared plugin |
| [`rs/crates/`](rs/README.md) | Protocol crates — `f2z-intent`, `f2z-codec`, messaging, key transparency |
| [`ts/react/free2z/`](ts/react/free2z/README.md) · [`ts/svelte/free2z/`](ts/svelte/free2z/README.md) | Free2Z web frontends |
| [`py/dj/proj/zuu/`](py/dj/proj/zuu/README.md) | Open-source Free2Z Django backend components |
| [`z/`](z/) | Upstream Zcash submodules — [`.gitmodules`](.gitmodules) is authoritative |
| [`scripts/`](scripts/) | Repository-wide policy checks run by CI |

## Quick start

The fixture-backed browser mode needs no Rust, native SDKs, or submodules:

```bash
git clone https://github.com/free2z/zuu.git
cd zuu/wallet/zuuli
npm ci
VITE_MOCK=1 npm run dev
```

Mock mode is UI evidence, not an end-to-end wallet. For real builds, tests, and
mobile commands see [docs/development.md](docs/development.md) and the per-app
READMEs.

## Contributing

Start from an open issue — [`agent-ready`](https://github.com/free2z/zuu/issues?q=is%3Aissue%20is%3Aopen%20label%3Aagent-ready)
and [`good first issue`](https://github.com/free2z/zuu/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22)
are the entry points.

> [!IMPORTANT]
> **Local `main` is read-only.** Every change branches from `origin/main` in its
> own worktree, goes through an issue and a pull request, and is squash-merged
> on GitHub. Local `main` moves only with `git pull --ff-only origin main`. Read
> [AGENTS.md](AGENTS.md) before changing anything; the full loop is in
> [docs/PARALLEL-AGENTS.md](docs/PARALLEL-AGENTS.md).

## License

ZUU's own source is available under the [MIT License](LICENSE). Each submodule
under `z/` is an independent upstream repository with its own license and
contribution rules.
