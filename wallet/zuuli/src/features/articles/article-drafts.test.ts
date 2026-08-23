import { describe, expect, it } from "vitest";
import {
  ARTICLE_DRAFT_STORAGE_KEY,
  ARTICLE_DRAFT_STORAGE_PREFIX,
  CorruptArticleDraftStoreError,
  UnsupportedArticleDraftStoreError,
  discardArticleDraft,
  hasArticleDraftConflict,
  listArticleDrafts,
  loadArticleDraft,
  saveArticleDraft,
  type ArticleDraftFields,
  type DraftStorage,
} from "./article-drafts";

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

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

  it("cannot erase different accounts or drafts when a writer is forced to reenter", () => {
    const storage = new MemoryStorage();
    let bobResult: ReturnType<typeof saveArticleDraft> | null = null;
    let reentered = false;
    const originalSet = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
      if (!reentered && key.includes("claim-writer-a")) {
        reentered = true;
        bobResult = saveArticleDraft(
          "bob",
          "draft-bob-one",
          fields("Bob concurrent"),
          0,
          storage,
          20,
          "claim-writer-b",
        );
      }
      originalSet(key, value);
    };

    const aliceResult = saveArticleDraft(
      "alice",
      "draft-alice-one",
      fields("Alice concurrent"),
      0,
      storage,
      10,
      "claim-writer-a",
    );

    expect(aliceResult.status).toBe("saved");
    expect(bobResult).toMatchObject({ status: "saved" });
    expect(loadArticleDraft("alice", "draft-alice-one", storage)?.title).toBe(
      "Alice concurrent",
    );
    expect(loadArticleDraft("bob", "draft-bob-one", storage)?.title).toBe(
      "Bob concurrent",
    );
  });

  it("keeps both bodies recoverable and reports conflict for forced same-parent writers", () => {
    const storage = new MemoryStorage();
    saveArticleDraft(
      "alice",
      "draft-shared",
      fields("Parent"),
      0,
      storage,
      1,
      "claim-parent-seed",
    );

    let writerB: ReturnType<typeof saveArticleDraft> | null = null;
    let reentered = false;
    const originalSet = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
      originalSet(key, value);
      if (!reentered && key.endsWith("claim-writer-a")) {
        reentered = true;
        writerB = saveArticleDraft(
          "alice",
          "draft-shared",
          fields("Writer B"),
          1,
          storage,
          30,
          "claim-writer-b",
        );
      }
    };

    const writerA = saveArticleDraft(
      "alice",
      "draft-shared",
      fields("Writer A"),
      1,
      storage,
      20,
      "claim-writer-a",
    );

    expect(writerA).toMatchObject({
      status: "conflict",
      rescue: { id: "claim-writer-a", title: "Writer A" },
    });
    expect(writerB).toMatchObject({
      status: "conflict",
      rescue: { id: "claim-writer-b", title: "Writer B" },
    });
    expect(loadArticleDraft("alice", "draft-shared", storage)?.title).toBe(
      "Parent",
    );
    expect(listArticleDrafts("alice", storage).map((draft) => draft.title)).toEqual(
      expect.arrayContaining(["Parent", "Writer A", "Writer B"]),
    );
    expect(hasArticleDraftConflict("alice", "draft-shared", storage)).toBe(true);
  });

  it("rescues a writer whose parent changes after its read but before its claim", () => {
    const storage = new MemoryStorage();
    saveArticleDraft(
      "alice",
      "draft-shared",
      fields("Parent"),
      0,
      storage,
      1,
      "claim-parent-seed",
    );

    let writerB: ReturnType<typeof saveArticleDraft> | null = null;
    let reentered = false;
    const originalGet = storage.getItem.bind(storage);
    storage.getItem = (key) => {
      if (!reentered && key.endsWith("claim-writer-a")) {
        reentered = true;
        writerB = saveArticleDraft(
          "alice",
          "draft-shared",
          fields("Writer B wins head"),
          1,
          storage,
          30,
          "claim-writer-b",
        );
      }
      return originalGet(key);
    };

    const writerA = saveArticleDraft(
      "alice",
      "draft-shared",
      fields("Writer A rescued"),
      1,
      storage,
      20,
      "claim-writer-a",
    );

    expect(writerB).toMatchObject({
      status: "saved",
      draft: { title: "Writer B wins head", revision: 2 },
    });
    expect(writerA).toMatchObject({
      status: "conflict",
      draft: { title: "Writer B wins head", revision: 2 },
      rescue: { title: "Writer A rescued" },
    });
    expect(listArticleDrafts("alice", storage).map((draft) => draft.title)).toEqual(
      expect.arrayContaining(["Writer B wins head", "Writer A rescued"]),
    );
    expect(hasArticleDraftConflict("alice", "draft-shared", storage)).toBe(true);
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
    expect(
      [...storage.values.keys()].filter((key) =>
        key.startsWith(ARTICLE_DRAFT_STORAGE_PREFIX),
      ),
    ).toEqual([]);
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
    expect(
      [...corrupt.values.keys()].filter((key) =>
        key.startsWith(ARTICLE_DRAFT_STORAGE_PREFIX),
      ),
    ).toEqual([]);
  });

  it("surfaces an unavailable writer", () => {

    const unavailable: DraftStorage = {
      length: 0,
      key: () => null,
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
