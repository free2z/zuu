import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { mountApplication } from "./app-bootstrap";
// The entry point as text. Vite's `?raw` rather than `node:fs`, because
// `@types/node` is deliberately not in this project's `types` and widening
// every file's ambient scope to read one file would be the larger change.
import mainSource from "./main.tsx?raw";

describe("application locale bootstrap", () => {
  it("renders a dependency-free recovery frame when locale initialization rejects", async () => {
    const failure = new Error("catalog chunk unavailable");
    const rendered: string[] = [];
    const reportError = vi.fn();

    await mountApplication({
      root: {
        render(children) {
          rendered.push(renderToStaticMarkup(children));
        },
      },
      initializeI18n: async () => {
        throw failure;
      },
      renderApplication: () => {
        throw new Error("must not render the app after initialization fails");
      },
      reportError,
    });

    expect(reportError).toHaveBeenCalledWith(
      "e2e2z locale bootstrap failed",
      failure,
    );
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain('role="alert"');
    expect(rendered[0]).toContain("Something went wrong");
    expect(rendered[0]).toContain(
      "e2e2z hit an unexpected error. Reloading usually fixes it.",
    );
    expect(rendered[0]).toContain(">Reload</button>");
  });

  // Having the recovery frame is not the same as reaching it. e2e2z shipped
  // #973 with this whole module unused: `main.tsx` was a bare
  // `void initializeAppI18n().then(...)`, so a rejected bootstrap produced an
  // empty root and the tests above still passed, because they call
  // `mountApplication` directly and never ask whether anything else does.
  //
  // Reading the entry point is the only way to hold that. It is a single
  // screen with no router, so there is exactly one file to check.
  //
  // Matched as a pattern rather than as one literal line because the boundary
  // now also carries an `onError` that reports into the diagnostics buffer, so
  // the tag spans several lines. The pattern still requires the same two things
  // the literal did — a boundary, with `RootFallback` as its fallback — and
  // additionally tolerates no gap between them, so it cannot be satisfied by a
  // boundary in one place and a stray `RootFallback` in another.
  it("is what the entry point actually mounts through", () => {
    expect(mainSource).toContain("mountApplication");
    expect(mainSource).toMatch(
      /<ErrorBoundary[^>]*\bfallback=\{<RootFallback \/>\}/u,
    );
    // The shape that shipped the bug: the entry point driving the render
    // itself, off a promise nothing was catching. It hands a root to
    // `mountApplication` and renders nothing on its own.
    expect(mainSource).not.toContain(").render(");
  });
});
