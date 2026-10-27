// Request-scoped locale storage, server half. See `$lib/request-locale.js` for
// why this exists.
//
// AsyncLocalStorage (rather than Svelte context) because the locale is read
// from plain modules as well as components — `t()` in `$lib/i18n`,
// `translateMessage()` in `$lib/i18n-message`, `$lib/meta`, service and store
// modules — none of which have a component context to read from. ALS also
// survives `await`, which is the whole point: the store propagates through the
// entire async call tree of one request and cannot be observed by another.
//
// This module is under `$lib/server/` so SvelteKit refuses to bundle it into
// the client, where `node:async_hooks` does not exist.

import { AsyncLocalStorage } from "node:async_hooks";

import { setRequestLocaleResolver } from "../request-locale.js";

/** @type {AsyncLocalStorage<string>} */
const localeStorage = new AsyncLocalStorage();

// Importing this module is what arms `getRequestLocale()`. `hooks.server.ts`
// imports it, so every server request path has it registered.
setRequestLocaleResolver(() => localeStorage.getStore() ?? null);

/**
 * Run `fn` with `locale` bound as the active request locale. Everything `fn`
 * awaits, synchronously or otherwise, sees this locale and only this locale.
 *
 * @template T
 * @param {string} locale
 * @param {() => T} fn
 * @returns {T}
 */
export function withRequestLocale(locale, fn) {
  return localeStorage.run(locale, fn);
}
