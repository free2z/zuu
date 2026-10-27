#!/bin/sh
# Runs only inside the selected backend image with read-only source/tools,
# an unprivileged UID, a writable scratch mount, and no release credentials.
set -eu
export HOME=/work/home
export CARGO_HOME=/work/cargo-home
export CARGO_TARGET_DIR=/work/target
export CARGO_BUILD_JOBS=2
export PATH=/tmp/rust/bin:/usr/local/bin:/usr/bin:/bin
export RUSTFLAGS='-C debuginfo=0'
mkdir -p "$HOME"
rust_version=$(python -I -c 'import json; print(json.load(open("/src/build/free2z/host-tools.json"))["rust_version"])')
sh "/tools/rust-$rust_version-x86_64-unknown-linux-gnu/install.sh" \
  --prefix=/tmp/rust --components=rustc,cargo,rust-std-x86_64-unknown-linux-gnu \
  --disable-ldconfig
test "$(rustc --version | cut -d ' ' -f 2)" = "$rust_version"
cargo test --locked --manifest-path /src/rs/zcash-payment-hooks/Cargo.toml
cargo build --locked --release --manifest-path /src/rs/zcash-payment-hooks/Cargo.toml
cp /work/target/release/zcash-paymentd /work/zcash-paymentd
cargo metadata --locked --format-version=1 --manifest-path /src/rs/zcash-payment-hooks/Cargo.toml > /work/cargo-metadata.json
python -I - <<'PY'
import hashlib, json, pathlib, shutil
root = pathlib.Path('/work/licenses')
root.mkdir()
shutil.copyfile('/src/LICENSE', root / 'first-party-LICENSE')
packages = []
for package in json.load(open('/work/cargo-metadata.json'))['packages']:
    source = pathlib.Path(package['manifest_path']).parent
    destination = root / (package['name'] + '-' + package['version'])
    destination.mkdir()
    files = {}
    for path in sorted(source.rglob('*')):
        if path.is_file() and any(part.lower().startswith(('license', 'licence', 'copying', 'copyright', 'notice')) for part in path.relative_to(source).parts):
            if path.is_symlink() or path.stat().st_size > 4 * 1024 * 1024:
                raise ValueError('invalid crate license file')
            name = path.relative_to(source).as_posix()
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
            files[name] = 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()
    if (package['source'] is not None or not package.get('license')) and not files:
        raise ValueError('crate has no license declaration or files: ' + package['name'])
    packages.append(dict(name=package['name'], version=package['version'], source=package['source'],
                         license=package.get('license'), files=files))
(root / 'packages.json').write_text(json.dumps(packages, sort_keys=True) + '\n')
PY
