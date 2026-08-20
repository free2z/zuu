#!/usr/bin/env bash
set -euo pipefail

# Accept an alternate producer only for the repository's dynamic regression.
# The image inventory invokes this with no argument and therefore always reads
# the host linker cache through ldconfig.
readonly ldconfig_command=${1:-ldconfig}
linker_cache=$("$ldconfig_command" -p)
readonly linker_cache

# Do not use grep -q here. With pipefail, an early successful match can close a
# live producer's pipe and turn its SIGPIPE into a false missing-library result.
grep -E 'libxdo\.so([[:space:]]|$)' <<<"$linker_cache" >/dev/null
