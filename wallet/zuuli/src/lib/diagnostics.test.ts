import { describe, expect, it } from "vitest";
import { renderDiagnosticsReport } from "@free2z/wallet-shared";
import { BUILD_INFO } from "./build-info";
import { createDiagnosticsStore } from "./diagnostics";

/**
 * That the wallet authority's buffer is this app's, and that the highest-value
 * secret in the product cannot appear in it.
 *
 * The shared package proves the redaction rules; what has to be proven here is
 * that ZUULI is wired to them at all, and that the wiring names ZUULI rather
 * than inheriting another surface's build.
 */
describe("the wallet authority's diagnostics buffer", () => {
  it("identifies itself as ZUULI and carries this build", () => {
    const store = createDiagnosticsStore();
    expect(store.environment.app).toBe("zuuli");
    expect(store.environment.version).toBe(BUILD_INFO.version);
    expect(store.environment.build).toBe(String(BUILD_INFO.build));
  });

  it("records a failure without carrying a recovery phrase into the report", () => {
    const store = createDiagnosticsStore();
    const phrase =
      "abandon ability able about above absent absorb abstract absurd abuse access accident";
    store.breadcrumb("wallet", "wallet-unlocked");
    store.record(
      "reported-error",
      new Error(`could not derive an account from ${phrase}`),
    );

    const report = renderDiagnosticsReport(store);
    // The word-run rule takes the two words either side of the phrase with it.
    // That is the trade the rule makes and it is the right way round: losing
    // "account from" costs a reader nothing, and keeping it would mean keeping
    // a rule that a recovery phrase can walk through.
    expect(report).toContain("could not derive an [redacted:word-run]");
    expect(report).not.toContain("abandon");
    expect(report).not.toContain(phrase);
    expect(report).toContain("wallet/wallet-unlocked");
  });
});
