import { useEffect, useRef, useState } from "react";

/**
 * Mermaid diagram renderer for the ZUULI Markdown pipeline.
 *
 * `mermaid` is HEAVY (~500 KB) and only a fraction of content uses it, so it is
 * LAZY-LOADED via a dynamic `import()` — it never touches the base bundle or the
 * login path. It is initialized ONCE (`startOnLoad:false`, `theme:'dark'`,
 * `securityLevel:'strict'`), then each block is rendered with
 * `await mermaid.render(id, chart)` into local state — we never use the global
 * `contentLoaded()` DOM scan the web renderer uses.
 *
 * `securityLevel:'strict'` sanitizes the generated SVG and needs NO unsafe-eval,
 * so no CSP change is required.
 */

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

/** Load + initialize mermaid exactly once, shared across all instances. */
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({
        startOnLoad: false,
        theme: "dark",
        securityLevel: "strict",
        fontFamily: "inherit",
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

let idSeq = 0;

export default function Mermaid({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string>("");
  const [failed, setFailed] = useState(false);
  // A DOM id unique per instance; mermaid requires a valid, unique id.
  const idRef = useRef(`zuuli-mermaid-${(idSeq += 1)}`);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setSvg("");

    loadMermaid()
      .then((mermaid) => mermaid.render(idRef.current, chart))
      .then(({ svg }) => {
        if (!cancelled) setSvg(svg);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [chart]);

  // On a parse/render error, degrade gracefully to the raw source as a code
  // block rather than throwing inside the markdown tree.
  if (failed) {
    return (
      <pre className="language-mermaid">
        <code>{chart}</code>
      </pre>
    );
  }

  if (!svg) {
    return (
      <div className="my-4 animate-pulse rounded-lg bg-muted/50 p-4 text-center text-sm text-muted-foreground">
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      className="mermaid-diagram my-4 flex justify-center overflow-x-auto"
      // SVG is produced by mermaid with securityLevel:'strict' (sanitized),
      // not from raw user HTML.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
