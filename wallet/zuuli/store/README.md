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

Each captured set carries four PNGs as constrained by the manifest:

1. the public Articles feed;
2. three public semantic-search results for `privacy`;
3. a full public article reader; and
4. a public creator profile and its published content, using one explicitly
   fictional, non-live, non-paid editorial identity.

The creator-profile and semantic-search candidates are captured only after the
responsive profile fix in #432 and the single-clear-control fix in #254. The
capture pipeline does not hide product defects with screenshot-only CSS; both
surfaces must pass the same geometry and readable-scale visual review as every
other candidate.

Every file must be opaque, exact-size, individually SHA-256 pinned, unique across
the complete catalog, and tied to an exact capture source SHA and review issue
under the capture policy. The actual production Vite bundle is rendered with
all `VITE_*` overrides removed, and capture refuses local Vite environment
files that production mode would load; this is not application mock mode. A narrow
network allowlist supplies exact public zpage/comment/creator response schemas
from the locale fixture and rejects every other external request. The harness
also rejects loading states, horizontal overflow, private/email-like text, and
mock/debug disclosure.

The rendering environment is immutable:
`mcr.microsoft.com/playwright@sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac`
on `linux/amd64`, Playwright/Chromium 1.62.1, UTC, a fixed clock, dark mode,
and declared safe-area insets. It performs two clean passes and refuses to
write unless every pixel and rendered-text digest matches. Input digests bracket
config parsing, build, both passes, and replacement so concurrent drift aborts
rather than mislabeling pixels. The record carries
both a full source digest and a separately revalidated capture-contract digest.
Ordinary validation permits an older, unapproved candidate to remain tied to
its exact source SHA as product work continues; publication validation and
the reproducibility command below requires current source to reproduce it exactly.

PNG textual chunks are also scanned for forbidden seed/private/debug markers.
Human-readable pixel review across all 20 images remains mandatory because no
automated raster check can prove that every visible claim is accurate or that
no personal data appears.

Run the local contract checks with:

```bash
npm run store:validate
npm run test:store-listing
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
