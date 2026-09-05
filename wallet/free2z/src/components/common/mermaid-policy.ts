export const MERMAID_MAX_SOURCE_CHARS = 12_000;
export const MERMAID_MAX_LINES = 240;
export const MERMAID_MAX_TOKENS = 2_400;
export const MERMAID_MAX_EDGES = 200;
export const MERMAID_MAX_OUTPUT_CHARS = 300_000;
export const MERMAID_RENDER_TIMEOUT_MS = 5_000;
export const MERMAID_MAX_CONCURRENT_WORKERS = 4;

export type MermaidBudgetFailure =
  | "empty"
  | "source-size"
  | "line-count"
  | "token-count"
  | "edge-count"
  | "output-size";

export class MermaidBudgetError extends Error {
  constructor(readonly reason: MermaidBudgetFailure) {
    super(`Mermaid budget exceeded: ${reason}`);
    this.name = "MermaidBudgetError";
  }
}

export class MermaidWorkerBudget {
  private active = 0;

  constructor(private readonly limit = MERMAID_MAX_CONCURRENT_WORKERS) {}

  acquire(): (() => void) | null {
    if (this.active >= this.limit) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}

/**
 * Enforce cheap, syntax-agnostic bounds before Mermaid sees creator content.
 * Mermaid supports many diagram grammars, so characters, lines and lexical
 * tokens are stable cross-grammar complexity measures. The worker repeats this
 * check as a defense-in-depth boundary.
 */
export function assertMermaidSourceBudget(chart: string): void {
  if (chart.trim().length === 0) throw new MermaidBudgetError("empty");
  if (chart.length > MERMAID_MAX_SOURCE_CHARS) {
    throw new MermaidBudgetError("source-size");
  }

  const lines = chart.split(/\r?\n/);
  if (lines.length > MERMAID_MAX_LINES) {
    throw new MermaidBudgetError("line-count");
  }

  const tokens =
    chart.match(
      /[\p{L}\p{N}_]+|-->|---|==>|-\.->|<-->|[()[\]{}:;,]/gu,
    )?.length ?? 0;
  if (tokens > MERMAID_MAX_TOKENS) {
    throw new MermaidBudgetError("token-count");
  }

  const edges = chart.match(/<-->|-->|---|==>|-\.->/g)?.length ?? 0;
  if (edges > MERMAID_MAX_EDGES) {
    throw new MermaidBudgetError("edge-count");
  }
}

export function assertMermaidOutputBudget(svg: string): void {
  if (svg.length === 0 || svg.length > MERMAID_MAX_OUTPUT_CHARS) {
    throw new MermaidBudgetError("output-size");
  }
}
