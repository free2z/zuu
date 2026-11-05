// Explicit import targets allow Vite to emit one content-hashed chunk per catalog.
// This loader does not select a locale or modify request/browser state.
let inFlight = 0;
export function isCatalogLoadInFlight() {
  return inFlight > 0;
}
const pseudoEnabled =
  typeof __PSEUDO_LOCALES__ !== "undefined" && __PSEUDO_LOCALES__;
const loaders = {
  en: () => import("./locales/en.json"),
  es: () => import("./locales/es.json"),
  fr: () => import("./locales/fr.json"),
  "pt-BR": () => import("./locales/pt-BR.json"),
  ...(pseudoEnabled
    ? Object.fromEntries(
        [
          ["en-XA", "expand"],
          ["en-XB", "accent"],
          ["ar-XB", "rtl"],
        ].map(([tag, mode]) => [
          tag,
          async () => {
            const [{ default: english }, { pseudoCatalog }] = await Promise.all(
              [import("./locales/en.json"), import("./pseudo-locales.js")],
            );
            return {
              default: pseudoCatalog(
                english,
                /** @type {"expand" | "accent" | "rtl"} */ (mode),
              ),
            };
          },
        ]),
      )
    : {}),
};

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
