import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TUZIS,
  DRAFT_STORAGE_PREFIX,
  clearCommentDraft,
  commentDraftKey,
  emptyDraft,
  getDraftStorage,
  isEmptyDraft,
  normalizeDraft,
  readCommentDraft,
  writeCommentDraft,
} from "../src/lib/commentDrafts.js";

/** Minimal in-memory stand-in for sessionStorage. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

/** A storage that throws on every operation (Safari private mode, quota). */
const hostileStorage = {
  getItem() {
    throw new Error("nope");
  },
  setItem() {
    throw new Error("quota");
  },
  removeItem() {
    throw new Error("nope");
  },
};

const ME = { username: "alice" };

test("keys drafts by who is writing and what they are commenting on", () => {
  assert.equal(
    commentDraftKey({ ...ME, object_type: "zpage", object_uuid: "abc" }),
    `${DRAFT_STORAGE_PREFIX}alice:zpage:abc`,
  );
  assert.equal(
    commentDraftKey({
      ...ME,
      object_type: "zpage",
      object_uuid: "abc",
      parent: "p1",
    }),
    `${DRAFT_STORAGE_PREFIX}alice:reply:p1`,
    "a reply belongs to its parent, not to the article",
  );
  assert.notEqual(
    commentDraftKey({ ...ME, object_type: "zpage", object_uuid: "a" }),
    commentDraftKey({ ...ME, object_type: "zpage", object_uuid: "b" }),
    "two articles must not share a draft",
  );
});

// sessionStorage outlives a logout. Without per-user scoping, user B logging
// in on the same tab would inherit user A's text and staked 2Z amount.
test("one account never inherits another account's draft", () => {
  const storage = fakeStorage();
  const target = { object_type: "zpage", object_uuid: "zp-1" };
  const aliceKey = commentDraftKey({ ...target, username: "alice" });
  const bobKey = commentDraftKey({ ...target, username: "bob" });

  assert.notEqual(aliceKey, bobKey);
  writeCommentDraft(storage, aliceKey, {
    headline: "",
    content: "alice's private thought",
    tuzis: 500,
  });

  assert.equal(readCommentDraft(storage, bobKey), null);
});

test("has no key until both the author and the target are known", () => {
  // During SSR / before the article load resolves, object_uuid is undefined.
  // Writing under a null key would orphan the draft once the uuid arrives.
  assert.equal(commentDraftKey({ ...ME, object_type: "zpage" }), null);
  assert.equal(commentDraftKey(ME), null);
  // Logged out: nothing is stored at all.
  assert.equal(
    commentDraftKey({ object_type: "zpage", object_uuid: "abc" }),
    null,
  );
});

// The  regression: text typed before an async load resolved was wiped when
// the form component was destroyed and re-created. The draft must outlive the
// component instance.
test("a draft survives the form being destroyed and re-created", () => {
  const storage = fakeStorage();
  const key = commentDraftKey({
    ...ME,
    object_type: "zpage",
    object_uuid: "zp-1",
  });

  // First instance: user types.
  writeCommentDraft(storage, key, {
    headline: "",
    content: "half a thought about zcash",
    tuzis: 5,
  });

  // The comments list resolves / the session revalidates / the auth branch
  // flips -> the component is torn down and a brand new one mounts.
  const restored = readCommentDraft(storage, key);

  assert.deepEqual(restored, {
    headline: "",
    content: "half a thought about zcash",
    tuzis: 5,
  });
});

test("posting successfully spends the draft", () => {
  const storage = fakeStorage();
  const key = commentDraftKey({
    ...ME,
    object_type: "zpage",
    object_uuid: "zp-1",
  });

  writeCommentDraft(storage, key, {
    headline: "",
    content: "posted!",
    tuzis: 1,
  });
  clearCommentDraft(storage, key);

  assert.equal(readCommentDraft(storage, key), null);
});

test("an untouched form stores nothing", () => {
  const storage = fakeStorage();
  const key = commentDraftKey({
    ...ME,
    object_type: "zpage",
    object_uuid: "zp-1",
  });

  assert.ok(isEmptyDraft(emptyDraft()));
  writeCommentDraft(storage, key, emptyDraft());
  assert.equal(storage.map.size, 0);
});

test("clearing a draft removes the stored entry", () => {
  const storage = fakeStorage();
  const key = commentDraftKey({
    ...ME,
    object_type: "zpage",
    object_uuid: "zp-1",
  });

  writeCommentDraft(storage, key, {
    headline: "",
    content: "x",
    tuzis: 1,
  });
  assert.equal(storage.map.size, 1);

  writeCommentDraft(storage, key, emptyDraft());
  assert.equal(storage.map.size, 0, "an emptied form drops its entry");
});

test("whitespace-only content is not worth persisting", () => {
  assert.ok(isEmptyDraft({ headline: "  ", content: "\n\t ", tuzis: 1 }));
});

test("a non-default 2Z weight alone is worth persisting", () => {
  assert.equal(isEmptyDraft({ headline: "", content: "", tuzis: 25 }), false);
});

test("garbage in storage never reaches the form", () => {
  const key = commentDraftKey({
    ...ME,
    object_type: "zpage",
    object_uuid: "zp-1",
  });

  assert.equal(readCommentDraft(fakeStorage({ [key]: "not json" }), key), null);
  assert.equal(readCommentDraft(fakeStorage({ [key]: "[]" }), key), null);
  assert.equal(readCommentDraft(fakeStorage({ [key]: "null" }), key), null);
  assert.equal(
    readCommentDraft(fakeStorage({ [key]: '"a string"' }), key),
    null,
  );
});

test("clamps a hostile tuzis value into the range the API accepts", () => {
  assert.equal(normalizeDraft({ content: "x", tuzis: 0 }).tuzis, 1);
  assert.equal(normalizeDraft({ content: "x", tuzis: 1e9 }).tuzis, 10000);
  assert.equal(normalizeDraft({ content: "x", tuzis: 4.7 }).tuzis, 4);
  assert.equal(
    normalizeDraft({ content: "x", tuzis: Number.NaN }).tuzis,
    DEFAULT_TUZIS,
  );
  assert.equal(
    normalizeDraft({ content: "x", tuzis: "12" }).tuzis,
    DEFAULT_TUZIS,
    "a string is not a weight",
  );
});

test("truncates stored text to the backend's limits", () => {
  const draft = normalizeDraft({
    headline: "h".repeat(500),
    content: "c".repeat(5000),
  });
  assert.equal(draft.headline.length, 100);
  assert.equal(draft.content.length, 1000);
});

test("survives storage being unavailable or throwing", () => {
  const key = commentDraftKey({
    ...ME,
    object_type: "zpage",
    object_uuid: "zp-1",
  });

  // SSR: there is no sessionStorage at all.
  assert.equal(readCommentDraft(null, key), null);
  assert.doesNotThrow(() => writeCommentDraft(null, key, emptyDraft()));
  assert.doesNotThrow(() => clearCommentDraft(null, key));

  // Private mode / quota exceeded: never take the comment section down.
  assert.equal(readCommentDraft(hostileStorage, key), null);
  assert.doesNotThrow(() =>
    writeCommentDraft(hostileStorage, key, {
      headline: "",
      content: "x",
      tuzis: 1,
    }),
  );
  assert.doesNotThrow(() => clearCommentDraft(hostileStorage, key));

  // No key yet (target unresolved): a no-op, not a crash.
  assert.equal(readCommentDraft(fakeStorage(), null), null);
  assert.doesNotThrow(() =>
    writeCommentDraft(fakeStorage(), null, emptyDraft()),
  );
});

test("getDraftStorage returns null when sessionStorage is absent (SSR)", () => {
  assert.equal(typeof sessionStorage, "undefined");
  assert.equal(getDraftStorage(), null);
});
