# Free2Z UI localization

Status: proposed. Product UI language and creator content language are separate choices; the existing content routes reserve `lang` for the latter. The current synchronous translator imports all four catalogs, interpolates simple placeholders, and uses request-scoped AsyncLocalStorage for server reads. Its public `t`, `translate`, and store APIs have many callers; replacing them requires a compatibility migration, not just a loader swap.

Use FormatJS `intl-messageformat` for ICU MessageFormat with CLDR cardinal, ordinal, and select support. Its ICU apostrophe and brace rules differ from the legacy interpolator, so keys opt in explicitly through `ICU_MESSAGE_KEYS` after every catalog pattern is checked; existing keys and fallback text keep their legacy semantics. The adapter returns plain text and disables rich-text tag parsing. Invalid ICU patterns and missing arguments are reported and return the original pattern rather than silently substituting another translation. The Free2Z UI maintainers own the legacy call census in `tests/i18n-call-baseline.json`: entries identify a path, call name, kind and normalized call fingerprint. The AST census rejects new unknown literal and dynamic calls and requires stale entries to be removed. The older missing-key baseline remains independently enforced. The census resolves direct imports, simple local aliases, explicitly typed `TranslationFunction` bindings, and translator names destructured directly from context. Translator uses outside direct calls and re-exports are held in a separate path-and-context fingerprint baseline, owned by the Free2Z UI maintainers; each removal must shrink it. These entries record legacy escape boundaries, not finite key domains or translation approval. This is a syntactic boundary, not a proof of arbitrary JavaScript dataflow: an escape must be classified before new downstream flows can be trusted. Keep an English core and load the selected catalog as a content-hashed chunk before rendering or committing a switch. Preserve the previous language on load failure and provide an accessible retry. The server must load within the request scope and serialize its choice for hydration. A regional fallback must never map Portugal Portuguese to Brazilian Portuguese. Existing shipped catalogs are not evidence of human review.

Negotiate URL UI override (except content-language routes), account preference, cookie, ordered browser preferences, then English. Account preference requires an authenticated source and must not be inferred from another user's state. Personalized HTML and page data require private caching. Document language follows the content language where applicable; direction and mixed-direction isolation need explicit treatment.

Migrate in stages: establish a registry and negotiation; integrate ICU and asynchronous catalog loading while retaining synchronous calls after loading; migrate formatting and layout; introduce pseudo-locales and isolation, recovery, and hydration tests; pilot difficult languages before expanding. Catalog parity alone is not translation review. Track source changes and ownership, provenance and human approval, with mandatory human review for authentication, payments, privacy, and destructive actions. Machine drafts remain drafts.

The four source JSON catalogs total 818,327 bytes uncompressed (en 187,970; es 207,398; fr 217,323; pt-BR 205,636), measured at base 14edafea. This is source size, not transferred bundle size. Initial-load, switch and SSR latency budgets still need reproducible measurements on a defined CI runner and enforced thresholds; these numbers must not be represented as those budgets. The existing static imports mean adding catalogs currently increases the client payload.

Malformed opted-in patterns are logged and resolution continues to the English source, then to the caller’s legacy fallback. This is runtime recovery, not evidence that the failed translation is reviewed or complete.

The editor category-label wrapper has a finite domain: `CATEGORY_LABELS` supplies every suffix, and `tests/i18n-category-domain.test.mjs` requires each resulting key in all four catalogs. Unknown creator categories remain unchanged. This check does not classify the other translator escapes.

The runtime now prepares English and the selected dictionary before SSR and serializes those two dictionaries in layout data for hydration. Subsequent selections load a catalog on demand before changing the store or persistence. The server caches dictionary data while request locale selection stays in AsyncLocalStorage. The server negotiates URL (except content-language routes), cookie, weighted Accept-Language, then English. There is no authenticated account locale contract in the current server load. A local-storage-only legacy preference is migrated after hydration. HTML and page data are private.

The selection sequence prevents an older catalog load from committing after a newer selection. A production browser test delays and reorders hashed imports, and aborts a catalog import. The tested Chromium build retried a failed fetch when the user selected the language a second time; other failures may remain cached in a page, so the localized retry button sets a short-lived pending locale cookie and reloads; the server loads the catalog before committing the normal locale cookie. The asset-recovery hook allows the language selector to handle an in-flight catalog preload failure. The English and selected dictionaries in the serialized HTML also require a measured payload budget.

A local production build emitted uncompressed JavaScript locale chunks of 161,711 bytes (English), 181,150 (Spanish), 191,372 (French), and 179,396 (Brazilian Portuguese). These are chunk sizes, not a measured initial transfer or an enforced budget. The active and English dictionaries are additionally serialized into the HTML, so the initial payload must be measured before setting a budget.

In a local production browser run against `/trending`, English HTML was 206,301 bytes uncompressed and 59,330 bytes gzipped; French was 393,112 and 114,839 bytes. These are measurements of the response body and gzip of that body, not a network budget. Initial browser navigations made zero separate application catalog-chunk requests because the active and English dictionaries were serialized. Traversal of static imports from all 41 client manifest entries reached none of the four application catalog entries. This does not measure every client asset or establish a performance budget.

The reproducible growth proof is `node scripts/check-locale-growth.mjs` from `ts/svelte/free2z`. On 2026-11-05 it built the original app, added a disabled `zz-ZZ` registry and loader entry plus a 1,200,032-character synthetic catalog, rebuilt, and then built an eager-import negative control. The synthetic locale was rejected by negotiation. In both normal builds, the transitive static client graph contained no application catalog entry; browser navigation requested no synthetic catalog and neither the sentinel nor representative unselected catalog strings appeared in the HTML or initial immutable assets.

| Locale  | Baseline HTML raw / gzip | With fixture HTML raw / gzip | Baseline immutable assets raw / gzip | With fixture immutable assets raw / gzip |
| ------- | -----------------------: | ---------------------------: | -----------------------------------: | ---------------------------------------: |
| English |         206,301 / 59,340 |             206,301 / 59,330 |                  2,532,829 / 783,959 |                      2,533,105 / 784,018 |
| French  |        393,112 / 114,845 |            393,112 / 114,836 |                  2,532,829 / 783,959 |                      2,533,105 / 784,018 |

The script sums response bodies for initial same-origin immutable assets and gzips each body separately; HTML gzip is computed locally, so these are reproducible estimates rather than negotiated wire transfer. It sums assets independently of content-hashed filenames; HTML hashes remain fixed-width, and a 4,096-byte maximum growth per raw or gzip measurement allows ordinary hash/compression variation while remaining below 0.4% of the fixture size. Observed asset growth was 276 raw and 59 gzip bytes. The eager control delivered the sentinel and raised asset bytes to 3,733,302 raw / 1,434,632 gzip, so the proof rejected it. The fixture and source mutations were restored before rebuilding the original app. This is a growth check, not a latency or initial-load performance budget.

Pseudo catalogs are available only when the explicit `FREE2Z_PSEUDO_TEST=1` build flag is set. The registry labels them test-only and excludes them from the product language selector. They are generated from English catalog strings before interpolation: placeholders, braced ICU constructs, and the listed product brands remain intact, while creator-authored values are never transformed. Expansion, accented Latin and RTL-script variants use English formatting data. The document base direction follows the UI locale; article content keeps its independently declared direction even when the document language names that content.

The required Free2Z web CI browser shard builds production and runs `node scripts/check-locale-budgets.mjs` followed by the production locale browser spec. The script limits compact JSON for each catalog to approximately 10% above the 2026-11-05 baseline, separately in raw and locally gzipped bytes: en 181,000/55,000, es 202,000/60,000, fr 213,000/62,000, and pt-BR 200,000/59,000. Active-plus-English compact JSON has separate caps: en 181,000/55,000, es 383,000/114,000, fr 394,000/116,000, and pt-BR 381,000/113,000. Current en and fr pairs are 164,082/49,324 and 357,530/104,931 bytes. The compact pairs estimate dictionary contribution; they are not the exact SvelteKit wire encoding.

The production browser gate limits `/trending` HTML to 230,000/68,000 bytes for en and 435,000/128,000 for fr, and initial immutable assets to 2,800,000/865,000, raw/locally gzipped. These are total page/asset limits, separate from the dictionary limits. It traverses static client imports, rejects catalog entries in that graph, and checks initial catalog network requests. On this runner HTML measured 206,304/59,349 en and 393,115/114,855 fr; the growth proof measured 2,534,811/784,450 initial asset bytes. Gzip here is recomputed locally, not a measured HTTP transfer.

The timing gate is a regression smoke test, not an SLA: the cold switch must complete within 2,500 ms after subtracting a deliberately injected 150 ms catalog response delay, the cached switch within 1,500 ms, and p95 across 12 concurrent en/fr SSR requests within 2,000 ms. One local run measured 534.5 ms, 560.8 ms, and 137 ms respectively. These elapsed times include scheduling, rendering and remaining local network work; subtracting the controlled delay does not isolate CPU. The limits leave headroom for shared runners while the byte and graph checks give more deterministic evidence. Negative controls exercise oversized data, eager imports and exceeded timing limits. `scripts/check-locale-growth.mjs` is the separate multi-build unused-locale/eager-import control, run deliberately rather than on every test; its current rerun showed 244 raw / 35 gzip bytes of index growth and rejected the eager sentinel.

HTML and page data are `private, no-cache` and vary on Cookie and Accept-Language; version metadata remains no-store. Production tests interleave locale cookies with and without the fixture session and check that an anonymous billing response does not contain the authenticated billing surface. These checks do not establish a CDN configuration outside this application.

### Translation operations and availability

A catalog entry is **present** when it has a nonempty value; presence is not
translation quality, freshness, or review. English is the source language.
Spanish, French and Brazilian Portuguese remain available as **beta** with no
recorded human reviews. `tests/catalog-review-metadata.json` is the per-message
ledger; absent records are unverified. Current source and translation SHA-256
hashes bind a review to exact text. Only a current record with a named human
reviewer, UTC review time and provenance is counted as reviewed. This is an
accountable record, not cryptographic proof of a person's identity; the Free2Z
localization owner must authenticate reviewers and retain review evidence.
Never mark machine output or English fallback as reviewed. Stable promotion
requires every message reviewed and no unresolved identical-text baseline. An identical entry may be approved
only with an explicit brand, code or acronym category, a named reviewer, UTC
review timestamp and reason, alongside current per-message review metadata.
This includes auth, payment, privacy and destructive copy; a machine draft alone
is never approval. The baseline's 160 English-identical messages are unresolved,
not approved brand exceptions, and must be translated or individually justified
by the localization owner before promotion.

Run `node scripts/catalog-governance.mjs` to validate and report presence,
review coverage and queue size. `node scripts/catalog-governance.mjs export >
work.json` exports the deterministic source-hash work queue. Add a pilot code,
for example `export ar`, to produce a source-only pilot worklist; these entries
contain no translations. `pilot-import ar work.json > ar-draft.json` validates
a partial pilot batch and emits a separate reviewable draft with provenance; it
does not register or ship the locale. A shipping catalog requires deliberate
registration and a missing-message policy. Import a JSON
array with `node scripts/catalog-governance.mjs import work.json`; each row has
`locale`, `key`, current `sourceHash`, `translation`, and `metadata` containing
`status` (`draft` or `reviewed`) and `provenance`. A reviewed row additionally
requires `reviewType: "human"`, a named `reviewer` and `reviewedAt` UTC timestamp.
Export rows are a work list and must be edited to add metadata before import;
review claims must reflect actual external review. Imports reject stale source,
unknown keys, invalid ICU, placeholder mismatch, and newly identical English.
Source changes invalidate matching reviews and generate stale queue items without
editing every translated catalog. The CI unit suite runs the validation and
mutation controls. Existing legacy interpolation retains its original syntax;
ICU parsing applies only to keys explicitly migrated to ICU.

Localization ownership: Free2Z product localization owns keys, translation
context, glossary, provenance, approvals and the unresolved baseline. Use stable
feature-scoped dotted keys, describe action/context and placeholders in the
work item, preserve placeholders, product names and identifiers, and use
locale-appropriate tone without changing meaning or financial units. Reviewers
must independently review authentication, payment, privacy and destructive
copy in context before approving it. User-authored content is out of scope.

`PRIVATE_DISABLED_UI_LOCALES` is a comma-separated deployment environment list
(e.g. `fr,pt-BR`), read by the Node server without rebuilding. Redeploy or
restart with the new environment and reload clients to apply it. English may be disabled as a selectable UI locale; its source catalog remains
internal fallback data. If every production UI locale is disabled the server
returns 503 with `no-store`. Disabled tags are ignored in URL,
cookie, retry and Accept-Language negotiation and omitted from the selector;
the next enabled preference or first enabled registry locale wins. HTML remains private and varies
by cookie and Accept-Language. This is deployment configuration, not an account
preference or a translation approval. The selector labels the three current
translations beta; test pseudo locales remain test-only.

The following candidate matrix is a planning queue, not a claim that catalogs
or reviewers exist. Pilot first: **ar** (RTL and plural categories), **pl**
(Slavic plurals), **ja** (CJK), **hi** (Indic), **de** (compound expansion).
The remaining candidates, in alphabetical groups, are af, am, az, be, bg, bn,
bs, ca, cs, cy, da, el, et, eu, fa, fi, fil, gu, he, hr, hu, hy, id, is, it,
ka, kk, km, kn, ko, lo, lt, lv, mk, ml, mn, mr, ms, my, nb, ne, nl, pa, ro,
ru, si, sk, sl, sq, sr, sv, sw, ta, te, th, tr, uk, ur, uz, vi, zh-Hans and
zh-Hant. None is currently available or reviewed. Prioritization beyond the
pilot requires actual translator/reviewer capacity, glossary, regional demand,
and sensitive-copy approval; no machine-generated catalog is represented as
production-ready.

### Difficult-language draft pilot

Arabic, Polish, Japanese, Hindi and German have **37 unreviewed local-model
translations each**, with 2,955 English source fallbacks each. They are partial
review material, not approved translations or selectable production languages.
`FREE2Z_PILOT_TEST=1` enables the five registry entries and lazy loaders only
when running the development server for tests; builds exclude them even when
the flag is set. The
English fallback is retained, and account-authentication, billing, privacy and
irreversible-action drafts are never represented as approved.

The review pack is `tests/pilot/drafts.json`, the five source/translation-hash
metadata files alongside it, and the corresponding
`src/lib/locales/pilot/*.json` catalogs. Each record says “Local model-produced
draft; human review pending”. The original batch was passed through the
`importPilot` validator used by `pilot-import`; `node
scripts/check-pilot-drafts.mjs` revalidates each recorded source hash, value,
placeholder contract, provenance and catalog against that import path. It does
not rewrite freshness when source text changes. `node
scripts/pilot-work-queue.mjs > pilot-queue.json` produces a deterministic
per-locale, per-key queue: 37 draft and 2,955 missing per locale at this commit.
A conservative key-name classification marks 24 drafted and 687 missing messages
per locale as sensitive; this classification is a review aid, not a guarantee
that remaining copy is non-sensitive. Reviewers must check every message in
context. No reviewed entries are claimed.

Before a pilot can be offered to real users, its owner must obtain native-language
review and attributable human review evidence, especially for authentication,
payment, privacy and destructive actions; resolve identical-text exceptions;
complete and revalidate catalogs and source hashes; assess the English fallback
policy in context; and explicitly promote its registry state. The test-only ICU
fixture exercises locale plural, select and ordinal behavior but is not a shipped
product message or additional catalog coverage. Production readiness for more
than 50 locales additionally requires actual translation and review capacity,
regional language decisions and sustained ownership for each locale.

### Exact amounts on browser floors

[MDN browser compatibility data](https://github.com/mdn/browser-compat-data/blob/main/javascript/builtins/Intl/NumberFormat.json) records exact decimal-string formatting from Chrome 106 and Safari/iOS 15.4; the supported floors are Chrome 111 and Safari/iOS 16.4. This is compatibility evidence, not a test on those exact engines. When a runtime fails the exactness probe, the fixed-point fallback uses BigInt and locale number parts with half-expand rounding for ordinary decimal and currency options. Unsupported advanced notation or rounding returns a localized unavailable message rather than losing precision. Numeric major-unit inputs continue through native formatting. A browser test simulates the old coercing implementation and exercises the actual currency and asset callers.

### Navigation, RTK resources and cache restrictions

The root server load declares its `lang` dependency so client-side query
navigation obtains the newly negotiated request locale. The browser reconciles
that layout data once per navigation; a switch started after navigation owns
the locale unless the newly received policy disables it. The content-language
routes continue to keep content and UI language separate. The response hook
adds private revalidation while retaining stricter origin directives, including
`no-store`, and removing shared-cache directives.

The registry owns the lazy application and RealtimeKit loader for each shipped
locale. The active RTK dictionary is prepared before committing a locale and
serialized with the active application dictionary; its English fallback is the
library's default. A failed RTK chunk leaves the old locale active and uses the
same localized reload recovery. The resource census rejects missing, mismatched
and orphan shipped loaders/catalogs; pilot and pseudo catalogs remain test-only.
The static graph budget covers route chunks and RTK packs as well as entry chunks.

On this build, compact RTK JSON measures es 26,947 raw/6,746 gzip, fr
28,389/7,023, and pt-BR 26,555/6,714. English fallback plus active application
and RTK dictionaries measures es 374,753/109,344, fr 386,116/111,480 and pt-BR
372,600/108,620 bytes. The corresponding structural byte gates allow roughly
10% growth. In the production browser sample, en HTML was 206,441/59,404 and
fr HTML was 421,445/121,556 raw/local-gzip bytes; existing HTML limits remain
unchanged. These local gzip measurements are not wire-transfer measurements.

The disposable growth check now adds both a 1.2 MB application dictionary and
an equally large RTK pack under one disabled registry entry. On this run en/fr
HTML raw bytes were unchanged; their local gzip changed by -3/-4 bytes. The
initial asset aggregate grew 310 raw and 44 local-gzip bytes in both cases,
within the unchanged 4,096-byte index allowance. Neither synthetic chunk was
requested or serialized. A deliberate eager import exposed its sentinel and
failed the safety assertion; the script restored both inputs and rebuilt.

### Browser-test SSR isolation

The browser test server uses a process-owned generated SvelteKit directory and
disables file-watch invalidation for the duration of that test server. This
prevents production-tree regeneration and editor writes from causing watcher-
driven invalidation of the test server's module graph during a cold request;
source files are still expected to remain fixed during the rest of a run. The IPC-controlled regression pauses
server-side initialization of `query-client.ts`, modifies and restores the i18n
source, runs production-tree `svelte-kit sync`, and then verifies Arabic SSR and
cleanup. A negative control with shared generated output and the old watcher
observed the source invalidation and failed the isolation assertion. It still
returned HTTP 200: it did **not** reproduce the earlier first-request 500, so
that failure's precise cause remains unconfirmed. The retained first-failure
trace shows a 500 before the login form assertion, and the recorded server error
reported Svelte server context unavailable; it was not merely a slow form.
