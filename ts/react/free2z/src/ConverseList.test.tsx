import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { VirtuosoMockContext } from "react-virtuoso";

import ConverseList from "./ConverseList";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-query", () => ({
  useInfiniteQuery: () => ({
    data: {
      pages: [
        {
          count: 1,
          next: null,
          previous: null,
          results: [
            {
              uuid: "async-embed-comment",
              author: { username: "alice" },
              parent: null,
              headline: "An asynchronously sized embed",
              content: "::embed[https://example.com/video]",
              tuzis: 0,
              created_at: "2026-08-23T00:00:00Z",
              updated_at: "2026-08-23T00:00:00Z",
              num_children: 0,
              content_url: null,
            },
          ],
        },
      ],
    },
    fetchNextPage: jest.fn(),
    hasNextPage: false,
    isLoading: false,
    isError: false,
    isSuccess: true,
  }),
}));

jest.mock("react-router-dom", () => ({
  useLocation: () => ({ pathname: "/converse" }),
  useNavigate: () => jest.fn(),
}));

jest.mock("react-helmet-async", () => ({
  Helmet: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("./components/ConverseListFilters", () => ({
  ConverseListFilters: () => <div>Search filters</div>,
}));

jest.mock("./components/CommentCardInfinite", () => {
  const React = require("react");

  return function AsyncEmbedComment() {
    const [loaded, setLoaded] = React.useState(false);

    React.useEffect(() => {
      const timeout = globalThis.setTimeout(() => setLoaded(true), 10);
      return () => globalThis.clearTimeout(timeout);
    }, []);

    return (
      <article
        data-testid="async-embed"
        style={{ height: loaded ? "500px" : "20px" }}
      >
        {loaded ? "Embed loaded" : "Loading embed"}
      </article>
    );
  };
});

test("keeps async embed resizes from selecting a native scroll anchor in the virtual feed", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(
      <VirtuosoMockContext.Provider
        value={{ viewportHeight: 600, itemHeight: 20 }}
      >
        <ConverseList />
      </VirtuosoMockContext.Provider>
    );
  });

  const feed = container.querySelector(".converse-feed");
  expect(feed).not.toBeNull();

  await act(async () => {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  });
  expect(
    container.querySelector('[data-testid="async-embed"]')?.textContent
  ).toBe("Embed loaded");
  expect(container.querySelector(".converse-feed")).toBe(feed);

  await act(async () => root.unmount());
  container.remove();
});
