import { describe, expect, it } from "vitest";
import type { SearchResultPage } from "@/lib/api/types";
import {
  mergeSearchPage,
  SearchSnapshotCache,
  type SearchSnapshot,
} from "./pagination";

interface Result {
  id: string;
}

const identity = (result: Result) => result.id;
const result = (id: string): Result => ({ id });

function initial(key = "privacy"): SearchSnapshot<Result> {
  return {
    key,
    items: [],
    next: 1,
    count: null,
    initialized: false,
  };
}

function page(
  items: Result[],
  next: number | null,
  count: number,
): SearchResultPage<Result> {
  return { items, next, count };
}

describe("global Search result pagination", () => {
  it("deduplicates overlapping pages without changing backend order", () => {
    const first = mergeSearchPage(
      initial(),
      page([result("a"), result("b")], 2, 3),
      1,
      identity,
    );
    const complete = mergeSearchPage(
      first,
      page([result("b"), result("c")], null, 3),
      2,
      identity,
    );
    expect(complete.items.map(identity)).toEqual(["a", "b", "c"]);
    expect(complete.next).toBeNull();
    expect(complete.count).toBe(3);
  });

  it("accepts an empty terminal corpus but rejects empty nonterminal progress", () => {
    expect(mergeSearchPage(initial(), page([], null, 0), 1, identity)).toEqual({
      key: "privacy",
      items: [],
      next: null,
      count: 0,
      initialized: true,
    });
    expect(() =>
      mergeSearchPage(initial(), page([], 2, 3), 1, identity),
    ).toThrow("made no progress");
  });

  it("fails closed on count drift, early termination, and cursor jumps", () => {
    const first = mergeSearchPage(
      initial(),
      page([result("a")], 2, 2),
      1,
      identity,
    );
    expect(() =>
      mergeSearchPage(first, page([result("b")], null, 3), 2, identity),
    ).toThrow("count changed");
    expect(() =>
      mergeSearchPage(first, page([], null, 2), 2, identity),
    ).toThrow("before every result");
    expect(() =>
      mergeSearchPage(first, page([result("b")], 4, 2), 2, identity),
    ).toThrow("unexpected next page");
  });

  it("keeps only the most recently used query snapshots", () => {
    const cache = new SearchSnapshotCache<Result>(2);
    cache.remember({ ...initial("one"), initialized: true });
    cache.remember({ ...initial("two"), initialized: true });
    expect(cache.restore("one")?.key).toBe("one");
    cache.remember({ ...initial("three"), initialized: true });
    expect(cache.restore("two")).toBeNull();
    expect(cache.restore("one")?.key).toBe("one");
    expect(cache.restore("three")?.key).toBe("three");
  });
});
