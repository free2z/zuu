import { describe, expect, it } from "vitest";
import type { Article, SimpleCreator } from "@/lib/api/types";
import {
  buildDiscoverySuggestions,
  localeSearchKey,
  rankTopicSuggestions,
} from "./discovery-autocomplete";

const creator = (username: string, display_name?: string): SimpleCreator => ({
  username,
  display_name,
  free2zaddr: username,
});

const page = (
  id: string,
  title: string,
  tags: string[],
  author = creator("author", "Author"),
): Article => ({ id, title, tags, author, content: "" });

describe("discovery autocomplete", () => {
  it("coalesces case, width, and accent variants using the active locale", () => {
    expect(localeSearchKey("ＰＲÍＶＡＣＹ", "es")).toBe("privacy");
    expect(localeSearchKey("İSTANBUL", "tr")).toBe("istanbul");
    expect(localeSearchKey("I", "tr")).toBe("ı");
    expect(
      rankTopicSuggestions(
        [
          { name: "Privacidad", count: 2 },
          { name: "PRIVACIDAD", count: 8 },
          { name: "Privacy", count: 20 },
        ],
        "pri",
        [],
        "es",
      ),
    ).toEqual([
      { name: "Privacy", count: 20 },
      { name: "PRIVACIDAD", count: 8 },
    ]);
  });

  it("ranks mixed topics, creators, and pages while preserving backend order", () => {
    const suggestions = buildDiscoverySuggestions({
      query: "privacy",
      locale: "en-US",
      creators: [creator("privacy_lab", "Privacy Lab"), creator("alice")],
      pages: [
        page("1", "Privacy in practice", ["Privacy", "Zcash"]),
        page("2", "A second view", ["PRÍVACY"]),
      ],
    });

    expect(suggestions.map(({ kind, label }) => [kind, label])).toEqual([
      ["topic", "Privacy"],
      ["page", "Privacy in practice"],
      ["page", "A second view"],
      ["creator", "Privacy Lab"],
      ["creator", "alice"],
    ]);
    expect(suggestions.filter(({ kind }) => kind === "topic")).toHaveLength(1);
  });

  it("omits locale-equivalent selected topics and bounds every suggestion kind", () => {
    const suggestions = buildDiscoverySuggestions({
      query: "z",
      locale: "de",
      selectedTopics: ["Zéro"],
      creators: Array.from({ length: 5 }, (_, index) => creator(`z-${index}`)),
      pages: Array.from({ length: 5 }, (_, index) =>
        page(String(index), `Z page ${index}`, [
          index === 0 ? "ZERO" : `z${index}`,
        ]),
      ),
      limit: 8,
    });

    expect(suggestions).toHaveLength(8);
    expect(
      suggestions.filter(({ kind }) => kind === "creator").length,
    ).toBeLessThanOrEqual(3);
    expect(
      suggestions.filter(({ kind }) => kind === "page").length,
    ).toBeLessThanOrEqual(3);
    expect(
      suggestions.some(
        ({ kind, label }) => kind === "topic" && label === "ZERO",
      ),
    ).toBe(false);
  });

  it("returns no default vocabulary before the user types", () => {
    expect(
      buildDiscoverySuggestions({
        query: "  ",
        creators: [creator("alice")],
        pages: [page("1", "Hello", ["privacy"])],
      }),
    ).toEqual([]);
  });
});
