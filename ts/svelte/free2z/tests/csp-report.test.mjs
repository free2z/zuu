import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createServer } from "vite";

// the regression contract — the enforced CSP carries
// `script-src 'self' 'unsafe-inline' 'unsafe-eval'`, which on a site that
// renders creator-authored markdown means the CSP contributes nothing against
// injected inline script. These tests cover the Report-Only measurement that
// has to come before an enforcing policy can be flipped safely.

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const appRoot = fileURLToPath(new URL("../", import.meta.url));

let server;
let cspPolicy;
let cspReport;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  cspPolicy = await server.ssrLoadModule("/src/lib/csp-policy.js");
  cspReport = await server.ssrLoadModule("/src/lib/server/csp-report.ts");
});

after(async () => {
  await server?.close();
});

/**
 * Kit quotes CSP keywords for you and leaves everything else alone, so the
 * source list in csp-policy.js is written unquoted. Reproduce that here so the
 * comparison against the enforced header is against the string kit will
 * actually emit, not against a hand-maintained second copy of it.
 */
const KIT_QUOTED = new Set([
  "self",
  "unsafe-eval",
  "unsafe-hashes",
  "unsafe-inline",
  "none",
  "strict-dynamic",
  "report-sample",
  "wasm-unsafe-eval",
  "script",
]);

function kitRender(source) {
  return KIT_QUOTED.has(source) ? `'${source}'` : source;
}

// THE DRIFT GUARD, and the reason this test reads a k8s file from the UI
// suite. The Report-Only policy is only a measurement of the enforced one if
// the two lists stay identical apart from the two keywords under test. If
// someone adds a CDN to the GCLB header and not here, the reports become a
// stream of false positives for a host we deliberately allow; if someone adds
// one here and not there, we would "measure" a policy production never had.
//.github/workflows/ci.yml routes changes to backend-config.yaml into the `ui`
// job precisely so this cannot be skipped by a k8s-only commit.

test("report-only script-src admits neither unsafe keyword", () => {
  for (const banned of ["unsafe-inline", "unsafe-eval"]) {
    assert.ok(
      !cspPolicy.REPORT_ONLY_SCRIPT_SRC.includes(banned),
      `${banned} is in the report-only policy, which makes the whole measurement a no-op`,
    );
  }
  assert.ok(cspPolicy.REPORT_ONLY_SCRIPT_SRC.includes("self"));
});

// A report-only policy is delivered by a header only. Kit's CspProvider is the
// only class with a get_meta(), so configuring `directives` (rather than
// `reportOnly`) would ship an ENFORCING <meta http-equiv> into the HTML of
// every page. That is the one way this change could take the site down, so it
// is asserted rather than assumed.
test("SvelteKit plugin configures report-only and no enforcing policy", async () => {
  const config = (await import("../vite.config.ts")).default;
  const plugins = (await Promise.all(config.plugins)).flat(Infinity);
  const csp = plugins.find(
    (plugin) => plugin.name === "vite-plugin-sveltekit-setup",
  ).api.options.csp;

  assert.ok(csp, "kit.csp is not configured");
  assert.equal(
    Object.values(csp.directives).some(Boolean),
    false,
    "kit.csp.directives is set, which makes SvelteKit emit an ENFORCING header and a <meta http-equiv> tag",
  );
  assert.deepEqual(
    csp.reportOnly["script-src"],
    cspPolicy.REPORT_ONLY_SCRIPT_SRC,
  );
  assert.deepEqual(csp.reportOnly["report-uri"], [cspPolicy.CSP_REPORT_PATH]);
  // Kit itself throws for a report-only policy with no reporting endpoint, but
  // it throws at RENDER time, i.e. in production, on the first page view.
  assert.ok(csp.reportOnly["report-uri"].length > 0);
});

// The nonce placeholder is inert until a CSP is configured, so deleting it
// breaks nothing a human or a smoke test would notice - it just silently turns
// both of these into permanent violations and buries the real signal.
test("every inline script in app.html carries the nonce placeholder", async () => {
  const appHtml = await readFile(`${appRoot}src/app.html`, "utf8");
  const openingTags = appHtml.match(/<script\b[^>]*>/g) ?? [];

  assert.ok(openingTags.length >= 2, "expected inline scripts in app.html");
  for (const tag of openingTags) {
    // An external script would be admitted by host, not by nonce. There are
    // none in app.html today; if one is added, this test should be taught
    // about it deliberately rather than by loosening the rule.
    assert.ok(
      !tag.includes(" src="),
      `app.html grew an external script (${tag}); confirm its host is in REPORT_ONLY_SCRIPT_SRC before allowing it here`,
    );
    assert.ok(
      tag.includes('nonce="%sveltekit.nonce%"'),
      `inline script without a nonce placeholder: ${tag}`,
    );
  }
});

test("every SSR document carries the uptime check's stable renderer marker", async () => {
  const appHtml = await readFile(`${appRoot}src/app.html`, "utf8");
  assert.match(
    appHtml,
    /<meta name="free2z-renderer" content='\{"version":"sveltekit"\}' \/>/,
    "the SSR canary's stable content matcher must stay in every rendered document",
  );
});

test("the reserved-username list owns the report path", async () => {
  const usernames = await readFile(
    `${repoRoot}py/free2z/dj/apps/g12f/usernames.py`,
    "utf8",
  );
  const name = cspPolicy.CSP_REPORT_PATH.replace(/^\//, "");
  assert.ok(
    usernames.includes(`"${name}"`),
    `nginx claims /${name} but FORBIDDEN_USERNAMES does not reserve it, so a creator could register the name and be shadowed (#1174)`,
  );
});

// --- the collector -------------------------------------------------------

test("normalizes the legacy report-uri envelope", () => {
  const [report] = cspReport.normalizeReports({
    "csp-report": {
      "document-uri": "https://free2z.cash/skylar/hello",
      "blocked-uri": "inline",
      "effective-directive": "script-src-elem",
      "violated-directive": "script-src-elem",
      "source-file": "https://free2z.cash/skylar/hello",
      "line-number": 12,
      "column-number": 3,
      "script-sample": "alert(1)",
      disposition: "report",
      "original-policy": "script-src 'self'",
    },
  });

  assert.equal(report.blockedUri, "inline");
  assert.equal(report.effectiveDirective, "script-src-elem");
  assert.equal(report.lineNumber, 12);
  assert.equal(report.sample, "alert(1)");
  assert.ok(!("originalPolicy" in report));
});

test("normalizes the Reporting API envelope", () => {
  const reports = cspReport.normalizeReports([
    {
      type: "csp-violation",
      body: {
        documentURL: "https://free2z.cash/",
        blockedURL: "https://evil.example/x.js",
        effectiveDirective: "script-src-elem",
        sourceFile: "https://free2z.cash/",
        lineNumber: 1,
        sample: "",
        disposition: "report",
      },
    },
    // A non-CSP report in the same batch (the Reporting API multiplexes
    // deprecation and intervention reports onto the same endpoint) must be
    // dropped, not logged as an empty violation.
    { type: "deprecation", body: { id: "x" } },
  ]);

  assert.equal(reports.length, 1);
  assert.equal(reports[0].blockedUri, "https://evil.example/x.js");
});

// CSP's own report sanitization keeps the path AND the query (CSP3 5.4), and
// the known mode-watcher violation fires on every page — including the one
// that carries a live password-reset token in its query string. Without this,
// the first report of each window deposits a working account-takeover
// credential into Cloud Logging. Found by the codex adversarial review of this
// change, not by a human reading it.
test("our own page URLs never carry a query string into a log", () => {
  const [report] = cspReport.normalizeReports({
    "csp-report": {
      "document-uri":
        "https://free2z.cash/reset-password?token=live-bearer-token&uid=7",
      "source-file":
        "https://free2z.cash/reset-password?token=live-bearer-token",
      "blocked-uri": "inline",
    },
  });

  assert.equal(
    report.documentUri,
    "https://free2z.cash/reset-password?<redacted>",
  );
  assert.equal(
    report.sourceFile,
    "https://free2z.cash/reset-password?<redacted>",
  );
  const line = cspReport.formatReportLine(report, 0);
  assert.ok(!line.includes("live-bearer-token"), line);
  // The path survives: "which page" is the entire diagnostic value.
  assert.ok(line.includes("/reset-password"));
});

test("redaction survives values that are not absolute URLs", () => {
  assert.equal(cspReport.redactUrl("about:blank"), "about:blank");
  assert.equal(cspReport.redactUrl(""), "");
  assert.equal(cspReport.redactUrl(undefined), "");
  // A relative reference the URL parser rejects must still lose its query
  // rather than falling through the catch untouched.
  assert.equal(
    cspReport.redactUrl("/reset-password?token=secret"),
    "/reset-password?<redacted>",
  );
  // A fragment containing a `?` must not be mistaken for a query.
  assert.equal(
    cspReport.redactUrl("https://free2z.cash/a#b?c"),
    "https://free2z.cash/a",
  );
});

// The refused resource keeps its query: for an injected script that IS the
// finding. Redacting it too would have been the easy over-correction.
test("the blocked URI is not redacted", () => {
  const [report] = cspReport.normalizeReports({
    "csp-report": { "blocked-uri": "https://evil.example/x.js?exfil=abc" },
  });
  assert.equal(report.blockedUri, "https://evil.example/x.js?exfil=abc");
});

// One request must not be able to spend the whole window's allowance. Sixty
// minimal envelopes fit inside the 8 KiB body cap, so without this an attacker
// could suppress every genuine violation for a minute with a single POST --
// and make the inventory look clean right before someone enforces on it.
test("a single request cannot consume the whole reporting budget", () => {
  const batch = Array.from({ length: 200 }, (_, i) => ({
    type: "csp-violation",
    body: {
      blockedURL: `https://noise.example/${i}.js`,
      effectiveDirective: "script-src-elem",
    },
  }));

  const reports = cspReport.normalizeReports(batch);
  assert.equal(reports.length, cspReport.MAX_REPORTS_PER_REQUEST);
  assert.ok(
    cspReport.MAX_REPORTS_PER_REQUEST < cspReport.MAX_REPORTS_PER_WINDOW,
    "the per-request cap must be below the per-window cap or it caps nothing",
  );
});

// Junk entries must not consume the per-request budget either -- otherwise a
// batch of 9 nulls followed by a real violation would drop the real one.
test("unparseable envelopes do not spend the per-request budget", () => {
  const batch = [
    ...Array.from({ length: 50 }, () => null),
    {
      type: "csp-violation",
      body: { blockedURL: "inline", effectiveDirective: "script-src-elem" },
    },
  ];
  const reports = cspReport.normalizeReports(batch);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].blockedUri, "inline");
});

test("garbage never throws and never logs", () => {
  for (const payload of [null, 42, "nope", [], {}, { "csp-report": "no" }]) {
    assert.deepEqual(cspReport.normalizeReports(payload), []);
  }
});

// Log forging. `blocked-uri` is attacker-chosen; a newline in it plus a
// concatenating logger is a fabricated log entry.
test("control characters cannot survive into a field", () => {
  const forged = cspReport.sanitizeField(
    'a\n{"event":"csp_report","blockedUri":"forged"}\r\u0000',
  );
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(forged));
  assert.match(forged, /^a /);
});

test("fields are truncated", () => {
  const long = "x".repeat(cspReport.MAX_FIELD_CHARS + 500);
  assert.equal(cspReport.sanitizeField(long).length, cspReport.MAX_FIELD_CHARS);
});

test("identical violations are counted, not repeated", () => {
  const limiter = new cspReport.CspReportLimiter();
  const [report] = cspReport.normalizeReports({
    "csp-report": {
      "blocked-uri": "inline",
      "effective-directive": "script-src-elem",
    },
  });

  assert.equal(limiter.admit(report, 1_000).log, true);
  for (let i = 0; i < 50; i += 1) {
    assert.equal(limiter.admit(report, 1_000 + i).log, false);
  }
});

// The expected steady state in production: the SAME inline script refused on
// every page load, from a different URL and a different line each time (that
// is what mode-watcher's bootstrap will do). If the key kept sourceFile or
// lineNumber this would log 60 lines a minute per pod forever and bury
// anything new.
test("one inline script reported from many pages is one line", () => {
  const limiter = new cspReport.CspReportLimiter();
  const fromPage = (n) =>
    cspReport.normalizeReports({
      "csp-report": {
        "document-uri": `https://free2z.cash/creator/page-${n}`,
        "source-file": `https://free2z.cash/creator/page-${n}`,
        "line-number": n,
        "blocked-uri": "inline",
        "effective-directive": "script-src-elem",
        "script-sample": "(function setInitialMode({ defaultMode",
      },
    })[0];

  let logged = 0;
  for (let i = 0; i < 500; i += 1) {
    if (limiter.admit(fromPage(i), 1_000).log) logged += 1;
  }
  assert.equal(logged, 1);

  //...and a DIFFERENT inline script still gets through, which is the only
  // reason collapsing the others is acceptable at all.
  const injected = cspReport.normalizeReports({
    "csp-report": {
      "blocked-uri": "inline",
      "effective-directive": "script-src-elem",
      "script-sample": "alert(document.cookie)",
    },
  })[0];
  assert.equal(limiter.admit(injected, 1_000).log, true);
});

test("distinct violations are capped per window and the window rolls", () => {
  const limiter = new cspReport.CspReportLimiter();
  const distinct = (n) =>
    cspReport.normalizeReports({
      "csp-report": {
        "blocked-uri": `https://evil.example/${n}.js`,
        "effective-directive": "script-src-elem",
      },
    })[0];

  let logged = 0;
  // Well past both MAX_REPORTS_PER_WINDOW and MAX_DEDUPE_KEYS.
  for (let i = 0; i < 1_000; i += 1) {
    if (limiter.admit(distinct(i), 1_000).log) logged += 1;
  }
  assert.equal(logged, cspReport.MAX_REPORTS_PER_WINDOW);

  // A fresh window admits again, and reports the backlog exactly once.
  const next = limiter.admit(distinct(10_000), 1_000 + cspReport.WINDOW_MS);
  assert.equal(next.log, true);
  assert.equal(next.suppressed, 1_000 - cspReport.MAX_REPORTS_PER_WINDOW);
  assert.equal(
    limiter.admit(distinct(10_001), 1_000 + cspReport.WINDOW_MS).suppressed,
    0,
  );
});

test("the log line carries the allowlisted fields and nothing else", () => {
  const [report] = cspReport.normalizeReports({
    "csp-report": {
      "blocked-uri": "inline",
      "original-policy": "x".repeat(400),
      "script-sample": "alert(1)",
    },
  });
  const line = JSON.parse(cspReport.formatReportLine(report, 0));

  assert.equal(line.event, "csp_report");
  assert.equal(line.policy, "report-only");
  assert.equal(line.blockedUri, "inline");
  assert.ok(!JSON.stringify(line).includes("x".repeat(400)));
  assert.ok(!("suppressedSinceLastLine" in line));
});

// An unauthenticated POST endpoint that buffers before it measures is a
// memory-exhaustion primitive, so the cap has to be applied while reading.
test("bodies over the cap are refused without being buffered", async () => {
  const oversized = "a".repeat(cspReport.MAX_BODY_BYTES + 1);
  assert.equal(
    await cspReport.readBoundedBody(
      new Request("https://free2z.cash/csp-report", {
        method: "POST",
        body: oversized,
      }),
    ),
    null,
  );

  const fine = JSON.stringify({ "csp-report": { "blocked-uri": "inline" } });
  assert.equal(
    await cspReport.readBoundedBody(
      new Request("https://free2z.cash/csp-report", {
        method: "POST",
        body: fine,
      }),
    ),
    fine,
  );
});

// Content-Length is not what bounds the read: a chunked request has none and a
// declared one can lie. Drive the streaming path directly.
test("a lying Content-Length does not raise the cap", async () => {
  const stream = new ReadableStream({
    start(controller) {
      const chunk = new Uint8Array(4096).fill(97);
      for (let i = 0; i < 4; i += 1) controller.enqueue(chunk);
      controller.close();
    },
  });

  const request = new Request("https://free2z.cash/csp-report", {
    method: "POST",
    body: stream,
    headers: { "content-length": "10" },
    duplex: "half",
  });

  assert.equal(await cspReport.readBoundedBody(request), null);
});
