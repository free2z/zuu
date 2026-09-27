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
        subprocess.run(["cargo", f"+{channel}", "run", "--manifest-path", str(consumer / "Cargo.toml")], cwd=stage, env=env, check=True)
    print(f"Preview package consumer passed for source {source_sha}; no package was published.")


if __name__ == "__main__":
    main()
