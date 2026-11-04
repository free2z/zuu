/**
 * The Report-Only counterpart to the enforced production CSP.
 *
 * WHERE THE ENFORCED POLICY LIVES: `k8s/free2z/backend-config.yaml`, as a GCLB
 * `customResponseHeaders` entry. It is a STATIC string stamped on every
 * response by the load balancer, which is precisely why it cannot be fixed
 * there: a nonce has to change per request, and the load balancer has no
 * per-request state. That header carries
 * `script-src 'self' 'unsafe-inline' 'unsafe-eval'...`, so today the CSP
 * contributes nothing against injected inline script — the one class the
 * markdown sanitizer exists to stop.
 *
 * WHAT THIS IS: the same `script-src`, minus `'unsafe-inline'` and
 * `'unsafe-eval'`, delivered as `Content-Security-Policy-Report-Only` by
 * SvelteKit (`svelte.config.js` -> `kit.csp.reportOnly`), which DOES have
 * per-request state and therefore can mint a nonce and stamp it on its own
 * inline bootstrap. Report-Only never blocks anything, so the worst case of
 * getting this wrong is noise in a log, not a dead site.
 *
 * ONE VARIABLE, ON PURPOSE. This policy declares `script-src` and nothing
 * else. Multiple CSP headers are enforced as an INTERSECTION — every policy
 * must allow a resource — so the enforced GCLB header still governs
 * `connect-src`, `img-src`, `frame-src` and the rest exactly as before, and
 * every report that arrives here is attributable to exactly one question:
 * "what breaks when script-src loses 'unsafe-inline' and 'unsafe-eval'?"
 * Mirroring all fourteen directives instead would have doubled the policy in
 * a second file, invited drift between the two, and made every report
 * ambiguous.
 *
 * WHAT THE INVENTORY FOUND before this shipped (see the PR for ):
 *   - Two hand-written inline <script> blocks in src/app.html. Both now carry
 *     `nonce="%sveltekit.nonce%"`, so they satisfy this policy.
 *   - SvelteKit's own inline hydration bootstrap. Kit nonces it itself once
 *     any `script-src` without `'unsafe-inline'` is configured.
 *   - Three `application/ld+json` blocks emitted through `{@html}`
 *     (SeoHead.svelte, article/[id], [username]/[vanity]). These are HTML
 *     "data blocks", not scripts: the "prepare the script element" algorithm
 *     bails before the CSP check for a non-JS type, so they should NOT
 *     report. They are the single most likely surprise here, which is a
 *     reason to measure rather than to assume.
 *   - `mode-watcher`'s `setInitialMode` bootstrap, injected as a bare inline
 *     `<script>` by `<ModeWatcher />`. THIS IS THE ONE THING THAT BLOCKS AN
 *     ENFORCING POLICY. It is found by measurement, not by reading: it does
 *     not appear anywhere in this repo's source. mode-watcher 1.1.0 does
 *     accept a `nonce` prop, but SvelteKit has no supported way to hand a
 *     component the nonce it minted — it is generated inside kit's render,
 *     after every load function has run — so the prop cannot be filled today.
 *     Do NOT "fix" this by pattern-matching the tag in `transformPageChunk`
 *     and stamping the nonce on any un-nonced script: a sanitizer bypass
 *     could then name its function `setInitialMode` and be handed the nonce,
 *     which inverts the whole control. The real options are to hash the
 *     script into the policy, or to move the theme bootstrap into app.html
 *     where we own the tag and can nonce it. Either is a separate change.
 *   - ZERO real `eval` / `new Function` call sites in the built client
 *     bundle. The only matches are lodash's
 *     `root = freeGlobal || freeSelf || Function('return this')()` global
 *     probe (mermaid's dependency tree) and an identical one in
 *     resize-observer-polyfill, both short-circuited by `freeSelf` in any
 *     browser. `'unsafe-eval'` therefore looks unnecessary — but "the
 *     fallback branch is unreachable" is a claim about code that is shipped
 *     and could be reached, so it is stated here as a hypothesis this policy
 *     is designed to test, not as a settled fact.
 */

/**
 * Where violation reports are POSTed.
 *
 * THIS IS A TOP-LEVEL PATH, SO IT IS A CLAIM ON THE USERNAME NAMESPACE.
 * `/{username}` is a real route, so an nginx `location = /csp-report` would
 * shadow a creator who registered that name. `csp-report` is therefore in
 * `FORBIDDEN_USERNAMES` (py/dj/apps/g12f/usernames.py) alongside `healthz`
 * and the other nginx-owned routes, and in that module's test parametrize
 * list. Do not move this path without moving those.
 */
export const CSP_REPORT_PATH = "/csp-report";

/**
 * `script-src` for the Report-Only policy: the production allowlist verbatim,
 * with `'unsafe-inline'` and `'unsafe-eval'` removed.
 *
 * Values are UNQUOTED here. SvelteKit adds the quotes for keywords it knows
 * (`self`, `unsafe-inline`, `strict-dynamic`,...) and for `nonce-`/`sha256-`
 * sources; writing `"'self'"` would emit `''self''` and silently produce a
 * policy that allows nothing from the origin.
 *
 * KEPT DELIBERATELY IDENTICAL to the enforced list, including entries that
 * look wrong. `https://platform.twitter.com` is NOT here and NOT in the
 * enforced policy either. Tweet embeds use X's self-contained iframe now
 *, so the parent page does not need to load X's widget script.
 * Adding the host here would be a policy change smuggled into a measurement.
 */
/** @type {("self" | "report-sample" | `${string}:` | `https://${string}.${string}`)[]} */
export const REPORT_ONLY_SCRIPT_SRC = [
  "self",
  // NOT a relaxation, and the one deliberate difference from the enforced
  // list. `'report-sample'` changes nothing about what is allowed; it asks the
  // browser to include the first ~40 characters of a blocked inline script in
  // the report. Without it, every inline violation reads "something inline was
  // refused at line N of a minified SSR document" — anonymous, and impossible
  // to tell apart from the next one. We already know at least one inline
  // violation fires on EVERY page load (see the mode-watcher note above), so
  // the ability to distinguish "the one we know about" from "a payload in
  // someone's markdown" is the entire value of collecting these at all.
  "report-sample",
  // The enforced policy allows blob: script URLs. Mirrored rather than
  // tightened: dropping it would mix a second variable into the experiment.
  "blob:",
  "https://*.iframe.ly",
  "https://*.iframely.net",
  "https://www.google.com",
  "https://www.gstatic.com",
  "https://plausible.io",
  "https://cdn.jsdelivr.net",
  "https://js.stripe.com",
];
