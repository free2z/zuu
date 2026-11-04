import { expect, test } from "@playwright/test";

import {
  ARTICLE_ENRICHMENT_TIMEOUT_MS,
  ARTICLE_SSR_APP_DEADLINE_MS,
  ARTICLE_VARIANT_RETRY_TIMEOUT_MS,
} from "../../src/lib/article-ssr-deadlines.js";
import { browserAppOrigin, browserMockApiOrigin } from "./ports";
import { diagnoseBudget, type ProbeOutcome } from "./ssr-deadline-verdict";

const origin = browserAppOrigin();

/**
 * WHY THIS FILE COMPUTES A BUDGET INSTEAD OF WRITING ONE DOWN
 *
 * The subject of these tests is that the SSR stream COMPLETES even when an
 * optional upstream fetch never answers. That is only observable from outside
 * the process, so the tests read the route with plain `fetch` (a browser's DOM
 * readiness cannot see the deferred data scripts after `</html>`) and bound the
 * read with their own `AbortController`.
 *
 * That bound used to be the literal `6000`. The route's own deadlines are
 * 3500 + 2500 = 6000, so the bound had become EXACTLY the app's share of the
 * wall clock with zero left for process start, the primary `/api/zpage/` round
 * trip, the render, and streaming the last byte -- and the stalled scenario
 * under test is MEANT to spend all 3500 ms of the enrichment deadline. Nobody
 * chose that: the literal was written once and the constants moved underneath
 * it. On a shared 2-core CI runner it was arithmetically guaranteed to abort,
 * and it reddened two unrelated PRs' gates with a bare
 * `AbortError: This operation was aborted` -- a message that names neither the
 * bound nor what it was composed of. Each time, the PR's author spent a cycle
 * deciding whether their own diff had caused it. One published the wrong
 * conclusion before withdrawing it.
 *
 * So the bound is now `ARTICLE_SSR_APP_DEADLINE_MS` -- imported from the same
 * module the route imports, so it cannot drift -- PLUS headroom that is named,
 * measured, and reported. And when the budget is exceeded, the failure records
 * an unstalled render of the same route to help distinguish a route deadline
 * regression from a run with too little headroom. See `diagnoseBudgetExceeded`.
 */

/**
 * The floor under the headroom: the cost of everything that is not a deadline,
 * on a runner we have not measured yet. Generous on purpose -- headroom is not
 * the thing under test, and every millisecond of it that goes unused costs
 * nothing at all.
 */
const RUNNER_HEADROOM_FLOOR_MS = 8_000;
/**
 *...and the multiple of the MEASURED cost we allow, for a runner slower than
 * the floor. A stalled render does the same work as the unstalled one we
 * measure, so 1x would already be the honest figure; 4x is the margin for a
 * runner whose contention varies during the run, which is exactly what a
 * shared CI machine does.
 */
const RUNNER_HEADROOM_FACTOR = 4;
/**
 * A ceiling, so a pathologically slow warm-up cannot turn a real hang into a
 * multi-minute wait. Past this, "the runner is too slow to measure a deadline
 * on" is the finding.
 */
const RUNNER_HEADROOM_CAP_MS = 30_000;
/**
 * Each warm-up's own bound. The first hit compiles the SSR module graph; a
 * second hit measures the already-compiled route, the cost relevant to the
 * stalled reads. Playwright retries replace the worker but reuse the dev
 * server, so measuring only the cold hit gave the first attempt a large bound
 * and its retry the floor. Discarding compile time keeps both attempts on the
 * same basis.
 */
const WARMUP_BUDGET_MS = 55_000;

const DEADLINE_SOURCE = "src/lib/article-ssr-deadlines.js";
const ROUTE_SOURCE = "src/routes/[username]/[vanity]/+page.server.ts";

interface StreamRead {
  html: string;
  elapsedMs: number;
}

class SsrStreamBudgetExceeded extends Error {
  constructor(
    message: string,
    /** How long the read actually got before the client gave up. */
    readonly waitedMs: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SsrStreamBudgetExceeded";
  }
}

/**
 * Read a fixture article to the last byte, or explain why it could not be.
 *
 * A bare `AbortError` from the raw `AbortController` is what cost two agents a
 * cycle each, so an exhausted budget becomes `SsrStreamBudgetExceeded` with the
 * composition of the bound in its message.
 */
async function readArticleWithin(
  id: string,
  budgetMs: number,
  describeBudget: (elapsedMs: number) => string = (elapsedMs) =>
    `Reading ${id} exceeded its ${budgetMs} ms budget after ${elapsedMs} ms.`,
): Promise<StreamRead> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${origin}/ssr-body-user/${id}`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    return { html, elapsedMs: Date.now() - startedAt };
  } catch (cause) {
    if (controller.signal.aborted) {
      const waitedMs = Date.now() - startedAt;
      throw new SsrStreamBudgetExceeded(describeBudget(waitedMs), waitedMs, {
        cause,
      });
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The cost of everything that is NOT a deadline, measured rather than guessed:
 * the unstalled fixture answers its optional calls immediately, so the time it
 * takes is the primary round trip plus render plus stream, without cold compile.
 */
let measuredBaselineRenderMs: number | null = null;

function runnerHeadroomMs(): number {
  if (measuredBaselineRenderMs === null) return RUNNER_HEADROOM_FLOOR_MS;
  return Math.min(
    RUNNER_HEADROOM_CAP_MS,
    Math.max(
      RUNNER_HEADROOM_FLOOR_MS,
      Math.ceil(measuredBaselineRenderMs * RUNNER_HEADROOM_FACTOR),
    ),
  );
}

function describeHeadroom(): string {
  const headroom = runnerHeadroomMs();
  if (measuredBaselineRenderMs === null) {
    return `${headroom} ms (the floor; no unstalled render was measured)`;
  }
  return (
    `${headroom} ms (max(floor ${RUNNER_HEADROOM_FLOOR_MS}, ` +
    `${RUNNER_HEADROOM_FACTOR}x the ${measuredBaselineRenderMs} ms measured for an ` +
    `unstalled render of this route), capped at ${RUNNER_HEADROOM_CAP_MS})`
  );
}

function describeAppDeadlines(): string {
  return (
    `${ARTICLE_SSR_APP_DEADLINE_MS} ms (ARTICLE_ENRICHMENT_TIMEOUT_MS ` +
    `${ARTICLE_ENRICHMENT_TIMEOUT_MS} + ARTICLE_VARIANT_RETRY_TIMEOUT_MS ` +
    `${ARTICLE_VARIANT_RETRY_TIMEOUT_MS}, from ${DEADLINE_SOURCE})`
  );
}

/**
 * Re-measure the unstalled route at the moment of the abort, and hand the facts to
 * the classifier in `ssr-deadline-verdict.ts`.
 *
 * The probe is an unstalled render of the same route: its cost includes app
 * work as well as runner cost, so it cannot exonerate the route by itself.
 * Three outcomes matter, not two -- completed, too slow, and outright FAILED --
 * because a failed probe is missing evidence rather than evidence that the code
 * under test is innocent. The classifier owns that distinction, and what it may
 * conclude from a probe that DID complete; a node test drives every one of its
 * verdicts in CI (codex adversarial review, two rounds).
 *
 * This only runs on the failure path.
 */
async function diagnoseBudgetExceeded(
  scenario: string,
  budgetMs: number,
  waitedMs: number,
): Promise<string> {
  const probeBudgetMs = ARTICLE_SSR_APP_DEADLINE_MS + runnerHeadroomMs();
  let probe: ProbeOutcome;
  try {
    const read = await readArticleWithin(
      "ssr-enrichment-success",
      probeBudgetMs,
    );
    probe = { kind: "completed", elapsedMs: read.elapsedMs };
  } catch (error) {
    probe =
      error instanceof SsrStreamBudgetExceeded
        ? {
            kind: "exceeded",
            budgetMs: probeBudgetMs,
            waitedMs: error.waitedMs,
          }
        : {
            kind: "errored",
            detail:
              error instanceof Error
                ? `${error.name}: ${error.message.split("\n")[0]}`
                : String(error),
          };
  }

  const { message } = diagnoseBudget({
    scenario,
    budgetMs,
    waitedMs,
    appDeadlineMs: ARTICLE_SSR_APP_DEADLINE_MS,
    headroomMs: runnerHeadroomMs(),
    appDeadlineDescription: describeAppDeadlines(),
    headroomDescription: describeHeadroom(),
    probe,
    deadlineSource: DEADLINE_SOURCE,
    routeSource: ROUTE_SOURCE,
  });
  return message;
}

test.beforeAll(async () => {
  test.setTimeout(WARMUP_BUDGET_MS * 2 + 15_000);
  const coldWarmup = await readArticleWithin(
    "ssr-enrichment-success",
    WARMUP_BUDGET_MS,
    (elapsed) =>
      [
        `The article route did not compile and render within ${WARMUP_BUDGET_MS} ms`,
        `(waited ${elapsed} ms). This is the cold warm-up: NO fetch is stalled in it,`,
        `so it says nothing about the SSR deadlines under test -- the dev server`,
        `never compiled the route, or the mock API never answered.`,
      ].join("\n"),
  );
  const measured = await readArticleWithin(
    "ssr-enrichment-success",
    WARMUP_BUDGET_MS,
    (elapsed) =>
      [
        `The already-compiled article route did not render within ${WARMUP_BUDGET_MS} ms`,
        `(waited ${elapsed} ms). This is the measured warm render: NO fetch is stalled in it,`,
        `so the failure is in the route response, mock API, or runner; inspect the logs.`,
      ].join("\n"),
  );
  measuredBaselineRenderMs = measured.elapsedMs;
  // One line on stderr, once: the cold compile is shown separately, but only
  // the warm measurement determines headroom. A restarted retry worker sees
  // the same compiled dev server and measures on the same basis.
  process.stderr.write(
    `article-enrichment-deadline: unstalled render (cold) took ` +
      `${coldWarmup.elapsedMs} ms; unstalled render (warm) took ` +
      `${measuredBaselineRenderMs} ms; ` +
      `bound for a stalled scenario = ` +
      `${ARTICLE_SSR_APP_DEADLINE_MS} ms of app deadlines + ` +
      `${runnerHeadroomMs()} ms of headroom = ` +
      `${ARTICLE_SSR_APP_DEADLINE_MS + runnerHeadroomMs()} ms\n`,
  );
});

for (const scenario of ["related-headers", "series-body"]) {
  test(`article stream finishes and cancels optional ${scenario} stalls`, async ({
    request,
  }) => {
    // The app is ENTITLED to spend all of ARTICLE_SSR_APP_DEADLINE_MS here:
    // that is the behaviour under test. Everything else the read costs is the
    // runner's, and gets its own named term.
    const budgetMs = ARTICLE_SSR_APP_DEADLINE_MS + runnerHeadroomMs();
    // The diagnosis on failure re-reads the route, so the test must outlive
    // both the bound and that probe.
    test.setTimeout(budgetMs * 2 + 15_000);

    const stalledKind = scenario.startsWith("related") ? "related" : "series";
    const stalledPhase = scenario.endsWith("headers") ? "headers" : "body";
    const stalledId = `ssr-enrichment-${stalledKind}-${stalledPhase}`;
    await request.post(
      `${browserMockApiOrigin()}/__ssr-enrichment-stall?id=${encodeURIComponent(stalledId)}`,
    );

    let read: StreamRead;
    try {
      read = await readArticleWithin(`ssr-enrichment-${scenario}`, budgetMs);
    } catch (error) {
      if (error instanceof SsrStreamBudgetExceeded) {
        // The diagnosis needs a live measurement, so it can only be made here,
        // after the abort -- not baked into the message up front.
        throw new SsrStreamBudgetExceeded(
          await diagnoseBudgetExceeded(scenario, budgetMs, error.waitedMs),
          error.waitedMs,
          { cause: error.cause },
        );
      }
      throw error;
    }

    // Report the margin even when green, so "we are at 11 of 12 minutes"
    // arrives before the gate turns red rather than after ('s rule, for
    // this bound).
    const usedPct = Math.round((read.elapsedMs / budgetMs) * 100);
    process.stderr.write(
      `article-enrichment-deadline: ${scenario} streamed in ${read.elapsedMs} ms ` +
        `of its ${budgetMs} ms bound (${usedPct}%)` +
        (usedPct >= 70
          ? ` -- WARNING: over 70% of the bound. Elapsed time includes app work` +
            ` and runner overhead; inspect the route and runner before adjusting` +
            ` either budget.`
          : "") +
        `\n`,
    );

    const html = read.html;
    expect(html).toContain("Core article sentinel");
    expect(html).toContain("Complete article tail sentinel.");
    expect(html).toContain("</html>");
    expect(html).toContain(
      scenario.startsWith("related")
        ? "Series enrichment sentinel"
        : "Related enrichment sentinel",
    );

    await expect
      .poll(async () => {
        const response = await request.get(
          `${browserMockApiOrigin()}/__ssr-enrichment-stall?id=${encodeURIComponent(stalledId)}`,
        );
        return response.json();
      })
      .toMatchObject({ started: true, closed: true });
  });
}

test("successful related and series data remain in the complete article stream", async () => {
  // Nothing stalls in this one, so the app's optional deadlines are not part
  // of its bound. The route render and runner still both contribute to cost.
  const budgetMs = runnerHeadroomMs();
  test.setTimeout(budgetMs + 15_000);
  const { html } = await readArticleWithin(
    "ssr-enrichment-success",
    budgetMs,
    (elapsed) =>
      [
        `An UNSTALLED article render did not complete within ${budgetMs} ms`,
        `(waited ${elapsed} ms).`,
        `  headroom = ${describeHeadroom()}`,
        ``,
        `No optional fetch is stalled in this scenario, so the route's own`,
        `deadlines (${describeAppDeadlines()})`,
        `are not part of this bound and this is NOT evidence that one failed to`,
        `fire. Either the runner is far slower than the warm-up measured, or the`,
        `route is hanging on a fetch that has no deadline at all.`,
      ].join("\n"),
  );
  expect(html).toContain("Core article sentinel");
  expect(html).toContain("Related enrichment sentinel");
  expect(html).toContain("Series enrichment sentinel");
});
