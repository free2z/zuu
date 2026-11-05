import { gzipSync } from "node:zlib";

// Compact JSON bytes approximate dictionary contribution; HTML checks account
// separately for SvelteKit serialization and page overhead. Gzip is local.
export const CATALOG_LIMITS = Object.freeze({
  en: { raw: 181000, gzip: 55000 },
  es: { raw: 202000, gzip: 60000 },
  fr: { raw: 213000, gzip: 62000 },
  "pt-BR": { raw: 200000, gzip: 59000 },
});
export const PAIR_LIMITS = Object.freeze({
  en: { raw: 181000, gzip: 55000 },
  es: { raw: 383000, gzip: 114000 },
  fr: { raw: 394000, gzip: 116000 },
  "pt-BR": { raw: 381000, gzip: 113000 },
});
export const RTK_LIMITS = Object.freeze({
  es: { raw: 29700, gzip: 7420 },
  fr: { raw: 31300, gzip: 7730 },
  "pt-BR": { raw: 29300, gzip: 7390 },
});
export const COMPLETE_PAIR_LIMITS = Object.freeze({
  es: { raw: 412300, gzip: 120300 },
  fr: { raw: 424700, gzip: 122700 },
  "pt-BR": { raw: 409800, gzip: 119500 },
});
export const HTML_LIMITS = Object.freeze({
  en: { raw: 230000, gzip: 68000 },
  fr: { raw: 435000, gzip: 128000 },
});
export const INITIAL_ASSET_LIMITS = Object.freeze({
  raw: 2800000,
  gzip: 865000,
});
export const TIMING_LIMITS = Object.freeze({
  coldSwitchMs: 2500,
  warmSwitchMs: 1500,
  ssrP95Ms: 2000,
});

/** @param {string | Buffer} value */
export function bytes(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return { raw: buffer.length, gzip: gzipSync(buffer).length };
}
/** @param {string} label @param {{raw: number, gzip: number}} actual @param {{raw: number, gzip: number}} limits */
export function enforceBytes(label, actual, limits) {
  for (const key of /** @type {const} */ (["raw", "gzip"]))
    if (actual[key] > limits[key])
      throw new Error(`${label} ${key}: ${actual[key]} exceeds ${limits[key]}`);
}
/** @param {string} label @param {number} actual @param {number} limit */
export function enforceTiming(label, actual, limit) {
  if (!Number.isFinite(actual) || actual < 0 || actual > limit)
    throw new Error(`${label}: ${actual}ms exceeds ${limit}ms`);
}
/** @param {Record<string, {isEntry?: boolean, isDynamicEntry?: boolean, imports?: string[]}>} manifest */
export function staticCatalogs(manifest) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {string} key */
  function visit(key) {
    if (seen.has(key) || !manifest[key]) return;
    seen.add(key);
    for (const dep of manifest[key].imports ?? []) visit(dep);
  }
  for (const [key, entry] of Object.entries(manifest))
    if (
      (entry.isEntry || entry.isDynamicEntry) &&
      !/^src\/lib\/locales\/(?:rtk\/)?[^/]+\.json$/.test(key)
    )
      visit(key);
  return [...seen].filter((key) =>
    /^src\/lib\/locales\/(?:rtk\/)?[^/]+\.json$/.test(key),
  );
}
/** @param {Record<string, {isEntry?: boolean, isDynamicEntry?: boolean, imports?: string[]}>} manifest */
export function enforceStaticGraph(manifest) {
  const found = staticCatalogs(manifest);
  if (found.length)
    throw new Error(`Eager catalogs in client graph: ${found.join(", ")}`);
}
