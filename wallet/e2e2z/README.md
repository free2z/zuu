# e2e2z — the messaging surface

`cash.free2z.e2e2z`. One of the three apps ZUULI is being split into (#904),
scaffolded by #906. **Boilerplate only: no feature code has moved here yet.**

| App | Role | Privileged plugins |
| --- | --- | --- |
| `cash.free2z.zuuli` | wallet authority | `zcash` |
| `cash.free2z.free2z` | content — articles, live, AI, creator, search | none |
| **`cash.free2z.e2e2z`** | **messaging** | **`f2zmsg`** |

## What this surface holds, and what it must never hold

It holds device keys and a device credential. It never holds the Zcash seed.

That is not a compromise, it is the existing design:
`docs/e2ee/ARCHITECTURE.md` §4.2 already separates **account keys**
(seed-derived, restorable) from **device keys** (OS CSPRNG, never seed-derived,
never exported), bound by a `DeviceCredential` that
`rs/crates/f2z-msg-identity/src/credential.rs` already implements. **Ongoing
messaging therefore never needs the seed — only enrollment does.**

So `src-tauri/Cargo.toml` links `tauri-plugin-f2zmsg` and never
`tauri-plugin-zcash`, and the capability files carry no `zcash:*` entry.

### The enrollment trio is deliberately absent

ZUULI registers three app-crate commands — `f2zmsg_enrollment_status`,
`f2zmsg_enroll`, `f2zmsg_unenroll` — which borrow the wallet seed from
`tauri-plugin-zcash`'s managed state *in-process* so the mnemonic never crosses
IPC (`docs/e2ee/CLIENT-CONTRACT.md` §2.2). They are plugin-less app commands, so
no capability entry grants them and none should try.

Here there is no seed to borrow. Enrollment becomes a bridge call into the
wallet authority, which issues the `DeviceCredential` (#905). Until that
protocol lands there is no honest in-process implementation, so this crate
registers no command at all and no capability addresses one.

## Capabilities: named commands, never the blanket grant

Both `src-tauri/capabilities/default.json` and `mobile.json` list the messaging
commands one by one — the same reviewed set
`wallet/zuuli/scripts/mobile-webview-authority.mjs` holds ZUULI's mobile webview
to, so the two cannot drift into disagreeing about what a messaging client
needs. `f2zmsg:default` is never used.

`f2zmsg:allow-set-relay-trust` is deliberately absent, for the same reason it is
absent from ZUULI's mobile grant: it is how a user opts in to a relay
advertising `transport_security: "none"`, the one grant in the set that is a
security downgrade. `add_relay` already refuses such a relay, so a build that
never grants the opt-in cannot be talked into routing messages in the clear.

Enforced by `wallet/zuuli/scripts/surface-capability-authority.mjs` (policy —
which commands this surface may hold) and
`scripts/check-tauri-plugin-permissions.mjs` (existence — that every identifier
is a command the plugin registers), both inside the required `gate`.

## CSP

As tight as ZUULI's, and it stays that way: this surface renders no remote
content, so `frame-src 'none'` costs nothing here and
`surface-capability-authority.mjs` asserts it. Unlike `wallet/free2z`, there is
no future relaxation planned.

## No `vite.config.ts`, on purpose

Same reason as `wallet/free2z` — see that README's section of the same name, and
the comment on `viteBuildsVerified` in
`wallet/zuuli/scripts/project-boundary.node-test.mjs`.

## Commands

```bash
npm ci
npm run typecheck && npm run typecheck:tests
npm test
npm run build
cargo check --locked --all-targets --manifest-path src-tauri/Cargo.toml
```

CI: `.github/workflows/wallet-surfaces.yml` (advisory build coverage) plus the
required `gate` in `.github/workflows/zuuli.yml`, whose change detector selects
`wallet/e2e2z/*`.

The app icon is a placeholder. Branded assets come with the surface extraction.
