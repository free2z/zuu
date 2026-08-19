# ZUULI Linux build image

ZUULI's Linux Rust and package jobs require WebKitGTK, GTK, Ayatana and other
development libraries that are not part of GitHub's Ubuntu runner image. The
repo-owned `ghcr.io/free2z/zuuli-linux-ci` image turns that mutable apt setup
into a reviewed, content-addressed OS dependency layer.

This document records the two-phase rollout tracked in #407. The application,
Rust dependency graph and release credentials never belong in this image.

## Phase A: published and attested

The source lives in `.github/containers/zuuli-linux/`:

- `Dockerfile` pins the amd64 Ubuntu 24.04 base manifest by digest.
- `packages.txt` is the complete reviewed package manifest.
- `verify-inventory.sh` proves the OS, architecture, native `pkg-config`
  surface, AppImage execution mode and absence of Rust/source/cache state.
- `image.lock` binds those sources to the promoted registry digest.

`.github/workflows/zuuli-linux-image.yml` validates every pull request and
performs a real amd64 Docker build plus inventory check. A push to `main`, a
Wednesday schedule, or a manual run from `main` publishes two convenience tags
and records the immutable digest. BuildKit attaches an OCI SBOM and maximal
provenance; GitHub also publishes a registry attestation for that digest.

The first published image was built from `da58e6567698a173db6cf8bf64c8dcab23f9c5fa`.
[GitHub attestation 41577363](https://github.com/free2z/zuu/attestations/41577363)
binds the untagged subject
`ghcr.io/free2z/zuuli-linux-ci` to digest
`sha256:bc66315a17723a6a828a8d3c91733ff2e06f164d18a17de72acf199cc27381d1`,
the main-branch image workflow, and a GitHub-hosted runner.

## Phase B: digest-pinned consumers

Exactly five Linux consumers use the promoted digest: the required lint,
standalone plugin, and ZUULI backend jobs; the Linux packaging smoke matrix
entry; and the protected Linux release job. macOS, Android, iOS, lightweight
format/supply-chain jobs, and all store-upload jobs remain on their native
runners.

GHCR keeps the package private. Each consumer therefore grants only
`packages: read` and supplies `github.actor` plus `secrets.GITHUB_TOKEN` as
job-level `container.credentials`; the runner must authenticate before any
step exists. The image inventory and Bash smoke are the first step, followed by
checkout, an immediate exact-workspace Git ownership exception, and setup
actions. This proves the runner-provided JavaScript action runtime works inside
the minimal image without granting broad `safe.directory` trust. Rust still
comes exclusively from the pinned toolchain action and
`wallet/rust-toolchain.toml`.

`scripts/check-zuuli-linux-image.mjs` enforces the consumed lock state, exactly
five identical digest references, pull-time credentials, packages-read scope,
the inventory-first contract, explicit Bash, and absence of live apt commands.
Its negative tests reject mutable tags, digest skew, missing credentials,
reordered inventory, missing or broad Git ownership trust, and policy paths
that no longer select the full required gate.

## Rebuild, promotion and rollback

The weekly workflow rebuilds against the pinned Ubuntu base. A failed scheduled
build does not affect any consumer: the last reviewed digest remains available.
Package or base updates produce a new digest, unique run/attempt tag, SBOM and
provenance record; they do not move consumers automatically. The
`ubuntu-24.04` convenience tag is mutable by design. Promote a new digest only
through a PR that reviews the inventory/security delta and passes all consumer
smoke tests.

Rollback promotes the previous digest through the same reviewed PR path,
updating the lock, validator binding, and every consumer together. Keep the
previous known-good digest in GHCR until its replacement has completed at least
two main-branch gates and a packaging canary. GHCR access uses the
workflow-scoped `GITHUB_TOKEN`; no registry password or release credential is
stored in the image or repository.

Review the base digest and native package inventory at least monthly and after
Ubuntu or WebKitGTK security notices. Publishing uses fresh build state rather
than a cross-run apt layer cache so a scheduled rebuild can actually pick up
repository updates. Consumers remain immutable until review promotes them.

## What is deliberately excluded

- Rust, Cargo and rustup: `wallet/rust-toolchain.toml` remains authoritative.
- Repository source, `target/`, Cargo registries and npm state.
- Signing keys, service-account documents, tokens and store credentials.
- A change to the Linux compatibility baseline.

Tauri recommends the oldest supported system with WebKitGTK 4.1, naming Ubuntu
22.04 and Debian 12 as suitable examples. Moving away from the current Ubuntu
24.04 release baseline changes the minimum glibc contract and must be evaluated
as its own issue after the immutable-image path is proven.

Run the policy locally with:

```bash
node scripts/check-zuuli-linux-image.mjs --self-test
docker build --platform linux/amd64 \
  --tag zuuli-linux-ci:local .github/containers/zuuli-linux
docker run --rm zuuli-linux-ci:local /usr/local/bin/verify-zuuli-linux-image
```
