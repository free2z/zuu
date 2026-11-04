/**
 * Importing an application SOURCE module from inside a page, safely.
 *
 * Several specs reach into the app's own module graph -- `import('/src/lib/
 * stores/privacy.ts')` -- to drive a store directly instead of clicking six
 * screens to reach the same state. That is a legitimate and deliberate hook,
 * and this module does not change what any of them assert. It fixes the one
 * way that hook fails for reasons that have nothing to do with the branch
 * under test:
 *
 *     ReferenceError: __SVELTEKIT_APP_VERSION__ is not defined
 *
 * WHY THAT HAPPENS. `$app/environment` re-exports
 * `@sveltejs/kit/src/runtime/app/env/internal.js`, whose very first line is
 * `export const version = __SVELTEKIT_APP_VERSION__;` -- a BARE GLOBAL, read
 * at module-evaluation time. In a production build Vite text-replaces it. In
 * DEV it does not: vite's `vite:define` plugin returns immediately for client
 * transforms (`if (!ssr && !isBuild) return`), and the values are shipped
 * instead as real globals that `/@vite/env` assigns onto `window` when the
 * page loads. Every module under `/src` that touches `$app/environment` --
 * `privacy.ts` and `auth.ts` both do -- therefore depends on a global that
 * exists only once Vite's own client script has run in THAT document.
 *
 * Normally it has: `page.goto()` resolves on `load`, and module scripts run
 * before that. The failure is a race with a reload nobody asked for. Vite
 * re-optimizes dependencies whenever a navigation discovers an import it has
 * not pre-bundled, and it recovers by forcing a full page reload. An
 * `evaluate()` issued against the page lands in the fresh document, which may
 * not have executed `/@vite/env` yet -- so the import resolves, the module
 * evaluates, and the bare global is not there. It is intermittent because it
 * depends on which specs ran first and warmed the optimizer, which is exactly
 * why it reads as unrelated noise on whatever PR happens to catch it.
 *
 * THE FIX is to wait, inside the page and in the same evaluation, for the dev
 * client to have installed its globals before importing. Waiting in Node
 * instead would reintroduce the race, because a reload can happen between the
 * wait and the import.
 *
 * Usage -- the loader source is a plain string, so it must be passed as an
 * `evaluate` ARGUMENT (an evaluate callback is serialized and cannot close
 * over module scope):
 *
 *     await page.evaluate(async (loader) => {
 *       const { privacyStore } = await new Function(loader)();
 *       privacyStore.trustDomain("video.example");
 *     }, PRIVACY_STORE_LOADER);
 */

/** How long to wait for `/@vite/env` before giving up and importing anyway. */
export const DEV_DEFINES_TIMEOUT_MS = 10_000;

/**
 * Statements that resolve once Vite's dev-time define globals are installed.
 *
 * BOUNDED ON PURPOSE. If the globals never arrive we fall through and import
 * anyway, so the failure reproduces as the original `ReferenceError` -- which
 * names the problem -- rather than as a spec that times out with no message.
 * An unbounded wait would trade a legible error for an illegible one.
 *
 * Exported separately so tests/dev-source-module.test.mjs can execute THIS
 * code rather than a paraphrase of it.
 */
export function devDefinesReadySource(
  timeoutMs: number = DEV_DEFINES_TIMEOUT_MS,
): string {
  return `
    const deadline = Date.now() + ${Number(timeoutMs)};
    while (
      typeof __SVELTEKIT_APP_VERSION__ === "undefined" &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }`;
}

/**
 * Build the body of a `new Function(...)` that resolves to the dev-server
 * module at `specifier`.
 *
 * `new Function` rather than a literal `import()` because Vite must not
 * statically analyse and rewrite the specifier at build time -- the point is
 * to fetch it through the dev server exactly as written.
 */
export function devSourceModuleLoader(
  specifier: string,
  timeoutMs: number = DEV_DEFINES_TIMEOUT_MS,
): string {
  return `return (async () => {${devDefinesReadySource(timeoutMs)}
    return import(${JSON.stringify(specifier)});
  })()`;
}

export const PRIVACY_STORE_LOADER = devSourceModuleLoader(
  "/src/lib/stores/privacy.ts",
);

export const AUTH_STORE_LOADER = devSourceModuleLoader(
  "/src/lib/stores/auth.ts",
);

export const EVENT_NOTIFICATIONS_LOADER = devSourceModuleLoader(
  "/src/lib/stores/eventNotifications.ts",
);

export const SONNER_LOADER = devSourceModuleLoader(
  "/src/lib/components/ui/sonner/index.ts",
);
