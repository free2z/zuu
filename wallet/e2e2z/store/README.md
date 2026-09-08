# E2E2Z draft Play catalog

This catalog is a **draft**, not an upload authorization. `publicationReady`
remains false and the validator refuses `--publish`.

The English copy is proposed from the current public app, **not retrieved from
Play Console**. Reconcile it with the saved console listing before review.
The contact URLs follow the existing ZUULI catalog.

The brand PNGs are deterministic derivatives of this app's tracked
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

The six screenshots show two views at each Play phone/tablet geometry. They
are draft production-frontend renders in pinned Linux Chromium with public
fixtures (Free2Z) or the simulated native unenrolled contract (E2E2Z), not
physical Android device evidence. No account, credential or conversation is
invented. `capture.json` names the reviewed plan/source; `capture-record.json`
pins the six PNGs, source and tooling digests, and two identical capture passes.

See [capture evidence and reproduction](../../../docs/release/SURFACE-STORE-CAPTURE.md).
The validator decodes the saved screenshot bytes and checks dimensions, RGB,
size, hash, embedded text and the complete record/manifest matrix. Undeclared
PNGs and publication approval are rejected.

Remaining work in #989: reconcile proposed copy with the saved console text,
and obtain copy, brand and screenshot owner review. Native-device release
validation and console declarations remain separate. No command uploads
media, completes a Play listing or alters the submitted IARC questionnaire.
