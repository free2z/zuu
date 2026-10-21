# Capture certificate trust

`ca-certificates.pem` is the Mozilla-derived CA bundle published by curl on
2026-10-20 at <https://curl.se/ca/cacert-2026-10-20.pem>. Its SHA-256 is
`796f1389bfea13c0ed78f663b765baaff54a508e5483786bd6ece73c5e3e3cbe`.
The PEM header retains its source attribution. The [curl CA extract](https://curl.se/docs/caextract.html) is licensed under the [Mozilla Public License 2.0](https://www.mozilla.org/MPL/2.0/).

The pinned Playwright browser image contains an older Node certificate store.
Capture wrappers verify this bundle, replace the system bundle and hashed
certificate directory, and select Node's OpenSSL verifier before fetching npm
packages. An exclusive empty directory prevents alternate trust-anchor lookup.
The Rust/WASM capture image installs the same bundle before rustup downloads
and in its browser stage. Browser and toolchain versions are unchanged.

Rotate the bundle through review: update its bytes and checksum in the helper
and Dockerfile, rerun all incident-chain rejections with a valid TLS control,
and regenerate capture records through real browser renders. Stored screenshots
are draft evidence, not publication approval or physical-device verification.
