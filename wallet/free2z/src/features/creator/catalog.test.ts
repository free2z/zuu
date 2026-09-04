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

function initial(): CreatorCatalogSnapshot {
  return { items: [], next: 1, count: null, initialized: false };
}

describe("creator catalog pagination", () => {
  it("deduplicates overlapping pages and completes at the authoritative count", () => {
    const first = mergeCreatorCatalogPage(
      initial(),
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

  it("adopts the first list response count independently of its profile hint", () => {
    expect(
      mergeCreatorCatalogPage(
        initial(),
        { items: [article(1)], next: null, count: 1 },
        1,
      ),
    ).toMatchObject({ count: 1, initialized: true });
    expect(
      mergeCreatorCatalogPage(
        initial(),
        { items: [], next: null, count: 0 },
        1,
      ),
    ).toMatchObject({ count: 0, initialized: true });
  });

  it("fails closed on list count drift or an incomplete terminal page", () => {
    expect(() =>
      mergeCreatorCatalogPage(
        initial(),
        { items: [article(1)], next: null, count: 2 },
        1,
      ),
    ).toThrow("incomplete catalog");
    const first = mergeCreatorCatalogPage(
      initial(),
      { items: [article(1)], next: 2, count: 2 },
      1,
    );
    expect(() =>
      mergeCreatorCatalogPage(
        first,
        { items: [article(2)], next: null, count: 3 },
        2,
      ),
    ).toThrow("count changed");
  });

  it("fails closed when a nonterminal page adds no unique rows", () => {
    expect(() =>
      mergeCreatorCatalogPage(initial(), { items: [], next: 2, count: 2 }, 1),
    ).toThrow("made no progress");

    const first = mergeCreatorCatalogPage(
      initial(),
      { items: [article(1)], next: 2, count: 2 },
      1,
    );
    expect(() =>
      mergeCreatorCatalogPage(
        first,
        { items: [article(1)], next: 3, count: 2 },
        2,
      ),
    ).toThrow("made no progress");
  });
});
