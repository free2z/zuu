#!/bin/sh
set -eu

: "${ZUULI_REAL_CARGO:?ZUULI_REAL_CARGO must name the pinned toolchain cargo binary}"
exec "$ZUULI_REAL_CARGO" auditable "$@"
