import { afterEach, expect, it } from "vitest";
import { renderDiagnosticsReport, DIAGNOSTIC_KINDS } from "@free2z/wallet-shared";
import { diagnostics } from "./diagnostics";
import { captureFeedbackDiagnostics, scrubFeedbackText } from "./feedback";

afterEach(() => diagnostics.clear());
it("the shipping feedback capture excludes every free-text surface and passes the independent scrubber", () => {
  diagnostics.clear();
  for (const kind of DIAGNOSTIC_KINDS) {
    diagnostics.breadcrumb("messaging", "device-info-failed");
    diagnostics.record(kind, {
      name: "session.secret",
      message: "password: bring the blue folder https://private.invalid /Users/alice/file.txt 0.123 ZEC",
      stack: "at fail (https://private.invalid/assets/bundle.js:12:34)",
      cause: new Error("abandon ".repeat(12)),
    });
  }
  const full = renderDiagnosticsReport(diagnostics);
  expect(full).toContain("bundle.js:12:34");
  expect(scrubFeedbackText(full, "removed").findings.length).toBeGreaterThan(0);
  const reduced = captureFeedbackDiagnostics();
  expect(reduced).toContain("Recorded failures: 5");
  for (const kind of DIAGNOSTIC_KINDS) expect(reduced).toContain(kind);
  expect(reduced).not.toMatch(/session|password|folder|private|alice|bundle|abandon|\.js|12:34/);
  expect(scrubFeedbackText(reduced, "removed")).toEqual({ text: reduced, findings: [] });
});
