import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TRENDING_SORT,
  TRENDING_PAGE_SIZE,
  parseTrendingParams,
  totalPages,
  trendingHref,
} from "../src/lib/trending.js";

const params = (qs) => new URLSearchParams(qs);

test("defaults to the updated sort on page 1", () => {
  assert.deepEqual(parseTrendingParams(params("")), {
    sort: DEFAULT_TRENDING_SORT,
    page: 1,
  });
});

test("accepts the two supported sorts and rejects anything else", () => {
  assert.equal(parseTrendingParams(params("sort=popular")).sort, "popular");
  assert.equal(parseTrendingParams(params("sort=updated")).sort, "updated");
  // `random` is a real backend homeSort but is not stable across pages, so it
  // must not be reachable from a paginated view.
  assert.equal(parseTrendingParams(params("sort=random")).sort, "updated");
  assert.equal(parseTrendingParams(params("sort=; DROP")).sort, "updated");
});

test("page numbers are clamped to a sane, non-negative range", () => {
  assert.equal(parseTrendingParams(params("page=4")).page, 4);
  assert.equal(parseTrendingParams(params("page=0")).page, 1);
  assert.equal(parseTrendingParams(params("page=-3")).page, 1);
  assert.equal(parseTrendingParams(params("page=banana")).page, 1);
  assert.equal(parseTrendingParams(params("page=1000000000")).page, 1000);
});

test("hrefs omit the defaults so page 1 has a single canonical URL", () => {
  assert.equal(trendingHref(), "/trending");
  assert.equal(trendingHref({ sort: "updated", page: 1 }), "/trending");
  assert.equal(trendingHref({ sort: "popular" }), "/trending?sort=popular");
  assert.equal(trendingHref({ page: 3 }), "/trending?page=3");
  assert.equal(
    trendingHref({ sort: "popular", page: 2 }),
    "/trending?sort=popular&page=2",
  );
});

test("an href round-trips through the parser", () => {
  const url = new URL(
    trendingHref({ sort: "popular", page: 7 }),
    "https://free2z.cash",
  );
  assert.deepEqual(parseTrendingParams(url.searchParams), {
    sort: "popular",
    page: 7,
  });
});

test("totalPages never drops below one", () => {
  assert.equal(totalPages(0), 1);
  assert.equal(totalPages(undefined), 1);
  assert.equal(totalPages(TRENDING_PAGE_SIZE), 1);
  assert.equal(totalPages(TRENDING_PAGE_SIZE + 1), 2);
  assert.equal(totalPages(3303, 12), 276);
});
