/**
 * Narrow jsdom internals used by the sanitizer retention regressions.
 *
 * The checked dependency lines are isomorphic-dompurify 4.4.x/jsdom 30.0.x
 * and 4.5.x/jsdom 30.1.x. jsdom 30.0.x exposes implementation objects via a
 * `Symbol(impl)` wrapper property; 30.1.x moved them behind private fields and
 * exports `implForWrapper` from a different internal utility module. Resolve
 * the utility relative to isomorphic-dompurify so this follows its actual
 * transitive jsdom rather than an unrelated top-level copy.
 *
 * This is intentionally private-API-coupled. A changed layout must fail with
 * an actionable error so the retention tests are re-derived; silently
 * returning an empty listener map or missing window would make the regression
 * tests pass without observing the leak.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const requireFromIsomorphicDOMPurify = createRequire(
  require.resolve("isomorphic-dompurify"),
);
const utilityCandidates = [
  "jsdom/lib/jsdom/living/generated/utils.js",
  "jsdom/lib/generated/idl/utils.js",
];

let jsdomUtils;
let resolvedUtilsPath;
for (const candidate of utilityCandidates) {
  try {
    jsdomUtils = requireFromIsomorphicDOMPurify(candidate);
    resolvedUtilsPath = candidate;
    break;
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
  }
}

assert.ok(
  jsdomUtils && typeof jsdomUtils.implForWrapper === "function",
  `unsupported jsdom internals: expected implForWrapper in ${utilityCandidates.join(" or ")}`,
);

export const jsdomVersion =
  requireFromIsomorphicDOMPurify("jsdom/package.json").version;
const supportedVersion = /^30\.(0|1)\./.exec(jsdomVersion);
assert.ok(
  supportedVersion,
  `unsupported jsdom ${jsdomVersion}; re-derive sanitizer leak controls for jsdom 30.0.x and 30.1.x`,
);
export const detachedParserDocumentsRetainNamedProperties =
  supportedVersion[1] === "0";

export function implementationFor(wrapper, label) {
  const implementation = jsdomUtils.implForWrapper(wrapper);
  assert.ok(
    implementation,
    `jsdom ${label} has no implementation via ${resolvedUtilsPath}`,
  );
  return implementation;
}

/** Reach isomorphic-dompurify's one process-wide jsdom Window wrapper. */
export function sharedWindow(DOMPurify) {
  const node = DOMPurify.sanitize("<p>x</p>", { RETURN_DOM: true });
  assert.ok(node, "RETURN_DOM gave us no node to walk back from");

  const ownerDocument = implementationFor(node, "node")._ownerDocument;
  assert.ok(ownerDocument, "node implementation has no _ownerDocument");

  const window = ownerDocument._globalObject;
  assert.ok(window, "owner document implementation has no _globalObject");
  implementationFor(window, "window");
  assert.equal(
    window.document.defaultView,
    window,
    "RETURN_DOM no longer leads back to isomorphic-dompurify's shared Window",
  );
  return window;
}

export function listenerCounts(window) {
  const listeners = implementationFor(window, "window")._eventListeners;
  assert.ok(
    listeners === null || (listeners && typeof listeners === "object"),
    "jsdom window implementation has no _eventListeners",
  );
  return Object.fromEntries(
    Object.entries(listeners ?? {})
      .map(([type, registered]) => [type, registered.length])
      .filter(([, count]) => count > 0),
  );
}
