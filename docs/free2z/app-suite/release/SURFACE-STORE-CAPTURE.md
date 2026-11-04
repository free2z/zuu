# Free2Z and E2E2Z store screenshot evidence

These are **draft browser renders**, not physical Android device screenshots.
The pinned Linux/amd64 Chromium runtime renders the production frontend bundle
at Play phone and tablet pixel dimensions. `runtimeEvidence` in each capture
record and manifest makes that distinction explicit. Neither publication
approval nor native-device validation is implied; `publicationReady` stays
false. The E2E2Z diagnostics view reports its actual Linux browser environment.

Free2Z uses the existing fictional editorial collection and exact public
request allowlist from the ZUULI capture pipeline. A fresh signed-out context
receives only those public fixture responses. Real accounts, authenticated API
requests, third-party requests and WebSockets are excluded. The screenshots
show the article feed and article reader, including the actual navigation.

E2E2Z receives the same stopped-engine and `not-enrolled` responses exercised
by its enrollment-gap regression test. This is a simulation of the native
unenrolled contract, not a running messaging transport. Only engine status,
device-info and event subscription calls are allowed. No enrollment command,
credential, identity or conversation is invented. Its views show the complete
enrollment-unavailable notice and empty, locally stored diagnostics.

## Reproduce

From `wallet/zuuli`, install the locked tooling dependencies with `npm ci`.
Docker must support the pinned Linux/amd64 Playwright image. Then run:

```bash
node scripts/surface-store-capture.mjs free2z --verify-reproducible
node scripts/surface-store-capture.mjs e2e2z --verify-reproducible
npm run store:validate
npm run test:store-listing
```

The source commit named in each `store/capture.json` must be available locally;
fetch that commit from `origin` if a shallow checkout omitted it. The capture
refuses when app production inputs or the shared package differ from that
commit. To refresh after a source change, commit that source first, update the
config's `sourceSha` to that exact commit, and use `--write` in place of
`--verify-reproducible`. Review the new images and diffs before committing them.

The container mounts the wallet directory so the local shared package is
available, and installs the app and capture tooling with separate temporary
`node_modules` volumes. Local Vite/npm override files are refused. App inputs,
`wallet/shared` and the E2E2Z native refusal implementation contribute to the
source digest. Tooling, lockfiles, configuration and fixtures contribute to the
contract digest. Input digests are checked before and after building/capturing.

Each run renders two passes using fresh browser contexts, fixed time, locale,
fonts and safe areas. Both screenshot bytes and rendered-text hashes must
match. The record requires the complete six-image matrix per app, distinct
pixels, exact geometry and two matching pass digests. Catalog validation
checks PNG hashes, RGB encoding, byte limits, embedded text markers and
undeclared files. The runner additionally rejects unexpected requests/native
calls, errors, horizontal overflow, overlapping navigation labels and clipped
focal content. These checks do not replace visual review.

The legacy ZUULI capture scripts remain byte-identical because their hashes are
part of its historical screenshot provenance. The new runner reuses their
exported input walker, canonical JSON reader, environment guard, public request
allowlist, fixture validation and feed-scroll calculation, together with the
shared store PNG/metadata checks. Its app-specific record validator follows the
same closed matrix contract and additionally records both pass digests and the
shared package inputs.

## Still required before publication

The English listing copy remains proposed and must be reconciled with the text
saved in Play Console. The existing plain-tile brand derivatives and all
screenshots require owner review. Console declarations and native-device
release testing remain separate. No capture command uploads media, creates a
release or changes the submitted IARC questionnaire.
