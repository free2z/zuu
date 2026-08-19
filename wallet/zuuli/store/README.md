# ZUULI store source of truth

`manifest.json` and `locales/` are the canonical, locale-ready source for App
Store Connect and Google Play presentation. The app and package identifiers are
fixed; each locale maps explicitly to Apple and Play locale codes so adding a
translation never relies on filename inference.

Phase A is deliberately `publicationReady: false`. The reviewed icons and Play
feature graphic from the canonical brand generator are present and hash-pinned,
but final screenshots remain deferred until #267, #1257, and #255 land. A
publish validation must fail before credentials or network access while any
screenshot set is incomplete.

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

Each finished set carries four to eight/ten PNGs as constrained by the manifest.
Every file must be opaque, exact-size, individually SHA-256 pinned, unique across
the complete catalog, and tied to an exact capture source SHA and review issue
under the capture policy. The validator
also scans PNG textual chunks for forbidden seed/private/debug markers. Pixel
review remains mandatory because automated checks cannot prove that rasterized
UI contains no personal data.

Run the local contract checks with:

```bash
npm run store:validate
npm run store:validate -- --publish  # intentionally fails during Phase A
npm run test:store-listing
```

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
