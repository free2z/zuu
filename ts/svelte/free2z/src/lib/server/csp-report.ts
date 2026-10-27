/**
 * Collector for `Content-Security-Policy-Report-Only` violations.
 *
 * THREAT MODEL FIRST. This endpoint is unauthenticated, cross-origin-postable
 * and exists only to write to a log, which makes it three things at once: a
 * log-injection sink, a logging-cost amplifier, and a cheap way to bury the
 * signal it was built to collect. Anyone can POST anything here as many times
 * as they like; the browser sends no cookie we can trust and no token we can
 * check, because a violation report is issued by the user agent, not by our
 * code. So every bound below is enforced on the assumption that the body is
 * hostile and the sender is not a browser:
 *
 *   - Bodies over MAX_BODY_BYTES are dropped unread past that prefix.
 *   - Every string is stripped of control characters and truncated.
 *   - `original-policy` (the single largest field, and one we already know)
 *     is never logged.
 *   - Query strings are stripped from our own page URLs, because CSP's report
 *     sanitization keeps them and ours carry bearer tokens (see redactUrl).
 *   - Identical violations are counted, not repeated: one page load can emit
 *     dozens of copies of one problem.
 *   - A per-process, per-window ceiling caps how many distinct lines any
 *     amount of traffic can produce.
 *
 * EVERY FIELD IN A REPORT IS ATTACKER-FORGEABLE. There is no credential on a
 * violation report, so nothing here distinguishes one a browser generated
 * from one somebody typed. These log lines are a LEAD — "look at this page" —
 * never evidence, and an empty inventory is not proof that a strict policy is
 * safe to enforce. Read them alongside what the site actually renders.
 *
 * The counters are per PROCESS, not per pod and not global. That is a
 * deliberate acceptance, not an oversight: there are three new-ui replicas
 * behind a Service, so the true worst case is 3x these numbers, and 3x a
 * bounded small number is still bounded and small. Anything shared would need
 * Redis on the path of a request whose entire value is "write one log line".
 */

/**
 * 8 KiB. A real CSP violation report is a few hundred bytes; the largest
 * legitimate field is `original-policy`, which is a copy of a policy we
 * ourselves emit and is under 400 bytes. 8 KiB is ~20x headroom and still far
 * too small to be worth using as an upload channel.
 *
 * nginx caps the same request at 16k (`location = /csp-report`), which is the
 * bound that matters for bandwidth because it rejects before the body is
 * read. This one is defence in depth for any path that does not traverse that
 * nginx — a direct hit on the pod IP, a port-forward, a future ingress.
 */
export const MAX_BODY_BYTES = 8192;

/**
 * How far past MAX_BODY_BYTES we will politely read and discard so the sender
 * gets a 413 rather than a connection reset. 1 MiB is ~128x the cap and ~2000x
 * a real report: generous to a misconfigured client, meaningless as a
 * bandwidth amplifier.
 */
export const MAX_DRAIN_BYTES = 1024 * 1024;

/** Per-field cap. Long enough to identify a script, short enough to be safe. */
export const MAX_FIELD_CHARS = 256;

/** Rolling window for both the report ceiling and the dedupe table. */
export const WINDOW_MS = 60_000;

/**
 * At most 60 distinct violation lines per process per minute. Sized so that a
 * genuinely broken deploy is fully visible (a handful of distinct violations
 * repeated everywhere collapses to a handful of lines) while a flood cannot
 * cost more than one line per second per process.
 */
export const MAX_REPORTS_PER_WINDOW = 60;

/**
 * Distinct dedupe keys retained per window. Bounds the memory an attacker can
 * pin by varying `blocked-uri`: 200 keys x ~3 truncated fields x 256 chars is
 * well under a megabyte, and the table is dropped whole when the window
 * rolls, so it cannot grow across windows.
 */
export const MAX_DEDUPE_KEYS = 200;

/**
 * Envelopes honoured from a SINGLE request.
 *
 * `report-uri` sends exactly one violation per POST; the Reporting API
 * batches, but into small groups. Without a cap, one 8 KiB body holding 60
 * minimal `csp-violation` envelopes consumes the ENTIRE window's allowance in
 * a single request — far below the arrival rate nginx limits — and every
 * genuine violation for the rest of that minute is silently suppressed. That
 * is not merely noisy: it lets an attacker bury the report their own XSS
 * payload would have produced, or make the inventory look clean right before
 * someone flips the policy to enforcing on the strength of it.
 *
 * 10 leaves the legitimate batch case untouched and forces an attacker to
 * spend six requests to do what one used to, against a 5r/s per-client
 * limit_req. Found by the codex adversarial review of.
 */
export const MAX_REPORTS_PER_REQUEST = 10;

export interface NormalizedCspReport {
  documentUri: string;
  blockedUri: string;
  effectiveDirective: string;
  sourceFile: string;
  lineNumber: number | null;
  columnNumber: number | null;
  sample: string;
  disposition: string;
}

/**
 * Strip C0/C1 control characters and truncate.
 *
 * The log line is emitted through `JSON.stringify`, which already escapes
 * newlines, so this is not the only thing standing between a hostile
 * `blocked-uri` and a forged log entry. It is here because "the serializer
 * escapes it" is a property of today's call site, and a field that is
 * structurally incapable of carrying a control character stays safe if
 * someone later logs it with string concatenation.
 */
export function sanitizeField(value: unknown): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return stripped.length > MAX_FIELD_CHARS
    ? stripped.slice(0, MAX_FIELD_CHARS)
    : stripped;
}

function sanitizeLine(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Drop the query string from one of OUR OWN page URLs before it is logged.
 *
 * CSP's own report sanitization (CSP3 5.4, "strip url for use in reports")
 * removes the fragment and any userinfo — and KEEPS the path and query. So a
 * violation on `/reset-password?token=<live one-day bearer token>` reports
 * that URL in full, and the known mode-watcher violation fires on every page,
 * including that one. Logging it verbatim would deposit a working
 * account-takeover credential into Cloud Logging, where it long outlives the
 * page view, and the 256-character field cap does not help because the token
 * fits comfortably inside it.
 *
 * The path is kept because it is the whole diagnostic value of the field —
 * "which page" is the question a violation report exists to answer — and
 * because our secrets live in query parameters, not path segments. The one
 * shape that is not covered is a secret embedded IN a path; `/{username}/
 * private/{vanity}` is a private page but its vanity is not a bearer
 * credential (access is decided server-side, per viewer).
 *
 * `blockedUri` is deliberately NOT passed through here: for a script-src
 * violation it names the resource that was refused, which is the primary
 * evidence, and an injected `https://evil.example/x.js?exfil=...` is a finding
 * whose query string IS the point.
 */
export function redactUrl(value: unknown): string {
  const raw = sanitizeField(value);
  if (!raw) return "";

  try {
    const url = new URL(raw);
    // ONLY http(s) is rebuilt from parts. For any other scheme `origin` is the
    // string "null" and `pathname` is opaque, so `origin + pathname` turns the
    // very common `about:blank` (what a browser reports for an iframe or a
    // srcdoc document) into the nonsense "nullblank". Caught by the test
    // below, which is the only reason this branch exists.
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("not an http(s) url");
    }
    // Rebuilt from parts rather than string-chopped: `?` can legally appear
    // inside a fragment or be percent-encoded elsewhere, and href.split("?")
    // gets both wrong.
    return url.search
      ? `${url.origin}${url.pathname}?<redacted>`
      : `${url.origin}${url.pathname}`;
  } catch {
    // Not an absolute URL — `document-uri` can be "about:blank", "inline",
    // or a relative reference depending on browser and context. Fall back to
    // a conservative cut so an unparseable value cannot smuggle a query
    // through the branch that was supposed to remove it.
    const cut = raw.indexOf("?");
    return cut === -1 ? raw : `${raw.slice(0, cut)}?<redacted>`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize both wire formats a browser may use.
 *
 * `report-uri` produces `application/csp-report`: a single object wrapped in a
 * `"csp-report"` key with hyphenated field names. `report-to` (the Reporting
 * API) produces `application/reports+json`: an ARRAY of envelopes with a
 * `body` and camelCase field names. We only configure `report-uri`, but
 * browsers have historically been inconsistent about which they send for a
 * policy carrying both, and a collector that understands only one silently
 * discards the other. Parsing both costs nothing.
 *
 * Returns [] for anything unrecognized rather than throwing: this endpoint
 * must never turn malformed input into a 500, because a 500 is itself a log
 * line an attacker controls the rate of.
 */
export function normalizeReports(payload: unknown): NormalizedCspReport[] {
  const envelopes: unknown[] = Array.isArray(payload) ? payload : [payload];
  const out: NormalizedCspReport[] = [];

  for (const envelope of envelopes) {
    // Counted on OUTPUT, not on input length: an array of 10,000 nulls must
    // cost 10,000 cheap type checks, not 10,000 normalizations, and it must
    // not be able to push a real report past the cap either.
    if (out.length >= MAX_REPORTS_PER_REQUEST) break;
    if (!isRecord(envelope)) continue;

    // Reporting API envelope: {type: "csp-violation", body: {...}}
    const reportingApiBody =
      envelope.type === "csp-violation" && isRecord(envelope.body)
        ? envelope.body
        : null;
    // Legacy report-uri envelope: {"csp-report": {...}}
    const legacyBody = isRecord(envelope["csp-report"])
      ? (envelope["csp-report"] as Record<string, unknown>)
      : null;

    const body = reportingApiBody ?? legacyBody;
    if (!body) continue;

    out.push({
      documentUri: redactUrl(body["document-uri"] ?? body.documentURL),
      blockedUri: sanitizeField(body["blocked-uri"] ?? body.blockedURL),
      effectiveDirective: sanitizeField(
        body["effective-directive"] ??
          body.effectiveDirective ??
          body["violated-directive"],
      ),
      sourceFile: redactUrl(body["source-file"] ?? body.sourceFile),
      lineNumber: sanitizeLine(body["line-number"] ?? body.lineNumber),
      columnNumber: sanitizeLine(body["column-number"] ?? body.columnNumber),
      sample: sanitizeField(body["script-sample"] ?? body.sample),
      disposition: sanitizeField(body.disposition),
      // `original-policy` is deliberately not carried. It is the largest
      // field in the payload and it is a copy of a policy this repo already
      // contains, so logging it buys nothing and multiplies the cost of every
      // line by roughly five.
    });
  }

  return out;
}

/**
 * Fixed-window limiter with in-window de-duplication.
 *
 * A class rather than module state so the tests can drive a clock and a fresh
 * instance instead of reaching into globals — and so a second collector could
 * exist without the two silently sharing a budget.
 */
export class CspReportLimiter {
  #windowStart = 0;
  #logged = 0;
  #suppressed = 0;
  #seen = new Map<string, number>();

  /**
   * @param now Milliseconds. Injected so the window logic is testable without
   *   sleeping; production passes `Date.now()`.
   * @returns `log` when the caller should emit a line, plus the number of
   *   reports suppressed since the last emitted line (0 unless a window just
   *   rolled), so the summary rides along on a line that is being written
   *   anyway rather than needing a timer of its own.
   */
  admit(
    report: NormalizedCspReport,
    now: number,
  ): { log: boolean; suppressed: number } {
    let suppressed = 0;

    if (now - this.#windowStart >= WINDOW_MS) {
      suppressed = this.#suppressed;
      this.#windowStart = now;
      this.#logged = 0;
      this.#suppressed = 0;
      this.#seen = new Map();
    }

    // WHAT IS AND IS NOT IN THE KEY MATTERS MORE THAN IT LOOKS.
    //
    // Excluded: documentUri, sourceFile and lineNumber. One broken inline
    // script is ONE problem whether it fires on ten zPages or ten thousand,
    // and all three of those vary per page - sourceFile IS the document URL
    // for an inline violation, and the line number moves with whatever
    // per-page <head> content sits above it. Keying on them would defeat the
    // dedupe entirely for exactly the violation class we expect most of, and
    // would hand an attacker a way to mint unlimited keys with a query
    // string. They are still LOGGED on the first occurrence; they just do not
    // decide whether it is the first.
    //
    // Included: `sample`, which is why `'report-sample'` is in the policy.
    // It is the only field that distinguishes one inline script from another,
    // so without it the known mode-watcher violation and a real injected
    // payload would collapse into the same key and the payload would never be
    // logged.
    const key = `${report.effectiveDirective} ${report.blockedUri} ${report.sample}`;

    const seenCount = this.#seen.get(key);
    if (seenCount !== undefined) {
      this.#seen.set(key, seenCount + 1);
      this.#suppressed += 1;
      return { log: false, suppressed };
    }

    if (this.#logged >= MAX_REPORTS_PER_WINDOW) {
      this.#suppressed += 1;
      return { log: false, suppressed };
    }

    // Past the key ceiling we stop recording NEW keys but still count them as
    // suppressed. Falling through to "log it anyway" would hand an attacker
    // an unbounded line count through unbounded key variety, which is the
    // exact thing the ceiling exists to stop.
    if (this.#seen.size >= MAX_DEDUPE_KEYS) {
      this.#suppressed += 1;
      return { log: false, suppressed };
    }

    this.#seen.set(key, 1);
    this.#logged += 1;
    return { log: true, suppressed };
  }
}

/**
 * Read at most `MAX_BODY_BYTES` from a request body.
 *
 * Streaming with a running byte count rather than `await request.text()`:
 * text() buffers whatever arrives before we can look at it, so a 500 MB POST
 * is 500 MB of this pod's heap before any limit we could apply. `Content-
 * Length` is not trusted for the same reason it never is — a chunked request
 * has none, and a lying one is trivial.
 *
 * Returns `null` when the body exceeds the cap, so the caller can answer 413
 * instead of guessing at a truncated JSON document.
 *
 * PAST THE CAP WE KEEP READING AND THROW THE BYTES AWAY, rather than
 * cancelling the stream. Cancelling mid-upload destroys the socket, and the
 * client sees a connection reset instead of the 413 that explains what
 * happened — measured, not assumed: the first version of this cancelled, and
 * the browser-level test got `socket hang up` where it expected a status.
 * Discarding is O(1) memory, so the thing the cap exists to protect is
 * protected either way.
 *
 * MAX_DRAIN_BYTES stops that politeness from becoming its own tarpit: an
 * endless stream would otherwise hold this request forever out of courtesy to
 * the client sending it. Past that we do reset, because at 1 MiB on an
 * endpoint whose entire payload is a few hundred bytes the sender is not a
 * browser having a bad day.
 */
export async function readBoundedBody(
  request: Request,
): Promise<string | null> {
  const body = request.body;
  if (!body) return "";

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  let oversized = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;

      if (total > MAX_BODY_BYTES) {
        oversized = true;
        text = "";
        if (total > MAX_DRAIN_BYTES) {
          await reader.cancel().catch(() => {});
          return null;
        }
        continue;
      }

      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // A client that disconnects mid-body is not an error worth a log line.
    return null;
  }

  if (oversized) return null;

  text += decoder.decode();
  return text;
}

/**
 * Build the structured line written to stdout.
 *
 * Separated from the emit so a test can assert the exact shape without
 * capturing console output, and so the field allowlist is visible in one
 * place. `csp_report` is the grep handle in Cloud Logging.
 */
export function formatReportLine(
  report: NormalizedCspReport,
  suppressed: number,
): string {
  return JSON.stringify({
    event: "csp_report",
    // Names the experiment in the log so these lines are separable from any
    // future enforced-policy reporting.
    policy: "report-only",
    ...report,
    ...(suppressed > 0 ? { suppressedSinceLastLine: suppressed } : {}),
  });
}
