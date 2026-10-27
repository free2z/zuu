// Request-scoped locale lookup, browser-safe half.
//
// `$lib/i18n` holds the active locale in a module-scoped Svelte store. In the
// browser that is correct: one process, one user, one locale. On the server the
// same module instance is shared by every concurrent request in the Node
// process, so a store written by request A is readable by request B — a
// "wrong language served to the wrong user" bug waiting for the first `await`
// on the render path (issue ).
//
// The server half (`$lib/server/request-locale.js`) binds an AsyncLocalStorage
// to each request and registers it here. This module deliberately imports
// nothing from `node:` so that `$lib/i18n` — which is bundled for the browser —
// can depend on it. When no resolver is registered (browser, unit tests,
// prerender outside a request) `getRequestLocale()` returns null and callers
// fall back to the module-global store exactly as before.

/** @type {(() => string | null) | null} */
let resolveRequestLocale = null;

/**
 * Register the server-side request-locale resolver. Called once, at import
 * time, by `$lib/server/request-locale.js`.
 *
 * @param {(() => string | null) | null} resolver
 * @returns {void}
 */
export function setRequestLocaleResolver(resolver) {
  resolveRequestLocale = resolver;
}

/**
 * The locale of the request currently being handled, or null when there is no
 * request scope (the browser, or server code running outside `handle`).
 *
 * @returns {string | null}
 */
export function getRequestLocale() {
  return resolveRequestLocale ? resolveRequestLocale() : null;
}
