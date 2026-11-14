# ZUULI store source of truth

`manifest.json` and `locales/` are the canonical, locale-ready source for App
Store Connect and Google Play presentation. The app and package identifiers are
fixed; each locale maps explicitly to Apple and Play locale codes so adding a
translation never relies on filename inference.

Phase B is deliberately `publicationReady: false`. The reviewed icons and Play
feature graphic from the canonical brand generator remain hash-pinned, and each
required device class now has four deterministic screenshot candidates. They
are capture evidence—not live store state and not owner-approved publication
media. Publication remains blocked on unshipped backend dependencies tracked
internally, owner verification of the minimum Apple credential role required by
#371, the repository Actions policy required by #373, plus owner/legal copy and
visual approval.
`store:validate -- --publish` must fail before credentials or network access
while that review is incomplete.

The English copy and category/rating choices are proposals, not assertions
about live store state or completed legal/store review. Their manifest statuses
must become `approved` in the same reviewed change that makes the catalog
publication-ready. The validator applies both provider character limits and
bounded UTF-8 byte limits. On 2026-08-19 the declared marketing, support, and
privacy URLs each resolved directly over HTTPS with status 200; that reachability
check does not constitute legal approval of their content.

The selected final capture contract is exact:

- Apple iPhone 6.9-inch portrait: 1320 × 2868, uploaded through the current
  `APP_IPHONE_67` API slot.
- Apple iPad 13-inch portrait: 2064 × 2752,
  `APP_IPAD_PRO_3GEN_129`.
- Play phone portrait: 1080 × 1920.
- Play 7-inch tablet portrait: 1200 × 1920.
- Play 10-inch tablet portrait: 1600 × 2560.

Each captured set carries four actual mounted production screens (#956):

1. `/`: the signed-out vault home, with zero balances and wallet destinations;
2. `/wallet/send`: the blank Send form with its review action disabled;
3. `/wallet/history`: the real empty transaction-history state; and
4. `/about`: product/build information and the blank feedback composer.

Receive is deliberately excluded: its useful settled state displays a payable
address and a QR code. The wallet-specific Overview also requires an address.
About replaces Receive without inventing a payment destination. No wallet is
created, restored, unlocked or funded; no payment is proposed or broadcast.
These are Linux Chromium fixture renders, **not physical-device, native-engine,
connected-chain, signed-artifact or successful-payment evidence**. Home's zero
readouts are public synthetic inputs, not observed balances on a real account.

Every file must be opaque, exact-size, individually SHA-256 pinned, unique across
the complete catalog, and tied to an exact product-source SHA and review issue.
The unchanged production Vite renderer is built with all `VITE_*` overrides
removed. Local Vite/npm overrides are refused. `scripts/store-vault-fixture.mjs`
is a capture-only Playwright initializer, absent from the shipping import graph;
there is no app capture mode or extra native capability. Its JSON snapshot is
an exact audited constant (`vault-empty-v1`), with a coherent synthetic wallet
inventory, zero balances, no history, no account session and no completed sync.
The native bridge can return only these reads and a desktop callback-transport
classification. It acknowledges only a null session publication. Automatic
`start_sync` is explicitly refused, never reported successful. Seed, backup,
restore, signing, send, credentials, account changes and every unknown command
or argument are refused and fail capture. No native host is connected.

Bootstrap requires an address string even on routes that never display it.
The only supplied value is the invalid, nonpayable constant
`PUBLIC-SYNTHETIC-NONPAYABLE`; capture fails if it appears in rendered text.
No production component is replaced or edited. Network access is restricted to
GETs for the selected local route and built static assets (including Vite's
exact WASM `?init` query); API calls, writes, remote requests, service workers
and WebSockets are refused. Capture also rejects runtime errors, frames,
horizontal overflow, clipped focus content, nonempty Send fields, payable Send
review, private/address-like text and mock/debug disclosures. The sole email exception
is About's exact, source-authored public support contact `help@free2z.com`;
negative controls reject tester identities, lookalikes and suffixed domains.

The editorial fixture remains solely for Free2Z's own captures. Because its
catalog and E2E2Z's catalog bind shared tooling bytes, #956 refreshes their
six-image matrices with fresh two-pass evidence as well. Their app code and
listing approval are unchanged; historical evidence is not relabelled current.

The rendering environment is immutable:
`ghcr.io/free2z/zuuli-store-capture@sha256:13c508c86e0a458c180059dbb6fa6e45406fcd01e24f5416de7c78acf8b57be9`
on `linux/amd64`, Playwright/Chromium 1.62.1, UTC, a fixed clock, dark mode,
and declared safe-area insets. The combined image retains the original pinned
Playwright base and supplies Rust 1.97.1/WASM. Its provenance was verified
against `free2z/zuu` and its inventory is verified on each invocation; see
[the image record](../../../docs/zuuli/build/ZUULI-STORE-CAPTURE-IMAGE.md). It performs two clean passes and refuses to
write unless every pixel and rendered-text digest matches. Input digests bracket
config parsing, build, both passes, and replacement so concurrent drift aborts
rather than mislabeling pixels. The record carries
both a full source digest and a separately revalidated capture-contract digest.
The default PR `store:validate` permits an older, unapproved candidate to remain tied to
its exact source SHA as product work continues; publication validation and
the `--current-source` validation and reproducibility commands below require
current source to reproduce it exactly. `--current-source` invokes the same
`enforceCurrentSource` provenance check required by `--publish`, while keeping
`publicationReady: false`. It does not approve copy/media or access a store.
`--publish` additionally requires owner approval and intentionally still fails.
The contract tests also complete the full local publish check using a temporary
synthetic approval manifest against the real current source and PNGs. That
positive control never modifies the actual manifest or grants listing approval.

The current `sourceSha` is `b4e3d79334b6ee56f0796776db6251e821d5dd4a`:
all renderer/build inputs match that commit. Capture-tool changes are bound by
`contractDigest` and the combined `sourceDigest`; this does not claim the new
capture tooling existed in the historical product-source commit. `STATUS.md`
remains its dated distribution audit, which predates these local candidates.
No current authenticated store readback was performed for #956; live store
screenshots, publication, signed artifacts and device behavior remain unverified.

PNG textual chunks are also scanned for forbidden seed/private/debug markers.
Human-readable pixel review across all 20 images remains mandatory because no
automated raster check can prove that every visible claim is accurate or that
no personal data appears.

Run the local contract checks with:

```bash
npm run store:validate
npm run test:store-listing
npm run store:validate -- --current-source # all three catalogs; publish provenance, no approval
node scripts/store-screenshot-capture.mjs --verify-reproducible # Docker; two passes
npm run store:validate -- --publish  # intentionally fails during Phase B
```

`node scripts/store-screenshot-capture.mjs --write` rewrites candidates,
manifest hashes, and the capture
record only after the same two-pass proof. Review the resulting images at
readable scale before committing. Neither capture command contacts a store,
loads credentials, changes testers, or uploads media.

Authenticated store audit and publication use protected workflows documented in
`docs/releasing.md`. They never build the app or load signing credentials.
Publication remains internal-only: it never submits an App Store version for
review, changes a Play track, or changes tester eligibility.

Primary specifications:

- Apple screenshot sizes: https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications
- Apple App Store Connect API: https://developer.apple.com/documentation/appstoreconnectapi
- Play listing API: https://developers.google.com/android-publisher/api-ref/rest/v3/edits.listings
- Play images API: https://developers.google.com/android-publisher/api-ref/rest/v3/edits.images
- Play graphic assets: https://support.google.com/googleplay/android-developer/answer/9866151

Google Play internal testing remains in owner-selected Console email-list mode
(#296). Publisher API audit may truthfully report that mode, but this store
pipeline never reads tester identities, migrates the track to Google Groups, or
claims that API automation manages email-list eligibility.
