import { expect, test } from "@playwright/test";

// the regression contract
//
// The two node-test suites check the CONFIG. This one checks the only thing
// that finally matters: what a real Chromium does with the header on a real
// page. A Report-Only policy that is syntactically perfect and admits none of
// our own scripts would look identical in every other test and would produce a
// report on every page view forever, which is how a measurement turns into
// noise nobody reads.
//
// It runs against the dev server (see playwright.config.ts), so it proves the
// policy is attached and the nonces line up. The production-build equivalent
// is covered by the header assertions in the node suite plus the per-tier
// pass-through assertions in.github/scripts/check_nginx_confs.sh.

const CSP_HEADER = "content-security-policy-report-only";

/** Chromium's wording for a report-only refusal. */
const VIOLATION = /\[Report Only\].*Content Security Policy/i;

/**
 * The one violation we already know about and have documented as the blocker
 * for an enforcing policy: mode-watcher injects its theme bootstrap as a bare
 * inline <script> and SvelteKit has no supported way to hand a component the
 * nonce it minted. See src/lib/csp-policy.js.
 *
 * It is matched NARROWLY, by the script sample Chromium quotes back. A broad
 * "ignore inline violations" filter would make this test blind to exactly the
 * thing it exists to catch.
 */
const KNOWN_VIOLATIONS = [/setInitialMode/];

test("the report-only policy is attached and admits our own scripts", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (VIOLATION.test(text)) violations.push(text);
  });

  // CLOSE THE LOOP. Everything else here tests one half or the other: the
  // console listener proves the browser NOTICED a violation, and the second
  // test proves the endpoint accepts a POST we construct ourselves. Neither
  // proves the browser actually DELIVERS a report to the configured
  // report-uri. If Chromium stopped honouring the directive, or the path were
  // wrong, both halves would stay green and the inventory would fill with
  // nothing — which reads exactly like "no violations, safe to enforce".
  const reportPost = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/csp-report",
    { timeout: 15_000 },
  );

  const response = await page.goto("/");
  expect(response).not.toBeNull();

  const policy = response!.headers()[CSP_HEADER];
  expect(policy, "no Content-Security-Policy-Report-Only header").toBeTruthy();

  // The point of the whole exercise: the measured policy must not contain the
  // keywords whose removal it is measuring.
  expect(policy).not.toContain("'unsafe-inline'");
  expect(policy).not.toContain("'unsafe-eval'");
  expect(policy).toContain("report-uri /csp-report");

  const nonceMatch = policy.match(/'nonce-([^']+)'/);
  expect(nonceMatch, `no nonce in the policy: ${policy}`).not.toBeNull();
  const nonce = nonceMatch![1];

  // A nonce that is not on the page admits nothing; a nonce that is fixed
  // across requests admits everything an attacker can read. Both would leave
  // the header looking correct.
  const nonced = await page.locator("script[nonce]").count();
  expect(nonced).toBeGreaterThan(0);

  const second = await page.request.get("/");
  const secondPolicy = second.headers()[CSP_HEADER];
  const secondNonce = secondPolicy.match(/'nonce-([^']+)'/)?.[1];
  expect(
    secondNonce,
    "the nonce is identical across two requests, which makes it guessable and therefore useless",
  ).not.toEqual(nonce);

  // The report request is the synchronization point. The app may keep
  // background requests open, so waiting for global network-idle can time out
  // even after Chromium has delivered the report we are asserting.
  const delivered = await reportPost;
  const body = JSON.parse(delivered.postData() ?? "null");
  // The report the BROWSER built, not one this test wrote: it must be the
  // shape the collector normalizes, and it must be about the violation we
  // know is there.
  const report = body?.["csp-report"] ?? body?.[0]?.body;
  expect(
    report,
    `unrecognized report envelope: ${delivered.postData()}`,
  ).toBeTruthy();
  expect(report["effective-directive"] ?? report.effectiveDirective).toContain(
    "script-src",
  );

  const unexpected = violations.filter(
    (text) => !KNOWN_VIOLATIONS.some((known) => known.test(text)),
  );
  expect(
    unexpected,
    `unexpected CSP violations from our own page:\n${unexpected.join("\n")}`,
  ).toEqual([]);
});

test("the report sink accepts a report and refuses a large body", async ({
  request,
}) => {
  const accepted = await request.post("/csp-report", {
    headers: { "content-type": "application/csp-report" },
    data: JSON.stringify({
      "csp-report": {
        "document-uri": "https://free2z.cash/",
        "blocked-uri": "inline",
        "effective-directive": "script-src-elem",
      },
    }),
  });
  expect(accepted.status()).toBe(204);

  // The other two wire formats a browser may pick. These are here for the
  // CSRF interaction rather than the parsing: SvelteKit 403s a cross-origin
  // POST carrying a FORM content type before this handler ever runs, so which
  // content types reach the code is a property worth pinning.
  for (const contentType of ["application/reports+json", "application/json"]) {
    const response = await request.post("/csp-report", {
      headers: { "content-type": contentType },
      data: JSON.stringify([
        {
          type: "csp-violation",
          body: { blockedURL: "inline", effectiveDirective: "script-src-elem" },
        },
      ]),
    });
    expect(response.status(), contentType).toBe(204);
  }

  // Malformed input must not become a 500: a 500 is a log line whose rate an
  // unauthenticated caller controls.
  const garbage = await request.post("/csp-report", {
    headers: { "content-type": "application/csp-report" },
    data: "not json at all",
  });
  expect(garbage.status()).toBe(204);

  // The application-level cap. nginx enforces its own 16k bound in front of
  // this in production, but nothing guarantees a request reached the pod
  // through that nginx.
  const oversized = await request.post("/csp-report", {
    headers: { "content-type": "application/csp-report" },
    data: "a".repeat(9000),
  });
  expect(oversized.status()).toBe(413);

  // Not a page: a scanner should get 405, not an HTML document.
  const wrongMethod = await request.get("/csp-report");
  expect(wrongMethod.status()).toBe(405);
});
