FROM ubuntu:24.04@sha256:1e0a86e57d247923571b75e0aaf48a1449cf8c543d51fb3e07a4a7d7bfa79316

ARG DEBIAN_FRONTEND=noninteractive

LABEL org.opencontainers.image.source="https://github.com/free2z/zuu"
LABEL org.opencontainers.image.description="Ubuntu 24.04 system dependencies for ZUULI Tauri Linux builds"
LABEL org.opencontainers.image.licenses="MIT"
LABEL cash.free2z.zuuli.image.role="os-dependencies-only"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

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
    && rm -rf /var/lib/apt/lists/* \
    && rm /tmp/zuuli-linux-packages.txt

COPY packages.txt /usr/local/share/zuuli-linux-image/packages.txt
COPY verify-inventory.sh /usr/local/bin/verify-zuuli-linux-image

# linuxdeploy/AppImage tooling cannot mount FUSE inside an ordinary Actions job
# container. Extraction preserves the package output without privileged mounts.
ENV APPIMAGE_EXTRACT_AND_RUN=1

RUN chmod 0755 /usr/local/bin/verify-zuuli-linux-image \
    && /usr/local/bin/verify-zuuli-linux-image
