/**
 * What to conclude when `article-enrichment-deadline.spec.ts` exceeds its
 * budget -- and why that conclusion lives in its own module.
 *
 * The spec's bound is two terms: `appDeadlineMs`, the most a correct route may
 * spend waiting out its own SSR deadlines (the thing under test), and
 * `headroomMs`, everything the runner has to do besides waiting them out. When
 * the bound is exceeded, saying WHICH ran out is the whole point of: the
 * previous bare `AbortError` cost two agents a diagnosis cycle each.
 *
 * The evidence is a PROBE taken right after the abort -- an unstalled render of
 * the same route. Its cost includes app work as well as runner cost.
 *
 * TWO THINGS THIS MODULE REFUSES TO DO, both because a confident wrong answer
 * is worse here than an honest inconclusive one. An autonomous reviewer acts on
 * this text.
 *
 *   1. It never treats a probe that FAILED (an HTTP 500, a dropped connection)
 *      as a slow runner. That is missing evidence, not evidence of innocence --
 *      and reporting it as runner contention points recovery at the test budget
 *      while a live application failure sits in front of it.
 *
 *   2. It never commits to "runner" or "deadline" when the bound lands inside
 *      the window a CORRECT implementation would legitimately occupy. A later
 *      request's duration cannot prove what an earlier request's deadline did,
 *      and the deadline's real spend is a range, not a number: these fixtures
 *      exercise the enrichment deadline but not the language-variant retry, so
 *      the app's legitimate share is anywhere from 0 to `appDeadlineMs`. When
 *      that range straddles the bound, the verdict is `headroom`: the bound was
 *      too small either way, which is actionable, and the code under test is
 *      explicitly NOT cleared.
 *
 * A completed probe is still a render of the app under test. It cannot separate
 * runner contention from app slowness, even when it alone takes longer than
 * the failed request's bound. No probe outcome here clears the code under test.
 *
 * Both refusals come from codex adversarial review, in two rounds. It is a
 * module rather than a closure inside the spec because a browser spec cannot
 * check its own classifier: the failure it would have to produce is the one the
 * CI machine produces and a developer machine does not.
 * `tests/article-ssr-deadline-bound.test.mjs` drives every branch in CI, with no
 * server and no browser.
 */

/** What the post-abort probe of an UNSTALLED render did. */
export type ProbeOutcome =
  /** It finished, in this long. */
  | { kind: "completed"; elapsedMs: number }
  /** It ran out of its own budget. */
  | { kind: "exceeded"; budgetMs: number; waitedMs: number }
  /** It failed outright -- a non-200, a dropped connection, anything else. */
  | { kind: "errored"; detail: string };

export type Verdict =
  /**
   * The unstalled same-route render plus the app's ENTIRE deadline budget still
   * fit inside the bound, so a stalled read should also have finished. A regression.
   */
  | "deadline"
  /**
   * The bound landed INSIDE the window a correct implementation could
   * legitimately occupy: its baseline render plus deadline time could exceed
   * the bound. The cause cannot be isolated; do not clear the code under test.
   */
  | "headroom"
  /** The same-route probe was slow, but cannot separate app cost from runner. */
  | "probe-slow"
  /** The probe was too slow to finish: runner AND app both still open. */
  | "probe-exceeded"
  /** The probe failed: the app, or its upstream, is answering badly. */
  | "probe-errored";

export interface BudgetFacts {
  scenario: string;
  /** The bound that was exceeded. Always `appDeadlineMs + headroomMs`. */
  budgetMs: number;
  /** How long the read actually got. */
  waitedMs: number;
  /**
   * The app's share of the bound: the MOST a correct implementation may spend
   * waiting out its own deadlines on this route.
   */
  appDeadlineMs: number;
  /** The rest of the bound -- everything that is not a deadline. */
  headroomMs: number;
  /** Human-readable composition of the app's share. */
  appDeadlineDescription: string;
  /** Human-readable composition of the headroom. */
  headroomDescription: string;
  probe: ProbeOutcome;
  /** Where the deadline constants live. */
  deadlineSource: string;
  /** Where the loader under test lives. */
  routeSource: string;
}

/**
 * What a CORRECT implementation would have needed on this runner: the measured
 * unstalled route cost, plus anywhere from nothing to the full deadline budget.
 *
 * A RANGE, deliberately. Collapsing it to one number is what makes a diagnosis
 * overconfident. `null` when the probe produced no measurement.
 */
export function legitimateRangeMs(
  facts: BudgetFacts,
): { minMs: number; maxMs: number } | null {
  if (facts.probe.kind !== "completed") return null;
  return {
    minMs: facts.probe.elapsedMs,
    maxMs: facts.probe.elapsedMs + facts.appDeadlineMs,
  };
}

/**
 * Three comparisons against that range, and because
 * `budgetMs === appDeadlineMs + headroomMs` each is one line of arithmetic:
 *
 *   range.max < budget    the app's whole deadline budget was still unspent when
 *                         the bound expired -> the deadline did not fire.
 *   range.min >= budget   even the unstalled app render exceeded the bound; its
 *                         cost cannot be separated from runner contention.
 *   otherwise             the bound is inside the legitimate window -> this
 *                         run cannot isolate which cost exceeded it.
 */
export function classifyBudgetExceeded(facts: BudgetFacts): Verdict {
  if (facts.probe.kind === "errored") return "probe-errored";
  if (facts.probe.kind === "exceeded") return "probe-exceeded";
  const range = legitimateRangeMs(facts);
  if (range === null) return "probe-exceeded";
  if (range.maxMs < facts.budgetMs) return "deadline";
  if (range.minMs >= facts.budgetMs) return "probe-slow";
  return "headroom";
}

/** The failure message, with the verdict it is based on. */
export function diagnoseBudget(facts: BudgetFacts): {
  verdict: Verdict;
  message: string;
} {
  const verdict = classifyBudgetExceeded(facts);
  const range = legitimateRangeMs(facts);
  const lines = [
    `The SSR stream for ssr-enrichment-${facts.scenario} did not finish inside the`,
    `budget this spec derives from the route's own deadlines.`,
    ``,
    `  bound         = ${facts.budgetMs} ms  = app deadlines + runner headroom`,
    `  app deadlines = ${facts.appDeadlineDescription}`,
    `  headroom      = ${facts.headroomDescription}`,
    `  waited        = ${facts.waitedMs} ms before this client aborted`,
    ``,
    `THE EVIDENCE (an UNSTALLED render of the same route, re-measured just now,`,
    `after the abort):`,
  ];

  if (range !== null) {
    lines.push(
      `  it took ${range.minMs} ms. A CORRECT stalled render on this runner would`,
      `  therefore have taken ${range.minMs}..${range.maxMs} ms -- that cost, plus 0 to`,
      `  ${facts.appDeadlineMs} ms of deadline. The bound was ${facts.budgetMs} ms`,
      `  (${facts.appDeadlineMs} + ${facts.headroomMs}).`,
    );
  } else if (facts.probe.kind === "exceeded") {
    lines.push(
      `  it did not finish either: ${facts.probe.waitedMs} ms of its own`,
      `  ${facts.probe.budgetMs} ms budget, with NO fetch stalled in it.`,
    );
  } else if (facts.probe.kind === "errored") {
    lines.push(`  it FAILED rather than being slow: ${facts.probe.detail}`);
  }
  lines.push(``);

  if (verdict === "probe-slow") {
    lines.push(
      `  => INCONCLUSIVE. The unstalled render of the SAME route took`,
      `     ${range?.minMs} ms, longer than the ${facts.budgetMs} ms bound. That measurement`,
      `     includes both app work and runner cost, so it cannot establish which`,
      `     one caused this request to miss its bound. The code under test is`,
      `     NOT cleared. Check runner load and the route before changing either`,
      `     the app deadlines or RUNNER_HEADROOM_* values.`,
    );
  } else if (verdict === "headroom") {
    lines.push(
      `  => INCONCLUSIVE. The bound (${facts.budgetMs} ms) falls INSIDE ${range?.minMs}..${range?.maxMs} ms,`,
      `     the possible duration of a correct render on this runner. The probe`,
      `     includes app work and runner cost, so this result cannot tell which`,
      `     cost used the remaining time. The code under test is NOT cleared.`,
      `     Review runner load and the route before adjusting the bound or the`,
      `     app deadlines; do not restate a literal (#1976).`,
    );
  } else if (verdict === "deadline") {
    lines.push(
      `  => EVIDENCE POINTS TO THE ROUTE DEADLINE: the measured baseline render`,
      `     plus its ENTIRE ${facts.appDeadlineMs} ms deadline budget still fit within the`,
      `     ${facts.budgetMs} ms bound. A stalled optional fetch should have released`,
      `     the article stream; inspect the deadline path in`,
      `     ${facts.routeSource}`,
      `     (or in whatever now bypasses createAbortSignalWithTimeout there).`,
    );
  } else if (verdict === "probe-exceeded") {
    lines.push(
      `  => INCONCLUSIVE. A render with nothing stalled in it could not complete`,
      `     either, which a contended runner and a route hanging on a fetch with`,
      `     NO deadline produce identically. Neither is ruled out, so do not`,
      `     record this as a known flake. Check the dev server and mock API in`,
      `     the job log first, then re-run one shard; if an unstalled render is`,
      `     still slow on a quiet machine, the bug is in`,
      `     ${facts.routeSource}.`,
    );
  } else {
    lines.push(
      `  => INCONCLUSIVE, AND THE APP IS ANSWERING BADLY. The unstalled probe`,
      `     did not time out, it FAILED, which is not what runner contention`,
      `     looks like. Treat that failure as the primary finding -- the app,`,
      `     its upstream, or the mock API in tests/browser/mock-api.mjs -- and`,
      `     come back to this bound afterwards. The code under test is NOT`,
      `     cleared by this result.`,
    );
  }

  lines.push(``, `(deadline constants: ${facts.deadlineSource})`);

  return { verdict, message: lines.join("\n") };
}
