import { LOCALE_REGISTRY } from "./locale.js";
import { rtkCatalogLoader } from "./catalog-loader.js";
/** Immutable loaded packs; English and test locales use the library's English fallback. */
const ready = new Map();
/** @param {string} locale */
export async function prepareRtkCatalog(locale) {
  const entry = LOCALE_REGISTRY.find((item) => item.code === locale);
  if (!entry?.loadRtk || ready.has(locale)) return;
  ready.set(locale, await rtkCatalogLoader.load(locale));
}
/** @param {string} locale */
export function getRtkCatalog(locale) {
  return ready.get(locale);
}
/** @param {string} locale @param {unknown} value */
export function hydrateRtkCatalog(locale, value) {
  if (value) ready.set(locale, value);
}
