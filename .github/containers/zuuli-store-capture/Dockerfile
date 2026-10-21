FROM rust:1.97.1-slim-bookworm@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3 AS rust-toolchain

COPY ca-certificates.pem /run/capture-ca.pem
RUN echo '796f1389bfea13c0ed78f663b765baaff54a508e5483786bd6ece73c5e3e3cbe  /run/capture-ca.pem' | sha256sum -c - \
    && rm -rf /etc/ssl/certs /etc/ssl/verified-empty \
    && mkdir -p /etc/ssl/certs /etc/ssl/verified-empty \
    && install -m 0644 /run/capture-ca.pem /etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_DIR=/etc/ssl/verified-empty
ENV CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
ENV CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt

RUN rustup target add --toolchain 1.97.1 wasm32-unknown-unknown

FROM mcr.microsoft.com/playwright@sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac

COPY ca-certificates.pem /run/capture-ca.pem
RUN echo '796f1389bfea13c0ed78f663b765baaff54a508e5483786bd6ece73c5e3e3cbe  /run/capture-ca.pem' | sha256sum -c - \
    && rm -rf /etc/ssl/certs /etc/ssl/verified-empty \
    && mkdir -p /etc/ssl/certs /etc/ssl/verified-empty \
    && install -m 0644 /run/capture-ca.pem /etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_DIR=/etc/ssl/verified-empty
ENV CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
ENV CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt
COPY CA-NOTICE.md /usr/local/share/doc/capture-ca-NOTICE.md
ENV NODE_OPTIONS=--use-openssl-ca

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
