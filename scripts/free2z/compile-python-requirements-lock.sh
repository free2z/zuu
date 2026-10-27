#!/usr/bin/env bash
# Free2Z application check: compile python requirements lock.
set -euo pipefail

lock_target="${1:-main}"
if [[ $# -gt 1 || ! "$lock_target" =~ ^(main|test|ci-audit|ci-lint|ci-policy)$ ]]; then
  echo "usage: $0 [main|test|ci-audit|ci-lint|ci-policy]" >&2
  exit 2
fi

repo_root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
dockerfile="${repo_root}/build/free2z/backend.Dockerfile"
image="$(sed -nE 's/^FROM ([^[:space:]]+).*/\1/p' "${dockerfile}")"
if [[ -z "${image}" ]]; then
  echo "could not read the pinned Python image from ${dockerfile}" >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to compile requirements locks" >&2
  exit 2
fi

cidfile="${TMPDIR:-/tmp}/free2z-compile-$$.cid"
trap 'if [[ -f "$cidfile" ]]; then echo "Python lock compile container: $(cat "$cidfile")" >&2; rm -f "$cidfile"; fi' EXIT
if docker run --cidfile "$cidfile" --rm --platform linux/amd64 \
  --name "free2z-compile-python-lock-$$" \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp \
  --env "LOCK_TARGET_IMAGE=${image}" \
  --env "LOCK_TARGET=${lock_target}" \
  --volume "${repo_root}:/workspace" \
  --workdir /workspace/py/free2z \
  "${image}" sh -ec '
    python -m venv /tmp/pip-tools
    /tmp/pip-tools/bin/python -m pip install --disable-pip-version-check --no-cache-dir --ignore-installed --only-binary=:all: --require-hashes -r requirements/lock-tools.txt
    CUSTOM_COMPILE_COMMAND="scripts/free2z/compile-python-requirements-lock.sh $LOCK_TARGET" /tmp/pip-tools/bin/pip-compile \
      --allow-unsafe \
      --generate-hashes \
      --resolver=backtracking \
      --output-file "requirements/$LOCK_TARGET.txt" \
      "requirements/$LOCK_TARGET.in"
    tmp="$(mktemp)"
    printf "# Target image: %s (linux/amd64)\\n" "$LOCK_TARGET_IMAGE" > "$tmp"
    cat "requirements/$LOCK_TARGET.txt" >> "$tmp"
    cat "$tmp" > "requirements/$LOCK_TARGET.txt"
    rm "$tmp"
  '; then
  exit 0
else
  status=$?
  exit "$status"
fi
