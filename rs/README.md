# `rs/` — the free2z Rust workspace

One `[workspace]`, one `rs/Cargo.lock`, alongside the existing `ts/`, `py/`,
`z/` and `wallet/`.

This tree holds the E2EE messaging system of
[#305](https://github.com/free2z/zuu/issues/305): the relay, the directory, and
the crates they share with the clients. It is specified by
[`docs/e2ee/WIRE.md`](../docs/e2ee/WIRE.md) and the ADRs beside it.

## Why it is called `rs/` and not `relay/`

[ADR 0001](../docs/e2ee/decisions/0001-platform-priority.md) requires **one Rust
crypto core**, compiled natively for ZUULI *and* to WASM for the web, so that
there is never a second implementation of the protocol to diverge from the
first. That means this tree will hold **client** crates beside the servers, and
a namespace named for one role would be wrong within a quarter.

`rs/` is the role-neutral name. `f2z-codec` is the first crate in it and is
already both: the relay parses frames with it, and so does the browser.

## #341 is decided, and a root here is inside the decision

[#341](https://github.com/free2z/zuu/issues/341) asked whether the *repository*
should have a single Rust workspace. It is **decided**, and the answer is in
[`docs/architecture/CARGO-WORKSPACE.md`](../docs/architecture/CARGO-WORKSPACE.md)
— accepted 2026-08-23 — not in the issue thread. Read the ADR, not this section,
when the question comes up again.

The ADR keeps the wallet's three Rust package roots independent and rules out a
repository-root workspace outright, because Cargo enrols path dependencies below
a workspace root and `z/` holds upstream Cargo projects that are not ours to
govern as members. Its own words:

> If a wallet-wide workspace is ever adopted, its candidate root is `wallet/`,
> with explicit members and exclusions.

**So the consolidation the ADR leaves open is `wallet/`-scoped, and `rs/` is not
under `wallet/`.** A fourth package root here does not make that consolidation
harder; the two trees were never candidates to merge under it. The ADR's reasons
for the boundary are wallet-specific in exactly the same way:

- The release system runs the Tauri CLI from the app directories and reads
  `src-tauri/Cargo.lock` and `src-tauri/target`; Tauri's generated mobile
  projects expect the app crate where it is.
- The wallet's three lockfiles resolve the Zcash and Tauri graphs **differently
  on purpose** — Tauri 2.11.5 / `aws-lc-rs` 1.17.3 on one side, 2.10.2 / 1.15.4
  on the other — so unifying them starts with a coordinated dependency update,
  not a relocation.
- `libsqlite3-sys` declares `links = "sqlite3"`, so Cargo hard-errors on a graph
  containing two versions — which makes `rusqlite 0.37` a repo-wide singleton and
  makes any workspace merge a resolution question, not a layout question.

None of those engages a tree with no Tauri, no SQLite and no path dependencies
into `z/`. What `rs/` does owe the ADR is its "Adding Rust crates" step 5 — run
the repository's manifest-discovering format, clippy and cargo-deny checks, and
add explicit locked build/test coverage for the context the crate promises. That
is what `.github/workflows/rs.yml` is.

The ADR does not freeze the question; it lists **revisit triggers** — a shared
release cadence, two or more further shared crates, a divergence that escapes
the per-app locked builds, measured CI data, or release tooling made independent
of the app-local lock and target paths — and it accepts consolidation only after
a migration proves the whole list of builds and tests. None of those triggers is
about `rs/`. If one ever fires and this tree is in scope, folding it in is one
reviewed dependency-resolution diff across both lockfiles — not the deletion of
a `[workspace]` table.

## The toolchain pin is a restatement

`rs/rust-toolchain.toml` repeats `channel = "1.97.1"` because cargo selects a
toolchain from the directory it runs in, and the shared scripts run cargo from
here. It is **not a second source of truth.** The one place the version is
decided is `wallet/rust-toolchain.toml`, and

```
scripts/check-rust-toolchain.sh
```

fails the pull request the moment the two disagree. `.github/workflows/rs.yml`
runs exactly that. `rs/rust-toolchain.toml` and every `rs/crates/*/Cargo.toml`
are registered in the script's own `TOOLCHAIN_RESTATEMENTS` and `MANIFESTS`
arrays — not by `--manifest` flags in this workflow, because the bare invocation
the required ZUULI gate runs passes no flags and would be blind to anything
registered only here. Bumping the compiler means editing
`wallet/rust-toolchain.toml` and running `scripts/check-rust-toolchain.sh`,
which names every restatement that still needs updating — this one included.

## Licence boundary: permissive crates, AGPL binaries

Per the owner decision recorded on
[#305](https://github.com/free2z/zuu/issues/305):

- **Shared crates are permissive** (MIT, matching the repository's `LICENSE`), so
  that the ZUULI client, the WASM web client, and third-party relays and clients
  can link them.
- **Server binaries will be AGPL-3.0.**

Every `Cargo.toml` in this tree sets `license` explicitly, from the first commit,
so the boundary is never implicit. `rs/deny.toml` makes it mechanical: it sets
`private = { ignore = false }`, which is what stops cargo-deny from skipping our
own `publish = false` crates, and it allows no copyleft licence at all. An
AGPL-3.0 server binary will therefore fail the gate until it is added to
`[licenses] exceptions` **by name** — a reviewed, one-line act. Putting
`"AGPL-3.0"` in `allow` instead would permit it for every crate in the tree,
including the ones the client links, which is the drift the split exists to
prevent.

## Crates

| Crate | What it is |
|---|---|
| [`crates/f2z-codec`](./crates/f2z-codec) | The canonical encoding layer of `WIRE.md`: `tls_codec` wrappers for every wire structure, the domain-separated signing transcript (§5), the redacting newtypes, and the padding-bucket validator (§9). `no_std` + `alloc`, `#![forbid(unsafe_code)]`, no I/O, no async runtime, and it builds for `wasm32-unknown-unknown`. |
| [`crates/f2z-relay-proto`](./crates/f2z-relay-proto) | The protocol layer above it: signed-command construction and verification in §5.1's exact order, the timestamp window and fail-closed seen-set (§5.5), the queue lifecycle and ACK arithmetic (§7, §8), the capability document (§11), the `HELLO` proof of possession (§5.2), and §4.3's typed in-flight window. Same constraints — `no_std` + `alloc`, no I/O, no clock, no randomness, and it builds for `wasm32-unknown-unknown`. |
| [`crates/f2z-relay-store`](./crates/f2z-relay-store) | The relay's queue storage: a `RelayStore` trait that speaks addresses and bytes and never a wire frame, plus a durable `SqliteStore` (WAL, `synchronous = FULL`, `secure_delete = ON`, group commit) and a volatile `MemoryStore`. **Native only** — it links SQLite and is not on the wasm line. `std`, `#![forbid(unsafe_code)]`, no async runtime. |
| [`crates/f2z-relay-testkit`](./crates/f2z-relay-testkit) | **FakeRelay**: a spec-conforming relay a client can develop against, over an in-process pipe *and* a real `ws://127.0.0.1:0` listener running the same implementation, plus fault injection and the conformance vector suite `f2z-relay` is run against unchanged. Also ships the `f2z-fakerelay` binary and `rs/deploy/docker-compose.dev.yml`. **Native only** — it opens sockets, spawns tasks and reads a clock, and is deliberately absent from the `wasm32` job. |
| [`crates/f2z-relay`](./crates/f2z-relay) | **The relay daemon** — the server that runs in production. `wss://` listener, §4 framing, §5 signed-command verification with the TLS-exporter binding, the full §6 command set over `RelayStore`, a group-commit writer, TTL expiry, §13 anti-abuse, the signed capability document, a loopback-only `/healthz` + `/metrics` admin listener, and an opt-in health-only listener that may bind off loopback so a Kubernetes probe and a load-balancer health check can reach `/healthz` at all. **AGPL-3.0**, native only, never on the wasm line. |
| [`crates/f2z-authority`](./crates/f2z-authority) | An **experimental candidate** for the directory's non-cryptographic trust-root layer: the proposed `HandleAssertion`, a partial assertion-layer check, `AuthoritySet`, and `f2z-assert`. `KT.md` does not yet ratify these structures or first-entry/no-authority semantics (#594), and its result is not §4.4 directory authorization. Same portability constraints. |
| [`crates/f2z-kt-core`](./crates/f2z-kt-core) | Key transparency, [`docs/e2ee/KT.md`](../docs/e2ee/KT.md) v1: `DirectoryEntry` and the §4.4 authorization rules, `SignedTreeHead` and its monotonicity checks, log-key rotation, `WitnessCosignature` and the threshold rule, and the client verifier over `akd_core`. Built on `f2z-codec`, `#![forbid(unsafe_code)]`, no I/O, no clock, no keys. |
| [`crates/f2z-kt-client`](./crates/f2z-kt-client) | The **client** half of [`docs/e2ee/KT.md`](../docs/e2ee/KT.md): §9.2's endpoints over HTTP, the pinned `LogView` that makes §6.3's monotonicity rules mean anything, §8.3's threshold applied and **failed closed** on, §8.2's self-audit, and the pin store and alarm log §9 rules 4 and 9 require. It decides no protocol outcome itself — every verdict is `f2z-kt-core`'s, per §11.4. There is deliberately **no `audit` method**: §8.5 says a client cannot substitute its own consistency check for a witness's. `Transport` is synchronous, so `wasm32-unknown-unknown` supplies its own over `fetch`; the crate's own `ureq` transport is behind the default-on `http` feature the browser build turns off. |
| [`crates/f2z-msg-identity`](./crates/f2z-msg-identity) | The messaging key hierarchy, [`docs/e2ee/ARCHITECTURE.md`](../docs/e2ee/ARCHITECTURE.md) §4.2: the ZIP-32-idiom seed-derived tree (`MSK`, hardened-only `CKDh`, `account_node`), the four HKDF account leaves, the per-device keys the OS CSPRNG generates, and `DeviceCredential` issuance. **The one crate here that holds a user's secret keys.** `no_std` + `alloc`, `#![forbid(unsafe_code)]`, no I/O, no clock, and its randomness is a `rand_core::CryptoRng` parameter so it reaches `wasm32-unknown-unknown`. |
| [`crates/f2z-msg-dag`](./crates/f2z-msg-dag) | The hash-linked application framing, [`docs/e2ee/ARCHITECTURE.md`](../docs/e2ee/ARCHITECTURE.md) §7: the `AppMessage`, its `msg_id` commitment, causal ordering with `(epoch, sender_leaf_index, msg_id)` as the tie-break, gap detection from a dangling `parents` hash, and the bounded-window plaintext outbox §7's repair needs. `sent_at` is a newtype with **no `Ord`**, so ordering by the sender's clock does not compile. `no_std` + `alloc`, `#![forbid(unsafe_code)]`, no I/O and no clock — every time-dependent decision is a `now_ms` parameter — so it reaches `wasm32-unknown-unknown`. |
| [`crates/f2z-crypto-kat`](./crates/f2z-crypto-kat) | Host-run known-answer tests for the locked libcrux graph: NIST ACVP ML-KEM-768, RFC 7748 X25519, RFC 8032 Ed25519, and all three X-Wing draft-06 Appendix C outputs, with committed provenance and a corrupted-vector CI negative control. Test evidence only; no production API. |

`f2z-msg-identity` is the **only** crate in this tree that holds secrets. Every
other crate here verifies, encodes or stores; this one derives an identity from a
mnemonic and signs with it. Two consequences worth knowing before opening it:

- **Its constants are not editable.** The BLAKE2b personalizations and the four
  HKDF labels in `src/labels.rs` are inputs to a one-way derivation from a user's
  seed. Changing one byte moves every existing user's `IdentitySigningKey`,
  invalidates every directory entry, breaks every pinned safety number, and
  leaves no migration path — `KT.md` §4.4 requires the *outgoing* identity key to
  sign a rotation. `tests/derivation_vectors.rs` pins the whole hierarchy from
  BIP-39's published all-`abandon` seed, computed independently in Python, so an
  accidental change fails there first.
- **It issues what `f2z-kt-core` validates.** `DeviceCredentialTBS` is
  `f2z-kt-core`'s type, not a second copy, and `tests/kt_core_agreement.rs` puts
  a credential issued here through `validate_submission` — the same function the
  log runs. The two crates cannot drift apart about those bytes without a red
  test.

`f2z-kt-core` is the **one** crate the log server, the witness and the client all
link (`KT.md` §11.4). That is not tidiness: a witness that verified with a
different implementation than the log builds with would produce cosignatures that
mean nothing, and §7.4's only structural defence against a lazy witness is that
there are not two implementations to disagree.

Its `verifier` feature reaches `wasm32-unknown-unknown`; its `auditor` feature
does not, and must never be enabled for the browser — `akd::auditor::audit_verify`
hardcodes `AzksParallelismConfig::default()` and reaches `tokio::task::spawn`, so
it compiles for that target and then traps at runtime (`KT.md` §11.3). The wasm CI
job builds `--no-default-features --features verifier` for exactly that reason.

`f2z-kt-core::api` carries `KT.md` §9.2's request and response envelopes —
`SubmissionEnvelope`, `TreeHeadBundle`, the lookup/history/audit shapes — for the
same reason. A witness that decoded a tree-head bundle differently from the log
that encoded it would cosign a root it did not actually read.

**`rs/deny.toml` carries the `akd >= 0.13.0` floor and it is load-bearing.**
[facebook/akd#495](https://github.com/facebook/akd/pull/495) — an auditor
append-only bypass letting a malicious log rewrite a label's value while still
producing a *valid* append-only proof — has no RustSec or OSV advisory and never
will, so `cargo audit` passes on a vulnerable pin forever
([ADR 0013](../docs/e2ee/decisions/0013-key-transparency-log.md)). A reviewer who
removes those `[[bans.deny]]` entries has removed the floor.


## The key-transparency binaries

`f2z-relay` is a server binary too and is described in the table above; these
are the two that serve `KT.md` rather than `WIRE.md`.

| Binary | What it is |
|---|---|
| [`crates/f2z-kt`](./crates/f2z-kt) | The **key-transparency log server** ([`KT.md`](../docs/e2ee/KT.md) §5, §6, §9): durable append-only journals, the submission choke point, the `akd` tree and the epoch scheduler, `LogSigner` behind a trait with a file-backed default, and the proof-serving API. |
| [`crates/f2z-witness`](./crates/f2z-witness) | The **cosigning daemon** (`KT.md` §7): poll, verify the tree-head signature, refuse and record evidence on rollback or fork, **verify the append-only proof**, cosign, and update one state file atomically. No inbound port, no TLS, no domain, no database. |

**Both are AGPL-3.0-only**, on the same boundary `f2z-relay` crosses and for the
same owner decision — [#305](https://github.com/free2z/zuu/issues/305).
`THREAT-MODEL.md` §4.5 concedes that server-side deletion is "auditable, not
verifiable", and a copyleft obligation for network use is the only lever we have
over an operator we do not run. `rs/deny.toml` names each binary in
`[licenses] exceptions` — the *library* crates above stay MIT so clients and
third-party implementations can link them, and a library crate appearing in that
list would be a review failure.

Neither is on the wasm line and neither ever should be: `f2z-kt` pulls tokio and
axum, and `f2z-witness` links `f2z-kt-core`'s `auditor` feature, which reaches
`akd::auditor::audit_verify` — it compiles for `wasm32-unknown-unknown` and then
traps at runtime (`KT.md` §11.3).

**The log and the witness link the same `audit_verify`, and that is structural
rather than tidy.** `KT.md` §7.4: a witness that cosigns without verifying the
append-only proof is worthless, and there is no way for a client to tell a lazy
witness from a diligent one by inspecting cosignatures. What the design does
about it is make "cosign without verifying" take *deleting a call* rather than
forgetting one — `f2z_kt_core::auditor::WitnessState::advance` will not advance
without the token `verify_append_only` returns, and neither has a public
constructor.


**The relay and the clients link these library crates.** That is the licence
boundary in practice: every crate above is MIT because a third-party relay, ZUULI
and the WASM web client all compile the same rules, and a rule that two implementations
disagree about is how ciphertext gets deleted before it is read.

**The clients link `f2z-codec`, `f2z-relay-proto`, `f2z-kt-core`'s verifier,
`f2z-kt-client`, `f2z-msg-identity` and `f2z-msg-dag`; the relay links the first two
plus `f2z-relay-store`.** That is the licence boundary in practice: the shared
crates are MIT because a third-party relay, ZUULI and the WASM web client all
compile the same rules, and a rule that two implementations disagree about is how
ciphertext gets deleted before it is read. **`f2z-relay`, `f2z-kt` and
`f2z-witness` are on the other side of that boundary** — AGPL server binaries,
each named individually in `rs/deny.toml`'s `exceptions` so crossing it cannot
happen by accident, and a library crate appearing in that list would be a review
failure.

The current dependency graph is narrower than that intended architecture:
`f2z-relay-proto` depends on `f2z-codec`, while `f2z-authority` is still a
standalone experimental leaf. Wiring the authority candidate into a relay or
client is future integration work, not a property this README claims today.
`f2z-kt` and `f2z-witness` **do** depend on it, and on `f2z-kt-core` — they are
the server binaries below, and they are the reason that layer exists. Every
library crate above remains MIT so downstream relays and clients can share the
rules.

`f2z-codec` is separate from everything that sits on top of it for three
reasons, and each is enforced by a test rather than by intent:

1. **Re-encode equality** (`WIRE.md` §3.3) is implemented once. Every received
   frame is decoded, re-encoded and byte-compared, and the *re-encoded* bytes are
   what a signature covers. Implementing it in one crate is what removes the
   parse-versus-verify gap from the whole system instead of from one component.
2. **Redacting `Debug`.** Addresses, payloads and keys never render their bytes.
   `--log-level trace` must not turn a relay into a ciphertext archive.
3. **It reaches WASM.** No I/O, no tokio, no `std`. A CI job builds it for
   `wasm32-unknown-unknown` on every change, because "we kept it portable" is a
   claim that stops being true the first week nobody checks.

## The server images

The three AGPL binaries above ship as three container images, built from one
`rs/Dockerfile` and published by `.github/workflows/f2z-images.yml`:

| Image | Entrypoint | Built with |
|---|---|---|
| `ghcr.io/free2z/f2z-relay` | `/f2z-relay` | `--build-arg BIN=f2z-relay` |
| `ghcr.io/free2z/f2z-kt` | `/f2z-kt` | `--build-arg BIN=f2z-kt` |
| `ghcr.io/free2z/f2z-witness` | `/f2z-witness` | `--build-arg BIN=f2z-witness` |

```bash
docker build -f rs/Dockerfile rs \
  --build-arg BIN=f2z-witness \
  --build-arg RUST_CHANNEL="$(scripts/check-rust-toolchain.sh --print-channel)" \
  -t f2z-witness:local
```

One Dockerfile rather than three, because what must not drift between them is
exactly the shared part: the pinned compiler, the pinned base images, the uid,
and the absence of a shell. The runtime is
`gcr.io/distroless/cc-debian12:nonroot`, digest-pinned, running as uid 65532 —
`cc` and not `static` because `rusqlite` bundles SQLite and all three link libc.
The builder is `rust:1-slim-bookworm`, also digest-pinned, and **bookworm is
load-bearing**: a builder on a newer Debian links a newer glibc and produces a
binary that starts on the build host and dies on the cluster.

The compiler version appears nowhere in the Dockerfile or the workflow. It
arrives as `RUST_CHANNEL` from `scripts/check-rust-toolchain.sh --print-channel`,
and the Dockerfile refuses to compile anything if what arrives disagrees with
`rs/rust-toolchain.toml` in the build context.

**Publishing is phase one of two, and the split is the point.** The workflow
pushes `:main-<sha>` and a build-scoped tag — never `:latest` — attaches an OCI
SBOM and `provenance: mode=max`, attests the registry digest with
`actions/attest --push-to-registry`, re-verifies by digest, and then prints that
digest into the job summary. Nothing consumes it. Moving a deployment onto a new
image is a separate, human-reviewed pull request against the deployment
manifests that pins the exact digest. A publish that could move a running
deployment on its own would make "merged to `main`" and "shipped to production"
the same event.

**Reproducible builds are not claimed.** The attestation proves *provenance* —
that this workflow, in this repository, built that digest from that commit. It
does not prove that rebuilding the commit yields the same digest, and nothing
here tries to: `cargo build` embeds paths and timestamps, and the base images are
pinned rather than rebuilt. Provenance is the property the deployment relies on.

`platforms: linux/amd64` only. That is what the target cluster runs. Multi-arch
is for self-hosters and can be added later without invalidating anything already
pinned: another platform publishes new digests beside the existing ones.

**`f2z-witness healthz` is a contract with the image, not only with the binary.**
The manifests probe it with `exec` because distroless has no shell, no `wget` and
no `curl`, and `KT.md` §9.3 promises the witness has no inbound listener to dial:

```yaml
livenessProbe:
  exec:
    command: ["/f2z-witness", "healthz", "--state", "/var/lib/f2z-witness/state.bin"]
```

`--state` is **required** — a probe written as `["/f2z-witness", "healthz"]`
fails permanently rather than reporting an unhealthy witness. And a witness that
has never completed a poll reports `UNPINNED` and exits 1 by design, so the probe
must be given a `startupProbe` or an `initialDelaySeconds` wide enough to cover
the first successful poll. `scripts/check-f2z-images.mjs --probe` asserts both
behaviours against a real container after every build.

Add `--liveness yes` on the **startup and liveness** probes and leave readiness
on the default verdict. `STALE` and `UNPINNED` are statements about the upstream
log, not about this process; wiring them to a `livenessProbe` restarts the
witness on a schedule for as long as the log is unreachable, during exactly the
incident in which its state file is the evidence somebody needs. `HALTED` still
fails either way. See `f2z-witness/src/health.rs`.

**`f2z-relay`'s probe is an `httpGet`, and needs `--health-listen`.** Its
`/healthz` is on a listener that refuses to bind off loopback, and a kubelet and
a GCE health check both dial the pod IP, so a deployed relay must be given a
second, health-only listener:

```yaml
args: ["--listen", "0.0.0.0:8080", "--insecure-listen", "--health-listen", "0.0.0.0:8081"]
readinessProbe:
  httpGet: { path: /healthz, port: 8081 }
```

`scripts/check-f2z-images.mjs --probe-relay` starts the image with exactly that
configuration and asserts that `/healthz` answers 200 on the health port, that
`/metrics` is a 404 there, and that `/healthz` is *not* answerable on the
protocol port.

That script is the policy for all of the above, it runs `--self-test` first, and
it is invoked unconditionally from `rs.yml` — not from the image workflow —
because the image workflow's own `paths:` filter is one of the things it checks,
and a drifted filter is a workflow that has silently stopped publishing.

**A shallow probe is only safe over a supervised process** ([#671]). `/healthz`
answers from process state and nothing else, deliberately — a probe that queried
the store would fail during exactly the backpressure it exists to survive. That
makes it a true statement about a relay only if the process cannot outlive the
tasks that do its work, so `f2z-relay` supervises the protocol listener, the
admin and health listeners, the expiry tick and — since [#685] — the
**group-commit writer**: if any of them ends before a shutdown was asked for,
the relay closes its listeners, prints
`the <task> stopped while the relay was running` to stderr and **exits 1**. A
crash-looping pod is the correct outcome. At `replicas: 1` with
`strategy: Recreate` that is a brief, visible outage, and the alternative — a
`Ready` endpoint in the load balancer's rotation over a relay that serves nobody
— is data loss under delete-on-ack rather than downtime: a sender that was told
`accepted` and a relay that then loses the message have between them destroyed
it.

The commit writer is the one that is not a task. It is an **OS thread**, because
an fsync is a blocking syscall of unbounded duration and parking a Tokio worker
on a 1 GB VPS is worse; `Supervised` holds `JoinHandle`s, so the thread could not
be in it, and a dead writer used to leave every listener open and every probe
green over a relay answering `ERR_UNAVAILABLE` to every `APPEND`. It is covered
by supervising a task that waits on the thread's liveness signal — a task
registered in the same list as the other four, so the watchdog is not itself
the unsupervised thing.

**`f2z-kt` has the same rule and a quieter failure** ([#684]). Its epoch
scheduler is what publishes `KT.md` §5.1's epochs, heartbeats included, and a
log that has stopped publishing errors on *nothing*: clients keep verifying
against the last signed tree head, lookups keep succeeding, and heartbeats
cannot be missed because there is nothing left to emit them. So the scheduler
and the HTTP listener are supervised the same way, and `f2z-kt serve` exits
non-zero when either ends.

[#671]: https://github.com/free2z/zuu/issues/671
[#684]: https://github.com/free2z/zuu/issues/684
[#685]: https://github.com/free2z/zuu/issues/685

## Working in this tree

```bash
cd rs
cargo test
# The client-linked crates only. `f2z-kt` and `f2z-witness` are native server
# binaries and are deliberately absent from this line.
cargo build --target wasm32-unknown-unknown --lib \
  -p f2z-codec -p f2z-relay-proto -p f2z-authority -p f2z-msg-identity -p f2z-msg-dag
cargo build --target wasm32-unknown-unknown --lib -p f2z-kt-core \
            --no-default-features --features verifier
# The directory client on top of it. `http` is off for the browser: it is the
# blocking ureq/rustls transport, and a browser brings its own over `fetch`.
cargo build --target wasm32-unknown-unknown --lib -p f2z-kt-client \
            --no-default-features --features verifier

# f2z-relay-store's crash-safety suite is behind a default-off feature, because
# the feature compiles an abort() into the commit path. It kills real child
# processes; `cargo test` alone does not run it.
cargo test -p f2z-relay-store --features crash-injection --test crash_safety

# A relay endpoint for a client developer, in one command.
cargo run -p f2z-relay-testkit --bin f2z-fakerelay

# The real thing, on loopback, with an ephemeral store.
cargo run -p f2z-relay -- --store memory
```

**Not every crate here reaches the browser, and the wasm line is the record of
which do.** `f2z-relay-store` links SQLite through `rusqlite`'s bundled C
amalgamation; `f2z-relay-testkit` opens sockets, spawns tasks and reads a clock,
and a test harness that could reach the browser build could end up in the
shipped bundle; `f2z-relay` is an AGPL server binary that does all three. All
are deliberately absent from `rs.yml`'s `rs_wasm` job. Adding a crate to that
line is a claim that a client links it.

The gates are the repository's shared scripts, pointed here with `--root`:

```bash
scripts/check-rust-toolchain.sh
scripts/check-rust-fmt.sh    --root rs
scripts/check-rust-clippy.sh --root rs
scripts/check-rust-deny.sh   --root rs --config rs/deny.toml
```

**All four now discover crates, by two different mechanisms.**
`check-rust-fmt.sh`, `check-rust-clippy.sh` and `check-rust-deny.sh` find every
`Cargo.toml` under `--root`, so a new crate under `rs/` is formatted, linted and
supply-chain-gated from its first commit.

`check-rust-toolchain.sh` still verifies a *registry* — it has to, because an
MSRV is a value to compare, not a tree to walk — but registration is no longer a
discipline. Its **census** enumerates every `Cargo.toml` and `rust-toolchain.toml`
git tracks outside `z/` and fails on any that declares `[package]` (or restates
the toolchain) and is registered nowhere. Proved by adding a throwaway
`rs/crates/scratch/Cargo.toml` with no `rust-version` and no `license`:

| Script | Sees it? | Verdict |
|---|---|---|
| `check-rust-fmt.sh --root rs` | yes | RED — `4 crate(s) are not formatted: … rs/crates/scratch` |
| `check-rust-clippy.sh --root rs` | yes | RED — `2 crate(s) failed the clippy gate: … rs/crates/scratch` |
| `check-rust-deny.sh --root rs --config rs/deny.toml` | yes | RED — `error[unlicensed]: scratch = 0.0.0 is unlicensed` |
| `check-rust-toolchain.sh` | yes | RED — `rs/crates/scratch/Cargo.toml declares [package] but is registered nowhere` |

Before [#553](https://github.com/free2z/zuu/issues/553) that last row was
**GREEN and blind**, and every new crate in this tree needed a `--manifest` flag
added to `rs.yml` by hand. It now needs a line in `MANIFESTS` instead — and the
check names the file and says so, rather than a reviewer having to notice.
`.github/workflows/rs.yml` runs all four, plus `cargo test` and the WASM build,
behind its own `gate`.

A virtual workspace root like `rs/Cargo.toml` is excused because it declares no
`[package]` and so has no `rust-version` to pin — recognised by that structure,
not by a path exclusion list that could later be widened to excuse a real crate.

### Workspace lints

`rs/Cargo.toml` denies the panicking families — `unwrap_used`, `expect_used`,
`panic`, `indexing_slicing`, `arithmetic_side_effects` — for every member. The
reason is specific to what this tree is: the relay is a public, unauthenticated
network listener, and a panic in its parser is a remote denial of service.
Integration tests relax them, with a note saying why.
