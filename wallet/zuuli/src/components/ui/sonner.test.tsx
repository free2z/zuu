import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const sonner = vi.hoisted(() => ({
  host: vi.fn((_props: Record<string, unknown>) => null),
}));

vi.mock("sonner", () => ({ Toaster: sonner.host }));

import { Toaster } from "./sonner";

describe("Toaster viewport geometry", () => {
  it("binds every Sonner edge to the centralized safe-area offsets", () => {
    renderToStaticMarkup(<Toaster />);

    expect(sonner.host).toHaveBeenCalledOnce();
    expect(sonner.host.mock.calls[0]?.[0]).toMatchObject({
      className: "app-toaster toaster group",
      position: "bottom-right",
      offset: {
        right: "var(--toast-horizontal-offset)",
        bottom: "var(--toast-bottom-offset)",
        left: "var(--toast-horizontal-offset)",
      },
      mobileOffset: {
        right: "var(--toast-horizontal-offset)",
        bottom: "var(--toast-bottom-offset)",
        left: "var(--toast-horizontal-offset)",
      },
    });
  });
});
