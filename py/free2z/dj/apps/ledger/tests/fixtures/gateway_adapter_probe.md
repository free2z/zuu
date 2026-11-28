# Private Rust/PostgreSQL acceptance consumer

This Free2Z ledger fixture exercises the public `f2z-ai::ledger` adapter
against the real private test schema using a temporary LOGIN that inherits only
the gateway function permissions. The Python harness checks that the role is not
a superuser and cannot read the account table. No production credentials apply.

Build `gateway_adapter_probe.rs` as an external Cargo binary with a path
dependency on the reviewed public `rs/crates/f2z-ai` checkout. Its other
dependencies are `async-trait = "0.1"`, `serde_json = "1"`, `secrecy = "0.10"`,
`uuid = { version = "1", features = ["serde"] }`, and
`tokio = { version = "1", features = ["rt-multi-thread", "macros"] }`.
Use the public repository's pinned Rust compiler. The probe is not a server.
Point `F2Z_GATEWAY_RUST_PROBE` at the compiled binary and run
`pytest dj/apps/ledger/tests/test_gateway_rust_adapter.py` from `py/free2z`, using
an isolated PostgreSQL test database with the current private migrations. Normal CI skips
this opt-in cross-repository test and retains its unconditional SQL tests.

The case runs under both economic policy versions. It covers a real claim,
attempt 1, a release whose committed reply is discarded and retried, and attempt 2
with its own hold key, model, rate card and amount. Repeating hold 2 replays the
same identifier. Both durable attempt snapshots are inspected before and after
completion; the earlier release remains the envelope's latest usage while the
call is still streaming. It also covers a committed-hold revocation barrier,
completion under the captured admission identity, recovery of the hold identifier
from retained attempt metadata, a committed settlement whose response is dropped
before retry, foreign-account isolation, and both terminal winner directions.
A separate call's hold expires before completion projects a released call; a later
settlement records provider expense without charging the customer. Final persisted
balance, held funds, expense splits and terminal usage counts verify one charge.
The Python harness additionally requires exactly one released attempt, one
settled winner, two distinct retained snapshots and no open holds, with the
original requested model and the actual answering model recorded separately.
The barrier uses a bounded pipe handshake, not a sleep. The subprocess exits
before its temporary role is removed, including failure paths.

The probe deliberately calls low-level operations directly; it does not claim
to validate HTTP orchestration, TLS deployment, provider traffic, or a live
paid call. Those require the public gateway's separate route tests and rollout.
