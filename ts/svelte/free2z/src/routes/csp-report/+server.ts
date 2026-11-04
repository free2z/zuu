import type { RequestHandler } from "./$types";
import {
  CspReportLimiter,
  formatReportLine,
  normalizeReports,
  readBoundedBody,
} from "$lib/server/csp-report";

/**
 * `report-uri` sink for the Report-Only CSP.
 *
 * The policy that points here is built in src/lib/csp-policy.js and attached
 * by kit from svelte.config.js. nginx routes this exact path to SvelteKit for
 * every client (`location = /csp-report`, k8s/free2z/nginx.conf) so a report
 * arrives whether or not the browser attached the f2z_ui cookie to it.
 *
 * ONLY POST IS EXPORTED, so kit answers 405 for everything else — this is not
 * a page, and it should not look like one to a scanner.
 *
 * CONTENT TYPE IS LOAD-BEARING, and not for parsing. SvelteKit's built-in CSRF
 * protection rejects a cross-origin POST with 403 when the Content-Type is one
 * of the three form types (`application/x-www-form-urlencoded`,
 * `multipart/form-data`, `text/plain`) — before this handler runs, with no log
 * line anywhere. Browsers send violation reports as `application/csp-report`
 * (report-uri), `application/reports+json` (report-to) or `application/json`,
 * none of which are on that list, so reports arrive. Verified against a
 * running production build, all three, plus the 403 for a form type. If a
 * future browser ever picked `text/plain`, this endpoint would go silently
 * dead rather than error — which is exactly why the statuses for the real
 * content types are pinned in tests/browser/csp-report-only.spec.ts.
 *
 * IT ALWAYS SUCCEEDS. A violation report is fire-and-forget; there is no
 * caller to inform and nothing to retry. Malformed JSON, an unrecognized
 * envelope and a perfectly good report all return 204, because the only thing
 * a status code could do here is tell an attacker which inputs cost us more
 * work. The single exception is 413, which is the honest answer to a body we
 * refused to read and is cheaper than pretending we consumed it.
 */

/**
 * One limiter for the lifetime of the process. Module scope is the right
 * scope: the budget must be shared by every request this process handles, and
 * SvelteKit gives a server module exactly one instance per process.
 */
const limiter = new CspReportLimiter();

export const POST: RequestHandler = async ({ request }) => {
  const raw = await readBoundedBody(request);

  if (raw === null) {
    return new Response(null, {
      status: 413,
      headers: { "cache-control": "no-store" },
    });
  }

  // Deliberately silent on failure. `JSON.parse` on a hostile 8 KiB string is
  // microseconds, and answering 400 would only confirm to a prober that the
  // endpoint parses what it is sent.
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return noContent();
  }

  const now = Date.now();
  for (const report of normalizeReports(payload)) {
    const { log, suppressed } = limiter.admit(report, now);
    if (log) {
      // stdout, one JSON object per line: that is what Cloud Logging ingests
      // from a container without any additional agent configuration. Not
      // console.error — a report-only violation is data being collected on
      // purpose, not an application error, and putting it on the error stream
      // would pollute the signal used for real ones.
      console.log(formatReportLine(report, suppressed));
    }
  }

  return noContent();
};

function noContent(): Response {
  return new Response(null, {
    status: 204,
    // A violation report is per-visitor, per-page evidence. Nothing about
    // this response is cacheable, and the CDN in front of it caches on origin
    // headers.
    headers: { "cache-control": "no-store" },
  });
}
