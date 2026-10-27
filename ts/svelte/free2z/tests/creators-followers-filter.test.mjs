// Regression coverage for.
//
// The /creators directory's "at least N followers" control filtered
// client-side on `creator.total`, and its "Most/Fewest Followers" sort asked
// the API for `ordering=-total`. `Creator.total` is `cache_total()` --
// `Sum(zpage.total) + tuzis/1000` -- a cached, ZEC-denominated page-support
// score counting spend by anyone including the creator themselves. It is not
// a follower count and never was, so both controls quietly answered a
// question nobody asked.
//
// Both now go through the API's real subscriber count: `min_followers` (a
// server-side filter, so the paginated `count` is the true number of matches
// rather than whatever survived on the pages already fetched) and
// `fans_count` ordering.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const read = (relative) =>
  readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    "utf8",
  );

const PAGE = "src/routes/creators/+page.svelte";
const STORE = "src/lib/stores/creatorsFilter.ts";

test("#1096: the follower filter is sent to the API, not applied to `total`", () => {
  const page = read(PAGE);

  assert.match(
    page,
    /params\.min_followers = minFollowers/,
    "the follower minimum must be passed to the creator list endpoint",
  );
  // The old implementation, in both of its parts.
  assert.doesNotMatch(
    page,
    /parseFollowers/,
    "`creator.total` is a ZEC page-support cache, not a follower count",
  );
  assert.doesNotMatch(
    page,
    /minFollowers\s*&&[^\n]*creator\.total/,
    "the client-side comparison against `total` must be gone",
  );
});

test("#1096: changing the follower minimum refetches", () => {
  // A server-side filter that is not in the TanStack query key returns a
  // cached page from the previous minimum -- the filter would appear to do
  // nothing until some other input changed.
  const page = read(PAGE);
  const key = page.match(/queryKey:\s*\[([\s\S]*?)\]/);
  assert.ok(key, "expected an infinite-query queryKey");
  assert.match(key[1], /minFollowers/);
});

test("#1096: the follower minimum is not double-counted as a client-side filter", () => {
  // `hasClientSideFilters` drives the "auto-fetch another page because the
  // filters emptied the grid" loop. With the filter applied server-side the
  // API already returns a full page of matches, so leaving minFollowers in
  // here would walk the entire directory on every follower filter.
  const store = read(STORE);
  const derived = store.match(
    /export const hasClientSideFilters = derived\(([\s\S]*?)\);/,
  );
  assert.ok(derived, "expected a hasClientSideFilters derived store");
  assert.doesNotMatch(derived[1], /minFollowers/);
});

test("#1096: Most/Fewest Followers sorts by subscribers, not by funding", () => {
  const store = read(STORE);
  // End at the function's own closing brace -- the only `}` alone on a line.
  // A bare `\n}` also matched the close of the multi-line RETURN TYPE that
  // Prettier introduced, which truncated `body` to the signature and
  // made every assertion below fail against unchanged behaviour.
  const sortParams = store.match(
    /export function getApiSortParams\b([\s\S]*?)\n\}$/m,
  );
  assert.ok(sortParams, "expected getApiSortParams");
  // Quote style belongs to the formatter. Normalize it so these assertions
  // pin which ordering each sort asks for, not how the file is punctuated.
  const body = sortParams[1].replace(/"/g, "'");

  // The two follower sorts must ask for the follower count.
  assert.match(
    body,
    /case 'followers_desc':\s*\n\s*return \{ ordering: '-fans_count' \};/,
  );
  assert.match(
    body,
    /case 'followers_asc':\s*\n\s*return \{ ordering: 'fans_count' \};/,
  );

  // `popular` legitimately keeps `-total`: page support is a fair proxy for
  // popularity. It is only mislabelled when it is called "followers".
  assert.match(body, /case 'popular':[\s\S]*?ordering: '-total'/);

  // And no follower sort may fall back to `total`.
  const followerBranch = body.slice(body.indexOf("case 'followers_desc'"));
  assert.doesNotMatch(
    followerBranch.slice(0, followerBranch.indexOf("case 'newest'") + 1) ||
      followerBranch,
    /ordering: '-?total'/,
  );
});

// The store cannot be imported here -- it pulls in `$app/environment`, which
// only resolves inside the SvelteKit build. `sanitizeThreshold` has no
// imports of its own, so lift its real source into a temp module and run it.
// This is a behavioural test of the shipped code, not a text match.
const loadSanitizer = async () => {
  const source = read(STORE);
  const fn = source.match(
    /function sanitizeThreshold\(value: number \| null \| undefined\): number \| null \{[\s\S]*?\n\}/,
  );
  assert.ok(fn, "expected sanitizeThreshold in the creators filter store");
  const file = join(
    mkdtempSync(join(tmpdir(), "f2z-sanitize-")),
    "sanitize.ts",
  );
  writeFileSync(file, `export ${fn[0]}\n`);
  return (await import(pathToFileURL(file).href)).sanitizeThreshold;
};

test("#1096: a negative follower minimum never reaches the API", async () => {
  // `min_followers=-1` is a 400 from the API (it would otherwise compile to
  // `fans_count >= -1` and match everyone). The number input's `min="0"`
  // does not stop anyone typing a minus sign, and the value is persisted --
  // so an unsanitised `-1` replaces the directory with "Could not load
  // creators" and survives a reload.
  const sanitize = await loadSanitizer();

  assert.equal(sanitize(-1), null);
  assert.equal(sanitize(-1000), null);
  assert.equal(sanitize(0), null); // "at least 0" is not a filter
  assert.equal(sanitize(NaN), null);
  assert.equal(sanitize(null), null);
  assert.equal(sanitize(undefined), null);
  assert.equal(sanitize(Infinity), null);

  // Real thresholds survive, and fractions are truncated rather than sent to
  // an endpoint that only accepts integers.
  assert.equal(sanitize(1), 1);
  assert.equal(sanitize(10), 10);
  assert.equal(sanitize(2.7), 2);
});

test("#1096: the sanitizer guards the setter, and storage in both directions", () => {
  const store = read(STORE);

  for (const setter of ["setMinFollowers", "setMinPosts"]) {
    const body = store.match(
      new RegExp(
        // Stop at the setter's own closing `},` at whatever indent the
        // formatter chose. Pinning a literal 8-space indent made this widen
        // silently to span both setters once Prettier reindented the store
        //  -- still green, no longer scoped to one setter.
        `${setter}: \\(value: number \\| null\\) => \\{[\\s\\S]*?\\n\\s*\\},`,
      ),
    );
    assert.ok(body, `expected ${setter}`);
    assert.match(body[0], /sanitizeThreshold\(value\)/);
  }

  // Values written by an older bundle are still in browsers today, so the
  // read path needs the guard too -- not just the write path.
  const loader = store.match(/function loadFromStorage\(\)[\s\S]*?\n}/);
  assert.ok(loader, "expected loadFromStorage");
  assert.match(loader[0], /sanitizeThreshold\(parseInt\(savedMinFollowers\)\)/);
});

test("#1096: `min_followers` exists in the generated client", () => {
  // The chain is Django -> f2z.yaml -> orval. If the param is missing from
  // the generated types the page above compiles only because the params
  // object is typed `any`, and the filter silently stops being sent.
  const schemas = read("src/lib/api/f2z.schemas.ts");
  const params = schemas.match(
    /export type CreatorListParams = \{([\s\S]*?)\n\};/,
  );
  assert.ok(params, "expected CreatorListParams in the generated client");
  assert.match(params[1], /min_followers\?: number;/);
});
