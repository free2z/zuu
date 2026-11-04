#!/usr/bin/env bash
set -euo pipefail

readonly bundle=/usr/local/share/zuuli-linux-image/ca-certificates.pem
readonly digest=796f1389bfea13c0ed78f663b765baaff54a508e5483786bd6ece73c5e3e3cbe
printf '%s  %s\n' "$digest" "$bundle" | sha256sum --check --status
# Select the same verified roots for clients that use the default OpenSSL
# bundle, and remove hashed fallback anchors. Run again after package postinst.
rm -rf /etc/ssl/certs /etc/ssl/verified-empty
mkdir -p /etc/ssl/certs /etc/ssl/verified-empty
install -m 0644 "$bundle" /etc/ssl/certs/ca-certificates.crt
