# Free2Z Play catalog foundation

This catalog is a **draft**, not an upload authorization. `publicationReady`
remains false and the validator refuses `--publish`.

The English copy is proposed from the current public app, **not retrieved from
Play Console**. Reconcile it with the saved console listing before review.
The contact URLs follow the existing ZUULI catalog.

The PNGs are deterministic derivatives of this app's tracked
`src-tauri/icons/icon.png`. That source is currently a plain colored tile;
the icon and feature graphic still need brand review. No new mark or font is
invented by the generator. The feature graphic is a centered existing tile
on its existing dark background.

From `wallet/zuuli`, with `npm ci` installed:

```bash
npm run store:surfaces:generate
npm run store:validate
npm run test:store-listing
```

The generator updates the media SHA-256 pins. Validation regenerates the PNGs
in memory to detect drift in either source or output, and applies the shared
PNG decode, geometry, RGB, byte-limit, hash and embedded-text checks.

Remaining work in #989:

- Reconcile proposed copy with the saved console text and obtain copy/brand review.
- Extend the deterministic capture pipeline with app-specific routes and public
  request allowlists, two-pass equality, source/contract digests and PNG scans.
- Capture at least two honest views per Play geometry, then replace the empty
  screenshot sets with reviewed, hash-pinned capture records. Free2Z must show
  only public content; E2E2Z must show its real enrollment-unavailable state
  and must not depict a working conversation.

No screenshots are claimed or fabricated in this foundation. It does not
complete a Play listing or alter the submitted IARC questionnaire.
