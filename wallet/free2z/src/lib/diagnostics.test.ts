import { describe, expect, it } from "vitest";
import { renderDiagnosticsReport } from "@free2z/wallet-shared";
import release from "../../release.json";
import { createDiagnosticsStore } from "./diagnostics";

/**
 * That the content surface's buffer is this app's, and that capture here
 * brought no native authority with it.
 *
 * The redaction rules themselves are proven in the shared package's own suite;
 * what has to be proven here is that free2z is wired to them and names its own
 * build. That this surface gained no native command along the way is asserted
 * where it can actually be enforced — `no_invoke_handler_is_registered` in
 * `src-tauri/src/lib.rs`.
 */
describe("the content surface's diagnostics buffer", () => {
  it("identifies itself as free2z and carries this build", () => {
    const store = createDiagnosticsStore();
    expect(store.environment.app).toBe("free2z");
    expect(store.environment.version).toBe(release.version);
    expect(store.environment.build).toBe(String(release.build));
  });

  it("records a failure and redacts what an article URL would carry", () => {
    const store = createDiagnosticsStore();
    store.breadcrumb("navigation", "route-enter");
    store.record(
      "unhandled-rejection",
      new Error("failed to load https://free2z.cash/creator/someone/article"),
    );

    const report = renderDiagnosticsReport(store);
    expect(report).toContain("failed to load");
    expect(report).not.toContain("free2z.cash");
    expect(report).not.toContain("someone");
  });
});
