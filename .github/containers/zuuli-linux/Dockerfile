FROM ubuntu:24.04@sha256:1e0a86e57d247923571b75e0aaf48a1449cf8c543d51fb3e07a4a7d7bfa79316

ARG DEBIAN_FRONTEND=noninteractive

LABEL org.opencontainers.image.source="https://github.com/free2z/zuu"
LABEL org.opencontainers.image.description="Ubuntu 24.04 system dependencies for ZUULI Tauri Linux builds"
LABEL org.opencontainers.image.licenses="MIT"
LABEL cash.free2z.zuuli.image.role="os-dependencies-only"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

COPY ca-certificates.pem CA-NOTICE.md /usr/local/share/zuuli-linux-image/
COPY install-tls-trust.sh /usr/local/bin/install-zuuli-linux-tls-trust
RUN bash /usr/local/bin/install-zuuli-linux-tls-trust

ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_DIR=/etc/ssl/verified-empty
ENV CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
ENV GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt
ENV GIT_SSL_CAPATH=/etc/ssl/verified-empty
ENV CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt
ENV RUSTUP_USE_CURL=1
ENV NODE_OPTIONS=--use-openssl-ca

COPY packages.txt /tmp/zuuli-linux-packages.txt

RUN timeout 10m apt-get \
      -o Acquire::Retries=5 \
      -o Acquire::http::Timeout=30 \
      -o Acquire::https::Timeout=30 \
      update \
    && xargs --no-run-if-empty timeout 30m apt-get \
      -o Acquire::Retries=5 \
      -o Acquire::http::Timeout=30 \
      -o Acquire::https::Timeout=30 \
      install -y --no-install-recommends \
      < /tmp/zuuli-linux-packages.txt \
    && bash /usr/local/bin/install-zuuli-linux-tls-trust \
    && rm -rf /var/lib/apt/lists/* \
    && rm /tmp/zuuli-linux-packages.txt

COPY packages.txt /usr/local/share/zuuli-linux-image/packages.txt
COPY verify-inventory.sh /usr/local/bin/verify-zuuli-linux-image
COPY verify-libxdo.sh /usr/local/bin/verify-zuuli-libxdo
COPY verify-tls-network.sh /usr/local/bin/verify-zuuli-linux-tls-network

# linuxdeploy/AppImage tooling cannot mount FUSE inside an ordinary Actions job
# container. Extraction preserves the package output without privileged mounts.
ENV APPIMAGE_EXTRACT_AND_RUN=1

RUN chmod 0755 \
      /usr/local/bin/verify-zuuli-linux-tls-network \
      /usr/local/bin/verify-zuuli-libxdo \
      /usr/local/bin/verify-zuuli-linux-image \
    && /usr/local/bin/verify-zuuli-linux-image
