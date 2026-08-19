# ZUULI Linux build image

ZUULI's Linux Rust and package jobs require WebKitGTK, GTK, Ayatana and other
development libraries that are not part of GitHub's Ubuntu runner image. The
repo-owned `ghcr.io/free2z/zuuli-linux-ci` image turns that mutable apt setup
into a reviewed, content-addressed OS dependency layer.

This document covers the two-phase bootstrap tracked in #407. The application,
Rust dependency graph and release credentials never belong in this image.

## Phase A: publish, but do not consume

The source lives in `.github/containers/zuuli-linux/`:

- `Dockerfile` pins the amd64 Ubuntu 24.04 base manifest by digest.
- `packages.txt` is the complete reviewed package manifest.
- `verify-inventory.sh` proves the OS, architecture, native `pkg-config`
  surface, AppImage execution mode and absence of Rust/source/cache state.
- `image.lock` binds those sources together. `UNPUBLISHED` is intentional until
  the first post-merge image exists.

`.github/workflows/zuuli-linux-image.yml` validates every pull request and
performs a real amd64 Docker build plus inventory check. A push to `main`, a
Wednesday schedule, or a manual run from `main` publishes two convenience tags
and records the immutable digest. BuildKit attaches an OCI SBOM and maximal
provenance; GitHub also publishes a registry attestation for that digest.

The ordinary required `wallet/zuuli` workflow still runs on a Phase A pull
request, but its checked-out diff does not classify this isolated bootstrap
surface as a release-impacting wallet change. Its fail-closed base/diff checks
and Rust-toolchain consistency check still run; the existing apt-heavy wallet
jobs legitimately skip. The dedicated image workflow is the authoritative
Phase A test. Do not add these bootstrap paths to the full-wallet change filter
before an immutable image can replace its apt steps.

## Phase B: pin and consume

After Phase A merges and the publish job succeeds:

1. Record `ghcr.io/free2z/zuuli-linux-ci@sha256:<digest>` from the job summary.
2. Verify the registry SBOM and provenance/attestation for that exact digest.
3. In a separate PR, change `image.lock` from `bootstrap`/`UNPUBLISHED` to the
   reviewed digest and switch only the Linux consumers named in #407.
4. Give each consumer `packages: read` and job-level `container.credentials`
   using `github.actor` and `secrets.GITHUB_TOKEN`; the runner pulls a job
   container before any login step can run. The OCI source label links the
   package to this repository, but confirm the new package inherited Actions
   access because an organization can disable automatic inheritance. Public
   visibility is optional, not assumed.
5. Remove their live apt steps, retain the inventory check as their first
   command, then install and verify the Rust version selected by
   `wallet/rust-toolchain.toml` exactly as today.
6. Add a hosted job-container smoke test using the exact digest. It must run
   checkout and setup actions plus explicit Bash commands before proving clean
   Rust builds and real AppImage, deb and RPM packages. Never consume
   `ubuntu-24.04` or another mutable tag.

The first consumer PR must extend `scripts/check-zuuli-linux-image.mjs` so every
consumer references the one locked digest and a mutable/mismatched reference is
rejected. Until then, the validator rejects every consumer reference.

## Rebuild, promotion and rollback

The weekly workflow rebuilds against the pinned Ubuntu base. A failed scheduled
build does not affect any consumer: the last reviewed digest remains available.
Package or base updates produce a new digest, unique run/attempt tag, SBOM and
provenance record; they do not move consumers automatically. The
`ubuntu-24.04` convenience tag is mutable by design. Promote a new digest only
through a PR that reviews the inventory/security delta and passes all consumer
smoke tests.

Rollback is a one-line digest change through the same reviewed PR path. Keep
the previous known-good digest in GHCR until its replacement has completed at
least two main-branch gates and a packaging canary. GHCR access uses the
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
