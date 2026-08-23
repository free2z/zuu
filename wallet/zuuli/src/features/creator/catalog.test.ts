import { describe, expect, it } from "vitest";
import type { Article } from "@/lib/api/types";
import {
  mergeCreatorCatalogPage,
  type CreatorCatalogSnapshot,
} from "./catalog";

function article(id: number): Article {
  return {
    id,
    free2zaddr: String(id),
    title: `Page ${id}`,
    content: "",
    author: { username: "creator", free2zaddr: "creator" },
  };
}

function initial(count: number): CreatorCatalogSnapshot {
  return { items: [], next: 1, count, initialized: false };
}

describe("creator catalog pagination", () => {
  it("deduplicates overlapping pages and completes at the authoritative count", () => {
    const first = mergeCreatorCatalogPage(
      initial(3),
      { items: [article(1), article(2)], next: 2, count: 3 },
      1,
    );
    const complete = mergeCreatorCatalogPage(
      first,
      { items: [article(2), article(3)], next: null, count: 3 },
      2,
    );
    expect(complete.items.map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(complete.next).toBeNull();
  });

  it("fails closed on count drift or an incomplete terminal page", () => {
    expect(() =>
      mergeCreatorCatalogPage(
        initial(2),
        { items: [article(1)], next: null, count: 2 },
        1,
      ),
    ).toThrow("incomplete catalog");
    expect(() =>
      mergeCreatorCatalogPage(
        initial(2),
        { items: [article(1)], next: null, count: 3 },
        1,
      ),
    ).toThrow("count changed");
  });
});
