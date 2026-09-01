FROM rust:1.97.1-slim-bookworm@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3 AS rust-toolchain

RUN rustup target add --toolchain 1.97.1 wasm32-unknown-unknown

FROM mcr.microsoft.com/playwright@sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac

LABEL org.opencontainers.image.source="https://github.com/free2z/zuu"
LABEL org.opencontainers.image.description="Pinned Playwright and Rust/WASM worker for deterministic ZUULI store captures"
LABEL org.opencontainers.image.licenses="MIT"
LABEL cash.free2z.zuuli.image.role="store-capture-toolchain"

COPY --from=rust-toolchain /usr/local/cargo /usr/local/cargo
COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup

ENV CARGO_HOME=/usr/local/cargo
ENV RUSTUP_HOME=/usr/local/rustup
ENV PATH=/usr/local/cargo/bin:${PATH}

COPY verify-inventory.sh /usr/local/bin/verify-zuuli-store-capture-image

RUN chmod 0755 /usr/local/bin/verify-zuuli-store-capture-image \
    && /usr/local/bin/verify-zuuli-store-capture-image
