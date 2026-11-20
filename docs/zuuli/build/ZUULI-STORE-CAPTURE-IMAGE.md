# ZUULI store-capture build image

The deterministic store screenshot path needs two toolchains in one worker:
the Chromium installation supplied by Playwright 1.62.1 and the exact Rust
1.97.1 `wasm32-unknown-unknown` compiler used by ZUULI's mandatory production
WASM build. The upstream Playwright image supplies only the first half.

`.github/containers/zuuli-store-capture/` defines the combined worker from two
digest-pinned upstream images. Rust is copied from the official exact-version
image; no installer is downloaded or piped to a shell. The image inventory is
verified while the image builds, again from the PR image, and again from the
published registry digest.

`.github/workflows/zuuli-store-capture-image.yml` is deliberately a Phase A
producer. Pull requests build and inspect the proposed `linux/amd64` image but
cannot publish it. Exact `main`, scheduled, and manual runs publish to GHCR with
OCI SBOM/provenance and a GitHub artifact attestation. The workflow summary
prints the immutable digest.

Issue #956 consumes the immutable combined image for ZUULI capture:

`ghcr.io/free2z/zuuli-store-capture@sha256:13c508c86e0a458c180059dbb6fa6e45406fcd01e24f5416de7c78acf8b57be9`

The [successful producer run](https://github.com/free2z/zuu/actions/runs/42997859565)
built from `b4e3d79334b6ee56f0796776db6251e821d5dd4a`. Its OCI index selects
`linux/amd64` manifest
`sha256:3362744a690b2dcf2d51aa69d70d77430a57fb8b7017a8bd94b0797c4cfe4060`.
`gh attestation verify oci://<image@digest> --repo free2z/zuu --format json`
verified its signed provenance (workflow `zuuli-store-capture-image.yml`,
`refs/heads/main`, same source commit). The image labels and runtime inventory
were independently inspected before capture. No mutable tag is consumed.

The runner mounts `wallet/` at `/work` and works in `/work/zuuli`, making the
pinned subtree toolchain and shared source available without exposing Git
metadata. The host proves product-source identity before and after capture;
source/contract digests bracket the build and both passes. Source identity now
also covers shared renderer code, WASM source, build scripts and build metadata.
Mutation tests reject an image change, route drift, fixture drift and source
changes. Each worker executes the image's inventory verifier and the existing
TLS/input preflights before building. The image pin is distinct from the
Playwright browser version, which remains 1.62.1.

Free2Z and E2E2Z retain their original pinned Playwright worker because neither
requires ZUULI's Rust build. Their captures are regenerated when shared tooling
changes; their evidence continues to state Linux Chromium rather than Android
hardware or native transport verification.

Run the source-policy gate locally with:

```sh
node scripts/check-zuuli-store-capture-image.mjs --self-test
node scripts/check-zuuli-store-capture-image.mjs
```
