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

The screenshot capture configuration does **not** consume a mutable tag or an
unreviewed Phase A image. A separate Phase B PR must:

1. inspect the published manifest and attestation;
2. pin the exact `ghcr.io/free2z/zuuli-store-capture@sha256:…` digest;
3. mount `wallet/` at the container boundary and work from `wallet/zuuli/`, so
   `wallet/rust-toolchain.toml` is available without exposing unrelated repo
   state; and
4. mutation-test both the image/toolchain pin and wallet-root mount before the
   two-pass 20-image refresh.

Run the source-policy gate locally with:

```sh
node scripts/check-zuuli-store-capture-image.mjs --self-test
node scripts/check-zuuli-store-capture-image.mjs
```
