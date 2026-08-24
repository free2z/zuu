# =============================================================================
# The three free2z E2EE server images, from one Dockerfile.
#
#   docker build -f rs/Dockerfile rs \
#     --build-arg BIN=f2z-relay \
#     --build-arg RUST_CHANNEL="$(scripts/check-rust-toolchain.sh --print-channel)"
#
# `BIN` is one of `f2z-relay`, `f2z-kt`, `f2z-witness` — the three AGPL-3.0
# server binaries of rs/README.md's licence boundary. There is no default:
# an image that quietly built the wrong binary is worse than a build that stops.
#
# ONE DOCKERFILE, NOT THREE. The three binaries share a workspace, a lockfile
# and a runtime base, and the thing that must not drift between them is exactly
# that shared part — the pinned compiler, the pinned distroless base, the uid,
# the absence of a shell. Three files would be three places for one of those to
# be edited alone.
#
# WHAT THIS IS NOT: `deploy/Dockerfile` beside it builds `f2z-fakerelay`, a test
# double for client development. This file builds the servers that run in
# production. They are deliberately different images with different bases and
# different promises.
#
# REPRODUCIBLE BUILDS ARE NOT CLAIMED. The CI attestation over a published
# digest proves *provenance* — that this workflow, in this repository, built
# that image from that commit. It does not prove that rebuilding the same commit
# yields the same digest, and nothing here tries to: `cargo build` embeds paths
# and timestamps, and the base images are pinned by digest rather than rebuilt.
# Provenance is the property the deployment relies on; reproducibility would be
# a separate piece of work and would have to be measured, not asserted.
# =============================================================================

# Declared before the first FROM so the final stage can select a per-binary
# runtime by name. That indirection is what lets `ENTRYPOINT` name a real,
# fixed path: exec-form ENTRYPOINT does not expand build arguments, and the
# deployment's `exec` probe runs `/f2z-witness` literally.
ARG BIN

# -----------------------------------------------------------------------------
# Builder.
# -----------------------------------------------------------------------------
# Pinned by digest, and bookworm on purpose: the runtime below is
# distroless/cc-**debian12**, which is bookworm. A builder on a newer Debian
# would link a newer glibc and produce a binary that starts on the build host
# and dies on the cluster.
#
# The image supplies rustup, not the compiler version. The version is decided in
# wallet/rust-toolchain.toml, restated in rs/rust-toolchain.toml, and held equal
# by scripts/check-rust-toolchain.sh. It is NOT written anywhere in this file:
# RUST_CHANNEL is passed in from `scripts/check-rust-toolchain.sh
# --print-channel`, and the first RUN below refuses to build unless it matches
# the toolchain file that is in the build context.
FROM docker.io/library/rust:1-slim-bookworm@sha256:94e9efa4033213dbb70d4f665527e7ece3944ddb7ba1dd2e43f6fd6e2490af58 AS build

ARG BIN
ARG RUST_CHANNEL

SHELL ["/bin/sh", "-euc"]
WORKDIR /src

# The whole rs/ workspace: one [workspace], one Cargo.lock. `--locked` below
# only means something if the lockfile present is the one in the repository.
COPY . /src

# Two refusals before a single crate is compiled, because both failures are
# silent otherwise: an unset BIN would build nothing and produce an image with
# no binary in it, and a RUST_CHANNEL that disagrees with the workspace's own
# toolchain file would produce a shipped artefact built by a compiler no gate
# ever ran.
RUN set -eu; \
    case "${BIN:-}" in \
      f2z-relay|f2z-kt|f2z-witness) ;; \
      "") echo "BIN build-arg is required (f2z-relay, f2z-kt or f2z-witness)" >&2; exit 1 ;; \
      *) echo "BIN=${BIN} is not one of the three server binaries" >&2; exit 1 ;; \
    esac; \
    test -n "${RUST_CHANNEL:-}" || { \
      echo "RUST_CHANNEL build-arg is required; pass scripts/check-rust-toolchain.sh --print-channel" >&2; \
      exit 1; \
    }; \
    declared=$(sed -n 's/^channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' rust-toolchain.toml); \
    test -n "$declared" || { echo "rust-toolchain.toml declares no channel" >&2; exit 1; }; \
    test "$declared" = "$RUST_CHANNEL" || { \
      echo "RUST_CHANNEL=${RUST_CHANNEL} but the workspace toolchain file says ${declared}" >&2; \
      exit 1; \
    }; \
    rustup toolchain install "$RUST_CHANNEL" --profile minimal --no-self-update

# No cache mount. A published server image is not a place to trade auditability
# for minutes: everything in the layer below came from the lockfile and the
# pinned compiler, and nothing came from a cache whose contents no attestation
# covers.
RUN set -eu; \
    cargo build --locked --release --package "$BIN" --bin "$BIN"; \
    install -D -m 0555 "target/release/$BIN" "/out/$BIN"

# -----------------------------------------------------------------------------
# Runtime.
# -----------------------------------------------------------------------------
# `cc`, not `static`: f2z-relay reaches SQLite through rusqlite's bundled C
# amalgamation and every one of the three links libc. `nonroot`, pinned by the
# digest of the multi-architecture index so the same reference resolves on any
# builder.
#
# There is no shell, no wget and no curl in here, which is the reason
# `f2z-witness healthz` is a subcommand of the binary rather than an endpoint:
# KT.md §9.3 promises a witness has no inbound listener, so an `exec` probe on
# this binary is the only probe shape that exists. See f2z-witness/src/health.rs.
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f AS runtime

# Restated rather than inherited. The base sets it today; a base bump that
# stopped setting it would otherwise return these images to root without a
# single line of this file changing.
USER 65532:65532

LABEL org.opencontainers.image.source="https://github.com/free2z/zuu"
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
LABEL org.opencontainers.image.vendor="free2z"
LABEL cash.free2z.image.role="e2ee-server"

# -----------------------------------------------------------------------------
# One stage per binary, so ENTRYPOINT can be a literal path.
# -----------------------------------------------------------------------------
# The binary lands at `/<name>` — not `/usr/local/bin/<name>` — because the
# deployment probes it by absolute path and a short one is a smaller thing to
# get wrong. Only the stage the final FROM selects is ever built.

FROM runtime AS bin-f2z-relay
LABEL org.opencontainers.image.title="f2z-relay"
LABEL org.opencontainers.image.description="The free2z relay daemon (docs/e2ee/WIRE.md)"
COPY --from=build /out/f2z-relay /f2z-relay
ENTRYPOINT ["/f2z-relay"]

FROM runtime AS bin-f2z-kt
LABEL org.opencontainers.image.title="f2z-kt"
LABEL org.opencontainers.image.description="The free2z key-transparency log server (docs/e2ee/KT.md)"
COPY --from=build /out/f2z-kt /f2z-kt
ENTRYPOINT ["/f2z-kt"]

FROM runtime AS bin-f2z-witness
LABEL org.opencontainers.image.title="f2z-witness"
LABEL org.opencontainers.image.description="The free2z key-transparency cosigning daemon (docs/e2ee/KT.md)"
COPY --from=build /out/f2z-witness /f2z-witness
# `healthz` is reachable by overriding the arguments, never by overriding the
# entrypoint: the probe is ["/f2z-witness", "healthz", "--state", FILE].
ENTRYPOINT ["/f2z-witness"]

# The selected image. `bin-${BIN}` is why ARG BIN is declared above the first
# FROM in this file.
FROM bin-${BIN}
