// The bound `tests/browser/article-enrichment-deadline.spec.ts` enforces must
// stay STRICTLY LOOSER than the deadlines it is measuring, and it must be
// derived from them rather than restated.
//
//the spec's `AbortController` was hardcoded at 6000 ms while the route's
// own deadlines were 3500 + 2500 = 6000. The bound had become exactly the app's
// share of the wall clock with zero left for process start, the primary
// `/api/zpage/` round trip, the render and the full stream -- and the stalled
// scenario under test is MEANT to spend all 3500 ms of the enrichment deadline.
// It reddened two unrelated PRs' gates with a bare `AbortError`.
//
// Nothing about that was visible in either file on its own, which is the point
// of this test: it is the only place the two numbers are compared. A browser
// spec cannot be the guard, because the guard has to fail on a machine where
// the browser spec passes.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ARTICLE_ENRICHMENT_TIMEOUT_MS,
  ARTICLE_SSR_APP_DEADLINE_MS,
  ARTICLE_VARIANT_RETRY_TIMEOUT_MS,
  FIRST_PARTY_EMBED_TIMEOUT_MS,
} from "../src/lib/article-ssr-deadlines.js";
import { diagnoseBudget } from "./browser/ssr-deadline-verdict.ts";

const UI_ROOT = path.dirname(fileURLToPath(import.meta.url));
const source = (relativePath) =>
  fs.readFileSync(path.join(UI_ROOT, "..", relativePath), "utf8");

const ZPAGE_ROUTE = "src/routes/[username]/[vanity]/+page.server.ts";
const ARTICLE_ID_ROUTE = "src/routes/article/[id]/+page.server.ts";
const ENRICHMENT_SOURCE = "src/lib/server/article-enrichment.ts";
const DEADLINE_SPEC = "tests/browser/article-enrichment-deadline.spec.ts";

test("the SSR deadlines have ONE definition, and the routes import it", () => {
  assert.equal(
    ARTICLE_SSR_APP_DEADLINE_MS,
    ARTICLE_ENRICHMENT_TIMEOUT_MS + ARTICLE_VARIANT_RETRY_TIMEOUT_MS,
    "the composed bound must be the sum of the deadlines that can serialize",
  );
  assert.ok(
    ARTICLE_SSR_APP_DEADLINE_MS <= 8_000,
    `the app deadline sum is ${ARTICLE_SSR_APP_DEADLINE_MS} ms; keep the ` +
      `undetected app spend below the 8,000 ms ceiling`,
  );

  for (const route of [ZPAGE_ROUTE, ARTICLE_ID_ROUTE]) {
    const text = source(route);
    assert.match(
      text,
      /from "\$lib\/article-ssr-deadlines\.js"/,
      `${route} must take its deadlines from the shared module`,
    );
    // A local `const ARTICLE_..._TIMEOUT_MS = 2_500` here is the state
    // came from: two files holding the same number, one of which is a test's
    // idea of it.
    assert.doesNotMatch(
      text,
      /const\s+ARTICLE_(?:ENRICHMENT|VARIANT_RETRY)_TIMEOUT_MS\s*=/,
      `${route} must not redeclare a deadline the shared module owns`,
    );
  }
});

test("first-party embed cards fit inside the composed bound (#2021)", () => {
  // The cards are AWAITED (they are part of the server-rendered body), after
  // the article and any variant retry. The zPage route starts its streamed
  // enrichment calls first, so the card deadline overlaps the enrichment one
  // instead of adding to it -- which only keeps ARTICLE_SSR_APP_DEADLINE_MS
  // honest while the card deadline is the shorter of the two.
  assert.ok(FIRST_PARTY_EMBED_TIMEOUT_MS > 0);
  assert.ok(
    FIRST_PARTY_EMBED_TIMEOUT_MS <= ARTICLE_ENRICHMENT_TIMEOUT_MS,
    "the card deadline must not outlast the enrichment deadline it overlaps",
  );
  const zpage = source(ZPAGE_ROUTE);
  const enrichments = zpage.indexOf("= loadArticleEnrichments(");
  const cards = zpage.indexOf("await loadFirstPartyCardSeed(");
  assert.ok(enrichments > 0 && cards > 0, "route shape changed");
  assert.ok(
    enrichments < cards,
    "the enrichment calls must be STARTED before the cards are awaited, or " +
      "the two deadlines serialize and the composed bound is wrong",
  );
  const enrichment = source(ENRICHMENT_SOURCE);
  assert.match(enrichment, /relatedArticles:\s*loadRelatedArticles\(/);
  assert.match(enrichment, /seriesContext:\s*loadSeriesContext\(/);
  // /article/<id> has no enrichment: retry + cards <= retry + enrichment.
  assert.match(source(ARTICLE_ID_ROUTE), /await loadFirstPartyCardSeed\(/);
});

test("the deadline spec derives its bound and leaves real headroom", () => {
  const spec = source(DEADLINE_SPEC);

  // It reads the constants rather than restating them...
  assert.match(spec, /from "\.\.\/\.\.\/src\/lib\/article-ssr-deadlines\.js"/);
  assert.match(spec, /ARTICLE_SSR_APP_DEADLINE_MS \+ runnerHeadroomMs\(\)/);
  assert.match(spec, /const coldWarmup = await readArticleWithin\(/);
  assert.match(spec, /const measured = await readArticleWithin\(/);
  assert.match(spec, /measuredBaselineRenderMs = measured\.elapsedMs/);
  assert.match(spec, /unstalled render \(warm\)/);

  //...and the headroom is a real, positive term. A zero floor would silently
  // restore the 6000 ms bound that  is about.
  const floor = Number(
    /RUNNER_HEADROOM_FLOOR_MS = ([\d_]+)/.exec(spec)?.[1].replaceAll("_", ""),
  );
  const cap = Number(
    /RUNNER_HEADROOM_CAP_MS = ([\d_]+)/.exec(spec)?.[1].replaceAll("_", ""),
  );
  assert.ok(
    Number.isFinite(floor) && floor > 0,
    "RUNNER_HEADROOM_FLOOR_MS must be a positive number of milliseconds",
  );
  assert.ok(
    Number.isFinite(cap) && cap >= floor,
    "RUNNER_HEADROOM_CAP_MS must not be below the floor",
  );
  // The historical failure, stated as arithmetic: the bound must exceed the
  // app's own deadlines by a margin big enough for boot, the primary round
  // trip, the render and the full stream on a shared 2-core runner.
  assert.ok(
    floor >= 5_000,
    `the minimum bound is ${ARTICLE_SSR_APP_DEADLINE_MS} + ${floor} ms; ` +
      `that leaves ${floor} ms for everything that is not a deadline, which is ` +
      `less than a cold CI runner needs (#1976)`,
  );

  // The literal that caused it, and any restatement of the sum, must not be
  // the bound again.
  assert.doesNotMatch(
    spec,
    new RegExp(
      `readArticleWithin\\([^)]*,\\s*${ARTICLE_SSR_APP_DEADLINE_MS}\\b`,
    ),
    "the bound must be composed, never written out as the sum of the deadlines",
  );

  // An exhausted bound must include the post-abort evidence or explain why that
  // evidence is inconclusive. A bare `AbortError` cost two agents a diagnosis cycle each.
  assert.match(spec, /class SsrStreamBudgetExceeded extends Error/);
  // The verdict is measured after the abort, not guessed from the clock, and it
  // is delegated to the classifier the tests below drive.
  assert.match(spec, /async function diagnoseBudgetExceeded/);
  assert.match(
    spec,
    /diagnoseBudgetExceeded\(scenario, budgetMs, error\.waitedMs\)/,
  );
  assert.match(spec, /from "\.\/ssr-deadline-verdict"/);
  assert.match(spec, /probe = \{ kind: "completed"/);
  assert.match(spec, /kind: "exceeded"/);
  assert.match(spec, /kind: "errored"/);
});

// --- the classifier itself, every branch -------------------------------------
//
// A browser spec cannot check its own diagnosis: the failure it would have to
// produce is the one the CI machine produces and this machine does not. So the
// classification is a module, and these drive it with no server and no browser.
//
// Two branches exist because codex found the collapsed version wrong twice:
//
//   * treating a probe that FAILED (HTTP 500, dropped connection) as a slow
//     runner printed "nothing here is evidence about the code under test" over
//     a live application failure, pointing recovery at the test budget;
//   * treating a slow completed same-route probe as proof of runner slowness
//     cleared a possibly-broken deadline. The probe includes app and runner
//     work, and cannot identify which one made the render slow.

const HEADROOM_MS = 8_000;
const facts = (probe, headroomMs = HEADROOM_MS) => ({
  scenario: "related-headers",
  // The invariant the spec maintains, and the one the classifier's arithmetic
  // rests on.
  budgetMs: ARTICLE_SSR_APP_DEADLINE_MS + headroomMs,
  waitedMs: ARTICLE_SSR_APP_DEADLINE_MS + headroomMs + 3,
  appDeadlineMs: ARTICLE_SSR_APP_DEADLINE_MS,
  headroomMs,
  appDeadlineDescription: `${ARTICLE_SSR_APP_DEADLINE_MS} ms (composed)`,
  headroomDescription: `${headroomMs} ms (the floor)`,
  probe,
  deadlineSource: "src/lib/article-ssr-deadlines.js",
  routeSource: "src/routes/[username]/[vanity]/+page.server.ts",
});

/**
 * A sentence, with every gap allowed to be a line break.
 *
 * The message is hand-wrapped for a CI log, so pinning an assertion to where it
 * happens to break would make a reword or a reformat look like a behaviour
 * change -- the exact trap  catalogues for source-scraping tests.
 */
const phrase = (text) =>
  new RegExp(
    text
      .trim()
      .split(/\s+/)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+"),
  );

const EXONERATION = phrase(
  "Nothing here is evidence about the code under test",
);

test("a probe well inside the headroom points at a missed deadline", () => {
  // 43 + 6000 = 6043, comfortably under the 14000 bound: even spending its whole
  // deadline budget the render would have fit.
  const { verdict, message } = diagnoseBudget(
    facts({ kind: "completed", elapsedMs: 43 }),
  );
  assert.equal(verdict, "deadline");
  assert.match(message, phrase("EVIDENCE POINTS TO THE ROUTE DEADLINE"));
  assert.match(message, /\+page\.server\.ts/);
  assert.doesNotMatch(message, EXONERATION);
});

test("a slow same-route probe cannot exonerate the app", () => {
  // Even though 14500 >= the 14000 bound, the probe includes app and runner
  // work; it cannot prove the runner alone caused the first request to time out.
  const { verdict, message } = diagnoseBudget(
    facts({ kind: "completed", elapsedMs: 14_500 }),
  );
  assert.equal(verdict, "probe-slow");
  assert.match(message, phrase("INCONCLUSIVE"));
  assert.match(message, phrase("includes both app work and runner cost"));
  assert.match(message, phrase("code under test is NOT cleared"));
  assert.doesNotMatch(message, EXONERATION);
  assert.doesNotMatch(message, phrase("THIS MEASURED THE RUNNER"));
});

test("a bound INSIDE the legitimate window is inconclusive and clears nobody", () => {
  // 9000 ms for the unstalled app-plus-runner render plus 0..6000 ms of deadline
  // makes a 9000..15000 ms range around the 14000 ms bound. This run cannot
  // isolate whether that remaining time came from app work or runner load.
  const { verdict, message } = diagnoseBudget(
    facts({ kind: "completed", elapsedMs: 9_000 }),
  );
  assert.equal(verdict, "headroom");
  assert.match(message, phrase("INCONCLUSIVE"));
  assert.match(message, /9000\.\.15000 ms/);
  assert.match(message, phrase("code under test is NOT cleared"));
  assert.doesNotMatch(message, EXONERATION);
});

test("a probe that is itself too slow is inconclusive, not runner slowness", () => {
  const { verdict, message } = diagnoseBudget({
    ...facts({ kind: "exceeded", budgetMs: 14_000, waitedMs: 14_002 }),
  });
  assert.equal(verdict, "probe-exceeded");
  assert.match(message, /INCONCLUSIVE/);
  // Both causes stay open, and it must not be filed as a known flake.
  assert.match(message, phrase("do not record this as a known flake"));
  assert.doesNotMatch(message, EXONERATION);
  assert.doesNotMatch(message, phrase("THIS MEASURED THE RUNNER"));
});

test("a probe that FAILS points at the app, never at the test budget", () => {
  // The case codex round 1 reproduced: an immediate HTTP 500 behind the stall.
  const { verdict, message } = diagnoseBudget(
    facts({ kind: "errored", detail: "Error: expected 200, got 500" }),
  );
  assert.equal(verdict, "probe-errored");
  assert.match(message, phrase("THE APP IS ANSWERING BADLY"));
  assert.match(message, /got 500/);
  assert.match(message, phrase("is NOT cleared by this result"));
  assert.doesNotMatch(message, EXONERATION);
  assert.doesNotMatch(message, /RUNNER_HEADROOM_FLOOR_MS/);
});

test("completed-probe verdicts partition the line without clearing the app", () => {
  // One headroom (8000), one app deadline (6000), so the bound is 14000 and the
  // verdict is purely a function of the measured baseline route cost. Every
  // point on the line has exactly one answer, and the two boundaries are exact.
  const at = (elapsedMs) =>
    diagnoseBudget(facts({ kind: "completed", elapsedMs })).verdict;
  assert.equal(at(0), "deadline");
  assert.equal(at(HEADROOM_MS - 1), "deadline");
  // probe >= headroom: the bound is now inside 8000..14000, the window a correct
  // render legitimately occupies.
  assert.equal(at(HEADROOM_MS), "headroom");
  assert.equal(at(ARTICLE_SSR_APP_DEADLINE_MS + HEADROOM_MS - 1), "headroom");
  // probe >= the whole bound: the app-plus-runner probe itself is slow.
  assert.equal(at(ARTICLE_SSR_APP_DEADLINE_MS + HEADROOM_MS), "probe-slow");
  assert.equal(
    diagnoseBudget(
      facts({
        kind: "completed",
        elapsedMs: ARTICLE_SSR_APP_DEADLINE_MS + HEADROOM_MS,
      }),
    ).message.includes("Nothing here is evidence about the code under test"),
    false,
  );
  //...and no bound, however generous, rescues a failed probe.
  const failed = { kind: "errored", detail: "ECONNRESET" };
  assert.equal(diagnoseBudget(facts(failed, 600_000)).verdict, "probe-errored");
});

test("the Converse picker waits for readiness before checking tab state", () => {
  const spec = source("tests/browser/converse-composer-tools.spec.ts");

  //`data-media-access-slot` is on `Dialog.Content` and lands before the
  // tab list is in the accessibility tree, so it was never a readiness signal
  // for a tab's `data-state`.
  assert.match(spec, /async function expectPickerOpen/);
  assert.match(spec, /getByRole\("tablist"\)/);
  // Every tab lookup is scoped to the dialog, so a closing picker cannot answer
  // for the one that is opening.
  assert.doesNotMatch(
    spec,
    /page\.getByRole\("tab"/,
    "scope tab lookups to the dialog they belong to",
  );
  //`data-state` is meaningful only after the picker itself is ready.
  // Check the helper's ordering rather than its matcher spelling: both
  // `toHaveAttribute` and `expect.poll` use the same expectation deadline.
  const helperStart = spec.indexOf("async function expectPickerOpen");
  const helperEnd = spec.indexOf(
    "\n}\n\n/**\n * Close the picker",
    helperStart,
  );
  assert.ok(
    helperStart >= 0 && helperEnd > helperStart,
    "helper shape changed",
  );
  const helper = spec.slice(helperStart, helperEnd);
  const stateAssertion = helper.indexOf(
    'await expect(cloudTab).toHaveAttribute("data-state", expected.cloudTab);',
  );
  assert.ok(stateAssertion >= 0, "picker state assertion changed");
  for (const readinessSignal of [
    'await expect(dialog.getByRole("tablist")).toBeVisible();',
    'await expect(dialog.getByRole("tab", { name: "Device" })).toBeVisible();',
    "await expect(cloudTab).toBeVisible();",
  ]) {
    const readinessIndex = helper.indexOf(readinessSignal);
    assert.ok(
      readinessIndex >= 0 && readinessIndex < stateAssertion,
      `${readinessSignal} must precede the data-state assertion`,
    );
  }
  // And a close is WAITED for before the composer is touched again: the
  // Escape-then-retype sequence is what made the reopen race the close.
  assert.match(spec, /async function closePicker/);
  assert.doesNotMatch(
    spec,
    /keyboard\.press\("Escape"\);\n\s*await reply/,
    "wait for the picker to close before typing the next command",
  );
});
