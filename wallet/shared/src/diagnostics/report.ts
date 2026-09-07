import type { DiagnosticsEnvironment } from "./environment";
import type { DiagnosticBreadcrumb, DiagnosticEvent } from "./record";
import type { DiagnosticsStore } from "./store";

/**
 * Render the buffer as markdown a tester can paste into an issue.
 *
 * ## Why markdown, and why the user does the pasting
 *
 * Every TestFlight tester here is a collaborator, and the useful destination
 * for what they hit is `github.com/free2z/zuu/issues`. So the export is shaped
 * for that: a table for the environment, a fenced block per event, and no
 * upload of any kind. The user reads it, then chooses to share it. Nothing in
 * this package can send it anywhere — there is no request code in the module
 * graph to send it with.
 *
 * ## What this function may and may not do
 *
 * It may format. It may not redact. Every string it prints has already been
 * through `redact.ts` on the way into the store, which is what makes "did the
 * export forget to filter?" a question with no answer to get wrong. If a change
 * here ever needs a redaction call, the redaction is in the wrong place.
 */

/** Characters that would break out of the markdown structure around them. */
function forMarkdown(value: string): string {
  return value.replace(/[`|]/gu, "'");
}

function timestamp(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "unknown";
  try {
    return new Date(at).toISOString().replace(/\.\d{3}Z$/u, "Z");
  } catch {
    return "unknown";
  }
}

function renderEnvironment(environment: DiagnosticsEnvironment): string[] {
  return [
    "| field | value |",
    "| --- | --- |",
    `| app | ${environment.app} |`,
    `| version | ${environment.version} (${environment.build}) |`,
    `| platform | ${environment.platform} ${environment.platformVersion} |`,
    `| engine | ${environment.engine} |`,
  ];
}

function renderBreadcrumbs(trail: readonly DiagnosticBreadcrumb[]): string {
  if (trail.length === 0) return "_no breadcrumbs_";
  return trail.map((crumb) => `${crumb.category}/${crumb.code}`).join(" -> ");
}

function renderEvent(event: DiagnosticEvent, index: number): string[] {
  const lines: string[] = [
    `#### ${index}. ${event.kind} at ${timestamp(event.at)}`,
    "",
    `**${forMarkdown(event.name || "Error")}** ${forMarkdown(event.message)}`.trim(),
    "",
  ];
  if (event.frames.length > 0) {
    lines.push("```");
    for (const frame of event.frames) {
      const where = `${frame.source}:${frame.line}:${frame.column}`;
      lines.push(frame.fn ? `at ${frame.fn} (${where})` : `at ${where}`);
    }
    lines.push("```", "");
  }
  lines.push(`breadcrumbs: ${forMarkdown(renderBreadcrumbs(event.breadcrumbs))}`, "");
  return lines;
}

/** Extra context the diagnostics screen knows and the store does not. */
export interface ReportOptions {
  /**
   * When the report was produced. Passed in rather than read from `Date.now()`
   * so a test and a screenshot are reproducible.
   */
  readonly at?: number;
}

/**
 * The heading the export opens with, which is also what the screen shows as a
 * title so the two are never out of step.
 */
export const REPORT_TITLE = "Diagnostics report";

/** Format the whole buffer. */
export function renderDiagnosticsReport(
  store: DiagnosticsStore,
  options: ReportOptions = {},
): string {
  const events = store.events();
  const lines: string[] = [
    `### ${REPORT_TITLE}`,
    "",
    ...renderEnvironment(store.environment),
    `| captured | ${timestamp(options.at ?? Date.now())} |`,
    `| events | ${events.length} |`,
    "",
  ];

  if (events.length === 0) {
    lines.push("No failures have been recorded on this device.", "");
  } else {
    // Newest first: the failure a tester is reporting is the one that just
    // happened, and it should not be below thirty-nine older ones.
    const newestFirst = [...events].reverse();
    newestFirst.forEach((event, index) => {
      lines.push(...renderEvent(event, index + 1));
    });
  }

  lines.push(
    "_Captured locally by the app. Values that were not recognised as safe to",
    "keep appear as `[redacted:...]`; nothing here left the device until this",
    "report was shared by hand._",
  );

  return lines.join("\n");
}
