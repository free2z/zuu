# e2e2z — the messaging surface

`cash.free2z.e2e2z`. One of the three apps ZUULI is being split into (#904),
scaffolded by #906 and filled in by phase 3 — the messaging surface moved here
out of ZUULI, which no longer has a `/messages` route or a Messages nav entry.

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
registers none of the trio and no capability addresses one.

The one command this crate *does* register is
`e2e2z_device_credential_keys` (`src-tauri/src/device.rs`): the **public**
halves of this device's key set, which are exactly what an
`issue-device-credential` request carries. It calls
`tauri_plugin_f2zmsg::engine::Engine::prepare_device`, which samples from the OS
CSPRNG, keeps the private halves in that process and hands back nothing else. It
is an app-crate command for §2.2's reason — no `plugin:` prefix, no capability
entry — and it is deliberately not part of the contract's §3 plugin surface,
because it grants nothing. Generating that keypair in the renderer instead would
mean a second cryptographic implementation and a private key in a
garbage-collected JavaScript heap; `src/lib/enrollment/deviceKeys.ts` says so at
the top and holds no `crypto.subtle`.

**And the frontend fails closed rather than pretending.** The ported
`src/lib/messaging/bridge.ts` keeps all three in its declared command
population — `WIRE_COMMANDS`, `RESULTS` and `BridgeMethod` are one population
that `parity.test.ts` and `wallet/zuuli/scripts/messaging-contract.node-test.mjs`
hold to §3 of the contract, so deleting them would silently shrink the contract
instead of recording what this app cannot do. Every call refuses with a typed
`EnrollmentUnavailableError` carrying
`reason: "enrollment-requires-wallet-app"`, without ever reaching Tauri IPC, and
the screen renders that as a standing "enrollment happens in the wallet app"
state: no claim control, no conversation list, no engine start/stop, nothing
that reads as enrolled. Nothing synthesizes an `EnrollmentStatus` — every field
of one is a claim about the key transparency directory, and a fabricated
`enrolled: true` would show a handle nobody published.

`#905`'s `issue-device-credential` intent is the way out, and it **does not ship
before #461**: a custom-scheme deep link is not an authenticated channel, so no
transport is invented here.

**The caller half of that intent is built, and it is what `enroll` now runs.**
`src/lib/enrollment/` reads this device's public keys, builds the request
through `@free2z/wallet-shared` — the single intent-bridge implementation, the
one `wallet/zuuli/scripts/project-boundary.mjs` forbids a second of — and hands
it to `transport.ts`, which is the whole seam and which **rejects**. It rejects
before a device key set is sampled, and it rejects again inside `dispatch`
without consulting its own availability flag, so no single edit turns the
refusal into a success. Response handling is implemented and tested against
hand-assembled hostile bytes even though nothing can deliver one: correlation,
family, window, status, framing and the credential's own encoding each get a
case. What that validation proves is that the responder saw the request; it does
**not** prove the responder was ZUULI, because
`docs/intent-bridge/CALLER-AUTHENTICATION.md` §5 records that there is no
signature over responses. That is #461's job, not this code's.

Proved by `src/lib/messaging/enrollment-gap.test.ts` (the bridge refuses, never
invokes, never resolves), `src/features/messages/index.enrollment-gap.test.tsx`
(the screen renders the gap and offers nothing enrolled), and
`tests/enrollment-gap.pw.ts`, which runs a real browser against the **default**
build with a Tauri IPC host that registers the plugin and not the trio — the
exact shape `src-tauri/src/lib.rs` ships — and asserts no `f2zmsg_*` command was
ever invoked. The intent path adds `src/lib/enrollment/*.test.ts`,
`src/lib/messaging/enroll-intent.test.ts` — which drives a *fulfilled* wallet
response through the shipping code and asserts `enroll` **still** refuses — and
`scripts/seed-authority-boundary.node-test.mjs`, which judges all three routes
seed authority could arrive by. `docs/intent-bridge/CONFORMANCE.md` records the
mutation matrix, including the two mutations that survive and why.

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

## What moved, and what came with it

- `src/features/messages/` — the screen, first contact, the transcript, and the
  browser-guarantee notice (§11.1).
- `src/lib/messaging/` — `bridge.ts`, `events.ts`, `types.ts`, `mock.ts`, the
  handle-eligibility fixtures and their tests.
- The five shared UI primitives the surface actually imports — `button`,
  `callout`, `input`, `skeleton`, `PageHeader` — plus `lib/utils.ts`, the
  Tailwind token layer and the bundled Plex faces. Copied, not imported:
  `wallet/zuuli/scripts/project-boundary.mjs` forbids one wallet project from
  reaching into another's tree, and a shared build config would be exactly that.

It brought **no** store, **no** wallet library and **no** session: the surface
never depended on them, which is what made the extraction a move.

Imports here are relative rather than `@/`-aliased, because this app has no
`vite.config.ts` (see below) and therefore no alias to resolve.

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
npx vitest run
node --test scripts/ui-copy-truncation.node-test.mjs
npx playwright test
npm run build
cargo check --locked --all-targets --manifest-path src-tauri/Cargo.toml
```

CI: `.github/workflows/wallet-surfaces.yml` (advisory build coverage) plus the
required `gate` in `.github/workflows/zuuli.yml`, whose change detector selects
`wallet/e2e2z/*`.

`npx playwright test` starts two dev servers on purpose, because this app has
two truthful states: `VITE_MOCK=1` for the fixture data layer, which is the only
way to reach a transcript without a running relay, and the default build, where
enrollment refuses and the screen has to say so rather than hang.

The app icon is a placeholder.
