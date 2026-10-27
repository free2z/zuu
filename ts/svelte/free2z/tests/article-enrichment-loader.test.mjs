import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { ARTICLE_ENRICHMENT_TIMEOUT_MS } from "../src/lib/article-ssr-deadlines.js";
import { loadArticleEnrichments } from "../src/lib/server/article-enrichment.ts";

const apiUrl = (path, params = {}) => {
  const url = new URL(path, "http://api.test");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return url.toString();
};

test("actual article enrichment loaders settle on deadline and cancel late headers", async (context) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  context.after(() => mock.timers.reset());

  const article = Object.freeze({
    free2zaddr: "article-loader-deadline-fixture",
    vanity: "article-loader-deadline-fixture",
    content: "Healthy article body sentinel.",
  });
  const heldFetches = new Map();
  const errors = [];
  const fetch = (input, init = {}) => {
    const kind = String(input).includes("/related/") ? "related" : "series";
    assert.equal(init.credentials, "omit");
    assert.ok(init.signal instanceof AbortSignal);
    return new Promise((resolve) => {
      heldFetches.set(kind, { resolve, signal: init.signal });
    });
  };

  const startedAt = Date.now();
  const deferred = loadArticleEnrichments(
    article,
    fetch,
    "en",
    new AbortController().signal,
    apiUrl,
    (event, error) => errors.push({ event, error }),
    (page) =>
      `/${page.creator?.username || "creator"}/${page.vanity || page.free2zaddr}`,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...heldFetches.keys()].sort(), ["related", "series"]);

  let settled = false;
  const values = Promise.all([
    deferred.relatedArticles,
    deferred.seriesContext,
  ]).then((result) => {
    settled = true;
    return result;
  });

  mock.timers.tick(ARTICLE_ENRICHMENT_TIMEOUT_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    settled,
    false,
    "the fixture must still be waiting before the deadline",
  );

  mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    settled,
    true,
    "both actual loaders must settle when their unchanged deadline fires",
  );

  const [related, series] = await values;
  const elapsed = Date.now() - startedAt;
  assert.equal(elapsed, ARTICLE_ENRICHMENT_TIMEOUT_MS);
  assert.deepEqual(related, []);
  assert.equal(series, null);
  assert.equal(article.content, "Healthy article body sentinel.");
  assert.ok([...heldFetches.values()].every(({ signal }) => signal.aborted));
  assert.deepEqual(errors.map(({ event }) => event).sort(), [
    "zpage_related_failed",
    "zpage_series_failed",
  ]);

  const cancelled = new Set();
  for (const [kind, held] of heldFetches) {
    held.resolve({
      ok: true,
      body: {
        cancel() {
          cancelled.add(kind);
          return Promise.resolve();
        },
      },
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...cancelled].sort(), ["related", "series"]);
});
