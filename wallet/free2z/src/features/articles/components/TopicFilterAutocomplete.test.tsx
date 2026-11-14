// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { articles } from "@/lib/api/free2z";
import { TopicFilterAutocomplete } from "./TopicFilterAutocomplete";

describe("TopicFilterAutocomplete", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts collapsed, intersects facets, and supports keyboard selection/removal", async () => {
    const changed = vi.fn();
    vi.spyOn(articles, "suggestTags").mockResolvedValue([
      { name: "privacy", count: 3 },
    ]);
    act(() =>
      root.render(
        <TopicFilterAutocomplete
          selected={["zcash"]}
          onChange={changed}
          filters={{ search: "proof", sort: "score" }}
        />,
      ),
    );

    const details = host.querySelector("details");
    expect(details?.open).toBe(false);
    expect(host.textContent).toContain("#zcash");
    act(() =>
      (
        host.querySelector(
          '[aria-label="Remove topic zcash"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(changed).toHaveBeenCalledWith([]);
    changed.mockClear();
    act(() => (host.querySelector("summary") as HTMLElement).click());
    const input = host.querySelector(
      'input[role="combobox"]',
    ) as HTMLInputElement;
    act(() => {
      input.focus();
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "pri");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(articles.suggestTags).toHaveBeenCalledWith("pri", ["zcash"], {
      search: "proof",
      sort: "score",
    });
    expect(host.querySelector('[role="option"]')?.textContent).toContain("3");
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      ),
    );
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(input.getAttribute("aria-expanded")).toBe("false");
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      ),
    );
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
        }),
      ),
    );
    expect(changed).toHaveBeenCalledWith(["zcash", "privacy"]);
    const remove = host.querySelector('[aria-label="Remove topic zcash"]');
    act(() => (remove as HTMLButtonElement).click());
    expect(changed).toHaveBeenLastCalledWith([]);
  });
});
