// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { getTokenSnapshot, setToken } from "./http";
import { moderation } from "./moderation";

afterEach(() => {
  setToken(null);
  vi.unstubAllGlobals();
});

it("uses authenticated authoritative routes for list, block, unblock and report", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const list = String(input).includes("blocks/mine");
    return new Response(
      JSON.stringify(
        list
          ? { count: 1, next: null, results: [{ username: "bob" }] }
          : { active: true }
      ),
      { status: 200 }
    );
  });
  vi.stubGlobal("fetch", fetch);
  window.fetch = fetch as typeof window.fetch;
  setToken("alice-token");
  const session = getTokenSnapshot();
  expect(await moderation.list(session)).toEqual(["bob"]);
  await moderation.setBlocked("bob", true, session);
  await moderation.setBlocked("bob", false, session);
  await moderation.report("comment", "abc", "spam", "details", session);
  expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
    "/api/g12f/blocks/mine/",
    "/api/creator/bob/block/",
    "/api/creator/bob/block/",
    "/api/reports/",
  ]);
  expect(calls.map((c) => c.init.method)).toEqual([
    "GET",
    "PUT",
    "DELETE",
    "POST",
  ]);
  expect(
    calls.every(
      (c) =>
        (c.init.headers as Record<string, string>).Authorization ===
        "Token alice-token"
    )
  ).toBe(true);
  expect(JSON.parse(calls[3].init.body as string)).toEqual({
    target_kind: "comment",
    target_id: "abc",
    reason: "spam",
    details: "details",
  });
});
