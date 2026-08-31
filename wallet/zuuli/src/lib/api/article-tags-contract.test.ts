import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./http", async (importOriginal) => {
  const original = await importOriginal<typeof import("./http")>();
  return { ...original, request: vi.fn() };
});

import { ArticlePublishedHydrationError, articles } from "./free2z";
import { request } from "./http";

const requestMock = vi.mocked(request);

describe("article tag HTTP contract", () => {
  beforeEach(() => requestMock.mockReset());

  it("publishes canonical, deduplicated tags in the zpage body", async () => {
    requestMock
      // Documented create response (`zPageUpdate`) has no creator object.
      .mockResolvedValueOnce({
        free2zaddr: "article-id",
        title: "Tagged",
        content: "Body",
        tags: ["zero knowledge", "privacy", "c++"],
      })
      .mockResolvedValueOnce({
        free2zaddr: "article-id",
        title: "Tagged",
        content: "Body",
        creator: { username: "alice" },
        tags: ["Zero Knowledge", "privacy", "C++"],
      });

    await expect(
      articles.publish({
        title: "Tagged",
        content: "Body",
        tags: [" Zero Knowledge ", "PRIVACY", "privacy", "C++"],
      }),
    ).resolves.toMatchObject({
      author: { username: "alice" },
      tags: ["Zero Knowledge", "privacy", "C++"],
    });

    expect(requestMock).toHaveBeenCalledWith("/api/zpage/", {
      method: "POST",
      body: {
        title: "Tagged",
        description: "",
        content: "Body",
        category: "",
        tags: ["zero knowledge", "privacy", "c++"],
        is_published: true,
      },
    });
    expect(requestMock).toHaveBeenCalledWith("/api/zpage/article-id/", {
      anonymous: true,
    });
  });

  it("preserves the backend's legal stored tag vocabulary on read", async () => {
    const rtl = "مرحبا\u200f";
    const long = "L".repeat(100);
    requestMock.mockResolvedValue({
      free2zaddr: "article-id",
      title: "Stored tags",
      content: "Body",
      creator: { username: "alice" },
      tags: ["ART", "🏳️‍🌈 pride", rtl, "machine learning, deep learning", long],
    });

    await expect(articles.get("article-id")).resolves.toMatchObject({
      tags: ["ART", "🏳️‍🌈 pride", rtl, "machine learning, deep learning", long],
    });
  });

  it("uses the public zpage autocomplete contract", async () => {
    requestMock.mockResolvedValue([
      { name: "Privacy", count: 12 },
      { name: "privacy", count: "11" },
      { name: "C++", count: null },
    ]);
    await expect(articles.suggestTags("pri", ["zcash"])).resolves.toEqual([
      { name: "Privacy", count: 12 },
      { name: "privacy", count: 11 },
      { name: "C++", count: 0 },
    ]);
    expect(requestMock).toHaveBeenCalledWith("/api/tagging/autocomplete", {
      query: {
        query: "pri",
        type: "zpage",
        selected_tags: "zcash",
        num_results: 10,
      },
      anonymous: true,
    });
  });

  it("preserves a committed article id when canonical hydration is delayed", async () => {
    requestMock
      .mockResolvedValueOnce({ free2zaddr: "committed-article" })
      .mockRejectedValueOnce(new Error("read-after-write delay"));

    const error = await articles
      .publish({ title: "Committed", content: "Body" })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ArticlePublishedHydrationError);
    expect(error).toMatchObject({
      name: "ArticlePublishedHydrationError",
      articleId: "committed-article",
    });
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("drops a malformed backend tag field without breaking article hydration", async () => {
    requestMock.mockResolvedValue({
      free2zaddr: "article-id",
      title: "Legacy",
      content: "Body",
      creator: { username: "alice" },
      tags: "not-an-array",
    });

    await expect(articles.get("article-id")).resolves.toMatchObject({
      tags: [],
    });
  });

  it("exposes autocomplete transport and schema failures to its UI boundary", async () => {
    requestMock.mockRejectedValueOnce(new Error("offline"));
    await expect(articles.suggestTags("privacy")).rejects.toThrow("offline");

    requestMock.mockResolvedValueOnce({ results: [] });
    await expect(articles.suggestTags("privacy")).rejects.toThrow(
      "Malformed topic autocomplete response",
    );

    requestMock.mockResolvedValueOnce([{ nope: true }]);
    await expect(articles.suggestTags("privacy")).rejects.toThrow(
      "Malformed topic autocomplete suggestion",
    );
  });
});
