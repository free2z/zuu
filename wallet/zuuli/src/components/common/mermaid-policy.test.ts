import { describe, expect, it } from "vitest";
import {
  MERMAID_MAX_EDGES,
  MERMAID_MAX_LINES,
  MERMAID_MAX_OUTPUT_CHARS,
  MERMAID_MAX_SOURCE_CHARS,
  MERMAID_MAX_TOKENS,
  MermaidBudgetError,
  MermaidWorkerBudget,
  type MermaidBudgetFailure,
  assertMermaidOutputBudget,
  assertMermaidSourceBudget,
} from "./mermaid-policy";

describe("Mermaid creator-content budgets", () => {
  it("accepts a normal bounded diagram and the advisory trigger", () => {
    expect(() => assertMermaidSourceBudget("flowchart LR\n  A --> B")).not.toThrow();
    expect(() =>
      assertMermaidSourceBudget("xychart\n  x-axis 1 --> 1\n  line [1, 2]"),
    ).not.toThrow();
  });

  const rejectedInputs: Array<[MermaidBudgetFailure, string]> = [
    ["empty", "   "],
    ["source-size", `flowchart LR\n${"a".repeat(MERMAID_MAX_SOURCE_CHARS)}`],
    ["line-count", Array.from({ length: MERMAID_MAX_LINES + 1 }, () => "A").join("\n")],
    ["token-count", `flowchart LR\n${"A ".repeat(MERMAID_MAX_TOKENS + 1)}`],
    [
      "edge-count",
      `flowchart LR\n${Array.from(
        { length: MERMAID_MAX_EDGES + 1 },
        (_, index) => `N${index} --> N${index + 1}`,
      ).join("\n")}`,
    ],
  ];

  it.each(rejectedInputs)("rejects %s input", (reason, chart) => {
    expect(() => assertMermaidSourceBudget(chart)).toThrowError(
      expect.objectContaining<Partial<MermaidBudgetError>>({ reason }),
    );
  });

  it("bounds worker output before it reaches an HTML sink", () => {
    expect(() => assertMermaidOutputBudget("<svg />")).not.toThrow();
    expect(() =>
      assertMermaidOutputBudget("x".repeat(MERMAID_MAX_OUTPUT_CHARS + 1)),
    ).toThrowError(expect.objectContaining({ reason: "output-size" }));
  });

  it("caps concurrent renderers and releases slots idempotently", () => {
    const budget = new MermaidWorkerBudget(2);
    const releaseFirst = budget.acquire();
    const releaseSecond = budget.acquire();
    expect(releaseFirst).toBeTypeOf("function");
    expect(releaseSecond).toBeTypeOf("function");
    expect(budget.acquire()).toBeNull();
    releaseFirst?.();
    releaseFirst?.();
    expect(budget.acquire()).toBeTypeOf("function");
  });
});
