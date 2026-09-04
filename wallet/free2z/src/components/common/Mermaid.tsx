import DOMPurify from "dompurify";
import { useEffect, useRef, useState } from "react";
import {
  MERMAID_RENDER_TIMEOUT_MS,
  MermaidWorkerBudget,
  assertMermaidOutputBudget,
  assertMermaidSourceBudget,
} from "./mermaid-policy";

interface RenderResponse {
  requestId: string;
  ok: boolean;
  svg?: string;
}

let idSeq = 0;
const workerBudget = new MermaidWorkerBudget();

function sanitizeSvg(candidate: string): string {
  assertMermaidOutputBudget(candidate);
  const sanitized = DOMPurify.sanitize(candidate, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [
      "a",
      "animate",
      "animateMotion",
      "animateTransform",
      "discard",
      "embed",
      "feImage",
      "foreignObject",
      "iframe",
      "image",
      "object",
      "script",
      "set",
    ],
    SANITIZE_NAMED_PROPS: true,
  });
  assertMermaidOutputBudget(sanitized);

  const parsed = new DOMParser().parseFromString(sanitized, "image/svg+xml");
  if (
    parsed.documentElement.localName !== "svg" ||
    parsed.querySelector("parsererror, script, iframe, object, embed, foreignObject")
  ) {
    throw new Error("Unsafe Mermaid output");
  }
  for (const element of parsed.querySelectorAll("*")) {
    for (const attribute of element.getAttributeNames()) {
      if (/^on/i.test(attribute)) throw new Error("Unsafe Mermaid output");
      if (/^(?:href|src|xlink:href)$/i.test(attribute)) {
        const value = element.getAttribute(attribute)?.trim() ?? "";
        if (!value.startsWith("#")) throw new Error("Unsafe Mermaid output");
      }
      const attributeValue = element.getAttribute(attribute) ?? "";
      const hasExternalAttributeUrl = Array.from(
        attributeValue.matchAll(/url\(([^)]*)\)/gi),
      ).some(
        ([, rawUrl]) => !rawUrl.trim().replace(/^["']|["']$/g, "").startsWith("#"),
      );
      if (hasExternalAttributeUrl) throw new Error("Unsafe Mermaid output");
    }
    if (element.localName === "style") {
      const css = element.textContent ?? "";
      const hasExternalUrl = Array.from(css.matchAll(/url\(([^)]*)\)/gi)).some(
        ([, rawUrl]) => !rawUrl.trim().replace(/^["']|["']$/g, "").startsWith("#"),
      );
      if (/@import/i.test(css) || hasExternalUrl) throw new Error("Unsafe Mermaid output");
    }
  }
  return sanitized;
}

function IsolatedSvg({ svg }: { svg: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const shadow = shadowRef.current ?? host.attachShadow({ mode: "open" });
    shadowRef.current = shadow;
    shadow.innerHTML = svg;
    return () => shadow.replaceChildren();
  }, [svg]);

  return <div ref={hostRef} data-mermaid-shadow-host />;
}

/**
 * Creator-controlled parsing and layout run in a disposable module Worker,
 * never on the wallet UI thread. Every attempt has explicit source, lexical,
 * output and wall-clock bounds; cleanup terminates the worker rather than only
 * racing a main-thread promise. The returned SVG is sanitized again in the real
 * browser DOM and mounted in a Shadow DOM so diagram styles cannot escape.
 */

export default function Mermaid({ chart }: { chart: string }) {
  const [svg, setSvg] = useState("");
  const [failed, setFailed] = useState(false);
  const requestIdRef = useRef(`render-${(idSeq += 1)}`);

  useEffect(() => {
    setFailed(false);
    setSvg("");

    try {
      assertMermaidSourceBudget(chart);
    } catch {
      setFailed(true);
      return;
    }

    // An article with many diagram fences must not create a worker storm. Four
    // active renderers is the whole-app concurrency budget; excess diagrams
    // fail closed to their escaped source block.
    const releaseWorkerSlot = workerBudget.acquire();
    if (!releaseWorkerSlot) {
      setFailed(true);
      return;
    }

    const requestId = requestIdRef.current;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./mermaid.worker.ts", import.meta.url), {
        name: "zuuli-mermaid-renderer",
        type: "module",
      });
    } catch {
      releaseWorkerSlot();
      setFailed(true);
      return;
    }
    let settled = false;

    const finish = (nextSvg?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.terminate();
      releaseWorkerSlot();
      if (!nextSvg) {
        setFailed(true);
        return;
      }
      try {
        setSvg(sanitizeSvg(nextSvg));
      } catch {
        setFailed(true);
      }
    };

    const timeout = window.setTimeout(() => finish(), MERMAID_RENDER_TIMEOUT_MS);
    worker.addEventListener("message", (event: MessageEvent<RenderResponse>) => {
      const result = event.data;
      if (result.requestId !== requestId) return;
      finish(result.ok ? result.svg : undefined);
    });
    worker.addEventListener("error", () => finish());
    worker.postMessage({ requestId, chart });

    return () => {
      settled = true;
      clearTimeout(timeout);
      worker.terminate();
      releaseWorkerSlot();
    };
  }, [chart]);

  if (failed) {
    return (
      <pre className="language-mermaid" data-mermaid-status="rejected">
        <code>{chart}</code>
      </pre>
    );
  }

  if (!svg) {
    return (
      <div
        className="my-4 animate-pulse rounded-lg bg-muted/50 p-4 text-center text-sm text-muted-foreground"
        data-mermaid-status="rendering"
      >
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      className="mermaid-diagram my-4 flex justify-center overflow-x-auto"
      data-mermaid-status="rendered"
    >
      <IsolatedSvg svg={svg} />
    </div>
  );
}
