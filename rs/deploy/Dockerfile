# f2z-fakerelay — a TEST DOUBLE for client development. NOT a relay.
#
# WIRE.md §2.1 admits `wss://` only and §7.1 requires unpredictable queue
# addresses from the relay's own CSPRNG. This image provides neither: it serves
# `ws://`, and its addresses come from a seeded BLAKE2b counter so that a
# conformance vector can be replayed byte for byte. Both facts are published in
# the capability document it serves, and a conforming client refuses it without
# an explicit per-relay opt-in (§2.3 obligation 3).
#
# Build it, run it on a developer's machine, point a client at it. Do not put it
# on a network anyone else can reach.

# The compiler is pinned by rs/rust-toolchain.toml, which restates
# wallet/rust-toolchain.toml and is held to it by
# scripts/check-rust-toolchain.sh. `rust:1-slim` ships rustup, which reads that
# file and fetches the pinned channel — so the version lives in one place here
# too, rather than being restated in a FROM line nothing checks.
FROM docker.io/library/rust:1-slim AS build
WORKDIR /src
# The whole rs/ workspace: one [workspace], one Cargo.lock, and `--locked` below
# only means something if the lockfile is the one in the repository.
COPY . /src
RUN cargo build --locked --release -p f2z-relay-testkit --bin f2z-fakerelay

FROM docker.io/library/debian:stable-slim
# Nothing here writes to disk — durability_mode is `memory` (§8.4) — so the
# runtime image needs no volume, no user data directory and no root.
RUN useradd --create-home --uid 10001 fakerelay
COPY --from=build /src/target/release/f2z-fakerelay /usr/local/bin/f2z-fakerelay
USER fakerelay
EXPOSE 9944
ENTRYPOINT ["/usr/local/bin/f2z-fakerelay"]
# --insecure-listen is required because the container binds 0.0.0.0, which
# WIRE.md §2.3 refuses without an explicit override. Typing it here rather than
# defaulting it away is the point: the override is meant to be visible.
CMD ["--listen", "0.0.0.0:9944", "--insecure-listen"]
