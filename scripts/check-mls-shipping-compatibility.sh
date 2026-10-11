#!/usr/bin/env bash
# Real previous shipping locks versus current locks, including a queued commit
# and on-disk state opened after upgrade. No external service or money IO.
set -euo pipefail
repo=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
candidate=${F2Z_MLS_COMPAT_SOURCE:-$repo}
baseline=40bfabffb3f765046ceafad213a26a5754dbd6b9
fixture=$(mktemp -d "${TMPDIR:-/tmp}/mls-shipping-compatibility.XXXXXX")
trap 'rm -rf -- "$fixture"' EXIT
if ! git -C "$repo" cat-file -e "$baseline^{commit}"; then
  git -C "$repo" fetch --no-tags origin "$baseline"
fi
mkdir -p "$fixture/old"
git -C "$repo" archive "$baseline" | tar -x -C "$fixture/old"
cp "$repo/rs/crates/f2z-msg-mls/tests/shipping_compatibility_peer.rs" "$fixture/old/rs/crates/f2z-msg-mls/tests/"
# Both binaries build separately; only relay bytes and each device's SQLite
# store survive a step. A new dependency graph never resolves the old binary.
for graph in "$fixture/old" "$candidate"; do
  cargo +1.97.1 test --manifest-path "$graph/rs/Cargo.toml" --locked \
    -p f2z-msg-mls --test shipping_compatibility_peer --no-run
 done
run_peer() {
  local graph=$1 actor=$2 step=$3
  F2Z_MLS_COMPAT_DIR=$state F2Z_MLS_COMPAT_ACTOR=$actor F2Z_MLS_COMPAT_STEP=$step \
    cargo +1.97.1 test --manifest-path "$graph/rs/Cargo.toml" --locked \
      -p f2z-msg-mls --test shipping_compatibility_peer -- --ignored --exact shipping_compatibility_peer
}
for upgraded in alice bob; do
  state=$fixture/$upgraded
  mkdir "$state"
  run_peer "$fixture/old" bob key-package
  run_peer "$fixture/old" alice add
  run_peer "$fixture/old" bob join
  # Bob's upgrade happens after Alice persisted and queued this old commit.
  alice=$fixture/old bob=$fixture/old
  if [[ $upgraded == alice ]]; then alice=$candidate; else bob=$candidate; fi
  run_peer "$alice" alice update
  run_peer "$bob" bob receive
  run_peer "$bob" bob update
  run_peer "$alice" alice receive
  printf 'shipping compatibility: %s upgrade, queued old state, both update/message directions passed\n' "$upgraded"
done
