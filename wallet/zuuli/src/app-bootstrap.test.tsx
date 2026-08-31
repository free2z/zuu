import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { mountApplication } from "./app-bootstrap";

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
      "ZUULI locale bootstrap failed",
      failure,
    );
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain('role="alert"');
    expect(rendered[0]).toContain("Something went wrong");
    expect(rendered[0]).toContain(
      "ZUULI hit an unexpected error. Reloading usually fixes it.",
    );
    expect(rendered[0]).toContain(">Reload</button>");
  });
});
