import assert from "node:assert/strict";
import test from "node:test";
import {
  bytes,
  enforceBytes,
  enforceStaticGraph,
  enforceTiming,
} from "../scripts/locale-budget.mjs";

test("budget negative controls reject oversize, eager and slow paths", () => {
  assert.throws(
    () =>
      enforceBytes("catalog", bytes("x".repeat(1000)), {
        raw: 999,
        gzip: 1000,
      }),
    /catalog raw/,
  );
  assert.throws(
    () =>
      enforceStaticGraph({
        entry: { isEntry: true, imports: ["src/lib/locales/fr.json"] },
        "src/lib/locales/fr.json": {},
      }),
    /Eager catalogs/,
  );
  assert.doesNotThrow(() =>
    enforceStaticGraph({
      entry: { isEntry: true, dynamicImports: ["src/lib/locales/fr.json"] },
      "src/lib/locales/fr.json": {},
    }),
  );
  assert.throws(
    () =>
      enforceStaticGraph({
        entry: { isEntry: true, imports: ["src/lib/locales/de.json"] },
        "src/lib/locales/de.json": {},
      }),
    /Eager catalogs/,
  );
  assert.throws(
    () =>
      enforceBytes(
        "initial assets",
        { raw: 2800001, gzip: 100 },
        { raw: 2800000, gzip: 865000 },
      ),
    /initial assets raw/,
  );
  assert.throws(() => enforceTiming("cold switch", 2501, 2500), /cold switch/);
  assert.throws(() => enforceTiming("SSR p95", 2001, 2000), /SSR p95/);
});

test("measured delayed switch and SSR work fail their timing gates", async () => {
  for (const label of ["cold switch", "SSR p95"]) {
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const elapsed = performance.now() - start;
    assert.throws(() => enforceTiming(label, elapsed, 5), new RegExp(label));
  }
});
