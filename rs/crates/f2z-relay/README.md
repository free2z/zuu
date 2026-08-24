# `f2z-relay` — the relay daemon

The server that runs in production. It implements
[`docs/e2ee/WIRE.md`](../../../docs/e2ee/WIRE.md) v1 §2 through §13 on top of
`f2z-codec` (canonical encoding, framing, re-encode equality),
`f2z-relay-proto` (the signing transcript, anti-replay, queue and ACK rules,
the capability document) and `f2z-relay-store` (durability, quota admission,
the acknowledgement watermark).

**Nothing in those three is reimplemented here.** What this crate decides is
the part they deliberately leave to a server: the socket, the connection
lifecycle, the group-commit schedule, the anti-abuse layering, and which
refusal answers which failure.

## Run one

```sh
# Loopback, ephemeral store, nothing to configure. §2.3 permits a loopback
# bind without TLS, so this needs no override.
cargo run -p f2z-relay -- --store memory

# A real one.
f2z-relay --config /etc/f2z-relay/relay.toml
```

```sh
f2z-relay --help                  # the flags, and where each lands in the file
f2z-relay --version               # crate version and protocol version
f2z-relay --check-config          # validate and exit
f2z-relay --print-config          # the merged configuration, secrets redacted
f2z-relay --print-capabilities    # §11.2's JSON document, for you to publish
```

Configuration is **flags > environment > file > default**. Every file key is
settable as `F2Z_RELAY_<SECTION>_<KEY>`: the file's `[limits] max_inflight` is
`F2Z_RELAY_LIMITS_MAX_INFLIGHT`. An unknown key in the file is an error, not a
warning — a mistyped `max_queue_byes` that silently kept the default would be a
quota you believe you set.

## The four properties this crate is responsible for

1. **`accepted` is never written to the socket before the commit is durable.**
   `f2z-relay-store`'s `Committed<T>` has a crate-private constructor, so the
   only value that can exist is one a completed transaction minted. It is
   unwrapped on the commit thread, after `append_batch` returns, in the same
   statement that sends the reply. There is no path by which a connection task
   holds an `Appended` before the disk does — not because the code is careful,
   but because there is nothing to hold until the commit has happened.

2. **Group commit, because `synchronous = FULL` makes the fsync rate the
   ceiling.** A commodity VPS does 50–200 fsyncs a second; one transaction per
   `APPEND` would cap the relay there, and
   [ADR 0005](../../../docs/e2ee/decisions/0005-federation.md)'s economics do
   not survive it. `tests/group_commit.rs` measures the amortization against
   `SqliteStore::commits` rather than asserting it — **100 concurrent appends
   cost 1 durable transaction.** This does not weaken §11.1's published
   `durability_mode`: §8.4 draws the line at *deferring* the fsync past the
   response, and every append in a batch waits for the same one.

3. **No payload, queue address, key or peer address in any log line, at any
   level.** `log::line` takes a `&'static str` and `(&'static str, u64)` pairs
   and nothing else, so `log_trace!("frame", "payload" = payload)` does not
   compile. `tests/redaction.rs` checks base16 (both cases), base64url **and**
   the decimal byte-list form — the trap `f2z-codec` documents, where
   `#[derive(Debug)]` on a byte vector prints `[222, 173, 190, 239, …]` and a
   hex-only check sails past a complete dump.

4. **Refusing rather than deleting.** §13.2: under no circumstance does the
   relay delete an unacknowledged message to make room. Backpressure refuses
   `CREATE_QUEUE`, then `APPEND`, then new connections, and **never** refuses
   `READ`, `ACK` or `DELETE_QUEUE` — those are the operations that make the
   relay smaller.

## Deployment shapes

| | `listen.tls_cert` / `tls_key` | `--insecure-listen` | Published |
|---|---|---|---|
| **TLS here** | set | no | `transport_security: tls`, `channel_binding_mode: tls-exporter` |
| **Behind a terminating proxy** | unset | yes | `transport_security: none`, `channel_binding_mode: none` |
| **Loopback development** | unset | not needed | as above |

§2.3's rule is a **startup check, not a warning**: a non-loopback bind without
TLS exits unless the override is typed, and the override is published in the
signed capability document. §5.3 is honest about the cost of the middle row —
a relay behind a TLS-terminating proxy has no exporter, so every transcript
carries 32 zero bytes and clients may refuse it.

## The admin listener is loopback-only, and refuses to be anything else

`/healthz` is constant, cheap, carries **no numbers**, and touches no storage: a
health check that queried the disk would fail during exactly the backpressure it
exists to survive. `/metrics` carries **no labels at all** — a `{queue="…"}`
series is a per-conversation activity trace that outlives the ciphertext in the
scraper's storage, and a `{remote="…"}` series is a connection log.

## …and there is a second, narrower listener, because that made it unprobeable

`--health-listen ADDR` (`[health] address`, `F2Z_RELAY_HEALTH_ADDRESS`) serves
**`/healthz` and nothing else** and may bind any address, including `0.0.0.0`.
It is **off by default**.

It exists because the rule above made the relay undeployable, and that was
discovered by running the published image against the Kubernetes manifest
written for it rather than by reading either. A kubelet dials the **pod IP** for
an `httpGet` probe, and a Google Cloud load balancer health-checks the pod IP
directly when the Service is backed by a NEG; a loopback listener is unreachable
to both by construction. The image is distroless — no shell, no `wget`, no
`curl` — so an `exec` probe has nothing to call, and a `healthz` subcommand (the
shape `f2z-kt` and `f2z-witness` use) answers the kubelet and does *nothing* for
the load balancer. The result would have been a pod reading `Ready` behind a 502.

Two things this deliberately is **not**:

* **It is not `/metrics` off-host.** `/metrics` on this listener is a 404. The
  loopback rule protects the metrics endpoint, and that is unchanged; what is
  exposed is a constant three-byte body with no digit in it.
* **It is not `/healthz` on the protocol port.** That port is §2.2's
  deliberately narrow unauthenticated surface, and it is also where §13.1 layer
  1's connection guard sits — a health check answered there would take a
  connection permit and could be *refused* under load, so a traffic spike would
  fail the kubelet's liveness probe and restart the only replica. A separate
  listener cannot do that.

It is also **bounded in time and concurrency**, which the loopback listener
never needed to be: a two-second deadline per request and sixteen in flight, so
a peer that connects and never speaks costs an accept and a close rather than a
task, a buffer and a descriptor held indefinitely. Be precise about what that
buys — it bounds *resources*, not *availability*. A determined flood from inside
the cluster can still occupy the permits and make a probe time out, and no
in-process constant fixes that; a NetworkPolicy on the port is the answer to a
hostile pod.

`scripts/check-f2z-images.mjs --probe-relay IMAGE` asserts the three surface
properties against a running container after every build, and
`tests/health.rs` covers the slow-client case.

## `.well-known` is deliberately not served

§11.2 asks for the capability document over plain HTTPS as JSON, so a human, a
journalist or a researcher can read a relay's policy without a client. This
relay does not serve it, and the reason is §2.2's own:

> a second transport is a second parser and a second fuzz target … The relay is
> an unauthenticated network listener that anyone on the internet may speak to
> before any signature is checked. Its attack surface is its parser.

Serving that URL means an HTTP request parser on the public port. The WebSocket
upgrade's own parse does not help: it runs only for requests already carrying
`Upgrade: websocket` and `Sec-WebSocket-Key`, so a plain `GET` is rejected
before any route callback sees it.

What is kept is the *property* §11.2 exists for. `--print-capabilities` emits
exactly the document served over the protocol — same values, same signature,
same `capabilities_digest` — for you to publish from whatever already serves
your website. A policy change stays publicly diffable at a URL anyone can poll;
what you lose is the relay hosting it. A JSON **encoder** is not a JSON parser:
it writes our own values and consumes nothing from the network, which is why one
is here and the other is not.

## Testing

```sh
cargo test -p f2z-relay
```

`tests/conformance.rs` runs `f2z-relay-testkit`'s 52-vector suite **unchanged**
against a real listener and against the FakeRelay, and asserts that every vector
both can run reaches the same verdict. Thirteen vectors need a fault handle or a
steerable clock; a real relay has neither and must not, so they report
`Skipped` — never a pass. `tests/configured_equivalents.rs` covers eleven of
those thirteen through published configuration or ordinary client behaviour, and
names the two that remain.

## Licence

**AGPL-3.0**, per the owner decision on
[#305](https://github.com/free2z/zuu/issues/305). The crates it links stay
permissive so that the ZUULI client, the WASM web client and third-party
implementations can use them; the boundary starts at this binary, and
`rs/deny.toml` names this crate in `exceptions` so crossing it is impossible by
accident.
