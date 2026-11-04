import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

// This is the exact advisory input from GHSA-2v8p-3f2j-5mp7. Mermaid <10.9.8
// can enter an unbounded append loop for it, so establish the patched v10
// version before the probe is placed in a browser or Mermaid is loaded.
const POC = ["xychart", "  x-axis 1 --> 1", "  line [1, 2]"].join("\n");
const RENDER_TIMEOUT_MS = 5_000;

// Promise.race bounds an asynchronous renderer; this independent Playwright
// watchdog also makes a future synchronous event-loop regression fail quickly.
test.setTimeout(10_000);

function isPatchedV10(version: string): boolean {
  const [major, minor, patch] = version.split(".").map(Number);
  return major === 10 && (minor > 9 || (minor === 9 && patch >= 8));
}

test("the patched Mermaid browser bundle settles the invalid XY-axis PoC promptly", async ({
  page,
}) => {
  const packageJsonPath = resolve(
    process.cwd(),
    "node_modules/mermaid/package.json",
  );
  const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version: string;
  };

  // This guard is deliberately before injection and before POC insertion. A
  // lockfile regression must fail safely rather than ever exercise an affected
  // Mermaid release in a browser process.
  expect(isPatchedV10(version)).toBe(true);

  // MarkdownContent selects this exact fenced-code DOM shape, dynamically
  // imports the same package, initializes strict mode, and replaces the <pre>
  // with either a sanitized SVG or its intentional code/error fallback. This
  // direct browser probe avoids coupling the security regression to Vite SSR
  // route compilation while retaining the production Mermaid browser bundle.
  await page.setContent(
    '<main class="markdown-content"><pre><code class="language-mermaid"></code></pre><p>mermaid-invalid-axis-tail-sentinel</p></main>',
  );
  await page.locator("code.language-mermaid").evaluate((node, source) => {
    node.textContent = source;
  }, POC);
  await page.addScriptTag({
    path: resolve(process.cwd(), "node_modules/mermaid/dist/mermaid.min.js"),
  });

  const result = await page.evaluate(
    async ({ source, timeoutMs }) => {
      const code = document.querySelector("code.language-mermaid");
      const pre = code?.closest("pre");
      if (!code || !pre) throw new Error("Missing Mermaid fenced-code fixture");

      const mermaid = (
        window as typeof window & {
          mermaid?: {
            initialize(options: Record<string, unknown>): void;
            render(id: string, text: string): Promise<{ svg: string }>;
          };
        }
      ).mermaid;
      if (!mermaid) throw new Error("Mermaid browser bundle was not loaded");

      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
      const diagram = document.createElement("div");
      diagram.className = "mermaid-diagram";
      const startedAt = performance.now();
      let outcome: "rendered" | "error";

      try {
        const rendered = await Promise.race([
          mermaid.render("issue-1052-invalid-axis", source),
          new Promise<never>((_, reject) => {
            window.setTimeout(
              () =>
                reject(
                  new Error(
                    "Mermaid render did not settle within the safety bound",
                  ),
                ),
              timeoutMs,
            );
          }),
        ]);
        diagram.innerHTML = rendered.svg;
        outcome = "rendered";
      } catch (error) {
        // Mirror MarkdownContent's safe failure posture: retain source as text,
        // never injected markup, and expose a readable rendering error.
        diagram.classList.add("mermaid-diagram-error");
        const fallback = document.createElement("pre");
        const fallbackCode = document.createElement("code");
        fallbackCode.className = "language-mermaid";
        fallbackCode.textContent = source;
        fallback.append(fallbackCode);
        const message = document.createElement("p");
        message.className = "mermaid-error-message";
        message.textContent = `Unable to render Mermaid diagram: ${String(error)}`;
        diagram.append(fallback, message);
        outcome = "error";
      }

      pre.replaceWith(diagram);
      const responsiveness = await new Promise<{
        animationFrames: number;
        timerDelayMs: number;
      }>((resolve) => {
        const responsivenessStartedAt = performance.now();
        let animationFrames = 0;
        requestAnimationFrame(() => {
          animationFrames += 1;
          requestAnimationFrame(() => {
            animationFrames += 1;
            window.setTimeout(() => {
              resolve({
                animationFrames,
                timerDelayMs: performance.now() - responsivenessStartedAt,
              });
            }, 0);
          });
        });
      });

      return {
        elapsedMs: performance.now() - startedAt,
        errorFallback: diagram.classList.contains("mermaid-diagram-error"),
        fallbackSource: diagram.querySelector("code")?.textContent,
        outcome,
        responsiveness,
        tailPresent: document.body.textContent?.includes(
          "mermaid-invalid-axis-tail-sentinel",
        ),
      };
    },
    { source: POC, timeoutMs: RENDER_TIMEOUT_MS },
  );

  expect(result.elapsedMs).toBeLessThan(RENDER_TIMEOUT_MS);
  expect(result.outcome === "rendered" || result.errorFallback).toBe(true);
  if (result.errorFallback) expect(result.fallbackSource).toBe(POC);
  expect(result.tailPresent).toBe(true);
  expect(result.responsiveness.animationFrames).toBe(2);
  expect(result.responsiveness.timerDelayMs).toBeLessThan(1_000);
});
