/**
 * The language catalog, fetched from `GET /api/languages/` and cached.
 *
 * Why this module exists: `TRANSLATABLE_LANGUAGES` in `zpage-language.js` is a
 * hand-maintained mirror of `TRANSLATABLE` in `py/f2z/languages.py`, so today
 * **a language cannot ship without a frontend release** . The
 * catalog endpoint moves that decision to the backend. This module is the
 * client half: one fetch per naming locale, cached for the lifetime of the tab,
 * and a seed to fall back to when the request fails.
 *
 * Three rules it keeps.
 *
 * **The seed is a fallback, never the truth, and never the ceiling.** It is the
 * offline answer, and it is allowed to lag the API — that is the whole point.
 * It is also not the full list a picker shows: whatever languages the API
 * reports for a given *article* are always listed too, even outside the
 * sellable set (the `ja` case in ). This module only ever supplies the
 * `translatable` argument of `untranslatedLanguages`; the `extraLanguages`
 * union around it stays exactly as it was.
 *
 * **A failure is not an empty catalog — but an empty catalog is not a failure.**
 * Returning `[]` on a network blip would empty the language picker, which reads
 * as "we removed your language", so every failure path returns the seed. A
 * *well-formed* response carrying `languages: []`, on the other hand, is the
 * platform saying it sells no translations right now, and the seed must not
 * overrule it into offering 39 targets whose quotes the backend then refuses.
 * The line between them is the SHAPE of the response, not its length: no
 * `languages` array, or rows this client cannot parse at all, is malformed.
 *
 * **It never throws at a caller.** The picker is UI chrome; a catalog fetch
 * that rejects must degrade, not take the editor down with it.
 */

import { DEFAULT_LOCALE } from "./locale.js";
import {
  TRANSLATABLE_LANGUAGES,
  languageAutonym,
  languageDisplayName,
  languageMatchesQuery,
  normalizeContentLanguage,
} from "./zpage-language.js";

/**
 * @typedef {object} LanguageCatalogEntry
 * @property {string} tag Canonical BCP-47 tag.
 * @property {string | null} name Name in the catalog's locale. Always a string
 *   when it came from the API; may be `null` in the offline seed on an engine
 *   with a trimmed ICU build, because printing the raw tag is the  defect.
 * @property {string | null} autonym The name written in itself.
 * @property {string | null} script ISO 15924, or `null` for "no constraint".
 * @property {"ltr" | "rtl"} direction
 * @property {boolean} translatable Whether we sell a translation into it.
 */

/**
 * @typedef {object} LanguageCatalog
 * @property {string} locale The locale the names are in — the *resolved* one.
 * @property {readonly LanguageCatalogEntry[]} languages
 * @property {boolean} fromApi `false` when this is the offline seed. Callers
 *   that want to distinguish "we do not sell that" from "we could not ask"
 *   need this; nothing else can tell the two apart.
 */

/**
 * Scripts written right-to-left. Mirrors `RTL_SCRIPTS` in
 * `py/f2z/language_catalog.py`, and `tests/language-catalog.test.mjs` fails if
 * the two drift. It is only consulted for the offline seed — an API entry
 * carries the server's answer — but a seed that renders Arabic left-to-right
 * is the  bug arriving through the back door.
 */
export const RTL_SCRIPTS = Object.freeze([
  "Adlm",
  "Arab",
  "Aran",
  "Armi",
  "Avst",
  "Cprt",
  "Egyd",
  "Egyh",
  "Elym",
  "Hatr",
  "Hebr",
  "Hung",
  "Khar",
  "Lydi",
  "Mand",
  "Mani",
  "Marc",
  "Medf",
  "Mend",
  "Merc",
  "Mero",
  "Narb",
  "Nbat",
  "Nkoo",
  "Orkh",
  "Ougr",
  "Palm",
  "Phli",
  "Phlp",
  "Phnx",
  "Prti",
  "Rohg",
  "Samr",
  "Sarb",
  "Sogd",
  "Sogo",
  "Syrc",
  "Syre",
  "Syrj",
  "Syrn",
  "Thaa",
  "Yezi",
]);

const RTL_SCRIPT_SET = new Set(RTL_SCRIPTS);

/** How long a cached catalog stays fresh. Matches the endpoint's `max-age`. */
export const CATALOG_TTL_MS = 300_000;

/**
 * The script CLDR says a tag is written in, or `null`.
 *
 * `Intl.Locale.maximize()` is the same table `f2z.languages.likely_script`
 * reads on the server, which is why `zh-TW` answers `Hant` here too.
 *
 * @param {string} tag
 * @returns {string | null}
 */
function likelyScript(tag) {
  try {
    return new Intl.Locale(tag).maximize().script || null;
  } catch {
    // A tag `Intl.Locale` rejects constrains nothing.
    return null;
  }
}

/**
 * Text direction for a language tag, from its script.
 *
 * `"ltr"` for an unanswerable tag: "no constraint" has to render as something,
 * and it is not the same claim as "right to left".
 *
 * @param {unknown} code
 * @returns {"ltr" | "rtl"}
 */
export function languageDirection(code) {
  const tag = normalizeContentLanguage(code);
  if (!tag) return "ltr";
  return RTL_SCRIPT_SET.has(likelyScript(tag) ?? "") ? "rtl" : "ltr";
}

/**
 * The name and autonym to render for a language, given what the server said.
 *
 * This engine's own CLDR data wins: it is in the exact viewer locale and it is
 * what the picker has always shown. The served name is the **fallback**, and it
 * is the half that makes the catalog worth serving — without it a language is
 * visible only if the browser happens to know it, so a language added on the
 * server would still need a client that has heard of it, and on an engine with
 * a trimmed ICU build most of the list disappears.
 *
 * `name` is `null` when neither source can name it. Never the raw tag: printing
 * a subtag at a reader is the  defect, and a nameless row is dropped.
 *
 * @param {unknown} language
 * @param {string} [viewerLocale]
 * @param {{ name?: string | null, autonym?: string | null } | null} [served]
 * @returns {{ name: string | null, autonym: string | null }}
 */
export function describeLanguage(
  language,
  viewerLocale = DEFAULT_LOCALE,
  served = null,
) {
  const tag = normalizeContentLanguage(language);
  if (!tag) return { name: null, autonym: null };
  /** @param {unknown} value */
  const text = (value) =>
    typeof value === "string" && value.trim() ? value : null;
  return {
    name: languageDisplayName(tag, viewerLocale) ?? text(served?.name),
    autonym: languageAutonym(tag) ?? text(served?.autonym),
  };
}

/**
 * Does a picker row match what the creator typed?
 *
 * `languageMatchesQuery` searches the tag and every name **this engine** can
 * produce. That is the whole answer for a language the engine knows, and no
 * answer at all for one only the server can name: the row would be on screen,
 * showing a name and an autonym, and typing either of them would make it
 * vanish. So the rendered strings are searched too.
 *
 * @param {{ language: string, name?: string | null, autonym?: string | null }} entry
 * @param {string} query
 * @param {string} [viewerLocale]
 * @returns {boolean}
 */
export function languageEntryMatchesQuery(
  entry,
  query,
  viewerLocale = DEFAULT_LOCALE,
) {
  if (!entry) return false;
  if (languageMatchesQuery(entry.language, query, viewerLocale)) return true;
  const needle = String(query || "")
    .trim()
    .toLowerCase();
  if (!needle) return true;
  return [entry.name, entry.autonym].some(
    (value) =>
      typeof value === "string" && value.toLowerCase().includes(needle),
  );
}

/**
 * The offline catalog, built from the seed array with no network at all.
 *
 * Every entry is `translatable: true` because the seed *is* the sellable
 * mirror — which is exactly why it must not be treated as authoritative: the
 * API is what knows about a language added or demoted since this bundle was
 * built.
 *
 * @param {string} [locale] Locale to name the languages in.
 * @returns {LanguageCatalog}
 */
export function seedLanguageCatalog(locale = DEFAULT_LOCALE) {
  const viewer = locale || DEFAULT_LOCALE;
  /** @type {LanguageCatalogEntry[]} */
  const languages = [];
  for (const code of TRANSLATABLE_LANGUAGES) {
    const tag = normalizeContentLanguage(code);
    if (!tag) continue;
    languages.push({
      tag,
      name: languageDisplayName(tag, viewer),
      autonym: languageAutonym(tag),
      script: likelyScript(tag),
      direction: languageDirection(tag),
      translatable: true,
    });
  }
  // Ordered by the name the viewer reads, like the server's. `localeCompare`
  // with the viewer's locale, because alphabetical order is itself localized.
  languages.sort((a, b) =>
    (a.name ?? a.tag).localeCompare(b.name ?? b.tag, viewer),
  );
  return { locale: viewer, languages, fromApi: false };
}

/**
 * Coerce one API row into an entry, dropping anything unusable.
 *
 * A row whose tag this client cannot normalize is skipped rather than shown:
 * the picker would have to print the raw tag at a reader to display it,
 * and a tag we cannot canonicalize is one we could not send back on a write
 * either.
 *
 * @param {unknown} row
 * @returns {LanguageCatalogEntry | null}
 */
function toEntry(row) {
  if (!row || typeof row !== "object") return null;
  const raw = /** @type {Record<string, unknown>} */ (row);
  const tag = normalizeContentLanguage(raw.tag);
  if (!tag) return null;
  const direction = raw.direction === "rtl" ? "rtl" : "ltr";
  return {
    tag,
    name: typeof raw.name === "string" && raw.name ? raw.name : null,
    autonym:
      typeof raw.autonym === "string" && raw.autonym ? raw.autonym : null,
    script: typeof raw.script === "string" && raw.script ? raw.script : null,
    direction,
    // Absent means "the server did not say", and the catalog is the sellable
    // set, so absence reads as sellable. An explicit `false` is honoured.
    translatable: raw.translatable !== false,
  };
}

/**
 * The default transport: the orval-generated client.
 *
 * Imported lazily so this module can be unit-tested, and used from a plain
 * `.js` file, without dragging in the generated TypeScript client and
 * `@tanstack/svelte-query` behind it.
 *
 * @param {{ locale?: string }} params
 * @param {AbortSignal} [signal]
 * @returns {Promise<unknown>}
 */
async function generatedClientFetcher(params, signal) {
  const { languagesCatalog } = await import("./api/languages/languages");
  return languagesCatalog(params, undefined, signal);
}

/** How long to wait for the catalog before giving up and using the seed. */
export const CATALOG_TIMEOUT_MS = 10_000;

/**
 * Run `call` with an abort signal and a hard deadline.
 *
 * The deadline is the load-bearing half. A stalled response — a captive
 * portal, a half-open socket — leaves a promise that never settles, and the
 * de-duplication below would then hand that same never-settling promise to
 * every later caller. The picker's refetch-on-open recovery would join the
 * stall instead of recovering from it, for as long as the tab stayed open.
 * Aborting is the polite half; rejecting is what actually bounds it, because a
 * transport that ignores the signal must not be able to wedge this module.
 *
 * @param {(signal: AbortSignal | undefined) => Promise<unknown>} call
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
function withTimeout(call, timeoutMs) {
  if (!(timeoutMs > 0)) return call(undefined);
  const controller =
    typeof AbortController === "function" ? new AbortController() : null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  return Promise.race([
    call(controller?.signal),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new Error("language catalog timed out"));
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** @type {Map<string, { at: number, value: LanguageCatalog }>} */
const cache = new Map();
/** @type {Map<string, Promise<LanguageCatalog>>} */
const inFlight = new Map();

/** Drop everything cached. Tests use it; nothing in the app should need it. */
export function resetLanguageCatalogCache() {
  cache.clear();
  inFlight.clear();
}

/**
 * The catalog for a viewer locale — from cache, then the API, then the seed.
 *
 * Concurrent callers for the same locale share one request: the editor mounts
 * several components that all want the picker list, and four identical GETs on
 * every editor open is the thing an in-memory cache is for.
 *
 * @param {object} [options]
 * @param {string} [options.locale] Locale to name the languages in.
 * @param {(params: { locale?: string }, signal?: AbortSignal) => Promise<unknown>} [options.fetcher]
 *   Transport seam, for tests and for a caller that already has the payload.
 * @param {number} [options.ttlMs] Freshness window; `0` forces a refetch.
 * @param {number} [options.timeoutMs] Deadline for one request; `0` disables.
 * @param {() => number} [options.now] Clock seam.
 * @returns {Promise<LanguageCatalog>} Never rejects.
 */
export async function fetchLanguageCatalog({
  locale = DEFAULT_LOCALE,
  fetcher = generatedClientFetcher,
  ttlMs = CATALOG_TTL_MS,
  timeoutMs = CATALOG_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  const key = locale || DEFAULT_LOCALE;

  const hit = cache.get(key);
  if (hit && now() - hit.at < ttlMs) return hit.value;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = (async () => {
    try {
      const payload = await withTimeout(
        (signal) => fetcher({ locale: key }, signal),
        timeoutMs,
      );
      const rows = /** @type {{ languages?: unknown }} */ (payload ?? {})
        .languages;
      if (!Array.isArray(rows)) throw new Error("no languages in the catalog");
      const languages = rows.map(toEntry).filter(
        /** @returns {entry is LanguageCatalogEntry} */
        (entry) => entry !== null,
      );
      // Rows came back and NONE of them survived parsing: this client and that
      // server do not agree on what a language looks like, which is a failure
      // however healthy the transport was. An empty `languages` array is the
      // opposite — a well-formed answer meaning "nothing is on sale" — and is
      // carried through rather than overruled by the seed.
      if (rows.length > 0 && languages.length === 0) {
        throw new Error("no usable language in the catalog");
      }
      const resolved = /** @type {{ locale?: unknown }} */ (payload ?? {})
        .locale;
      /** @type {LanguageCatalog} */
      const value = {
        locale: typeof resolved === "string" && resolved ? resolved : key,
        languages,
        fromApi: true,
      };
      cache.set(key, { at: now(), value });
      return value;
    } catch {
      // Deliberately not cached: the next caller should get to try again,
      // and a cached failure would outlive the outage that caused it.
      return seedLanguageCatalog(key);
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, request);
  return request;
}

/**
 * The tags a picker may offer, in catalog order.
 *
 * This is what goes into `untranslatedLanguages({ translatable })`. It is
 * deliberately **only** the sellable half: the languages an article already
 * has are unioned in by that function's `extraLanguages`, so a variant outside
 * the sell list  stays visible.
 *
 * @param {LanguageCatalog | null | undefined} catalog
 * @returns {string[]}
 */
export function catalogTranslatableTags(catalog) {
  if (!catalog || !Array.isArray(catalog.languages)) {
    return [...TRANSLATABLE_LANGUAGES];
  }
  const tags = catalog.languages
    .filter((entry) => entry && entry.translatable !== false)
    .map((entry) => entry.tag);
  // A catalog the API answered with, in which nothing is sellable, is an
  // ANSWER — "we are not selling translations right now" — and the seed must
  // not overrule it into offering 39 targets whose quotes the backend then
  // refuses. An empty *seed-derived* catalog is a different thing: it means
  // this function was handed something broken, and the seed is the answer.
  if (tags.length === 0 && catalog.fromApi !== true) {
    return [...TRANSLATABLE_LANGUAGES];
  }
  return tags;
}
