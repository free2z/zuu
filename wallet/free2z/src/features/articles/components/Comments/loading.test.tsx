// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/api/free2z", () => ({ comments: { list: vi.fn(), create: vi.fn() } }));
vi.mock("./CommentForm", () => ({ CommentForm: () => null }));
vi.mock("./CommentThread", () => ({ CommentThread: () => null }));
import { comments } from "@/lib/api/free2z";
import { CommentsSection } from "./index";

it("settles the comments skeleton when a later pagination request rejects", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(comments.list)
    .mockResolvedValueOnce({ items: [], count: 1, next: 2 })
    .mockRejectedValueOnce(new Error("response decoder failed"));
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<CommentsSection uuid="article-one" />); });
    expect(container.textContent).toContain("Couldn’t load comments");
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(comments.list).toHaveBeenCalledTimes(2);
    expect(comments.create).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

afterEach(() => vi.unstubAllGlobals());
