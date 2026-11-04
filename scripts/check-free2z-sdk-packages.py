#!/usr/bin/env python3
"""Audit pre-release SDK archives and compile a consumer of unpacked artifacts.

No publication. Dependency patches are confined to this verification process.
Requires Python 3.12+, Git and the repository's pinned Rust toolchain.
"""
from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import tomllib


def run(args: list[str], cwd: Path, env: dict[str, str] | None = None) -> str:
    return subprocess.check_output(args, cwd=cwd, env=env, text=True).strip()


def check_native_lock_change(before: str, after: str, allowed: list[dict[str, str]]) -> None:
    """Only exact unused local overrides may be appended; preserve the resolved graph."""
    old, new = tomllib.loads(before), tomllib.loads(after)
    old_patch, new_patch = old.pop("patch", {}), new.pop("patch", {})
    old_unused = old_patch.pop("unused", [])
    remaining = new_patch.pop("unused", []).copy()
    if old != new or old_patch != new_patch:
        raise SystemExit("Native snapshot lock normalization changed resolved dependencies or metadata.")
    for entry in old_unused:
        if entry not in remaining:
            raise SystemExit("Native snapshot lock normalization removed an existing override.")
        remaining.remove(entry)
    permitted = allowed.copy()
    for entry in remaining:
        if entry not in permitted:
            raise SystemExit("Native snapshot lock normalization added an unexpected override.")
        permitted.remove(entry)


def normalize_native_lock(command: list[str], stage: Path, env: dict[str, str],
                          relative: str, unpacked: dict[str, Path]) -> None:
    lock_name = relative + "/Cargo.lock"
    run(["git", "ls-files", "--error-unmatch", lock_name], stage)
    lock = stage / lock_name
    before = lock.read_text()
    # Core packaging already normalized the reduced snapshot workspace. Native
    # resolution may not change that graph, nor commit its earlier local diff.
    rs_lock = stage / "rs/Cargo.lock"
    rs_before = rs_lock.read_bytes()
    metadata = command.copy()
    metadata[metadata.index("package")] = "metadata"
    metadata.remove("--no-verify")
    metadata.extend(["--format-version", "1"])
    run(metadata, stage, env)
    allowed = [{"name": name, "version": tomllib.loads((path / "Cargo.toml").read_text())["package"]["version"]}
               for name, path in unpacked.items() if name in ("f2z-ai-proto", "f2z-sdk")]
    check_native_lock_change(before, lock.read_text(), allowed)
    if rs_lock.read_bytes() != rs_before:
        raise SystemExit("Native snapshot normalization changed the core workspace lock.")
    changed = set(run(["git", "diff", "--name-only"], stage).splitlines())
    if changed - {lock_name, "rs/Cargo.lock"} or run(["git", "diff", "--cached", "--name-only"], stage):
        raise SystemExit("Unexpected tracked snapshot changes before native packaging.")
    if lock.read_text() != before:
        run(["git", "add", lock_name], stage)
        run(["git", "-c", "user.name=SDK package verification", "-c", "user.email=package-test@example.invalid",
             "-c", "commit.gpgsign=false", "commit", "-qm", "Record snapshot-only unused local overrides"], stage)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--with-native", action="store_true")
    args = parser.parse_args()
    root = args.source_root.resolve()
    if run(["git", "status", "--porcelain", "--untracked-files=all"], root):
        raise SystemExit("Package verification requires a clean committed source worktree.")
    channel = tomllib.loads((root / "rust-toolchain.toml").read_text())["toolchain"]["channel"]
    sdk = "rs/crates/f2z-sdk"
    proto = "rs/crates/f2z-ai-proto"
    plugin = "wallet/plugins/tauri-plugin-f2z"
    paths = ["rust-toolchain.toml", "rs/Cargo.toml", "rs/Cargo.lock", "rs/rust-toolchain.toml", sdk, proto]
    crates = [("f2z-ai-proto", proto), ("f2z-sdk", sdk)]
    if args.with_native:
        if not (root / plugin / "Cargo.toml").is_file():
            raise SystemExit("Native plugin is not present in this source revision.")
        paths.append(plugin)
        crates.append(("tauri-plugin-f2z", plugin))
    output = root / "target/free2z-sdk-package-preview"
    output.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["CARGO_TARGET_DIR"] = str(output / "build")
    source_sha = run(["git", "rev-parse", "HEAD"], root)
    archive = subprocess.check_output(["git", "archive", "HEAD", *paths], cwd=root)
    with tempfile.TemporaryDirectory(prefix="source-", dir=output) as tmp:
        stage = Path(tmp)
        with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
            bundle.extractall(stage, filter="data")
        run(["git", "init", "-q"], stage)
        run(["git", "add", "."], stage)
        run(["git", "-c", "user.name=SDK package verification", "-c", "user.email=package-test@example.invalid",
             "-c", "commit.gpgsign=false", "commit", "-qm", f"Preview snapshot of {source_sha}"], stage)
        unpacked: dict[str, Path] = {}
        for name, relative in crates:
            manifest = stage / relative / "Cargo.toml"
            version = tomllib.loads(manifest.read_text())["package"]["version"]
            command = ["cargo", f"+{channel}", "package", "--manifest-path", str(manifest), "--no-verify"]
            for dependency, path in unpacked.items():
                command.extend(["--config", f"patch.crates-io.{dependency}.path={json.dumps(str(path))}"])
            if name == "tauri-plugin-f2z":
                normalize_native_lock(command, stage, env, relative, unpacked)
            subprocess.run(command, cwd=stage, env=env, check=True)
            artifact = output / "build/package" / f"{name}-{version}.crate"
            if not artifact.is_file():
                raise SystemExit(f"Missing artifact for {name}")
            destination = stage / "unpacked"
            destination.mkdir(exist_ok=True)
            with tarfile.open(artifact) as bundle:
                names = [member.name for member in bundle.getmembers()]
                prefix = f"{name}-{version}/"
                files = [item.removeprefix(prefix) for item in names]
                required = {"Cargo.toml", "README.md", "CHANGELOG.md", "LICENSE", "src/lib.rs"}
                if not required.issubset(files):
                    raise SystemExit(f"Incomplete package metadata/source in {name}")
                if any(part in file.split("/") for file in files for part in ("target", "node_modules", ".build", ".env")):
                    raise SystemExit(f"Build output or local configuration in {name} archive")
                if name != "tauri-plugin-f2z":
                    permitted = {"Cargo.toml", "Cargo.toml.orig", "Cargo.lock", ".cargo_vcs_info.json", "README.md", "CHANGELOG.md", "LICENSE"}
                    if any(file not in permitted and not file.startswith("src/") for file in files):
                        raise SystemExit(f"Non-library file in {name} archive")
                else:
                    if not all(any(file.startswith(prefix) for file in files) for prefix in ("permissions/", "android/src/", "ios/Sources/")):
                        raise SystemExit("Native package is missing platform assets or permissions")
                    for expected in ("build.rs", "command_registry.rs", "android/build.gradle.kts", "android/consumer-rules.pro", "ios/Package.swift"):
                        if expected not in files:
                            raise SystemExit(f"Native package missing {expected}")
                bundle.extractall(destination, filter="data")
            unpacked[name] = destination / f"{name}-{version}"
            normalized = tomllib.loads((unpacked[name] / "Cargo.toml").read_text())
            for dependency in ("f2z-ai-proto", "f2z-sdk"):
                spec = normalized.get("dependencies", {}).get(dependency)
                if spec and ("path" in spec or "git" in spec or not spec.get("version")):
                    raise SystemExit(f"Unpublishable {dependency} dependency in {name}")
            print(f"Audited {name} {version}: {len(files)} archive entries", flush=True)
        consumer = stage / "consumer"
        (consumer / "src").mkdir(parents=True)
        dependencies = "\n".join(f"{name} = {{ path = {json.dumps(str(path))} }}" for name, path in unpacked.items())
        patches = "\n".join(f"{name} = {{ path = {json.dumps(str(path))} }}" for name, path in unpacked.items())
        (consumer / "Cargo.toml").write_text(f'[package]\nname = "sdk-package-consumer"\nversion = "0.0.0"\nedition = "2024"\npublish = false\n[workspace]\n[dependencies]\n{dependencies}\n[patch.crates-io]\n{patches}\n')
        (consumer / "src/main.rs").write_text('''use std::sync::Arc;
use f2z_sdk::{Client, Config, MemoryStore};
use f2z_ai_proto::{Bps, Nusd, Whole2z, price_nusd};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _client = Client::new(Config::new("package-preview"), Arc::new(MemoryStore::new()))?;
    let charge = price_nusd(Nusd::new(21_000_000), Bps(0), Bps(0), Whole2z::new(1))?;
    assert_eq!(charge.total_2z(), Whole2z::new(3));
    Ok(())
}
''')
        if args.with_native:
            source = consumer / "src/main.rs"
            source.write_text(source.read_text().replace("    let charge =", '    let _native = tauri_plugin_f2z::Builder::new(Config::new("package-preview"), "https://tutor.example/purchase-return");\n    let charge ='))
        subprocess.run(["cargo", f"+{channel}", "run", "--manifest-path", str(consumer / "Cargo.toml")], cwd=stage, env=env, check=True)
    print(f"Preview package consumer passed for source {source_sha}; no package was published.")


if __name__ == "__main__":
    main()
