// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryRouter,
  RouterProvider,
  useLocation,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Feed } from "./Feed";

vi.mock("@/hooks/useRouteScroll", () => ({
  useRouteScroll: () => ({ viewport: null }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../useArticleFeed", () => ({
  useArticleFeed: () => ({
    items: [],
    count: 0,
    loading: false,
    loadingMore: false,
    error: false,
    hasMore: false,
    loadMore: vi.fn(),
    reload: vi.fn(),
  }),
}));
vi.mock("../components/TopicFilterAutocomplete", () => ({
  TopicFilterAutocomplete: ({ selected }: { selected: string[] }) => (
    <div aria-label="Selected topics">{selected.join(",")}</div>
  ),
}));
vi.mock("@/components/common/PageHeader", () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("@/components/common/EmptyState", () => ({
  EmptyState: ({ title }: { title: string }) => <p>{title}</p>,
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

describe("Feed URL state", () => {
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
  });

  it("restores search, sort and tags on back navigation without stale debounce writes", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/articles",
          element: (
            <>
              <Feed />
              <LocationProbe />
            </>
          ),
        },
      ],
      {
        initialEntries: [
          "/articles?search=earlier&sort=score&tags=zcash",
          "/articles?search=current&sort=updated&tags=privacy",
        ],
        initialIndex: 1,
      },
    );
    act(() => root.render(<RouterProvider router={router} />));
    const search = host.querySelector(
      'input[role="searchbox"]',
    ) as HTMLInputElement;
    expect(search.value).toBe("current");
    expect(
      host.querySelector('[data-testid="location-search"]')?.textContent,
    ).toBe("?search=current&sort=updated&tags=privacy");

    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(search, "pending query");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await router.navigate(-1);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(search.value).toBe("earlier");
    expect(
      host.querySelector('[data-testid="location-search"]')?.textContent,
    ).toBe("?search=earlier&sort=score&tags=zcash");
  });
});
