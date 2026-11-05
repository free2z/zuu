import fs from "node:fs";
import {
  bytes,
  CATALOG_LIMITS,
  PAIR_LIMITS,
  RTK_LIMITS,
  COMPLETE_PAIR_LIMITS,
  enforceBytes,
  enforceStaticGraph,
} from "./locale-budget.mjs";
const catalogs = {};
for (const [locale, limit] of Object.entries(CATALOG_LIMITS)) {
  const catalog = JSON.parse(
    fs.readFileSync(`src/lib/locales/${locale}.json`, "utf8"),
  );
  catalogs[locale] = catalog;
  const size = bytes(JSON.stringify(catalog));
  enforceBytes(locale, size, limit);
  console.log(`${locale}: raw ${size.raw}, gzip ${size.gzip}`);
}
for (const [locale, limit] of Object.entries(PAIR_LIMITS)) {
  const size = bytes(
    JSON.stringify(
      locale === "en" ? [catalogs.en] : [catalogs.en, catalogs[locale]],
    ),
  );
  enforceBytes(`${locale} active and fallback`, size, limit);
  console.log(`${locale} active+fallback: raw ${size.raw}, gzip ${size.gzip}`);
}
for (const [locale, limit] of Object.entries(RTK_LIMITS)) {
  const pack = JSON.parse(
    fs.readFileSync(`src/lib/locales/rtk/${locale}.json`, "utf8"),
  );
  const size = bytes(JSON.stringify(pack));
  enforceBytes(`${locale} RTK`, size, limit);
  const total = bytes(JSON.stringify([catalogs.en, catalogs[locale], pack]));
  enforceBytes(
    `${locale} complete active and fallback`,
    total,
    COMPLETE_PAIR_LIMITS[locale],
  );
  console.log(
    `${locale} RTK raw ${size.raw} gzip ${size.gzip}; complete raw ${total.raw} gzip ${total.gzip}`,
  );
}
const manifest = JSON.parse(
  fs.readFileSync(".svelte-kit/output/client/.vite/manifest.json", "utf8"),
);
enforceStaticGraph(manifest);
console.log("No catalog is statically reachable from a client entry.");
