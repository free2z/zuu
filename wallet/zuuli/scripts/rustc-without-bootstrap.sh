#!/bin/sh
set -eu

if [ "$#" -eq 0 ] || [ -z "${1:-}" ]; then
  printf '%s\n' 'ZUULI rustc wrapper requires the real rustc command' >&2
  exit 64
fi

real_rustc=$1
shift
unset RUSTC_BOOTSTRAP
exec "$real_rustc" "$@"
