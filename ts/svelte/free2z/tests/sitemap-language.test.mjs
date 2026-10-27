// Sitemap language alternates ( Part 8, reconciling ).
//
// Two things are under test and they are not the same thing:
//
//   1. That the sitemap's URLs are the SAME URLs the article page declares
//      canonical. A sitemap advertising a URL whose page canonicalizes
//      elsewhere is worse than no sitemap — the engine drops the whole
//      language cluster. The golden table in
//      py/free2z/dj/apps/g12f/testdata/zpage_language_parity.json is the shared
//      expected answer; py/free2z/dj/apps/g12f/test_crawler_language.py asserts the
//      Django crawler tier against the very same file.
//   2. That the emitted document is valid XML under the sitemaps.org 0.9
//      content model plus Google's hreflang annotation — checked with a real
//      schema validator, not a substring match.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const PARITY_FIXTURE = new URL(
  "../../../../py/free2z/dj/apps/g12f/testdata/zpage_language_parity.json",
  import.meta.url,
);
const MACROLANGUAGE_PARITY_FIXTURE = new URL(
  "../../../../py/free2z/dj/apps/g12f/testdata/macrolanguage_normalization_parity.json",
  import.meta.url,
);
const SITEMAP_XSD = fileURLToPath(
  new URL("./fixtures/sitemap-hreflang.xsd", import.meta.url),
);

const parity = JSON.parse(readFileSync(PARITY_FIXTURE, "utf8"));
const macrolanguageParity = JSON.parse(
  readFileSync(MACROLANGUAGE_PARITY_FIXTURE, "utf8"),
);
const ORIGIN = "https://free2z.cash";

let vite;
let getSitemapChild;
let articleCanonicalHref;
let articleLanguageAlternates;
let explicitArticleLanguage;
let normalizeContentLanguage;
let resolveContentLanguageRange;
const previousApiBase = process.env.PRIVATE_API_BASE_URL;

before(async () => {
  process.env.PRIVATE_API_BASE_URL = "https://api.free2z.test";
  vite = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { hmr: false, middlewareMode: true },
  });
  ({ GET: getSitemapChild } = await vite.ssrLoadModule(
    "/src/routes/sitemap/[kind]/[page].xml/+server.ts",
  ));
  ({
    articleCanonicalHref,
    articleLanguageAlternates,
    explicitArticleLanguage,
    normalizeContentLanguage,
    resolveContentLanguageRange,
  } = await vite.ssrLoadModule("/src/lib/zpage-language.js"));
});

after(async () => {
  await vite?.close();
  if (previousApiBase === undefined) {
    delete process.env.PRIVATE_API_BASE_URL;
  } else {
    process.env.PRIVATE_API_BASE_URL = previousApiBase;
  }
});

/** One backend chunk row in the localized shape. */
function row(overrides = {}) {
  return {
    username: "alice",
    vanity: "post",
    updated_at: "2026-07-28T12:00:00Z",
    languages: ["en"],
    source_language: "en",
    ...overrides,
  };
}

async function childXml(zpages) {
  const response = await getSitemapChild({
    fetch: async () => Response.json({ kind: "zpages", page: 0, zpages }),
    params: { kind: "zpages", page: `0-${zpages.length}-abcdefghijklmnop` },
    url: new URL(
      `https://free2z.test/sitemap/zpages/0-${zpages.length}-abcdefghijklmnop.xml`,
    ),
  });
  assert.equal(response.status, 200, "sitemap child should render");
  return response.text();
}

/**
 * Parse a `<urlset>` into `[{ loc, alternates: [{ hreflang, href }] }]`.
 *
 * Deliberately structural rather than a substring check: the point of these
 * assertions is that a URL sits in the right group, and a regex over the whole
 * document cannot tell one `<url>` block from the next.
 */
function parseUrlset(xml) {
  return [...xml.matchAll(/ {2}<url>\n([\s\S]*?)\n {2}<\/url>/g)].map(
    ([, block]) => ({
      loc: /<loc>([^<]*)<\/loc>/.exec(block)[1],
      alternates: [
        ...block.matchAll(
          /<xhtml:link rel="alternate" hreflang="([^"]+)" href="([^"]+)"\/>/g,
        ),
      ].map(([, hreflang, href]) => ({ hreflang, href })),
    }),
  );
}

let xmllintAvailable;
function haveXmllint() {
  if (xmllintAvailable === undefined) {
    try {
      execFileSync("xmllint", ["--version"], { stdio: "ignore" });
      xmllintAvailable = true;
    } catch {
      xmllintAvailable = false;
      // Optional locally, MANDATORY in CI. Left optional everywhere, a change
      // to the runner image would silently delete the only structural check on
      // this document and let an invalid namespace, element order or attribute
      // shape merge green — the class of thing crawlers reject outright.
      // `.github/workflows/ci.yml` installs libxml2-utils for this reason.
      if (process.env.CI) {
        throw new Error(
          "xmllint is required in CI: sitemap XML schema validation cannot " +
            "be skipped. Install libxml2-utils.",
        );
      }
      console.warn(
        "xmllint is unavailable; sitemap XML schema validation was skipped.",
      );
    }
  }
  return xmllintAvailable;
}

/** Validate against the sitemaps.org 0.9 + hreflang schema, when we can. */
function assertSchemaValid(xml, label) {
  if (!haveXmllint()) return;
  const file = join(mkdtempSync(join(tmpdir(), "sitemaplang-")), "sitemap.xml");
  writeFileSync(file, xml);
  try {
    execFileSync("xmllint", ["--noout", "--schema", SITEMAP_XSD, file], {
      stdio: "pipe",
    });
  } catch (cause) {
    assert.fail(
      `${label} failed sitemap schema validation:\n${cause.stderr?.toString() ?? cause}`,
    );
  }
}

test("golden table: page canonical, page alternates, and sitemap agree", async () => {
  for (const testCase of parity.cases) {
    const { base } = parity;
    const {
      name,
      source_language: source,
      available_languages: available,
    } = testCase;

    assert.deepEqual(
      articleLanguageAlternates(base, available, source),
      testCase.alternates,
      `article hreflang set for "${name}"`,
    );

    for (const [actual, expected] of Object.entries(
      testCase.canonical_by_actual,
    )) {
      assert.equal(
        articleCanonicalHref(base, actual, source, available),
        expected,
        `article canonical for "${name}" serving ${actual}`,
      );
    }

    for (const alternate of testCase.alternates) {
      if (alternate.hreflang === "x-default") continue;
      assert.equal(
        articleCanonicalHref(base, alternate.hreflang, source, available),
        alternate.href,
        `named alternate ${alternate.hreflang} for "${name}" must be self-canonical`,
      );
    }

    const xml = await childXml([
      row({
        username: "alice",
        vanity: "post",
        languages: available,
        source_language: source,
      }),
    ]);
    assertSchemaValid(xml, name);
    assert.deepEqual(
      parseUrlset(xml),
      testCase.sitemap.map((entry) => ({
        loc: `${ORIGIN}${entry.loc}`,
        alternates: entry.alternates.map(({ hreflang, href }) => ({
          hreflang,
          href: `${ORIGIN}${href}`,
        })),
      })),
      `sitemap URLs for "${name}"`,
    );
  }
});

test("macrolanguage normalization matches ICU across the IANA registry", async () => {
  assert.equal(macrolanguageParity.cases.length, 453);
  for (const { input, tag } of macrolanguageParity.cases) {
    assert.equal(normalizeContentLanguage(input), tag, `normalize ${input}`);
  }
});

// --- the two duplicated ALGORITHMS, not just their URL output ---------------
//
// Until  this file asserted only canonical/alternates/sitemap, so the one
// genuinely new cross-runtime algorithm -- "which variant does this language
// RANGE mean?" -- was pinned by nothing at all, and the two normalizers had
// diverged on `?lang=cmn` without either suite noticing (reviewer F2).

test("a language range resolves identically in both runtimes", () => {
  for (const { requested, available, resolved } of parity.range) {
    assert.equal(
      resolveContentLanguageRange(requested, available),
      resolved,
      `range ${requested} in [${available}]`,
    );
  }
});

test("the content-language normalizer matches the Python registry", () => {
  for (const { input, tag } of parity.normalize) {
    assert.equal(
      normalizeContentLanguage(input),
      tag,
      `normalize ${JSON.stringify(input)}`,
    );
  }
});

test("the explicit ?lang= selector matches the Python crawler tier", () => {
  // Keeps a stored macrolanguage alias (`cmn`), never splices a raw primary
  // onto a whole-tag mapping (`sgn-BR` -> `bzs`, not `sgn`).
  for (const { input, tag } of parity.explicit) {
    assert.equal(
      explicitArticleLanguage(input),
      tag,
      `explicit ${JSON.stringify(input)}`,
    );
  }
});

test("the documented runtime divergences are exactly these, and harmless", () => {
  // Structurally valid BCP-47 the IANA registry does not have. This tier
  // forwards it, the API answers 400, and `+page.server.ts` renders
  // DEFAULT_LOCALE — which is what the Django tier serves for the same input,
  // so the two agree on CONTENT even though they disagree on the tag.
  for (const { input, js } of parity.normalize_runtime_divergence) {
    assert.equal(
      normalizeContentLanguage(input),
      js,
      `divergence ${JSON.stringify(input)}`,
    );
  }
  assert.ok(
    parity.normalize_runtime_divergence.every((entry) => entry.python === null),
    "a divergence where BOTH runtimes name a language would serve two languages",
  );
});

test("every sitemap <loc> is its own page's canonical", async () => {
  // The invariant the golden table exists to protect, restated as a property
  // so a new case cannot be added with a self-contradicting expectation.
  for (const testCase of parity.cases) {
    const { base } = parity;
    for (const entry of testCase.sitemap) {
      const query = entry.loc.includes("?lang=")
        ? entry.loc.split("?lang=")[1]
        : null;
      // Which variant that URL serves: the explicit ?lang=, else the default
      // negotiation (English when published, otherwise the source).
      const actual =
        query ??
        (testCase.available_languages.includes("en")
          ? "en"
          : testCase.source_language);
      assert.equal(
        articleCanonicalHref(
          base,
          actual,
          testCase.source_language,
          testCase.available_languages,
        ),
        entry.loc,
        `${entry.loc} (${testCase.name}) is advertised but canonicalizes elsewhere`,
      );
    }
  }
});

test("a translated article emits its cluster and never advertises und", async () => {
  const xml = await childXml([
    row({ languages: ["und", "es"], source_language: "und" }),
  ]);

  assertSchemaValid(xml, "und + es");
  assert.match(xml, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
  assert.doesNotMatch(xml, /hreflang="und"/);
  assert.match(
    xml,
    /hreflang="x-default" href="https:\/\/free2z\.cash\/alice\/post"/,
  );
  // Every member of a cluster lists every member, itself included.
  for (const entry of parseUrlset(xml)) {
    assert.ok(
      entry.alternates.some((alternate) => alternate.href === entry.loc) ||
        entry.alternates.some(
          (alternate) =>
            alternate.hreflang === "x-default" && alternate.href === entry.loc,
        ),
      `${entry.loc} is missing from its own alternate group`,
    );
  }
});

test("an untranslated article is byte-for-byte what it was before", async () => {
  const legacy = await childXml([
    { username: "alice", vanity: "post", updated_at: "2026-07-28T12:00:00Z" },
  ]);
  const localized = await childXml([row()]);

  assert.equal(localized, legacy);
  assert.doesNotMatch(localized, /xhtml/);
  assert.match(localized, /<loc>https:\/\/free2z\.cash\/alice\/post<\/loc>/);
  assertSchemaValid(localized, "untranslated");
});

test("an article whose language is not detected yet still gets a URL", async () => {
  // `zPage.source_language` is nullable  and NULL — "detection has not
  // run yet" — is what  M7 replaces `und` with. The day the first row goes
  // NULL, this must be one ordinary URL, not a 503'd chunk.
  const xml = await childXml([row({ languages: [], source_language: null })]);

  assertSchemaValid(xml, "undetected language");
  assert.deepEqual(parseUrlset(xml), [
    { loc: "https://free2z.cash/alice/post", alternates: [] },
  ]);
});

test("collision-safe sitemap rows never advertise a product route as an article", async () => {
  const xml = await childXml([
    row({ vanity: "ppv", free2zaddr: "safe-address" }),
    row({
      username: "live",
      vanity: "ordinary-vanity",
      free2zaddr: "live-owner-address",
    }),
    row({ vanity: "broadcast", free2zaddr: "ppv" }),
  ]);

  assert.deepEqual(
    parseUrlset(xml).map(({ loc }) => loc),
    [
      "https://free2z.cash/alice/safe-address",
      "https://free2z.cash/article/live-owner-address",
      "https://free2z.cash/article/ppv",
    ],
  );
});

test("zPage sitemap children negotiate the collision-safe backend shape", async () => {
  let requested;
  const response = await getSitemapChild({
    fetch: async (_input, init) => {
      requested = new Headers(init?.headers);
      return Response.json({
        kind: "zpages",
        page: 0,
        zpages: [row({ free2zaddr: "safe-address" })],
      });
    },
    params: { kind: "zpages", page: "0-1-abcdefghijklmnop" },
    url: new URL("https://free2z.test/sitemap/zpages/0-1-abcdefghijklmnop.xml"),
  });

  assert.equal(response.status, 200);
  assert.equal(requested.get("x-free2z-sitemap-canonical-address"), "1");
  // Django rolls BEFORE the frontend does, and `parseLanguages` throws — 503ing
  // the whole child — on a row longer than THIS replica's bound. So the width
  // is asked for, never assumed: without a header Django keeps emitting 32.
  //
  //  asked with a BOOLEAN, which could only ever mean the one width that
  // generation was compiled with.  raised the ceiling and that header
  // could not express it, so the number is sent explicitly now. Both go out:
  // the boolean is what a Django replica predating  understands.
  const { MAX_SITEMAP_VARIANTS_PER_ZPAGE } = await vite.ssrLoadModule(
    "/src/lib/server/sitemap.ts",
  );
  assert.equal(
    requested.get("x-free2z-sitemap-max-variants"),
    String(MAX_SITEMAP_VARIANTS_PER_ZPAGE),
    "the width this parser accepts must be stated as a number",
  );
  assert.equal(requested.get("x-free2z-sitemap-wide-variants"), "1");
});

test("a chunk from a Django replica that predates languages still renders", async () => {
  // Django and SvelteKit are separate Deployments; a rollout mixes them.
  const xml = await childXml([
    { username: "alice", vanity: "post", updated_at: "2026-07-28T12:00:00Z" },
    { username: "bob", vanity: "other", updated_at: "2026-07-29T12:00:00Z" },
  ]);
  assert.equal(parseUrlset(xml).length, 2);
});

test("a malformed or unbounded language list fails closed", async () => {
  const { MAX_SITEMAP_VARIANTS_PER_ZPAGE: maxVariantsPerZPage } =
    await vite.ssrLoadModule("/src/lib/server/sitemap.ts");
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    for (const languages of [
      ["en", 7],
      ["en", ""],
      // One past MAX_SITEMAP_VARIANTS_PER_ZPAGE, which tracks the write
      // path's own ceiling (published translations + the source): 32 before
      //, 65 after it, 97 since. Read from the module rather than
      // written down, or this stops testing the bound the moment it moves.
      Array.from(
        { length: maxVariantsPerZPage + 1 },
        (_, index) => `x${index}`,
      ),
      "en",
    ]) {
      const response = await getSitemapChild({
        fetch: async () =>
          Response.json({
            kind: "zpages",
            page: 0,
            zpages: [row({ languages })],
          }),
        params: { kind: "zpages", page: "0-1-abcdefghijklmnop" },
        url: new URL(
          "https://free2z.test/sitemap/zpages/0-1-abcdefghijklmnop.xml",
        ),
      });
      assert.equal(
        response.status,
        503,
        `languages=${JSON.stringify(languages)} should not render`,
      );
    }

    // A half-migrated row (languages without source_language, or vice versa)
    // is a contract violation, not an older contract.
    for (const zpage of [
      {
        username: "a",
        vanity: "b",
        updated_at: "2026-07-28T12:00:00Z",
        languages: ["en"],
      },
      {
        username: "a",
        vanity: "b",
        updated_at: "2026-07-28T12:00:00Z",
        source_language: "en",
      },
      { ...row(), source_language: 7 },
    ]) {
      const response = await getSitemapChild({
        fetch: async () =>
          Response.json({ kind: "zpages", page: 0, zpages: [zpage] }),
        params: { kind: "zpages", page: "0-1-abcdefghijklmnop" },
        url: new URL(
          "https://free2z.test/sitemap/zpages/0-1-abcdefghijklmnop.xml",
        ),
      });
      assert.equal(response.status, 503);
    }
  } finally {
    console.error = originalConsoleError;
  }
});

test("the four-locale era is byte-for-byte unchanged", async () => {
  // Row growth is the reason this work was deferred behind the sitemap timeout
  // issues. This used to be called the worst case, on the premise
  // that the multiplier was the number of languages the article page could
  // name — four.  deleted that premise (every content language is
  // nameable now), so this is no longer the ceiling; it is the regression
  // guard that the common corpus still emits its full inline cluster.
  const zpages = Array.from({ length: 500 }, (_, index) =>
    row({
      vanity: `post-${index}`,
      languages: ["en", "es", "fr", "pt-BR"],
      source_language: "en",
    }),
  );
  const xml = await childXml(zpages);
  const urls = parseUrlset(xml);
  assert.equal(urls.length, 2000);
  assert.ok(urls.every((entry) => entry.alternates.length === 5));
  assertSchemaValid(xml, "four-locale chunk");
});

// --- the real ceiling, and why the inline cluster is not it ----------------
//
// `SITEMAP_MAX_BYTES_PER_ZPAGE` exists because an `n`-variant article costs
// `n` `<loc>` elements times `n` `xhtml:link` lines each, and each of those
// lines carries the article's URL. Before  the bound was 32 variants and
// the cluster was always inline, which renders 62.5 MiB for a 500-row chunk —
// past `MAX_SITEMAP_BYTES` and therefore a 503 on a sitemap child, taking up
// to 499 unrelated articles down with it.
//
// The bound is BYTES, not a variant count, because URL length is the other
// factor and Django's `UnicodeUsernameValidator` makes it large: a 150-CJK
// username percent-encodes to 1,350 bytes, and the first cut of  (an
// 8-variant cap, derived from ASCII measurements) renders 60.1 MiB on such a
// corpus and 503s anyway. These tests pin both the ASCII and the Unicode
// worst case.

/**
 * `count` distinct, linkable content languages.
 *
 * The curated head is real sellable languages, in rough speaker order, so the
 * small counts these tests use are representative rather than synthetic. Past
 * it the list is GENERATED from the registry, because a hand-written pool has
 * to be re-sized every time the variant ceiling moves — which is exactly the
 * defect  is about, one layer down.  sized this pool at 65 and
 * needed 97.
 *
 * Every tag is validated through `normalizeContentLanguage`, the same function
 * `linkableLanguages` uses: a tag it rejects is dropped before any cluster is
 * built, so filler it refuses would make these tests pass against a document
 * that never grew.
 */
function manyLanguages(count) {
  const curated = [
    "en",
    "es",
    "fr",
    "pt-BR",
    "de",
    "it",
    "ja",
    "ko",
    "zh-Hans",
    "zh-Hant",
    "ru",
    "ar",
    "he",
    "hi",
    "bn",
    "ur",
    "fa",
    "tr",
    "pl",
    "nl",
    "sv",
    "da",
    "fi",
    "nb",
    "cs",
    "el",
    "hu",
    "ro",
    "th",
    "vi",
    "id",
    "ms",
    "uk",
    "ta",
    "te",
    "ml",
    "kn",
    "mr",
    "gu",
    "pa",
    "ne",
    "si",
    "km",
    "lo",
    "my",
    "am",
    "ha",
    "yo",
    "ig",
    "sw",
    "bg",
    "sr",
    "hr",
    "sk",
    "sl",
    "lt",
    "lv",
    "et",
    "is",
    "ca",
    "eu",
    "gl",
    "hy",
    "ka",
    "az",
  ];
  const seen = new Set();
  const pool = [];
  const push = (tag) => {
    const normalized = normalizeContentLanguage(tag);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    pool.push(tag);
  };
  for (const tag of curated) push(tag);
  const letters = "abcdefghijklmnopqrstuvwxyz";
  for (const first of letters) {
    for (const second of letters) {
      if (pool.length >= count) break;
      push(`${first}${second}`);
    }
  }
  assert.ok(
    pool.length >= count,
    `pool is too small for this test: ${pool.length} < ${count}`,
  );
  return pool.slice(0, count);
}

test("the inline hreflang cluster is dropped, not the URLs, over budget", async () => {
  const { SITEMAP_MAX_BYTES_PER_ZPAGE } = await vite.ssrLoadModule(
    "/src/lib/server/sitemap.ts",
  );

  // Ordinary paths, a handful of variants: well inside the budget, so every
  // URL still carries the whole cluster inline. This is the corpus today and
  // it must not change.
  const small = parseUrlset(
    await childXml([row({ languages: manyLanguages(6) })]),
  );
  assert.equal(small.length, 6);
  assert.ok(
    small.every(
      (entry) =>
        entry.alternates.length === 7 &&
        entry.alternates.at(-1).hreflang === "x-default",
    ),
    "inside the budget each <loc> lists every variant plus x-default",
  );

  // Enough variants that the quadratic term blows the per-article budget. The
  // `<loc>` list is what gets a variant crawled and it must NOT shrink — the
  // page's own <head> carries the hreflang from here on.
  const languages = manyLanguages(40);
  const xml = await childXml([row({ languages })]);
  const past = parseUrlset(xml);
  assert.equal(
    past.length,
    40,
    "every variant keeps its own <loc> past the cluster budget",
  );
  assert.deepEqual(
    past.map((entry) => entry.loc.replace(ORIGIN, "")).sort(),
    languages.map((language) => `/alice/post?lang=${language}`).sort(),
  );
  assert.ok(
    past.every((entry) => entry.alternates.length === 0),
    "past the budget no <url> carries an inline cluster",
  );
  // A document with no alternate left must not declare the namespace for one.
  assert.doesNotMatch(xml, /xmlns:xhtml/);
  assertSchemaValid(xml, "chunk past the cluster budget");

  // And the budget really is what decided it: the same variant count with
  // SHORTER URLs keeps its cluster, which a variant-count rule could not do.
  assert.ok(
    new TextEncoder().encode(xml).byteLength / 40 < SITEMAP_MAX_BYTES_PER_ZPAGE,
    "the truncated article is inside its budget",
  );
});

test("a 150-character CJK username cannot 503 a sitemap child", async () => {
  // The codex adversarial review of the first cut of. Django's
  // `UnicodeUsernameValidator` allows a 150-CHARACTER username; 150 CJK
  // characters percent-encode to 1,350 bytes, so every `<loc>` and every
  // `xhtml:link` line is ~1.5 kB. Against the real renderer that produced
  // 60.1 MiB at 8 variants and 51.2 MiB at 65 variants with NO alternates at
  // all -- both past the 50 MiB ceiling, both a permanent 503 on that child.
  const { MAX_SITEMAP_BYTES, MAX_SITEMAP_VARIANTS_PER_ZPAGE } =
    await vite.ssrLoadModule("/src/lib/server/sitemap.ts");
  const username = "\u754c".repeat(150);
  assert.ok(
    encodeURIComponent(username).length >= 1350,
    "fixture must actually be a 1,350-byte encoded username",
  );

  for (const count of [8, MAX_SITEMAP_VARIANTS_PER_ZPAGE]) {
    const xml = await childXml(
      Array.from({ length: 500 }, (_, index) =>
        row({
          username,
          vanity: String(index).padStart(128, "v"),
          languages: manyLanguages(count),
          source_language: "en",
        }),
      ),
    );
    const bytes = new TextEncoder().encode(xml).byteLength;
    assert.ok(
      bytes < MAX_SITEMAP_BYTES,
      `${count} variants rendered ${(bytes / 1024 / 1024).toFixed(1)} MiB`,
    );
    // Half the ceiling by construction: 500 articles x the per-article budget.
    assert.ok(
      bytes <= MAX_SITEMAP_BYTES / 2 + 1024 * 1024,
      `${count} variants rendered past the provable half-ceiling bound`,
    );
    // Nothing vanished entirely -- every article still has at least one URL.
    assert.ok((xml.match(/ {2}<url>/g) ?? []).length >= 500);
  }
});

test("a full chunk at the write-path variant ceiling renders, and does not 503", async () => {
  const {
    MAX_SITEMAP_VARIANTS_PER_ZPAGE,
    MAX_SITEMAP_BYTES,
    MAX_SITEMAP_ENTRIES,
    SITEMAP_CHUNK_SIZE,
  } = await vite.ssrLoadModule("/src/lib/server/sitemap.ts");
  // / cap a zPage at MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE
  // published translations and the source makes one more. The Python constant
  // is the source of truth and `py/free2z/dj/apps/g12f/test_language_derived_bounds.py`
  // asserts this literal against it; pinning the NUMBER again here would just
  // be a second place to forget. What matters on this side is the consequence:
  // a full chunk at that ceiling must render rather than 503.
  assert.ok(
    SITEMAP_CHUNK_SIZE * MAX_SITEMAP_VARIANTS_PER_ZPAGE <= MAX_SITEMAP_ENTRIES,
    `a full chunk would emit ${SITEMAP_CHUNK_SIZE * MAX_SITEMAP_VARIANTS_PER_ZPAGE} ` +
      `URLs, past the ${MAX_SITEMAP_ENTRIES} renderUrlset throws on`,
  );

  // The absolute worst case the API can hand this renderer: a whole chunk of
  // maximally-translated articles, with the longest username (150) and vanity
  // (128) the schema allows, so the URL length term is at its maximum too.
  const username = "u".repeat(150);
  const languages = manyLanguages(MAX_SITEMAP_VARIANTS_PER_ZPAGE);
  const zpages = Array.from({ length: 500 }, (_, index) =>
    row({
      username,
      vanity: String(index).padStart(128, "v"),
      languages,
      source_language: "en",
    }),
  );

  const xml = await childXml(zpages);
  const bytes = new TextEncoder().encode(xml).byteLength;
  // 500 rows x every variant. The clean URL is not listed: `en` is published,
  // so a cookie-less visitor gets it there and the clean URL canonicalizes to
  // `?lang=en`.
  const urlCount = (xml.match(/ {2}<url>/g) ?? []).length;
  assert.equal(urlCount, 500 * MAX_SITEMAP_VARIANTS_PER_ZPAGE);
  assert.ok(
    urlCount <= MAX_SITEMAP_ENTRIES,
    `${urlCount} URLs exceeds the protocol bound`,
  );
  assert.ok(
    bytes < MAX_SITEMAP_BYTES,
    `${(bytes / 1024 / 1024).toFixed(1)} MiB exceeds the 50 MiB ceiling`,
  );
  // Inline clusters here would be ~757 MiB. Their absence is the whole point.
  assert.doesNotMatch(xml, /xhtml:link/);

  // The other branch, where the clean URL is listed TOO because what it serves
  // is unnameable: a legacy `und` source. One more <loc> per article, and the
  // bound has to hold with it.
  const legacy = await childXml(
    Array.from({ length: 500 }, (_, index) =>
      row({
        username,
        vanity: String(index).padStart(128, "v"),
        // No `en`, so what the clean URL serves is the `und` source — which
        // is unnameable, so the clean URL is its own canonical and IS listed.
        languages: ["und", ...languages.filter((code) => code !== "en")],
        source_language: "und",
      }),
    ),
  );
  const legacyUrls = (legacy.match(/ {2}<url>/g) ?? []).length;
  assert.equal(
    legacyUrls,
    500 * MAX_SITEMAP_VARIANTS_PER_ZPAGE,
    "every named variant plus the clean URL, which `und` does not own",
  );
  assert.ok(legacyUrls <= 50_000);
  assert.ok(new TextEncoder().encode(legacy).byteLength < MAX_SITEMAP_BYTES);
});

// --- the URL-count ceiling is structural, not an arithmetic bracket  --
//
// The byte budget above makes a chunk's SIZE independent of how many variants
// an article carries. Its URL COUNT was not: an article contributed one
// `<loc>` per named variant (plus the clean URL when what it serves is
// unnameable), so a chunk's count was `SITEMAP_CHUNK_SIZE x variants`, and the
// only thing keeping that under the protocol's 50,000 was that the publish
// cap happened to sit at or below 99. A row the parser accepts with a NULL
// source and a full list already emits `MAX_SITEMAP_VARIANTS_PER_ZPAGE + 1`
// URLs, and raising the publish cap one step past the bracket turned that
// into a `renderUrlset` throw — a 503 on the whole child, taking up to 499
// unrelated articles with it. These tests drive `zpageSitemapEntries`
// directly, past the parser's own variant bound, because the property is
// "whatever the variant count", not "at today's constants".

test("a chunk's URL count is bounded whatever an article's variant count", async () => {
  const {
    MAX_SITEMAP_ENTRIES,
    MAX_SITEMAP_VARIANTS_PER_ZPAGE,
    SITEMAP_CHUNK_SIZE,
    SITEMAP_MAX_URLS_PER_ZPAGE,
    renderUrlset,
    zpageSitemapEntries,
  } = await vite.ssrLoadModule("/src/lib/server/sitemap.ts");

  assert.ok(
    Number.isSafeInteger(SITEMAP_MAX_URLS_PER_ZPAGE) &&
      SITEMAP_MAX_URLS_PER_ZPAGE >= 1,
    "SITEMAP_MAX_URLS_PER_ZPAGE must be a positive integer",
  );
  assert.ok(
    SITEMAP_CHUNK_SIZE * SITEMAP_MAX_URLS_PER_ZPAGE <= MAX_SITEMAP_ENTRIES,
    "a full chunk at the per-article URL ceiling must fit the protocol bound",
  );

  const lastmod = "2026-07-28T12:00:00.000Z";
  for (const count of [
    MAX_SITEMAP_VARIANTS_PER_ZPAGE,
    MAX_SITEMAP_VARIANTS_PER_ZPAGE + 1,
    SITEMAP_MAX_URLS_PER_ZPAGE + 1,
    150,
  ]) {
    // No `en` and a NULL source: the clean URL serves something unnameable,
    // so it is its own canonical and is listed ON TOP of every named variant
    // the widest `<loc>` list a row can produce.
    const languages = manyLanguages(count + 1)
      .filter((code) => code !== "en")
      .slice(0, count);
    assert.equal(languages.length, count);
    const entries = zpageSitemapEntries(
      "/alice/post",
      lastmod,
      languages,
      undefined,
      ORIGIN,
    );
    assert.ok(
      entries.length <= SITEMAP_MAX_URLS_PER_ZPAGE,
      `${count} variants emitted ${entries.length} URLs, past the ` +
        `${SITEMAP_MAX_URLS_PER_ZPAGE}-URL per-article ceiling`,
    );
    // The clean URL — the cluster's x-default — is never the one dropped.
    assert.equal(entries[0].path, "/alice/post");

    // And the consequence that matters: a FULL chunk of such articles renders.
    const chunk = Array.from({ length: SITEMAP_CHUNK_SIZE }, (_, index) =>
      zpageSitemapEntries(
        `/alice/post-${index}`,
        lastmod,
        languages,
        undefined,
        ORIGIN,
      ),
    ).flat();
    assert.doesNotThrow(
      () => renderUrlset(chunk, ORIGIN),
      `a ${SITEMAP_CHUNK_SIZE}-article chunk at ${count} variants must not 503`,
    );
  }
});

test("truncating to the URL ceiling keeps the source's own URL", async () => {
  const { SITEMAP_MAX_URLS_PER_ZPAGE, zpageSitemapEntries } =
    await vite.ssrLoadModule("/src/lib/server/sitemap.ts");
  // Tag order is alphabetical, so a source late in the alphabet is exactly
  // the one a plain slice would drop — and it is the language the article was
  // written in.
  const languages = manyLanguages(SITEMAP_MAX_URLS_PER_ZPAGE + 20)
    .filter((code) => code !== "en")
    .slice(0, SITEMAP_MAX_URLS_PER_ZPAGE + 10)
    .sort();
  const source = languages.at(-1);
  const entries = zpageSitemapEntries(
    "/alice/post",
    "2026-07-28T12:00:00.000Z",
    languages,
    source,
    ORIGIN,
  );
  assert.equal(entries.length, SITEMAP_MAX_URLS_PER_ZPAGE);
  assert.ok(
    entries.some((entry) => entry.path === `/alice/post?lang=${source}`),
    `the ${source} source variant must survive truncation`,
  );
});

test("an untruncated article's URLs are unchanged by the URL ceiling", async () => {
  // Every row the parser can accept today sits under the ceiling, so the
  // ceiling must be invisible to it: same URLs, same order.
  const { MAX_SITEMAP_VARIANTS_PER_ZPAGE, SITEMAP_MAX_URLS_PER_ZPAGE } =
    await vite.ssrLoadModule("/src/lib/server/sitemap.ts");
  assert.ok(MAX_SITEMAP_VARIANTS_PER_ZPAGE + 1 <= SITEMAP_MAX_URLS_PER_ZPAGE);
  const languages = manyLanguages(MAX_SITEMAP_VARIANTS_PER_ZPAGE + 1)
    .filter((code) => code !== "en")
    .slice(0, MAX_SITEMAP_VARIANTS_PER_ZPAGE);
  const urls = parseUrlset(
    await childXml([row({ languages, source_language: null })]),
  ).map((entry) => entry.loc.replace(ORIGIN, ""));
  assert.deepEqual(urls, [
    "/alice/post",
    ...languages.map((code) => `/alice/post?lang=${code}`),
  ]);
});
