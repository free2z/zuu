import { describe, expect, it } from "vitest";
import {
  ARTICLE_DRAFT_STORAGE_KEY,
  CorruptArticleDraftStoreError,
  UnsupportedArticleDraftStoreError,
  discardArticleDraft,
  listArticleDrafts,
  loadArticleDraft,
  saveArticleDraft,
  type ArticleDraftFields,
  type DraftStorage,
} from "./article-drafts";

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const fields = (title: string): ArticleDraftFields => ({
  title,
  subtitle: `${title} subtitle`,
  category: "Technology",
  tags: ["privacy", "zcash"],
  content: `# ${title}\n\nLong-form work.`,
});

describe("local article drafts", () => {
  it("round-trips every field and advances an explicit revision", () => {
    const storage = new MemoryStorage();
    const first = saveArticleDraft(
      "Alice",
      "draft-first",
      fields("First"),
      0,
      storage,
      100,
    );
    expect(first).toMatchObject({ status: "saved", draft: { revision: 1 } });
    expect(loadArticleDraft("alice", "draft-first", storage)).toMatchObject({
      ...fields("First"),
      account: "alice",
      revision: 1,
      updatedAt: 100,
    });

    const second = saveArticleDraft(
      "ALICE",
      "draft-first",
      fields("Revised"),
      1,
      storage,
      200,
    );
    expect(second).toMatchObject({
      status: "saved",
      draft: { title: "Revised", revision: 2, updatedAt: 200 },
    });
  });

  it("keeps draft ids and accounts isolated and clears only the chosen draft", () => {
    const storage = new MemoryStorage();
    saveArticleDraft("alice", "draft-alice-a", fields("Alice A"), 0, storage, 10);
    saveArticleDraft("alice", "draft-alice-b", fields("Alice B"), 0, storage, 30);
    saveArticleDraft("bob", "draft-alice-b", fields("Bob"), 0, storage, 20);

    expect(listArticleDrafts("alice", storage).map((draft) => draft.title)).toEqual([
      "Alice B",
      "Alice A",
    ]);
    expect(loadArticleDraft("bob", "draft-alice-b", storage)?.title).toBe("Bob");

    expect(discardArticleDraft("alice", "draft-alice-b", 1, storage)).toBe(
      "discarded",
    );
    expect(listArticleDrafts("alice", storage).map((draft) => draft.title)).toEqual([
      "Alice A",
    ]);
    expect(loadArticleDraft("bob", "draft-alice-b", storage)?.title).toBe("Bob");
  });

  it("refuses a stale tab write instead of overwriting the newer revision", () => {
    const storage = new MemoryStorage();
    saveArticleDraft("alice", "draft-shared", fields("Initial"), 0, storage, 10);
    saveArticleDraft("alice", "draft-shared", fields("Newer tab"), 1, storage, 20);

    const stale = saveArticleDraft(
      "alice",
      "draft-shared",
      fields("Stale tab"),
      1,
      storage,
      30,
    );
    expect(stale).toMatchObject({
      status: "conflict",
      draft: { title: "Newer tab", revision: 2 },
    });
    expect(loadArticleDraft("alice", "draft-shared", storage)?.title).toBe(
      "Newer tab",
    );
  });

  it("refuses to discard a revision replaced by a newer tab", () => {
    const storage = new MemoryStorage();
    saveArticleDraft("alice", "draft-shared", fields("Published"), 0, storage, 10);
    saveArticleDraft("alice", "draft-shared", fields("Newer tab"), 1, storage, 20);

    expect(discardArticleDraft("alice", "draft-shared", 1, storage)).toBe(
      "conflict",
    );
    expect(loadArticleDraft("alice", "draft-shared", storage)?.title).toBe(
      "Newer tab",
    );
    expect(discardArticleDraft("alice", "draft-shared", 2, storage)).toBe(
      "discarded",
    );
  });

  it("persists deliberate clearing instead of resurrecting earlier content", () => {
    const storage = new MemoryStorage();
    saveArticleDraft("alice", "draft-clear", fields("Before"), 0, storage, 10);
    saveArticleDraft(
      "alice",
      "draft-clear",
      { title: "", subtitle: "", category: "", tags: [], content: "" },
      1,
      storage,
      20,
    );
    expect(loadArticleDraft("alice", "draft-clear", storage)).toMatchObject({
      title: "",
      content: "",
      revision: 2,
    });
  });

  it("does not overwrite a newer storage schema", () => {
    const storage = new MemoryStorage();
    const future = JSON.stringify({ version: 2, drafts: [{ private: "future" }] });
    storage.setItem(ARTICLE_DRAFT_STORAGE_KEY, future);

    expect(listArticleDrafts("alice", storage)).toEqual([]);
    expect(() =>
      saveArticleDraft("alice", "draft-future", fields("No overwrite"), 0, storage),
    ).toThrow(UnsupportedArticleDraftStoreError);
    expect(storage.getItem(ARTICLE_DRAFT_STORAGE_KEY)).toBe(future);
  });

  it("reads corrupt storage as empty but never overwrites its original bytes", () => {
    const corrupt = new MemoryStorage();
    const malformed = '{"version":1,"drafts":[';
    corrupt.setItem(ARTICLE_DRAFT_STORAGE_KEY, malformed);
    expect(listArticleDrafts("alice", corrupt)).toEqual([]);
    expect(() =>
      saveArticleDraft("alice", "draft-corrupt", fields("No overwrite"), 0, corrupt),
    ).toThrow(CorruptArticleDraftStoreError);
    expect(() =>
      discardArticleDraft("alice", "draft-corrupt", 0, corrupt),
    ).toThrow(CorruptArticleDraftStoreError);
    expect(corrupt.getItem(ARTICLE_DRAFT_STORAGE_KEY)).toBe(malformed);
  });

  it("surfaces an unavailable writer", () => {

    const unavailable: DraftStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(listArticleDrafts("alice", unavailable)).toEqual([]);
    expect(() =>
      saveArticleDraft(
        "alice",
        "draft-blocked",
        fields("Unavailable"),
        0,
        unavailable,
      ),
    ).toThrow("blocked");
  });
});
