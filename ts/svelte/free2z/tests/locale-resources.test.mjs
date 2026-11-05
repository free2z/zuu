import test from "node:test";
import assert from "node:assert/strict";
import { LOCALE_REGISTRY } from "../src/lib/locale.js";
import { validateResources } from "../scripts/check-locale-resources.mjs";
const catalogs = ["en.json", "es.json", "fr.json", "pt-BR.json"];
const rtk = ["es.json", "fr.json", "pt-BR.json"];
test("registry requires owned loaders, resources and fallback policies", () => {
  assert.deepEqual(validateResources(LOCALE_REGISTRY, catalogs, rtk), []);
  assert.match(
    validateResources(
      [
        ...LOCALE_REGISTRY,
        { code: "it", availability: "beta", fallback: "en" },
      ],
      [...catalogs, "it.json"],
      rtk,
    ).join(),
    /missing catalog loader/,
  );
  assert.match(
    validateResources(
      LOCALE_REGISTRY.map((entry) =>
        entry.code === "fr"
          ? {
              ...entry,
              loadCatalog: () => import("../src/lib/locales/es.json"),
            }
          : entry,
      ),
      catalogs,
      rtk,
    ).join(),
    /wrong catalog loader/,
  );
  assert.match(
    validateResources(LOCALE_REGISTRY, [...catalogs, "it.json"], rtk).join(),
    /orphan catalog/,
  );
  assert.match(
    validateResources(LOCALE_REGISTRY, catalogs, [...rtk, "it.json"]).join(),
    /orphan RTK catalog/,
  );
  assert.match(
    validateResources(
      LOCALE_REGISTRY,
      catalogs,
      rtk.filter((file) => file !== "fr.json"),
    ).join(),
    /fr: missing RTK/,
  );
});
