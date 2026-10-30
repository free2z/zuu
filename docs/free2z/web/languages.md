# Free2Z content languages

Free2Z accepts article languages independently of the languages offered for AI
translation and the locales used for interface text. This guide explains how to
change the translation offering without losing names, pricing evidence or
capacity guarantees. Paths below are relative to the repository root.

The canonical registry is
[`py/free2z/f2z/languages.py`](../../../py/free2z/f2z/languages.py):

| Registry | Purpose |
| --- | --- |
| `DETECTABLE` | Membership validation for real content languages; deliberately not enumerable. It excludes unknown, multiple-language, nonlinguistic and private-use codes. |
| `TRANSLATABLE` | Curated AI translation targets. Use `translatable_choices()` for stable ordering. |
| `UI_LOCALES` | Interface locales: `en`, `es`, `fr`, `pt-BR`. Adding an article language does not add interface translations. |
| `ALSO_NAMED` | Additional accepted tags that need curated display names. |

Tags follow BCP 47: language, script and region are separate subtags. For
example, `zh-Hans` and `zh-Hant` distinguish scripts; `yue-Hant` names Cantonese
and must not collapse into `zh-Hant`. Bare `zh` is a valid content language but
is not an AI translation target. Changing normalization can change the identity
of stored variants; review existing data and any required migration separately.

## Add or remove a translation target

1. **Review admission.** Add a canonical tag to `TRANSLATABLE`, with a short
   explanation of its written standard and established publishing use. It must
   have a curated name in every UI locale and an autonym (its name in its own
   language). Check that `normalize(tag) == tag` and that storage limits fit it.
   Names alone do not establish translation quality.
2. **Add evidence.** Add a `LanguageEvidence` row in
   [`translation/evidence.py`](../../../py/free2z/dj/apps/g12f/translation/evidence.py).
   A measured sample is the complete Article 1 of the Universal Declaration of
   Human Rights in that language. Compare it with the published translation;
   missing clauses distort estimates in both translation directions. Record
   only the checks actually performed in `checked`.
3. **Regenerate names.** Run the generator below after changing `TRANSLATABLE`,
   `UI_LOCALES` or `ALSO_NAMED`. Commit the generated `f2z/language_names.py`.
   Review localized names and autonyms. The registry tests reject fallback to
   IANA registry descriptions for languages the product offers.
4. **Review the offline list.** Update `TRANSLATABLE_LANGUAGES` in
   [`zpage-language.js`](../../../ts/svelte/free2z/src/lib/zpage-language.js)
   when the offline offering should change. This is a fallback, not an exact
   mirror enforced by tests; its tags must be canonical and the list usable.
5. **Check fixtures.** Search for the new tag as a quoted string, including tests
   that use it as an example of a valid but unsold language. Replace that example
   if its premise has changed. Avoid searching only for an unquoted tag such as
   `is`, `it` or `no`, which also matches ordinary prose.
6. **Check the bounds and behavior.** Run the focused checks below. Review both
   translation storage caps, sitemap limits, per-model output ceilings and
   request/document time budgets. Adding a language must not advertise a target
   that cannot be quoted, completed or published.

To demote a language, remove it from `TRANSLATABLE` and review the fallback list.
Its evidence row can stay. Do not reject existing content in that language or
remove its stored variants merely because AI translation into it is unavailable.

The name generator uses CLDR, the Unicode Common Locale Data Repository, through
a separately installed, hash-locked developer dependency set. From the repository
root, choose an unused environment directory:

```sh
python3.12 -m venv /tmp/free2z-language-names
/tmp/free2z-language-names/bin/python -m pip install --require-hashes --only-binary=:all: \
  -r py/free2z/requirements/language-data.txt
/tmp/free2z-language-names/bin/python scripts/free2z/gen-language-names.py
git diff -- py/free2z/f2z/language_names.py
```

Keep these data-generation dependencies out of the backend runtime environment.

## Catalog and rendering behavior

[`GET /api/languages/`](../../../py/free2z/dj/apps/g12f/views/language_catalog.py)
provides the live translation offering and localized names. The
[`client`](../../../ts/svelte/free2z/src/lib/language-catalog.js) caches successful
responses per naming locale for five minutes. A failed or malformed response
uses the offline seed and is not cached as a success. A valid empty language
array means no AI targets are offered; the seed must not override it. Languages
already present on an article remain selectable even when they are not offered
for AI translation. `LanguageCatalog.fromApi` distinguishes an API answer from
fallback data.

Article language and interface locale are independent. Derive text direction
from the script, using explicit script subtags or CLDR likely-subtags; a fixed
language-to-direction table cannot distinguish `pa-Arab` from `pa-Guru`.
[`content-direction.js`](../../../ts/svelte/free2z/src/lib/content-direction.js)
and the catalog implementations must agree with their checked-in CLDR oracle.
[`text-direction.test.mjs`](../../../ts/svelte/free2z/tests/text-direction.test.mjs)
checks both missing and extra RTL scripts, including the explicit exceptions.

Apply direction and language-specific fonts to the content container, not the
interface. Regional Han glyph selection also depends on the font stack; a
`lang` attribute alone is not a guarantee. Preserve the `[data-content-lang]`
rules in [`globals.css`](../../../ts/svelte/free2z/src/styles/globals.css), and
use the article/editor direction browser tests for changes to rendered layout.

## Keep derived bounds consistent

[`test_language_derived_bounds.py`](../../../py/free2z/dj/apps/g12f/test_language_derived_bounds.py)
checks the relationships across Django and SvelteKit. Add new relationships there
when a limit depends on the registry size; a comment with arithmetic cannot
enforce them.

Let `L` be the number of translation targets, `P` the published-translation cap
per article, and `C` the number of articles per sitemap chunk. The source variant
is additional to the translation cap.

| Relationship | Source defaults |
| --- | --- |
| Published and draft caps must each be at least `L`. | `L = 79`; both caps are `96`. |
| Django's per-article sitemap variant bound is `P + 1` and must equal SvelteKit's bound. | `97` in both tiers. |
| `C × (P + 1) ≤ MAX_SITEMAP_ENTRIES`. | `500 × (96 + 1) ≤ 50,000`; with this chunk size, `P` cannot exceed `99`. |
| The query row budget must cover `2 × C × max(P, L)`. | `100,000 ≥ 96,000`. |

The source definitions are
[`serializers/zpage.py`](../../../py/free2z/dj/apps/g12f/serializers/zpage.py),
[`views/sitemap.py`](../../../py/free2z/dj/apps/g12f/views/sitemap.py) and
[`sitemap.ts`](../../../ts/svelte/free2z/src/lib/server/sitemap.ts). Read them
when changing the offering; the tests calculate from the registry rather than
trusting the example counts above.

The sitemap renderer also enforces a per-article URL budget. Raising `P` beyond
that budget can silently omit legitimate variants even if rendering succeeds.
Reduce `C` and re-derive all related bounds when the offering outgrows the
bracket, with a compatible protocol transition. `parseSitemapIndexPayload` rejects
an API response whose `chunk_size` differs from the reader's compiled constant;
changing only one side can make the sitemap index unavailable. Before changing
`C`, design compatibility handling and verify old/new Django and SvelteKit
combinations. Tests of matching constants in one checkout do not prove that
transition safe. Negotiated compatibility widths `32` and `65` are fixed
wire-contract values; do not recompute them from the current registry size.

The byte budget is separate: `MAX_SITEMAP_BYTES` is 50 MiB and each article gets
`floor(MAX_SITEMAP_BYTES / C / 2)` bytes. URL length varies with encoded usernames,
so a variant-count limit alone cannot bound bytes. The renderer drops the
quadratically growing alternate-language link cluster before truncating the
article's URL list.

Translation limits also depend on the language pair and model. In
[`translation/service.py`](../../../py/free2z/dj/apps/g12f/translation/service.py),
the request timeout is 180 seconds and the document timeout is 900 seconds.
Fragment planning uses an assumed minimum output rate of 40 tokens/second,
alongside setup and retry budgets. This is a planning assumption, not a measured
provider guarantee. The bounds tests require every offered language/model pair
to fit its output ceiling, stream the planned fragment within one request
window, and admit a standard-sized article within the document window.

## Evidence and verification limits

Token expansion is measured as `tokens(target sample) / tokens(source sample)`
using the model's configured token counter. Keep samples parallel and complete;
changing a tokenizer can change the ratio without changing any language data.
A tag without its own sample may use a same-script parent or script-level
sample. An empty sample must not claim measured evidence. The quality and cap
tests require every offered target to have an evidence row and a usable pricing
path, and reject implausible measurements.

The prompt requests the target script and the reply checker examines the
combined translated fragments, excluding preserved URLs, email addresses and
code spans. It deliberately gives no verdict for unclassifiable scripts,
insufficient text, or simplified-versus-traditional Han. Passing those checks
does not establish fluency, semantic accuracy or real-provider throughput.

The focused tests below use local data and provider stubs. The
[`detection recording`](../../../py/free2z/dj/apps/openai/testdata/language_eval_recording.json)
and `ACCURACY_FLOORS` in
[`test_language_detection_evals.py`](../../../py/free2z/dj/apps/openai/test_language_detection_evals.py)
must reflect actual recorded evaluations. Do not invent accuracy floors or
claim that fixture-based checks prove live model quality.

## Focused checks

Use the locked Python environment described in the
[backend README](../../../py/free2z/README.md). From `py/free2z`:

```sh
python -m pytest -q \
  dj/apps/g12f/test_language_registry.py \
  dj/apps/g12f/test_translation_quality.py \
  dj/apps/g12f/test_translation_output_cap.py \
  dj/apps/g12f/test_language_derived_bounds.py
```

These checks need the backend dependencies and tokenizer data, but do not use a
database or paid provider. From `ts/svelte/free2z`, use the repository's pinned
Node version for the catalog and offline-picker checks:

```sh
node --test tests/language-catalog.test.mjs tests/editor-translation-manager.test.mjs
```

For rendering changes, install the website's locked dependencies using its
[README](../../../ts/svelte/free2z/README.md), then run
`node --test tests/text-direction.test.mjs` and
`npm run test:browser -- tests/browser/article-direction.spec.ts tests/browser/editor-direction.spec.ts`
from `ts/svelte/free2z`. The browser tests also require Playwright's browser
installation.
