// Pure request-shaping helpers for the shared API client (mutator.ts).
//
// Kept as plain JS with no SvelteKit imports so `npm test` (node --test) can
// exercise them directly — mutator.ts itself imports `$app/env` and
// `$env/dynamic/public`, which only resolve inside a Vite/SvelteKit build.

/**
 * Values orval can emit for an optional header parameter. `new Headers({...})`
 * THROWS on a nullish value ("Invalid value"), so every entry has to be
 * filtered before it reaches the Headers constructor. Object spread used to
 * stringify these to "undefined" instead, which was wrong but silent.
 *
 * @param {Headers} target
 * @param {HeadersInit | undefined | null} source
 */
function assignHeaders(target, source) {
  if (!source) return;

  if (source instanceof Headers) {
    source.forEach((value, key) => target.set(key, value));
    return;
  }

  const entries = Array.isArray(source) ? source : Object.entries(source);
  for (const entry of entries) {
    if (!entry) continue;
    const [key, value] = entry;
    // Skip rather than stringify: an absent optional header must be absent.
    if (key == null || value == null) continue;
    target.set(String(key), String(value));
  }
}

/**
 * Merge the orval-generated request descriptor's headers with the caller's
 * request options.
 *
 * Precedence: generated headers are the base, the caller's explicit headers
 * win. `Headers` replaces case-insensitively, so `content-type` and
 * `Content-Type` can never both be emitted.
 *
 * This is the fix for: `customInstance` used to do
 * `headers: input.headers` while merging, which discarded the caller's
 * headers entirely — so the session cookie every `+page.server.ts` forwards
 * never reached the API and all SSR rendered anonymous.
 *
 * @param {HeadersInit | undefined | null} generatedHeaders
 * @param {HeadersInit | undefined | null} callerHeaders
 * @param {unknown} [body] resolved request body, used only to decide whether
 *   a default Content-Type is appropriate
 * @returns {Headers}
 */
export function mergeRequestHeaders(generatedHeaders, callerHeaders, body) {
  const headers = new Headers();
  assignHeaders(headers, generatedHeaders);
  assignHeaders(headers, callerHeaders);

  // fetch must generate the multipart boundary itself; any Content-Type we
  // set here (including orval's boundary-less "multipart/form-data") makes the
  // body unparseable server-side.
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    headers.delete("Content-Type");
    return headers;
  }

  // The JSON default is right for a string body (what every generated write
  // and every hand-rolled `body: JSON.stringify(...)` call site sends) and
  // harmless on a bodyless GET. It is actively wrong for a body that describes
  // its own encoding: labelling `URLSearchParams` as JSON makes Django reject
  // a form post that fetch would otherwise have typed correctly.
  if (!headers.has("Content-Type") && !isSelfTypedBody(body)) {
    headers.set("Content-Type", "application/json");
  }

  return headers;
}

/**
 * Body kinds fetch types for itself when no Content-Type is set.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isSelfTypedBody(value) {
  if (value == null || typeof value === "string") return false;
  if (
    typeof URLSearchParams !== "undefined" &&
    value instanceof URLSearchParams
  )
    return true;
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream)
    return true;
  if (value instanceof ArrayBuffer) return true;
  return ArrayBuffer.isView(value);
}

/**
 * @param {unknown} value
 * @returns {boolean} true when fetch can already use `value` as-is
 */
function isPreEncodedBody(value) {
  if (typeof value === "string") return true;
  if (typeof FormData !== "undefined" && value instanceof FormData) return true;
  return isSelfTypedBody(value);
}

/**
 * Map orval's `data` onto a `RequestInit.body`.
 *
 * orval hands the request payload to `customInstance` as `input.data`, which
 * is not a `RequestInit` key — so every generated write used to go out with an
 * empty body. Nothing in the app called a generated write with a payload
 * (the three that exist hand-roll `body` through request options, which is
 * why this stayed latent), but the next generated mutation would have failed
 * silently.
 *
 * An already-resolved `body` always wins, so those hand-rolled call sites are
 * untouched.
 *
 * @param {unknown} data value of the generated descriptor's `data` key
 * @param {BodyInit | null | undefined} existingBody the `body` the pre-existing
 *   descriptor/options merge produced, if any
 * @returns {BodyInit | null | undefined}
 */
export function resolveRequestBody(data, existingBody) {
  if (existingBody !== undefined) return existingBody;
  if (data === undefined) return undefined;
  if (isPreEncodedBody(data)) return /** @type {BodyInit} */ (data);
  return JSON.stringify(data);
}
