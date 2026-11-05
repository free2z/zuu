// Explicit import targets allow Vite to emit one content-hashed chunk per catalog.
// This loader does not select a locale or modify request/browser state.
let inFlight = 0;
export function isCatalogLoadInFlight() {
  return inFlight > 0;
}
import { LOCALE_REGISTRY } from "./locale.js";
const loaders = Object.fromEntries(
  LOCALE_REGISTRY.map(({ code, loadCatalog }) => [code, loadCatalog]),
);
export const rtkCatalogLoader = createCatalogLoader(
  Object.fromEntries(
    LOCALE_REGISTRY.flatMap(({ code, loadRtk }) =>
      loadRtk ? [[code, loadRtk]] : [],
    ),
  ),
);

/** Create a cache whose failed loads can be retried.
 * @param {Record<string, () => Promise<{default: unknown}>>} sources
 */
export function createCatalogLoader(sources) {
  /** @type {Map<string, Promise<unknown>>} */
  const pending = new Map();
  return {
    /** @param {string} locale */
    load(locale) {
      const existing = pending.get(locale);
      if (existing) return existing;
      const source = sources[locale];
      if (!source)
        return Promise.reject(new Error(`Unsupported locale: ${locale}`));
      inFlight++;
      const result = Promise.resolve()
        .then(source)
        .then(({ default: catalog }) => catalog)
        .finally(() => {
          inFlight--;
        });
      pending.set(locale, result);
      result.catch(() => {
        if (pending.get(locale) === result) pending.delete(locale);
      });
      return result;
    },
  };
}

export const catalogLoader = createCatalogLoader(loaders);
