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

E2E2Z simulates the production stopped, unenrolled engine contract. The
`not-enrolled` refusal and `e2e2z_enrollment_status` response shapes are also
exercised by its enrollment-gap regression test. This is a simulation of the
native unenrolled contract, not a running
messaging transport. The allowed calls are exactly the ones a packaged e2e2z
issues before its first screen settles: engine status, device info, this
device's own seed-free enrollment read, the deep-link launch URL (which is
`null`, because no link launched this run) and event subscription. Every other
command is refused, and the runner fails on any call outside that list. No
credential, identity, handle or conversation is invented. Its views show the
complete enrollment-unavailable notice and empty, locally stored diagnostics.
This is the desktop/browser state: the production mobile app now implements
enrollment through ZUULI. These images do not prove mobile enrollment or a
working conversation. The bundled disposable directory has zero independent
witnesses (`internal-directory.conf` and `BundledDirectory::independent_witnesses`);
the fixture reports zero, no connections and an unmet witness threshold.

## Reproduce

From `wallet/zuuli`, install the locked tooling dependencies with `npm ci`.
Docker must support the pinned Linux/amd64 Playwright image. Then run:

```bash
node scripts/surface-store-capture.mjs free2z --verify-reproducible
node scripts/surface-store-capture.mjs e2e2z --verify-reproducible
npm run store:validate
npm run test:store-listing
node scripts/surface-store-catalogs.mjs --current-source
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
E2E2Z's source inventory includes the bundled directory configuration, plugin
build script/manifests and app identity configuration, so changing the relay or
witness posture cannot silently preserve current-source evidence.

The default catalog tests/validation accept historical source evidence so
ordinary product development does not require store recaptures. They do not
prove that the images represent current code. Use `--current-source` when
reviewing a listing: it checks the saved source digest against current inputs,
checks those inputs against the named commit, and refuses local build overrides.
It fails on stale app, shared-package or native-configuration inputs. This
check validates provenance without launching a browser; the two-pass commands
above additionally prove the current render's reproducibility.

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

For #989, #992/#995 supplied the catalogs/media and #1035's startup-command
repair is already merged. Both apps have now been recaptured from
`b4e3d79334b6ee56f0796776db6251e821d5dd4a`, using the current production routes
and the strict native-command allowlist. The existing four brand PNGs meet the
geometry/hash contract and were reused. E2E2Z's proposed copy now describes the
implemented mobile enrollment path and disposable directory instead of claiming
that transport is absent everywhere.

No connected Play Console/App Store access was available for this reconciliation.
The repository's [2026-09-07 console record](PLAY-STORE-SETUP.md) records contact
details and says listing text was saved, but does not contain the exact saved
descriptions or establish today's publication state. The proposed descriptions
are therefore not attributed to console copy, and actual publication remains
unverified. Keep `publicationReady: false` pending console reconciliation and
owner review; neither a green validator nor these renders authorizes a store
upload or release.
