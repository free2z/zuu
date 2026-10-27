#!/usr/bin/env bash
# Free2Z application check: compile python requirements lock.
set -euo pipefail

repo_root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
dockerfile="${repo_root}/build/free2z/backend.Dockerfile"
image="$(sed -nE 's/^FROM ([^[:space:]]+).*/\1/p' "${dockerfile}")"
if [[ -z "${image}" ]]; then
  echo "could not read the pinned Python image from ${dockerfile}" >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to compile the production requirements lock" >&2
  exit 2
fi

cidfile="${TMPDIR:-/tmp}/free2z-compile-$$.cid"
trap 'if [[ -f "$cidfile" ]]; then echo "Python lock compile container: $(cat "$cidfile")" >&2; rm -f "$cidfile"; fi' EXIT
if docker run --cidfile "$cidfile" --rm --platform linux/amd64 \
  --name "free2z-compile-python-lock-$$" \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp \
  --env "LOCK_TARGET_IMAGE=${image}" \
  --volume "${repo_root}:/workspace" \
  --workdir /workspace/py/free2z \
  "${image}" sh -ec '
    python -m venv /tmp/pip-tools
    /tmp/pip-tools/bin/python -m pip install --disable-pip-version-check --no-cache-dir pip-tools==7.6.1
    /tmp/pip-tools/bin/pip-compile \
      --allow-unsafe \
      --generate-hashes \
      --resolver=backtracking \
      --output-file requirements/main.txt \
      requirements/main.in
    tmp="$(mktemp)"
    printf "# Target image: %s (linux/amd64)\\n" "$LOCK_TARGET_IMAGE" > "$tmp"
    cat requirements/main.txt >> "$tmp"
    cat "$tmp" > requirements/main.txt
    rm "$tmp"
  '; then
  exit 0
else
  status=$?
  exit "$status"
fi
