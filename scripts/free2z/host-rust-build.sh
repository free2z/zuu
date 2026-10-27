#!/bin/sh
# Runs only inside the selected backend image with read-only source/tools,
# an unprivileged UID, a writable scratch mount, and no release credentials.
set -eu
export HOME=/work/home
export CARGO_HOME=/work/cargo-home
export CARGO_TARGET_DIR=/work/target
export CARGO_BUILD_JOBS=2
# Docker's /tmp tmpfs is noexec. Compiler tools belong on the executable
# scratch bind alongside Cargo's build scripts and targets.
export PATH=/work/rust-toolchain/bin:/usr/local/bin:/usr/bin:/bin
export RUSTFLAGS='-C debuginfo=0'
mkdir -p "$HOME"
rust_version=$(python -I -c 'import json; print(json.load(open("/src/build/free2z/host-tools.json"))["rust_version"])')
sh "/tools/rust-$rust_version-x86_64-unknown-linux-gnu/install.sh" \
  --prefix=/work/rust-toolchain --components=rustc,cargo,rust-std-x86_64-unknown-linux-gnu \
  --disable-ldconfig
test "$(rustc --version | cut -d ' ' -f 2)" = "$rust_version"
cargo test --locked --manifest-path /src/rs/zcash-payment-hooks/Cargo.toml
cargo build --locked --release --manifest-path /src/rs/zcash-payment-hooks/Cargo.toml
cp /work/target/release/zcash-paymentd /work/zcash-paymentd
cargo metadata --locked --format-version=1 --manifest-path /src/rs/zcash-payment-hooks/Cargo.toml > /work/cargo-metadata.json
python -I /src/scripts/free2z/host_runtime/licenses.py \
  --repository /src --metadata /work/cargo-metadata.json \
  --cargo-home "$CARGO_HOME" --output /work/licenses
