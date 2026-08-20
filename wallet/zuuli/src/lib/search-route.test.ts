import { describe, expect, it } from "vitest";
import {
  isSearchRoute,
  searchHref,
  withSearchQuery,
} from "./search-route";

describe("route-backed search contract", () => {
  it("recognizes only the Search route and its mounted descendants", () => {
    expect(isSearchRoute("/search")).toBe(true);
    expect(isSearchRoute("/search/results")).toBe(true);
    expect(isSearchRoute("/searching")).toBe(false);
    expect(isSearchRoute("/articles/search")).toBe(false);
  });

  it("builds a canonical TopBar destination without losing Unicode", () => {
    expect(searchHref("  shielded payments  ")).toBe(
      "/search?q=shielded%20payments",
    );
    expect(searchHref("élodie")).toBe("/search?q=%C3%A9lodie");
    expect(searchHref("   ")).toBe("/search");
  });

  it("changes only q so route-owned filters survive typing and clear", () => {
    const initial = new URLSearchParams("tab=pages&q=old&sort=newest");
    expect(withSearchQuery(initial, "new phrase").toString()).toBe(
      "tab=pages&q=new+phrase&sort=newest",
    );
    expect(withSearchQuery(initial, "").toString()).toBe(
      "tab=pages&sort=newest",
    );
    expect(initial.toString()).toBe("tab=pages&q=old&sort=newest");
  });
});
