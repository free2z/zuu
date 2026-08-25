#!/bin/sh
set -eu

: "${ZUULI_REAL_CARGO:?ZUULI_REAL_CARGO must name the pinned toolchain cargo binary}"

case ${1-} in
  +*)
    toolchain=$1
    shift
    case ${1-} in
      +*) exec "$ZUULI_REAL_CARGO" "$toolchain" "$@" ;;
    esac
    exec "$ZUULI_REAL_CARGO" "$toolchain" auditable "$@"
    ;;
esac
exec "$ZUULI_REAL_CARGO" auditable "$@"
