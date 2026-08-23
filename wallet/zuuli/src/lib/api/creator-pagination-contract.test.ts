import { describe, expect, it } from "vitest";
import { parseCreatorPagesPage } from "./free2z";

function row(id: string) {
  return {
    free2zaddr: id,
    vanity: id,
    title: `Page ${id}`,
    creator: { username: "zooko" },
  };
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    count: 2,
    next: "/api/zpage/?username=zooko&page=2",
    previous: null,
    results: [row("one")],
    ...overrides,
  };
}

describe("creator pagination API contract", () => {
  it("parses a same-filter forward cursor", () => {
    expect(parseCreatorPagesPage(page(), "zooko", 1)).toMatchObject({
      count: 2,
      next: 2,
      items: [{ id: "one", title: "Page one" }],
    });
  });

  it("rejects malformed rows and pagination metadata", () => {
    expect(() =>
      parseCreatorPagesPage(page({ count: "2" }), "zooko", 1),
    ).toThrow("pagination count");
    expect(() =>
      parseCreatorPagesPage(page({ results: [{}] }), "zooko", 1),
    ).toThrow("page identity");
    expect(() =>
      parseCreatorPagesPage(
        page({ next: "/api/zpage/?username=someone-else&page=2" }),
        "zooko",
        1,
      ),
    ).toThrow("changed its creator filter");
    expect(() =>
      parseCreatorPagesPage(
        page({ next: "/api/creator/?username=zooko&page=2" }),
        "zooko",
        1,
      ),
    ).toThrow("left its endpoint");
    expect(() =>
      parseCreatorPagesPage(
        page({ next: "/api/zpage/?username=zooko&page=3" }),
        "zooko",
        1,
      ),
    ).toThrow("invalid next page");
  });
});
