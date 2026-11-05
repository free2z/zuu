import assert from "node:assert/strict";
import test from "node:test";
import { createCatalogLoader } from "../src/lib/catalog-loader.js";

test("loads only requested catalogs, deduplicates and retries failed loads", async () => {
  let attempts = 0;
  let other = 0;
  const loader = createCatalogLoader({
    en: async () => {
      attempts++;
      if (attempts === 1) throw new Error("offline");
      return { default: { hello: "Hello" } };
    },
    fr: async () => {
      other++;
      return { default: {} };
    },
  });
  const a = loader.load("en");
  assert.equal(a, loader.load("en"));
  await assert.rejects(a, /offline/);
  assert.deepEqual(await loader.load("en"), { hello: "Hello" });
  assert.equal(attempts, 2);
  assert.equal(other, 0);
  await assert.rejects(loader.load("pt-PT"), /Unsupported locale/);
});
