import { parseHTML } from "linkedom/worker";
import {
  MERMAID_MAX_EDGES,
  MERMAID_MAX_SOURCE_CHARS,
  assertMermaidOutputBudget,
  assertMermaidSourceBudget,
} from "./mermaid-policy";

interface RenderRequest {
  requestId: string;
  chart: string;
}

interface RenderResponse {
  requestId: string;
  ok: boolean;
  svg?: string;
}

interface VirtualRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
  toJSON: () => VirtualRect;
}

interface VirtualMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  inverse: () => VirtualMatrix;
}

type VirtualElement = Element & {
  getBBox?: () => VirtualRect;
  getBoundingClientRect?: () => VirtualRect;
  getComputedTextLength?: () => number;
  getScreenCTM?: () => VirtualMatrix;
};

const virtualRect = (width: number, height: number): VirtualRect => {
  const rect = {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    toJSON: () => rect,
  };
  return rect;
};

const virtualMatrix = (): VirtualMatrix => {
  const matrix = {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    e: 0,
    f: 0,
    inverse: () => matrix,
  };
  return matrix;
};

function measuredRect(element: Element): VirtualRect {
  const labels = Array.from(element.querySelectorAll("text, tspan"))
    .map((node) => node.textContent?.trim() ?? "")
    .filter(Boolean);
  const ownText = element.textContent?.trim() ?? "";
  const longestLabel = Math.max(
    1,
    ...labels.map((label) => Array.from(label).length),
    labels.length === 0 ? Math.min(Array.from(ownText).length, 48) : 0,
  );
  const labelLines = Math.max(1, labels.length);

  if (element.localName === "svg") {
    const groups = element.querySelectorAll("g.node, g.cluster, g.actor").length;
    return virtualRect(Math.max(320, groups * 180), Math.max(120, labelLines * 28));
  }

  return virtualRect(Math.max(32, longestLabel * 8 + 24), labelLines * 20 + 12);
}

function installVirtualDom(): Document {
  const { window, document } = parseHTML("<html><body></body></html>");
  const workerGlobal = globalThis as typeof globalThis & Record<string, unknown>;

  for (const name of [
    "window",
    "document",
    "HTMLElement",
    "SVGElement",
    "Element",
    "Node",
    "DOMParser",
    "XMLSerializer",
  ] as const) {
    Object.defineProperty(workerGlobal, name, {
      configurable: true,
      value: window[name],
    });
  }

  class VirtualStyleSheet {
    readonly cssRules: Array<{ cssText: string }> = [];

    insertRule(rule: string, index = this.cssRules.length): number {
      this.cssRules.splice(index, 0, { cssText: rule });
      return index;
    }
  }

  Object.defineProperty(workerGlobal, "CSSStyleSheet", {
    configurable: true,
    value: VirtualStyleSheet,
  });
  Object.defineProperty(workerGlobal, "getComputedStyle", {
    configurable: true,
    value: () => ({
      fontFamily: "sans-serif",
      fontSize: "16px",
      getPropertyValue: () => "",
    }),
  });

  const elementPrototype = window.Element.prototype as VirtualElement;
  elementPrototype.getBBox = function getBBox() {
    return measuredRect(this);
  };
  elementPrototype.getBoundingClientRect = function getBoundingClientRect() {
    return measuredRect(this);
  };
  elementPrototype.getComputedTextLength = function getComputedTextLength() {
    return Math.max(16, Array.from(this.textContent ?? "").length * 8);
  };
  elementPrototype.getScreenCTM = virtualMatrix;

  return document;
}

const document = installVirtualDom();
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

async function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: "dark",
        fontFamily: "sans-serif",
        htmlLabels: false,
        maxTextSize: MERMAID_MAX_SOURCE_CHARS,
        maxEdges: MERMAID_MAX_EDGES,
        flowchart: { htmlLabels: false },
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

globalThis.addEventListener("message", async (event: MessageEvent<RenderRequest>) => {
  const { requestId, chart } = event.data;
  const response: RenderResponse = { requestId, ok: false };

  try {
    assertMermaidSourceBudget(chart);
    document.body.replaceChildren();
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render(`zuuli-mermaid-${requestId}`, chart);
    assertMermaidOutputBudget(svg);
    response.ok = true;
    response.svg = svg;
  } catch {
    // Never reflect parser text or creator source into logs, errors or UI.
  }

  globalThis.postMessage(response);
});
