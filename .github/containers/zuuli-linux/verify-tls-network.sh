#!/usr/bin/env bash
set -euo pipefail

# Only issuer/revocation failures count. A timeout, hostname mismatch, or
# expiration cannot establish protection against the compromised authorities.
result=$(mktemp)
readonly result
trap 'rm -f "$result"' EXIT
count=0
for kind in dv ov ev; do
  for variant in g3b g3c; do
    for prefix in '' aaa-; do
      host="$kind-$variant-${prefix}emudhra.we-have-a-problem.com"
      status=0
      curl --noproxy '*' --connect-timeout 10 --max-time 25 --silent --show-error \
        --output /dev/null "https://$host/" 2>"$result" || status=$?
      [[ "$status" == 60 ]] || { echo "TLS path accepted or inconclusive: $host" >&2; exit 1; }
      grep -Eiq 'unable to get (local )?issuer certificate|self.signed certificate in certificate chain|certificate revoked' "$result" \
        || { echo "Unclassified certificate rejection: $host" >&2; exit 1; }
      count=$((count + 1))
    done
  done
done
for control in https://example.com/ https://registry.k8s.io/v2/; do
  code=$(curl --noproxy '*' --connect-timeout 10 --max-time 25 --silent --show-error \
    --location --output /dev/null --write-out '%{http_code}' "$control")
  case "$control:$code" in
    https://example.com/:200|https://registry.k8s.io/v2/:200|https://registry.k8s.io/v2/:401) ;;
    *) echo "Unexpected valid-control HTTP response: $control" >&2; exit 1;;
  esac
done
printf 'TLS issuer/revocation rejections=%s valid_controls=2\n' "$count"
