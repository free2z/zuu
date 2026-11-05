// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/platform", () => ({
  useMock: () => true,
  isTauri: () => false,
}));
import { getTokenSnapshot, setToken } from "./http";
import { moderation } from "./moderation";
import { useSession } from "@/store/session";

afterEach(() => {
  useSession.getState().setUser(null);
  setToken(null);
});

it("keeps mock blocks owned, idempotent and rejects missing targets", async () => {
  setToken("mock-a");
  useSession.getState().setUser({ username: "mock-reader-a", tuzis: 0 });
  const snapshot = getTokenSnapshot();
  await moderation.setBlocked("zooko", true, snapshot, "mock-reader-a");
  await moderation.setBlocked("zooko", true, snapshot, "mock-reader-a");
  expect(await moderation.list(snapshot, "mock-reader-a")).toEqual(["zooko"]);
  await expect(
    moderation.setBlocked("nonexistent", true, snapshot, "mock-reader-a")
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    moderation.report(
      "comment",
      "missing",
      "spam",
      "",
      snapshot,
      "mock-reader-a"
    )
  ).rejects.toMatchObject({ status: 404 });
  useSession.getState().setUser({ username: "mock-reader-b", tuzis: 0 });
  expect(await moderation.list(snapshot, "mock-reader-b")).toEqual([]);
  await expect(
    moderation.setBlocked("zooko", false, snapshot, "mock-reader-a")
  ).rejects.toMatchObject({ status: 401 });
  useSession.getState().setUser({ username: "mock-reader-a", tuzis: 0 });
  await moderation.setBlocked("zooko", false, snapshot, "mock-reader-a");
  expect(await moderation.list(snapshot, "mock-reader-a")).toEqual([]);
});
