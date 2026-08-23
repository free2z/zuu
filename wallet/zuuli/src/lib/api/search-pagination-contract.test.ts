import { describe, expect, it } from "vitest";
import { parseCreatorSearchPage, parsePageSearchPage } from "./free2z";

const query = "zero knowledge";

function creator(username: string) {
  return { username, full_name: username.toUpperCase() };
}

function zpage(id: string) {
  return {
    free2zaddr: id,
    title: `Page ${id}`,
    creator: creator("alice"),
  };
}

function envelope(
  endpoint: "/api/creator/" | "/api/zpage/",
  results: unknown[],
  extra = "",
) {
  const params = new URLSearchParams({
    search: query,
    page: "2",
    page_size: "24",
  });
  if (endpoint === "/api/creator/") params.set("ordering", "-total");
  return {
    count: 30,
    next: `${endpoint}?${params.toString()}${extra}`,
    previous: null,
    results,
  };
}

describe("global Search pagination API contract", () => {
  it("preserves independent creator and page cursors with authoritative counts", () => {
    expect(
      parseCreatorSearchPage(
        envelope("/api/creator/", [creator("alice")]),
        query,
        1,
        24,
      ),
    ).toMatchObject({ count: 30, next: 2, items: [{ username: "alice" }] });
    expect(
      parsePageSearchPage(
        envelope("/api/zpage/", [zpage("one")]),
        query,
        1,
        24,
      ),
    ).toMatchObject({ count: 30, next: 2, items: [{ id: "one" }] });
  });

  it("accepts an authoritative empty terminal corpus", () => {
    expect(
      parsePageSearchPage(
        { count: 0, next: null, previous: null, results: [] },
        query,
        1,
        24,
      ),
    ).toEqual({ count: 0, next: null, items: [] });
  });

  it("rejects malformed counts and result identities", () => {
    expect(() =>
      parseCreatorSearchPage(
        { ...envelope("/api/creator/", []), count: "30" },
        query,
        1,
        24,
      ),
    ).toThrow("pagination count");
    expect(() =>
      parseCreatorSearchPage(envelope("/api/creator/", [{}]), query, 1, 24),
    ).toThrow("creator search result identity");
    expect(() =>
      parsePageSearchPage(
        envelope("/api/zpage/", [{ free2zaddr: "one", title: "One" }]),
        query,
        1,
        24,
      ),
    ).toThrow("page search result identity");
  });

  it.each([
    [
      "endpoint",
      "/api/zpage/?search=zero+knowledge&page=2&page_size=24&ordering=-total",
      "left its endpoint",
    ],
    [
      "query",
      "/api/creator/?search=another&page=2&page_size=24&ordering=-total",
      "changed its query",
    ],
    [
      "page size",
      "/api/creator/?search=zero+knowledge&page=2&page_size=25&ordering=-total",
      "changed its page size",
    ],
    [
      "ordering",
      "/api/creator/?search=zero+knowledge&page=2&page_size=24&ordering=popular",
      "changed its ordering",
    ],
    [
      "next page",
      "/api/creator/?search=zero+knowledge&page=3&page_size=24&ordering=-total",
      "invalid next page",
    ],
  ])("rejects a creator cursor that changes its %s", (_case, next, error) => {
    expect(() =>
      parseCreatorSearchPage(
        { ...envelope("/api/creator/", []), next },
        query,
        1,
        24,
      ),
    ).toThrow(error);
  });

  it("accepts the absolute cursor shape emitted by production DRF", () => {
    const relative = envelope("/api/creator/", [creator("alice")]);
    expect(
      parseCreatorSearchPage(
        { ...relative, next: `https://free2z.cash${relative.next}` },
        query,
        1,
        24,
      ),
    ).toMatchObject({ next: 2, count: 30 });
  });
});
