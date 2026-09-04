import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResultPage, SimpleCreator } from "@/lib/api/types";
import {
  creatorSearchIdentity,
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
  afterEach(() => vi.restoreAllMocks());

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

  it("accepts an empty terminal corpus", () => {
    expect(mergeSearchPage(initial(), page([], null, 0), 1, identity)).toEqual({
      key: "privacy",
      items: [],
      next: null,
      count: 0,
      initialized: true,
    });
  });

  it("advances past a fully duplicated nonterminal page to later rows", () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const first = mergeSearchPage(
      initial(),
      page([result("a"), result("b")], 2, 3),
      1,
      identity,
    );
    const duplicate = mergeSearchPage(
      first,
      page([result("a"), result("b")], 3, 3),
      2,
      identity,
    );
    expect(duplicate).toMatchObject({
      items: [{ id: "a" }, { id: "b" }],
      next: 3,
    });
    expect(warning).toHaveBeenCalledWith(
      "Search page contained no new rows; advancing its cursor.",
      { requestedPage: 2, next: 3 },
    );

    const complete = mergeSearchPage(
      duplicate,
      page([result("c")], null, 3),
      3,
      identity,
    );
    expect(complete.items.map(identity)).toEqual(["a", "b", "c"]);
    expect(complete.next).toBeNull();
  });

  it("keeps valid rows when advisory counts drift or a tied row is skipped", () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const first = mergeSearchPage(
      initial(),
      page([result("a")], 2, 2),
      1,
      identity,
    );
    expect(
      mergeSearchPage(first, page([result("c")], null, 3), 2, identity),
    ).toMatchObject({
      items: [{ id: "a" }, { id: "c" }],
      next: null,
      count: 3,
    });
    expect(warning).toHaveBeenCalledWith(
      "Search result count changed during pagination.",
      expect.objectContaining({ previousCount: 2, responseCount: 3 }),
    );
  });

  it("fails closed on cursor jumps", () => {
    const first = mergeSearchPage(
      initial(),
      page([result("a")], 2, 2),
      1,
      identity,
    );
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

  it("keeps case-variant creator accounts distinct by stable address", () => {
    const creator = (username: string, free2zaddr: string): SimpleCreator => ({
      username,
      free2zaddr,
    });
    const merged = mergeSearchPage(
      {
        key: "shared",
        items: [],
        next: 1,
        count: null,
        initialized: false,
      },
      {
        items: [
          creator("Shared", "t-addr-one"),
          creator("shared", "t-addr-two"),
        ],
        next: null,
        count: 2,
      },
      1,
      creatorSearchIdentity,
    );
    expect(merged.items.map(({ free2zaddr }) => free2zaddr)).toEqual([
      "t-addr-one",
      "t-addr-two",
    ]);
  });
});
